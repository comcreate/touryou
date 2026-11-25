/**
 * CLI の子の紐付け（設計 6.2。仕様 6.2 の Desktop の紐付けと同じ `POST /v1/bind`）。
 *
 * 子のセッションの skill が、最初の番で、mcp の道具 `child_bind` に `nodeId` と紐付けのコードを渡す。mcp は daemon の身元を
 * 確かめてから（コードを偽の daemon へ送らない）、`{ nodeId, bindCode, cwd }` を送り、子ごとの資格情報（子ロールのトークン）を受け取る。
 *
 * - トークンは、このプロセスのメモリの中だけに持つ（ファイル・環境変数・ログ・失敗の原因に書かない）。
 * - `cwd` は、このプロセスの作業ディレクトリ（Claude Code が、セッションの作業ディレクトリで stdio の mcp を起動する前提。推測）。daemon は、それがノードの作業ツリーかを確かめる（FR_006）。
 * - 失敗は区別せず（daemon は 401 だけを返す）、次の操作を添えて返す。
 */
import { type Failure, failure, isSafeId, isSessionId, ok, type Result } from "@touryou/core";
import type { IdentityVerifier } from "./identity.js";

export { CHILD_BIND_TOOL } from "./tools.js";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 16 * 1024;
const TOKEN_RE = /^[\x21-\x7e]{16,8192}$/;

export interface ChildBindOptions {
  readonly daemonUrl: string;
  readonly verifier?: IdentityVerifier;
  readonly fetch?: typeof fetch;
  /** 子のセッションの作業ディレクトリ（既定は `process.cwd()`）。 */
  readonly cwd?: () => string;
  /** 子のセッションの ID（環境変数 `CLAUDE_CODE_SESSION_ID`。あれば送る。daemon が session_id → ノードを記録する）。 */
  readonly sessionId?: string;
  /**
   * コードを書いた daemon の公開 ID（コードのファイルの 2 行目）。渡すと、検証した接続先の daemon の ID と合うときだけ送る。
   * 食い違えば、コードは送らずに `bind_daemon_mismatch` で失敗する（別の daemon のコード）。`verifier` がないときは確かめられない。
   */
  readonly codeDaemonId?: string;
  readonly timeoutMs?: number;
}

export interface ChildCredential {
  readonly nodeId: string;
  /** 子ロールのトークン。メモリの中だけに持つ。 */
  readonly token: string;
}

const bindFailed = (): Failure =>
  failure(
    "bind_failed",
    "紐付けに失敗した（コードが違う・使用済み・期限切れ・別のノードのもの、または作業ツリーの中のセッションでない）",
    "作業を始めずに、会話で人（親）に、紐付けの文面の出し直しを頼む",
    "子のセッションが、そのノードの作業ツリーで起動されたかを確かめる",
  );

/** コードを書いた daemon と、この mcp の接続先の daemon が違う（コードは送っていない）。 */
export const daemonMismatch = (): Failure =>
  failure(
    "bind_daemon_mismatch",
    "紐付けのコードは、いま接続している daemon ではなく、別の daemon が書いたもの（接続先違い。コードは送っていない）",
    "作業を始めずに、会話で人（親）に、この子を作った daemon と、plugin（mcp）の接続先が同じかを確かめてもらう（--config・TOURYOU_DAEMON_CONFIG・cwd から上の .touryou/config.json のどれが効いているか）",
    "接続先を直したら、Claude Code の /mcp で touryou を Reconnect し、child_bind を引数なしでもう一度呼ぶ",
    "それでも合わないときは、親に node_bindCode でコードを出し直してもらう",
  );

/** daemon の失敗の記号（応答の `error.code`）から、理由を区別した失敗にする。コードそのものは含まない。 */
function failureOfDaemonCode(code: unknown): Failure {
  switch (code) {
    case "bindCodeExpired":
      return failure(
        "bind_code_expired",
        "紐付けのコードの期限が切れている",
        "作業を始めずに、会話で人（親）に、node_bindCode でコードを出し直してもらう",
        "出し直されたら、child_bind を引数なしでもう一度呼ぶ",
      );
    case "bindCodeUsed":
      return failure(
        "bind_code_used",
        "紐付けのコードは使用済み",
        "すでに紐付け済みの子なら、そのまま作業を続ける（道具が使えるか whoami で確かめる）",
        "紐付けが外れているなら、会話で人（親）に、node_bindCode でコードを出し直してもらう",
      );
    case "bindWorktreeMismatch":
      return failure(
        "bind_worktree_mismatch",
        "このセッションの作業ディレクトリが、そのノードの作業ツリーと合わない",
        "子のセッションを、そのノードの作業ツリーの一番上（作業ツリーのフォルダそのもの）で起動し直す",
        "別のノードの作業ツリーのセッションから呼んでいないか確かめる",
      );
    default:
      return bindFailed();
  }
}

