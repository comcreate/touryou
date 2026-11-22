import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { proofOf } from "../src/identity.js";
import { openPendingStdioSession, type StdioDeps } from "../src/stdio.js";

// `claude attach` で mcp が入れ替わった子（メモリのトークンがなく、コードのファイルも使用済み）が、
// セッション ID・作業ツリー・ノード ID だけで、人の手間なしにつなぎ直せる（#145）。
// 「attach のあとも CLAUDE_CODE_SESSION_ID が同じか」は、ここでは確かめない（docs/manual-verification-checklist.md の実機の確認）。
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const setup = async (opts: { rebindStatus: number; deps?: StdioDeps }) => {
  const dir = mkdtempSync(join(tmpdir(), "touryou-rebind-"));
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
  const bindBodies: Record<string, unknown>[] = [];
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
      bindBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (opts.rebindStatus !== 200) {
        return json(401, {
          ok: false,
          error: { code: "unauthenticated", cause: "bind コードが無効", nextActions: ["x"] },
        });
      }
      return json(200, { ok: true, value: { nodeId: "a", token: `tok-${"x".repeat(40)}` } });
    }
    // 本物の daemon の whoami は、トークンのロールとノードの ID を返す（child_bind の戻りのロールの切り替えが使う）
    if (url.pathname === "/v1/whoami") return json(200, { ok: true, value: { role: "child", nodeId: "a" } });
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
      ...opts.deps,
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
  return { bindBodies, names, call };
};

describe("attach のあとのつなぎ直し（child_bind を引数なしで）", () => {
  it("コードのファイルがなくても、セッション ID・作業ツリー・ノード ID で紐付け直し、報告できる", async () => {
    const r = await setup({ rebindStatus: 200 });
    expect(await r.names()).toEqual(["child_bind", "whoami"]);
    expect((await r.call("child_bind")).isError).not.toBe(true);
    expect(await r.names()).toContain("report_progress");
    expect((await r.call("report_progress", { text: "x" })).isError).not.toBe(true);
    expect(r.bindBodies).toHaveLength(1);
    const body = r.bindBodies[0] ?? {};
    expect(body).toMatchObject({ nodeId: "a", sessionId: "s-1" });
    expect(typeof body.cwd).toBe("string");
    expect("bindCode" in body).toBe(false);
  });

  it("daemon が断ったら、親にコードの出し直しを頼む案内に落ちる（紐付け待ちのまま）", async () => {
    const r = await setup({ rebindStatus: 401 });
    const res = await r.call("child_bind");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]?.text ?? "{}").code).toBe("bind_code_file_unavailable");
    expect(await r.names()).toEqual(["child_bind", "whoami"]);
  });

  it("セッション ID がなければ、つなぎ直しを試みず、案内に落ちる", async () => {
    const r = await setup({ rebindStatus: 200, deps: { sessionId: "" } });
    const res = await r.call("child_bind");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]?.text ?? "{}").code).toBe("bind_code_file_unavailable");
    expect(r.bindBodies).toHaveLength(0);
  });
});
