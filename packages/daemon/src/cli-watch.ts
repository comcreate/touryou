/**
 * CLI の子の見張り（設計 6.2 の「止まったことの検出」2、FR_009 の「読まれないまま所定の時間を超えたら」）。
 *
 * - daemon は子を呼ばない。記録の時刻（と、フックが来た時刻）だけで決める。
 * - 止まっているかもしれない子: 親が起動を報告した、動いている（running）CLI の子で、最後の動き（起動の報告・報告・判断の要求・
 *   範囲違反・道具の拒否・指示の受け取り・フックの呼び出し）から `stallMs` を超えたもの。同じ「最後の動き」には 1 回だけ出す。
 *   判断の答え・範囲の頼みの判定を待っている子には出さない。同じ子の未解決の知らせがあれば、新しく出さない（#115）。
 *   判断待ち（waiting）は、人の答えを待っているので出さない。
 * - 読まれていない指示: 子が `child.inbox` で受け取らないまま、記録から `unreadMs` を超えた指示。指示ごとに 1 回だけ出す。
 * - 紐付けていない子: 親が起動を報告した（done）CLI の子で、その報告から `unboundMs` を超えても紐付け（`child_bind`）が
 *   ないもの。子ごとに 1 回だけ出す。親の起動の報告がない子・報告が failed の子は出さない。`--plugin-dir` で開いた親の子には
 *   touryou の plugin が付かず、子は `child_bind` を見つけられない。紐付けのない子には、いまの決まりのとおり
 *   作業の op を許可しない（ここでは知らせるだけ）。
 * - 紐付けが外れているかも: 有効な紐付けのトークンを持つ、running・waiting の CLI の子で、知らせを受け取る接続（購読）がない状態が
 *   `unsubscribedMs` を超えて続いているもの。claude attach・/mcp の再接続・mcp の再起動で、子の mcp が認証を失っても、401 は出ず、
 *   daemon 側のトークンは有効なまま、通知の購読だけが止まる。使われない子は child_bind も呼ばないので、検出は daemon が行う。
 *   購読がない時間は、呼び出し側（compose）が観測して渡す（`BindLostProbe`。daemon の起動から数えるので、起動の直後の猶予にもなる）。
 *   同じ途切れには 1 回だけ（鍵は途切れの始まりの時刻）。購読が戻る・トークンが切れる・子が動いていないなら、解決にする。
 *   トークンがない・切れている子には出さない（切れた知らせ〔#189〕・「紐付けをやり直して」が別にある）。検出は読み取りだけ。
 * - 判定は純粋な関数（`watchFindings`）。受信箱への記録は、決まった ID（同じものを二度出さない）で行う。
 */

import type { EventBody, OrchState } from "@touryou/core";

import {
  intentionallyIdle,
  isPrefaceInstruction,
  isStallSummary,
  lastActivityMs,
} from "@touryou/core";

import { appendAtomically, deriveId, type LogPort, notice } from "./api/handlers/context.js";

export interface WatchSpec {
  readonly stallMs: number;
  readonly unreadMs: number;
  /** 起動の報告（done）から、紐付けがないと知らせるまでの時間。未指定なら知らせない。 */
  readonly unboundMs?: number;
  /**
   * daemon が起動した時刻（ミリ秒）。「最後の動き」の下限にする（フックの時刻はメモリだけなので、再起動の直後に、動いている子を
   * 止まっているかもしれないと出さないため）。
   */
  readonly sinceMs?: number;
  /** ノードごとの、1 日（24 時間）に出す知らせの上限。既定 20。超えたら 1 回だけ「多すぎるので止めた」を出す。 */
  readonly perNodePerDay?: number;
  /**
   * 知らせを受け取る接続（購読）がないまま、これだけ続いたら「紐付けが外れているかも」と知らせる時間。未指定なら知らせない。
   * 起動の直後の猶予は、呼び出し側（compose）が、観測の始まりを daemon の起動から数えることで持つ。
   */
  readonly unsubscribedMs?: number;
}

/**
 * 紐付けが外れている疑いの観測（compose が持つ。メモリだけ）。
 * `absentSinceMs`: そのノードの購読がない状態を、続けて見始めた時刻。購読がある・見ていない（対象外）なら undefined。
 */
export interface BindLostProbe {
  readonly absentSinceMs: (nodeId: string) => number | undefined;
  /** 有効な紐付けのトークン（kind が bind）を持つか。切れている・ないなら false（切れた知らせは別にある）。 */
  readonly hasValidBindToken: (nodeId: string) => boolean;
}

