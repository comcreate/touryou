/**
 * 方針の操作の実体（#194 PR4。設計書 § 3.2.1）。どちらも人間だけが呼べる（契約の `ROLE_OPERATIONS`）。
 *
 * - `policy.ruleChange`: 実行中の方針の規則を足す・外す。`policy.ruleChanged` を記録し、受信箱（info）に出す。
 *   足す規則は、解析できて、足したあとの方針の検査（`policyProblem`）を通ること。すでにある規則の足し・ない規則の取り外しは、
 *   何も書かない（`changed: false`）。`deny` も、実行中の層に足せる。
 * - `config.reload`: 設定ファイルを読み直し、検査を通ったときだけ、方針（`rootScope`・`permissions`・`autoApprove`）を入れ替える。
 *   ほかの項目が変わっていれば、名前を返して反映しない（起動のときにだけ読む項目）。新しい上限からはみ出す子は、名前を返して
 *   受信箱に出す（子の範囲は縮めない）。読めない・不正なら、今の方針のまま、失敗を返して受信箱に出す。
 */

import {
  type EventBody,
  effectiveScope,
  type Failure,
  failure,
  isScopeSubset,
  type OperationMap,
  type Result,
  stateOf,
} from "@touryou/core";
import { type DaemonConfig, policyBaseOf, restartRequiredKeys } from "../../config.js";
import { type PolicyHolder, policyProblemWith } from "../../policy-holder.js";
import type { HandlerRequest } from "../server.js";
import {
  appendAtomically,
  deriveId,
  fail,
  type LogPort,
  notice,
  ruleExcerpt,
  withoutPaths,
} from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface PolicyHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  readonly holder: PolicyHolder;
  /** 設定ファイルを読んで検査する（`loadConfigFile` を、パスを束ねて渡す）。 */
  readonly loadConfig: () => Result<DaemonConfig, Failure>;
  /** いま動いている設定（再起動が要る項目の比較に使う）。 */
  readonly runningConfig: () => DaemonConfig;
  /** 入れ替えに成功した設定を受け取る（次の比較の基準にする）。 */
  readonly onReloaded: (config: DaemonConfig) => void;
  /** ノードの作業ツリー（実パス）。取得できなければ `undefined`（その子は、はみ出しの判定から外す）。 */
  readonly cwdOf: (nodeId: string) => Promise<string | undefined>;
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

const LIVE = new Set(["running", "waiting"]);

