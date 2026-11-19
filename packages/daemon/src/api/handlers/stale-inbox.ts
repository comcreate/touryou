/**
 * 受理（verified）・回収可能（reclaimable）・archive 済みのノードに残る、古い停止未完了・失敗の項目を、システムの記録として解決にする。
 * 項目を選ぶのは core の `staleInboxItems`。イベントは書き換えず、`inbox.resolved` を追記するだけ（冪等: 対象がなければ何も足さない）。
 */

import { type EventBody, staleInboxItems } from "@touryou/core";
import { appendAtomically, type LogPort } from "./context.js";

/**
 * 古い項目を解決にする `inbox.resolved` の列。`nodeId` を渡すと、そのノードの項目だけ。
 * 2 回目以降（すべて解決済み）は空。
 */
export function staleResolveBodies(
  state: ReturnType<LogPort["state"]>,
  nodeId?: string,
): EventBody[] {
  return staleInboxItems(state)
    .filter((i) => nodeId === undefined || i.nodeId === nodeId)
    .map((i): EventBody => ({ type: "inbox.resolved", payload: { itemId: i.id } }));
}

/**
 * いまの記録から古い項目を解決にして追記する。対象がなければ追記しない。追記できなかったことは、呼び出し側へ返す
 * （本来の操作の成否には影響させない。起動時の整合が、あとから同じ関数で拾う）。
 */
export function resolveStaleInbox(
  log: LogPort,
  clock: () => string,
  key: string,
  nodeId?: string,
): { readonly ok: true } | { readonly ok: false; readonly cause: string } {
  const bodies = staleResolveBodies(log.state(), nodeId);
  if (bodies.length === 0) return { ok: true };
  const r = appendAtomically(log, clock, key, { system: true }, bodies);
  return r.ok ? { ok: true } : { ok: false, cause: `${r.error.code}: ${r.error.cause}` };
}
