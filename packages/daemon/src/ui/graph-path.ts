/**
 * 関係図の線（#89。設計の下書き 7 節）。`d` は数だけで組む（命令 M・L・Q・Z）。
 * 動く玉の `offset-path` を設定するのも、この 1 か所（`setRunnerPath`）だけ。
 */
import { BOX_H, BOX_W, type Layout, type LayoutPos, MARGIN, ROW_H } from "./graph-layout.js";
import { PATH_PATTERN } from "./svg-el.js";

/** 上りと下りの道を、枝の中心から上下にずらす幅。 */
export const LANE_GAP = 6;
export const ARROW = 8;
const RADIUS = 8;

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
  /** 線の道（矢印の手前まで）。玉もこの道を走る。 */
  readonly d: string;
  /** 矢印の三角。 */
  readonly tip: string;
  /** 端子の丸（子の箱の端。人の道にはない）の真ん中。 */
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

/** 点の並び（縦と横の線だけ）を、角を丸めた折れ線の `d` にする。 */
export function roundedPath(pts: readonly (readonly [number, number])[], radius = RADIUS): string {
  if (pts.length < 2) throw new Error("path: points");
  const first = pts[0] as readonly [number, number];
  const cmds: [string, ...number[]][] = [["M", first[0], first[1]]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1] as readonly [number, number];
    const [x, y] = pts[i] as readonly [number, number];
    const [nx, ny] = pts[i + 1] as readonly [number, number];
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(nx - x, ny - y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      cmds.push(["L", x, y]);
      continue;
    }
    cmds.push(["L", x - ((x - px) / inLen) * r, y - ((y - py) / inLen) * r]);
    cmds.push(["Q", x, y, x + ((nx - x) / outLen) * r, y + ((ny - y) / outLen) * r]);
  }
  const last = pts[pts.length - 1] as readonly [number, number];
  cmds.push(["L", last[0], last[1]]);
  return pathD(cmds);
}

/** 箱の上の辺より上で、いちばん近い行の間（葉の行と行のあいだの、箱のない帯）の真ん中の y。 */
export function gapRowAbove(top: number): number {
  const half = (ROW_H - BOX_H) / 2;
  const k = Math.floor((top - MARGIN + half - 4) / ROW_H);
  return MARGIN - half + k * ROW_H;
}

/** 矢印の三角。先が (x, y) で、`to` の向き（左・右・下）を指す。 */
function tipAt(x: number, y: number, to: "left" | "right" | "down"): string {
  const b = ARROW + 2;
  if (to === "left") return pathD([["M", x, y], ["L", x + b, y - 5], ["L", x + b, y + 5], ["Z"]]);
  return to === "right"
    ? pathD([["M", x, y], ["L", x - b, y - 5], ["L", x - b, y + 5], ["Z"]])
    : pathD([["M", x, y], ["L", x - 5, y - b], ["L", x + 5, y - b], ["Z"]]);
}

/** 通り道の、ノード 1 つ分の幅（上りと下りの 2 本）。 */
export const CORRIDOR_STEP = 16;

/**
 * 「人」の箱と通り道の場所。通り道は、木のどの箱よりも右（`L.width - MARGIN` より右）にとり、その右に人の箱を置く。
 * `talkers` は、人とやり取りするノードの数（ノードごとに通り道をずらす）。
 */
export function humanColumnOf(
  L: Layout,
  talkers: number,
): { human: LayoutPos; corridorX: (slot: number) => number; width: number; height: number } {
  const corridor = L.width - MARGIN + 24;
  const hx = corridor + talkers * CORRIDOR_STEP + 32;
  return {
    human: { x: hx, y: MARGIN, cy: MARGIN + BOX_H / 2, depth: -1 },
    corridorX: (slot) => corridor + slot * CORRIDOR_STEP,
    width: hx + BOX_W + MARGIN,
    height: Math.max(L.height, MARGIN * 2 + BOX_H),
  };
}

/**
 * 人とのやり取りの道（段を飛ばす。research.md 6.1 の (b)）。木の右の縦の通り道を通る。
 * ノードの箱の上の辺から出て、行の間（箱のない所。`gapRowAbove`）を右へ、通り道を縦に、人の箱の左の辺へ。
 * `corridorX` は、そのノードの通り道の x（ノードごとにずらし、重ねない）。上りは人の箱を、下りはノードの箱を指す。
 * 札は、行の間の帯に 1 行で置く（帯は狭いので、段の言葉も同じ行に続ける。`stageY` は `labelY` と同じ）。
 */
export function humanLaneOf(
  N: LayoutPos,
  H: LayoutPos,
  corridorX: number,
  dir: Dir,
  slot = 0,
  slots = 1,
): Lane {
  const up = dir === "up";
  const sx = N.x + BOX_W - (up ? 24 : 40);
  const gapY = gapRowAbove(N.y) + (up ? -4 : 4);
  const cx = corridorX + (up ? 0 : LANE_GAP);
  // 人の箱の左の辺に着く高さは、道ごとに分ける（矢印の先を重ねない）
  const hy = humanEndY(H, slot * 2 + (up ? 0 : 1), slots * 2);
  const fromNode: [number, number][] = [
    [sx, N.y],
    [sx, gapY],
    [cx, gapY],
    [cx, hy],
    [H.x, hy],
  ];
  if (up) {
    const pts = fromNode.slice(0, -1).concat([[H.x - ARROW, hy]]);
    return {
      d: roundedPath(pts),
      tip: tipAt(H.x, hy, "right"),
      labelX: N.x + BOX_W + 8,
      labelY: gapY - 3,
      stageY: gapY - 3,
    };
  }
  const pts = fromNode
    .slice(1)
    .reverse()
    .concat([[sx, N.y - ARROW]]);
  return {
    d: roundedPath(pts),
    tip: tipAt(sx, N.y, "down"),
    labelX: N.x + BOX_W + 8,
    labelY: gapY + 11,
    stageY: gapY + 11,
  };
}

/** 人の箱の左の辺の、`i` 本目（`n` 本中）の道が着く高さ。箱の上下 10px を残して、等しく分ける。 */
export function humanEndY(H: LayoutPos, i: number, n: number): number {
  const top = H.y + 10;
  const span = BOX_H - 20;
  return n <= 1 ? H.cy : top + (span * Math.min(i, n - 1)) / (n - 1);
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

/** 動く玉に道を設定する。中身は `d` と同じ検査を通したものだけ。 */
export function setRunnerPath(dot: HTMLElement, d: string): void {
  if (!PATH_PATTERN.test(d)) throw new Error("path: shape");
  dot.style.offsetPath = `path('${d}')`;
}
