/**
 * 紐付けの期限の前置き（`kind: "tokenIdleSoon"` の追加指示。#189）は、子が読まなくても構わない daemon の知らせなので、
 * cli-watch の「読まれていない指示」にしない。ふつうの指示は、今までどおり出す。
 */
import type { OrchState } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { watchFindings } from "../src/cli-watch.js";

const T0 = Date.parse("2026-10-20T00:00:00.000Z");
const MIN = 60_000;

const stateWith = (instructions: unknown[]): OrchState =>
  ({
    nodes: [{ id: "a", state: "running" }],
    parentRequests: [
      {
        nodeId: "a",
        kind: "launch",
        report: { outcome: "done", at: new Date(T0).toISOString() },
      },
    ],
    instructions,
    reports: [],
    violations: [],
    toolDenials: [],
    decisions: [],
    extensions: [],
    inbox: [],
  }) as unknown as OrchState;

const instruction = (seq: number, kind?: string) => ({
  seq,
  at: new Date(T0).toISOString(),
  nodeId: "a",
  text: "指示",
  actor: { system: true },
  ...(kind === undefined ? {} : { kind }),
});

describe("読まれていない指示（cli-watch）と前置きの指示（#189）", () => {
  it("前置き（tokenIdleSoon）は、読まれないまま時間を超えても、読まれていない指示にならない。ふつうの指示はなる", () => {
    const spec = { stallMs: 30 * MIN, unreadMs: 30 * MIN };
    const f = watchFindings(
      stateWith([instruction(1, "tokenIdleSoon"), instruction(2), instruction(3, "answer")]),
      T0 + 31 * MIN,
      spec,
    );
    expect(f.unread).toEqual([
      { nodeId: "a", seq: 2 },
      { nodeId: "a", seq: 3 },
    ]);
  });
});
