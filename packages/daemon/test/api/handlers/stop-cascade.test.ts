/**
 * サブ統括（統合ノードの子）の連動停止（#168 PR5。設計 §7・§11 の「停止」）。
 * - サブ統括の node.stop は、配下の子（孫）を先に停止の依頼に載せ、孫の停止が確認されてから、自分のセッションの停止を始める。
 * - 孫の停止が上限までに確認できなければ、サブ統括は停止未完了になり、理由（孫の ID と状態）が受信箱に出る。
 * - done の孫は対象にしない。verified の孫は状態を変えず、裏のセッションの停止の依頼を出し直す。
 */
import {
  type EventBody,
  type Failure,
  type NodeEvent,
  ok,
  type Result,
  stateOf,
} from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createRuntimeHandlers } from "../../../src/api/handlers/runtime-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import type { Capabilities, RuntimeAdapter, StopRequest } from "../../../src/sdk/runtime.js";

const clock = (): string => "2026-11-22T00:00:00Z";
let n = 0;

/** CLI のアダプタに似せた偽物: 停止は親への依頼（stopIncomplete・代行）で返し、止めたとは自分では記録しない。 */
class DelegatingAdapter implements RuntimeAdapter {
  readonly kind = "cli" as const;
  readonly stops: [string, StopRequest][] = [];
  capabilities(): Capabilities {
    return {
      send: "delayed",
      stopGraceful: true,
      stopImmediate: true,
      stopDelegated: true,
      hooks: "ok",
      sessionId: false,
    };
  }
  async start(): Promise<never> {
    throw new Error("not used");
  }
  async send(): Promise<never> {
    throw new Error("not used");
  }
  async stop(nodeId: string, request: StopRequest) {
    this.stops.push([nodeId, request]);
    return ok({
      state: "stopIncomplete" as const,
      blockers: [],
      delegation: `親に停止を依頼: ${nodeId}`,
    });
  }
  updateScope(): Result<undefined, Failure> {
    return ok(undefined);
  }
}

/**
 * root ─ m1（サブ統括）─ g1(running)・g2(waiting)・gp(pending)・gd(done)・gv(verified。起動の報告つき)
 * root ─ m2（別のサブ統括）─ h(running)。呼び出し元は root。
 */
const rig = (cascade: { waitMs: number; pollMs: number } = { waitMs: 2_000, pollMs: 5 }) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
  node("root", "integrator", null);
  ev("root", { type: "start" });
  node("m1", "integrator", "root");
  ev("m1", { type: "start" });
  node("g1", "implement", "m1");
  ev("g1", { type: "start" });
  node("g2", "implement", "m1");
  ev("g2", { type: "start" });
  ev("g2", { type: "requestDecision" });
  node("gp", "implement", "m1");
  node("gd", "implement", "m1");
  ev("gd", { type: "start" });
  ev("gd", { type: "reportDone" });
  node("gv", "implement", "m1");
  ev("gv", { type: "start" });
  add({
    type: "node.parentRequested",
    payload: { nodeId: "gv", requestRef: "preq-gv", kind: "launch", worktree: "/w/gv" },
  });
  add({
    type: "node.parentReported",
    payload: { nodeId: "gv", requestRef: "preq-gv", outcome: "done", sessionRef: "sess-gv" },
  });
  ev("gv", { type: "reportDone" });
  ev("gv", { type: "accept" });
  node("m2", "integrator", "root");
  ev("m2", { type: "start" });
  node("h", "implement", "m2");
  ev("h", { type: "start" });
  const adapter = new DelegatingAdapter();
  const h = createRuntimeHandlers({ log, clock, adapterFor: () => adapter, cascade });
  const stop = async (nodeId: string, mode: "graceful" | "immediate" = "graceful", id?: string) =>
    (await h["node.stop"]({
      requestId: id ?? `q-${++n}`,
      operation: "node.stop",
      role: "integrator",
      caller: { nodeId: "root" },
      params: { nodeId, mode },
    } as unknown as HandlerRequest<"node.stop">)) as {
      ok: boolean;
      value?: { state: string };
      error?: Failure;
    };
  const st = (id: string) => stateOf(log.state(), id);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return { log, adapter, ev, stop, st, sleep };
};

