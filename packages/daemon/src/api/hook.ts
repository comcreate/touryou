/**
 * ファイルで設定するフック（plugin の `hooks/hooks.json`）の受け口 `POST /v1/hook` の、入力の検証と、`session_id` とノードの結び付け。
 * PRD: FR_014, IR_002 / `docs/plugin.md` の「フック」
 *
 * - 入力は Claude Code のフック入力（`hook_event_name`・`session_id`・`tool_name`・`tool_input`。`cwd` は判定に使わない）。
 * - `session_id` は、ノードごとに最初に来た値に結ぶ（メモリだけ。daemon を再起動すると結び直しになる）。別の値は拒否する
 *   （同じトークンを、別のセッションで使い回させない）。結び付けは、`node.hookUnbind`（人間・祖先の統合ノード）と、
 *   トークンの発行し直し・失効で外れる。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Failure, failure, type Result } from "@touryou/core";

export type HookEventName = "PreToolUse" | "PostToolUse" | "Stop" | "Notification";

export interface HookRequest {
  readonly event: HookEventName;
  readonly sessionId: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  /** フック入力の cwd（Claude Code が書く。Desktop の子では、daemon の作業ツリーと照らす）。 */
  readonly cwd?: string;
  /** フック入力の transcript_path（`<CLAUDE_CONFIG_DIR>/projects/…/<セッション>.jsonl`。Desktop の子で、設定の場所を知る）。 */
  readonly transcriptPath?: string;
  /** Notification: `notification_type`・`message`・`title`。 */
  readonly notificationType?: string;
  readonly message?: string;
  readonly title?: string;
  /** 共通の入力の prompt_id（Notification の重ねての報告をまとめる）。 */
  readonly promptId?: string;
  /** Stop: フックで続けている最中か。 */
  readonly stopHookActive?: boolean;
}

/** PreToolUse の判定（ノードの範囲で、許可・拒否）。`reason` はモデルへ伝える拒否の理由。 */
export type HookDecider = (
  nodeId: string,
  toolName: string,
  toolInput: unknown,
  cwd?: string,
  transcriptPath?: string,
  /** トークンのない（session_id で引いた）要求の信頼度（記録の行為者に写す）。 */
  trust?: "sessionIdOnly",
) => Promise<
  | {
      readonly allow: true;
      /**
       * 起動のあとに承認した拡張（`scope.extensionDecided`）でだけ通る Bash（#91）。起動のときの許可の一覧（`--settings` の
       * permissions.allow。dontAsk）には入っていないので、フックのコマンドが Claude Code へ明示の許可（permissionDecision: allow）を返す。
       */
      readonly permit?: "extension";
    }
  | { readonly allow: false; readonly reason: string }
>;

const EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse", "Stop", "Notification"]);
const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,200}$/;
const NOTIFICATION_TYPE = /^[a-z0-9_]{1,100}$/;
const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length <= max ? v : undefined;

const bad = (cause: string): { ok: false; error: Failure } => ({
  ok: false,
  error: failure("invalidRequest", cause, "Claude Code のフック入力をそのまま送る"),
});

export function parseHookRequest(body: unknown): Result<HookRequest, Failure> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return bad("フック入力がオブジェクトでない");
  }
  const b = body as Record<string, unknown>;
  const event = b.hook_event_name;
  if (typeof event !== "string" || !EVENTS.has(event)) {
    return bad("hook_event_name が PreToolUse・PostToolUse・Stop・Notification のどれでもない");
  }
  const sessionId = b.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    return bad("session_id がないか、形が正しくない");
  }
  const cwdOf = text(b.cwd, 4096);
  if (event === "Stop") {
    return {
      ok: true,
      value: {
        event,
        sessionId,
        stopHookActive: b.stop_hook_active === true,
        ...(cwdOf === undefined ? {} : { cwd: cwdOf }),
      },
    };
  }
  if (event === "Notification") {
    const t = b.notification_type;
    if (typeof t !== "string" || !NOTIFICATION_TYPE.test(t)) {
      return bad("notification_type がないか、形が正しくない");
    }
    const message = text(b.message, 2000);
    const title = text(b.title, 500);
    const promptId = text(b.prompt_id, 200);
    return {
      ok: true,
      value: {
        event,
        sessionId,
        notificationType: t,
        ...(cwdOf === undefined ? {} : { cwd: cwdOf }),
        ...(message === undefined ? {} : { message }),
        ...(title === undefined ? {} : { title }),
        ...(promptId === undefined ? {} : { promptId }),
      },
    };
  }
  const toolName = b.tool_name;
  if (typeof toolName !== "string" || !TOOL_NAME.test(toolName)) {
    return bad("tool_name がないか、形が正しくない");
  }
  const cwd = typeof b.cwd === "string" && b.cwd.length <= 4096 ? b.cwd : undefined;
  const transcriptPath =
    typeof b.transcript_path === "string" && b.transcript_path.length <= 4096
      ? b.transcript_path
      : undefined;
  return {
    ok: true,
    value: {
      event: event as HookEventName,
      sessionId,
      toolName,
      toolInput: b.tool_input,
      ...(cwd === undefined ? {} : { cwd }),
      ...(transcriptPath === undefined ? {} : { transcriptPath }),
    },
  };
}

