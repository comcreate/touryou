/**
 * 親への依頼の中身と、親の報告（設計 6.1・6.2）。`parent.request`・`parent.report`。
 *
 * - `parent.request`: 子の最も新しい、まだ報告のない依頼を返す。どれも、親がそのまま Bash で実行する文（変数なし・値は引用済み）。
 *   - 起動（launch）: `cd <作業ツリー> && claude --bg …`。紐付けのコードは入れない（子の mcp が、作業ツリーの git のディレクトリの
 *     `touryou-bind-code` から読む）。
 *   - 停止（stop）: `claude stop <子のセッション>`。
 *   - 削除（remove）: `claude rm <子のセッション>`。成果を捨てる旗（`--discard-unpushed`）は、人間が破棄を決めたノード
 *     （`node.discardDecided`）のときだけ付ける。
 * - `parent.report`: 親が実行した結果を記録する（子のセッションの参照・失敗の理由・`claude agents --json` で読んだ子の状態）。
 *   依頼の受信箱の項目を解決済みにする。子が止まっていそうな状態（入力待ちなど）なら、受信箱に出す。
 *   - 起動の失敗: 受信箱に failure。
 *   - 停止の「止めた」: 親の報告だけでは決めない。`lsof-probe` で作業ツリーを使うプロセスがないと確かめてから stopped にし、続けて
 *     削除（`claude rm`）を依頼する。残っている・確かめられないときは、停止未完了のまま受信箱に出す
 *     （受理後〔verified・reclaimable・archived〕のノードは、対処が要る状態でないので、stopIncomplete でなく info にとどめる）。
 *   - 削除の失敗（`claude rm` が拒んだ）: 消さずに受信箱に出す（成果を捨てるかは人間が決める）。`claude rm` は子のセッションだけを消し、
 *     touryou の作業ツリーとコミットは残る（未 push を守るのは Claude Code 自身が作った作業ツリーのときだけ）ので、拒まれるのは念のための備え。作業ツリーの片付けは回収（node.reclaimPreview → node.reclaim）。
 * - 直接の親か人間だけ（`SUBTREE_RULES` の directChild。窓口の `authorize` が適用する）。
 */

import {
  type Actor,
  type EventBody,
  type Failure,
  findRunningProcesses,
  isSessionRef,
  type OperationMap,
  type OrchState,
  type ParentRequestRecord,
  type Result,
  SETTLED_STATES,
} from "@touryou/core";
import { childAllowList, childToolNames } from "../../sdk/child-permissions.js";
import { buildLaunchCommand } from "../../sdk/launch-command.js";
import type { ProcessProbe } from "../../sdk/lsof-probe.js";
import { checkPluginDir, type PluginDirPorts } from "../../sdk/plugin-dir.js";
import type { HandlerRequest } from "../server.js";
import { shellWord } from "./bind-handlers.js";
import { appendAtomically, deriveId, fail, type LogPort, notice, summarize } from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

/** 親が読んだ子の状態のうち、止まっているかもしれない（人に attach を頼む）もの。 */
export const STALLED_AGENT_STATES: ReadonlySet<string> = new Set([
  "need_input",
  "needs_input",
  "waiting_input",
  "permission_prompt",
  "blocked",
  "error",
]);

export interface ParentRequestHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  /** 作業ツリーを使うプロセスの調査（`lsof-probe`）。ないと、停止の報告では stopped にしない（確かめられないため）。 */
  readonly probe?: ProcessProbe;
  /** 停止を確かめたあと、管理から外す（コードとファイルの片付け。CLI のアダプタの `release`）。 */
  readonly release?: (nodeId: string) => void;
  /** 子に付ける plugin の場所の確かめの入出力。ないと、plugin の場所を添えられても付けない（受信箱に出す）。 */
  readonly pluginDir?: PluginDirPorts;
}

const actorOf = (req: { role: string; caller?: { nodeId: string } }): Actor =>
  req.role === "human" ? { human: true } : { nodeId: req.caller?.nodeId ?? "" };

/** 依頼の受信箱の項目の ID（`cli-adapter.ts` の起動の依頼と同じ導き方）。 */
export const requestInboxId = (requestRef: string): string =>
  deriveId("inbox", "system", requestRef, "parent-request");

export const openRequestOf = (
  requests: readonly ParentRequestRecord[],
  nodeId: string,
): ParentRequestRecord | undefined => {
  const latest = [...requests].reverse().find((r) => r.nodeId === nodeId);
  return latest?.report === undefined ? latest : undefined;
};

/** 親が調べた id で作り直す依頼の参照。 */
const withRefOf = (nodeId: string, requestRef: string): string =>
  deriveId("preq", nodeId, requestRef, "with-ref");

