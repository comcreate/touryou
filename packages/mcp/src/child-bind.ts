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
import { type Failure, failure, isSafeId, ok, type Result } from "@touryou/core";
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

const isSessionIdShape = (s: string | undefined): s is string =>
  s !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(s);

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
    if (res.status !== 200 || text.length > MAX_BYTES) return { ok: false, error: bindFailed() };
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
