/**
 * 自分のノードの出来事を購読する（設計 6.3）。`GET /v1/events?node=<id>&after=<seq>`（SSE）。
 *
 * - 起動時: 最初の接続は `after` を付けない（daemon は、その時点より後の出来事だけを送る）。起動の前に置かれた指示は、受信箱と
 *   番の区切りのフックで拾う（知らせは、受信箱を読ませるきっかけにすぎない）。
 * - 切れたら（daemon の再起動・寿命・ネットワーク）: 待ってから、接続先とトークンを読み直し、最後に受けた seq の続きから取り直す。
 * - 出来事が来たら、短い間（`coalesceMs`）まとめて、知らせを 1 行だけ書く（番号は、まとめた中で最大の seq）。
 * - トークンつきの要求の前に、daemon の身元を確かめる（ほかの要求と同じ）。トークンは、ログに出さない。
 * - daemon がトークンを拒んだら（whoami・購読の 401。`unauthenticated`）、張り直しをやめる（記録は 1 回だけ。`onAuthFailed` を呼ぶ）。
 *   同じトークンで張り直しても通らない（daemon の記録を詰まらせるだけ）。つながらない・daemon が落ちているときは、いままでどおり張り直す。
 * - daemon が `event: retired`（トークンが役目の終わりで失効した）を送ってきたら、401 を待たずに、同じく張り直しをやめる
 *   （記録は `subscribeRetired` を 1 回。`onAuthFailed` を呼ぶ）。古い daemon（`retired` を送らない）とは、今までどおり。
 */
import type { Result } from "@touryou/core";

export interface SubscribeTarget {
  readonly daemonUrl: string;
  readonly token: string;
  /** 分かっていれば（子の資格情報）。なければ、身元を確かめたあとで `resolveNode` で引く。 */
  readonly nodeId?: string;
}

export interface NodeSubscriberDeps {
  /** 接続先・トークン（再接続のたびに読み直す）。**トークンを送らない**（読むだけ）。 */
  readonly target: () => Promise<Result<SubscribeTarget>>;
  /** 身元を確かめたあとで、自分のノードを引く（`/v1/whoami`。トークンを送る）。`nodeId` があれば、一致を確かめる。 */
  readonly resolveNode?: (t: SubscribeTarget) => Promise<Result<string>>;
  /** トークンを送る前の、daemon の身元の確かめ。`false` なら送らない。 */
  readonly verify: (t: SubscribeTarget) => Promise<boolean>;
  readonly fetch?: typeof fetch;
  /**
   * 知らせを書く（`notify-socket.ts`）。番号は seq。書けたら `written: true`。書けなければ、その番号は捨てずに、次の出来事のときに
   * まとめて知らせ直す（中身は受信箱にあるので、番号は最大の 1 つでよい）。書けないことは、続く間 1 回だけ記録する。
   */
  readonly notify: (
    seq: number,
    /** まとめた出来事を出した、直接の子のノード（送り手。受け手が、自分に関わるかを判断できるように）。 */
    childIds: readonly string[],
  ) => Promise<{ readonly written: boolean; readonly reason?: string }>;
  /** 購読したセッション（根のモードの `CLAUDE_CODE_SESSION_ID`。知らせの宛先）。 */
  readonly sessionId?: string;
  /** つながっていたと見なす時間（既定 30 秒）。これより短く切れ、出来事も受けていなければ、待ちを延ばす。 */
  readonly healthyAfterMs?: number;
  /** 続きの起点（資格情報が変わっても同じノードなら、前の購読の `lastSeq` を引き継ぐ）。 */
  readonly initialSeq?: number;
  /** 単調時計（試験用）。 */
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (e: Record<string, unknown>) => void;
  /** まとめる間（既定 300ms）。 */
  readonly coalesceMs?: number;
  /** daemon がトークンを拒んで（401）購読をやめたときに 1 回呼ぶ（子なら、資格情報の入れ物を空にする）。 */
  readonly onAuthFailed?: () => void;
  /**
   * 渡すと、401 でも止めずに、この長さだけ待って張り直す（根。トークンの入れ替えのあとに戻れるように）。記録は
   * `AUTH_LOG_WINDOW_MS` の窓ごとに 1 回（`subscribeAuthFailed`。窓の間に抑えた回数を `suppressed` に）。`onAuthFailed` は呼ばない。
   */
  readonly authRetryMs?: number;
}

export interface NodeSubscriber {
  /** 最後に受けた seq（まだなら `undefined`）。 */
  readonly lastSeq: number | undefined;
  stop(): void;
  /** 購読の輪が終わるまで（`stop` のあと）。 */
  readonly done: Promise<void>;
}

