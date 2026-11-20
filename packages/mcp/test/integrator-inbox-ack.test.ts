import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { failure, type InboxItem, ok } from "@touryou/core";
import { describe, expect, it } from "vitest";
import type { Relay } from "../src/relay.js";
import { createToolServer } from "../src/server.js";

// 統合の受信箱（#102）: inbox_fetch は inbox.fetch を呼び、応答に載せた項目の ID を ackItemIds で知らせる（受け取った記録）。
describe("統合の inbox_fetch（inbox.fetch）", () => {
  const item = (seq: number, kind: InboxItem["kind"] = "info"): InboxItem => ({
    seq,
    id: `i${seq}`,
    kind,
    nodeId: "a",
    dependsOn: [],
    at: "2026-10-20T00:00:00Z",
  });
  const setup = (items: InboxItem[], ackFails = false) => {
    const calls: { op: string; params: unknown }[] = [];
    const relay: Relay = {
      whoami: async () => ok({ role: "integrator", nodeId: "root" }),
      request: async (op, params) => {
        calls.push({ op, params });
        const isAck = (params as { ackItemIds?: unknown }).ackItemIds !== undefined;
        if (isAck) {
          return ackFails
            ? { ok: false, error: failure("invalidRequest", "古い daemon", "なし") }
            : ok({ items: [] });
        }
        return ok({ items });
      },
    };
    return { calls, server: createToolServer({ role: "integrator", relay }) };
  };
  const call = async (
    server: ReturnType<typeof createToolServer>,
    args: Record<string, unknown>,
  ) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = (await client.callTool({ name: "inbox_fetch", arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: r.isError === true, body: JSON.parse(r.content[0]?.text ?? "null") };
  };

  it("応答を作れたら、載せた項目の ID を ackItemIds で知らせる（件数で切った分は、載せていないので知らせない）", async () => {
    const s = setup([item(1), item(2), item(3)]);
    const r = await call(s.server, { limit: 2 });
    expect(r.isError).toBe(false);
    expect(r.body.entries).toHaveLength(2);
    const shown = r.body.entries.map((e: { id: string }) => e.id);
    expect(s.calls).toEqual([
      { op: "inbox.fetch", params: {} },
      { op: "inbox.fetch", params: { ackItemIds: shown } },
    ]);
    expect(shown).toHaveLength(2);
  });

  it("項目がなければ、受け取りは送らない", async () => {
    const s = setup([]);
    await call(s.server, {});
    expect(s.calls).toEqual([{ op: "inbox.fetch", params: {} }]);
  });

  it("受け取りの呼び出しが失敗（古い daemon など）しても、応答は変わらない。ackItemIds は道具の引数では受けない", async () => {
    const s = setup([item(1)], true);
    const r = await call(s.server, {});
    expect(r.isError).toBe(false);
    expect(r.body.entries.map((e: { id: string }) => e.id)).toEqual(["i1"]);
    const t = setup([item(1)]);
    const bad = await call(t.server, { ackItemIds: ["i1"] });
    expect(bad.isError).toBe(true);
    expect(t.calls).toEqual([]);
  });
});
