/**
 * 既存の作業ツリーと、そこで動いているセッションを、子として採用する操作の実体: `node.adopt`（Issue #163）。
 * 権限と部分木の判定は、認可（`authorize`）で済んでいる前提（ハンドラでも、親が呼び出し元の部分木に収まることを確かめる）。
 *
 * 順序（失敗したら、そこまでの副作用を片付ける。作業ツリーとブランチは、採用の前から利用者のものなので、決して消さない）:
 * 1. 再送の判定（同じ requestId で記録済みなら、記録したノードの内容を返す）
 * 2. 親（動作中の統合ノード）・親の作業ツリー（`cwdOf`）・子の範囲が親の範囲に収まるか（`childScopeProblem`。spawn と同じ判定）
 * 3. 作業ツリーの検査（`inspectAdoption`。何も変えない）→ 範囲を子の作業ツリーで `validateScope`
 * 4. 子の印を書く（`markAdopted`）→ 紐付けのコードを出す（`issueBindCode`）
 * 5. 記録: `node.created`（範囲を含む）・`start`・`node.adopted`（作業ツリーとブランチ）を 1 トランザクションで書く。
 *    行為者（誰が採用したか）は、イベントの封筒に残る。
 * 起動（`adapter.start`）はしない: セッションはすでに動いている。紐付け（`child_bind`）で、セッションが子になる。
 */

import {
  type Failure,
  isInSubtree,
  type NodeRecord,
  type OperationMap,
  type OrchState,
  type Result,
  type Scope,
  validateScope,
} from "@touryou/core";
import type { HandlerRequest } from "../server.js";
import { childScopeProblem } from "./child-scope-check.js";
import {
  alreadyApplied,
  appendAtomically,
  derivedRequestId,
  deriveId,
  fail,
  type LogPort,
} from "./context.js";
import { createExclusive } from "./inflight.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

/** 採用に使う、外への口（git の検査・印・紐付けのコードのファイル）。 */
export interface AdoptPorts {
  /** ノードの作業ツリー（実パス）。取得できなければ `undefined`（失敗させる）。 */
  cwdOf(nodeId: string): Promise<string | undefined>;
  /** 既存の作業ツリーを採用できるか検査する（何も変えない）。 */
  inspectAdoption(req: {
    parentId: string;
    worktree: string;
    branch: string;
  }): Promise<Result<{ worktreePath: string; branch: string; dirty: boolean }, Failure>>;
  /** 子の印を書く。すでに印があれば失敗する。 */
  markAdopted(nodeId: string, worktreePath: string): Promise<Result<undefined, Failure>>;
  /** 書いた印を消す（作業ツリーとブランチは消さない）。 */
  unmarkAdopted(worktreePath: string): Promise<void>;
  /** 紐付けのコードを出し、作業ツリーの git のディレクトリに書く。書けなければ例外。 */
  issueBindCode(nodeId: string, worktreePath: string): void;
  /** 出したコードとファイルを片付ける。 */
  discardBindCode(nodeId: string, worktreePath: string): void;
}

export interface AdoptHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  readonly ports: AdoptPorts;
  /** 根の有効な範囲（spawn と同じ）。 */
  readonly rootScope?: Scope;
  /** 応答に出さない原因の記録先。 */
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

const LIVE = new Set(["running", "waiting"]);

const nodeOf = (state: OrchState, id: string): NodeRecord | undefined =>
  state.nodes.find((n) => n.id === id);

/** 採用した子のセッションへの手順（親が、そのセッションの人に伝える）。 */
const instructionOf = (nodeId: string, dirty: boolean): string =>
  [
    `ノード ${nodeId} として採用した。このノードの作業ツリーで動いているセッションで、次の順に進める:`,
    "1. セッションの中で /mcp を開き、touryou の接続をつなぎ直す（Reconnect）。これで、このセッションが子として動けるようになる（採用の前から動いていたセッションは、つなぎ直すまで、子として扱われない）",
    "2. 子のツール child_bind を、引数なしで呼ぶ（紐付けのコードは作業ツリーに置いてある。期限が切れていたら、親が node_bindCode で出し直す）",
    "3. 紐付けのあとは、/touryou:child の手順で報告する。起動時の知らせの自動の流れがないので、ときどき inbox_fetch で受信箱を読む",
    ...(dirty
      ? ["注意: 作業ツリーに未コミットの変更がある。採用の範囲に収まるか、作業の前に確かめる"]
      : []),
  ].join("\n");

