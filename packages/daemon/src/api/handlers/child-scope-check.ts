/**
 * 子の範囲（scope）が、親の有効な範囲に収まるかの検査。子の生成（`node.spawn`・`node.split`）と、既存の作業ツリーの
 * 採用（`node.adopt`）で共有する（権限が親を超えないことの判定を、1 か所に置く）。
 *
 * 相対パスは、親の作業ツリーを基準に、子も親も同じ基準で比べる（作業ツリーは別々なので、絶対パスは収まらない）。
 * 親にブリーフがなければ（根など）、daemon の設定の根の範囲（`rootScope`）と比べる。設定がなければ失敗させる（安全側）。
 */

import {
  effectiveScope,
  type Failure,
  failure,
  isScopeSubset,
  type OrchState,
  type Scope,
  validateScope,
} from "@touryou/core";

export function childScopeProblem(req: {
  readonly state: OrchState;
  readonly parentId: string;
  readonly parentCwd: string;
  readonly scope: Scope;
  readonly rootScope: Scope | undefined;
}): Failure | undefined {
  const { state, parentId, parentCwd, scope, rootScope } = req;
  const parentScope = effectiveScope(state, parentId) ?? rootScope;
  if (parentScope === undefined) {
    return failure(
      "rootScopeUnconfigured",
      `親 ${parentId} にブリーフがなく、根の範囲の設定（許可リスト）もない。子の権限を決められない`,
      "daemon の設定に、根の範囲（許可する場所とコマンド）を書く",
    );
  }
  if (rootScope === parentScope && validateScope(parentScope, parentCwd).length > 0) {
    return failure(
      "rootScopeInvalid",
      "daemon の設定の根の範囲が、根の作業ツリーの規則を満たさない",
      "設定の根の範囲を、根の作業ツリーの内側の場所に直す",
    );
  }
  if (!isScopeSubset(scope, parentScope, { child: parentCwd, parent: parentCwd })) {
    // 上限が根の範囲（設定ファイル）のときは、直す場所と、起動し直しが要ることを出す（Issue #5）
    if (rootScope === parentScope)
      return failure(
        "scopeNotSubset",
        "子の範囲が、根の範囲（設定ファイル config.json の rootScope）に収まらない（コマンド・書き込み可能な場所・禁止の場所）",
        "子の範囲を、根の範囲の内側に絞って指定し直す（forbiddenLocations には、根の禁止の場所をすべて含める。禁止は根から引き継ぐ）",
        "根の範囲を広げるなら、人に確かめてから config.json の rootScope（allowedCommands・writableLocations）を直し、touryou config reload で読み込み直す（daemon を起動し直すのでもよい。どちらかをするまで、変更は効かない）",
      );
    return failure(
      "scopeNotSubset",
      "子の範囲が、親の範囲に収まらない（コマンド・書き込み可能な場所・禁止の場所）",
      "親の範囲の内側に絞って指定し直す（forbiddenLocations には、親の禁止の場所をすべて含める。禁止は親から引き継ぐ）",
    );
  }
  return undefined;
}
