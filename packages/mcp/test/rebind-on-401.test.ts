import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { proofOf } from "../src/identity.js";
import { openPendingStdioSession } from "../src/stdio.js";

// daemon の再起動などで、紐付けのあとのトークンを daemon が 401 で拒んだとき（#185）。
// mcp は、資格情報を捨てる前に、コードなしの結び直し（#145）を 1 回試す。通らなければ「紐付けが外れた」と出す。
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), "touryou-rebind401-"));
  made.push(dir);
  const identity = { daemonId: "a".repeat(32), secret: "b".repeat(64) };
  const identityPath = join(dir, "daemon-identity");
  writeFileSync(identityPath, JSON.stringify({ version: 1, ...identity }), { mode: 0o600 });
  chmodSync(identityPath, 0o600);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-touryou-daemon-id": identity.daemonId },
    });
  const state = { binds: 0, rebindAllowed: true, revoked: new Set<string>() };
  const tokenOf = (n: number) => `tok-${String(n).repeat(40)}`;
  const fakeFetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/v1/identity") {
      return json(200, {
        ok: true,
        value: {
          daemonId: identity.daemonId,
          proof: proofOf(identity, "127.0.0.1:45678", url.searchParams.get("nonce") ?? ""),
        },
      });
    }
    if (url.pathname === "/v1/bind") {
      if (state.binds > 0 && !state.rebindAllowed) {
        return json(401, {
          ok: false,
          error: { code: "unauthenticated", cause: "bind コードが無効", nextActions: ["x"] },
        });
      }
      state.binds += 1;
      return json(200, { ok: true, value: { nodeId: "a", token: tokenOf(state.binds) } });
    }
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (state.revoked.has(auth.replace("Bearer ", ""))) {
      return json(401, {
        ok: false,
        error: { code: "unauthenticated", cause: "トークンが無効", nextActions: ["x"] },
      });
    }
    // 本物の daemon の whoami は、トークンのロールとノードの ID を返す（child_bind の戻りのロールの切り替えが使う）
    if (url.pathname === "/v1/whoami")
      return json(200, { ok: true, value: { role: "child", nodeId: "a" } });
    return json(200, { ok: true, value: { accepted: true } });
  }) as unknown as typeof fetch;
  const server = openPendingStdioSession(
    { daemonUrl: "http://127.0.0.1:45678", identityPath, stateDir: dir },
    { stderr: () => {} },
    {
      fetch: fakeFetch,
      cwd: () => join(dir, "tree-without-code-file"),
      markerNodeId: "a",
      sessionId: "s-1",
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: res.isError === true, body: JSON.parse(res.content[0]?.text ?? "{}") };
  };
  return { state, tokenOf, names, call };
};

describe("紐付けのあとの 401（daemon の再起動など）", () => {
  it("結び直しが通れば、新しいトークンで呼び直し、紐付けは外れない", async () => {
    const r = await setup();
    expect((await r.call("child_bind")).isError).toBe(false);
    r.state.revoked.add(r.tokenOf(1));
    const res = await r.call("report_progress", { text: "x" });
    expect(res.isError).toBe(false);
    expect(r.state.binds).toBe(2);
    expect(await r.names()).toContain("report_progress");
    expect(await r.names()).not.toContain("child_bind");
  });

  it("結び直しが通らなければ、紐付けが外れたと出す（MCP の接続の問題ではない）", async () => {
    const r = await setup();
    expect((await r.call("child_bind")).isError).toBe(false);
    r.state.revoked.add(r.tokenOf(1));
    r.state.rebindAllowed = false;
    expect((await r.call("report_progress", { text: "x" })).body.code).toBe("unauthenticated");
    expect(await r.names()).toEqual(["child_bind", "whoami"]);
    const lost = await r.call("report_progress", { text: "x" });
    expect(lost.isError).toBe(true);
    expect(lost.body.code).toBe("binding_lost");
    expect(lost.body.cause).toContain("紐付けが外れた");
    expect(lost.body.cause).toContain("MCP の接続は切れていない");
  });

  it("外れたあとでも、child_bind を引数なしで呼べば戻る", async () => {
    const r = await setup();
    await r.call("child_bind");
    r.state.revoked.add(r.tokenOf(1));
    r.state.rebindAllowed = false;
    await r.call("report_progress", { text: "x" });
    r.state.rebindAllowed = true;
    expect((await r.call("child_bind")).isError).toBe(false);
    expect((await r.call("report_progress", { text: "x" })).isError).toBe(false);
  });

  it("最初から紐付いていないときは、これまでどおり not_bound", async () => {
    const r = await setup();
    expect((await r.call("report_progress", { text: "x" })).body.code).toBe("not_bound");
  });
});
