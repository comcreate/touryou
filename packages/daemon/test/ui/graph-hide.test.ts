import { describe, expect, it } from "vitest";
import { graphModelOf, keptIdsOf } from "../../src/ui/graph-model.js";
import { graphString } from "../../src/ui/graph-text.js";

/** 表示モデルのノード（関係図が読む値だけ）。 */
const node = (id: string, parentId: string | null, band: string, state: string) => ({
  id,
  parentId,
  role: parentId === null ? "integrator" : "implement",
  state,
  band,
  title: id,
});
const flow = (child: string, parent: string) => ({
  from: child,
  to: parent,
  dir: "up",
  kind: "report",
  stage: "done",
  sentAt: "2026-11-22T10:00:00Z",
});
const idsOf = (m: { nodes: readonly { id: string }[] }): string[] => m.nodes.map((n) => n.id);
const hide = { hideFinished: true } as const;

describe("関係図: 止めた・済んだ子を隠す（#206）", () => {
  // root ─ done1（済んだ）
  //      ─ stop1（止めた）
  //      ─ run1（動いている）
  const flat = {
    nodes: [
      node("root", null, "running", "running"),
      node("done1", "root", "finished", "verified"),
      node("stop1", "root", "finished", "stopped"),
      node("run1", "root", "running", "running"),
    ],
    flows: [flow("done1", "root"), flow("stop1", "root"), flow("run1", "root")],
  };

  it("既定は隠さない（options なし・hideFinished が真でない）", () => {
    for (const m of [
      graphModelOf(flat),
      graphModelOf(flat, "ja", {}),
      graphModelOf(flat, "ja", { hideFinished: false }),
    ]) {
      expect(idsOf(m)).toEqual(["root", "done1", "stop1", "run1"]);
      expect(m.lanes).toHaveLength(3);
      expect(m.hidden).toBe(0);
    }
  });

  it("止めた・済んだ子を節と線から外し、隠した数を返す", () => {
    const m = graphModelOf(flat, "ja", hide);
    expect(idsOf(m)).toEqual(["root", "run1"]);
    expect(m.lanes.map((l) => l.child)).toEqual(["run1"]);
    expect(m.hidden).toBe(2);
  });

  it("動いている子の祖先は、止めた・済んだでも残す（線が途中で切れない）", () => {
    // root ─ mid（済んだ）─ run2（動いている）
    //      │              └ done2（済んだ）
    //      └ gone（済んだ）─ done3（済んだ）
    const view = {
      nodes: [
        node("root", null, "running", "running"),
        node("mid", "root", "finished", "verified"),
        node("run2", "mid", "running", "running"),
        node("done2", "mid", "finished", "verified"),
        node("gone", "root", "finished", "verified"),
        node("done3", "gone", "finished", "stopped"),
      ],
      flows: [
        flow("mid", "root"),
        flow("run2", "mid"),
        flow("done2", "mid"),
        flow("gone", "root"),
        flow("done3", "gone"),
      ],
    };
    const m = graphModelOf(view, "ja", hide);
    expect(idsOf(m)).toEqual(["root", "mid", "run2"]);
    // 残した親（mid）は、止めた・済んだの見た目のまま
    expect(m.nodes.find((n) => n.id === "mid")?.tier).toBe("over");
    // 線は、両端が残るものだけ
    expect(m.lanes.map((l) => `${l.parent}>${l.child}`)).toEqual(["root>mid", "mid>run2"]);
    expect(m.hidden).toBe(3);
  });

  it("答え待ち・失敗・止まっているかもの子は、隠さない（出番のもの）", () => {
    const view = {
      nodes: [
        node("root", null, "running", "running"),
        node("ask", "root", "turn", "waiting"),
        // 止まりきっていない（band が finished でも、人がすることが残る）
        node("half", "root", "finished", "stopIncomplete"),
      ],
      flows: [],
      decisions: [{ nodeId: "ask", question: "q", options: [] }],
    };
    const m = graphModelOf(view, "ja", hide);
    expect(idsOf(m)).toEqual(["root", "ask", "half"]);
    expect(m.hidden).toBe(0);
  });

  it("全部が済んでも、根は残る（図が空にならない）", () => {
    const view = {
      nodes: [
        node("root", null, "finished", "verified"),
        node("a", "root", "finished", "verified"),
        node("b", "a", "finished", "stopped"),
      ],
      flows: [flow("a", "root"), flow("b", "a")],
    };
    const m = graphModelOf(view, "ja", hide);
    expect(idsOf(m)).toEqual(["root"]);
    expect(m.lanes).toEqual([]);
    expect(m.hidden).toBe(2);
  });

  it("親をたどると輪になる入力でも止まる", () => {
    const view = {
      nodes: [node("x", "y", "running", "running"), node("y", "x", "finished", "verified")],
      flows: [],
    };
    const m = graphModelOf(view, "ja", hide);
    expect(idsOf(m)).toEqual(["x", "y"]);
    expect(m.hidden).toBe(0);
    expect([...keptIdsOf(m.nodes)].sort()).toEqual(["x", "y"]);
  });

  it("隠した数の文は、日本語と英語の両方にある", () => {
    expect(graphString("ja", "graph.hidden", { n: 3 })).toBe("3 件隠しています");
    expect(graphString("en", "graph.hidden", { n: 3 })).toBe("3 hidden");
  });
});
