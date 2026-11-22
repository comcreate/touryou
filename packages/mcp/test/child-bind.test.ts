import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ok, type Result } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { bindChild } from "../src/child-bind.js";
import type { Relay } from "../src/relay.js";
import { createToolServer } from "../src/server.js";

// CLI の子の紐付け（mcp の child_bind）。
const relayAs = (role: string, nodeId: string, calls: string[] = []): Relay => ({
  whoami: async () => ok({ role, nodeId }),
  request: async (op) => {
    calls.push(`${nodeId}:${op}`);
    return ok({ accepted: true });
  },
});

const connect = async (bind: (n: unknown, c: unknown) => Promise<Result<Relay>>) => {
  const server = createToolServer({
    role: "integrator",
    relay: relayAs("integrator", "root"),
    bindChild: bind,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = async () => (await client.listTools()).tools.map((t) => t.name);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: r.isError === true, body: JSON.parse(r.content[0]?.text ?? "null") };
  };
  return { names, call };
};

describe("child_bind の道具", () => {
  it("紐付けに成功すると、子のロールの道具に切り替わり、child_bind は消える", async () => {
    const calls: string[] = [];
    const s = await connect(async () => ok(relayAs("child", "a", calls)));
    expect(await s.names()).toContain("child_bind");
    const r = await s.call("child_bind", { nodeId: "a", bindCode: "X" });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ bound: true, nodeId: "a", role: "child" });
    expect((r.body as { next?: string }).next).toContain("inbox_fetch");
    const after = await s.names();
    expect(after).not.toContain("child_bind");
    expect(after).toContain("report_progress");
    expect(after).not.toContain("node_spawn");
    expect((await s.call("whoami")).body).toEqual({
      nodeId: "a",
      role: "child",
      note: "紐付け済み。child_bind は道具の一覧から消える（mcp が切れたのではない）。ほかの子の道具はそのまま使える",
    });
    expect((r.body as { note?: string }).note).toContain("mcp が切れたのではない");
    await s.call("report_progress", { text: "x" });
    expect(calls).toEqual(["a:report.progress"]);
    // 2 回目は already_bound
    expect((await s.call("child_bind", { nodeId: "a", bindCode: "X" })).body.code).toBe(
      "already_bound",
    );
  });

  it("紐付けで受け取ったトークンのロールが integrator（サブ統括）なら、統合の道具に切り替わる（#168 PR3）", async () => {
    const calls: string[] = [];
    const s = await connect(async () => ok(relayAs("integrator", "sub", calls)));
    const r = await s.call("child_bind", { nodeId: "sub", bindCode: "X" });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ bound: true, nodeId: "sub", role: "integrator" });
    const after = await s.names();
    expect(after).not.toContain("child_bind");
    expect(after).toContain("node_spawn");
    expect(after).toContain("inbox_fetch");
    // サブ統括は、自分の親へ完了を報告できる（子の操作を持つ。子の受信箱は child_inbox）
    expect(after).toContain("report_done");
    expect(after).toContain("child_inbox");
    expect((await s.call("whoami")).body).toMatchObject({ nodeId: "sub", role: "integrator" });
    await s.call("tree_list");
    expect(calls).toEqual(["sub:tree.list"]);
  });

  it("受け取ったトークンのロールが、子でも統合でもない・尋ねられないときは、紐付かない（道具は切り替わらない）", async () => {
    const human = await connect(async () => ok(relayAs("human", "h")));
    const r1 = await human.call("child_bind", { nodeId: "h", bindCode: "X" });
    expect(r1.isError).toBe(true);
    expect(await human.names()).toContain("child_bind");
    const lost = await connect(async () =>
      ok({
        whoami: async () => ({
          ok: false as const,
          error: { code: "daemon_unreachable", cause: "x", nextActions: ["y"] },
        }),
        request: async () => ok({}),
      }),
    );
    const r2 = await lost.call("child_bind", { nodeId: "a", bindCode: "X" });
    expect(r2.isError).toBe(true);
    expect(r2.body.code).toBe("daemon_unreachable");
    expect(await lost.names()).toContain("child_bind");
  });

  it("失敗したら、ロールは変わらない", async () => {
    const s = await connect(async () => ({
      ok: false,
      error: { code: "bind_failed", cause: "x", nextActions: ["y"] },
    }));
    const r = await s.call("child_bind", { nodeId: "a", bindCode: "X" });
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe("bind_failed");
    expect(await s.names()).toContain("child_bind");
  });
});

