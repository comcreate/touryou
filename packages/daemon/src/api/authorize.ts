/**
 * 窓口の認可。認証した主体（ロール・ノード）と操作・引数から、許可するかを決める。
 * PRD: NFR_004, DC_003 / spec 4.1
 *
 * 判定の順序（server.ts）: 認証 → `checkPrincipal`（主体の検査）→ `authorizeRole`（ロール）→ 引数の検証 →
 * `authorizeScope`（部分木）。ロールの持たない操作に、引数の形を教えない。
 *
 * - `checkPrincipal`: ノードのトークンは、ノードが木にあり、トークンのロールが `NodeRecord.role` と合い、停止後
 *   （stopIncomplete・stopped）・回収可能・アーカイブでないときだけ有効（無効なら 401）。停止要求中（stopping）は、
 *   成果の保存の報告のため有効。
 * - `authorizeRole`: 申告（封筒の `role`・`caller`）は、認証した主体と食い違えば拒否する（判定には使わない）。
 *   操作は `ROLE_OPERATIONS` にあるものだけ。
 * - `authorizeScope`: 統合ノードの操作は `INTEGRATOR_OPERATION_CLASS` で分類する。`subtree` は `SUBTREE_RULES` の規則
 *   （strictDescendant・directChild・selfOrDescendant）で対象を判定し、`denied`（`scope.decide`）は拒否、
 *   `callerFiltered` は通す（結果を呼び出し側の部分木に絞るのはハンドラの責務。`visibleState`）。
 *   判断・報告は記録のノードで判定し、範囲外と未知を区別しない（存在を漏らさない）。
 * 引数は検証済み（`validateParams`）の値を渡す。
 */

import {
  type DaemonOperation,
  type FailureMessageKey,
  type failure,
  failureMsg,
  INTEGRATOR_OPERATION_CLASS,
  isDirectChild,
  isInSubtree,
  isStrictDescendant,
  type NodeState,
  type OperationMap,
  type OrchState,
  type Result,
  ROLE_OPERATIONS,
  SUBTREE_RULES,
  type SubtreeOperation,
  type SubtreeRule,
} from "@touryou/core";
import type { Principal } from "./credentials.js";

type Failure = ReturnType<typeof failure>;
type Params = OperationMap[DaemonOperation]["params"];

export interface Claims {
  readonly claimedRole?: string;
  readonly claimedCaller?: string;
}

const OK = { ok: true, value: undefined } as const;
type Args = Readonly<Record<string, string | number>>;
const forbidden = (key: FailureMessageKey, args: Args = {}): { ok: false; error: Failure } => ({
  ok: false,
  error: failureMsg(
    "forbidden",
    key,
    args,
    "この操作を持つロールで呼び出す",
    "親（統合ノード）に依頼する",
  ),
});
const notFound = (key: FailureMessageKey, args: Args = {}): { ok: false; error: Failure } => ({
  ok: false,
  error: failureMsg("notFound", key, args, "ID を確認する", "受信箱の参照 ID（ref）を確認する"),
});
const unauthenticated = (
  key: FailureMessageKey,
  args: Args = {},
): { ok: false; error: Failure } => ({
  ok: false,
  error: failureMsg(
    "unauthenticated",
    key,
    args,
    "正しい資格情報で呼び出す",
    "資格情報を再発行する",
  ),
});

/** トークンを無効にするノードの状態（子のプロセスが止まった後）。stopping は成果の保存の報告のため有効。 */
const REVOKED_STATES: ReadonlySet<NodeState> = new Set([
  "stopIncomplete",
  "stopped",
  "reclaimable",
  "archived",
]);

export function checkPrincipal(principal: Principal, state: OrchState): Result<undefined, Failure> {
  if (principal.role === "human") return OK;
  const node = state.nodes.find((n) => n.id === principal.nodeId);
  if (node === undefined) return unauthenticated("nodeNotInTree", { node: principal.nodeId });
  if ((principal.role === "integrator") !== (node.role === "integrator")) {
    return unauthenticated("tokenRoleMismatch");
  }
  if (REVOKED_STATES.has(node.state)) {
    return unauthenticated("nodeStateInvalid", { state: node.state });
  }
  return OK;
}

