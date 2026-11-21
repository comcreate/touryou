/**
 * 関係図に渡す値の作り直し（#89。純粋な関数）。表示モデル（形を信じない）から、整えた文字・確かめた ID・数だけを作る。
 */

import { ID_PATTERN } from "../../../core/src/ids.js";
import { UI_HUMAN, uiText } from "../../../core/src/ui-view.js";
import type { Dir } from "./graph-path.js";
import { type GraphTextKey, graphString, type Lang } from "./graph-text.js";

export const STAGES = ["sent", "delivered", "done"] as const;
export type Stage = (typeof STAGES)[number];
/** 役割の名前の鍵（画面の `ROLE_NAMES` と同じ鍵。文字は ui/i18n.ts の表。#140）。 */
const ROLE_NAMES: Readonly<Record<string, GraphTextKey>> = {
  integrator: "role.integrator",
  implement: "role.implement",
  review: "role.review",
  investigate: "role.investigate",
  merge: "role.merge",
};
const BANDS = ["turn", "running", "finished"] as const;
type Band = (typeof BANDS)[number];
/** やり取りの種類（画面の `FLOW_KIND_NAMES` とそろえる）。 */
const KIND_NAMES: Readonly<Record<string, GraphTextKey>> = {
  instruction: "flow.instruction",
  report: "flow.report",
  done: "flow.done",
  decision: "flow.decision",
  extension: "flow.extension",
  answer: "flow.answer",
  approved: "flow.approved",
  rejected: "flow.rejected",
  split: "flow.split",
};

/**
 * 箱の 3 行目の状態（見本 mock.html の `STATE`）。印と、利用者の言葉。
 * `tier` は左の縁の色の段（見本の `TIER`）：go＝進んでいる（藍）・turn＝出番・over＝終わった（薄い灰）。
 * 出番の中でも色を分ける：wait＝答え待ち（柿）・stall＝止まっているかも（くすんだ黄）・fail＝失敗（朱）。
 */
export type NodeStatus = "run" | "wait" | "stall" | "fail" | "done" | "stopped";
export type Tier = "go" | "turn" | "over";
export const STATUS_TEXT: Readonly<Record<NodeStatus, GraphTextKey>> = {
  run: "status.run",
  wait: "status.wait",
  stall: "status.stall",
  fail: "status.fail",
  done: "status.done",
  stopped: "status.stopped",
};
/** 動いている（run）ときの、状態ごとの言葉。画面の `STATE_NAMES` と同じ言葉（試験で照らす）。 */
export const RUN_TEXT: Readonly<Record<string, GraphTextKey>> = {
  pending: "run.pending",
  running: "run.running",
  waiting: "run.waiting",
  done: "run.done",
  stopping: "run.stopping",
  stopIncomplete: "run.stopIncomplete",
};
export const tierOf = (s: NodeStatus): Tier =>
  s === "wait" || s === "stall" || s === "fail"
    ? "turn"
    : s === "done" || s === "stopped"
      ? "over"
      : "go";

export interface GraphNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  /** 役割の名前（統合・作業・レビュー など）。 */
  readonly role: string;
  /** 役割の印：統合は枝分かれ、ほかは金づち。 */
  readonly integrator: boolean;
  readonly status: NodeStatus;
  readonly tier: Tier;
  /** 3 行目の言葉（印つき）。 */
  readonly statusText: string;
  /** 動いている子（右上の点）。 */
  readonly alive: boolean;
  /** 人の操作が要る数（右上の丸い数）。 */
  readonly needsHuman: number;
  /** 最後の動きの時刻（ミリ秒。なければ null）。「何分前」は描くときに出す。 */
  readonly lastAt: number | null;
  readonly depth?: number;
}
export interface GraphLane {
  /** 親のノード ID。 */
  readonly parent: string;
  readonly child: string;
  readonly dir: Dir;
  readonly stage: Stage;
  readonly unknown: boolean;
  /** 「済んだ」を推定で出した。 */
  readonly inferred: boolean;
  /** 出した子が判断を取り下げた（人の回答で済んだのではない）。真のときだけ付く。 */
  readonly withdrawn?: true;
  readonly label: string;
  /** 送った時刻（ミリ秒。なければ null）。 */
  readonly at: number | null;
  /** 人の答えを待っている（子から親への判断・範囲の頼みが、まだ済んでいない）。柿色で描く。 */
  readonly waiting: boolean;
}
export interface GraphModel {
  readonly nodes: readonly GraphNode[];
  readonly lanes: readonly GraphLane[];
  /** 止めた・済んだ子を隠したときの、隠した数（隠していなければ 0）。 */
  readonly hidden: number;
}

export interface GraphModelOptions {
  /** 止めた・済んだ子を隠す（既定は隠さない）。 */
  readonly hideFinished?: boolean;
}

/**
 * 止めた・済んだ子を隠したときに残すノードの ID。
 * 残すのは、止めた・済んだ（`tier` が over）でないノードと、その祖先すべて（動いている子の線が途中で切れないように）。
 * 根（親がない）も残す（全部が終わっても、図が空にならない）。
 */
