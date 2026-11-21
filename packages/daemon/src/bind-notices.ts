/**
 * 紐付け（bind）のトークンの期限にまつわる知らせ（#189）。compose から切り出して、結線を試験で確かめられるようにする。
 *
 * - 失効の知らせ（`tokenExpiredIdleBind`・`tokenExpiredAbsoluteBind`）と、失効の前の知らせ（`tokenIdleSoonBind`）は、受信箱の info。
 *   状態画面のカードの札は、未解決の失効の知らせから導く。紐付けが結び直されたら、どれも解決にする（`resolveBindNotices`）。
 * - 失効の前の知らせは、親へは受信箱の info、子へは system の追加指示。同じ「最後に使った時刻」には 1 回だけ（要求 ID で冪等）。
 */

import {
  type Actor,
  type EventBody,
  type InboxItem,
  type InboxMessageKey,
  inboxMessageText,
  type OrchState,
} from "@touryou/core";
import { appendAtomically, deriveId, type LogPort, notice } from "./api/handlers/context.js";

/** トークンの見回りの間隔（ミリ秒）。 */
export const TOKEN_SWEEP_MS = 5 * 60_000;

/**
 * 失効の前の知らせを出す、切れるまでの残り時間。見回りの間隔の 2 倍（既定 10 分）。見回りの間に窓を通り過ぎないよう、
 * 窓は見回りの間隔より長くする。使わなければ切れる期限が、見回りの間隔の 4 倍より短いと、窓が期限の半分を超えて、使った直後から
 * 「もうすぐ切れる」になってしまうので、知らせない（`undefined`）。
 */
export const idleWarnMsOf = (
  bindIdleMs: number,
  sweepMs: number = TOKEN_SWEEP_MS,
): number | undefined => (bindIdleMs >= 4 * sweepMs ? 2 * sweepMs : undefined);

/** 紐付けの期限にまつわる知らせの鍵。結び直されたら、どれも解決にする。 */
export const BIND_NOTICE_KEYS: ReadonlySet<string> = new Set<InboxMessageKey>([
  "tokenExpiredIdleBind",
  "tokenExpiredAbsoluteBind",
  "tokenIdleSoonBind",
]);

/** 失効の前の知らせの鍵だけ（失効・復帰で解決にする対象）。 */
export const IDLE_SOON_KEYS: ReadonlySet<string> = new Set<InboxMessageKey>(["tokenIdleSoonBind"]);

const SYSTEM: Actor = { system: true };

/** そのノードの、未解決の知らせ（`keys` の鍵のもの）。 */
export const openBindNotices = (
  state: OrchState,
  nodeId: string,
  keys: ReadonlySet<string> = BIND_NOTICE_KEYS,
): InboxItem[] =>
  state.inbox.filter(
    (i) =>
      i.nodeId === nodeId && i.resolved === undefined && i.msg !== undefined && keys.has(i.msg.key),
  );

/** 解決にする `inbox.resolved` の本体（対象がなければ空）。 */
export const resolveBodies = (items: readonly InboxItem[]): EventBody[] =>
  items.map((i) => ({ type: "inbox.resolved", payload: { itemId: i.id } }));

/**
 * そのノードの、未解決の知らせ（紐付けの期限にまつわる）を、1 回の追記で解決にする。対象がなければ何も書かない。
 * 要求 ID は、対象の項目から決める（同じ対象への再試行は重複にならず、別の対象には別の ID になる）。
 * 戻り値: 書けたか（対象がないときも `true`）。失敗のときは、その符号。
 */
export function resolveBindNotices(
  log: LogPort,
  clock: () => string,
  nodeId: string,
  keys: ReadonlySet<string> = BIND_NOTICE_KEYS,
): { ok: true } | { ok: false; code: string } {
  const items = openBindNotices(log.state(), nodeId, keys);
  if (items.length === 0) return { ok: true };
  const ids = items.map((i) => i.id).join(",");
  const r = appendAtomically(
    log,
    clock,
    `bind-notice-resolved/${nodeId}/${deriveId("h", "system", ids, "bind-notice-resolved")}`,
    SYSTEM,
    resolveBodies(items),
  );
  return r.ok ? { ok: true } : { ok: false, code: r.error.code };
}

/** 子への追加指示の文。日本語・英語を並べる（子は、どちらの言語の利用者のもとでも読める。画面には出さない文）。 */
export const idleSoonInstruction = (minutes: number): string => {
  const m = { key: "tokenIdleSoonChild", args: { minutes } };
  return `${inboxMessageText("ja", m) ?? ""} ${inboxMessageText("en", m) ?? ""}`.trim();
};

export interface IdleSoonDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  readonly stateOf: (nodeId: string) => string | undefined;
  readonly note: (event: string, data: Record<string, unknown>) => void;
}

/**
 * 失効の前の知らせを書く。running の子だけ（判断待ち・done は時計が止まる）。戻り値は、記録できたか
 * （`credentials` が、出した印を立てるかを決める。running でない・記録の失敗は `false`＝次の見回りで、もう一度）。
 * 同じ「最後に使った時刻」への再試行は、要求 ID が同じなので重複せず、`true` を返す。
 */
export function createIdleSoonNotifier(
  deps: IdleSoonDeps,
): (info: { nodeId: string; lastUsedMs: number; remainingMs: number }) => boolean {
  return (info) => {
    const { nodeId, lastUsedMs } = info;
    if (deps.stateOf(nodeId) !== "running") return false;
    const mins = Math.max(1, Math.ceil(info.remainingMs / 60_000));
    const key = `token-idle-soon/${nodeId}/${lastUsedMs}`;
    const r = appendAtomically(deps.log, deps.clock, key, SYSTEM, [
      {
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", key, "token-idle-soon"),
          kind: "info",
          nodeId,
          ...notice("tokenIdleSoonBind", { node: nodeId, minutes: mins }),
        },
      },
      {
        type: "node.instructed",
        payload: { nodeId, text: idleSoonInstruction(mins), kind: "tokenIdleSoon" },
      },
    ]);
    if (!r.ok) {
      deps.note("tokenIdleSoonNoticeFailure", { nodeId, cause: r.error.code });
      return false;
    }
    return true;
  };
}
