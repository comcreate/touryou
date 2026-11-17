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
  /** ラベルの左下。 */
  readonly labelX: number;
  readonly labelY: number;
}

/**
 * 親 P から子 C への枝の、上り（子 → 親）か下り（親 → 子）の道。
 * `bendX` は、その子の枝が曲がる縦の線の x（外側の子ほど親の近く。`bendXOf` で決める）。
 * 角丸の折れ線：子の箱の左 ⇄ 曲がり目 ⇄ 親の高さ ⇄ 親の箱の右。
 */
export function laneOf(P: LayoutPos, C: LayoutPos, bendX: number, dir: Dir): Lane {
  const off = dir === "up" ? -LANE_GAP : LANE_GAP;
  const yC = C.cy + off;
  const yP = P.cy + off / 2;
  const xP = P.x + BOX_W;
  const xC = C.x;
  const dy = yP - yC;
  const r = Math.min(RADIUS, Math.abs(dy) / 2);
  const s = Math.sign(dy);
  // 子の側から親の側へ、の点の並び
  const pts: [string, ...number[]][] =
    r < 0.5
      ? [
          ["M", xC, yC],
          ["L", xP, yP],
        ]
      : [
          ["M", xC, yC],
          ["L", bendX + r, yC],
          ["Q", bendX, yC, bendX, yC + s * r],
          ["L", bendX, yP - s * r],
          ["Q", bendX, yP, bendX - r, yP],
          ["L", xP, yP],
        ];
  if (dir === "up") {
    // 子 → 親。矢印は親の箱の右の辺を指す（左向き）
    const last = pts[pts.length - 1] as [string, number, number];
    last[1] = xP + ARROW;
    return {
      d: pathD(pts),
      tip: pathD([
        ["M", xP, yP],
        ["L", xP + ARROW + 2, yP - 5],
        ["L", xP + ARROW + 2, yP + 5],
        ["Z"],
      ]),
      labelX: bendX + 12,
      labelY: yC - 6,
    };
  }
  // 親 → 子。点の並びを逆にして、矢印は子の箱の左の辺を指す（右向き）
  const rev = reverse(pts);
  const last = rev[rev.length - 1] as [string, number, number];
  last[1] = xC - ARROW;
  return {
    d: pathD(rev),
    tip: pathD([
      ["M", xC, yC],
      ["L", xC - ARROW - 2, yC - 5],
      ["L", xC - ARROW - 2, yC + 5],
      ["Z"],
    ]),
    labelX: bendX + 12,
    labelY: yC + 15,
  };
}

/** M・L・Q だけの道を、逆向きにする。 */
function reverse(pts: readonly [string, ...number[]][]): [string, ...number[]][] {
  const ends: [number, number][] = pts.map((p) => [
    p[p.length - 2] as number,
    p[p.length - 1] as number,
  ]);
  const out: [string, ...number[]][] = [["M", ...(ends[ends.length - 1] as [number, number])]];
  for (let i = pts.length - 1; i > 0; i--) {
    const p = pts[i] as [string, ...number[]];
    const to = ends[i - 1] as [number, number];
    if (p[0] === "Q") out.push(["Q", p[1] as number, p[2] as number, to[0], to[1]]);
    else out.push(["L", to[0], to[1]]);
  }
  return out;
}

/** 薄い点線の枝（やり取りのまだない子）。 */
export function twigOf(P: LayoutPos, C: LayoutPos, bendX: number): string {
  const xP = P.x + BOX_W;
  if (Math.abs(C.cy - P.cy) < 1)
    return pathD([
      ["M", xP, P.cy],
      ["L", C.x, C.cy],
    ]);
  return pathD([
    ["M", xP, P.cy],
    ["L", bendX, P.cy],
    ["L", bendX, C.cy],
    ["L", C.x, C.cy],
  ]);
}

/**
 * 子ごとの曲がり目の x。親の高さから遠い（外側の）子ほど、親の近くで曲げる（線を交わらせない）。
 * 子が多いときは、間を詰める（列の間からはみ出さない）。
 */
export function bendXOf(P: LayoutPos, kids: readonly LayoutPos[], colGap: number): number[] {
  const start = P.x + BOX_W + 16;
  const room = colGap - 16 - 40; // 子の箱の手前に、ラベルの場所を残す
  const order = kids
    .map((k, i) => ({ i, dist: Math.abs(k.cy - P.cy), above: k.cy < P.cy }))
    .sort((a, b) => b.dist - a.dist || a.i - b.i);
  // 上の子と下の子は別々に数える（上下で同じ x を使っても交わらない）
  const step = Math.min(10, room / Math.max(1, Math.ceil(kids.length / 2)));
  const out = new Array<number>(kids.length).fill(start);
  let up = 0;
  let down = 0;
  for (const o of order) {
    const rank = o.above ? up++ : down++;
    out[o.i] = start + rank * step;
  }
  return out;
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

/** 矢印の三角。先が (x, y) で、`to` の向き（右・下）を指す。 */
function tipAt(x: number, y: number, to: "right" | "down"): string {
  const b = ARROW + 2;
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
 */
export function humanLaneOf(N: LayoutPos, H: LayoutPos, corridorX: number, dir: Dir): Lane {
  const up = dir === "up";
  const sx = N.x + BOX_W - (up ? 24 : 40);
  const gapY = gapRowAbove(N.y) + (up ? -4 : 4);
  const cx = corridorX + (up ? 0 : LANE_GAP);
  const hy = H.cy + (up ? -LANE_GAP : LANE_GAP);
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
      labelX: sx + 8,
      labelY: gapY - 4,
    };
  }
  const pts = fromNode
    .slice(1)
    .reverse()
    .concat([[sx, N.y - ARROW]]);
  return {
    d: roundedPath(pts),
    tip: tipAt(sx, N.y, "down"),
    labelX: sx + 8,
    labelY: gapY - 4,
  };
}

/** 動く玉に道を設定する。中身は `d` と同じ検査を通したものだけ。 */
export function setRunnerPath(dot: HTMLElement, d: string): void {
  if (!PATH_PATTERN.test(d)) throw new Error("path: shape");
  dot.style.offsetPath = `path('${d}')`;
}