export interface SessionBinder {
  /** 最初の値なら結び、結んだ値と同じなら真。別の値なら偽。 */
  check(nodeId: string, sessionId: string): boolean;
  /** 結ばずに確かめる。結び付けがないか、結んだ値と同じなら真（判定で拒否した呼び出しでは結ばないため）。 */
  accepts(nodeId: string, sessionId: string): boolean;
  /** 結び付けを外す。外したら真（結び付けがなければ偽）。次に来た session_id に結び直す。 */
  unbind(nodeId: string): boolean;
  /** 結び付けがあるか（記録の `hadBinding` 用）。 */
  has(nodeId: string): boolean;
}

export function createSessionBinder(): SessionBinder {
  const bound = new Map<string, string>();
  return {
    check(nodeId, sessionId) {
      const s = bound.get(nodeId);
      if (s === undefined) {
        bound.set(nodeId, sessionId);
        return true;
      }
      return s === sessionId;
    },
    accepts(nodeId, sessionId) {
      const s = bound.get(nodeId);
      return s === undefined || s === sessionId;
    },
    unbind(nodeId) {
      return bound.delete(nodeId);
    },
    has(nodeId) {
      return bound.has(nodeId);
    },
  };
}

/**
 * 手動の CLI セッション用の、フック専用のトークンの表。ノードのトークン（`CredentialStore`）とは別に持ち、`POST /v1/hook` だけで使う。
 * ノードごとに 1 つ（発行し直すと、古いものは無効）。ハッシュだけを持ち、メモリだけ（daemon の再起動で無効）。発行から
 * 24 時間（設定で変えられる）で切れる。
 */
export interface HookTokens {
  /** 発行する（そのノードの古いフック用トークンは無効になる）。 */
  issue(nodeId: string): string;
  /** トークンのノード。未知・不正なら undefined。 */
  authenticate(token: unknown): string | undefined;
  revoke(nodeId: string): void;
  /** 直近に期限で失効させたトークンか（応答の失敗の記号を tokenExpired にするため。メモリだけ）。 */
  wasExpired?(token: unknown): boolean;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/** フック用のトークンの、発行からの絶対の期限（既定 24 時間。使わなければ切れる期限は付けない）。 */
export const DEFAULT_HOOK_TOKEN_MAX_AGE_MS = 24 * 3_600_000;

export function createHookTokens(
  options: {
    readonly randomBytes?: (n: number) => Buffer;
    /** 発行からの絶対の期限（ミリ秒）。 */
    readonly maxAgeMs?: number;
    /** 時計（ミリ秒）。経過だけを使う（既定は単調時計。壁時計が巻き戻っても、期限が延びない）。 */
    readonly nowMs?: () => number;
  } = {},
): HookTokens {
  const random = options.randomBytes ?? randomBytes;
  const maxAge = options.maxAgeMs ?? DEFAULT_HOOK_TOKEN_MAX_AGE_MS;
  const nowMs = options.nowMs ?? (() => performance.now());
  const byNode = new Map<string, { hash: Buffer; issuedMs: number }>();
  const expired = new Set<string>();
  const EXPIRED_MAX = 1000;
  return {
    issue(nodeId) {
      const token = random(32).toString("base64url");
      byNode.set(nodeId, { hash: sha256(token), issuedMs: nowMs() });
      return token;
    },
    authenticate(token) {
      if (typeof token !== "string" || token === "") return undefined;
      const h = sha256(token);
      for (const [nodeId, stored] of byNode) {
        if (timingSafeEqual(stored.hash, h)) {
          if (nowMs() - stored.issuedMs >= maxAge) {
            byNode.delete(nodeId); // 期限切れ: 失効させる（`touryou hook-env` で出し直す）
            expired.add(h.toString("hex"));
            if (expired.size > EXPIRED_MAX) {
              const first = expired.values().next().value;
              if (first !== undefined) expired.delete(first);
            }
            return undefined;
          }
          return nodeId;
        }
      }
      return undefined;
    },
    revoke(nodeId) {
      byNode.delete(nodeId);
    },
    wasExpired(token) {
      if (typeof token !== "string" || token === "") return false;
      return expired.has(sha256(token).toString("hex"));
    },
  };
}

/** トークンなし・session_id で引いた報告の記録の行為者（`lookupNodeBySession` の `trust` を写す）。 */
export const sessionActor = (trust: "sessionIdOnly") => ({ system: true, trust }) as const;

/** パス `p` が `root` そのものか、その配下か（文字列で比べる。呼ぶ側で実パスにそろえる）。 */
export const isWithin = (p: string, root: string): boolean => {
  const f = (x: string) => x.normalize("NFC").replace(/\/+$/, "");
  const a = f(p);
  const b = f(root);
  return a === b || a.startsWith(`${b}/`);
};
