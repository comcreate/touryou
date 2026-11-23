/**
 * 復唱が返らない指示（#261）の見張り。手書きの状態で `watchFindings` を確かめ（cli-watch-adopted.test.ts と同じ作り方）、
 * 本物のログで `recordWatchFindings` の出し方（指示ごとに 1 回・解決）を確かめる。
 */
import type { EventBody, OrchState } from "@touryou/core";
import { describe, expect, it } from "vitest";
import {
  type BindLostProbe,
  recordWatchFindings,
  type WatchFindings,
  type WatchSpec,
  watchFindings,
} from "../src/cli-watch.js";
import { EventLog } from "../src/eventlog.js";
import { createMemoryStore } from "../src/memory-store.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-24T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const SPEC: WatchSpec = {
  stallMs: 600 * MIN,
  unreadMs: 30 * MIN,
  unboundMs: 600 * MIN,
  unsubscribedMs: 600 * MIN,
  echoMs: 5 * MIN,
};
const probe: BindLostProbe = { absentSinceMs: () => undefined, hasValidBindToken: () => true };

type Ins = { seq: number; deliveredSeq?: number; echo?: string; kind?: string };

const stateWith = (instructions: Ins[]): OrchState =>
  ({
    nodes: [{ id: "a", state: "running", runtime: "cli", adopted: { at: iso(T0) } }],
    parentRequests: [],
    instructions: instructions.map((i) => ({ nodeId: "a", at: iso(T0), text: "x", ...i })),
    reports: [{ nodeId: "a", at: iso(T0) }],
    violations: [],
    toolDenials: [],
    decisions: [],
    extensions: [],
    inbox: [],
  }) as unknown as OrchState;

const find = (state: OrchState, afterMin: number, spec: WatchSpec = SPEC) =>
  watchFindings(
    state,
    T0 + afterMin * MIN,
    { ...spec, sinceMs: T0 - MIN },
    undefined,
    () => true,
    probe,
  );

describe("watchFindings: 復唱が返らない指示（#261）", () => {
  it("配送済みで復唱がない指示は、echoMs を超えると unechoed に入る。echoMs の前は入らない", () => {
    const s = stateWith([{ seq: 5, deliveredSeq: 6 }]);
    expect(find(s, 4).unechoed).toEqual([]);
    expect(find(s, 6).unechoed).toEqual([{ nodeId: "a", seq: 5 }]);
  });

  it("復唱がある指示は入らない", () => {
    const s = stateWith([{ seq: 5, deliveredSeq: 6, echo: "ba7816bf8f01cfea" }]);
    expect(find(s, 60).unechoed).toEqual([]);
  });

  it("統合: echoMs が unreadMs 以下なら、受け取られていない指示は unechoed だけに入り、unread には入らない", () => {
    const s = stateWith([{ seq: 5 }]);
    const f = find(s, 40);
    expect(f.unechoed).toEqual([{ nodeId: "a", seq: 5 }]);
    expect(f.unread).toEqual([]);
  });

  it("echoMs が unreadMs より長いときは、受け取られていない指示は、これまでどおり unread だけに入る", () => {
    const spec = { ...SPEC, echoMs: 60 * MIN };
    const s = stateWith([{ seq: 5 }]);
    const f = find(s, 40, spec);
    expect(f.unread).toEqual([{ nodeId: "a", seq: 5 }]);
    expect(f.unechoed).toEqual([]);
  });

  it("echoMs がなければ（設定の対象外）、unechoed は空", () => {
    const { echoMs: _omit, ...spec } = SPEC;
    expect(find(stateWith([{ seq: 5, deliveredSeq: 6 }]), 60, spec).unechoed).toEqual([]);
  });

  it("daemon の前置きの指示は、対象にしない", () => {
    const s = stateWith([{ seq: 5, deliveredSeq: 6, kind: "tokenIdleSoon" }]);
    expect(find(s, 60).unechoed).toEqual([]);
  });
});

describe("recordWatchFindings: 復唱が返らない知らせ（#261）", () => {
  const open = () => {
    const o = EventLog.open(createMemoryStore().open(), { clock: () => iso(T0) });
    if (!o.ok) throw new Error(o.error.code);
    const log = o.value;
    let n = 0;
    const add = (body: EventBody) => {
      const r = log.append({ requestId: `s${++n}`, actor: { system: true }, body });
      if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
      return r.value.event.seq;
    };
    add({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    });
    add({
      type: "node.stateChanged",
      payload: { nodeId: "root", event: { type: "start" } },
    });
    add({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
    });
    return { log, add };
  };
  const none: WatchFindings = {
    stalled: [],
    unread: [],
    unbound: [],
    unsubscribed: [],
    resolvedUnsubscribed: [],
    resolvedStalls: [],
  };
  const clock = () => iso(T0 + 10 * MIN);

  it("指示ごとに 1 回だけ出す（付け直しても重ならない）。本文・ハッシュ値・内部の道具名は出さない", () => {
    const { log } = open();
    const f: WatchFindings = { ...none, unechoed: [{ nodeId: "a", seq: 5 }] };
    expect(recordWatchFindings(log, clock, f, SPEC)).toBe(1);
    expect(recordWatchFindings(log, clock, f, SPEC)).toBe(0);
    const items = log.state().inbox.filter((i) => i.msg?.key === "echoMissing");
    expect(items).toHaveLength(1);
    expect(items[0]?.msg?.args).toEqual({ node: "a", seq: 5, minutes: 5 });
    expect([...(items[0]?.summary ?? "")].length).toBeLessThanOrEqual(200);
    expect(items[0]?.summary).not.toContain("ackThrough");
  });

  it("復唱が届いたら、resolvedEchoMissing の ID で解決済みになる", () => {
    const { log } = open();
    recordWatchFindings(log, clock, { ...none, unechoed: [{ nodeId: "a", seq: 5 }] }, SPEC);
    const item = log.state().inbox.find((i) => i.msg?.key === "echoMissing");
    expect(item?.resolved).toBeUndefined();
    recordWatchFindings(log, clock, { ...none, resolvedEchoMissing: [item?.id ?? ""] }, SPEC);
    expect(log.state().inbox.find((i) => i.msg?.key === "echoMissing")?.resolved).toBeDefined();
  });
});

describe("watchFindings: 復唱が返らない知らせの片付け（#261）", () => {
  const withItem = (instruction: Ins | undefined, nodeState = "running"): OrchState => {
    const s = stateWith(instruction === undefined ? [] : [instruction]) as unknown as {
      nodes: { state: string }[];
      inbox: unknown[];
    };
    s.nodes[0]!.state = nodeState;
    s.inbox = [
      {
        id: "i1",
        kind: "info",
        nodeId: "a",
        summary: "s",
        at: iso(T0),
        msg: { key: "echoMissing", args: { node: "a", seq: 5, minutes: 5 } },
      },
    ];
    return s as unknown as OrchState;
  };

  it("復唱が届いた・指示が消えた・子が動いていないときは解決する。まだ届かず子が動いているときは残す", () => {
    expect(
      find(withItem({ seq: 5, deliveredSeq: 6, echo: "ba7816bf8f01cfea" }), 6).resolvedEchoMissing,
    ).toEqual(["i1"]);
    expect(find(withItem(undefined), 6).resolvedEchoMissing).toEqual(["i1"]);
    expect(find(withItem({ seq: 5, deliveredSeq: 6 }, "done"), 6).resolvedEchoMissing).toEqual([
      "i1",
    ]);
    expect(find(withItem({ seq: 5, deliveredSeq: 6 }), 6).resolvedEchoMissing).toEqual([]);
  });
});
