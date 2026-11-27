/**
 * 関係図の線（#89。設計の下書き 7 節）。`d` は数だけで組む（命令 M・L・Q・Z）。
 * 流星は、線と同じ `d` の path を重ね、破線の位置を CSS で動かして描く（`meteorEndOf` は、火花が当たる点を `d` から読む）。
 */
import { BOX_H, BOX_W, type Layout, type LayoutPos, MARGIN, ROW_H } from "./graph-layout.js";
import { PATH_PATTERN } from "./svg-el.js";

/** 上りと下りの道を、枝の中心から上下にずらす幅。 */
export const LANE_GAP = 10;
export const ARROW = 8;

const num = (v: number): string => {
  if (!Number.isFinite(v)) throw new Error("path: not a number");
  return String(Math.round(v * 10) / 10);
};

/** 命令と数の列から `d` を組む。 */
export function pathD(cmds: readonly (readonly [string, ...number[]])[]): string {
  const out: string[] = [];
  for (const [c, ...xs] of cmds) {
    if (!/^[MLQZ]$/.test(c)) throw new Error("path: command");
    out.push([c, ...xs.map(num)].join(" "));
  }
  const d = out.join(" ");
  if (!PATH_PATTERN.test(d)) throw new Error("path: shape");
  return d;
}

export type Dir = "up" | "down";

export interface Lane {
  /** 線の道（矢印の手前まで）。流星もこの道を走る。 */
  readonly d: string;
  /** 矢印の三角。 */
  readonly tip: string;
  /** 端子（親の端子の帯の上の、この線の枠）の真ん中。 */
  readonly portX?: number;
  readonly portY?: number;
  /** 札（種類と「何分前」）の文字の右の端と基線。段の言葉は、その外側（上りは上・下りは下）に `stageY` で置く。 */
  readonly labelX: number;
  readonly labelY: number;
  readonly stageY: number;
}

/**
 * 親の右の辺の「端子の帯」（見本の `bar`）と、そこから出る線の寸法（docs/ui-mock/index.html と同じ）。
 * 線は 1 本ごとに「枠」（slot）を 1 つ持ち、親の中心を真ん中に、SLOT_GAP ずつ縦に並ぶ。
 * 線は端子の帯の右から出て、枠ごとの高さで折れ（JOG）、子の高さの線になって子の箱へ着く。
 */
export const BAR_OFFSET = 19;
export const BAR_W = 6;
export const LANE_OFFSET = 31;
/** 上りと下りの線の間隔（LANE_GAP の 2 倍）にそろえる。ずれると、同じ高さの子で線に小さな段差が出る。 */
export const SLOT_GAP = LANE_GAP * 2;
const JOG_BASE = 26;
const JOG_STEP = 10;
const JOG_EXTRA_MAX = 40;

/** 親の線の枠（何番目か・全部で何個か）。親の下の子の並びの順（子の高さの順。上りが下りの前）に 0 から振る。 */
export interface Slot {
  readonly index: number;
  readonly count: number;
}

const barXOf = (P: LayoutPos): number => P.x + BOX_W + BAR_OFFSET;
/** 線が端子の帯から出る x（帯の右）。 */
export const laneXOf = (P: LayoutPos): number => P.x + BOX_W + LANE_OFFSET;
const slotYOf = (P: LayoutPos, s: Slot): number => P.cy + (s.index - (s.count - 1) / 2) * SLOT_GAP;
/** 縦に折れる x。両端の枠ほど手前、真ん中の枠ほど奥にして、線が交わらないようにする（見本の 185・195・205・215）。 */
function jogXOf(P: LayoutPos, s: Slot): number {
  const depth = Math.min(s.index, s.count - 1 - s.index);
  const step = Math.min(JOG_STEP, JOG_EXTRA_MAX / Math.max(1, Math.floor((s.count - 1) / 2)));
  return laneXOf(P) + JOG_BASE + depth * step;
}

/**
 * 親の端子の帯：親の箱の右の辺から短く出る線（stub）と、枠の全部にのびる縦の帯（bar。太い線で描く）。
 */
export function trunkOf(P: LayoutPos, count: number): readonly string[] {
  const bx = barXOf(P) + BAR_W / 2;
  const top = slotYOf(P, { index: 0, count }) - 16;
  const bottom = slotYOf(P, { index: count - 1, count }) + 16;
  return [
    pathD([
      ["M", P.x + BOX_W, P.cy],
      ["L", barXOf(P), P.cy],
    ]),
    pathD([
      ["M", bx, top],
      ["L", bx, bottom],
    ]),
  ];
}

/**
 * 子 C の枝の、上り（子 → 親）か下り（親 → 子）の道（見本の `drawGraph` の `line`）。
 * 上りは子の箱の左から、折れて、端子の帯の右へ（矢印の先は帯の側。左向き）。下りは帯の右から、折れて、子の箱の左へ（矢印の先は子の箱。右向き）。
 * 子の高さの線は、上りが枝の上、下りが枝の下を通る。端子（port）は、帯の上の、この線の枠の位置。
 */
export function laneOf(P: LayoutPos, C: LayoutPos, dir: Dir, slot: Slot): Lane {
  const sx = laneXOf(P);
  const jx = jogXOf(P, slot);
  const py = slotYOf(P, slot);
  const up = dir === "up";
  const y = C.cy + (up ? -LANE_GAP : LANE_GAP);
  const apex = sx + 2;
  return {
    d: up
      ? pathD([
          ["M", C.x, y],
          ["L", jx, y],
          ["L", jx, py],
          ["L", apex + ARROW, py],
        ])
      : pathD([
          ["M", sx, py],
          ["L", jx, py],
          ["L", jx, y],
          ["L", C.x - ARROW, y],
        ]),
    tip: up ? tipAt(apex, py, "left") : tipAt(C.x, y, "right"),
    portX: barXOf(P) + BAR_W / 2,
    portY: py,
    // 札は線の上下の真ん中（高さ 18）に置き、右の端を子の箱の手前 32 にそろえる（見本のとおり）。
    // 段の言葉は、札の外側（上りは上・下りは下）に、札の右の端にそろえて置く
    labelX: C.x - 32 - 6,
    labelY: y + 4.5,
    stageY: up ? y - 13 : y + 22,
  };
}