export function createAdoptHandlers(deps: AdoptHandlerDeps) {
  const { log, ports } = deps;
  const exclusive = createExclusive();
  const note = (nodeId: string, cause: string): void => {
    try {
      deps.onFailure?.(nodeId, cause);
    } catch {
      // 記録先の失敗は、処理を止めない
    }
  };

  const handlers = {
    "node.adopt": (req: HandlerRequest<"node.adopt">): Promise<R<"node.adopt">> => {
      const p = req.params;
      const caller = req.caller?.nodeId ?? "";
      const actor = req.role === "human" ? { human: true as const } : { nodeId: caller };
      return exclusive(
        `${caller}\0${req.requestId}`,
        JSON.stringify(p),
        async (): Promise<R<"node.adopt">> => {
          const nodeId = deriveId("node", caller, req.requestId, "adopt");
          const state = log.state();

          // 再送: 記録済みなら、記録したノードの内容を返す（検査・印・コードをやり直さない）。
          // 未コミットの変更の有無は、記録に持たないので、再送では false（指示の注意の行も出さない）。
          if (alreadyApplied(state, actor, req.requestId)) {
            const node = nodeOf(state, nodeId);
            if (node?.adopted === undefined || node.adopted.branch !== p.branch) {
              return fail(
                "requestIdConflict",
                "この requestId は、別の内容の操作に使われている",
                "新しい requestId で、もう一度呼ぶ",
              );
            }
            return {
              ok: true,
              value: {
                nodeId,
                worktree: node.adopted.worktree,
                branch: node.adopted.branch,
                dirty: false,
                instruction: instructionOf(nodeId, false),
                duplicate: true,
              },
            };
          }

          const parent = nodeOf(state, p.parentId);
          if (parent === undefined)
            return fail("notFound", "親のノードが見つからない", "ID を確認する");
          if (!isInSubtree(state.nodes, caller, p.parentId)) {
            return fail("forbidden", "親が自分の部分木の外にある", "親（統合ノード）に依頼する");
          }
          if (parent.role !== "integrator" || !LIVE.has(parent.state)) {
            return fail(
              "notActive",
              `親 ${p.parentId} は動作中の統合ノードでない（${parent.role}・${parent.state}）`,
              "動作中の統合ノードを親にする",
            );
          }
          if (p.role === "integrator") {
            return fail(
              "adoptRoleInvalid",
              "採用できるのは、作業の子だけ（統合ノードは採用できない）",
              "role に、作業の子の役割を指定する",
            );
          }

          let parentCwd: string | undefined;
          try {
            parentCwd = await ports.cwdOf(p.parentId);
          } catch (e) {
            note(p.parentId, `親の作業ツリーを取得できない: ${String(e)}`);
          }
          if (parentCwd === undefined) {
            return fail(
              "worktreeUnknown",
              `親 ${p.parentId} の作業ツリーを確認できない`,
              "親の状態を確認する",
            );
          }

          // 権限が親を超えないこと（spawn と同じ判定。作業ツリーに触れる前に検査する）。
          const scopeProblem = childScopeProblem({
            state,
            parentId: p.parentId,
            parentCwd,
            scope: p.scope,
            rootScope: deps.rootScope,
          });
          if (scopeProblem !== undefined) return { ok: false, error: scopeProblem };

          let inspected: Result<{ worktreePath: string; branch: string; dirty: boolean }, Failure>;
          try {
            inspected = await ports.inspectAdoption({
              parentId: p.parentId,
              worktree: p.worktree,
              branch: p.branch,
            });
          } catch (e) {
            note(nodeId, `作業ツリーを検査できない: ${String(e)}`);
            return fail(
              "adoptInspectFailed",
              "作業ツリーを検査できなかった",
              "しばらくして、もう一度試す",
            );
          }
          if (!inspected.ok) return inspected;
          const { worktreePath, branch, dirty } = inspected.value;

          const issues = validateScope(p.scope, worktreePath);
          if (issues.length > 0) {
            return fail(
              "scopeInvalid",
              `範囲が作業ツリーの規則を満たさない: ${issues.map((i) => `${i.field}（${i.problem}）`).join("、")}`,
              "範囲を、作業ツリーの内側の相対パスで指定し直す",
            );
          }

          // 以降の失敗は、書いた印とコードだけを片付ける（作業ツリーとブランチは消さない）。
          const marked = await ports
            .markAdopted(nodeId, worktreePath)
            .catch((e: unknown): Result<undefined, Failure> => {
              note(nodeId, `印を書けない: ${String(e)}`);
              return {
                ok: false,
                error: {
                  code: "adoptMarkFailed",
                  cause: "子の印を書けなかった",
                  nextActions: ["git のディレクトリの権限とディスクの空きを確かめて、もう一度試す"],
                },
              };
            });
          if (!marked.ok) return marked;
          const undo = async (): Promise<void> => {
            try {
              ports.discardBindCode(nodeId, worktreePath);
            } catch (e) {
              note(nodeId, `コードを片付けられない: ${String(e)}`);
            }
            await ports.unmarkAdopted(worktreePath).catch((e: unknown) => {
              note(nodeId, `印を片付けられない: ${String(e)}`);
            });
          };
          try {
            ports.issueBindCode(nodeId, worktreePath);
          } catch (e) {
            note(nodeId, `紐付けのコードを書けない: ${String(e)}`);
            await undo();
            return fail(
              "bindCodeFileFailed",
              "紐付けのコードのファイルを、作業ツリーの git のディレクトリに書けなかった",
              "git の状態と、ディスクの空きを確かめてから、もう一度試す",
            );
          }

          const recorded = appendAtomically(log, deps.clock, req.requestId, actor, [
            {
              type: "node.created",
              payload: {
                nodeId,
                role: p.role,
                parentId: p.parentId,
                dependsOn: [],
                objective: p.objective,
                acceptanceCriteria: [...p.acceptanceCriteria],
                scope: p.scope,
              },
            },
            { type: "node.stateChanged", payload: { nodeId, event: { type: "start" } } },
            {
              type: "node.adopted",
              payload: {
                nodeId,
                worktree: worktreePath,
                branch,
                ...(p.sessionRef === undefined ? {} : { sessionRef: p.sessionRef }),
              },
            },
          ]);
          if (!recorded.ok) {
            await undo();
            return { ok: false, error: recorded.error };
          }

          // 親のセッションを記録する（知らせの宛先）。記録に失敗しても、採用は止めない。
          if (p.parentSessionId !== undefined) {
            try {
              log.append({
                requestId: derivedRequestId(actor, req.requestId, 9),
                actor,
                body: {
                  type: "node.parentSessionSet",
                  payload: { nodeId, sessionId: p.parentSessionId },
                },
              });
            } catch {
              // 記録の失敗で、採用を止めない
            }
          }

          return {
            ok: true,
            value: {
              nodeId,
              worktree: worktreePath,
              branch,
              dirty,
              instruction: instructionOf(nodeId, dirty),
              duplicate: false,
            },
          };
        },
      );
    },
  };
  return { handlers };
}
