/**
 * 受理・回収・archive のあとに残る、古い停止未完了・失敗の項目の解決（案 A+B）。
 * - 受理（node.review accept）で、その子の未解決の stopIncomplete・failure を inbox.resolved（system）で解決にする。
 * - 起動時の整合で、既存の記録を追記だけで 1 回だけ解決にする（2 回目は何も足さない）。
 * - 受理後のノードの停止の報告で、プロセスが残るときは stopIncomplete にする。
 * - 差し戻し（reject）では、項目を解決にしない。
 */
import type { EventBody, InboxKind, NodeEvent, ProcessInfo } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createParentRequestHandlers } from "../../src/api/handlers/parent-request-handlers.js";
import { createStateHandlers } from "../../src/api/handlers/state-handlers.js";
import type { HandlerRequest } from "../../src/api/server.js";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";
import { EXTERNAL_CHECK_SUMMARY, reconcileOnStartup } from "../../src/reconcile.js";

const T0 = "2026-11-14T00:00:00.000Z";

const DONE: NodeEvent = { type: "reportDone" };
const ACCEPT: NodeEvent = { type: "accept" };
const RECLAIMABLE: NodeEvent = { type: "markReclaimable", discarded: false };
const ARCHIVE: NodeEvent = { type: "archive" };
const WAIT: NodeEvent = { type: "requestDecision" };
const STOP: NodeEvent = { type: "stop", mode: "immediate" };
const STOP_TIMEOUT: NodeEvent = { type: "stopTimeout" };

const rig = (nodes: Record<string, NodeEvent[]>) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock: () => T0 });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  // 種の requestId は、この rig だけの連番（テストの並びや、ほかの rig に依存しない）。
  let seed = 0;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `seed-${++seed}`, actor: { system: true }, body });
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
    for (const event of events) {
      add({ type: "node.stateChanged", payload: { nodeId: id, event } });
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
    requestId: `review-${nodeId}`,
    operation: "node.review",
    role: "integrator",
    caller: { nodeId: "root" },
    params: { nodeId, verdict: "accept" },
  } as unknown as HandlerRequest<"node.review">);