/** 紐付けのコードで、子ごとの資格情報を受け取る。 */
export async function bindChild(
  opts: ChildBindOptions,
  nodeId: unknown,
  bindCode: unknown,
): Promise<Result<ChildCredential>> {
  if (!isSafeId(nodeId) || typeof bindCode !== "string" || bindCode.length > 64) {
    return {
      ok: false,
      error: failure(
        "invalid_argument",
        "child_bind の引数は { nodeId, bindCode }（文面に書かれたものを、そのまま渡す）",
        "紐付けの文面の nodeId と bindCode を確かめて、呼び直す",
      ),
    };
  }
  return postBind(opts, nodeId, bindCode);
}

/**
 * コードなしのつなぎ直し（#145。`claude attach` で mcp が入れ替わったあと）。セッションの ID・作業ツリー・ノード ID を送り、
 * daemon が記録の値と全部合うときだけ、トークンが出し直される。セッションの ID がなければ送らない（`undefined` が返る）。
 */
export async function rebindChild(
  opts: ChildBindOptions,
  nodeId: unknown,
): Promise<Result<ChildCredential> | undefined> {
  if (!isSafeId(nodeId) || !isSessionIdShape(opts.sessionId)) return undefined;
  return postBind(opts, nodeId, undefined);
}

const isSessionIdShape = (s: string | undefined): s is string => isSessionId(s);

async function postBind(
  opts: ChildBindOptions,
  nodeId: string,
  bindCode: string | undefined,
): Promise<Result<ChildCredential>> {
  let expectedDaemonId: string | undefined;
  if (opts.verifier !== undefined) {
    const v = await opts.verifier.verify();
    if (!v.ok) return { ok: false, error: v.failure };
    expectedDaemonId = v.daemonId;
    // コードを書いた daemon と、いま接続している daemon が違う: コードを送らない（別の daemon に渡さない・使わせない）
    if (opts.codeDaemonId !== undefined && opts.codeDaemonId !== v.daemonId) {
      return { ok: false, error: daemonMismatch() };
    }
  }
  let origin: string;
  try {
    origin = new URL(opts.daemonUrl).origin;
  } catch {
    return {
      ok: false,
      error: failure("invalid_config", "daemon の窓口の URL が不正", "設定を確かめる"),
    };
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await doFetch(`${origin}/v1/bind`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId,
        ...(bindCode === undefined ? {} : { bindCode }),
        cwd: (opts.cwd ?? (() => process.cwd()))(),
        ...(isSessionIdShape(opts.sessionId) ? { sessionId: opts.sessionId } : {}),
      }),
    });
    if (
      expectedDaemonId !== undefined &&
      res.headers.get("x-touryou-daemon-id") !== expectedDaemonId
    ) {
      await res.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        error: failure(
          "daemon_identity_failed",
          "応答の送り手が、検証した daemon と違う（応答は捨てた）",
          "daemon を起動し直し、紐付けの文面を出し直してもらう",
        ),
      };
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        error: failure(
          "rate_limited",
          "紐付けの失敗が続いたため、しばらく受け付けない",
          "数秒待ってから、同じ引数で 1 回だけ呼び直す",
        ),
      };
    }
    const text = await res.text();
    if (text.length > MAX_BYTES) return { ok: false, error: bindFailed() };
    if (res.status !== 200) {
      // 401 の本文の `error.code` で、理由を区別する（期限切れ・使用済み・作業ツリー違い。ほかは、区別しない）
      let daemonCode: unknown;
      try {
        daemonCode = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
      } catch {
        // JSON でない: 区別しない
      }
      return { ok: false, error: failureOfDaemonCode(daemonCode) };
    }
    const body = JSON.parse(text) as {
      ok?: unknown;
      value?: { nodeId?: unknown; token?: unknown };
    };
    const value = body.ok === true ? body.value : undefined;
    if (
      value === undefined ||
      value.nodeId !== nodeId ||
      typeof value.token !== "string" ||
      !TOKEN_RE.test(value.token)
    ) {
      return { ok: false, error: bindFailed() };
    }
    return ok({ nodeId, token: value.token });
  } catch {
    return {
      ok: false,
      error: failure(
        "daemon_unreachable",
        "daemon に届かない（紐付けのコードは使われていない見込み）",
        "daemon が動いているか確かめ、同じ引数で呼び直す",
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}
