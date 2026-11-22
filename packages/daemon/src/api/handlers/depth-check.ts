/**
 * 木の深さの上限の検査（spawn・adopt で共通。#168 PR4）。
 *
 * 新しいノードを追加した木を `validateTree` に `maxTreeDepth` つきで渡し、新しいノードの `depthExceeded` だけを失敗にする
 * （検査の規則は core の 1 か所に置き、ここでは持たない）。深さは root=0。新しいノードの深さが `maxTreeDepth` 以上なら断る。
 */

import {
  DEFAULT_MAX_TREE_DEPTH,
  type Failure,
  failure,
  type NodeRole,
  type OrchState,
  validateTree,
} from "@touryou/core";

export function depthProblem(req: {
  readonly state: OrchState;
  readonly nodeId: string;
  readonly parentId: string;
  readonly role: NodeRole;
  /** 設定 `maxTreeDepth`。省略すると `DEFAULT_MAX_TREE_DEPTH`。 */
  readonly maxTreeDepth?: number | undefined;
}): Failure | undefined {
  const { state, nodeId, parentId, role } = req;
  const maxTreeDepth = req.maxTreeDepth ?? DEFAULT_MAX_TREE_DEPTH;
  const nodes = [
    ...state.nodes.map((n) => ({ id: n.id, role: n.role, parentId: n.parentId })),
    { id: nodeId, role, parentId },
  ];
  const exceeded = validateTree(nodes, { maxTreeDepth }).find(
    (v) => v.kind === "depthExceeded" && v.nodeId === nodeId,
  );
  if (exceeded === undefined || exceeded.kind !== "depthExceeded") return undefined;
  return failure(
    "depthExceeded",
    `木の深さの上限を超える（親 ${parentId} の下のノードは深さ ${exceeded.depth}。上限 maxTreeDepth は ${exceeded.maxTreeDepth}。根を 0 と数える）`,
    "このノードを、深さが上限に収まる親（より浅い統合ノード）の下に作る",
    "もっと深くしたいときは、人に確かめてから設定ファイル config.json の maxTreeDepth を上げ、daemon を起動し直す（起動し直すまで、変更は効かない）",
  );
}