describe("受理で、古い停止未完了・失敗の項目を解決にする（A2）", () => {
  it("受理した子の未解決の stopIncomplete・failure が解決になる。system の記録で、info は残す", async () => {
    const r = rig({ a: [DONE], b: [] });
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
  const run = (log: EventLog, failures: string[] = []) =>
    reconcileOnStartup({
      log,
      clock: () => T0,
      cwdOf: async (id) => `/wt/${id}`,
      probe: async () => [],
      onFailure: (id, cause) => void failures.push(`${id}: ${cause}`),
    });

  it("verified・reclaimable・archived の古い項目だけ解決にし、running の項目は残す。2 回目は何も足さない", async () => {
    const r = rig({
      v: [DONE, ACCEPT],
      c: [DONE, ACCEPT, RECLAIMABLE],
      z: [DONE, ACCEPT, RECLAIMABLE, ARCHIVE],
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

  it("まだ対処が要るノード（stopping・waiting・stopIncomplete）の項目は、整合のあとも解決にしない。受理済みの子の項目だけ解決にする", async () => {
    const r = rig({ v: [DONE, ACCEPT], w: [WAIT], s: [STOP], i: [STOP, STOP_TIMEOUT] });
    for (const id of ["v", "w", "s", "i"]) {
      r.item(id, "failure");
      r.item(id, "stopIncomplete");
    }
    // v 以外は、作業ツリーにプロセスが残っている（停止未完了のまま、記録の状態は settled にならない）
    const busy = (cwd: string): ProcessInfo[] => [{ pid: 7, cwd, hasOpenFiles: true }];
    const failures: string[] = [];
    await reconcileOnStartup({
      log: r.log,
      clock: () => T0,
      cwdOf: async (id) => `/wt/${id}`,
      probe: async (cwd) => (cwd === "/wt/v" ? [] : busy(cwd)),
      onFailure: (id, cause) => void failures.push(`${id}: ${cause}`),
    });
    expect(failures).toEqual([]);
    expect(r.unresolved("v")).toEqual([]);
    for (const id of ["w", "s", "i"]) {
      expect(r.unresolved(id), id).toEqual(expect.arrayContaining([`failure-${id}`]));
      expect(r.unresolved(id), id).toEqual(expect.arrayContaining([`stopIncomplete-${id}`]));
    }
  });

  it("直前の外部確認の解決と重なる項目（受理済みの子にある未解決の外部確認の依頼）があっても、失敗せず、ほかの古い項目も解決にする。先に解決した記録が残る", async () => {
    const r = rig({ v: [DONE, ACCEPT], a: [] });
    r.add({
      type: "inbox.added",
      payload: {
        id: "ext-v",
        kind: "stopIncomplete",
        nodeId: "v",
        summary: `${EXTERNAL_CHECK_SUMMARY}（1 件: a）`,
      },
    });
    r.item("v", "failure");
    const failures: string[] = [];
    await run(r.log, failures);
    // 外部確認の解決（start の stale）と、古い項目の解決（start のスナップショットから選ぶ）が同じ項目を指しても、
    // 二度目の解決は最初の記録を残すだけで、追記の全体は失敗しない。
    expect(failures).toEqual([]);
    const item = (id: string) => r.log.state().inbox.find((i) => i.id === id);
    expect(item("ext-v")?.resolved?.by).toEqual({ system: true });
    expect(item("failure-v")?.resolved?.by).toEqual({ system: true });
    expect(item("ext-v")?.resolved?.seq ?? Number.POSITIVE_INFINITY).toBeLessThan(
      item("failure-v")?.resolved?.seq ?? 0,
    );
    // 2 回目は何も足さない（冪等）
    const before = r.log.state().lastSeq;
    await run(r.log, failures);
    expect(r.log.state().lastSeq).toBe(before);
  });
});

describe("差し戻しでは、古い項目を解決にしない", () => {
  it("reject した子の未解決の stopIncomplete・failure は残る", async () => {
    const r = rig({ a: [DONE] });
    r.item("a", "stopIncomplete");
    r.item("a", "failure");
    const res = await createStateHandlers({ log: r.log, clock: () => T0 })["node.review"]({
      requestId: "review-reject-a",
      operation: "node.review",
      role: "integrator",
      caller: { nodeId: "root" },
      params: { nodeId: "a", verdict: "reject", feedback: "直してください" },
    } as unknown as HandlerRequest<"node.review">);
    expect(res.ok).toBe(true);
    expect(r.unresolved("a")).toEqual(["failure-a", "stopIncomplete-a"]);
  });
});

describe("受理後のノードの停止の報告で、プロセスが残るときは stopIncomplete にする（B）", () => {
  it("プロセスが残っていれば、受理後（verified）でも stopIncomplete にする", async () => {
    const r = rig({ a: [DONE] });
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
      requestId: "report-stop-a",
      operation: "parent.report",
      role: "integrator",
      caller: { nodeId: "root" },
      params: { nodeId: "a", requestRef: open?.requestRef, outcome: "done" },
    } as unknown as HandlerRequest<"parent.report">);
    expect(res.ok).toBe(true);
    const items = r.log.state().inbox.filter((i) => i.nodeId === "a");
    expect(items.some((i) => i.kind === "stopIncomplete")).toBe(true);
    expect(r.log.state().nodes.find((x) => x.id === "a")?.state).toBe("verified");
  });

  // 受理後（reclaimable・archived）の子への、停止の「止めた」の報告。残っているプロセスがない・確かめられない（left === null）なら、
  // 対処は要らないので info にとどめる。残っていれば stopIncomplete。
  describe.each([
    ["reclaimable", [DONE, ACCEPT, RECLAIMABLE]],
    ["archived", [DONE, ACCEPT, RECLAIMABLE, ARCHIVE]],
  ] as const)("%s のノード", (state, events) => {
    /** `probe` が undefined のときは、プロセスを確かめられない（left === null）。 */
    const report = async (probe?: () => Promise<ProcessInfo[]>) => {
      // 受理までの記録のあとで、停止の依頼を足す（受理で出る依頼とは別に、この依頼だけを報告する）
      const r = rig({ a: [DONE, ACCEPT] });
      r.add({
        type: "node.parentRequested",
        payload: { nodeId: "a", requestRef: "preq-stop", kind: "stop", worktree: "/w/a" },
      });
      for (const event of events.slice(2)) {
        r.add({ type: "node.stateChanged", payload: { nodeId: "a", event } });
      }
      expect(r.log.state().nodes.find((x) => x.id === "a")?.state).toBe(state);
      const parent = createParentRequestHandlers({
        log: r.log,
        clock: () => T0,
        ...(probe === undefined ? {} : { probe }),
      });
      const res = await parent["parent.report"]({
        requestId: "report-stop-a",
        operation: "parent.report",
        role: "integrator",
        caller: { nodeId: "root" },
        params: { nodeId: "a", requestRef: "preq-stop", outcome: "done" },
      } as unknown as HandlerRequest<"parent.report">);
      expect(res.ok).toBe(true);
      return r.log
        .state()
        .inbox.filter((i) => i.nodeId === "a")
        .map((i) => i.kind);
    };

    it("プロセスを確かめられない（left === null）ときは、stopIncomplete にせず info にとどめる", async () => {
      expect(await report()).toEqual(["info"]);
    });

    it("プロセスが残っていないときも、info にとどめる", async () => {
      expect(await report(async () => [])).toEqual(["info"]);
    });

    it("プロセスが残っているときは、stopIncomplete にする", async () => {
      const busy: ProcessInfo[] = [{ pid: 42, cwd: "/w/a", hasOpenFiles: true }];
      expect(await report(async () => busy)).toEqual(["stopIncomplete"]);
    });
  });
});
