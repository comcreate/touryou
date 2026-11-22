import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { proofOf } from "../src/identity.js";
import { openPendingStdioSession } from "../src/stdio.js";

// daemon の 401 を fake の fetch で返し、watch が資格情報を空にして紐付け待ちに戻り、bind し直せる（結び目の試験）。
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("紐付け待ちのセッションで、daemon の 401 のあと bind し直す", () => {
  it("401 で child_bind が戻り、出し直したコードで紐付け、子の道具が使える", async () => {
    const dir = mkdtempSync(join(tmpdir(), "touryou-relogin-"));
    made.push(dir);
    const identity = { daemonId: "a".repeat(32), secret: "b".repeat(64) };
    const identityPath = join(dir, "daemon-identity");
    writeFileSync(identityPath, JSON.stringify({ version: 1, ...identity }), { mode: 0o600 });
    chmodSync(identityPath, 0o600);
    const daemonUrl = "http://127.0.0.1:45678";
    let binds = 0;
    let requests = 0;
    const seenTokens: string[] = [];
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-touryou-daemon-id": identity.daemonId },
      });
    const fakeFetch = (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === "/v1/identity") {
        const nonce = url.searchParams.get("nonce") ?? "";
        return json(200, {
          ok: true,
          value: {
            daemonId: identity.daemonId,
            proof: proofOf(identity, "127.0.0.1:45678", nonce),
          },
        });
      }
      if (url.pathname === "/v1/bind") {
        binds++;
        return json(200, {
          ok: true,
          value: { nodeId: "a", token: `tok-${binds}-${"x".repeat(40)}` },
        });
      }
      // 本物の daemon の whoami は、トークンのロールとノードの ID を返す（child_bind の戻りのロールの切り替えが使う）。
      // 失効の確認と、要求の数・トークンの記録の対象にしない（この試験は、紐付けのあとの最初の要求が 401 になる場面）
      if (url.pathname === "/v1/whoami")
        return json(200, { ok: true, value: { role: "child", nodeId: "a" } });
      const auth = String(
        (init?.headers as Record<string, string> | undefined)?.authorization ?? "",
      );
      seenTokens.push(auth);
      requests++;
      // 1 つ目のトークンは失効している（daemon の 401）
      if (auth.includes("tok-1-")) {
        return json(401, {
          ok: false,
          error: { code: "unauthenticated", cause: "失効", nextActions: ["出し直す"] },
        });
      }
      return json(200, { ok: true, value: { accepted: true } });
    }) as unknown as typeof fetch;

    const server = openPendingStdioSession(
      { daemonUrl, identityPath, stateDir: dir },
      { stderr: () => {} },
      { fetch: fakeFetch, cwd: () => "/w/trees/a" },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };

    expect(await names()).toEqual(["child_bind", "whoami"]);
    expect((await call("child_bind", { nodeId: "a", bindCode: "X" })).isError).not.toBe(true);
    expect(await names()).toContain("report_progress");
    const denied = await call("report_progress", { text: "x" });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0]?.text ?? "{}").code).toBe("unauthenticated");
    // 紐付け待ちに戻っている
    expect(await names()).toEqual(["child_bind", "whoami"]);
    expect((await call("child_bind", { nodeId: "a", bindCode: "Y" })).isError).not.toBe(true);
    expect((await call("report_progress", { text: "x" })).isError).not.toBe(true);
    expect(binds).toBe(2);
    expect(requests).toBeGreaterThanOrEqual(2);
  });
});
