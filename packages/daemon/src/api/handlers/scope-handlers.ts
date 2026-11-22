/**
 * 範囲の拡張の操作の実体: 要求（`scope.extend`。子）と判定（`scope.decide`。統合ノード）。
 * PRD: FR_015 / spec 5.5
 *
 * - `scope.extend`: 要求（`scope.extensionRequested`）と、親の受信箱の項目（`violation`。次の操作は `scope_decide`。拡張要求の ID は要約に入れる）を 1 トランザクションで
 *   記録する。対象の書き込み先は、作業ツリーの内側の相対パスに限る（絶対パス・`..`・`/` は、何も記録せずに拒否）。未判定の
 *   上限（10 件。`tooManyOpenExtensions`）と、要求できる状態（running・waiting）は core が判定する。
 * - `scope.decide`: 判定（`scope.extensionDecided`）を記録する。承認（approve）は、記録の前に、拡張後の範囲が作業ツリーの
 *   規則を満たす（`validateScope`）こと、親の範囲に収まる（`isScopeSubset`。ブリーフのない親は `rootScope`）ことを確かめ、
 *   許可した対象（要求と同じもの）を記録してから、有効な範囲（`effectiveScope`）でアダプタを更新する（`updateScope`）。
 *   更新に失敗したら、判定は記録済みのまま、受信箱に `failure` を出して失敗を返す（同じ要求の再送で、更新をやり直す）。
 *   却下・切り出し（reject・split）は記録だけ。判定の対象のノードの祖先（自分を含まない）だけが判定できる。
 */

import {
  type Actor,
  type EventBody,
  type ExtensionRecord,
  effectiveScope,
  evaluate,
  type Failure,
  isMcpToolName,
  isOwnMcpServerTool,
  isScopeSubset,
  isStrictDescendant,
  LIMITS,
  type NodeState,
  type OperationMap,
  type Result,
  runtimeOf,
  type Scope,
  stateOf,
  validateScope,
} from "@touryou/core";
import { growScope, ruleOfExtension } from "../../root-policy.js";
import type { RuntimeAdapter } from "../../sdk/runtime.js";
import type { HandlerRequest } from "../server.js";
import { unquote } from "./child-inbox-handlers.js";
import {
  alreadyApplied,
  appendAtomically,
  deriveId,
  fail,
  type Live,
  type LogPort,
  live,
  notice,
  ruleKindOf,
} from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface ScopeHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  readonly adapterFor: (nodeId: string) => RuntimeAdapter | undefined;
  /** ノードの作業ツリー（実パス）。アダプタ側を正とする。取得できなければ `undefined`（承認しない＝安全側）。 */
  readonly cwdOf: (nodeId: string) => Promise<string | undefined>;
  /** ブリーフのない親（根など）の有効な範囲（`SpawnHandlerDeps.rootScope` と同じ）。 */
  readonly rootScope?: Live<Scope>;
  /**
   * 根の方針の `deny` の規則（`RootPolicy.deny`）。MCP ツールの承認で、deny に当たるものは、上限の内側でも承認しない
   * （deny は allow・ask・範囲より強い。設計書 § 3.3）。省略すると、deny はない。
   * 関数で渡すと、そのつど読む（実行中に足した deny が、すぐ効く。#194 PR4）。
   */
  readonly denyRules?: Live<readonly string[]>;
  /**
   * 根の方針の `ask` の規則（`RootPolicy.ask`）。ask に当たる MCP ツールは、人間だけが承認できる（統合ノードの判定では承認しない）。
   * 省略すると、ask はない。関数で渡すと、そのつど読む（config.reload で入れ替わった ask が、すぐ効く。#194 PR4）。
   */
  readonly askRules?: Live<readonly string[]>;
  /**
   * 「上限にも足して承認」で足す規則が、足したあとの方針の検査を通るか（通らなければ理由。#194 PR4）。
   * 省略すると、規則の長さだけを検査する。
   */
  readonly limitRuleProblem?: (rule: string) => string | undefined;
  /** 応答に出さない原因の記録先。 */
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

