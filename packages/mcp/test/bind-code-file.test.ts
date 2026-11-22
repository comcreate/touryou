/**
 * 紐付けのコードのファイル: `child_bind` を引数なしで呼ぶと、mcp が作業ツリーの git のディレクトリのファイルを読む。
 * 読む前の確かめ（リンクでない・持ち主・0600）と、bind のあとの削除。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { BIND_CODE_FILE, readCodeFile } from "../src/bind-code-file.js";
import { proofOf } from "../src/identity.js";
import { openPendingStdioSession } from "../src/stdio.js";

const CODE = "0123456789ABCDEFGHJKMNPQRS";
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tree = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-mcp-bcf-")));
  made.push(base);
  const gitDir = join(base, "repo", ".git", "worktrees", "a");
  mkdirSync(gitDir, { recursive: true });
  const wt = join(base, "wt", "a");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${gitDir}\n`);
  const codePath = join(gitDir, BIND_CODE_FILE);
  return { base, gitDir, wt, codePath };
};
const putCode = (path: string, code = CODE, mode = 0o600) => {
  writeFileSync(path, `${code}\n`, { mode });
  chmodSync(path, mode);
};

describe("コードのファイルを読む前の確かめ", () => {
  it("0600・自分の持ち主・通常のファイルなら読む", () => {
    const t = tree();
    putCode(t.codePath);
    const r = readCodeFile(t.wt);
    expect(r.ok && r.code).toBe(CODE);
  });

  it("権限が 0600 でない・持ち主が違う・リンク・ない、は読まない", () => {
    const t = tree();
    putCode(t.codePath, CODE, 0o644);
    expect(readCodeFile(t.wt)).toMatchObject({ ok: false, reason: "unsafe" });
    chmodSync(t.codePath, 0o600);
    expect(readCodeFile(t.wt, { uid: () => 99999 })).toMatchObject({ ok: false, reason: "unsafe" });
    rmSync(t.codePath);
    const real = join(t.base, "real");
    putCode(real);
    symlinkSync(real, t.codePath);
    expect(readCodeFile(t.wt)).toMatchObject({ ok: false, reason: "unsafe" });
    rmSync(t.codePath);
    expect(readCodeFile(t.wt)).toMatchObject({ ok: false, reason: "missing" });
  });
});

describe("child_bind を引数なしで呼ぶ（紐付け待ちのセッション）", () => {
  const session = async (t: ReturnType<typeof tree>, bindStatus: () => number) => {
    const identity = { daemonId: "a".repeat(32), secret: "b".repeat(64) };
    const identityPath = join(t.base, "daemon-identity");
    writeFileSync(identityPath, JSON.stringify({ version: 1, ...identity }), { mode: 0o600 });
    chmodSync(identityPath, 0o600);
    const sent: Record<string, unknown>[] = [];
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
            proof: proofOf(identity, "127.0.0.1:45679", nonce),
          },
        });
      }
      if (url.pathname === "/v1/bind") {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const status = bindStatus();
        return status === 200
          ? json(200, { ok: true, value: { nodeId: "a", token: `tok-${"x".repeat(40)}` } })
          : json(status, {
              ok: false,
              error: { code: "unauthenticated", cause: "x", nextActions: ["y"] },
            });
      }
      // 本物の daemon の whoami は、トークンのロールとノードの ID を返す（child_bind の戻りのロールの切り替えが使う）
      if (url.pathname === "/v1/whoami")
        return json(200, { ok: true, value: { role: "child", nodeId: "a" } });
      return json(200, { ok: true, value: { accepted: true } });
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const server = openPendingStdioSession(
      { daemonUrl: "http://127.0.0.1:45679", identityPath, stateDir: t.base },
      { stderr: (x) => logs.push(x) },
      { fetch: fakeFetch, cwd: () => t.wt, markerNodeId: "a" },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const bind = async (args: Record<string, unknown> = {}) =>
      (await client.callTool({ name: "child_bind", arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
    return { bind, sent, logs, client };
  };

  it("印のノードの ID とファイルのコードで送り、通ったらファイルを消す。結果にも記録にもコードを出さない", async () => {
    const t = tree();
    putCode(t.codePath);
    const s = await session(t, () => 200);
    const r = await s.bind();
    expect(r.isError).not.toBe(true);
    expect(JSON.parse(r.content[0]?.text ?? "{}")).toMatchObject({ bound: true, nodeId: "a" });
    expect(s.sent[0]).toMatchObject({ nodeId: "a", bindCode: CODE, cwd: t.wt });
    expect(existsSync(t.codePath)).toBe(false);
    expect(r.content[0]?.text).not.toContain(CODE);
    expect(s.logs.join("")).not.toContain(CODE);
  });

  it("通らなかったとき: 形の正しいコードは残す（daemon が期限・停止で消す）。形の正しくないコードは消す。やり直しの手順を返す", async () => {
    const t = tree();
    putCode(t.codePath);
    const s = await session(t, () => 401);
    const r = await s.bind();
    expect(r.isError).toBe(true);
    const e = JSON.parse(r.content[0]?.text ?? "{}") as { code: string; nextActions: string[] };
    expect(e.code).toBe("bind_failed");
    expect(e.nextActions.join("")).toContain("紐付けをやり直して");
    expect(existsSync(t.codePath)).toBe(true);
    putCode(t.codePath, "not-a-code");
    expect((await s.bind()).isError).toBe(true);
    expect(existsSync(t.codePath)).toBe(false);
  });

  it("ファイルがない・安全でないときは daemon に送らず、やり直しを頼む手順を返す。片方だけの引数は受けない", async () => {
    const t = tree();
    const s = await session(t, () => 200);
    const r = await s.bind();
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]?.text ?? "{}").code).toBe("bind_code_file_unavailable");
    putCode(t.codePath, CODE, 0o640);
    expect((await s.bind()).isError).toBe(true);
    expect(s.sent).toHaveLength(0);
    expect((await s.bind({ nodeId: "a" })).isError).toBe(true);
    expect(s.sent).toHaveLength(0);
  });

  it("道具の入力の形: 引数は任意（required なし）", async () => {
    const t = tree();
    const s = await session(t, () => 200);
    const tool = (await s.client.listTools()).tools.find((x) => x.name === "child_bind");
    expect(tool?.inputSchema.required).toBeUndefined();
  });
});

describe("git のディレクトリそのものがリンク", () => {
  it("gitdir: の先がリンクなら、コードのファイルを読まない", () => {
    const t = tree();
    const real = join(t.base, "realgit");
    mkdirSync(real);
    putCode(join(real, BIND_CODE_FILE));
    const link = join(t.base, "linkgit");
    symlinkSync(real, link);
    writeFileSync(join(t.wt, ".git"), `gitdir: ${link}\n`);
    expect(readCodeFile(t.wt)).toMatchObject({ ok: false, reason: "missing" });
  });
});