export function keptIdsOf(nodes: readonly GraphNode[]): ReadonlySet<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kept = new Set<string>();
  for (const n of nodes) {
    if (n.parentId !== null && n.tier === "over") continue;
    // 自分から親をたどって入れる（すでに入れたノードに着いたら、その先も入っているので止める。輪でも止まる）
    let cur: GraphNode | undefined = n;
    while (cur !== undefined && !kept.has(cur.id)) {
      kept.add(cur.id);
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
  }
  return kept;
}

/**
 * 人（ノードでない相手）。図には人の箱を置かない（利用者の決め。見本の形）。人の答え・許可・却下・切り出し（人 → 子）は、
 * 親から子への下りの線の札で表す。根と人のやり取りは線を引かず、根の箱の「あなたの答え」の数だけで表す。
 */
export const HUMAN = UI_HUMAN;

const own = (o: object, k: string): boolean => Object.hasOwn(o, k);
const idOf = (x: unknown): string | null =>
  typeof x === "string" && ID_PATTERN.test(x) ? x : null;
const rec = (x: unknown): Record<string, unknown> | null =>
  typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
const list = (x: unknown, max: number): readonly unknown[] =>
  Array.isArray(x) ? x.slice(0, max) : [];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** 時刻（ISO の形の文字だけ）をミリ秒に。形が違えば null。 */
export const timeOf = (x: unknown): number | null => {
  if (typeof x !== "string" || !ISO.test(x)) return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
};
const count = (x: unknown): number =>
  typeof x === "number" && Number.isInteger(x) && x > 0 ? Math.min(x, 999) : 0;

/** 「何分前」（画面の `agoText` とそろえる）。 */
export function agoText(ms: number, lang: Lang = "ja"): string {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return graphString(lang, "time.now");
  if (m < 60) return graphString(lang, "time.minAgo", { n: m });
  if (m < 1440) return graphString(lang, "time.hourAgo", { n: Math.floor(m / 60) });
  return graphString(lang, "time.dayAgo", { n: Math.floor(m / 1440) });
}

/** 箱の「役割　何分前」（#204。描き直さずに、nowMs から計算し直せるよう、純粋な関数にしてある）。 */
export function roleAgoText(role: string, at: number, now: number, lang: Lang = "ja"): string {
  return graphString(lang, "graph.roleAgo", { role, ago: agoText(now - at, lang) });
}

/** 線の札の「矢印 種類　何分前」（#204。同上）。 */
export function laneAgoText(
  arrow: string,
  label: string,
  at: number,
  now: number,
  lang: Lang = "ja",
): string {
  return graphString(lang, "graph.laneAgo", { arrow, label, ago: agoText(now - at, lang) });
}

/** ノードの、人に関わる項目の有無（表示モデルの受信箱・判断・拡張要求から）。札は、答え待ち・失敗・止まっているかもの順に決める（app.js の `statusesOf` と同じ）。 */
function flagsOf(
  v: Record<string, unknown>,
): Map<string, { wait: boolean; stall: boolean; fail: boolean }> {
  const m = new Map<string, { wait: boolean; stall: boolean; fail: boolean }>();
  const at = (id: string | null) => {
    if (id === null) return null;
    const f = m.get(id) ?? { wait: false, stall: false, fail: false };
    m.set(id, f);
    return f;
  };
  for (const x of list(v.decisions, 100)) {
    const d = rec(x);
    // 閉じた判断（closedReason がある。破棄を決めた子のもの）は、答えを待っていない（画面のカードと同じ決め方）
    if (d === null || d.closedReason !== undefined) continue;
    const f = at(idOf(d.nodeId));
    if (f) f.wait = true;
  }
  for (const x of list(v.extensions, 100)) {
    const f = at(idOf(rec(x)?.nodeId));
    if (f) f.wait = true;
  }
  for (const x of list(v.inbox, 200)) {
    const i = rec(x);
    const f = at(idOf(i?.nodeId));
    if (!f || i === null) continue;
    if (i.stall === true) f.stall = true;
    // 断られた操作（violation）の知らせだけでは失敗にしない（子は続けて動ける。知らせとしては残す）
    else if (i.priority === "failed" && i.kind !== "violation") f.fail = true;
  }
  return m;
}

