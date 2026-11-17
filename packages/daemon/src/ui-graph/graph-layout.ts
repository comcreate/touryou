/**
 * 関係図の配置（#89。設計の下書き 7 節）。I/O を持たない純粋な関数。
 * 横向きの木：根が左、深さが右へ。葉を上から順に置き、親は子の並びの真ん中の高さ。兄弟は入力の順（記録の seq の順）。
 * 親が見えないノード（親の ID が並びにない）は、根として最後に置く。
 */
export const BOX_W = 220;
export const BOX_H = 80;
/** 列の間（親の箱の右から、子の箱の左まで）。幹と枝はこの中に描く。 */
export const COL_GAP = 140;
/** 葉 1 つ分の高さ。 */
export const ROW_H = 104;
export const MARGIN = 40;

export interface LayoutInput {
  readonly id: string;
  readonly parentId: string | null;
}
export interface LayoutPos {
  readonly x: number;
  readonly y: number;
  /** 箱の縦の真ん中。 */
  readonly cy: number;
  readonly depth: number;
}
export interface Layout {
  readonly pos: ReadonlyMap<string, LayoutPos>;
  /** 親 → 子（入力の順）。 */
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly width: number;
  readonly height: number;
}

export function layoutOf(nodes: readonly LayoutInput[]): Layout {
  const ids = new Set<string>();
  const order: string[] = [];
  for (const n of nodes) {
    if (ids.has(n.id)) continue; // 同じ ID は最初のものだけ
    ids.add(n.id);
    order.push(n.id);
  }
  const parentOf = new Map<string, string | null>();
  for (const n of nodes) if (!parentOf.has(n.id)) parentOf.set(n.id, n.parentId);
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of order) {
    const p = parentOf.get(id) ?? null;
    if (p !== null && p !== id && ids.has(p)) {
      const xs = children.get(p) ?? [];
      xs.push(id);
      children.set(p, xs);
    } else roots.push(id);
  }
  const pos = new Map<string, LayoutPos>();
  let leaf = 0;
  let maxDepth = 0;
  const seen = new Set<string>();
  // 再帰でなく、明示の積み上げで（深い鎖でも積み上げがあふれない）
  const place = (root: string): void => {
    const stack: { id: string; depth: number; i: number }[] = [{ id: root, depth: 0, i: 0 }];
    seen.add(root);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: string; depth: number; i: number };
      const kids = (children.get(top.id) ?? []).filter((k) => !seen.has(k) || pos.has(k));
      if (top.i < kids.length) {
        const k = kids[top.i++] as string;
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push({ id: k, depth: top.depth + 1, i: 0 });
        continue;
      }
      stack.pop();
      const placed = kids.filter((k) => pos.has(k));
      let cy: number;
      if (placed.length === 0) cy = MARGIN + leaf++ * ROW_H + BOX_H / 2;
      else {
        const first = pos.get(placed[0] as string) as LayoutPos;
        const last = pos.get(placed[placed.length - 1] as string) as LayoutPos;
        cy = (first.cy + last.cy) / 2;
      }
      maxDepth = Math.max(maxDepth, top.depth);
      const x = MARGIN + top.depth * (BOX_W + COL_GAP);
      pos.set(top.id, { x, y: cy - BOX_H / 2, cy, depth: top.depth });
    }
  };
  for (const r of roots) place(r);
  // 輪（親をたどると戻るもの）で根に届かなかったノードも、根として置く
  for (const id of order) if (!seen.has(id)) place(id);
  const shown = new Map<string, readonly string[]>();
  for (const [p, xs] of children)
    shown.set(
      p,
      xs.filter((k) => pos.has(k)),
    );
  return {
    pos,
    children: shown,
    width: MARGIN * 2 + maxDepth * (BOX_W + COL_GAP) + BOX_W,
    height: MARGIN * 2 + Math.max(1, leaf) * ROW_H - (ROW_H - BOX_H),
  };
}
