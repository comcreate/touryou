import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { UI_JS } from "../../src/api/ui-assets.js";
import { BOX_H, BOX_W, COL_GAP, layoutOf, MARGIN, ROW_H } from "../../src/ui/graph-layout.js";
import {
  ageClassOf,
  agoText,
  graphModelOf,
  RUN_TEXT,
  STATUS_TEXT,
  stageText,
} from "../../src/ui/graph-model.js";
import {
  LANE_GAP,
  laneOf,
  pathD,
  roleIconOf,
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
    ["run", "run", "go", "動いている", true],
    ["ask", "wait", "turn", "● あなたの答え待ち", false],
    ["stall", "stall", "turn", "‖ 止まっているかも", false],
    ["fail", "fail", "turn", "✕ 失敗", false],
    ["arch", "done", "over", "済んだ", false],
    ["stop", "stopped", "over", "■ 止めた", false],
    ["pend", "run", "go", "起動を待っている", false],
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
    // 新しさの段（5 分・30 分・1 時間で区切る。時刻がなければいちばん古い段）
    expect([0, 5, 6, 30, 31, 60, 61].map((m) => ageClassOf(0, m * 60_000))).toEqual([
      "a1",
      "a1",
      "a2",
      "a2",
      "a3",
      "a3",
      "a4",
    ]);
    expect(ageClassOf(null, 0)).toBe("a4");
    expect(agoText(12 * 60_000)).toBe("12 分前");
    expect(agoText(3 * 3600_000)).toBe("3 時間前");
    expect(stageText({ stage: "sent", unknown: true, inferred: false })).toBe(
      "送った（届いたかは分からない）",
    );
    expect(stageText({ stage: "done", unknown: false, inferred: true })).toBe("済んだ（推定）");
  });
});

describe("人とのやり取り（人の箱は置かない。利用者の決め）", () => {
  it("graphModelOf：人の答えなどは、親から子への下りの線にする。子から親への判断・範囲の頼みで、済んでいないものだけ waiting。根と人のやり取りは線にしない", () => {
    const m = graphModelOf({
      nodes: [
        { id: "root", parentId: null },
        { id: "a", parentId: "root" },
        { id: "g", parentId: "a" },
      ],
      flows: [
        { dir: "up", from: "g", to: "a", stage: "sent", kind: "decision", deliveryUnknown: true },
        { dir: "down", from: "human", to: "g", stage: "sent", kind: "answer" },
        { dir: "up", from: "a", to: "root", stage: "sent", kind: "extension" },
        { dir: "down", from: "human", to: "a", stage: "done", kind: "approved" },
        { dir: "up", from: "root", to: "human", stage: "sent", kind: "decision" }, // 根 → 人：線にしない
        { dir: "down", from: "human", to: "root", stage: "sent", kind: "answer" }, // 人 → 根：線にしない
        { dir: "up", from: "g", to: "human", stage: "sent", kind: "report" }, // 人あての上り：線にしない
        { dir: "down", from: "root", to: "g", stage: "sent", kind: "instruction" }, // ノードどうしの段飛ばし：落とす
        { dir: "down", from: "human", to: "nobody", stage: "sent", kind: "answer" }, // 知らないノード：落とす
      ],
    });
    expect(m.lanes.map((l) => [l.parent, l.child, l.dir, l.label, l.waiting])).toEqual([
      ["a", "g", "up", "判断を求む", true],
      ["a", "g", "down", "答え", false],
      ["root", "a", "up", "範囲の頼み", true],
      ["root", "a", "down", "許可", false],
    ]);
    // 済んだ頼みは柿色にしない
    const done = graphModelOf({
      nodes: [
        { id: "root", parentId: null },
        { id: "a", parentId: "root" },
      ],
      flows: [{ dir: "up", from: "a", to: "root", stage: "done", kind: "decision" }],
    });
    expect(done.lanes.map((l) => l.waiting)).toEqual([false]);
  });
});

describe("上りの線は、答え待ちの頼みを優先する（利用者の決め）", () => {
  const nodes = [
    { id: "root", parentId: null },
    { id: "a", parentId: "root" },
  ];
  it("頼みのあとに新しい報告が来ても、上りの線は柿色の頼みのまま。下りの線は、いちばん新しいもの", () => {
    const m = graphModelOf({
      nodes,
      flows: [
        // 新しい順
        {
          dir: "up",
          from: "a",
          to: "root",
          stage: "done",
          kind: "report",
          sentAt: "2026-11-17T10:03:00Z",
        },
        { dir: "down", from: "root", to: "a", stage: "sent", kind: "instruction" },
        {
          dir: "up",
          from: "a",
          to: "root",
          stage: "sent",
          kind: "extension",
          sentAt: "2026-11-17T10:02:00Z",
        },
        { dir: "down", from: "human", to: "a", stage: "done", kind: "answer" },
        {
          dir: "up",
          from: "a",
          to: "root",
          stage: "sent",
          kind: "decision",
          sentAt: "2026-11-17T10:01:00Z",
        },
      ],
    });
    expect(m.lanes.map((l) => [l.dir, l.label, l.waiting])).toEqual([
      ["up", "範囲の頼み", true], // 答え待ちの頼みのうち、いちばん新しいもの
      ["down", "指示", false],
    ]);
  });
  it("頼みに答えたあと（段が done）は、いちばん新しいものに戻る", () => {
    const m = graphModelOf({
      nodes,
      flows: [
        { dir: "up", from: "a", to: "root", stage: "done", kind: "report" },
        { dir: "up", from: "a", to: "root", stage: "done", kind: "extension" },
      ],
    });
    expect(m.lanes.map((l) => [l.label, l.waiting])).toEqual([["報告", false]]);
  });
});

describe("閉じた判断は、答え待ちに数えない（カードと同じ）", () => {
  it("閉じた判断（closedReason）だけが残る子は、答え待ちの箱にならず、柿色の線も丸い数も出ない", () => {
    const m = graphModelOf({
      nodes: [
        { id: "root", parentId: null },
        { id: "a", parentId: "root", band: "turn", needsHuman: 0 },
        { id: "b", parentId: "root", needsHuman: 1 },
      ],
      decisions: [
        { decisionId: "d1", nodeId: "a", closedReason: "discarded" },
        { decisionId: "d2", nodeId: "b" },
      ],
      flows: [
        { dir: "up", from: "a", to: "root", stage: "done", kind: "decision" },
        { dir: "up", from: "b", to: "root", stage: "sent", kind: "decision" },
      ],
    });
    const a = m.nodes.find((n) => n.id === "a");
    const b = m.nodes.find((n) => n.id === "b");
    expect(a?.status).not.toBe("wait");
    expect(a?.needsHuman).toBe(0);
    expect(b?.status).toBe("wait");
    expect(b?.needsHuman).toBe(1);
    expect(m.lanes.filter((l) => l.waiting).map((l) => l.child)).toEqual(["b"]);
  });
});

describe("箱の状態の言葉は、画面（app.js）の STATE_NAMES と同じ", () => {
  it("RUN_TEXT の値は、STATE_NAMES の同じキーの値と同じ（「■ 」の印つきの止まりきっていないは、印を除いて）", () => {
    const i = UI_JS.indexOf("var STATE_NAMES = {");
    const names = runInNewContext(
      `(${UI_JS.slice(UI_JS.indexOf("{", i), UI_JS.indexOf("};", i) + 1)})`,
    ) as Record<string, string>;
    for (const [k, v] of Object.entries(RUN_TEXT)) expect(v.replace(/^■ /, ""), k).toBe(names[k]);
    expect(STATUS_TEXT.run).toBe(names.running);
  });
});
