/**
 * 採用した子（`node.adopted`）を、起動の報告がなくても見張りの対象にし、Desktop の子は対象にしない（#159）。
 * 手書きの状態で `watchFindings` を確かめる（cli-watch-unsubscribed.test.ts と同じ作り方）。
 */
import type { OrchState } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { type BindLostProbe, type WatchSpec, watchFindings } from "../src/cli-watch.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-20T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const SPEC: WatchSpec = {
  stallMs: 30 * MIN,
  unreadMs: 600 * MIN,
  unboundMs: 10 * MIN,
  unsubscribedMs: 15 * MIN,
};
// 子が動いた記録（最後の動き）は T0 に 1 件
const report = { nodeId: "a", at: iso(T0) };

interface NodeOver {
  runtime?: "cli" | "desktop";
  adopted?: { at: string };
}

const stateWith = (over: NodeOver, launch = false): OrchState =>
  ({
    nodes: [{ id: "a", state: "running", ...over }],
    parentRequests: launch
      ? [{ nodeId: "a", kind: "launch", report: { outcome: "done", at: iso(T0) } }]
      : [],
    instructions: [],
    reports: [report],
    violations: [],
    toolDenials: [],
    decisions: [],
    extensions: [],
    inbox: [],
  }) as unknown as OrchState;

const ADOPTED = { runtime: "cli", adopted: { at: iso(T0) } } as const;
const probe: BindLostProbe = { absentSinceMs: () => T0, hasValidBindToken: () => true };
const find = (state: OrchState, afterMin: number) =>
  watchFindings(state, T0 + afterMin * MIN, { ...SPEC, sinceMs: T0 - MIN }, undefined, () => false, probe);

describe("watchFindings: 採用した子（起動の報告なし。#159）", () => {
  it("止まっているかも: 最後の動きから stallMs を超えると出る", () => {
    const s = stateWith(ADOPTED);
    expect(find(s, 29).stalled).toEqual([]);
    expect(find(s, 31).stalled).toEqual([{ nodeId: "a", lastMs: T0 }]);
  });

  it("紐付けていない: 採用の記録の時刻から unboundMs を超え、紐付けがなければ出る", () => {
    const s = stateWith(ADOPTED);
    expect(find(s, 9).unbound).toEqual([]);
    expect(find(s, 11).unbound).toEqual([{ nodeId: "a" }]);
  });

  it("紐付けていない: 採用が daemon の起動より前の子は出さない（紐付けたか分からない）", () => {
    const s = stateWith({ runtime: "cli", adopted: { at: iso(T0 - 5 * MIN) } });
    expect(find(s, 11).unbound).toEqual([]);
  });

  it("紐付けが外れているかも: 購読がない状態が続けば出る", () => {
    const s = stateWith(ADOPTED);
    expect(find(s, 14).unsubscribed).toEqual([]);
    expect(find(s, 16).unsubscribed).toEqual([{ nodeId: "a", sinceMs: T0 }]);
  });

  it("Desktop の子（採用でも起動の報告でも）には、どの知らせも出さない", () => {
    for (const s of [
      stateWith({ runtime: "desktop", adopted: { at: iso(T0) } }),
      stateWith({ runtime: "desktop" }),
      stateWith({ runtime: "desktop" }, true),
    ]) {
      const f = find(s, 120);
      expect(f.stalled).toEqual([]);
      expect(f.unbound).toEqual([]);
      expect(f.unsubscribed).toEqual([]);
    }
  });

  it("runtime のない古い採用の記録は、対象にしない（推し量らない）", () => {
    const f = find(stateWith({ adopted: { at: iso(T0) } }), 120);
    expect(f.stalled).toEqual([]);
    expect(f.unbound).toEqual([]);
  });

  it("既存の子: 起動の報告がある CLI の子は、これまでどおり対象。報告のない（採用でもない）子は対象外", () => {
    const launched = find(stateWith({}, true), 120);
    expect(launched.stalled).toHaveLength(1);
    expect(launched.unbound).toEqual([{ nodeId: "a" }]);
    const unreported = find(stateWith({ runtime: "cli" }), 120);
    expect(unreported.stalled).toEqual([]);
    expect(unreported.unbound).toEqual([]);
  });
});
