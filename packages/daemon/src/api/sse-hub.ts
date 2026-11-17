/**
 * SSE の接続の管理（`docs/ui.md`）。`ServerResponse` から切り離してあるので、背圧・寿命・失効の確認を、偽の出力先（`SseSink`）で確かめられる。
 *
 * - 送るのは `lastSeq` の通知だけ。1 つの周期（`coalesceMs`）で、全ての接続を見る。変わっていれば通知（連続した変化は最新の 1 件にまとまる）。
 * - **背圧**: `write()` が `false` を返したら、`drain` が来るまで、その接続には何も送らない。`drainTimeoutMs` 来なければ、切る（遅い・止まった相手）。
 * - **寿命**: 接続は、`maxLifetimeMs` で閉じる（画面は、再接続する）。
 * - **譲る**: 人の側の接続が `maxConnections` に達したら、いちばん古いものに `event: replaced` を送って閉じ、新しい接続を通す。
 * - **失効の確認**: トークンが使えるかを、通知とは独立に、`heartbeatMs` ごとに確かめる（使えなければ閉じる）。
 * - **heartbeat**: `heartbeatMs` の間、何も書かなければ、コメント行を書く。
 * - **退役**: ノードのトークンが役目の終わり（受理など）で失効したら、閉じる前に `event: retired` を 1 件送る（`retire()`。
 *   heartbeat の確かめで見つけたときも同じ）。購読する側（mcp）は、これを受けたら張り直さない。中身は理由の種類だけ。
 */

import type { ServerResponse } from "node:http";
import type { InboxKind, OrchState } from "@touryou/core";

/**
 * ノードごとの出来事（設計 6.3）。記録（状態）から作るので、`seq` を指定すれば取り直せる。
 * 中身（指示の本文など）は載せない。中身は受信箱（`inbox_fetch`）で読む。
 * - `instruction`: 追加指示（`node.send`・差し戻し・判断の回答・起こす指示。どれも `node.instructed`）
 * - `stop`: 停止の指示（`stopRequests`）
 * - `child`: 直接の子の受信箱の項目
 * - `request`: 直接の子についての、親への依頼（ParentRequest）。宛先は、その子の親のセッション（`node.parentSessionSet`）
 *   だけ。記録がなければ流さない（受信箱とフックで拾う）。
 */
export type NodeEventKind = "instruction" | "stop" | "child" | "request";
export interface NodeEvent {
  readonly seq: number;
  readonly kind: NodeEventKind;
  /** `child`: 項目を出した直接の子（受け手が、自分に関わるかを判断できるように）。 */
  readonly childId?: string;
  /**
   * 宛先のセッション。ある間は、この session_id で購読している接続にだけ流す（合う接続がなければ、どこにも流さない。
   * 受信箱とフックで拾う）。ない（親の操作がまだ記録にない）間は、そのノードの根の購読がちょうど 1 本のときだけ、そこに流す。外には出さない。
   */
  readonly target?: string;
  /**
   * 統合ノードの、宛先の決まらない出来事（親の操作がまだ記録にない）。そのノードの購読がちょうど 1 本のときだけ流す。子のノードの
   * 出来事には付けない（子の自分の購読は、張り直しの重なりで 2 本になっても受ける）。外には出さない。
   */
  readonly exclusive?: true;
}

/** 親に知らせる、直接の子の受信箱の項目の種類（中間統合ノードを起こす種類〔`wake.ts`〕と同じ）。 */
export const CHILD_EVENT_KINDS: ReadonlySet<InboxKind> = new Set([
  "decision",
  "violation",
  "failure",
  "stopIncomplete",
  "done",
]);

/** 1 回に送る出来事の上限（残りは次の周期で送る）。 */
export const NODE_FEED_BATCH = 100;