/** 薄い点線の枝（やり取りのまだない子）。端子の帯の右から、折れて、子の箱の左まで。 */
export function twigOf(P: LayoutPos, C: LayoutPos, slot: Slot): string {
  const jx = jogXOf(P, slot);
  const py = slotYOf(P, slot);
  return pathD([
    ["M", laneXOf(P), py],
    ["L", jx, py],
    ["L", jx, C.cy],
    ["L", C.x, C.cy],
  ]);
}

/**
 * 矢印（見本の `.tip`：塗らない開いた山形）。先が (x, y) で、`to` の向き（左・右）を指す。
 * 先から 2 本の線を引く（先を丸い端で結ぶので、角は 1 点に見える）。
 */
function tipAt(x: number, y: number, to: "left" | "right"): string {
  const b = ARROW;
  const bx = to === "left" ? x + b : x - b;
  return pathD([
    ["M", x, y],
    ["L", bx, y - 5],
    ["M", x, y],
    ["L", bx, y + 5],
  ]);
}

/** 役割の印（12×12 の中。見本の `role-ic`）：統合は枝分かれ、ほかは金づち。 */
export function roleIconOf(integrator: boolean): string {
  return integrator
    ? pathD([
        ["M", 1, 6],
        ["L", 5, 6],
        ["M", 5, 1],
        ["L", 5, 11],
        ["M", 5, 1],
        ["L", 10, 1],
        ["M", 5, 11],
        ["L", 10, 11],
      ])
    : pathD([
        ["M", 2, 11],
        ["L", 7, 5],
        ["M", 4, 3],
        ["L", 7, 1],
        ["L", 11, 5],
        ["L", 9, 7],
        ["Z"],
      ]);
}

/**
 * 流星が着く点（道 `d` の最後の点。命令 M・L・Q の引数は、すべて x y の組）。上りの火花は、ここへ当てる。
 */
export function meteorEndOf(d: string): { readonly x: number; readonly y: number } {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!PATH_PATTERN.test(d) || /[AC]/.test(d) || nums.length < 2 || nums.length % 2 !== 0)
    throw new Error("path: meteor");
  return { x: nums[nums.length - 2] as number, y: nums[nums.length - 1] as number };
}

/**
 * 上りの火花（当たった点 0 0 から、流星の来た向き＝右側へ跳ね返る光の筋）。`[d, 寿命の種類]`。
 * 寿命は `sk`（0.6 秒）・`sk2`（0.45 秒）・`sk3`（0.3 秒）。真後ろに近いほど本数が多く、道が長い（docs/ui-mock/index.html の「まとめ」と同じ形）。
 */
export const SPARK_FLASH = "M-4 0A4 4 0 1 0 4 0A4 4 0 1 0 -4 0Z";
export const SPARK_STREAKS: readonly (readonly [string, "sk" | "sk sk2" | "sk sk3"])[] = [
  ["M0 0L6.7 -16.7", "sk"],
  ["M0 0L11.8 -16.2", "sk"],
  ["M0 0L15.6 -14.1", "sk sk2"],
  ["M0 0L20.4 -12.7", "sk"],
  ["M0 0L25.8 -10.9", "sk sk2"],
  ["M0 0L30.9 -8.3", "sk sk3"],
  ["M0 0L35.6 -5", "sk sk2"],
  ["M0 0L39.9 -2.1", "sk sk3"],
  ["M0 0L38 1.3", "sk sk2"],
  ["M0 0L33.8 4.1", "sk sk3"],
  ["M0 0L29.2 6.7", "sk sk2"],
  ["M0 0L25.4 9.2", "sk"],
  ["M0 0L20.3 10.8", "sk sk2"],
  ["M0 0L15.8 12.3", "sk"],
  ["M0 0L12.2 14.6", "sk sk2"],
  ["M0 0L7.9 16.2", "sk"],
];

/**
 * 下りの火花（弱い流星が着く子の箱の縁から、来た向き＝左側へ跳ね返る）。上りより弱く、筋 10 本・道を 7 割ほど・閃光を小さく
 * （docs/ui-mock/index.html の案 A の下りと同じ形。`scale(-1 1)` を使わず、左向きの座標で書く）。
 */
export const SPARK_FLASH_WEAK = "M-3 0A3 3 0 1 0 3 0A3 3 0 1 0 -3 0Z";
export const SPARK_STREAKS_WEAK: readonly (readonly [string, "sk" | "sk sk2" | "sk sk3"])[] = [
  ["M0 0L-8.8 -12.1", "sk"],
  ["M0 0L-14.4 -9", "sk"],
  ["M0 0L-21.3 -5.7", "sk sk3"],
  ["M0 0L-24.8 -3.5", "sk sk2"],
  ["M0 0L-28 -1.5", "sk sk3"],
  ["M0 0L-27 0.9", "sk sk2"],
  ["M0 0L-23.8 2.9", "sk sk3"],
  ["M0 0L-20.5 4.7", "sk sk2"],
  ["M0 0L-14.1 7.5", "sk sk2"],
  ["M0 0L-9.6 11.5", "sk sk2"],
];
