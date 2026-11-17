import { describe, expect, it } from "vitest";
import { BOX_H, BOX_W, COL_GAP, layoutOf, MARGIN, ROW_H } from "../../src/ui/graph-layout.js";
import { agoText, graphModelOf, stageText } from "../../src/ui/graph-model.js";
import {
  gapRowAbove,
  humanColumnOf,
  humanEndY,
  humanLaneOf,
  LANE_GAP,
  laneOf,
  pathD,
  roleIconOf,
  roundedPath,
  trunkOf,
  trunkXOf,
  twigOf,
} from "../../src/ui/graph-path.js";
import { PATH_PATTERN, svgAttrValue } from "../../src/ui/svg-el.js";

const must = <T>(x: T | undefined | null): T => {
  if (x === undefined || x === null) throw new Error("missing");
  return x;
};
const nums = (d: string) => [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

describe("graph-path（線の道。幹から子ごとに枝分かれ）", () => {
  const L = layoutOf([
    { id: "r", parentId: null },
    { id: "a", parentId: "r" },
    { id: "b", parentId: "r" },
    { id: "c", parentId: "r" },
  ]);
  const P = must(L.pos.get("r"));
  const kids = ["a", "b", "c"].map((k) => must(L.pos.get(k)));
  const tx = trunkXOf(P);

  it("d は許した命令と数だけ", () => {
    for (const C of kids)
      for (const dir of ["up", "down"] as const) {
        const l = laneOf(P, C, dir);
        expect(l.d).toMatch(PATH_PATTERN);
        expect(l.tip).toMatch(PATH_PATTERN);
      }
    for (const d of trunkOf(P, kids)) expect(d).toMatch(PATH_PATTERN);
    expect(twigOf(P, must(kids[0]))).toMatch(PATH_PATTERN);
    expect(roleIconOf(true)).toMatch(PATH_PATTERN);
    expect(roleIconOf(false)).toMatch(PATH_PATTERN);
    expect(() => pathD([["M", Number.NaN, 0]])).toThrow();
    expect(() => pathD([["X" as "M", 0, 0]])).toThrow();
  });

  it("上りは子の箱の左から幹へ（矢印の先は幹・左向き）、下りは幹から子の箱へ（矢印の先は子の箱・右向き）。端子は子の箱の端", () => {
    const C = must(kids[1]);
    const up = laneOf(P, C, "up");
    const down = laneOf(P, C, "down");
    expect(nums(up.d)[0]).toBe(C.x);
    expect(nums(up.tip).slice(0, 2)).toEqual([tx, C.cy - LANE_GAP]);
    expect(nums(up.tip)[2]).toBeGreaterThan(tx); // 左向き（三角の底が右）
    expect(nums(down.d)[0]).toBe(tx);
    expect(nums(down.tip).slice(0, 2)).toEqual([C.x, C.cy + LANE_GAP]);
    expect([up.portX, up.portY]).toEqual([C.x, C.cy - LANE_GAP]);
    // 札は線の上（上り）・下（下り）、段の言葉はその外側
    expect(up.stageY).toBeLessThan(up.labelY);
    expect(down.stageY).toBeGreaterThan(down.labelY);
  });

  it("上りの矢印の先は、子ごとに違う高さ（1 点に重ならない）。幹は子の高さの全体にのびる", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, parentId: "r" }));
    const M = layoutOf([{ id: "r", parentId: null }, ...many]);
    const MP = must(M.pos.get("r"));
    const kp = many.map((k) => must(M.pos.get(k.id)));
    const tips = kp.map((C) =>
      nums(laneOf(MP, C, "up").tip)
        .slice(0, 2)
        .join(","),
    );
    expect(new Set(tips).size).toBe(kp.length);
    const [stub, trunk] = trunkOf(MP, kp).map(nums);
    expect(must(stub)[0]).toBe(MP.x + BOX_W);
    expect(must(trunk)[1]).toBeLessThanOrEqual(Math.min(...kp.map((k) => k.cy)));
    expect(must(trunk)[3]).toBeGreaterThanOrEqual(Math.max(...kp.map((k) => k.cy)));
    // 札は列の間に収まる（子の箱にかからない）
    for (const C of kp) expect(laneOf(MP, C, "up").labelX).toBeLessThan(C.x - 150);
    expect(COL_GAP).toBeGreaterThanOrEqual(200);
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
    expect(m.nodes[0]?.role).toBe("統合");
    expect(m.nodes[0]?.integrator).toBe(true);
    expect(m.nodes[1]?.role).toBe("作業"); // 知らない役割（__proto__）は「作業」
    expect(m.nodes[1]?.integrator).toBe(false);
    expect(m.lanes).toEqual([
      {
        parent: "root",
        child: "a",
        dir: "up",
        stage: "sent",
        unknown: true,
        label: "報告",
        inferred: false,
        at: null,
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
        inferred: false,
        at: null,
        human: false,
        waiting: false,
      },
    ]);
    expect(graphModelOf(null)).toEqual({ nodes: [], lanes: [] });
  });
});

