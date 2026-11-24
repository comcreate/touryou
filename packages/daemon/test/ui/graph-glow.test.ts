import { describe, expect, it } from "vitest";
import { type GraphNode, glowIdsOf } from "../../src/ui/graph-model.js";

/** 縁の光の選び方に関わる値だけを持つノード。 */
const node = (id: string, status: GraphNode["status"], lastAt: number | null): GraphNode => ({
  id,
  parentId: "root",
  title: id,
  role: "作業",
  integrator: false,
  status,
  tier: "go",
  statusText: "",
  alive: true,
  needsHuman: 0,
  lastAt,
});

describe("縁の光の選び方（glowIdsOf。流星と同じく新しい順）", () => {
  it("答え待ち・失敗の箱だけを選ぶ（止まっているかも・動いている・済んだは光らせない）", () => {
    const nodes = [
      node("w", "wait", 10),
      node("f", "fail", 20),
      node("s", "stall", 30),
      node("r", "run", 40),
      node("d", "done", 50),
    ];
    expect(glowIdsOf(nodes, 6)).toEqual(["f", "w"]);
  });

  it("上限を超えるときは、並びの先頭でなく、最後の動きが新しい 6 つを選ぶ", () => {
    // 並びの先頭（a0〜a5）は古く、あとの 6 つ（b0〜b5）が新しい
    const old = Array.from({ length: 6 }, (_, i) => node(`a${i}`, "wait", 100 + i));
    const fresh = Array.from({ length: 6 }, (_, i) =>
      node(`b${i}`, i % 2 === 0 ? "fail" : "wait", 1000 + i),
    );
    expect(glowIdsOf([...old, ...fresh], 6)).toEqual(["b5", "b4", "b3", "b2", "b1", "b0"]);
  });

  it("時刻のない箱は最後。同じ時刻は、並びのまま", () => {
    const nodes = [
      node("none", "wait", null),
      node("t1", "fail", 5),
      node("t2", "wait", 5),
      node("t3", "wait", 9),
    ];
    expect(glowIdsOf(nodes, 3)).toEqual(["t3", "t1", "t2"]);
    expect(glowIdsOf(nodes, 4)).toEqual(["t3", "t1", "t2", "none"]);
  });

  it("元の並びを変えない（描く側の model.nodes の並びを壊さない）", () => {
    const nodes = [node("x", "wait", 1), node("y", "wait", 2)];
    glowIdsOf(nodes, 6);
    expect(nodes.map((n) => n.id)).toEqual(["x", "y"]);
  });

  it("上限が 0 なら、何も選ばない", () => {
    expect(glowIdsOf([node("x", "wait", 1)], 0)).toEqual([]);
  });
});