describe("サブ統括の連動停止（孫が先、サブ統括が後）", () => {
  it("孫を先に停止の依頼に載せ、孫の停止が確認されるまでサブ統括は stopping に留まり、自分のセッションの停止を始めない", async () => {
    const r = rig();
    const res = await r.stop("m1");
    expect(res).toEqual({ ok: true, value: { state: "stopping" } });
    expect(r.st("m1")).toBe("stopping");
    expect(r.st("g1")).toBe("stopping");
    expect(r.st("g2")).toBe("stopping");
    expect(r.st("gp")).toBe("stopped"); // 起動前は取り消し
    await r.sleep(30);
    // 孫の停止は始まったが、孫の確認がないので、サブ統括の停止は始まらない（stopping のまま）。
    expect(r.adapter.stops.map(([id]) => id).sort()).toEqual(["g1", "g2"]);
    expect(r.st("m1")).toBe("stopping");
    // 孫の停止を宣言する（親のセッションが claude stop を実行した → 確認）と、サブ統括の停止が始まる。後順。
    r.ev("g1", { type: "confirmStopped" });
    r.ev("g2", { type: "confirmStopped" });
    await r.sleep(30);
    expect(r.adapter.stops.map(([id]) => id)).toEqual(["g1", "g2", "m1"]);
    // 別のサブ統括の配下には影響しない
    expect(r.st("h")).toBe("running");
    expect(r.st("m2")).toBe("running");
  });

  it("孫の停止が上限までに確認できないと、サブ統括も停止未完了になり、理由（孫の ID と状態）が受信箱に出る。サブ統括の停止は始まらない", async () => {
    const r = rig({ waitMs: 40, pollMs: 5 });
    await r.stop("m1");
    await r.sleep(120);
    expect(r.st("m1")).toBe("stopIncomplete");
    expect(r.adapter.stops.map(([id]) => id)).not.toContain("m1");
    const item = r.log
      .state()
      .inbox.find(
        (i) => i.kind === "stopIncomplete" && i.nodeId === "m1" && i.resolved === undefined,
      );
    expect(item?.summary).toContain("g1（stopping）");
    expect(item?.summary).toContain("g2（stopping）");
    // 孫の成果（記録・状態）は消えない。確認できた孫（gp）は理由に出ない。
    expect(item?.summary).not.toContain("gp");
  });

  it("確認できなかったあと、親が孫の停止を宣言してから、サブ統括を止め直せる（再試行は孫の確認を待たずに自分の停止へ進む）", async () => {
    const r = rig({ waitMs: 40, pollMs: 5 });
    await r.stop("m1");
    await r.sleep(120);
    expect(r.st("m1")).toBe("stopIncomplete");
    // 親（root）が、孫ごとに node.confirmStopped で宣言する（既存の逃げ道。stopDelegated のノードを、祖先が宣言できる）。
    r.ev("g1", { type: "confirmStopped" });
    r.ev("g2", { type: "confirmStopped" });
    const retry = await r.stop("m1", "immediate");
    expect(retry).toEqual({ ok: true, value: { state: "stopping" } });
    await r.sleep(30);
    expect(r.adapter.stops.at(-1)?.[0]).toBe("m1");
    expect(r.adapter.stops.at(-1)?.[1].mode).toBe("immediate");
  });

  it("done の孫は止めない（done のまま）。verified の孫は状態を変えず、裏のセッションの停止を依頼し直す", async () => {
    const r = rig();
    await r.stop("m1");
    expect(r.st("gd")).toBe("done");
    expect(r.st("gv")).toBe("verified");
    const reqs = r.log.state().parentRequests.filter((q) => q.nodeId === "gv" && q.kind === "stop");
    expect(reqs.length).toBe(1);
    await r.sleep(30);
    expect(r.adapter.stops.map(([id]) => id)).not.toContain("gd");
    expect(r.adapter.stops.map(([id]) => id)).not.toContain("gv");
    // done・verified の孫は、確認を待つ対象でもない（動作中の孫だけが確認されれば、サブ統括の停止が始まる）。
    r.ev("g1", { type: "confirmStopped" });
    r.ev("g2", { type: "confirmStopped" });
    await r.sleep(30);
    expect(r.adapter.stops.at(-1)?.[0]).toBe("m1");
  });

  it("同じ requestId の再送は、孫の停止の依頼を重ねて記録しない", async () => {
    const r = rig();
    await r.stop("m1", "graceful", "same");
    await r.sleep(30); // 孫の停止の結果（受信箱への記録）が済むのを待つ
    const seq = r.log.state().lastSeq;
    const again = await r.stop("m1", "graceful", "same");
    expect(again).toEqual({ ok: true, value: { state: "stopping" } });
    expect(r.log.state().lastSeq).toBe(seq);
  });

  it("別のサブ統括 m2 も同じ: 孫 h が先に止まり、h の確認のあとに m2 の停止が始まる", async () => {
    const r = rig();
    const res = await r.stop("m2");
    expect(res.ok).toBe(true);
    expect(r.st("h")).toBe("stopping");
    await r.sleep(30);
    expect(r.adapter.stops.map(([id]) => id)).toEqual(["h"]);
    r.ev("h", { type: "confirmStopped" });
    await r.sleep(30);
    expect(r.adapter.stops.map(([id]) => id)).toEqual(["h", "m2"]);
    // m1 の配下には影響しない
    expect(r.st("g1")).toBe("running");
  });

  it("配下に動作中の子のない統合ノードは、これまでどおり、すぐに自分のセッションの停止を始める", async () => {
    const r = rig();
    // m2 の孫 h を先に止めて確認済みにする
    r.ev("h", { type: "stop", mode: "immediate" });
    r.ev("h", { type: "confirmStopped" });
    const res = await r.stop("m2");
    expect(res.ok).toBe(true);
    await r.sleep(10);
    expect(r.adapter.stops.map(([id]) => id)).toEqual(["m2"]);
  });
});
