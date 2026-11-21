/**
 * ノードの「最後の動き」の数え方（#195）。I/O を持たない純粋関数。
 *
 * 見張り（daemon の cli-watch。「止まっているかも」の判定）と画面（ui-view の `lastActivityAt`）が、
 * 同じ記録から同じ時刻を導くよう、数え方をここ 1 か所に置く（データに近い層）。
 * - 数えるもの: 報告・範囲違反・道具の拒否・指示（送った時刻と受け取った時刻の両方）・親の依頼の報告・
 *   判断の頼みと答え・範囲の頼みと判定。
 * - 数えないもの: 受信箱の項目（「止まっているかも」の知らせ自体が動きに見えてしまうため）。
 *   フックの呼び出しの時刻はメモリだけなので、呼び出し側が `extraMs` で足す。
 */

import { isPrefaceInstruction, type OrchState } from "./events.js";

const ms = (iso: string | undefined): number => (iso === undefined ? 0 : Date.parse(iso) || 0);

/** 動きの時刻（記録の文字列）を、数え方の 1 か所で集める。 */
function activityTimes(state: OrchState, nodeId: string): (string | undefined)[] {
  const of = <T extends { nodeId: string }>(xs: readonly T[]): T[] =>
    xs.filter((x) => x.nodeId === nodeId);
  return [
    ...of(state.reports).map((x) => x.at),
    ...of(state.violations).map((x) => x.at),
    ...of(state.toolDenials).map((x) => x.at),
    // 指示は、送った時刻も数える（子が動いていて、まだ受け取っていない間に「止まっているかも」を出さない）
    // daemon の前置き（#189）は、記録した時刻では動かさず、子が受け取った時刻だけを数える
    ...of(state.instructions).flatMap((x) =>
      isPrefaceInstruction(x) ? [x.deliveredAt] : [x.at, x.deliveredAt],
    ),
    ...of(state.parentRequests).map((x) => x.report?.at),
    ...of(state.decisions).flatMap((x) => [x.requestedAt, x.answeredAt]),
    ...of(state.extensions).flatMap((x) => [x.requestedAt, x.decidedAt]),
  ];
}

/** ノードの最後の動きの時刻（ミリ秒）。動きの記録がなければ 0。 */
export function lastActivityMs(state: OrchState, nodeId: string, extraMs = 0): number {
  return Math.max(0, extraMs, ...activityTimes(state, nodeId).map(ms));
}

/** ノードの最後の動きの時刻（記録の文字列のまま。画面用）。動きの記録がなければ undefined。 */
export function lastActivityAt(state: OrchState, nodeId: string): string | undefined {
  let best: string | undefined;
  for (const t of activityTimes(state, nodeId)) {
    if (typeof t === "string" && t !== "" && (best === undefined || ms(t) > ms(best))) best = t;
  }
  return best;
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