export function nodeFeedOf(state: OrchState, nodeId: string, afterSeq: number): NodeEvent[] {
  // 宛先: 子に関わる出来事は、その子の親のセッション。子に関わらない出来事は、最後に親の操作をしたセッション（どちらも記録から）。
  const children = new Map<string, string | undefined>();
  let last: { sessionId: string; seq: number } | undefined;
  for (const n of state.nodes) {
    if (n.parentId !== nodeId) continue;
    children.set(n.id, n.parentSession?.sessionId);
    if (n.parentSession !== undefined && (last === undefined || n.parentSession.seq > last.seq)) {
      last = n.parentSession;
    }
  }
  const integrator = state.nodes.find((n) => n.id === nodeId)?.role === "integrator";
  const undecided = integrator ? { exclusive: true as const } : {};
  const own = last === undefined ? undecided : { target: last.sessionId };
  const out: NodeEvent[] = [];
  for (const i of state.instructions) {
    if (i.nodeId === nodeId && i.seq > afterSeq)
      out.push({ seq: i.seq, kind: "instruction", ...own });
  }
  for (const r of state.stopRequests) {
    if (r.nodeId === nodeId && r.seq > afterSeq) out.push({ seq: r.seq, kind: "stop", ...own });
  }
  if (children.size > 0) {
    for (const item of state.inbox) {
      if (item.seq <= afterSeq || !CHILD_EVENT_KINDS.has(item.kind) || !children.has(item.nodeId))
        continue;
      const target = children.get(item.nodeId) ?? last?.sessionId;
      out.push({
        seq: item.seq,
        kind: "child",
        childId: item.nodeId,
        ...(target === undefined ? undecided : { target }),
      });
    }
  }
  if (children.size > 0) {
    for (const r of state.parentRequests) {
      if (r.seq <= afterSeq || r.report !== undefined || !children.has(r.nodeId)) continue;
      const target = children.get(r.nodeId);
      // 親のセッションの記録がない子への依頼は、ほかのセッションに流さない（最後に親の操作をしたセッションにも流さない）。
      if (target === undefined) continue;
      out.push({ seq: r.seq, kind: "request", childId: r.nodeId, target });
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out.slice(0, NODE_FEED_BATCH);
}

export const nodeSseEvent = (e: NodeEvent): string =>
  `id: ${e.seq}\nevent: node\ndata: ${JSON.stringify({
    seq: e.seq,
    kind: e.kind,
    ...(e.childId === undefined ? {} : { childId: e.childId }),
  })}\n\n`;

export interface SseSink {
  /** `false` は、書き込みが詰まったこと（`drain` が来るまで、待つ）。 */
  write(chunk: string): boolean;
  end(): void;
  destroy(): void;
  readonly destroyed: boolean;
  onDrain(callback: () => void): void;
  onClose(callback: () => void): void;
}

export interface SseHubSpec {
  readonly maxConnections: number;
  readonly coalesceMs: number;
  readonly heartbeatMs: number;
  /** `write()` が `false` を返してから、`drain` を待つ上限。 */
  readonly drainTimeoutMs: number;
  /** 1 つの接続の最大の寿命。 */
  readonly maxLifetimeMs: number;
}

export interface SseHubDeps {
  readonly spec: SseHubSpec;
  /** 今の `lastSeq`。 */
  readonly getSeq: () => number;
  /** トークンが、今も使えるか。 */
  readonly isTokenValid: (token: string) => boolean;
  /** 単調時計（ミリ秒）。 */
  readonly nowMs: () => number;
  /** `false` なら、周期を自動で回さない（試験が `tick()` を呼ぶ）。 */
  readonly autoStart?: boolean;
  /** ノードの購読の出来事（`addNode` を使うときに要る）。 */
  readonly nodeFeed?: (nodeId: string, afterSeq: number) => readonly NodeEvent[];
  /** ノードの購読の同時の上限。既定 64。 */
  readonly maxNodeConnections?: number;
  /**
   * ノードの購読のトークンが、今もそのノードのものとして使えるか（失効・ノードの停止〔REVOKED_STATES〕・役割の食い違いなら `false`）。
   * heartbeat ごとに確かめ、`false` なら切る。省略すると `isTokenValid` だけで見る。
   */
  readonly isNodeTokenValid?: (token: string, nodeId: string) => boolean;
  /** 使えないトークンが、役目の終わり（退役）で失効したものか（heartbeat の確かめで閉じるとき、`retired` を送るかを決める）。 */
  readonly isTokenRetired?: (token: string) => boolean;
}

/** 退役の出来事（設計 6.3）。中身は理由の種類だけ（トークン・nodeId は載せない）。 */
export const RETIRED_SSE_EVENT = `event: retired\ndata: ${JSON.stringify({ reason: "retired" })}\n\n`;
/** 画面の購読の枠が埋まり、新しいタブの接続に場所を譲るために閉じるとき、閉じる前に送る 1 件（中身は空。画面は張り直さない）。 */
export const REPLACED_SSE_EVENT = "event: replaced\ndata: {}\n\n";

export interface SseHub {
  readonly size: number;
  /** 接続を加える。上限なら `false`（何も書かない）。加えたら、今の `lastSeq` をすぐ送る。 */
  add(sink: SseSink, token: string): boolean;
  /** ノードの購読。`afterSeq` より後の出来事を、すぐ送り直し、以後は新しい出来事を送る。上限なら `false`。 */
  addNode(
    sink: SseSink,
    token: string,
    nodeId: string,
    afterSeq: number,
    sessionId?: string,
  ): boolean;
  readonly nodeSize: number;
  /**
   * そのノードの購読（`GET /v1/events?node=`）が、いま 1 本でもあるか。CLI の子は、これで指示を受け取る。
   * 差し戻し（reject）のとき、購読がなければ、指示がすぐには届かないことを親の受信箱に知らせる。
   */
  hasSubscription(nodeId: string): boolean;
  /** そのノードの購読に `retired` を送ってから閉じる（退役の場から呼ぶ。heartbeat を待たない）。閉じた本数を返す。 */
  retire(nodeId: string): number;
  tick(): void;
}

interface Conn {
  readonly sink: SseSink;
  readonly token: string;
  readonly startedMs: number;
  /** ノードの購読なら、そのノード。 */
  readonly nodeId?: string;
  /** ノードの購読の、購読したセッション（宛先の決め）。 */
  readonly sessionId?: string;
  /**
   * ノードの購読: 取り置いた出来事（統合ノードの、宛先の決まらないもの）。最大の seq の 1 件だけを持つ（中身は受信箱にあり、知らせは
   * 最大の番号 1 つで足りる）。購読が 1 本に戻ったら、宛先を確かめ直してから配る。
   */
  held: NodeEvent | undefined;
  /** ノードの購読: 最後に出来事を調べたときの `getSeq()`（変わっていなければ、調べない）。 */
  feedCheckedAt?: number;
  sentSeq: number;
  lastWriteMs: number;
  lastAuthMs: number;
  /** `write()` が `false` を返した時刻（`drain` で消える）。 */
  blockedSinceMs: number | undefined;
}

/** `ServerResponse` を、出力先にする（`write()` の戻り値と `drain` を、そのまま使う）。 */
export const responseSink = (res: ServerResponse): SseSink => ({
  write: (chunk) => res.write(chunk),
  end: () => res.end(),
  destroy: () => res.destroy(),
  get destroyed() {
    return res.destroyed;
  },
  onDrain: (cb) => res.on("drain", cb),
  onClose: (cb) => res.once("close", cb),
});

export const sseEvent = (seq: number): string =>
  `id: ${seq}\nevent: seq\ndata: ${JSON.stringify({ lastSeq: seq })}\n\n`;

export function createSseHub(deps: SseHubDeps): SseHub {
  const { spec } = deps;
  const conns = new Set<Conn>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopTimerIfIdle = (): void => {
    if (conns.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const drop = (c: Conn): void => {
    conns.delete(c);
    stopTimerIfIdle();
  };
  const send = (c: Conn, chunk: string): void => {
    const now = deps.nowMs();
    const ok = c.sink.write(chunk);
    c.lastWriteMs = now;
    if (!ok && c.blockedSinceMs === undefined) c.blockedSinceMs = now;
  };

  /**
   * 統合ノードの購読の数え方: session_id ごとに 1 本（同じ session_id の接続どうしは 1 本。張り直しの重なりで
   * 知らせを落とさない）。session を付けない購読は、それぞれ 1 本と数える。
   */
  const unitsOf = (nodeId: string): number => {
    const sessions = new Set<string>();
    let bare = 0;
    for (const x of conns) {
      if (x.nodeId !== nodeId || x.sink.destroyed) continue;
      if (x.sessionId === undefined) bare += 1;
      else sessions.add(x.sessionId);
    }
    return sessions.size + bare;
  };

  /** ノードの未送の出来事を送る。送ったら `true`。詰まったら、そこで止める（残りは `drain` のあと）。 */
  const flushNode = (c: Conn): boolean => {
    if (c.nodeId === undefined || deps.nodeFeed === undefined) return false;
    let wrote = false;
    // 統合ノードの、宛先の決まらない出来事は、購読がちょうど 1 本のときだけ流す。2 本以上の間は、接続ごとに取り置き（番号は進めるが、
    // 捨てない）、1 本に戻ったら配る。数えるのは、この呼び出しの頭で 1 回。
    const single = unitsOf(c.nodeId) === 1;
    if (single && c.held !== undefined && c.blockedSinceMs === undefined) {
      const held = c.held;
      c.held = undefined;
      // 取り置いたあとに宛先が決まっていれば、その接続あてのときだけ配る（宛先を見ずに配らない）。
      const now = deps.nodeFeed(c.nodeId, held.seq - 1).find((x) => x.seq === held.seq);
      if (now !== undefined && (now.target === undefined || now.target === c.sessionId)) {
        send(c, nodeSseEvent(now));
        wrote = true;
      }
    }
    // 記録が変わっていなければ、調べない（接続ごと・周期ごとに、全件をなめない）。取り置きがある間は、1 本に戻るのを待つ。
    const seqNow = deps.getSeq();
    if (c.feedCheckedAt === seqNow) return wrote;
    let drained = true;
    const events = deps.nodeFeed(c.nodeId, c.sentSeq);
    for (const e of events) {
      c.sentSeq = e.seq;
      // 宛先が決まっている出来事は、そのセッションの接続だけに流す（ほかには流さない。番号だけ進める）。
      if (e.target !== undefined && e.target !== c.sessionId) continue;
      // 統合ノードの、宛先の決まらない出来事（親の操作がまだ記録にない）: 2 本以上の間は取り置く。子のノードの出来事は、全部の接続に流す。
      if (e.exclusive === true && !single) {
        if (c.held === undefined || e.seq > c.held.seq) c.held = e;
        continue;
      }
      send(c, nodeSseEvent(e));
      wrote = true;
      if (c.blockedSinceMs !== undefined) {
        drained = false;
        break;
      }
    }
    // 1 回に送る上限で切れたか、詰まって止めたときは、次の周期でも調べる。
    const batchFull = events.length >= NODE_FEED_BATCH;
    if (drained && !batchFull) c.feedCheckedAt = seqNow;
    return wrote;
  };
  const countNodes = (): number => [...conns].filter((c) => c.nodeId !== undefined).length;
  const ensureTimer = (): void => {
    if (timer === undefined && deps.autoStart !== false) {
      timer = setInterval(tick, spec.coalesceMs);
      timer.unref();
    }
  };

  /** `retired` を送ってから閉じる（詰まっていても、1 件だけ書いてから閉じる）。 */
  const closeRetired = (c: Conn): void => {
    drop(c);
    if (c.sink.destroyed) return;
    try {
      c.sink.write(RETIRED_SSE_EVENT);
    } catch {
      // 書けなくても閉じる
    }
    c.sink.end();
  };

  function tick(): void {
    const seq = deps.getSeq();
    const now = deps.nowMs();
    for (const c of [...conns]) {
      if (!conns.has(c)) continue; // この周期の中で、ほかの場（退役）で閉じた
      if (c.sink.destroyed) {
        drop(c);
        continue;
      }
      if (now - c.startedMs >= spec.maxLifetimeMs) {
        c.sink.end(); // 寿命。画面は再接続する
        drop(c);
        continue;
      }
      // 失効の確認は、通知とは独立に、heartbeatMs ごと
      if (now - c.lastAuthMs >= spec.heartbeatMs) {
        c.lastAuthMs = now;
        const valid =
          c.nodeId !== undefined && deps.isNodeTokenValid !== undefined
            ? deps.isNodeTokenValid(c.token, c.nodeId)
            : deps.isTokenValid(c.token);
        if (!conns.has(c)) continue; // 確かめの中で失効し、退役の場で閉じた
        if (!valid) {
          if (c.nodeId !== undefined && deps.isTokenRetired?.(c.token) === true) {
            closeRetired(c);
            continue;
          }
          c.sink.end();
          drop(c);
          continue;
        }
      }
      if (c.blockedSinceMs !== undefined) {
        // 詰まっている間は、何も書かない（溜めない）。`drain` が来なければ、切る
        if (now - c.blockedSinceMs >= spec.drainTimeoutMs) {
          c.sink.destroy();
          drop(c);
        }
        continue;
      }
      if (c.nodeId !== undefined) {
        if (!flushNode(c) && now - c.lastWriteMs >= spec.heartbeatMs) send(c, ": heartbeat\n\n");
        continue;
      }
      if (c.sentSeq !== seq) {
        send(c, sseEvent(seq));
        c.sentSeq = seq;
      } else if (now - c.lastWriteMs >= spec.heartbeatMs) {
        send(c, ": heartbeat\n\n");
      }
    }
  }

  return {
    get size(): number {
      return conns.size - countNodes();
    },
    get nodeSize(): number {
      return countNodes();
    },
    hasSubscription(nodeId) {
      for (const c of conns) if (c.nodeId === nodeId && !c.sink.destroyed) return true;
      return false;
    },
    retire(nodeId) {
      let n = 0;
      for (const c of [...conns]) {
        if (c.nodeId !== nodeId) continue;
        closeRetired(c);
        n += 1;
      }
      return n;
    },
    addNode(sink, token, nodeId, afterSeq, sessionId) {
      if (countNodes() >= (deps.maxNodeConnections ?? 64)) return false;
      const now = deps.nowMs();
      const c: Conn = {
        sink,
        token,
        nodeId,
        ...(sessionId === undefined ? {} : { sessionId }),
        startedMs: now,
        sentSeq: Math.max(0, Math.floor(afterSeq)),
        lastWriteMs: now,
        lastAuthMs: now,
        blockedSinceMs: undefined,
        held: undefined,
      };
      conns.add(c);
      sink.onDrain(() => {
        c.blockedSinceMs = undefined;
      });
      sink.onClose(() => drop(c));
      // 最初に、再接続の間隔と ready（始めの seq。購読する側は、これを続きの起点にする）を送る（購読する側は、これで「つながった」と分かる）。取りこぼしは、続けて送る。
      send(c, `retry: 3000\nevent: ready\ndata: ${JSON.stringify({ from: c.sentSeq })}\n\n`);
      if (c.blockedSinceMs === undefined) flushNode(c);
      ensureTimer();
      return true;
    },
    add(sink, token) {
      // 枠が埋まっていたら、いちばん古い人の側の接続（人間のトークン・画面のセッション）を、`event: replaced` を送ってから閉じる。
      // 開き直すたびに増える古いタブが枠を占めて、今見ているタブが 429 を受け続けないように。ノード（子・統合）の接続には触らない。
      // `replaced` の中身は空（ほかのタブ・セッションの値を出さない）
      if (conns.size - countNodes() >= spec.maxConnections) {
        const humans = [...conns].filter((x) => x.nodeId === undefined);
        const oldest = humans.reduce<Conn | undefined>(
          (a, x) => (a === undefined || x.startedMs < a.startedMs ? x : a),
          undefined,
        );
        if (oldest === undefined || spec.maxConnections <= 0) return false;
        drop(oldest);
        if (!oldest.sink.destroyed) {
          try {
            oldest.sink.write(REPLACED_SSE_EVENT);
          } catch {
            // 書けなくても閉じる
          }
          oldest.sink.end();
        }
      }
      const now = deps.nowMs();
      const seq = deps.getSeq();
      const c: Conn = {
        sink,
        token,
        startedMs: now,
        sentSeq: seq,
        lastWriteMs: now,
        lastAuthMs: now,
        blockedSinceMs: undefined,
        held: undefined,
      };
      conns.add(c);
      sink.onDrain(() => {
        c.blockedSinceMs = undefined;
      });
      sink.onClose(() => drop(c));
      // 最初に、今の `lastSeq` を送る（画面は、これで状態を取る。再接続の間の変化も、これで拾う）
      send(c, `retry: 3000\n${sseEvent(seq)}`);
      ensureTimer();
      return true;
    },
    tick,
  };
}
