import { describe, expect, it } from "vitest";
import { BOX_H, BOX_W, COL_GAP, layoutOf, MARGIN, ROW_H } from "../../src/ui-graph/graph-layout.js";

const n = (id: string, parentId: string | null = null) => ({ id, parentId });
const at = (L: ReturnType<typeof layoutOf>, id: string) => {
  const p = L.pos.get(id);
  if (p === undefined) throw new Error(id);
  return p;
};
const noOverlap = (L: ReturnType<typeof layoutOf>) => {
  const ps = [...L.pos.values()];
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i] as { x: number; y: number };
      const b = ps[j] as { x: number; y: number };
      const apart = Math.abs(a.x - b.x) >= BOX_W || Math.abs(a.y - b.y) >= BOX_H;
      expect(apart).toBe(true);
    }
};

describe("layoutOf（横向きの木）", () => {
  it("根だけ", () => {
    const L = layoutOf([n("root")]);
    expect(at(L, "root")).toEqual({ x: MARGIN, y: MARGIN, cy: MARGIN + BOX_H / 2, depth: 0 });
    expect(L.width).toBe(MARGIN * 2 + BOX_W);
    expect(L.height).toBe(MARGIN * 2 + BOX_H);
  });

  it("根が左、深さが右へ。鎖はまっすぐ横に並ぶ", () => {
    const L = layoutOf([n("a"), n("b", "a"), n("c", "b")]);
    expect(at(L, "b").x - at(L, "a").x).toBe(BOX_W + COL_GAP);
    expect(at(L, "c").depth).toBe(2);
    expect(new Set([at(L, "a").cy, at(L, "b").cy, at(L, "c").cy]).size).toBe(1);
  });

  it("兄弟は入力の順（seq の順）に上から並び、親は子の並びの真ん中の高さ", () => {
    const L = layoutOf([n("r"), n("k2", "r"), n("k1", "r"), n("k3", "r")]);
    expect(at(L, "k2").cy).toBeLessThan(at(L, "k1").cy);
    expect(at(L, "k1").cy).toBeLessThan(at(L, "k3").cy);
    expect(at(L, "k1").cy - at(L, "k2").cy).toBe(ROW_H);
    expect(at(L, "r").cy).toBe((at(L, "k2").cy + at(L, "k3").cy) / 2);
    expect(L.children.get("r")).toEqual(["k2", "k1", "k3"]);
  });

  it("深さの不揃いな木：親は、最初と最後の子の真ん中。重ならない", () => {
    const L = layoutOf([
      n("r"),
      n("a", "r"),
      n("a1", "a"),
      n("a2", "a"),
      n("b", "r"),
      n("c", "r"),
      n("c1", "c"),
    ]);
    expect(at(L, "a").cy).toBe((at(L, "a1").cy + at(L, "a2").cy) / 2);
    expect(at(L, "r").cy).toBe((at(L, "a").cy + at(L, "c").cy) / 2);
    expect(at(L, "c1").cy).toBe(at(L, "c").cy);
    noOverlap(L);
  });

  it("子が多い（50）：上限なく縦に並び、重ならず、親は真ん中。高さは葉の数で決まる", () => {
    const kids = Array.from({ length: 50 }, (_, i) => n(`k${i}`, "r"));
    const L = layoutOf([n("r"), ...kids]);
    expect(L.pos.size).toBe(51);
    expect(at(L, "r").cy).toBe((at(L, "k0").cy + at(L, "k49").cy) / 2);
    expect(L.height).toBe(MARGIN * 2 + 50 * ROW_H - (ROW_H - BOX_H));
    noOverlap(L);
  });

  it("親の見えない子・輪・同じ ID：落とさず、根として置く。同じ入力で同じ出力", () => {
    const input = [n("r"), n("x", "missing"), n("p", "q"), n("q", "p"), n("r", "x")];
    const L = layoutOf(input);
    expect([...L.pos.keys()].sort()).toEqual(["p", "q", "r", "x"]);
    expect(at(L, "r").depth).toBe(0);
    expect(at(L, "x").depth).toBe(0);
    noOverlap(L);
    expect(layoutOf(input)).toEqual(L);
  });

  it("深い鎖（2,000 段）でも積み上げがあふれない", () => {
    const xs = Array.from({ length: 2000 }, (_, i) => n(`n${i}`, i === 0 ? null : `n${i - 1}`));
    expect(layoutOf(xs).pos.size).toBe(2000);
  });
});
