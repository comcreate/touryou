/**
 * 実行中の根の方針の保持（#194 PR4。設計書 § 3.2）。
 *
 * 実効の上限 = config の方針（基準。`config.reload` で入れ替える）∪ 実行中に足した規則（イベント `policy.ruleChanged` から導く）。
 * 判定のたびに `current()` を呼ぶ。基準も実行中の規則も変わらない間は、同じオブジェクトを返す
 * （`rootScope === parentScope` の同一性の比較〔上限の文言の分岐〕が、1 回の要求の中で崩れないように）。
 */

import type { PolicyRuleRecord, Scope } from "@touryou/core";
import {
  type AutoApproveConfig,
  buildRootPolicy,
  growScope,
  type PermissionsConfig,
  policyProblem,
  type RootPolicy,
} from "./root-policy.js";

/** 入れ替えられる方針（config の `rootScope`・`permissions`・`autoApprove`）。 */
export interface PolicyBase {
  readonly rootScope: Scope;
  readonly permissions: PermissionsConfig;
  readonly autoApprove: AutoApproveConfig;
}

/** 判定に使う、今の方針。 */
export interface LivePolicy {
  /** 根の範囲（子の権限の上限）。基準の `rootScope` に、実行中に足した `allow` と、上限の MCP ツールを足したもの。 */
  readonly rootScope: Scope;
  /** 基準と実行中の規則を畳んだ方針。 */
  readonly policy: RootPolicy;
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];

function derive(base: PolicyBase, rules: readonly PolicyRuleRecord[]): LivePolicy {
  const by = (list: PolicyRuleRecord["list"]): string[] =>
    rules.filter((r) => r.list === list).map((r) => r.rule);
  const permissions: PermissionsConfig = {
    allow: uniq([...base.permissions.allow, ...by("allow")]),
    deny: uniq([...base.permissions.deny, ...by("deny")]),
    ask: uniq([...base.permissions.ask, ...by("ask")]),
  };
  const autoApprove: AutoApproveConfig = {
    allow: uniq([...base.autoApprove.allow, ...by("autoApprove")]),
  };
  const policy = buildRootPolicy(base.rootScope, permissions, autoApprove);
  const grown = growScope(base.rootScope, by("allow"));
  const rootScope: Scope = {
    ...grown,
    ...(policy.allowedMcpTools.length === 0 ? {} : { allowedMcpTools: policy.allowedMcpTools }),
  };
  return { rootScope, policy };
}

/**
 * 基準 `base` に、実行中の規則 `rules` を足した方針が、設定のときと同じ検査（解析・子の許可の形・autoApprove の条件）を通るか。
 * 通れば `undefined`、通らなければ理由。規則を足す前（足したあとの方針で）、`config.reload` の入れ替えの前に使う。
 */
export function policyProblemWith(
  base: PolicyBase,
  rules: readonly Pick<PolicyRuleRecord, "list" | "rule">[],
): string | undefined {
  const by = (list: PolicyRuleRecord["list"]): string[] =>
    rules.filter((r) => r.list === list).map((r) => r.rule);
  return policyProblem(
    growScope(base.rootScope, by("allow")),
    {
      allow: uniq([...base.permissions.allow, ...by("allow")]),
      deny: uniq([...base.permissions.deny, ...by("deny")]),
      ask: uniq([...base.permissions.ask, ...by("ask")]),
    },
    { allow: uniq([...base.autoApprove.allow, ...by("autoApprove")]) },
  );
}

export interface PolicyHolder {
  /** 今の方針。基準も規則も変わらない間は、同じオブジェクト。 */
  current(): LivePolicy;
  /** 今の基準（入れ替える前の比較に使う）。 */
  base(): PolicyBase;
  /** 基準を入れ替える（検査を通したものだけを渡す）。 */
  replace(next: PolicyBase): void;
}

/** `rules` は、実行中の規則（`state().policyRules`）を返す関数。 */
export function createPolicyHolder(
  initial: PolicyBase,
  rules: () => readonly PolicyRuleRecord[],
): PolicyHolder {
  let base = initial;
  let memo: { base: PolicyBase; rules: readonly PolicyRuleRecord[]; value: LivePolicy } | undefined;
  return {
    current() {
      const now = rules();
      // 状態の配列は、イベントのたびに別の参照になるので、規則の中身（list・rule の並び）で比べる
      const same =
        memo !== undefined &&
        memo.rules.length === now.length &&
        memo.rules.every((r, i) => r.list === now[i]?.list && r.rule === now[i]?.rule);
      if (memo === undefined || memo.base !== base || !same) {
        memo = { base, rules: now, value: derive(base, now) };
      }
      return memo.value;
    },
    base: () => base,
    replace(next) {
      base = next;
    },
  };
}
