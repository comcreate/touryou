import { describe, expect, it } from "vitest";
import {
  awaitingHuman,
  type EventBody,
  foldEvents,
  intentionallyIdle,
  lastActivityAt,
  lastActivityMs,
  type OrchEvent,
  type OrchState,
  uiViewOf,
} from "../src/index.js";

const SYS = { system: true } as const;
let n = 0;
const ev = (body: EventBody, at: string): OrchEvent =>
  ({ seq: ++n, at, requestId: `r${n}`, actor: SYS, ...body }) as OrchEvent;
const must = (events: OrchEvent[]): OrchState => {
  const r = foldEvents(events);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};
const T0 = "2026-10-20T00:00:00.000Z";
const T1 = "2026-10-20T01:00:00.000Z";
const T2 = "2026-10-20T02:00:00.000Z";
const base = (): OrchEvent[] => {
  n = 0;
  return [
    ev(
      {
        type: "node.created",
        payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
      },
      T0,
    ),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }, T0),
    ev(
      {
        type: "node.created",
        payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
      },
      T0,
    ),
    ev({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } }, T0),
  ];
};

describe("lastActivityMs（#195。見張りと画面の共通の数え方）", () => {
  it("指示は、送った時刻（受け取る前）も動きに数える", () => {
    const s = must([
      ...base(),
      ev({ type: "node.instructed", payload: { nodeId: "a", text: "x" } }, T2),
    ]);
    expect(lastActivityMs(s, "a")).toBe(Date.parse(T2));
  });

  it("フックの時刻（extraMs）のほうが新しければ、それを返す", () => {
    const s = must(base());
    expect(lastActivityMs(s, "a", Date.parse(T1))).toBe(Date.parse(T1));
  });

  it("画面の lastActivityAt は、同じ関数の値", () => {
    const s = must([
      ...base(),
      ev({ type: "node.instructed", payload: { nodeId: "a", text: "x" } }, T2),
    ]);
    const at = uiViewOf(s).nodes.find((x) => x.id === "a")?.lastActivityAt;
    expect(at).toBe(lastActivityAt(s, "a"));
    expect(Date.parse(at ?? "")).toBe(lastActivityMs(s, "a"));
  });
});

describe("intentionallyIdle（#195）", () => {
  it("running で何も待っていない子は、待つと決まっていない", () => {
    expect(intentionallyIdle(must(base()), "a")).toBe(false);
  });

  it("判断の答えを待っている子（waiting）は、待つと決まっている", () => {
    const s = must([
      ...base(),
      ev(
        {
          type: "decision.requested",
          payload: { decisionId: "d1", nodeId: "a", question: "q", options: ["x"] },
        },
        T1,
      ),
    ]);
    expect(awaitingHuman(s, "a")).toBe(true);
    expect(intentionallyIdle(s, "a")).toBe(true);
  });
});
