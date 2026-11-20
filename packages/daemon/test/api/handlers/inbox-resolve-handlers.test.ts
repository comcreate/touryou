/**
 * 受信箱の項目を人が片付ける・戻す（`inbox.resolve`・`inbox.reopen`。#99）。
 * - 片付けられるのは progress・done・info だけ。判断・違反・停止未完了・失敗は、1 件でも含まれれば何も片付けずに断る。
 * - 存在しない ID は notFound（何も片付けない）。解決済みは alreadyResolved に入れて冪等。
 * - 人間だけが呼べる。片付けた項目は未解決の数に入らず、記録に残る。
 * - 戻せるのは人が片付けた項目だけ（system が解決にしたものは notReopenable）。
 */
import { type EventBody, type InboxKind, unresolvedInbox } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createInboxResolveHandlers } from "../../../src/api/handlers/inbox-resolve-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";

const T0 = "2026-11-20T00:00:00.000Z";

const rig = () => {
  const opened = EventLog.open(createMemoryStore().open(), { clock: () => T0 });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  let seed = 0;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `seed-${++seed}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  add({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } });
  add({
    type: "node.created",
    payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
  });
  const item = (kind: InboxKind) =>
    add({
      type: "inbox.added",
      payload: { id: `${kind}-a`, kind, nodeId: "a", summary: `${kind} a` },
    });
  const handlers = createInboxResolveHandlers({ log, clock: () => T0 });
  let n = 0;
  const resolve = (itemIds: string[], role: "human" | "integrator" = "human") =>
    handlers["inbox.resolve"]({
      requestId: `req-${++n}`,
      operation: "inbox.resolve",
      role,
      params: { itemIds },
    } as unknown as HandlerRequest<"inbox.resolve">);
  const reopen = (itemIds: string[], role: "human" | "integrator" = "human") =>
    handlers["inbox.reopen"]({
      requestId: `req-${++n}`,
      operation: "inbox.reopen",
      role,
      params: { itemIds },
    } as unknown as HandlerRequest<"inbox.reopen">);
  const open = (): string[] =>
    unresolvedInbox(log.state().inbox)
      .map((i) => i.id)
      .sort();
  return { log, add, item, resolve, reopen, open };
};

describe("inbox.resolve", () => {
  it("progress・done・info を、人間として片付ける。未解決の数に入らず、項目は記録に残る", () => {
    const r = rig();
    r.item("progress");
    r.item("done");
    r.item("info");
    const res = r.resolve(["progress-a", "done-a", "info-a"]);
    expect(res).toEqual({
      ok: true,
      value: { resolved: ["progress-a", "done-a", "info-a"], alreadyResolved: [] },
    });
    expect(r.open()).toEqual([]);
    const kept = r.log.state().inbox.find((i) => i.id === "done-a");
    expect(kept?.resolved?.by).toEqual({ human: true });
  });

  it("片付けられない種類が 1 件でもあれば、何も片付けずに notResolvable で断る", () => {
    for (const kind of ["decision", "violation", "stopIncomplete", "failure"] as const) {
      const r = rig();
      r.item("info");
      r.item(kind);
      const res = r.resolve(["info-a", `${kind}-a`]);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("notResolvable");
      expect(r.open()).toContain("info-a");
      expect(r.open()).toContain(`${kind}-a`);
    }
  });

  it("存在しない ID が 1 件でもあれば、何も片付けずに notFound", () => {
    const r = rig();
    r.item("info");
    const res = r.resolve(["info-a", "no-such-item"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("notFound");
    expect(r.open()).toEqual(["info-a"]);
  });

  it("解決済みの項目は alreadyResolved に入れて、成功する（冪等）", () => {
    const r = rig();
    r.item("info");
    r.item("done");
    expect(r.resolve(["info-a"]).ok).toBe(true);
    const res = r.resolve(["info-a", "done-a"]);
    expect(res).toEqual({
      ok: true,
      value: { resolved: ["done-a"], alreadyResolved: ["info-a"] },
    });
    // すべて解決済みでも成功し、何も足さない
    const again = r.resolve(["info-a", "done-a"]);
    expect(again).toEqual({
      ok: true,
      value: { resolved: [], alreadyResolved: ["info-a", "done-a"] },
    });
  });

  it("人間以外は forbidden", () => {
    const r = rig();
    r.item("info");
    const res = r.resolve(["info-a"], "integrator");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
    expect(r.open()).toEqual(["info-a"]);
  });
});

describe("inbox.reopen", () => {
  it("人が片付けた項目を、未解決に戻す", () => {
    const r = rig();
    r.item("info");
    r.resolve(["info-a"]);
    expect(r.open()).toEqual([]);
    const res = r.reopen(["info-a"]);
    expect(res).toEqual({ ok: true, value: { reopened: ["info-a"], alreadyOpen: [] } });
    expect(r.open()).toEqual(["info-a"]);
    expect(r.log.state().inbox.find((i) => i.id === "info-a")?.resolved).toBeUndefined();
  });

  it("戻したあとで、もう一度片付けられる", () => {
    const r = rig();
    r.item("done");
    r.resolve(["done-a"]);
    r.reopen(["done-a"]);
    expect(r.resolve(["done-a"]).ok).toBe(true);
    expect(r.open()).toEqual([]);
  });

  it("すでに未解決の項目は alreadyOpen に入れて、成功する（冪等）", () => {
    const r = rig();
    r.item("info");
    const res = r.reopen(["info-a"]);
    expect(res).toEqual({ ok: true, value: { reopened: [], alreadyOpen: ["info-a"] } });
  });

  it("system が解決にした項目は戻せない（notReopenable）", () => {
    const r = rig();
    r.item("failure");
    r.add({ type: "inbox.resolved", payload: { itemId: "failure-a" } });
    const res = r.reopen(["failure-a"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("notReopenable");
    expect(r.open()).toEqual([]);
  });

  it("存在しない ID は notFound、人間以外は forbidden", () => {
    const r = rig();
    r.item("info");
    r.resolve(["info-a"]);
    const missing = r.reopen(["no-such-item"]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("notFound");
    const denied = r.reopen(["info-a"], "integrator");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("forbidden");
    expect(r.open()).toEqual([]);
  });
});
