/**
 * ノードの「最後の動き」の数え方（#195）。I/O を持たない純粋関数。
 *
 * 見張り（daemon の cli-watch。「止まっているかも」の判定）と画面（ui-view の `lastActivityAt`）が、
 * 同じ記録から同じ時刻を導くよう、数え方をここ 1 か所に置く（データに近い層）。
 * - 数えるもの: 報告・範囲違反・道具の拒否・指示（子が受け取った時刻だけ。送った時刻は数えない）・親の依頼の報告・
 *   判断の頼みと答え・範囲の頼みと判定。
 * - 数えないもの: 受信箱の項目（「止まっているかも」の知らせ自体が動きに見えてしまうため）。
 *   フックの呼び出しの時刻はメモリだけなので、呼び出し側が `extraMs` で足す。
 */

import type { OrchState } from "./events.js";

/** 時刻の文字列をミリ秒にする。読めない・ない時刻は 0（動きに数えない）。 */
const ms = (iso: string | undefined): number => (iso === undefined ? 0 : Date.parse(iso) || 0);

interface Latest {
  readonly ms: number;
  readonly at: string;
}

/**
 * 記録を 1 回走査して、ノードごとの最後の動きを出す（記録の数に比例）。有効な時刻（`ms` が 0 より大きい）だけを数える。
 * `only` を渡すと、そのノードの分だけを集める（見張りが 1 ノードずつ呼ぶ形）。
 */
function scanActivity(state: OrchState, only?: string): Map<string, Latest> {
  const out = new Map<string, Latest>();
  const add = (nodeId: string, at: string | undefined): void => {
    if (only !== undefined && nodeId !== only) return;
    const t = ms(at);
    if (at === undefined || t <= 0) return;
    const cur = out.get(nodeId);
    if (cur === undefined || t > cur.ms) out.set(nodeId, { ms: t, at });
  };
  for (const x of state.reports) add(x.nodeId, x.at);
  for (const x of state.violations) add(x.nodeId, x.at);
  for (const x of state.toolDenials) add(x.nodeId, x.at);
  // 指示は、子が受け取った時刻だけを数える（#201）。送っただけでは、子が動いたことにならない
  // （止まっている子に指示を送っても「止まっているかも」を消さない。受け取っていない指示は、見張りの「読まれていない指示」が見る）
  for (const x of state.instructions) add(x.nodeId, x.deliveredAt);
  for (const x of state.parentRequests) add(x.nodeId, x.report?.at);
  for (const x of state.decisions) {
    add(x.nodeId, x.requestedAt);
    add(x.nodeId, x.answeredAt);
  }
  for (const x of state.extensions) {
    add(x.nodeId, x.requestedAt);
    add(x.nodeId, x.decidedAt);
  }
  return out;
}

/** ノードの最後の動きの時刻（ミリ秒）。動きの記録がなければ 0。 */
export function lastActivityMs(state: OrchState, nodeId: string, extraMs = 0): number {
  return Math.max(0, extraMs, scanActivity(state, nodeId).get(nodeId)?.ms ?? 0);
}

/** ノードの最後の動きの時刻（記録の文字列のまま。画面用）。動きの記録がなければ undefined。 */
export function lastActivityAt(state: OrchState, nodeId: string): string | undefined {
  return scanActivity(state, nodeId).get(nodeId)?.at;
}

/** 全ノードの最後の動きの時刻（記録の文字列のまま）。1 回の走査で出す。動きの記録がないノードは載せない。 */
export function lastActivityByNode(state: OrchState): Map<string, string> {
  return new Map([...scanActivity(state)].map(([id, v]) => [id, v.at]));
}

/** 判断の答え・範囲の頼みの判定を待っている子か（止まっているのではない。#115・#131）。 */
export const awaitingHuman = (state: OrchState, nodeId: string): boolean =>
  state.decisions.some((d) => d.nodeId === nodeId && d.status === "open") ||
  state.extensions.some((x) => x.nodeId === nodeId && x.status === "open");

/**
 * 止まっているのではなく、待つことが決まっている子か（#195）。「止まっているかも」に数えない。
 * 判断待ち（waiting）・人の答えか判定を待っている子・動いていない子（running 以外）。
 */
export const intentionallyIdle = (state: OrchState, nodeId: string): boolean => {
  const n = state.nodes.find((x) => x.id === nodeId);
  return n === undefined || n.state !== "running" || awaitingHuman(state, nodeId);
};
