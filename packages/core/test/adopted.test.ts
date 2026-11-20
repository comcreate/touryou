import { describe, expect, it } from "vitest";
import { type EventBody, foldEvents, type OrchEvent } from "../src/index.js";

let counter = 0;
const ev = (body: EventBody, actor: OrchEvent["actor"] = { system: true }): OrchEvent => {
  counter += 1;
  return {
    seq: counter,
    at: "2026-11-20T00:00:00Z",
    requestId: `adopted-req-${counter}`,
    actor,
    ...body,
  } as OrchEvent;
};

const scope = { writableLocations: ["src"], forbiddenLocations: [], allowedCommands: [] };

const tree = (): OrchEvent[] => [
  ev({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  }),
  ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
  ev({
    type: "node.created",
    payload: {
      nodeId: "a",
      role: "implement",
      parentId: "root",
      dependsOn: [],
      objective: "目的",
      acceptanceCriteria: ["基準"],
      scope,
    },
  }),
  ev({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } }),
];

describe("node.adopted（既存の作業ツリーの採用。#163）", () => {
  it("作業ツリー・ブランチ・採用した者を、ノードの記録に残す", () => {
    const actor = { nodeId: "root" };
    const r = foldEvents([
      ...tree(),
      ev(
        {
          type: "node.adopted",
          payload: { nodeId: "a", worktree: "/tmp/wt-a", branch: "feature/a", sessionRef: "s-1" },
        },
        actor,
      ),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.value.nodes.find((n) => n.id === "a");
    expect(a?.adopted).toMatchObject({
      worktree: "/tmp/wt-a",
      branch: "feature/a",
      sessionRef: "s-1",
      by: actor,
    });
    // 範囲は node.created が持つ（採用の記録で変わらない）
    expect(a?.scope?.writableLocations).toEqual(["src"]);
  });

  it("存在しないノードの採用は、拒否する", () => {
    const r = foldEvents([
      ...tree(),
      ev({
        type: "node.adopted",
        payload: { nodeId: "ghost", worktree: "/tmp/wt-x", branch: "feature/x" },
      }),
    ]);
    expect(r.ok).toBe(false);
  });

  it("作業ツリーが絶対パスでない・ブランチが空の記録は、拒否する", () => {
    for (const payload of [
      { nodeId: "a", worktree: "relative/path", branch: "feature/a" },
      { nodeId: "a", worktree: "/tmp/wt-a", branch: "" },
    ]) {
      const r = foldEvents([...tree(), ev({ type: "node.adopted", payload })]);
      expect(r.ok).toBe(false);
    }
  });

  it("採用していないノードには、adopted がない", () => {
    const r = foldEvents(tree());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes.every((n) => n.adopted === undefined)).toBe(true);
  });
});