const LIVE: ReadonlySet<NodeState> = new Set(["running", "waiting"]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒否するための検査
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** 拡張の対象として使えない値の理由。使えれば `undefined`。 */
function targetProblem(target: { kind: string; value: string }): string | undefined {
  const v = target.value;
  if (v.trim() === "" || v !== v.trim()) return "前後の空白・空の値は使えない";
  if (CONTROL.test(v)) return "制御文字（改行を含む）は使えない";
  if (target.kind === "mcp") {
    // 子の依頼で付与できるのは、完全な名前の道具 1 つだけ（サーバー全体 mcp__<サーバー> は、人間が config に書くときだけ）
    if (!isMcpToolName(v))
      return "MCP ツールは mcp__<サーバー>__<道具> の完全な名前（サーバー全体は頼めない）";
    // 親の道具（node_spawn など）を、拡張で子に付与できてしまうのを防ぐ
    if (isOwnMcpServerTool(v)) return "touryou 自身の MCP サーバーの道具は頼めない";
    return undefined;
  }
  if (target.kind === "write") {
    if (v.startsWith("/")) return "絶対パスは使えない";
    const segs = v.split("/");
    if (segs.some((seg) => seg === "..")) return ".. は使えない";
    if (/[*?[\]{}]/u.test(v)) return "glob 文字（* ? [ ] { }）は使えない";
    if (segs.some((seg) => seg.toLowerCase() === ".git")) return ".git（入れ子を含む）は使えない";
    return undefined;
  }
  if (/[&;|`<>]|\$\(/u.test(v)) return "シェルの連結子・置換（& ; | ` < > $(）は使えない";
  return undefined;
}

export function createScopeHandlers(deps: ScopeHandlerDeps) {
  const { log } = deps;
  const note = (nodeId: string, cause: string): void => {
    try {
      deps.onFailure?.(nodeId, cause);
    } catch {
      // 記録先の失敗は、処理を止めない
    }
  };

  /** 承認の前の検査。問題があれば失敗を返す。 */
  async function checkApprove(
    ext: ExtensionRecord,
    human: boolean,
    /** 「上限にも足して承認」で、上限に足す規則。足したあとの上限で判定する（deny は、これでも承認しない）。 */
    limitRule?: string,
  ): Promise<{ ok: false; error: Failure } | undefined> {
    const state = log.state();
    // 実行中に入れ替わる方針は、要求の中で 1 回だけ読む（同じ値で、上限の文言の分岐〔同一性の比較〕まで通す）
    const rootScope = deps.rootScope === undefined ? undefined : live(deps.rootScope);
    const denyRules = deps.denyRules === undefined ? [] : live(deps.denyRules);
    const askRules = deps.askRules === undefined ? [] : live(deps.askRules);
    const node = state.nodes.find((n) => n.id === ext.nodeId);
    if (node === undefined || node.parentId === null) {
      return fail("notFound", "対象のノードまたはその親が見つからない", "ID を確認する");
    }
    const current = effectiveScope(state, ext.nodeId);
    if (current === undefined) {
      return fail(
        "scopeUnknown",
        `ノード ${ext.nodeId} にブリーフ（範囲）がない`,
        "範囲を確認する",
      );
    }
    // MCP ツールは、deny に当たるなら、上限の内側でも承認しない（人間が deny したものを、承認で通さない）
    if (
      ext.target.kind === "mcp" &&
      evaluate({ allow: [], deny: denyRules, ask: [] }, { kind: "mcp", tool: ext.target.value }) ===
        "deny"
    ) {
      return fail(
        "scopeDenied",
        `MCP ツール ${ext.target.value} は、方針の deny（設定の permissions.deny か、実行中に足した規則）に当たるため承認できない`,
        "却下する",
        "許すなら、人に確かめてから config.json の permissions.deny を直し、touryou config reload で読み込み直してから（実行中に足した deny は、touryou policy remove deny で外す）、もう一度判定する",
      );
    }
    // MCP ツールは、ask に当たるなら、人間だけが承認できる（統合ノードの判定では、子の頼みを自動で通さない）
    if (
      ext.target.kind === "mcp" &&
      !human &&
      evaluate({ allow: [], deny: [], ask: askRules }, { kind: "mcp", tool: ext.target.value }) ===
        "ask"
    ) {
      return fail(
        "forbidden",
        `MCP ツール ${ext.target.value} は、設定の permissions.ask に当たるため、人間だけが承認できる`,
        "人（状態画面）に判定してもらう",
      );
    }
    const grown: Scope =
      ext.target.kind === "write"
        ? {
            ...current,
            writableLocations: [...new Set([...current.writableLocations, ext.target.value])],
          }
        : ext.target.kind === "mcp"
          ? {
              ...current,
              allowedMcpTools: [...new Set([...(current.allowedMcpTools ?? []), ext.target.value])],
            }
          : {
              ...current,
              allowedCommands: [...new Set([...current.allowedCommands, ext.target.value])],
            };
    const [cwd, parentCwd] = await Promise.all([
      deps.cwdOf(ext.nodeId).catch(() => undefined),
      deps.cwdOf(node.parentId).catch(() => undefined),
    ]);
    if (cwd === undefined || parentCwd === undefined) {
      return fail("worktreeUnknown", "作業ツリーを確認できない", "ノードの状態を確認する");
    }
    const issues = validateScope(grown, cwd);
    if (issues.length > 0) {
      return fail(
        "scopeInvalid",
        `拡張後の範囲が作業ツリーの規則を満たさない: ${issues.map((i) => `${i.field}（${i.problem}）`).join("、")}`,
        "対象を、作業ツリーの内側の相対パスにして要求し直させる",
      );
    }
    const brief = effectiveScope(state, node.parentId);
    // 親が根（ブリーフがない）のときだけ、「上限にも足して承認」の規則を、上限に足して比べる
    const parentScope =
      brief ??
      (rootScope === undefined || limitRule === undefined
        ? rootScope
        : {
            ...growScope(rootScope, [limitRule]),
            ...(ext.target.kind === "mcp"
              ? {
                  allowedMcpTools: [
                    ...new Set([...(rootScope.allowedMcpTools ?? []), ext.target.value]),
                  ],
                }
              : {}),
          });
    if (parentScope === undefined) {
      return fail(
        "rootScopeUnconfigured",
        "親にブリーフがなく、根の範囲の設定（許可リスト）もない",
        "daemon の設定に、根の範囲を書く",
      );
    }
    if (!isScopeSubset(grown, parentScope, { child: parentCwd, parent: parentCwd })) {
      // 上限が根の範囲（設定ファイル）のときは、直す場所と、起動し直しが要ることを出す（node.spawn と同じ判定。Issue #5）
      if (brief === undefined)
        return fail(
          "scopeNotSubset",
          ext.target.kind === "mcp"
            ? "MCP ツールが、根の上限（設定ファイル config.json の permissions.allow）にない"
            : "拡張後の範囲が、根の範囲（設定ファイル config.json の rootScope）に収まらない",
          "却下する",
          ext.target.kind === "mcp"
            ? "上限を広げるなら、人に確かめてから、人間の判定で「上限にも足して承認」（scope_decide の alsoLimit。touryou scope decide --also-limit）にするか、config.json の permissions.allow に MCP ツール（mcp__<サーバー>__<道具>）を足して touryou config reload で読み込み直し（daemon を起動し直すのでもよい）、もう一度判定する"
            : "根の範囲を広げるなら、人に確かめてから、人間の判定で「上限にも足して承認」（scope_decide の alsoLimit。touryou scope decide --also-limit）にするか、config.json の rootScope（allowedCommands・writableLocations）を直して touryou config reload で読み込み直し（daemon を起動し直すのでもよい）、もう一度判定する",
        );
      return fail(
        "scopeNotSubset",
        "拡張後の範囲が、親の範囲に収まらない",
        "却下する",
        "親の範囲を広げてから、もう一度判定する",
      );
    }
    return undefined;
  }

  return {
    "scope.extend": (req: HandlerRequest<"scope.extend">): R<"scope.extend"> => {
      const caller = req.caller?.nodeId ?? "";
      const { reason } = req.params;
      // ブリーフ（引用の形）を見たまま書き写した「> …」は、頭の印（と後ろの空白）を外す。印のない値は、そのまま確かめる
      const target = { ...req.params.target, value: unquote(req.params.target.value) };
      const problem = targetProblem(target);
      if (problem !== undefined) {
        return fail(
          "invalidTarget",
          `拡張の対象が使えない: ${problem}（書き込み先は、作業ツリーの内側の相対パス。コマンドは、単純な 1 つのコマンド。MCP ツールは、mcp__<サーバー>__<道具> の完全な名前）`,
          "対象を直して要求し直す",
        );
      }
      // MCP ツールの依頼は、CLI の子だけ（Desktop の子は別のフックの経路。v0.2.0 以降。設計書 確認点 E3）
      if (target.kind === "mcp" && runtimeOf(log.state(), caller) === "desktop") {
        return fail(
          "invalidTarget",
          "MCP ツールの依頼は、CLI の子だけが出せる（Desktop の子は v0.2.0 以降）",
          "親に、MCP ツールが要る作業を CLI の子で進めるよう頼む",
        );
      }
      const extensionId = deriveId("ext", caller, req.requestId, "extension");
      const bodies: EventBody[] = [
        {
          type: "scope.extensionRequested",
          payload: { extensionId, nodeId: caller, target, reason },
        },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", caller, req.requestId, "inbox"),
            kind: "violation",
            nodeId: caller,
            ...notice("extensionRequested", { kind: target.kind, value: target.value }),
            ref: extensionId,
          },
        },
      ];
      const r = appendAtomically(log, deps.clock, req.requestId, { nodeId: caller }, bodies);
      return r.ok ? { ok: true, value: { extensionId } } : r;
    },

    "scope.decide": async (req: HandlerRequest<"scope.decide">): Promise<R<"scope.decide">> => {
      const caller = req.caller?.nodeId ?? "";
      // 人間は、全ノードの拡張を判定できる（部分木の判定の外。判定者は人間として記録する）。
      const human = req.role === "human";
      const actor: Actor = human ? { human: true } : { nodeId: caller };
      const { extensionId, decision } = req.params;
      const state = log.state();
      const ext = state.extensions.find((x) => x.extensionId === extensionId);
      if (ext === undefined) {
        return fail("notFound", "拡張要求が見つからない", "拡張要求の ID を確認する");
      }
      if (!human && !isStrictDescendant(state.nodes, caller, ext.nodeId)) {
        return fail(
          "forbidden",
          "判定できるのは、対象のノードの祖先（統合ノード）だけ",
          "親の統合ノードに依頼する",
        );
      }
      // 「上限にも足して承認」: 根の上限を広げる操作なので、人間だけ（統合ノードは付けられない）
      const alsoLimit = decision === "approve" && req.params.alsoLimit === true;
      if (alsoLimit && !human) {
        return fail(
          "forbidden",
          "上限にも足して承認できるのは、人間だけ（根の上限を広げる操作）",
          "足さずに承認するか、人間に頼む",
        );
      }
      const limitRule = alsoLimit ? ruleOfExtension(ext.target) : undefined;
      if (alsoLimit && limitRule === undefined) {
        return fail(
          "invalidTarget",
          "この対象は、上限の規則に直せない",
          "足さずに承認するか、config.json の permissions.allow に書く",
        );
      }
      // 規則は、記録する前に検査する（長すぎる・方針の検査を通らない規則は、承認の記録ごと失敗させない）
      if (limitRule !== undefined && ext.status === "open") {
        const why =
          limitRule.length > LIMITS.policyRule
            ? `規則が長すぎる（${LIMITS.policyRule} 字まで）`
            : deps.limitRuleProblem?.(limitRule);
        if (why !== undefined) {
          return fail(
            "invalidTarget",
            `この対象は、上限に足せない: ${why}`,
            "足さずに承認するか、config.json の permissions.allow に書く",
          );
        }
      }
      const stateOfNode = (): NodeState | undefined => stateOf(log.state(), ext.nodeId);
      // 承認済みへの再承認: 記録はせず、アダプタの更新だけをやり直す（requestId が違っても。冪等）。
      // 規則は足さないので、alsoLimit つきなら `limitAdded: false` で返す（断ると、同じ要求の再送が失敗する）。
      if (decision === "approve" && ext.status === "approved") {
        const failed = applyToAdapter(ext, extensionId);
        if (failed) return failed;
        return {
          ok: true,
          value: {
            state: stateOfNode() as NodeState,
            ...(alsoLimit ? { limitAdded: false } : {}),
          },
        };
      }
      if (decision === "approve" && ext.status === "open") {
        // 検査は、記録する直前に取り直す（検査の途中の待ちの間に、範囲が変わっていないか）。
        for (let attempt = 0; ; attempt++) {
          const basis = JSON.stringify(effectiveScope(log.state(), ext.nodeId));
          const problem = await checkApprove(ext, human, limitRule);
          if (problem) return problem;
          if (JSON.stringify(effectiveScope(log.state(), ext.nodeId)) === basis) break;
          if (attempt >= 1) {
            return fail("busy", "検査の間に範囲が変わった", "もう一度判定する");
          }
        }
      }
      const limitBodies: readonly EventBody[] =
        limitRule === undefined || ext.status !== "open"
          ? []
          : [
              {
                type: "policy.ruleChanged",
                payload: { list: "allow", rule: limitRule, op: "add" },
              },
              {
                type: "inbox.added",
                payload: {
                  id: deriveId("inbox", "human", req.requestId, "rule"),
                  kind: "info",
                  nodeId: state.nodes.find((n) => n.parentId === null)?.id ?? ext.nodeId,
                  ...notice("policyRuleAdded", { list: "allow", kind: ruleKindOf(limitRule) }),
                },
              },
            ];
      const bodies: EventBody[] = [
        // 上限にも足す: 同じ記録（1 トランザクション）で、規則を足す（承認だけ・規則だけが残ることはない）
        ...limitBodies,
        {
          type: "scope.extensionDecided",
          payload: {
            extensionId,
            decision,
            ...(decision === "approve" ? { granted: ext.target } : {}),
          },
        },
        // 判定したら、親の受信箱の、この拡張要求の項目を解決済みにする（同じ記録で。再送は重複しない）。
        ...state.inbox
          .filter(
            (i) => i.kind === "violation" && i.ref === extensionId && i.resolved === undefined,
          )
          .map((i): EventBody => ({ type: "inbox.resolved", payload: { itemId: i.id } })),
      ];
      const decided = appendAtomically(log, deps.clock, req.requestId, actor, bodies);
      if (!decided.ok) return decided;
      if (decision === "approve") {
        const failed = applyToAdapter(ext, extensionId);
        if (failed) return failed;
      }
      notifyChild(ext, decision, actor, req.requestId);
      return {
        ok: true,
        value: {
          state: stateOfNode() as NodeState,
          ...(alsoLimit ? { limitAdded: limitBodies.length > 0 } : {}),
        },
      };
    },
  };

  /** 承認を、動作中の子のアダプタへ反映する（動作中でなければ、次回の起動で有効な範囲が使われるので、何もしない）。 */
  function applyToAdapter(
    ext: ExtensionRecord,
    extensionId: string,
  ): { ok: false; error: Failure } | undefined {
    const after = log.state();
    if (!LIVE.has(stateOf(after, ext.nodeId) ?? "pending")) return undefined;
    const scope = effectiveScope(after, ext.nodeId);
    const adapter = deps.adapterFor(ext.nodeId);
    let failedWith: string | undefined;
    if (scope === undefined || adapter === undefined) {
      failedWith = "アダプタまたは範囲が見つからない";
    } else {
      try {
        const u = adapter.updateScope(ext.nodeId, scope);
        if (!u.ok) failedWith = `${u.error.code}: ${u.error.cause}`;
      } catch (e) {
        failedWith = String(e);
      }
    }
    if (failedWith === undefined) return undefined;
    note(ext.nodeId, `範囲を更新できない: ${failedWith}`);
    const listed = appendAtomically(
      log,
      deps.clock,
      `update-failed-${extensionId}`,
      { system: true },
      [
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", "system", extensionId, "update-failed"),
            kind: "failure",
            nodeId: ext.nodeId,
            ...notice("extensionUpdateFailed", { extension: extensionId }),
          },
        },
      ],
    );
    if (!listed.ok)
      note(ext.nodeId, `受信箱に載せられない: ${listed.error.code}: ${listed.error.cause}`);
    return fail(
      "scopeUpdateFailed",
      "承認は記録したが、アダプタの範囲を更新できなかった",
      "同じ判定をもう一度送ると、更新をやり直す",
    );
  }

  /** 判定の結果を、動作中の子に追加指示として記録して届ける（失敗は判定を妨げない）。 */
  function notifyChild(
    ext: ExtensionRecord,
    decision: "approve" | "reject" | "split",
    actor: Actor,
    requestId: string,
  ): void {
    if (!LIVE.has(stateOf(log.state(), ext.nodeId) ?? "pending")) return;
    const kindLabel =
      ext.target.kind === "write"
        ? "書き込み先"
        : ext.target.kind === "mcp"
          ? "MCP ツール"
          : "コマンド";
    const what = `${kindLabel} ${ext.target.value}`;
    const text =
      decision === "approve"
        ? ext.target.kind === "command"
          ? `範囲の拡張の要求（${what}）は承認された。使ってよい。承認は引数まで含めたこの形にだけ効く（git add・git status・git ls-files は、うしろに安全な旗とパスを足してもよい。mkdir・touch・cp・git rm・git mv は、パスが書き込める場所（承認した場所を含む）の中にあるときだけ）。形が違うと断られる`
          : `範囲の拡張の要求（${what}）は承認された。使ってよい`
        : decision === "reject"
          ? `範囲の拡張の要求（${what}）は却下された。範囲の内側で進める`
          : `範囲の拡張の要求（${what}）は、作業を切り出して別に進めることになった。範囲の内側で進める`;
    const notifyId = `${requestId}/notify`;
    const before = alreadyApplied(log.state(), actor, notifyId);
    // 種類（状態画面のやり取りの札。#115）
    const kind =
      decision === "approve"
        ? ("extensionApproved" as const)
        : decision === "reject"
          ? ("extensionRejected" as const)
          : ("extensionSplit" as const);
    const r = appendAtomically(log, deps.clock, notifyId, actor, [
      {
        type: "node.instructed",
        payload: { nodeId: ext.nodeId, text, kind },
      },
    ]);
    if (!r.ok) {
      note(ext.nodeId, `判定の通知を記録できない: ${r.error.code}: ${r.error.cause}`);
      return;
    }
    if (before) return;
    const adapter = deps.adapterFor(ext.nodeId);
    if (adapter === undefined) return;
    void adapter.send(ext.nodeId, text).then(
      (sent) => {
        if (!sent.ok) note(ext.nodeId, `判定の通知を届けられない: ${sent.error.code}`);
      },
      (e: unknown) => note(ext.nodeId, `判定の通知を届けられない: ${String(e)}`),
    );
  }
}