/** 表示モデル（形を信じない）から、描く値だけを作り直す。 */
export function graphModelOf(
  view: unknown,
  lang: Lang = "ja",
  options: GraphModelOptions = {},
): GraphModel {
  const v = rec(view) ?? {};
  const nodes: GraphNode[] = [];
  const known = new Set<string>();
  const flags = flagsOf(v);
  for (const x of list(v.nodes, 500)) {
    const n = rec(x);
    const id = idOf(n?.id);
    if (n === null || id === null || known.has(id)) continue;
    known.add(id);
    const roleKey = typeof n.role === "string" && own(ROLE_NAMES, n.role) ? n.role : "";
    const band: Band = BANDS.find((b) => b === n.band) ?? "running";
    const state = typeof n.state === "string" && own(RUN_TEXT, n.state) ? n.state : "";
    const f = flags.get(id) ?? { wait: false, stall: false, fail: false };
    const status: NodeStatus =
      band === "finished"
        ? n.state === "stopped"
          ? "stopped"
          : "done"
        : f.wait
          ? "wait"
          : f.fail
            ? "fail"
            : f.stall
              ? "stall"
              : "run";
    const stopIncomplete = state === "stopIncomplete";
    nodes.push({
      id,
      parentId: idOf(n.parentId),
      title: n.title === undefined ? id : uiText(n.title, 80),
      role: graphString(
        lang,
        roleKey === "" ? "role.implement" : (ROLE_NAMES[roleKey] as GraphTextKey),
      ),
      integrator: roleKey === "integrator",
      status: stopIncomplete && status === "run" ? "fail" : status,
      tier: stopIncomplete ? "turn" : tierOf(status),
      statusText: graphString(
        lang,
        status === "run" ? (RUN_TEXT[state] ?? STATUS_TEXT.run) : STATUS_TEXT[status],
      ),
      alive: status === "run" && state === "running",
      needsHuman: count(n.needsHuman),
      lastAt: timeOf(n.lastActivityAt),
    });
  }
  const lanes: GraphLane[] = [];
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
  const taken = new Map<string, number>();
  // flows は新しい順。親子の枝ごと・向きごとに、いちばん新しいものだけ。
  // ただし上り（子 → 親）は、答えを待っている頼み（判断・範囲の頼みで、まだ済んでいないもの）があれば、
  // それを新しい報告より先に出す（利用者の決め：答え待ちを優先。箱が答え待ちなのに、線が報告になるのを避ける）
  for (const x of list(v.flows, 200)) {
    const f = rec(x);
    if (f === null) continue;
    const from = f.from === HUMAN ? HUMAN : idOf(f.from);
    const to = f.to === HUMAN ? HUMAN : idOf(f.to);
    const dir = f.dir === "up" || f.dir === "down" ? f.dir : null;
    const stage = STAGES.find((s) => s === f.stage);
    if (from === null || to === null || dir === null || stage === undefined) continue;
    const [end, child] = dir === "up" ? [to, from] : [from, to];
    if (child === HUMAN || !known.has(child)) continue;
    const up = parentOf.get(child) ?? null;
    // 人 → 子（答え・許可・却下・切り出し）は、その子の親からの下りの線で表す。根（親がない）には線を引かない
    // 子 → 人（根の報告・頼み）も線を引かない（根の箱の「あなたの答え」の数で表す）。ノードどうしは、親子の枝だけ
    if (up === null) continue;
    if (end === HUMAN ? dir === "up" : end !== up) continue;
    const parent = up;
    const key = `${parent} ${child} ${dir}`;
    const asks = f.kind === "decision" || f.kind === "extension";
    const waiting = asks && dir === "up" && stage !== "done";
    const seen = taken.get(key);
    // すでに出した線があれば、それが答え待ちでなく、これが答え待ちのときだけ置き換える
    if (seen !== undefined && (!waiting || (lanes[seen] as GraphLane).waiting)) continue;
    const kind = graphString(
      lang,
      typeof f.kind === "string" && own(KIND_NAMES, f.kind)
        ? (KIND_NAMES[f.kind] as GraphTextKey)
        : "flow.other",
    );
    const lane: GraphLane = {
      parent,
      child,
      dir,
      stage,
      unknown: f.deliveryUnknown === true,
      inferred: f.doneInferred === true,
      ...(f.withdrawn === true ? { withdrawn: true as const } : {}),
      label: kind,
      at: timeOf(f.sentAt),
      waiting,
    };
    if (seen === undefined) {
      taken.set(key, lanes.length);
      lanes.push(lane);
    } else lanes[seen] = lane;
  }
  if (options.hideFinished !== true) return { nodes, lanes, hidden: 0 };
  // 残すノードの親は、いつも残る（祖先を残すため）ので、線は、両端が残るものだけを残せばよい
  const kept = keptIdsOf(nodes);
  return {
    nodes: nodes.filter((n) => kept.has(n.id)),
    lanes: lanes.filter((l) => kept.has(l.parent) && kept.has(l.child)),
    hidden: nodes.length - kept.size,
  };
}

/** やり取りの段の言葉（画面の `stageText` とそろえる）。 */
export function stageText(
  l: Pick<GraphLane, "stage" | "unknown" | "inferred" | "withdrawn">,
  lang: Lang = "ja",
): string {
  if (l.withdrawn === true) return graphString(lang, "stage.withdrawn");
  if (l.stage === "sent") return graphString(lang, l.unknown ? "stage.sentUnknown" : "stage.sent");
  if (l.stage === "delivered") return graphString(lang, "stage.delivered");
  return graphString(lang, l.inferred ? "stage.doneInferred" : "stage.done");
}

/** やり取りの新しさの段（見本の a1〜a4）。5 分・30 分・1 時間で区切る。時刻がなければいちばん古い段。 */
export function ageClassOf(at: number | null, now: number): "a1" | "a2" | "a3" | "a4" {
  if (at === null) return "a4";
  const m = (now - at) / 60000;
  return m <= 5 ? "a1" : m <= 30 ? "a2" : m <= 60 ? "a3" : "a4";
}
