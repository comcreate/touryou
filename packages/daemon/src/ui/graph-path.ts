/**
 * 関係図の線（#89。設計の下書き 7 節）。`d` は数だけで組む（命令 M・L・Q・Z）。
 * 彗星は、線と同じ `d` の path に mask をかけて描く（`cometSpanOf` は、その走る範囲を `d` から読む）。
 */
import { BOX_H, BOX_W, type Layout, type LayoutPos, MARGIN, ROW_H } from "./graph-layout.js";
import { PATH_PATTERN } from "./svg-el.js";

/** 上りと下りの道を、枝の中心から上下にずらす幅。 */
export const LANE_GAP = 6;
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
  /** 線の道（矢印の手前まで）。彗星もこの道を走る。 */
  readonly d: string;
  /** 矢印の三角。 */
  readonly tip: string;
  /** 端子の丸（子の箱の端）の真ん中。 */
  readonly portX?: number;
  readonly portY?: number;
  /** 札（種類と「何分前」）の左下。段の言葉は、その外側（上りは上・下りは下）に `stageY` で置く。 */
  readonly labelX: number;
  readonly labelY: number;
  readonly stageY: number;
}

/** 親の箱の右の辺から、幹（縦の線）までの長さ。 */
export const TRUNK = 26;

/** 親 P の幹の x。子の枝は、すべてこの幹から分かれる（見本の `tx`）。 */
export const trunkXOf = (P: LayoutPos): number => P.x + BOX_W + TRUNK;

/**
 * 親の幹：親の箱の右の辺から短く出て、子の高さまで縦にのびる 2 本（見本の `trunk`）。
 * 子の上りの道は、子ごとの高さで幹に着くので、矢印の先が重ならない。
 */
export function trunkOf(P: LayoutPos, kids: readonly LayoutPos[]): readonly string[] {
  const tx = trunkXOf(P);
  const ys = kids.map((k) => k.cy).concat([P.cy]);
  return [
    pathD([
      ["M", P.x + BOX_W, P.cy],
      ["L", tx, P.cy],
    ]),
    pathD([
      ["M", tx, Math.min(...ys) - LANE_GAP],
      ["L", tx, Math.max(...ys) + LANE_GAP],
    ]),
  ];
}

/**
 * 子 C の枝の、上り（子 → 親）か下り（親 → 子）の道（見本の `drawGraph` の `line`）。
 * 上りは子の箱の左から幹へ（矢印の先は幹。左向き）、下りは幹から子の箱の左へ（矢印の先は子の箱。右向き）。
 * 上りは枝の上、下りは枝の下を通る。
 */
export function laneOf(P: LayoutPos, C: LayoutPos, dir: Dir): Lane {
  const tx = trunkXOf(P);
  const up = dir === "up";
  const y = C.cy + (up ? -LANE_GAP : LANE_GAP);
  return {
    d: up
      ? pathD([
          ["M", C.x, y],
          ["L", tx + ARROW, y],
        ])
      : pathD([
          ["M", tx, y],
          ["L", C.x - ARROW, y],
        ]),
    tip: up ? tipAt(tx, y, "left") : tipAt(C.x, y, "right"),
    portX: C.x,
    portY: y,
    labelX: tx + 18,
    labelY: up ? y - 6 : y + 15,
    stageY: up ? y - 20 : y + 29,
  };
}

/** 薄い点線の枝（やり取りのまだない子）。幹から子の箱の左まで。 */
export function twigOf(P: LayoutPos, C: LayoutPos): string {
  return pathD([
    ["M", trunkXOf(P), C.cy],
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

/** 彗星の尾の長さ（x 方向）。 */
export const COMET_TAIL = 140;

/**
 * 彗星が走る道の、始点と終点の x。`d` の最初と最後の点（命令 M・L・Q・C の引数は、すべて x y の組）。
 * 終点が始点より左なら、彗星は左へ走る。曲線は端の点だけを見る（尾は、線と同じ `d` の mask で切るので、線から外れない）。
 */
export function cometSpanOf(d: string): { readonly from: number; readonly to: number } {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!PATH_PATTERN.test(d) || /A/.test(d) || nums.length < 2 || nums.length % 2 !== 0)
    throw new Error("path: comet");
  return { from: nums[0] as number, to: nums[nums.length - 2] as number };
}