/**
 * 子のセッションの参照。読むのは、成功の起動の報告と、停止・削除の前に親が調べた id の報告（command つきの依頼の作り直しを生んだ
 * 報告）だけ。停止・削除のふつうの報告に付いた sessionRef は読まない（別の id の rm にしないため）。
 */
export const sessionRefOf = (state: OrchState, nodeId: string): string | undefined =>
  [...state.parentRequests]
    .reverse()
    .find(
      (r) =>
        r.nodeId === nodeId &&
        r.report?.outcome === "done" &&
        r.report.sessionRef !== undefined &&
        (r.kind === "launch" ||
          state.parentRequests.some((x) => x.requestRef === withRefOf(nodeId, r.requestRef))),
    )?.report?.sessionRef;

/**
 * セッションの削除（claude rm）の依頼の失敗の理由が「そのセッションがもうない」ことを言っているか（#115）。
 * 受理のあとの後片付けでは、止めた（claude stop）時点でセッションが一覧から消えることがあり、そのときの削除の失敗は、
 * 消す必要がもうないだけなので、済んだ扱いにする（受信箱に「うまくいかなかった」を出さない）。
 * 当てるのは、セッション・エージェントを名指して「ない」と言う文と、依頼の手順で決めた「一覧にない」の報告だけ
 * （`command not found`・`no such file or directory` などの本当の失敗は、失敗のまま受信箱に出す）。
 */
