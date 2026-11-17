import { describe, expect, it } from "vitest";
import { BOX_H, BOX_W, COL_GAP, layoutOf, ROW_H } from "../../src/ui/graph-layout.js";
import { graphModelOf } from "../../src/ui/graph-model.js";
import {
  bendXOf,
  gapRowAbove,
  humanColumnOf,
  humanLaneOf,
  LANE_GAP,
  laneOf,
  pathD,
  roundedPath,
  twigOf,
} from "../../src/ui/graph-path.js";
import { PATH_PATTERN, svgAttrValue } from "../../src/ui/svg-el.js";

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
      {
        parent: "root",
        child: "a",
        dir: "up",
        stage: "sent",
        unknown: true,
        label: "報告",
        human: false,
        waiting: false,
      },
      {
        parent: "root",
        child: "a",
        dir: "down",
        stage: "delivered",
        unknown: false,
        label: "やり取り",
        human: false,
        waiting: false,
      },
    ]);
    expect(graphModelOf(null)).toEqual({ nodes: [], lanes: [] });
  });
});

describe("人とのやり取り（段を飛ばす。木の外の「人」の箱）", () => {
  it("graphModelOf：人との上り・下りは、根でも孫でも残す。答え待ちの判断・範囲の頼みだけ waiting", () => {
    const m = graphModelOf({
      nodes: [
        { id: "root", parentId: null },
        { id: "a", parentId: "root" },
        { id: "g", parentId: "a" },
      ],
      flows: [
        {
          dir: "up",
          from: "g",
          to: "human",
          stage: "sent",
          kind: "decision",
          deliveryUnknown: true,
        },
        { dir: "down", from: "human", to: "g", stage: "sent", kind: "answer" },
        { dir: "up", from: "root", to: "human", stage: "done", kind: "report" },
        { dir: "up", from: "a", to: "human", stage: "done", kind: "extension" },
        { dir: "up", from: "human", to: "root", stage: "sent", kind: "report" }, // 人が子の側：落とす
        { dir: "down", from: "root", to: "g", stage: "sent", kind: "instruction" }, // ノードどうしの段飛ばし：落とす
        { dir: "up", from: "nobody", to: "human", stage: "sent", kind: "report" }, // 知らないノード：落とす
      ],
    });
    expect(m.lanes.map((l) => [l.child, l.dir, l.human, l.waiting])).toEqual([
      ["g", "up", true, true],
      ["g", "down", true, false],
      ["root", "up", true, false],
      ["a", "up", true, false],
    ]);
  });

  it("gapRowAbove：箱の上の、いちばん近い行の間（箱のない帯）", () => {
    const L = layoutOf([
      { id: "r", parentId: null },
      { id: "a", parentId: "r" },
      { id: "b", parentId: "r" },
    ]);
    for (const p of L.pos.values()) {
      const g = gapRowAbove(p.y);
      expect(g).toBeLessThan(p.y);
      expect(p.y - g).toBeLessThanOrEqual(ROW_H);
      // 同じ列と、右の列の葉（行に並ぶ箱）には入らない（右の列の親は、子の真ん中の高さなので、当たることがある）
      const leaves = new Set(["a", "b"]);
      for (const [id, q] of L.pos)
        if (q.x === p.x || (q.x > p.x && leaves.has(id)))
          expect(g < q.y || g > q.y + BOX_H, id).toBe(true);
    }
  });

  it("humanLaneOf：上りは人の箱の左を右向きに指し、下りはノードの箱の上を下向きに指す。d は許した形", () => {
    const N = { x: 400, y: 144, cy: 184, depth: 1 };
    const H = { x: 1000, y: 40, cy: 80, depth: -1 };
    const up = humanLaneOf(N, H, 900, "up");
    const down = humanLaneOf(N, H, 900, "down");
    for (const l of [up, down]) {
      expect(l.d).toMatch(PATH_PATTERN);
      expect(l.tip).toMatch(PATH_PATTERN);
    }
    expect(nums(up.tip).slice(0, 2)).toEqual([H.x, H.cy - LANE_GAP]);
    expect(nums(down.tip)[1]).toBe(N.y);
    expect(nums(up.d).slice(0, 2)).toEqual([N.x + BOX_W - 24, N.y]); // 箱の上の辺から出る
    expect(nums(down.d).slice(0, 2)).toEqual([H.x, H.cy + LANE_GAP]); // 人の箱から出る
  });

  it("roundedPath：点が 2 つなら直線。折れ目は Q で丸める", () => {
    expect(
      roundedPath([
        [0, 0],
        [10, 0],
      ]),
    ).toBe("M 0 0 L 10 0");
    expect(
      roundedPath([
        [0, 0],
        [20, 0],
        [20, 20],
      ]),
    ).toMatch(/^M 0 0 L 12 0 Q 20 0 20 8 L 20 20$/);
    expect(() => roundedPath([[0, 0]])).toThrow();
  });

  it("humanColumnOf：通り道の縦の線（上りと下り）の x は、どの箱の範囲にも入らない。人の箱は、どの箱とも重ならない", () => {
    const xs: { id: string; parentId: string | null }[] = [{ id: "r", parentId: null }];
    for (let i = 0; i < 6; i++) xs.push({ id: `k${i}`, parentId: i < 3 ? "r" : `k${i - 3}` });
    for (let i = 0; i < 4; i++) xs.push({ id: `g${i}`, parentId: "k3" });
    const L = layoutOf(xs);
    const col = humanColumnOf(L, xs.length);
    const boxes = [...L.pos.values()];
    for (let slot = 0; slot < xs.length; slot++)
      for (const x of [col.corridorX(slot), col.corridorX(slot) + LANE_GAP])
        for (const b of boxes) expect(x < b.x || x > b.x + BOX_W).toBe(true);
    for (const b of boxes) expect(col.human.x).toBeGreaterThan(b.x + BOX_W);
    expect(col.width).toBe(col.human.x + BOX_W + 40);
  });
});
