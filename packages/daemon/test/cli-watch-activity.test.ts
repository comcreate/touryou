// #195: 見張り（watchFindings）の「止まっているかも」が、画面と同じ数え方（core の lastActivityMs）を使うこと。
import {
  type EventBody,
  foldEvents,
  type OrchEvent,
  type OrchState,
  stallSummary,
} from "@touryou/core";
import { describe, expect, it } from "vitest";
import { watchFindings } from "../src/cli-watch.js";

const SYS = { system: true } as const;
let n = 0;
const ev = (body: EventBody, at: string): OrchEvent =>
  ({ seq: ++n, at, requestId: `r${n}`, actor: SYS, ...body }) as OrchEvent;
/** 人・親が送った指示（daemon が自動で送る指示は、送った時刻を動きに数えない）。 */
const byHuman = (e: OrchEvent): OrchEvent => ({ ...e, actor: { human: true } });
const must = (events: OrchEvent[]): OrchState => {
  const r = foldEvents(events);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};
const MIN = 60_000;
const T0 = Date.parse("2026-10-20T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const SPEC = { stallMs: 30 * MIN, unreadMs: 30 * MIN };

/** 親が起動を報告した、動いている CLI の子 a（T0 から動きなし）。 */
const base = (): OrchEvent[] => {
  n = 0;
  return [
    ev(
      {
        type: "node.created",
        payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
      },
      iso(T0),
    ),
    ev(
      { type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } },
      iso(T0),
    ),
    ev(
      {
        type: "node.created",
        payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
      },
      iso(T0),
    ),
    ev({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } }, iso(T0)),
    ev(
      {
        type: "node.parentRequested",
        payload: { nodeId: "a", requestRef: "q1", kind: "launch", worktree: "/w/a" },
      } as never,
      iso(T0),
    ),
    ev(
      {
        type: "node.parentReported",
        payload: { nodeId: "a", requestRef: "q1", outcome: "done" },
      } as never,
      iso(T0),
    ),
  ];
};

describe("watchFindings の止まっているかも（#195）", () => {
  it("動きがないまま stallMs を超えた子は出す（基準の確認）", () => {
    const f = watchFindings(must(base()), T0 + 40 * MIN, SPEC);
    expect(f.stalled.map((x) => x.nodeId)).toEqual(["a"]);
  });

  it("指示を送った時刻も動きに数える（受け取る前でも、送った直後は出さない）", () => {
    const s = must([
      ...base(),
      byHuman(
        ev({ type: "node.instructed", payload: { nodeId: "a", text: "x" } }, iso(T0 + 35 * MIN)),
      ),
    ]);
    expect(watchFindings(s, T0 + 40 * MIN, SPEC).stalled).toEqual([]);
  });

  it("判断の答えを待っている子（waiting）は出さない", () => {
    const s = must([
      ...base(),
      ev(
        {
          type: "decision.requested",
          payload: { decisionId: "d1", nodeId: "a", question: "q", options: ["x"] },
        },
        iso(T0),
      ),
    ]);
    expect(watchFindings(s, T0 + 90 * MIN, SPEC).stalled).toEqual([]);
  });

  it("送った指示のあとに、残っていた「止まっているかも」の知らせを片付ける", () => {
    const stalled = ev(
      {
        type: "inbox.added",
        payload: { id: "i1", kind: "info", nodeId: "a", summary: stallSummary("a", 30) },
      } as never,
      iso(T0 + 31 * MIN),
    );
    const before = must([...base(), stalled]);
    expect(watchFindings(before, T0 + 32 * MIN, SPEC).resolvedStalls ?? []).toEqual([]);
    const after = must([
      ...base(),
      stalled,
      byHuman(
        ev({ type: "node.instructed", payload: { nodeId: "a", text: "x" } }, iso(T0 + 33 * MIN)),
      ),
    ]);
    expect(watchFindings(after, T0 + 34 * MIN, SPEC).resolvedStalls).toEqual(["i1"]);
  });
});
