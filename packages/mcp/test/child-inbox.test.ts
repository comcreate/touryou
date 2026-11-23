import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { failure, ok } from "@touryou/core";
import { instructionEcho } from "@touryou/core/echo";
import { describe, expect, it } from "vitest";
import type { Relay } from "../src/relay.js";
import { createToolServer } from "../src/server.js";

// 子の受信箱: 子の道具 inbox_fetch は child.inbox を呼び、応答を受け取ってから ackThrough で受け取りを知らせる。
describe("子の inbox_fetch（child.inbox）", () => {
  const setup = (instructions: { seq: number; received: boolean }[]) => {
    const calls: { op: string; params: unknown }[] = [];
    const relay: Relay = {
      whoami: async () => ok({ role: "child", nodeId: "a" }),
      request: async (op, params) => {
        calls.push({ op, params });
        return ok({
          brief: { nodeId: "a", objective: "直す", dependsOn: [] },
          instructions: instructions.map((i) => ({ ...i, at: "t", quotedText: "> x" })),
        });
      },
    };
    return { calls, server: createToolServer({ role: "child", relay }) };
  };
  const call = async (
    server: ReturnType<typeof createToolServer>,
    args: Record<string, unknown>,
  ) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    const r = (await client.callTool({ name: "inbox_fetch", arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { names, isError: r.isError === true, body: JSON.parse(r.content[0]?.text ?? "null") };
  };

  it("child.inbox を呼び、まだ受け取っていなかった指示の最大の番号を ackThrough で知らせる。応答に引用の注意を付ける", async () => {
    const s = setup([
      { seq: 3, received: true },
      { seq: 5, received: false },
      { seq: 7, received: false },
    ]);
    const r = await call(s.server, { all: true });
    expect(r.names).toContain("inbox_fetch");
    expect(r.isError).toBe(false);
    expect(r.body.note).toContain("引用");
    expect(r.body.note).toContain("頭の > を除く");
    expect(r.body.note).toContain("report_decision");
    expect(r.body.brief.nodeId).toBe("a");
    // 復唱（#261）は、まだ受け取っていなかった指示だけに付く（受け取り済みの 3 番には付けない）
    expect(s.calls).toEqual([
      { op: "child.inbox", params: { all: true } },
      {
        op: "child.inbox",
        params: { ackThrough: 7, echoes: { "5": instructionEcho("x"), "7": instructionEcho("x") } },
      },
    ]);
  });

  it("復唱は、引用の印（> ）を外した本文のハッシュ値。子の AI の入力に依らず、MCP が計算する。行頭の空白は本文の一部", async () => {
    const calls: { op: string; params: unknown }[] = [];
    const relay: Relay = {
      whoami: async () => ok({ role: "child", nodeId: "a" }),
      request: async (op, params) => {
        calls.push({ op, params });
        return ok({
          brief: { nodeId: "a", dependsOn: [] },
          instructions: [
            { seq: 4, received: false, at: "t", quotedText: ">   字下げ\n> \n> 次の行" },
          ],
        });
      },
    };
    await call(createToolServer({ role: "child", relay }), {});
    expect(calls[1]).toEqual({
      op: "child.inbox",
      params: { ackThrough: 4, echoes: { "4": instructionEcho("  字下げ\n\n次の行") } },
    });
  });

  it("復唱を知らない古い daemon が断っても、復唱なしで受け取りをもう一度知らせる（受け取りの記録を失わない）", async () => {
    const calls: { op: string; params: unknown }[] = [];
    const relay: Relay = {
      whoami: async () => ok({ role: "child", nodeId: "a" }),
      request: async (op, params) => {
        calls.push({ op, params });
        if ((params as { echoes?: unknown }).echoes !== undefined) {
          return { ok: false, error: failure("invalidParams", "echoes は未知のキー", "") };
        }
        return ok({
          brief: { nodeId: "a", dependsOn: [] },
          instructions: [{ seq: 2, received: false, at: "t", quotedText: "> y" }],
        });
      },
    };
    await call(createToolServer({ role: "child", relay }), {});
    expect(calls.map((c) => c.params)).toEqual([
      {},
      { ackThrough: 2, echoes: { "2": instructionEcho("y") } },
      { ackThrough: 2 },
    ]);
  });

  it("新しい指示がなければ、ackThrough を送らない。ackThrough は道具の引数では受けない", async () => {
    const s = setup([]);
    await call(s.server, {});
    expect(s.calls).toEqual([{ op: "child.inbox", params: {} }]);
    const t = setup([]);
    const bad = await call(t.server, { ackThrough: 9 });
    expect(bad.isError).toBe(true);
    expect(t.calls).toEqual([]);
  });
});