/** 見張りの知らせの数（ノードごと。メモリだけ）。 */
export type WatchCounts = Map<string, { dayStartMs: number; n: number; capped: boolean }>;

export interface WatchFindings {
  /** 止まっているかもしれない子と、最後の動きの時刻（ミリ秒）。 */
  readonly stalled: readonly { readonly nodeId: string; readonly lastMs: number }[];
  /** 読まれていない指示。 */
  readonly unread: readonly { readonly nodeId: string; readonly seq: number }[];
  /** 起動の報告から所定の時間を超えても紐付けていない子。 */
  readonly unbound?: readonly { readonly nodeId: string }[];
  /**
   * 紐付けが外れているかもしれない子と、購読がない状態を見始めた時刻（ミリ秒。知らせの鍵に使う）。
   * 紐付け済みで、トークンが有効なのに、購読がない状態が `unsubscribedMs` を超えて続いている running・waiting の CLI の子。
   */
  readonly unsubscribed?: readonly { readonly nodeId: string; readonly sinceMs: number }[];
  /** 解決済みにする「紐付けが外れているかも」の知らせの ID。購読が戻った・トークンが切れた・子が動いていない、など。 */
  readonly resolvedUnsubscribed?: readonly string[];
  /**
   * 解決済みにする「止まっているかも」の知らせの ID（#136）。子が動いていない（終わった・止めた・回収した・判断待ち）か、
   * 知らせのあとに子の動きがあったもの。
   */
  readonly resolvedStalls?: readonly string[];
}

/**
 * 子の最後の動きの時刻（ミリ秒）。数え方は core の `lastActivityMs`（画面と同じ。#195）に、フックの呼び出しの時刻（メモリだけ）を足す。
 * daemon の起動の時刻は含めない（呼び出し側で足す）。
 */
const activityMs = (
  state: OrchState,
  nodeId: string,
  lastHookMs: (nodeId: string) => number | undefined,
): number => lastActivityMs(state, nodeId, lastHookMs(nodeId) ?? 0);

/**
 * 記録から見て、子が紐付けたか（`node.sessionBound` の記録があるか）。報告（`report.added`）は、子でなくても記録される
 * （答えの配送・状態の op・照合など）ので、判定に使わない。紐付けのトークン（kind が bind）は、
 * 呼び出し側（compose）が足す。
 */
export const boundInState = (state: OrchState, nodeId: string): boolean =>
  state.nodes.find((n) => n.id === nodeId)?.sessionId !== undefined;

const ms = (iso: string | undefined): number => (iso === undefined ? 0 : Date.parse(iso) || 0);

/** 知らせを受け取る接続が要る状態（動いている・待っている）。 */
const isLive = (state: string): boolean => state === "running" || state === "waiting";

/** 「紐付けが外れているかも」の知らせの鍵（core の `INBOX_MESSAGES`）。 */
export const BIND_LOST_KEY = "bindLostSuspect";

