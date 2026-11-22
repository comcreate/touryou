import { describe, expect, it } from "vitest";
import {
  awaitingHuman,
  type EventBody,
  foldEvents,
  intentionallyIdle,
  lastActivityAt,
  lastActivityByNode,
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

const HUMAN = { human: true } as const;
const T3 = "2026-10-20T03:00:00.000Z";
const withActor = (e: OrchEvent, actor: OrchEvent["actor"]): OrchEvent => ({ ...e, actor });

describe("lastActivityMs（#195。見張りと画面の共通の数え方）", () => {
  it("人・親の指示は、送った時刻を数えず、子が受け取った時刻だけ数える（#201）", () => {
    const sent = [
      ...base(),
      withActor(ev({ type: "node.instructed", payload: { nodeId: "a", text: "x" } }, T2), HUMAN),
    ];
    expect(lastActivityMs(must(sent), "a")).toBe(0);
    const delivered = must([
      ...sent,
      ev({ type: "node.instructionDelivered", payload: { instructedSeq: n } }, T3),
    ]);
    expect(lastActivityMs(delivered, "a")).toBe(Date.parse(T3));
  });

  it("daemon が自動で送る指示（actor が system）は、送った時刻を数えず、受け取った時刻だけ数える", () => {
    const sent = [
      ...base(),
      ev({ type: "node.instructed", payload: { nodeId: "a", text: "wake" } }, T2),
    ];
    expect(lastActivityMs(must(sent), "a")).toBe(0);
    const delivered = must([
      ...sent,
      ev({ type: "node.instructionDelivered", payload: { instructedSeq: n } }, T3),
    ]);
    expect(lastActivityMs(delivered, "a")).toBe(Date.parse(T3));
  });

  it("前置きの指示（tokenIdleSoon）は、送った時刻を数えず、受け取った時刻だけ数える", () => {
    const sent = [
      ...base(),
      withActor(
        ev(
          { type: "node.instructed", payload: { nodeId: "a", text: "p", kind: "tokenIdleSoon" } },
          T2,
        ),
        HUMAN,
      ),
    ];
    expect(lastActivityMs(must(sent), "a")).toBe(0);
    const delivered = must([
      ...sent,
      ev({ type: "node.instructionDelivered", payload: { instructedSeq: n } }, T3),
    ]);
    expect(lastActivityMs(delivered, "a")).toBe(Date.parse(T3));
  });

  it("受信箱の項目は、動きに数えない", () => {
    const s = must([
      ...base(),
      ev(
        { type: "inbox.added", payload: { id: "i1", kind: "info", nodeId: "a", summary: "x" } },
        T2,
      ),
    ]);
    expect(lastActivityMs(s, "a")).toBe(0);
    expect(lastActivityAt(s, "a")).toBeUndefined();
  });

  it("範囲の頼みの判定の時刻（decidedAt）を、動きに数える", () => {
    const s = must([
      ...base(),
      ev(
        {
          type: "scope.extensionRequested",
          payload: {
            extensionId: "x1",
            nodeId: "a",
            target: { kind: "write", value: "docs" },
            reason: "r",
          },
        },
        T1,
      ),
      ev(
        { type: "scope.extensionDecided", payload: { extensionId: "x1", decision: "reject" } },
        T3,
      ),
    ]);
    expect(lastActivityMs(s, "a")).toBe(Date.parse(T3));
    expect(lastActivityAt(s, "a")).toBe(T3);
  });

  it("壊れた時刻は、lastActivityMs も lastActivityAt も数えない（食い違わない）", () => {
    const s = must([
      ...base(),
      ev({ type: "node.toolDenied", payload: { nodeId: "a", tool: "t" } }, T1),
    ]);
    const broken: OrchState = {
      ...s,
      toolDenials: [
        ...s.toolDenials,
        { seq: 999, at: "not-a-time", nodeId: "a", tool: "t", actor: SYS },
      ],
    };
    expect(lastActivityMs(broken, "a")).toBe(Date.parse(T1));
    expect(lastActivityAt(broken, "a")).toBe(T1);
    // 壊れた時刻だけのノードは、動きの記録がないのと同じ
    const onlyBroken: OrchState = {
      ...s,
      toolDenials: [{ seq: 999, at: "not-a-time", nodeId: "a", tool: "t", actor: SYS }],
    };
    expect(lastActivityMs(onlyBroken, "a")).toBe(0);
    expect(lastActivityAt(onlyBroken, "a")).toBeUndefined();
  });

  it("lastActivityByNode は、1 回の走査でノードごとの値を出し、1 ノードずつの値と同じ", () => {
    const s = must([
      ...base(),
      ev({ type: "node.toolDenied", payload: { nodeId: "a", tool: "t" } }, T1),
      ev({ type: "node.toolDenied", payload: { nodeId: "root", tool: "t" } }, T2),
    ]);
    const all = lastActivityByNode(s);
    expect(all.get("a")).toBe(lastActivityAt(s, "a"));
    expect(all.get("root")).toBe(lastActivityAt(s, "root"));
  });

  it("フックの時刻（extraMs）のほうが新しければ、それを返す", () => {
    const s = must(base());
    expect(lastActivityMs(s, "a", Date.parse(T1))).toBe(Date.parse(T1));
  });

  it("画面の lastActivityAt は、同じ関数の値", () => {
    const s = must([
      ...base(),
      ev({ type: "node.toolDenied", payload: { nodeId: "a", tool: "t" } }, T2),
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