describe("bindChild（POST /v1/bind の呼び出し）", () => {
  const TOKEN = "t".repeat(43);
  const fakeFetch = (status: number, value: unknown, seen: unknown[] = []) =>
    (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(status === 200 ? { ok: true, value } : { ok: false }), {
        status,
      });
    }) as unknown as typeof fetch;

  it("nodeId・bindCode・作業ディレクトリを送り、トークンを受け取る", async () => {
    const seen: unknown[] = [];
    const r = await bindChild(
      {
        daemonUrl: "http://127.0.0.1:7777",
        fetch: fakeFetch(200, { nodeId: "a", token: TOKEN }, seen),
        cwd: () => "/w/trees/a",
      },
      "a",
      "ABCDE",
    );
    expect(r).toEqual({ ok: true, value: { nodeId: "a", token: TOKEN } });
    expect(seen).toEqual([{ nodeId: "a", bindCode: "ABCDE", cwd: "/w/trees/a" }]);
  });

  it("401・別のノードの応答は bind_failed。失敗にトークンを含めない", async () => {
    for (const f of [fakeFetch(401, undefined), fakeFetch(200, { nodeId: "b", token: TOKEN })]) {
      const r = await bindChild(
        { daemonUrl: "http://127.0.0.1:7777", fetch: f, cwd: () => "/" },
        "a",
        "X",
      );
      expect(r.ok ? "" : r.error.code).toBe("bind_failed");
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });

  it("身元の確認に失敗したら、コードを送らない", async () => {
    const seen: unknown[] = [];
    const r = await bindChild(
      {
        daemonUrl: "http://127.0.0.1:7777",
        fetch: fakeFetch(200, { nodeId: "a", token: TOKEN }, seen),
        verifier: {
          verify: async () => ({
            ok: false,
            kind: "identity",
            failure: { code: "daemon_identity_failed", cause: "x", nextActions: ["y"] },
          }),
        },
      },
      "a",
      "X",
    );
    expect(r.ok ? "" : r.error.code).toBe("daemon_identity_failed");
    expect(seen).toHaveLength(0);
  });

  it("不正な引数は送らない", async () => {
    const seen: unknown[] = [];
    const r = await bindChild(
      { daemonUrl: "http://127.0.0.1:7777", fetch: fakeFetch(200, {}, seen) },
      "../x",
      "X",
    );
    expect(r.ok ? "" : r.error.code).toBe("invalid_argument");
    expect(seen).toHaveLength(0);
  });
});

describe("紐付け待ち（pending）の道具", () => {
  it("紐付けの前は child_bind と whoami だけを出し、ほかは not_bound。紐付けのあとは子の道具", async () => {
    const unbound: Relay = {
      whoami: async () => ({
        ok: false,
        error: { code: "not_bound", cause: "x", nextActions: ["y"] },
      }),
      request: async () => ({
        ok: false,
        error: { code: "not_bound", cause: "x", nextActions: ["y"] },
      }),
    };
    const server = createToolServer({
      role: "child",
      relay: unbound,
      pending: true,
      bindChild: async () => ok(relayAs("child", "a")),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
    expect(await names()).toEqual(["child_bind", "whoami"]);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      JSON.parse(
        ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] })
          .content[0]?.text ?? "null",
      );
    expect((await call("report_progress", { text: "x" })).code).toBe("not_bound");
    expect((await call("node_spawn", {})).code).toBe("not_bound");
    expect((await call("whoami")).code).toBe("not_bound");
    await call("child_bind", { nodeId: "a", bindCode: "X" });
    const after = await names();
    expect(after).toContain("report_progress");
    expect(after).not.toContain("child_bind");
    expect(after).not.toContain("node_spawn");
  });
});

describe("401 のあと、紐付け待ちに戻る", () => {
  it("入れ物が空になったら child_bind を出し直し、出し直したコードで紐付けられる", async () => {
    const { createNodeCredentialStore } = await import("../src/node-credential.js");
    const store = createNodeCredentialStore();
    const unbound: Relay = {
      whoami: async () => ({
        ok: false,
        error: { code: "not_bound", cause: "x", nextActions: ["y"] },
      }),
      request: async () => ({
        ok: false,
        error: { code: "not_bound", cause: "x", nextActions: ["y"] },
      }),
    };
    let binds = 0;
    const server = createToolServer({
      role: "child",
      relay: unbound,
      pending: true,
      credentials: store,
      bindChild: async (nodeId) => {
        binds++;
        store.set({ nodeId: String(nodeId), token: "t".repeat(43) });
        return ok(relayAs("child", "a"));
      },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = async () => (await client.listTools()).tools.map((t) => t.name);
    await client.callTool({ name: "child_bind", arguments: { nodeId: "a", bindCode: "X" } });
    expect(await names()).not.toContain("child_bind");
    store.clear(); // daemon の 401
    expect((await names()).sort()).toEqual(["child_bind", "whoami"]);
    const again = (await client.callTool({
      name: "child_bind",
      arguments: { nodeId: "a", bindCode: "Y" },
    })) as {
      isError?: boolean;
    };
    expect(again.isError).not.toBe(true);
    expect(binds).toBe(2);
    expect(await names()).toContain("report_progress");
  });
});