export function createPolicyHandlers(deps: PolicyHandlerDeps) {
  const { log, holder } = deps;
  /** 受信箱の知らせの宛先（根のノード。なければ固定の名前）。 */
  const anchor = (): string => log.state().nodes.find((n) => n.parentId === null)?.id ?? "root";
  const info = (
    requestId: string,
    tag: string,
    text: { summary: string; msg: ReturnType<typeof notice>["msg"] },
    kind: "info" | "failure" = "info",
  ): EventBody => ({
    type: "inbox.added",
    payload: { id: deriveId("inbox", "human", requestId, tag), kind, nodeId: anchor(), ...text },
  });

  return {
    "policy.ruleChange": (req: HandlerRequest<"policy.ruleChange">): R<"policy.ruleChange"> => {
      const { list, rule, op } = req.params;
      const state = log.state();
      const exists = state.policyRules.some((x) => x.list === list && x.rule === rule);
      if (op === "add" && exists) return { ok: true, value: { changed: false } };
      if (op === "remove" && !exists) {
        // 設定ファイル由来の規則は、ここでは外せない（「変わらなかった」と区別する）
        const base = holder.base();
        const configured = list === "autoApprove" ? base.autoApprove.allow : base.permissions[list];
        if (configured.includes(rule)) {
          return fail(
            "ruleFromConfig",
            "その規則は設定ファイルにあるため、ここでは外せない",
            "設定ファイル config.json を直して、touryou config reload で読み込み直す",
          );
        }
        return { ok: true, value: { changed: false } };
      }
      if (op === "add") {
        // 足したあとの方針が、設定のときと同じ検査（解析・子の許可の形・autoApprove の条件）を通ること
        const problem = policyProblemWith(holder.base(), [...state.policyRules, { list, rule }]);
        if (problem !== undefined) {
          return fail(
            "invalidRule",
            `規則を足せない: ${problem}`,
            "規則の書き方（docs/config.md の permissions）を確かめて、直して送り直す",
          );
        }
      }
      const r = appendAtomically(log, deps.clock, req.requestId, { human: true }, [
        { type: "policy.ruleChanged", payload: { list, rule, op } },
        info(
          req.requestId,
          "rule",
          notice(op === "add" ? "policyRuleAdded" : "policyRuleRemoved", {
            list,
            rule: ruleExcerpt(rule),
          }),
        ),
      ]);
      return r.ok ? { ok: true, value: { changed: !r.value.duplicate } } : r;
    },

    "config.reload": async (req: HandlerRequest<"config.reload">): Promise<R<"config.reload">> => {
      const record = (tag: string, text: ReturnType<typeof notice>, kind?: "failure"): void => {
        const r = appendAtomically(log, deps.clock, `${req.requestId}/${tag}`, { human: true }, [
          info(req.requestId, tag, text, kind),
        ]);
        if (!r.ok) deps.onFailure?.("", `受信箱に載せられない: ${r.error.code}: ${r.error.cause}`);
      };
      let loaded: Result<DaemonConfig, Failure>;
      try {
        loaded = deps.loadConfig();
      } catch (e) {
        loaded = {
          ok: false,
          error: failure("configInvalid", String(e), "設定ファイルを確かめる"),
        };
      }
      if (!loaded.ok) {
        // 設定ファイルのパスは、受信箱にも応答にも出さない（理由の種類だけ）
        const cause = withoutPaths(loaded.error.cause);
        record("failed", notice("configReloadFailed", { cause }), "failure");
        return fail(
          "configInvalid",
          `設定を読み込み直せない（今の方針のまま）: ${cause}`,
          "設定ファイルを直して、もう一度 config.reload を呼ぶ",
        );
      }
      const next = loaded.value;
      const restartRequired = restartRequiredKeys(deps.runningConfig(), next);
      const before = holder.base();
      const after = policyBaseOf(next);
      // 実行中に足した規則と合わせた方針が、検査を通ること（通らなければ、今の方針のまま）
      const mixed = policyProblemWith(after, log.state().policyRules);
      if (mixed !== undefined) {
        const cause = withoutPaths(
          `実行中に足した規則と合わせると、方針が検査を通らない: ${mixed}`,
        );
        record("failed", notice("configReloadFailed", { cause }), "failure");
        return fail(
          "configInvalid",
          `設定を読み込み直せない（今の方針のまま）: ${cause}`,
          "touryou policy remove で実行中の規則を外すか、設定ファイルを直して、もう一度 config.reload を呼ぶ",
        );
      }
      const changed = (["rootScope", "permissions", "autoApprove"] as const).filter(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
      );
      holder.replace(after);
      // 反映した項目だけ、次の比較の基準に取り込む（再起動が要る項目は、起動時のまま残す）
      deps.onReloaded({
        ...deps.runningConfig(),
        ...next,
        ...restrictToRunning(deps, restartRequired),
      });

      // 新しい上限からはみ出す子（親が根のもの）を見つける。子の範囲は縮めない
      const state = log.state();
      const live = holder.current();
      const overLimit: string[] = [];
      for (const n of state.nodes) {
        if (n.parentId === null || !LIVE.has(stateOf(state, n.id) ?? "pending")) continue;
        if (effectiveScope(state, n.parentId) !== undefined) continue; // 親が子のとき、上限は親の範囲（変わらない）
        const scope = effectiveScope(state, n.id);
        if (scope === undefined) continue;
        const cwd = await deps.cwdOf(n.parentId).catch(() => undefined);
        if (cwd === undefined) continue;
        if (!isScopeSubset(scope, live.rootScope, { child: cwd, parent: cwd }))
          overLimit.push(n.id);
      }

      record(
        "reloaded",
        notice("configReloaded", { changed: changed.length === 0 ? "なし" : changed.join("・") }),
      );
      if (restartRequired.length > 0) {
        record("restart", notice("configRestartRequired", { items: restartRequired.join("・") }));
      }
      if (overLimit.length > 0) {
        record("overLimit", notice("configOverLimit", { nodes: overLimit.join("・") }));
      }
      return { ok: true, value: { changed, restartRequired, overLimit } };
    },
  };
}

/** 再起動が要る項目は、反映せず、動いている設定の値のまま残す（次の読み直しで、また「変わっている」と指摘できるように）。 */
function restrictToRunning(
  deps: PolicyHandlerDeps,
  keys: readonly string[],
): Partial<DaemonConfig> {
  const running = deps.runningConfig();
  // 動いている設定にない項目は undefined にする（今の設定の値で、上書きし直す）
  return Object.fromEntries(
    keys.map((k) => [k, Object.getOwnPropertyDescriptor(running, k)?.value]),
  );
}