describe("箱の状態（見本の STATE・TIER。画面の言葉とそろえる）", () => {
  const AT = "2026-11-17T10:00:00Z";
  const m = graphModelOf({
    nodes: [
      {
        id: "run",
        parentId: null,
        role: "integrator",
        state: "running",
        band: "running",
        lastActivityAt: AT,
      },
      {
        id: "ask",
        parentId: "run",
        role: "implement",
        state: "running",
        band: "turn",
        needsHuman: 2,
      },
      {
        id: "stall",
        parentId: "run",
        role: "investigate",
        state: "running",
        band: "turn",
        needsHuman: 1,
      },
      { id: "fail", parentId: "run", role: "implement", state: "running", band: "turn" },
      { id: "arch", parentId: "run", role: "implement", state: "archived", band: "finished" },
      { id: "stop", parentId: "run", role: "implement", state: "stopped", band: "finished" },
      {
        id: "pend",
        parentId: "run",
        role: "review",
        state: "pending",
        band: "running",
        lastActivityAt: "bad",
      },
    ],
    decisions: [{ id: "d1", nodeId: "ask" }],
    inbox: [
      { id: "s1", nodeId: "stall", kind: "info", priority: "info", stall: true },
      { id: "f1", nodeId: "fail", kind: "failure", priority: "failed" },
    ],
  });
  const by = new Map(m.nodes.map((n) => [n.id, n]));
  it.each([
    ["run", "run", "go", "動いています", true],
    ["ask", "wait", "turn", "● あなたの答え待ち", false],
    ["stall", "stall", "turn", "‖ 止まっているかも", false],
    ["fail", "fail", "turn", "✕ 失敗", false],
    ["arch", "done", "over", "済んだ", false],
    ["stop", "stopped", "over", "■ 止めた", false],
    ["pend", "run", "go", "起動を待っています", false],
  ] as const)("%s → %s・%s・「%s」", (id, status, tier, text, alive) => {
    const n = must(by.get(id));
    expect([n.status, n.tier, n.statusText, n.alive]).toEqual([status, tier, text, alive]);
  });
  it("役割の名前・人の答えの数・最後の動きの時刻（形の違う時刻は null）", () => {
    expect(must(by.get("stall")).role).toBe("調べ");
    expect(must(by.get("ask")).needsHuman).toBe(2);
    expect(must(by.get("run")).lastAt).toBe(Date.parse(AT));
    expect(must(by.get("pend")).lastAt).toBe(null);
    expect(agoText(0)).toBe("いま");
    expect(agoText(12 * 60_000)).toBe("12 分前");
    expect(agoText(3 * 3600_000)).toBe("3 時間前");
    expect(stageText({ stage: "sent", unknown: true, inferred: false })).toBe(
      "送った（届いたかは分からない）",
    );
    expect(stageText({ stage: "done", unknown: false, inferred: true })).toBe("済んだ（推定）");
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
    expect(nums(up.tip).slice(0, 2)).toEqual([H.x, H.y + 10]); // 人の箱の左の辺の、道ごとの高さ
    expect(nums(down.tip)[1]).toBe(N.y);
    expect(nums(up.d).slice(0, 2)).toEqual([N.x + BOX_W - 24, N.y]); // 箱の上の辺から出る
    expect(nums(down.d).slice(0, 2)).toEqual([H.x, H.y + 70]); // 人の箱から出る（上りと違う高さ）
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
    expect(col.width).toBe(col.human.x + BOX_W + MARGIN);
  });

  it("humanEndY：人の箱に着く高さは、道ごとに違い、箱の中に収まる", () => {
    const H = { x: 1000, y: 40, cy: 80, depth: -1 };
    const ys = Array.from({ length: 8 }, (_, i) => humanEndY(H, i, 8));
    expect(new Set(ys).size).toBe(8);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(H.y + 10);
      expect(y).toBeLessThanOrEqual(H.y + BOX_H - 10);
    }
    expect(humanEndY(H, 0, 1)).toBe(H.cy);
  });
});
