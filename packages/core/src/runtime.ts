/**
 * 子の実行環境（runtime）の導出（#159）。I/O を持たない純粋関数。
 *
 * 見張り（daemon の cli-watch）と画面（ui-view）が、同じ答えを出すよう、導出の規則をここ 1 か所に置く。
 * 規則（古い記録との互換）:
 * 1. `node.created` の `runtime` の属性があれば、それ。
 * 2. なければ、親が起動（`launch`）を done で報告した子は `cli`。
 * 3. なければ `undefined`（不明）。不明のノードは、実行環境を推し量らない。
 */

import type { NodeRuntime, OrchState } from "./events.js";

export function runtimeOf(state: OrchState, nodeId: string): NodeRuntime | undefined {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (node?.runtime !== undefined) return node.runtime;
  const launched = state.parentRequests.some(
    (r) => r.nodeId === nodeId && r.kind === "launch" && r.report?.outcome === "done",
  );
  return launched ? "cli" : undefined;
}
