/**
 * 状態画面のチケットとセッション（Issue #88）。どちらもメモリにだけ持つ（daemon を起動し直すと、すべて切れる）。
 *
 * - チケット: `touryou ui` が、人間のトークンで `POST /v1/ui/ticket` からもらう。60 秒・1 回だけ・32 バイトの乱数。
 *   画面が `POST /v1/ui/session` でセッションのトークンに交換する。交換を試みたチケットは、成否によらず、その場で消す。
 * - セッションのトークン: 人間と同じ操作ができる。使わないと 1 時間・発行から最長 12 時間で切れる。`human-token` とは別物。
 * - 値そのものは持たず、SHA-256 のハッシュだけを持つ。照合はハッシュを鍵にした表で引く（値の比較は、長さのそろったハッシュを
 *   `timingSafeEqual` で行う）。
 * - 値は、ログ・記録・画面の表示に出さない（NFR_005）。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface UiSessionExpiry {
  /** チケットの期限。既定 60 秒。 */
  readonly ticketMs: number;
  /** セッションの、使わなければ切れる期限。既定 1 時間。 */
  readonly sessionIdleMs: number;
  /** セッションの、発行からの最長の期限。既定 12 時間。 */
  readonly sessionAbsoluteMs: number;
}
export const DEFAULT_UI_SESSION_EXPIRY: UiSessionExpiry = {
  ticketMs: 60_000,
  sessionIdleMs: 3_600_000,
  sessionAbsoluteMs: 12 * 3_600_000,
};

/** チケット・セッションの数の上限（メモリを増やされない）。超えたら最も古いものを捨てる。 */
const MAX_TICKETS = 64;
const MAX_SESSIONS = 64;

export interface UiSessionStore {
  /** チケットを発行する（43 文字の base64url）。 */
  issueTicket(): string;
  /** チケットをセッションのトークンに交換する。無効・期限切れ・使用済みはすべて `undefined`（理由を分けない）。 */
  exchange(ticket: unknown): string | undefined;
  /** セッションのトークンが有効か。`touch` が真なら、使ったものとして数える（使わなければ切れる期限を延ばす）。 */
  isSession(token: unknown, touch?: boolean): boolean;
  /** すべてのセッションとチケットを失効させる。 */
  revokeAll(): void;
  /** 有効なセッションの数（試験用）。 */
  sessionCount(): number;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function createUiSessionStore(
  options: {
    readonly expiry?: Partial<UiSessionExpiry>;
    /** 単調時計（ミリ秒）。既定は `performance.now`。 */
    readonly nowMs?: () => number;
    /** 試験用。 */
    readonly randomBytes?: (size: number) => Buffer;
  } = {},
): UiSessionStore {
  const expiry = { ...DEFAULT_UI_SESSION_EXPIRY, ...options.expiry };
  const now = options.nowMs ?? (() => performance.now());
  const random = options.randomBytes ?? randomBytes;
  /** ハッシュ（16 進）→ 期限（ミリ秒）。 */
  const tickets = new Map<string, number>();
  /** ハッシュ（16 進）→ 発行・最後に使った時刻。 */
  const sessions = new Map<string, { issuedMs: number; lastUsedMs: number }>();

  const sweep = (): void => {
    const t = now();
    for (const [h, exp] of tickets) if (exp <= t) tickets.delete(h);
    for (const [h, s] of sessions) {
      if (t - s.lastUsedMs >= expiry.sessionIdleMs || t - s.issuedMs >= expiry.sessionAbsoluteMs) {
        sessions.delete(h);
      }
    }
  };
  const cap = <V>(m: Map<string, V>, max: number): void => {
    while (m.size > max) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  };
  /** 表の鍵を引いたあと、ハッシュを一定時間で比べ直す（鍵の一致だけに頼らない）。 */
  const lookup = <V>(m: Map<string, V>, value: string): string | undefined => {
    const h = sha256(value);
    const key = h.toString("hex");
    if (!m.has(key)) return undefined;
    return timingSafeEqual(Buffer.from(key, "hex"), h) ? key : undefined;
  };

  return {
    issueTicket() {
      sweep();
      const ticket = random(32).toString("base64url");
      tickets.set(sha256(ticket).toString("hex"), now() + expiry.ticketMs);
      cap(tickets, MAX_TICKETS);
      return ticket;
    },
    exchange(ticket) {
      sweep();
      if (typeof ticket !== "string" || !TICKET_SHAPE.test(ticket)) return undefined;
      const key = lookup(tickets, ticket);
      if (key === undefined) return undefined;
      const exp = tickets.get(key) ?? 0;
      tickets.delete(key); // 1 回だけ
      if (exp <= now()) return undefined;
      const token = random(32).toString("base64url");
      const t = now();
      sessions.set(sha256(token).toString("hex"), { issuedMs: t, lastUsedMs: t });
      cap(sessions, MAX_SESSIONS);
      return token;
    },
    isSession(token, touch = true) {
      if (typeof token !== "string" || sessions.size === 0) return false;
      sweep();
      const key = lookup(sessions, token);
      if (key === undefined) return false;
      if (touch) {
        const s = sessions.get(key);
        if (s !== undefined) s.lastUsedMs = now();
      }
      return true;
    },
    revokeAll() {
      tickets.clear();
      sessions.clear();
    },
    sessionCount() {
      sweep();
      return sessions.size;
    },
  };
}
