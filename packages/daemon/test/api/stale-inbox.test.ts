/**
 * 受理・回収・archive のあとに残る、古い停止未完了・失敗の項目の解決（案 A+B）。
 * - 受理（node.review accept）で、その子の未解決の stopIncomplete・failure を inbox.resolved（system）で解決にする。
 * - 起動時の整合で、既存の記録を追記だけで 1 回だけ解決にする（2 回目は何も足さない）。
 * - 受理後のノードの停止の報告で、プロセスが残っていても stopIncomplete を作らず info にする。
 */
import type { EventBody, InboxKind, NodeEvent, ProcessInfo } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createParentRequestHandlers } from "../../src/api/handlers/parent-request-handlers.js";
import { createStateHandlers } from "../../src/api/handlers/state-handlers.js";
import type { HandlerRequest } from "../../src/api/server.js";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";
import { reconcileOnStartup } from "../../src/reconcile.js";

const T0 = "2026-11-14T00:00:00.000Z";
let n = 0;

const rig = (nodes: Record<string, NodeEvent["type"][]>) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock: () => T0 });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  add({
    type: "node.stateChanged",
    payload: { nodeId: "root", event: { type: "start" } },
  });
  for (const [id, events] of Object.entries(nodes)) {
    add({
      type: "node.created",
      payload: { nodeId: id, role: "implement", parentId: "root", dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: id, event: { type: "start" } } });
    for (const type of events) {
      add({ type: "node.stateChanged", payload: { nodeId: id, event: { type } as NodeEvent } });
    }
  }
  const item = (nodeId: string, kind: InboxKind) =>
    add({
      type: "inbox.added",
      payload: { id: `${kind}-${nodeId}`, kind, nodeId, summary: `${kind} ${nodeId}` },
    });
  const unresolved = (nodeId: string): string[] =>
    log
      .state()
      .inbox.filter((i) => i.nodeId === nodeId && i.resolved === undefined)
      .map((i) => i.id)
      .sort();
  return { log, item, add, unresolved };
};

const review = (log: EventLog, nodeId: string) =>
  createStateHandlers({ log, clock: () => T0 })["node.review"]({
    requestId: `q-${++n}`,
    operation: "node.review",
    role: "integrator",
    caller: { nodeId: "root" },
    params: { nodeId, verdict: "accept" },
  } as unknown as HandlerRequest<"node.review">);

describe("受理で、古い停止未完了・失敗の項目を解決にする（A2）", () => {
  it("受理した子の未解決の stopIncomplete・failure が解決になる。system の記録で、info は残す", async () => {
    const r = rig({ a: ["reportDone"], b: [] });
    r.item("a", "stopIncomplete");
    r.item("a", "failure");
    r.item("a", "info");
    r.item("b", "failure");
    const res = await review(r.log, "a");
    expect(res.ok).toBe(true);
    expect(r.unresolved("a")).toContain("info-a");
    expect(r.unresolved("a")).not.toContain("stopIncomplete-a");
    expect(r.unresolved("a")).not.toContain("failure-a");
    const resolved = r.log.state().inbox.find((i) => i.id === "failure-a")?.resolved;
    expect(resolved?.by).toEqual({ system: true });
    // 回帰: 受理していない（running の）子の項目は解決にしない
    expect(r.unresolved("b")).toEqual(["failure-b"]);
  });
});

describe("起動時の整合で、古い項目を 1 回だけ追記で解決にする（A3）", () => {
  const run = (log: EventLog) =>
    reconcileOnStartup({
      log,
      clock: () => T0,
      cwdOf: async (id) => `/wt/${id}`,
      probe: async () => [],
    });

  it("verified・reclaimable・archived の古い項目だけ解決にし、running の項目は残す。2 回目は何も足さない", async () => {
    const r = rig({
      v: ["reportDone", "accept"],
      c: ["reportDone", "accept", "markReclaimable"],
      z: ["reportDone", "accept", "markReclaimable", "archive"],
      s: [],
    });
    for (const id of ["v", "c", "z", "s"]) r.item(id, "failure");
    r.item("v", "stopIncomplete");
    // running の s は、reconcile 自身が失敗を足す（プロセスなし）ので、その前の項目 id で見る
    await run(r.log);
    expect(r.unresolved("v")).toEqual([]);
    expect(r.unresolved("c")).toEqual([]);
    expect(r.unresolved("z")).toEqual([]);
    expect(r.unresolved("s")).toContain("failure-s");
    const before = r.log.state().lastSeq;
    const eventsBefore = r.log.state().inbox.map((i) => ({ ...i }));
    await run(r.log);
    expect(r.log.state().lastSeq).toBe(before);
    expect(r.log.state().inbox.map((i) => ({ ...i }))).toEqual(eventsBefore);
  });
});

describe("受理後のノードの停止の報告で、stopIncomplete を作らない（B）", () => {
  it("プロセスが残っていても、受理後（verified）は info にする", async () => {
    const r = rig({ a: ["reportDone"] });
    r.add({
      type: "node.parentRequested",
      payload: { nodeId: "a", requestRef: "preq-launch", kind: "launch", worktree: "/w/a" },
    });
    r.add({
      type: "node.parentReported",
      payload: { nodeId: "a", requestRef: "preq-launch", outcome: "done", sessionRef: "sess-a" },
    });
    await review(r.log, "a");
    const busy: ProcessInfo[] = [{ pid: 42, cwd: "/w/a", hasOpenFiles: true, command: "claude" }];
    const parent = createParentRequestHandlers({
      log: r.log,
      clock: () => T0,
      probe: async () => busy,
    });
    const open = [...r.log.state().parentRequests].reverse().find((x) => x.report === undefined);
    const res = await parent["parent.report"]({
      requestId: `q-${++n}`,
      operation: "parent.report",
      role: "integrator",
      caller: { nodeId: "root" },
      params: { nodeId: "a", requestRef: open?.requestRef, outcome: "done" },
    } as unknown as HandlerRequest<"parent.report">);
    expect(res.ok).toBe(true);
    const items = r.log.state().inbox.filter((i) => i.nodeId === "a");
    expect(items.some((i) => i.kind === "stopIncomplete")).toBe(false);
    expect(r.log.state().nodes.find((x) => x.id === "a")?.state).toBe("verified");
  });
});
