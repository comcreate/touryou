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

  it("指示は、送っただけでは動きに数えない。子が受け取った時刻から数える（#201）", () => {
    const sent = [
      ...base(),
      byHuman(
        ev({ type: "node.instructed", payload: { nodeId: "a", text: "x" } }, iso(T0 + 35 * MIN)),
      ),
    ];
    expect(watchFindings(must(sent), T0 + 40 * MIN, SPEC).stalled.map((x) => x.nodeId)).toEqual([
      "a",
    ]);
    const delivered = must([
      ...sent,
      ev({ type: "node.instructionDelivered", payload: { instructedSeq: n } }, iso(T0 + 36 * MIN)),
    ]);
    expect(watchFindings(delivered, T0 + 40 * MIN, SPEC).stalled).toEqual([]);
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

  it("指示を子が受け取ったあとに、残っていた「止まっているかも」の知らせを片付ける（送っただけでは片付けない）", () => {
    // seq は、base() の番号と重ならないよう、はっきり決める
    const stalled: OrchEvent = {
      ...ev(
        {
          type: "inbox.added",
          payload: { id: "i1", kind: "info", nodeId: "a", summary: stallSummary("a", 30) },
        } as never,
        iso(T0 + 31 * MIN),
      ),
      seq: 500,
    };
    const instructed: OrchEvent = {
      ...byHuman(
        ev({ type: "node.instructed", payload: { nodeId: "a", text: "x" } }, iso(T0 + 33 * MIN)),
      ),
      seq: 501,
    };
    const delivered: OrchEvent = {
      ...ev(
        { type: "node.instructionDelivered", payload: { instructedSeq: 501 } },
        iso(T0 + 33.5 * MIN),
      ),
      seq: 502,
    };
    const before = must([...base(), stalled]);
    expect(watchFindings(before, T0 + 32 * MIN, SPEC).resolvedStalls ?? []).toEqual([]);
    const sent = [...base(), stalled, instructed];
    expect(watchFindings(must(sent), T0 + 34 * MIN, SPEC).resolvedStalls ?? []).toEqual([]);
    const after = must([...sent, delivered]);
    expect(watchFindings(after, T0 + 34 * MIN, SPEC).resolvedStalls).toEqual(["i1"]);
  });
});
