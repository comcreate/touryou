/**
 * 受理した子の裏のセッションの停止（Issue #3。設計 6.2）。
 * - 受理（node.review accept）のとき、親が起動を報告した子には、状態を verified のまま、`claude stop` の依頼を出す。
 * - 親の「止めた」のあと、作業ツリーのプロセスがないと確かめたら、受信箱に info を出し、続けて `claude rm` を依頼する（状態は変えない）。
 * - プロセスが残っていれば、node_stop（verified でも受ける）で依頼を出し直せる。
 */
import type { EventBody, NodeEvent, ProcessInfo } from "@touryou/core";
import { describe, expect, it } from "vitest";
import {
  createParentRequestHandlers,
  sessionStopBodies,
} from "../../src/api/handlers/parent-request-handlers.js";
import { createRuntimeHandlers } from "../../src/api/handlers/runtime-handlers.js";
import { createStateHandlers } from "../../src/api/handlers/state-handlers.js";
import type { HandlerRequest } from "../../src/api/server.js";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";

const T0 = "2026-11-14T00:00:00.000Z";
let n = 0;

const rig = (opts: { launched: boolean }) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock: () => T0 });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  for (const [id, parent] of [
    ["root", null],
    ["a", "root"],
  ] as const) {
    add({
      type: "node.created",
      payload: {
        nodeId: id,
        role: id === "root" ? "integrator" : "implement",
        parentId: parent,
        dependsOn: [],
      },
    });
    ev(id, { type: "start" });
  }
  if (opts.launched) {
    add({
      type: "node.parentRequested",
      payload: { nodeId: "a", requestRef: "preq-launch", kind: "launch", worktree: "/w/a" },
    });
    add({
      type: "node.parentReported",
      payload: { nodeId: "a", requestRef: "preq-launch", outcome: "done", sessionRef: "sess-a" },
    });
  }
  ev("a", { type: "reportDone" });
  let procs: readonly ProcessInfo[] | null = [];
  const probe = async () => procs;
  const parent = createParentRequestHandlers({ log, clock: () => T0, probe });
  const state = createStateHandlers({ log, clock: () => T0 });
  const runtime = createRuntimeHandlers({ log, clock: () => T0, adapterFor: () => undefined });
  const req = <Op extends string>(operation: Op, params: unknown) =>
    ({
      requestId: `q-${++n}`,
      operation,
      role: "integrator",
      caller: { nodeId: "root" },
      params,
    }) as unknown as HandlerRequest<never>;
  type Res = { ok: boolean; value?: Record<string, unknown>; error?: { code: string } };
  const call = async (operation: string, params: unknown): Promise<Res> => {
    const all = { ...parent, ...state, ...runtime } as unknown as Record<
      string,
      (r: unknown) => unknown
    >;
    return (await all[operation]?.(req(operation, params))) as Res;
  };
  const open = () => [...log.state().parentRequests].reverse().find((r) => r.report === undefined);
  const stateOfA = () => log.state().nodes.find((x) => x.id === "a")?.state;
  return { log, call, open, stateOfA, setProcs: (p: readonly ProcessInfo[] | null) => (procs = p) };
};

const busy: ProcessInfo[] = [{ pid: 42, cwd: "/w/a", hasOpenFiles: true, command: "claude" }];

describe("受理した子の裏のセッションの停止（Issue #3）", () => {
  it("受理すると、状態は verified のまま、親に claude stop を依頼する", async () => {
    const r = rig({ launched: true });
    const res = await r.call("node.review", { nodeId: "a", verdict: "accept" });
    expect(res.ok).toBe(true);
    expect(r.stateOfA()).toBe("verified");
    expect(r.open()?.kind).toBe("stop");
    const cmd = await r.call("parent.request", { nodeId: "a" });
    expect(cmd.value?.command).toBe("claude stop sess-a");
    expect(r.log.state().inbox.some((i) => i.summary?.includes("受理した")) === true).toBe(true);
  });

  it("止めたのを確かめたら、受信箱に info を出し、続けて claude rm を依頼する（状態は verified のまま）", async () => {
    const r = rig({ launched: true });
    await r.call("node.review", { nodeId: "a", verdict: "accept" });
    const stop = r.open();
    await r.call("parent.report", { nodeId: "a", requestRef: stop?.requestRef, outcome: "done" });
    expect(r.stateOfA()).toBe("verified");
    expect(r.open()?.kind).toBe("remove");
    const cmd = await r.call("parent.request", { nodeId: "a" });
    expect(cmd.value?.command).toBe("claude rm sess-a");
    expect(
      r.log
        .state()
        .inbox.some((i) => i.kind === "info" && i.summary?.includes("裏のセッションを止めた")),
    ).toBe(true);
  });

  it("プロセスが残っていれば、削除を依頼せず、node_stop で依頼を出し直せる", async () => {
    const r = rig({ launched: true });
    await r.call("node.review", { nodeId: "a", verdict: "accept" });
    r.setProcs(busy);
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef,
      outcome: "done",
    });
    expect(r.open()).toBeUndefined();
    expect(r.stateOfA()).toBe("verified");
    const again = await r.call("node.stop", { nodeId: "a", mode: "immediate" });
    expect(again).toMatchObject({ ok: true, value: { state: "verified" } });
    expect(r.open()?.kind).toBe("stop");
    // まだ報告のない依頼があるうちは、出し直さない
    const twice = await r.call("node.stop", { nodeId: "a", mode: "immediate" });
    expect(twice.error?.code).toBe("alreadyFinished");
  });

  it("起動の報告がない子（Desktop・紐付けだけ）には、依頼を出さない", async () => {
    const r = rig({ launched: false });
    await r.call("node.review", { nodeId: "a", verdict: "accept" });
    expect(r.stateOfA()).toBe("verified");
    expect(r.log.state().parentRequests).toHaveLength(0);
    expect(sessionStopBodies(r.log.state(), "a", "x")).toEqual([]);
    const res = await r.call("node.stop", { nodeId: "a", mode: "immediate" });
    expect(res.error?.code).toBe("alreadyFinished");
  });
});