export const SESSION_GONE =
  /(?:session|agent|セッション)[^\n]{0,40}(?:not found|does not exist|doesn't exist|no longer exists|見つから|存在しない)|一覧に(?:も)?ない|もう一覧になかった/i;

const NEXT_SIMPLE = (r: ParentRequestRecord) =>
  `実行する前に、claude agents --json で、名前が ${r.nodeId} のセッションの id が command の id と同じかを確かめる（違えば実行せず、parent_report で outcome: failed と reason に「id が違う」と書く）。command を Bash でそのまま 1 回だけ実行する（書き換えない）。結果を parent_report（requestRef: ${r.requestRef}）で報告する: 成功は outcome: done、失敗（拒まれた・エラー）は outcome: failed と reason（出力の要点）`;

/**
 * 破棄つきの削除の作り直し。人間が破棄を決めた（`node.discardDecided`）ノードで、最も新しい削除の依頼が
 * 拒まれた（failed）まま、まだ報告のない依頼がないなら、新しい削除の依頼（`--discard-unpushed` つきになる）を作る記録を返す。
 * 当てはまらなければ空。依頼の参照は、拒まれた依頼から決まるので、同じものは二度作らない。
 */
export function discardRemoveBodies(state: OrchState, nodeId: string): EventBody[] {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (node?.discarded === undefined || openRequestOf(state.parentRequests, nodeId) !== undefined)
    return [];
  const lastRemove = [...state.parentRequests]
    .reverse()
    .find((r) => r.nodeId === nodeId && r.kind === "remove");
  if (lastRemove?.report?.outcome !== "failed") return [];
  const requestRef = deriveId("preq", nodeId, lastRemove.requestRef, "remove-discard");
  if (state.parentRequests.some((r) => r.requestRef === requestRef)) return [];
  return [
    {
      type: "node.parentRequested",
      payload: { nodeId, requestRef, kind: "remove", worktree: lastRemove.worktree },
    },
    {
      type: "inbox.added",
      payload: {
        id: requestInboxId(requestRef),
        kind: "info",
        nodeId,
        ...notice("removeDiscarded", { node: nodeId }),
      },
    },
  ];
}

/**
 * 受理のときに、まだ報告のない親への依頼が開いていて、停止の依頼（`sessionStopBodies`）を出せなかった子への知らせ（Issue #3）。
 * 受信箱に info を出し、その依頼を片付けたあとに `node_stop` で停止の依頼を出すよう促す（セッションを残したままにしない）。
 * 親が起動を報告していない子・開いている依頼がない子は空を返す。
 */
export function sessionStopDeferredBodies(
  state: OrchState,
  nodeId: string,
  seed: string,
): EventBody[] {
  const launched = state.parentRequests.some(
    (r) => r.nodeId === nodeId && r.kind === "launch" && r.report?.outcome === "done",
  );
  if (!launched || openRequestOf(state.parentRequests, nodeId) === undefined) return [];
  return [
    {
      type: "inbox.added",
      payload: {
        id: deriveId("inbox", "system", seed, "session-stop-deferred"),
        kind: "info",
        nodeId,
        ...notice("acceptedPendingRequest", { node: nodeId }),
      },
    },
  ];
}

/**
 * 受理した子（verified）の、裏のセッションの停止の依頼（設計 6.2。Issue #3）。親が起動を報告した子（CLI の `claude --bg`）だけが対象。
 * 状態は変えない（成果は受理済みで、止めるのはセッションだけ）。止めたことは `parent.report` で作業ツリーのプロセスがないことを
 * 確かめてから受信箱に出し、続けて削除（`claude rm`）を依頼する。まだ報告のない依頼があるとき・同じ依頼を作ったことがあるとき・
 * 起動の報告がない子（Desktop・紐付けだけの子）は空を返す。`seed` は依頼の参照を導く種（受理の要求 ID など）。
 */
export function sessionStopBodies(state: OrchState, nodeId: string, seed: string): EventBody[] {
  const launch = [...state.parentRequests]
    .reverse()
    .find((r) => r.nodeId === nodeId && r.kind === "launch" && r.report?.outcome === "done");
  if (launch === undefined || openRequestOf(state.parentRequests, nodeId) !== undefined) return [];
  const requestRef = deriveId("preq", nodeId, seed, "session-stop");
  if (state.parentRequests.some((r) => r.requestRef === requestRef)) return [];
  return [
    {
      type: "node.parentRequested",
      payload: { nodeId, requestRef, kind: "stop", worktree: launch.worktree },
    },
    {
      type: "inbox.added",
      payload: {
        id: requestInboxId(requestRef),
        kind: "info",
        nodeId,
        ...notice("acceptedStopRequest", { node: nodeId }),
      },
    },
  ];
}

export function createParentRequestHandlers(deps: ParentRequestHandlerDeps) {
  /** 停止の「止めた」の報告を確かめる: 作業ツリーを使うプロセスがない（`[]`）・残っている（pid）・確かめられない（null）。 */
  const remaining = async (worktree: string): Promise<number[] | null> => {
    if (deps.probe === undefined) return null;
    const procs = await deps.probe(worktree).catch(() => null);
    return procs === null ? null : findRunningProcesses(worktree, procs);
  };

  return {
    "parent.request": (req: HandlerRequest<"parent.request">): R<"parent.request"> => {
      const { nodeId, model, effort, forkSessionRef, pluginRoot } = req.params;
      const state = deps.log.state();
      const node = state.nodes.find((n) => n.id === nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      const r = openRequestOf(state.parentRequests, nodeId);
      if (r === undefined) {
        return fail(
          "noRequest",
          `ノード ${nodeId} への、まだ報告のない依頼はない`,
          "受信箱（inbox_fetch）で、依頼の項目を確かめる",
        );
      }
      if (r.kind === "launch") {
        const allow = childAllowList(
          node.scope ?? { writableLocations: [], forbiddenLocations: [], allowedCommands: [] },
          childToolNames(),
        );
        if (!allow.ok) return allow;
        // plugin の場所: 確かめを通れば --plugin-dir を足す。通らなければ付けず、理由を受信箱に出す（値・パスは出さない）
        const plugin =
          pluginRoot === undefined
            ? undefined
            : deps.pluginDir === undefined
              ? { ok: false as const, reason: "daemon に plugin の場所を確かめる手段がない" }
              : checkPluginDir(pluginRoot, deps.pluginDir);
        if (plugin !== undefined && !plugin.ok) {
          const itemId = deriveId("inbox", "system", r.requestRef, "plugin-dir");
          if (!state.inbox.some((i) => i.id === itemId)) {
            appendAtomically(deps.log, deps.clock, req.requestId, actorOf(req), [
              {
                type: "inbox.added",
                payload: {
                  id: itemId,
                  kind: "info",
                  nodeId,
                  ...notice("pluginNotAttached", { node: nodeId, reason: plugin.reason }),
                },
              },
            ]);
          }
        }
        const command = buildLaunchCommand({
          ...(plugin?.ok === true ? { pluginDir: plugin.dir } : {}),
          permissions: allow.value,
          worktree: r.worktree,
          name: nodeId,
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
          ...(forkSessionRef === undefined ? {} : { forkSessionRef }),
        });
        return {
          ok: true,
          value: {
            requestRef: r.requestRef,
            nodeId,
            kind: r.kind,
            command,
            next: `command を Bash でそのまま 1 回だけ実行する（書き換えない）。成功したら、出力にある子のセッションの参照（なければ claude agents --json で ${nodeId} の名前の id）を sessionRef に入れて parent_report（requestRef: ${r.requestRef}, outcome: done）。失敗したら、failed と報告する前に claude agents --json でその名前（${nodeId}）の子がいないことを確かめてから、outcome: failed と reason で報告する（いれば、その id を sessionRef に入れて outcome: done）`,
          },
        };
      }
      const ref = sessionRefOf(state, nodeId);
      if (ref === undefined) {
        return fail(
          "noSessionRef",
          `ノード ${nodeId} の子のセッションの参照が記録にない（起動の報告に sessionRef がなかった）`,
          `claude agents --json で、名前が ${nodeId} のセッションの id を探し、parent_report（requestRef: ${r.requestRef}, outcome: done）の sessionRef として返す。コマンドは組まない・実行しない（touryou が、その id で、command つきの依頼を作り直す。そのあと parent_request を呼ぶ）`,
          `見つからなければ、parent_report（requestRef: ${r.requestRef}, outcome: failed）の reason に「名前が ${nodeId} のセッションが見つからない」と書く`,
        );
      }
      // 成果を捨てる旗は、人間が破棄を決めたノードだけ（node.discardDecided。設計 6.2）
      const discard = r.kind === "remove" && node.discarded !== undefined;
      const command =
        r.kind === "stop"
          ? `claude stop ${shellWord(ref)}`
          : `claude rm ${shellWord(ref)}${discard ? " --discard-unpushed" : ""}`;
      return {
        ok: true,
        value: {
          requestRef: r.requestRef,
          nodeId,
          kind: r.kind,
          command,
          next:
            r.kind === "remove"
              ? `${NEXT_SIMPLE(r)}。claude agents --json に、名前が ${r.nodeId} のセッションがもうなければ（止めた時点で消えている）、実行せずに outcome: done と reason に「一覧にない」と書いて報告する`
              : NEXT_SIMPLE(r),
        },
      };
    },

    "parent.report": async (req: HandlerRequest<"parent.report">): Promise<R<"parent.report">> => {
      const { nodeId, requestRef, sessionRef, reason, agentState } = req.params;
      const actor = actorOf(req);
      const state = deps.log.state();
      const r = state.parentRequests.find((x) => x.requestRef === requestRef);
      // 削除の失敗の理由が「セッションがもうない」なら、消す必要はないので、済んだ扱いにする（#115）
      const gone =
        r?.kind === "remove" && req.params.outcome === "failed" && SESSION_GONE.test(reason ?? "");
      const outcome = gone ? "done" : req.params.outcome;
      if (r === undefined || r.nodeId !== nodeId) {
        return fail(
          "notFound",
          "その依頼が見つからない",
          "parent_request で requestRef を確かめる",
        );
      }
      const add = (
        tag: string,
        kind: "info" | "failure" | "stopIncomplete",
        text: string | ReturnType<typeof notice>,
      ): EventBody => ({
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", requestRef, tag),
          kind,
          nodeId,
          ...(typeof text === "string" ? { summary: summarize(text) } : text),
        },
      });
      const bodies: EventBody[] = [
        {
          type: "node.parentReported",
          payload: {
            nodeId,
            requestRef,
            outcome,
            ...(sessionRef === undefined ? {} : { sessionRef }),
            ...(reason === undefined ? {} : { reason }),
            ...(agentState === undefined ? {} : { agentState }),
          },
        },
      ];
      const itemId = requestInboxId(requestRef);
      if (state.inbox.some((i) => i.id === itemId))
        bodies.push({ type: "inbox.resolved", payload: { itemId } });
      // 参照がすでにあるノードの停止・削除の報告に、違う sessionRef が付いていたら拒む
      const known = r.kind === "launch" ? undefined : sessionRefOf(state, nodeId);
      if (known !== undefined && sessionRef !== undefined && sessionRef !== known) {
        return fail(
          "invalidParams",
          "sessionRef が、記録にある子のセッションの id と違う",
          "sessionRef を付けずに報告する（id が違うなら、実行せずに outcome: failed で報告する）",
        );
      }
      // 停止・削除の依頼で、子のセッションの参照が記録になかった: 親はコマンドを組まず、
      // claude agents --json で調べた id を sessionRef で返す。形を確かめてから、command つきの依頼を作り直す。
      if (
        r.kind !== "launch" &&
        outcome === "done" &&
        sessionRef !== undefined &&
        known === undefined
      ) {
        if (!isSessionRef(sessionRef))
          return fail(
            "invalidParams",
            "sessionRef の形が不正",
            "claude agents --json の id を、そのまま入れる",
          );
        const again = withRefOf(nodeId, requestRef);
        bodies.push(
          {
            type: "node.parentRequested",
            payload: { nodeId, requestRef: again, kind: r.kind, worktree: r.worktree },
          },
          {
            type: "inbox.added",
            payload: {
              id: requestInboxId(again),
              kind: "info",
              nodeId,
              ...notice(r.kind === "stop" ? "recreatedStop" : "recreatedRemove", { node: nodeId }),
            },
          },
        );
        const appended = appendAtomically(deps.log, deps.clock, req.requestId, actor, bodies);
        if (!appended.ok) return appended;
        return { ok: true, value: { recorded: true, duplicate: appended.value.duplicate } };
      }
      let confirmed = false;
      if (outcome === "failed") {
        bodies.push(
          r.kind === "remove"
            ? add(
                "parent-failed",
                "failure",
                reason === undefined
                  ? notice("removeRefusedNoReason", { node: nodeId })
                  : notice("removeRefused", { node: nodeId, reason }),
              )
            : add(
                "parent-failed",
                "failure",
                reason === undefined
                  ? notice("parentFailedNoReason", { node: nodeId, kind: r.kind })
                  : notice("parentFailed", { node: nodeId, kind: r.kind, reason }),
              ),
        );
      } else if (r.kind === "stop") {
        // 親の「止めた」だけでは決めない。作業ツリーを使うプロセスがないことを確かめてから stopped にする。
        const left = await remaining(r.worktree);
        const now = deps.log.state();
        const nodeState = now.nodes.find((n) => n.id === nodeId)?.state;
        if (left !== null && left.length === 0 && nodeState === "stopIncomplete") {
          confirmed = true;
          bodies.push(
            {
              type: "node.stopDeclared",
              payload: {
                nodeId,
                note: "親が claude stop を実行し、作業ツリーのプロセスがないことを確かめた",
              },
            },
            { type: "node.stateChanged", payload: { nodeId, event: { type: "confirmStopped" } } },
            ...now.inbox
              .filter(
                (i) =>
                  i.kind === "stopIncomplete" &&
                  i.nodeId === nodeId &&
                  i.resolved === undefined &&
                  i.id !== itemId,
              )
              .map((i): EventBody => ({ type: "inbox.resolved", payload: { itemId: i.id } })),
            add("stop-confirmed", "info", notice("stopVerified", { node: nodeId })),
          );
        }
        // 停止を確かめた（停止未完了から stopped にした・受理した子のセッションを止めた）ら、続けてセッションの削除（claude rm）を依頼する
        if (confirmed || (nodeState === "verified" && left !== null && left.length === 0)) {
          const removeRef = deriveId("preq", nodeId, requestRef, "remove");
          bodies.push(
            {
              type: "node.parentRequested",
              payload: { nodeId, requestRef: removeRef, kind: "remove", worktree: r.worktree },
            },
            {
              type: "inbox.added",
              payload: {
                id: requestInboxId(removeRef),
                kind: "info",
                nodeId,
                ...notice("removeRequest", { node: nodeId }),
              },
            },
          );
        }
        if (!confirmed) {
          bodies.push(
            nodeState === "verified" && left !== null && left.length === 0
              ? add("session-stopped", "info", notice("sessionStopped", { node: nodeId }))
              : add(
                  "stop-unconfirmed",
                  // 受理後（verified など）のノードは、対処が要る停止未完了の状態でないので、info にとどめる（古い項目を残さない）
                  nodeState !== undefined && SETTLED_STATES.has(nodeState)
                    ? "info"
                    : "stopIncomplete",
                  left === null
                    ? notice("stopUnverifiable", { node: nodeId })
                    : left.length > 0
                      ? notice("stopProcessesLeft", { node: nodeId, pids: left.join(", ") })
                      : nodeState === undefined
                        ? notice("stopReportedUnknownState", { node: nodeId })
                        : notice("stopReportedState", { node: nodeId, state: nodeState }),
                ),
          );
        }
      } else if (r.kind === "remove") {
        bodies.push(
          gone
            ? add("removed", "info", notice("sessionGone", { node: nodeId }))
            : add("removed", "info", notice("sessionRemoved", { node: nodeId })),
        );
      }
      if (agentState !== undefined && STALLED_AGENT_STATES.has(agentState)) {
        bodies.push(
          add(
            `agent-${agentState}`,
            "info",
            notice("agentStalled", { node: nodeId, state: agentState }),
          ),
        );
      }
      const appended = appendAtomically(deps.log, deps.clock, req.requestId, actor, bodies);
      if (!appended.ok) return appended;
      if (confirmed && !appended.value.duplicate) {
        try {
          deps.release?.(nodeId);
        } catch {
          // 片付けの失敗は、記録を取り消さない
        }
      }
      return { ok: true, value: { recorded: true, duplicate: appended.value.duplicate } };
    },
  };
}