/** 根の購読が 401 を受けたときの待ち（ms）。 */
export const AUTH_RETRY_MS = 60_000;
/** 根の購読の 401 の記録の窓（ms）。窓ごとに 1 回だけ記録する。 */
export const AUTH_LOG_WINDOW_MS = 10 * 60_000;

/** 再接続の待ち（ms）。最後の値を繰り返す。 */
export const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

interface SseMessage {
  event: string;
  id?: string;
  data: string;
}

/** SSE の行を、メッセージに分ける（`\n\n` 区切り）。残りを返す。 */
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  const messages: SseMessage[] = [];
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const m: SseMessage = { event: "message", data: "" };
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") m.event = value;
      else if (field === "id") m.id = value;
      else if (field === "data") m.data = m.data === "" ? value : `${m.data}\n${value}`;
    }
    messages.push(m);
  }
  return { messages, rest };
}

export function startNodeSubscriber(deps: NodeSubscriberDeps): NodeSubscriber {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const log = (e: Record<string, unknown>): void => {
    try {
      deps.log?.({ ...e, at: new Date().toISOString() });
    } catch {
      // 記録の失敗で、購読を止めない
    }
  };
  let lastSeq: number | undefined = deps.initialSeq;
  let stopped = false;
  let abort: AbortController | undefined;
  let pending: number | undefined;
  let flushing: Promise<void> = Promise.resolve();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** 書けなかった最大の番号（次の出来事のときに、まとめて知らせ直す）。 */
  let unsent: number | undefined;
  /** 書けない状態が続いているか（続く間は、記録を 1 回だけにする）。 */
  let failing = false;
  const now = deps.nowMs ?? (() => Date.now());
  /** まとめている間の、送り手の子（と、書けなかった分）。 */
  const pendingChildren = new Set<string>();
  const unsentChildren = new Set<string>();

  const flush = (): void => {
    flushTimer = undefined;
    const seq = pending;
    pending = undefined;
    const childIds = [...pendingChildren, ...unsentChildren];
    pendingChildren.clear();
    if (seq === undefined) return;
    flushing = flushing
      .then(async () => {
        const r = await deps.notify(seq, [...new Set(childIds)]);
        if (!r.written) for (const id of childIds) unsentChildren.add(id);
        else unsentChildren.clear();
        if (r.written) {
          unsent = undefined;
          if (failing) log({ event: "notifyRecovered", seq });
          failing = false;
          return;
        }
        unsent = Math.max(unsent ?? 0, seq);
        if (!failing) log({ event: "notifyUnavailable", seq, reason: r.reason ?? "unknown" });
        failing = true;
      })
      .catch((e: unknown) => {
        unsent = Math.max(unsent ?? 0, seq);
        for (const id of childIds) unsentChildren.add(id);
        const err = e as { name?: unknown; code?: unknown };
        log({
          event: "notifyFailed",
          name: typeof err?.name === "string" ? err.name : "Error",
          ...(typeof err?.code === "string" ? { code: err.code } : {}),
        });
      });
  };
  const enqueue = (seq: number, childId?: string): void => {
    if (childId !== undefined) pendingChildren.add(childId);
    pending = Math.max(pending ?? 0, unsent ?? 0, seq);
    if (flushTimer === undefined) {
      flushTimer = setTimeout(flush, deps.coalesceMs ?? 300);
      flushTimer.unref?.();
    }
  };

  /**
   * 1 回の試みの結果。`true`: 健全につながっていた。`false`: 張り直す。`"auth"`: トークンを拒まれた（張り直さない）。
   * `"retired"`: daemon が退役を知らせた（張り直さない）。
   */
  async function once(): Promise<boolean | "auth" | "retired"> {
    const t = await deps.target();
    if (stopped) return false;
    if (!t.ok) {
      log({ event: "subscribeTargetFailed", code: t.error.code });
      return false;
    }
    // 身元を確かめてから、トークンを送る（whoami も購読も、確かめのあと）。
    const verified = await deps.verify(t.value);
    if (stopped) return false; // 止めたあとは、トークンを送らない
    if (!verified) {
      log({ event: "subscribeIdentityFailed" });
      return false;
    }
    // 自分のノードは whoami で引く。資格情報が nodeId を持つとき（子）は、whoami と同じことを確かめる（食い違えば購読しない）。
    let nodeId = t.value.nodeId;
    if (deps.resolveNode !== undefined) {
      const n = await deps.resolveNode(t.value);
      if (stopped) return false;
      if (!n.ok) {
        if (n.error.code === "unauthenticated") return "auth";
        log({ event: "subscribeNodeUnknown", code: n.error.code });
        return false;
      }
      if (nodeId !== undefined && n.value !== nodeId) {
        log({ event: "subscribeNodeMismatch" });
        return false;
      }
      nodeId = n.value;
    }
    if (nodeId === undefined) return false;
    const q = new URLSearchParams({ node: nodeId });
    if (deps.sessionId !== undefined) q.set("session", deps.sessionId);
    if (lastSeq !== undefined) q.set("after", String(lastSeq));
    abort = new AbortController();
    const res = await doFetch(`${t.value.daemonUrl}/v1/events?${q.toString()}`, {
      headers: { authorization: `Bearer ${t.value.token}`, accept: "text/event-stream" },
      signal: abort.signal,
    });
    if (res.status === 401) {
      await res.body?.cancel().catch(() => undefined);
      return "auth";
    }
    if (res.status !== 200 || res.body === null) {
      log({ event: "subscribeRejected", status: res.status });
      await res.body?.cancel().catch(() => undefined);
      return false;
    }
    log({ event: "subscribed", resumeFrom: lastSeq ?? null });
    // 書けなかった知らせがあれば、張り直したときに 1 回書き直す（次の出来事を待たない）。
    if (unsent !== undefined) enqueue(unsent);
    const connectedAt = now();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let got = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parsed = parseSse(buf);
      buf = parsed.rest;
      for (const m of parsed.messages) {
        if (m.event === "ready" && lastSeq === undefined) {
          // 最初の接続の起点（daemon が決めた「今」）。再接続は、ここからの続きにする（再起動の間の出来事を落とさない）。
          try {
            const from = (JSON.parse(m.data) as { from?: unknown }).from;
            if (typeof from === "number" && Number.isSafeInteger(from)) lastSeq = from;
          } catch {
            // 起点がなければ、次の出来事から
          }
          continue;
        }
        if (m.event === "retired") {
          // トークンが役目の終わりで失効した。張り直しても 401 になるだけなので、ここで止める。
          await reader.cancel().catch(() => undefined);
          return "retired";
        }
        if (m.event !== "node") continue;
        let seq: unknown;
        let childId: unknown;
        try {
          const d = JSON.parse(m.data) as { seq?: unknown; childId?: unknown };
          seq = d.seq;
          childId = d.childId;
        } catch {
          continue;
        }
        if (typeof seq !== "number" || !Number.isSafeInteger(seq)) continue;
        if (lastSeq !== undefined && seq <= lastSeq) continue; // 重複は捨てる
        lastSeq = seq;
        got = true;
        enqueue(
          seq,
          typeof childId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(childId)
            ? childId
            : undefined,
        );
      }
    }
    // 健全と見なすのは、出来事を受けたか、一定の時間つながっていたときだけ（受け付けてすぐ切る相手に、詰めて張り直さない）。
    return got || now() - connectedAt >= (deps.healthyAfterMs ?? 30_000);
  }

  const done = (async () => {
    let attempt = 0;
    /** 根の 401 の記録: 窓の始まりと、抑えた回数。 */
    let authLoggedAt: number | undefined;
    let authSuppressed = 0;
    while (!stopped) {
      let healthy = false;
      try {
        let r = await once();
        // 根（authRetryMs あり）は、退役しない（期限を付けない）。届いても、401 と同じ扱い（待って張り直す）。
        if (r === "retired" && deps.authRetryMs !== undefined) r = "auth";
        if (r === "auth" && deps.authRetryMs !== undefined) {
          if (stopped) break;
          const t = now();
          if (authLoggedAt === undefined || t - authLoggedAt >= AUTH_LOG_WINDOW_MS) {
            log({ event: "subscribeAuthFailed", suppressed: authSuppressed });
            authLoggedAt = t;
            authSuppressed = 0;
          } else authSuppressed += 1;
          attempt = 0;
          await sleep(deps.authRetryMs);
          continue;
        }
        if (r === "auth" || r === "retired") {
          if (!stopped) {
            stopped = true;
            log({ event: r === "retired" ? "subscribeRetired" : "subscribeAuthStopped" });
            try {
              deps.onAuthFailed?.();
            } catch {
              // 知らせの失敗で、止め方を変えない
            }
          }
          break;
        }
        healthy = r;
        if (r && authLoggedAt !== undefined) {
          log({ event: "subscribeAuthRecovered" });
          authLoggedAt = undefined;
          authSuppressed = 0;
        }
      } catch (e) {
        if (!stopped)
          log({ event: "subscribeError", cause: e instanceof Error ? e.name : "error" });
      }
      if (stopped) break;
      attempt = healthy ? 0 : attempt + 1;
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 8_000;
      await sleep(wait);
    }
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flush();
    }
    await flushing;
  })();

  return {
    get lastSeq() {
      return lastSeq;
    },
    stop() {
      stopped = true;
      abort?.abort();
    },
    done,
  };
}