export function authorizeRole(
  principal: Principal,
  operation: DaemonOperation,
  claims: Claims,
): Result<undefined, Failure> {
  if (claims.claimedRole !== undefined && claims.claimedRole !== principal.role) {
    return forbidden("claimedRoleMismatch");
  }
  if (claims.claimedCaller !== undefined) {
    if (principal.role === "human" || claims.claimedCaller !== principal.nodeId) {
      return forbidden("claimedCallerMismatch");
    }
  }
  if (!(ROLE_OPERATIONS[principal.role] as readonly string[]).includes(operation)) {
    return forbidden("roleLacksOperation", { role: principal.role, op: operation });
  }
  return OK;
}

const satisfies = (
  rule: SubtreeRule,
  nodes: OrchState["nodes"],
  caller: string,
  target: unknown,
): boolean => {
  if (typeof target !== "string") return false;
  switch (rule) {
    case "strictDescendant":
      return isStrictDescendant(nodes, caller, target);
    case "directChild":
      return isDirectChild(nodes, caller, target);
    case "selfOrDescendant":
      return isInSubtree(nodes, caller, target);
  }
};

export function authorizeScope(
  principal: Principal,
  operation: DaemonOperation,
  params: Params,
  state: OrchState,
): Result<undefined, Failure> {
  if (principal.role === "human") return OK;
  const nodes = state.nodes;
  if (!nodes.some((n) => n.id === principal.nodeId)) {
    return forbidden("nodeNotInTree", { node: principal.nodeId });
  }
  if (principal.role !== "integrator") return OK;

  const op = operation as keyof typeof INTEGRATOR_OPERATION_CLASS;
  const cls = INTEGRATOR_OPERATION_CLASS[op];
  if (cls === undefined || cls === "denied") {
    return forbidden("integratorOperationUnavailable", { op: operation });
  }
  if (cls === "callerFiltered") return OK;

  const caller = principal.nodeId;
  const rule = SUBTREE_RULES[op as SubtreeOperation];
  const p = params as Record<string, unknown>;
  const outside = forbidden("outsideSubtree");
  switch (op) {
    case "node.spawn":
      return satisfies(rule, nodes, caller, p.parentId) ? OK : outside;
    case "decision.present": {
      const ids = p.pauseNodeIds;
      if (ids === undefined) return OK;
      return Array.isArray(ids) && ids.every((id) => satisfies(rule, nodes, caller, id))
        ? OK
        : outside;
    }
    case "decision.get": {
      const owner = state.decisions.find((d) => d.decisionId === p.decisionId)?.nodeId;
      return satisfies(rule, nodes, caller, owner) ? OK : notFound("decisionNotFound");
    }
    case "scope.decide": {
      // 対象は、拡張の発生元のノード（拡張要求の nodeId）。
      const owner = state.extensions.find((x) => x.extensionId === p.extensionId)?.nodeId;
      return satisfies(rule, nodes, caller, owner) ? OK : notFound("extensionNotFound");
    }
    case "report.get": {
      const owner = state.reports.find((r) => r.reportId === p.reportId)?.nodeId;
      return satisfies(rule, nodes, caller, owner) ? OK : notFound("reportNotFound");
    }
    default:
      return satisfies(rule, nodes, caller, p.nodeId) ? OK : outside;
  }
}

/** ロール → 部分木の順で判定する（引数の検証は間に入れる。server.ts）。 */
export function authorize(
  principal: Principal,
  operation: DaemonOperation,
  params: Params,
  state: OrchState,
  claims: Claims,
): Result<undefined, Failure> {
  const role = authorizeRole(principal, operation, claims);
  return role.ok ? authorizeScope(principal, operation, params, state) : role;
}
