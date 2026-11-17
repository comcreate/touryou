import { describe, expect, it } from "vitest";
import { graphModelOf } from "../../src/ui-graph/graph-entry.js";
import { BOX_W, COL_GAP, layoutOf } from "../../src/ui-graph/graph-layout.js";
import { bendXOf, LANE_GAP, laneOf, pathD, twigOf } from "../../src/ui-graph/graph-path.js";
import { PATH_PATTERN, svgAttrValue } from "../../src/ui-graph/svg-el.js";

const must = <T>(x: T | undefined | null): T => {
  if (x === undefined || x === null) throw new Error("missing");
  return x;
};
const nums = (d: string) => [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

describe("graph-path（線の道）", () => {
  const L = layoutOf([
    { id: "r", parentId: null },
    { id: "a", parentId: "r" },
    { id: "b", parentId: "r" },
    { id: "c", parentId: "r" },
  ]);
  const P = must(L.pos.get("r"));
  const kids = ["a", "b", "c"].map((k) => must(L.pos.get(k)));
  const bends = bendXOf(P, kids, COL_GAP);

  it("d は許した命令と数だけ", () => {
    for (const [i, C] of kids.entries())
      for (const dir of ["up", "down"] as const) {
        const l = laneOf(P, C, must(bends[i]), dir);
        expect(l.d).toMatch(PATH_PATTERN);
        expect(l.tip).toMatch(PATH_PATTERN);
        expect(l.d).toMatch(/^[MLQ0-9 .-]+$/);
      }
    expect(twigOf(P, must(kids[0]), must(bends[0]))).toMatch(PATH_PATTERN);
    expect(() => pathD([["M", Number.NaN, 0]])).toThrow();
    expect(() => pathD([["X" as "M", 0, 0]])).toThrow();
  });

  it("上りは子の箱の左から親の右へ（矢印は左向き）、下りは親の右から子の左へ（矢印は右向き）", () => {
    const C = must(kids[1]); // 真ん中の子（親と同じ高さ）
    const up = laneOf(P, C, must(bends[1]), "up");
    const down = laneOf(P, C, must(bends[1]), "down");
    expect(nums(up.d)[0]).toBe(C.x);
    expect(nums(up.d).at(-2)).toBeGreaterThan(P.x + BOX_W);
    expect(nums(up.tip)[0]).toBe(P.x + BOX_W); // 三角の先が、親の辺
    expect(nums(down.d)[0]).toBe(P.x + BOX_W);
    expect(nums(down.tip)[0]).toBe(C.x); // 三角の先が、子の辺
    // 上りは上、下りは下にずれて、重ならない
    expect(nums(up.d)[1]).toBe(C.cy - LANE_GAP);
    expect(nums(down.d).at(-1)).toBe(C.cy + LANE_GAP);
  });

  it("外側の子ほど親の近くで曲げる（交わらない）。子が多くても列の間に収まる", () => {
    expect(bends[0]).toBe(bends[2]); // 上と下は別に数える
    expect(must(bends[0])).toBeLessThan(must(bends[1]));
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `k${i}`, parentId: "r" }));
    const M = layoutOf([{ id: "r", parentId: null }, ...many]);
    const MP = must(M.pos.get("r"));
    const bx = bendXOf(
      MP,
      many.map((k) => must(M.pos.get(k.id))),
      COL_GAP,
    );
    for (const x of bx) {
      expect(x).toBeGreaterThan(MP.x + BOX_W);
      expect(x).toBeLessThan(MP.x + BOX_W + COL_GAP - 40);
    }
    // 親より上の子は、上の子ほど曲がり目が小さい
    const above = many
      .map((k, i) => ({ cy: must(M.pos.get(k.id)).cy, x: must(bx[i]) }))
      .filter((p) => p.cy < MP.cy);
    for (let i = 1; i < above.length; i++)
      expect(must(above[i]).x).toBeGreaterThanOrEqual(must(above[i - 1]).x);
  });
});

describe("svgEl の値の検査", () => {
  it("数・クラス・d・viewBox の形だけ通す", () => {
    expect(svgAttrValue("x", 1.234)).toBe("1.2");
    expect(svgAttrValue("class", "line up g-sent")).toBe("line up g-sent");
    expect(svgAttrValue("class", "line ")).toBe("line");
    expect(svgAttrValue("d", "M 1 2 L 3 4 Z")).toBe("M 1 2 L 3 4 Z");
    expect(svgAttrValue("viewBox", "0 0 100 50")).toBe("0 0 100 50");
    for (const [k, v] of [
      ["x", "1"],
      ["x", Number.POSITIVE_INFINITY],
      ["class", 'a"b'],
      ["class", "A"],
      ["class", "line bogus"],
      ["class", ""],
      ["class", "__proto__"],
      ["d", "M 0 0 url(#x)"],
      ["d", "M0 0');x:y"],
      ["viewBox", "0 0 1"],
      ["href", "javascript:alert(1)"],
      ["onclick", "x"],
      ["style", "x"],
    ] as const)
      expect(() => svgAttrValue(k, v), `${k}=${String(v)}`).toThrow();
  });
});

describe("graphModelOf（図に渡す値の作り直し）", () => {
  it("ID は ID_PATTERN を通したものだけ。文字は整える。種類・段は許可リスト", () => {
    const m = graphModelOf({
      nodes: [
        { id: "root", parentId: null, role: "integrator", state: "running", title: "統合‮<b>x</b>" },
        { id: "<img>", parentId: "root", role: "implement", state: "running" },
        { id: "a", parentId: "root", role: "__proto__", state: "running", band: "turn" },
        { id: "a", parentId: null },
      ],
      flows: [
        {
          id: "f1",
          dir: "up",
          from: "a",
          to: "root",
          stage: "sent",
          kind: "report",
          deliveryUnknown: true,
        },
        { id: "f0", dir: "up", from: "a", to: "root", stage: "done", kind: "report" },
        { id: "f2", dir: "down", from: "root", to: "a", stage: "bogus", kind: "instruction" },
        { id: "f3", dir: "down", from: "root", to: "a", stage: "delivered", kind: "toString" },
      ],
    });
    expect(m.nodes.map((n) => n.id)).toEqual(["root", "a"]);
    expect(m.nodes[0]?.title).toBe("統合<b>x</b>"); // 書式制御文字を除く（文字は textContent で入れる）
    expect(m.nodes[1]?.sub).toBe("作業・running");
    expect(m.nodes[1]?.band).toBe("turn");
    expect(m.lanes).toEqual([
      { parent: "root", child: "a", dir: "up", stage: "sent", unknown: true, label: "報告" },
      {
        parent: "root",
        child: "a",
        dir: "down",
        stage: "delivered",
        unknown: false,
        label: "やり取り",
      },
    ]);
    expect(graphModelOf(null)).toEqual({ nodes: [], lanes: [] });
  });
});
