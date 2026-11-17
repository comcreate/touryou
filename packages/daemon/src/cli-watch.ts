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
 * - 判定は純粋な関数（`watchFindings`）。受信箱への記録は、決まった ID（同じものを二度出さない）で行う。
 */

import type { EventBody, OrchState } from "@touryou/core";
import { isStallSummary, stallSummary } from "@touryou/core";
import { appendAtomically, deriveId, type LogPort, summarize } from "./api/handlers/context.js";

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
}

/**
 * 記録から見て、子が紐付けたか（`node.sessionBound` の記録があるか）。報告（`report.added`）は、子でなくても記録される
 * （答えの配送・状態の op・照合など）ので、判定に使わない。紐付けのトークン（kind が bind）は、
 * 呼び出し側（compose）が足す。
 */
export const boundInState = (state: OrchState, nodeId: string): boolean =>
  state.nodes.find((n) => n.id === nodeId)?.sessionId !== undefined;

const ms = (iso: string | undefined): number => (iso === undefined ? 0 : Date.parse(iso) || 0);

export function watchFindings(
  state: OrchState,
  nowMs: number,
  spec: WatchSpec,
  lastHookMs: (nodeId: string) => number | undefined = () => undefined,
  isBound: (nodeId: string) => boolean = (id) => boundInState(state, id),
): WatchFindings {
  const stalled: { nodeId: string; lastMs: number }[] = [];
  const unread: { nodeId: string; seq: number }[] = [];
  const unbound: { nodeId: string }[] = [];
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
    // 判断の答え・範囲の頼みの判定を待っているだけの子は、止まっているのではないので知らせない（#115）
    const awaiting =
      state.decisions.some((d) => d.nodeId === n.id && d.status === "open") ||
      state.extensions.some((x) => x.nodeId === n.id && x.status === "open");
    if (n.state === "running" && !awaiting) {
      const times = [
        ms(launch.report?.at),
        ...state.reports.filter((x) => x.nodeId === n.id).map((x) => ms(x.at)),
        ...state.violations.filter((x) => x.nodeId === n.id).map((x) => ms(x.at)),
        ...state.toolDenials.filter((x) => x.nodeId === n.id).map((x) => ms(x.at)),
        ...state.instructions.filter((x) => x.nodeId === n.id).map((x) => ms(x.deliveredAt)),
        ...state.parentRequests.filter((x) => x.nodeId === n.id).map((x) => ms(x.report?.at)),
        lastHookMs(n.id) ?? 0,
        spec.sinceMs ?? 0,
      ];
      const lastMs = Math.max(...times);
      if (nowMs - lastMs > spec.stallMs) stalled.push({ nodeId: n.id, lastMs });
    }
    if (n.state === "running" || n.state === "waiting") {
      for (const i of state.instructions) {
        if (i.nodeId === n.id && i.deliveredSeq === undefined && nowMs - ms(i.at) > spec.unreadMs)
          unread.push({ nodeId: n.id, seq: i.seq });
      }
    }
  }
  return { stalled, unread, unbound };
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
  const push = (key: string, nodeId: string, text: string, kind: "info" | "failure" = "info") => {
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
          summary: summarize(
            `子 ${nodeId} の見張りの知らせが多すぎる（24 時間に ${cap} 件）ので、しばらく出すのを止めた。子の状態を確かめる`,
          ),
        },
      });
      return;
    }
    c.n += 1;
    known.add(id);
    bodies.push({
      type: "inbox.added",
      payload: { id, kind, nodeId, summary: summarize(text) },
    });
  };
  // 同じ子の「止まっているかも」は、未解決のものを 1 件だけにする（#115。最後の動きが進んでも、古い知らせと並べない）
  const openStall = new Set(
    log
      .state()
      .inbox.filter((i) => i.resolved === undefined && isStallSummary(i.summary))
      .map((i) => i.nodeId),
  );
  for (const s of f.stalled) {
    if (openStall.has(s.nodeId)) continue;
    openStall.add(s.nodeId);
    push(
      `stall/${s.nodeId}/${s.lastMs}`,
      s.nodeId,
      stallSummary(s.nodeId, Math.round(spec.stallMs / 60_000)),
    );
  }
  for (const u of f.unread) {
    push(
      `unread/${u.seq}`,
      u.nodeId,
      `子 ${u.nodeId} が、指示（番号 ${u.seq}）を ${Math.round(spec.unreadMs / 60_000)} 分たっても受け取っていない。子が動いているか確かめる`,
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
      `子 ${u.nodeId} が紐付けていない（起動の報告から ${Math.round((spec.unboundMs ?? 0) / 60_000)} 分）。touryou の plugin が、子の設定の置き場に入っていない見込み。--plugin-dir で開いた親の子には plugin が付かない。plugin を設定の置き場に入れて（/touryou:setup）、子を起動し直す`,
      "failure",
    );
  }
  if (bodies.length === 0) return 0;
  // 1 件ずつ記録する（ほかのものの失敗で、全部を落とさない）
  let n = 0;
  for (const b of bodies) {
    const id = (b as { payload: { id: string } }).payload.id;
    if (appendAtomically(log, clock, `cli-watch-${id}`, { system: true }, [b]).ok) n++;
  }
  return n;
}