export function watchFindings(
  state: OrchState,
  nowMs: number,
  spec: WatchSpec,
  lastHookMs: (nodeId: string) => number | undefined = () => undefined,
  isBound: (nodeId: string) => boolean = (id) => boundInState(state, id),
  probe?: BindLostProbe,
): WatchFindings {
  const stalled: { nodeId: string; lastMs: number }[] = [];
  const unread: { nodeId: string; seq: number }[] = [];
  const unbound: { nodeId: string }[] = [];
  const unsubscribed: { nodeId: string; sinceMs: number }[] = [];
  for (const n of state.nodes) {
    const launch = [...state.parentRequests]
      .reverse()
      .find((r) => r.nodeId === n.id && r.kind === "launch" && r.report?.outcome === "done");
    if (launch === undefined) continue; // CLI の子で、親が起動を報告したものだけ（failed・未報告は対象外）
    if (
      spec.unboundMs !== undefined &&
      (n.state === "running" || n.state === "waiting") &&
      // 再起動の前に起動の報告があった子は出さない（紐付けのトークンはメモリだけなので、紐付けたかが分からない。
      // そのような子は「紐付けをやり直して」〔compose の noticeRebind〕に任せる）
      ms(launch.report?.at) > (spec.sinceMs ?? 0) &&
      nowMs - ms(launch.report?.at) > spec.unboundMs &&
      !isBound(n.id)
    )
      unbound.push({ nodeId: n.id });
    // 紐付けが外れているかも: 有効な紐付けのトークンがあるのに、購読がない状態が `unsubscribedMs` を超えて続いている子。
    // トークンがない・切れている子は、切れた知らせ（#189）・「紐付けをやり直して」に任せる。読み取りだけで、権限・紐付けの条件は変えない
    if (spec.unsubscribedMs !== undefined && probe !== undefined && isLive(n.state)) {
      const since = probe.absentSinceMs(n.id);
      if (
        since !== undefined &&
        nowMs - since > spec.unsubscribedMs &&
        probe.hasValidBindToken(n.id)
      )
        unsubscribed.push({ nodeId: n.id, sinceMs: since });
    }
    // 待つことが決まっている子（waiting・判断の答えや範囲の頼みの判定を待っている子）は、止まっているのではないので知らせない（#115・#195）
    if (!intentionallyIdle(state, n.id)) {
      const lastMs = Math.max(activityMs(state, n.id, lastHookMs), spec.sinceMs ?? 0);
      if (nowMs - lastMs > spec.stallMs) stalled.push({ nodeId: n.id, lastMs });
    }
    if (n.state === "running" || n.state === "waiting") {
      for (const i of state.instructions) {
        // daemon の前置き（`tokenIdleSoon`。#189）は、子が読まなくても構わない知らせなので、読まれていない指示にしない
        if (
          i.nodeId === n.id &&
          !isPrefaceInstruction(i) &&
          i.deliveredSeq === undefined &&
          nowMs - ms(i.at) > spec.unreadMs
        )
          unread.push({ nodeId: n.id, seq: i.seq });
      }
    }
  }
  // 「止まっているかも」の知らせの片付け（#136）: 子が動いていない（running でない）か、知らせのあとに子の動きがあれば解決済みにする
  const resolvedStalls = state.inbox
    .filter((i) => i.resolved === undefined && i.kind === "info" && isStallSummary(i.summary))
    // 動いていない・待つことが決まっている子、または知らせのあとに子の動き（送った指示を含む。#195）があれば、片付ける
    .filter(
      (i) =>
        intentionallyIdle(state, i.nodeId) || activityMs(state, i.nodeId, lastHookMs) > ms(i.at),
    )
    .map((i) => i.id);
  // 「紐付けが外れているかも」の片付け: 購読が戻った（観測がなくなった）・トークンが切れた・子が動いていない（止めた・回収した・
  // 受理した など）なら、解決済みにする。結び直し（child_bind の成功）での解決は、daemon の紐付けの経路が行う
  const resolvedUnsubscribed =
    probe === undefined
      ? []
      : state.inbox
          .filter((i) => i.resolved === undefined && i.msg?.key === BIND_LOST_KEY)
          .filter((i) => {
            const node = state.nodes.find((x) => x.id === i.nodeId);
            return (
              node === undefined ||
              !isLive(node.state) ||
              probe.absentSinceMs(i.nodeId) === undefined ||
              !probe.hasValidBindToken(i.nodeId)
            );
          })
          .map((i) => i.id);
  return { stalled, unread, unbound, unsubscribed, resolvedUnsubscribed, resolvedStalls };
}

