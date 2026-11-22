import type { EventBody, NodeEvent } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createBindCodes } from "../../../src/api/bind.js";
import { createBindHandlers } from "../../../src/api/handlers/bind-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";

// node.bindCode の CLI の木の文面。
let n = 0;
const rig = () => {
  const opened = EventLog.open(createMemoryStore().open(), { clock: () => "2026-11-11T00:00:00Z" });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(r.error.code);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  ev("root", { type: "start" });
  add({
    type: "node.created",
    payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
  });
  ev("a", { type: "start" });
  add({
    type: "node.created",
    payload: { nodeId: "p", role: "implement", parentId: "root", dependsOn: [] },
  });
  // サブ統括 m1（root の子の統合ノード）とその子 g
  add({
    type: "node.created",
    payload: { nodeId: "m1", role: "integrator", parentId: "root", dependsOn: [] },
  });
  ev("m1", { type: "start" });
  add({
    type: "node.created",
    payload: { nodeId: "g", role: "implement", parentId: "m1", dependsOn: [] },
  });
  ev("g", { type: "start" });
  // m1 の下の統合ノード m2（root から見て、直接の子ではない子孫）
  add({
    type: "node.created",
    payload: { nodeId: "m2", role: "integrator", parentId: "m1", dependsOn: [] },
  });
  ev("m2", { type: "start" });
  const now = Date.parse("2026-11-11T00:00:00Z");
  const bind = createBindCodes({ clock: () => now });
  const h = createBindHandlers({ log, bind, cli: true, baseUrl: () => "http://127.0.0.1:7777" });
  const call = (nodeId: string, caller = "root") =>
    h["node.bindCode"]({
      requestId: `q-${++n}`,
      operation: "node.bindCode",
      role: caller === "human" ? "human" : "integrator",
      ...(caller === "human" ? {} : { caller: { nodeId: caller } }),
      params: { nodeId },
    } as unknown as HandlerRequest<"node.bindCode">);
  return { bind, call, events: () => log.state() };
};
const codeOf = (text: string): string => {
  const m = /bindCode: ([0-9A-Z-]+)/.exec(text);
  if (!m) throw new Error("no code");
  return m[1] as string;
};

describe("node.bindCode（CLI の子）", () => {
  it("一度きりのコードと、child_bind を呼ぶ手順を返す。期限つき。コードは記録に入らない", () => {
    const r = rig();
    const res = r.call("a");
    if (!res.ok) throw new Error(res.error.code);
    expect(res.value.instruction).toContain("child_bind");
    expect(res.value.instruction).toContain("nodeId: a");
    expect(res.value.expiresAt).toBe("2026-11-11T00:10:00.000Z");
    const code = codeOf(res.value.instruction);
    expect(JSON.stringify(r.events())).not.toContain(code.replaceAll("-", ""));
    expect(r.bind.redeem("a", code).ok).toBe(true);
    expect(r.bind.redeem("a", code).ok).toBe(false); // 再使用
  });

  it("出し直すと、前のコードは無効になる", () => {
    const r = rig();
    const first = r.call("a");
    const second = r.call("a");
    if (!first.ok || !second.ok) throw new Error("failed");
    expect(r.bind.redeem("a", codeOf(first.value.instruction)).ok).toBe(false);
    expect(r.bind.redeem("a", codeOf(second.value.instruction)).ok).toBe(true);
  });

  it("起動前（pending）のノードは notActive", () => {
    const r = rig();
    const p = r.call("p");
    expect(p.ok ? "" : p.error.code).toBe("notActive");
  });

  it("サブ統括（統合ノードの子の統合ノード）の bind コードを、直接の親と人間が発行できる", () => {
    const r = rig();
    const fromParent = r.call("m1", "root");
    if (!fromParent.ok) throw new Error(fromParent.error.code);
    expect(fromParent.value.instruction).toContain("nodeId: m1");
    expect(r.bind.redeem("m1", codeOf(fromParent.value.instruction)).ok).toBe(true);
    expect(r.call("m1", "human").ok).toBe(true);
  });

  it("サブ統括の bind コードは、直接の親でない者・根・Desktop の木では出さない", () => {
    const r = rig();
    const code = (x: ReturnType<typeof r.call>) => (x.ok ? "ok" : x.error.code);
    // 子の g は、m1 の子で、m1 の親でも祖先でもない
    expect(code(r.call("m1", "g"))).toBe("forbidden");
    // root は m2 の祖先だが、直接の親ではない（m2 の親は m1）。m1 なら出せる
    expect(code(r.call("m2", "root"))).toBe("forbidden");
    expect(code(r.call("m2", "m1"))).toBe("ok");
    // 根は、コードでは紐付けない（人間でも）
    expect(code(r.call("root", "human"))).toBe("forbidden");
    expect(code(r.call("root", "m1"))).toBe("forbidden");
  });
});

describe("G: Desktop の木の node.bindCode", () => {
  it("cli の旗があっても、Desktop のアダプタがあれば Desktop の文面を返す", () => {
    const opened = EventLog.open(createMemoryStore().open(), {
      clock: () => "2026-11-11T00:00:00Z",
    });
    if (!opened.ok) throw new Error(opened.error.code);
    const log = opened.value;
    const add = (body: EventBody) =>
      log.append({ requestId: `g-${++n}`, actor: { system: true }, body });
    add({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } });
    add({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } });
    const h = createBindHandlers({
      log,
      bind: createBindCodes(),
      cli: true,
      desktop: { instructionOf: () => "あなたのノード ID: a" },
      baseUrl: () => "http://127.0.0.1:7777",
      touryouCommand: ["node", "/opt/touryou/bin.js"],
      prepareDrawer: () => "/d",
    });
    const r = h["node.bindCode"]({
      requestId: "q",
      operation: "node.bindCode",
      role: "human",
      params: { nodeId: "a" },
    } as unknown as HandlerRequest<"node.bindCode">);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.value.instruction).toContain("touryou child");
    expect(r.value.instruction).not.toContain("child_bind");
  });
});