/** 見つけたものを受信箱に出す（決まった ID なので、同じものは二度出ない）。出した件数を返す。 */
export function recordWatchFindings(
  log: LogPort,
  clock: () => string,
  f: WatchFindings,
  spec: WatchSpec,
  counts: WatchCounts = new Map(),
  nowMs: number = Date.parse(clock()),
  onSkip?: (nodeId: string) => void,
): number {
  const bodies: EventBody[] = [];
  const known = new Set(log.state().inbox.map((i) => i.id));
  const cap = spec.perNodePerDay ?? 20;
  const push = (
    key: string,
    nodeId: string,
    text: ReturnType<typeof notice>,
    kind: "info" | "failure" = "info",
  ) => {
    const id = deriveId("inbox", "system", key, "cli-watch");
    if (known.has(id)) return;
    let c = counts.get(nodeId);
    if (c === undefined || nowMs - c.dayStartMs >= 24 * 60 * 60_000) {
      c = { dayStartMs: nowMs, n: 0, capped: false };
      counts.set(nodeId, c);
    }
    if (c.n >= cap) {
      if (c.capped) return;
      c.capped = true;
      const capId = deriveId("inbox", "system", `cap/${nodeId}/${c.dayStartMs}`, "cli-watch");
      known.add(capId);
      bodies.push({
        type: "inbox.added",
        payload: {
          id: capId,
          kind: "info",
          nodeId,
          ...notice("watchCapped", { node: nodeId, cap }),
        },
      });
      return;
    }
    c.n += 1;
    known.add(id);
    bodies.push({
      type: "inbox.added",
      payload: { id, kind, nodeId, ...text },
    });
  };
  // 同じ子の「止まっているかも」は、未解決のものを 1 件だけにする（#115。最後の動きが進んでも、古い知らせと並べない）
  const resolving = new Set([...(f.resolvedStalls ?? []), ...(f.resolvedUnsubscribed ?? [])]);
  for (const itemId of resolving) bodies.push({ type: "inbox.resolved", payload: { itemId } });
  const openStall = new Set(
    log
      .state()
      .inbox.filter(
        (i) => i.resolved === undefined && isStallSummary(i.summary) && !resolving.has(i.id),
      )
      .map((i) => i.nodeId),
  );
  for (const s of f.stalled) {
    if (openStall.has(s.nodeId)) continue;
    openStall.add(s.nodeId);
    // 鍵は最後の動きの時刻ごと。片付けたあと、新しい動きがないまま running に戻ってまた止まると、同じ鍵になり出さない
    // （めったにない形。子が動けば最後の動きが進み、鍵が変わる。#136）
    push(
      `stall/${s.nodeId}/${s.lastMs}`,
      s.nodeId,
      notice("stall", { node: s.nodeId, minutes: Math.round(spec.stallMs / 60_000) }),
    );
  }
  for (const u of f.unread) {
    push(
      `unread/${u.seq}`,
      u.nodeId,
      notice("unreadInstruction", {
        node: u.nodeId,
        seq: u.seq,
        minutes: Math.round(spec.unreadMs / 60_000),
      }),
    );
  }
  for (const u of f.unbound ?? []) {
    // 項目の nodeId は子の ID（知らせの宛先決めで、子の親のセッションの購読に流れる）。親のない子は出さずにログに残す
    if (log.state().nodes.find((n) => n.id === u.nodeId)?.parentId == null) {
      onSkip?.(u.nodeId);
      continue;
    }
    push(
      `unbound/${u.nodeId}`,
      u.nodeId,
      notice("unbound", { node: u.nodeId, minutes: Math.round((spec.unboundMs ?? 0) / 60_000) }),
      "failure",
    );
  }
  // 紐付けが外れているかも: 同じ子の未解決の知らせがあれば、新しく出さない。鍵は「購読がない状態を見始めた時刻」ごと
  // （同じ途切れには 1 回だけ。購読が戻って、また途切れれば、別の鍵になる）。1 日の上限は `push` が数える
  const openLost = new Set(
    log
      .state()
      .inbox.filter(
        (i) => i.resolved === undefined && i.msg?.key === BIND_LOST_KEY && !resolving.has(i.id),
      )
      .map((i) => i.nodeId),
  );
  for (const u of f.unsubscribed ?? []) {
    if (openLost.has(u.nodeId)) continue;
    // 項目の nodeId は子の ID（知らせの宛先決めで、子の親のセッションの購読に流れる）。親のない子は出さずにログに残す
    if (log.state().nodes.find((n) => n.id === u.nodeId)?.parentId == null) {
      onSkip?.(u.nodeId);
      continue;
    }
    openLost.add(u.nodeId);
    push(
      `unsubscribed/${u.nodeId}/${u.sinceMs}`,
      u.nodeId,
      notice(BIND_LOST_KEY, {
        node: u.nodeId,
        minutes: Math.round((spec.unsubscribedMs ?? 0) / 60_000),
      }),
      "failure",
    );
  }
  if (bodies.length === 0) return 0;
  // 1 件ずつ記録する（ほかのものの失敗で、全部を落とさない）
  let n = 0;
  for (const b of bodies) {
    if (b.type === "inbox.resolved") {
      // 片付け（#136）は、出した件数に数えない
      appendAtomically(log, clock, `cli-watch-resolve-${b.payload.itemId}`, { system: true }, [b]);
      continue;
    }
    const id = (b as { payload: { id: string } }).payload.id;
    if (appendAtomically(log, clock, `cli-watch-${id}`, { system: true }, [b]).ok) n++;
  }
  return n;
}
