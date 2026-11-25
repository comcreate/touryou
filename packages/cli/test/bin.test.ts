import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBin } from "../src/bin.js";

const TOKEN = "human-token-human-token-human-token-1234";
const ENV = {
  TOURYOU_DAEMON_URL: "http://127.0.0.1:7777",
  TOURYOU_HUMAN_TOKEN: TOKEN,
  TOURYOU_CLI_ALLOW_UNVERIFIED: "1",
};
const TTY = { stdin: false, stdout: false };
/** 設定が見つからない場所（実機の cwd の上にある設定を拾わない）。環境変数だけで動く試験に付ける */
const NO_CONFIG = { cwd: "/work/none", exists: () => false };

/** 偽の窓口: POST /v1/request の要求を記録して、決まった応答を返す。 */
const fakeFetch = (value: unknown) => {
  const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ ok: true, value }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { f, seen };
};

describe("touryou（bin）", () => {
  it("環境変数で受けた窓口・トークンで POST /v1/request を呼ぶ。requestId はそのまま。出力にトークンを出さない", async () => {
    const { f, seen } = fakeFetch({ unbound: true, duplicate: false });
    const r = await runBin(["hook-unbind", "a", "--request-id", "again-1"], {
      ...NO_CONFIG,
      env: ENV,
      isTTY: TTY,
      fetch: f,
    });
    expect(r.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://127.0.0.1:7777/v1/request");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.body).toMatchObject({
      requestId: "again-1",
      operation: "node.hookUnbind",
      params: { nodeId: "a" },
    });
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("daemon（偽の窓口）が、応答にトークンを入れても、出力・エラーには出さない（*** に置き換える）", async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: "boom", cause: `echo ${TOKEN} back`, nextActions: [`use ${TOKEN}`] },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const r = await runBin(["hook-unbind", "a"], { ...NO_CONFIG, env: ENV, isTTY: TTY, fetch: f });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(r.stderr).toContain("echo *** back");
  });

  it("TOURYOU_DAEMON_URL・TOURYOU_HUMAN_TOKEN がなければ、終了コード 2（何も送らない）。--token の引数は受けない", async () => {
    const { f, seen } = fakeFetch({});
    for (const env of [
      { ...ENV, TOURYOU_DAEMON_URL: undefined },
      { ...ENV, TOURYOU_HUMAN_TOKEN: undefined },
      { ...ENV, TOURYOU_HUMAN_TOKEN: "" },
    ]) {
      const r = await runBin(["hook-unbind", "a"], { ...NO_CONFIG, env, isTTY: TTY, fetch: f });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("TOURYOU_HUMAN_TOKEN");
    }
    const t = await runBin(["hook-unbind", "a", "--token", TOKEN], {
      ...NO_CONFIG,
      env: ENV,
      isTTY: TTY,
      fetch: f,
    });
    expect(t.exitCode).toBe(2);
    expect(seen).toEqual([]);
  });

  it("TOURYOU_DAEMON_CONFIG がなければ、動かない（TOURYOU_CLI_ALLOW_UNVERIFIED がちょうど 1 のときだけ例外）", async () => {
    const { f, seen } = fakeFetch({});
    for (const allow of [undefined, "true", "", "0"]) {
      const r = await runBin(["hook-unbind", "a"], {
        ...NO_CONFIG,
        env: { ...ENV, TOURYOU_CLI_ALLOW_UNVERIFIED: allow },
        isTTY: TTY,
        fetch: f,
      });
      expect(r.exitCode, String(allow)).toBe(2);
    }
    expect(seen).toEqual([]);
  });

  it("配布物（devBuild が false）では、TOURYOU_CLI_ALLOW_UNVERIFIED=1 でも動かない（何も送らない）", async () => {
    const { f, seen } = fakeFetch({ unbound: true, duplicate: false });
    const r = await runBin(["hook-unbind", "a"], {
      ...NO_CONFIG,
      env: { ...ENV, TOURYOU_CLI_ALLOW_UNVERIFIED: "1" },
      devBuild: false,
      isTTY: TTY,
      fetch: f,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/配布物では効かない/);
    expect(seen).toEqual([]);
  });

  it("TOURYOU_DAEMON_CONFIG があれば、トークンを送る前に身元を確かめる（秘密が読めなければ、トークンを送らない）", async () => {
    const { f, seen } = fakeFetch({ unbound: true, duplicate: false });
    const r = await runBin(["hook-unbind", "a"], {
      env: {
        ...ENV,
        TOURYOU_CLI_ALLOW_UNVERIFIED: undefined,
        TOURYOU_DAEMON_CONFIG: "/x/config.json",
      },
      isTTY: TTY,
      fetch: f,
      readFile: (p) => {
        if (p === "/x/config.json") return JSON.stringify({ stateDir: "/x/state" });
        throw new Error("no file");
      },
      sleep: async () => {},
    });
    expect(r.exitCode).toBe(1);
    expect(seen.some((s) => s.headers.authorization !== undefined)).toBe(false);
  });

  it("環境変数がなくても、cwd から上の .touryou/config.json の stateDir から窓口と人間のトークンを自分で読む（#115。touryou ui と同じ）。子の作業ツリーからも届く", async () => {
    for (const cwd of ["/work/repo/src/a", "/work/repo/.touryou/worktrees/c1/src"]) {
      const { f, seen } = fakeFetch({ unbound: true, duplicate: false });
      const reads: string[] = [];
      const r = await runBin(["reclaim", "a"], {
        env: { HOME: "/home/u" },
        cwd,
        exists: (p) => p === "/work/repo/.touryou/config.json",
        devBuild: false,
        isTTY: TTY,
        fetch: f,
        readFile: (p) => {
          if (p === "/work/repo/.touryou/config.json") return JSON.stringify({ stateDir: "/s" });
          throw new Error("no file");
        },
        readSecret: (p) => {
          reads.push(p);
          if (p === "/s/port") return "7777\n";
          if (p === "/s/human-token") return `${TOKEN}\n`;
          throw new Error("no file");
        },
        sleep: async () => {},
      });
      expect(reads.sort(), cwd).toEqual(["/s/human-token", "/s/port"]);
      // 「窓口・トークンがない」では止まらず、トークンを送る前の身元の確かめまで進む（身元の秘密がないので、トークンは送らない）
      expect(r.stderr, cwd).not.toMatch(/TOURYOU_DAEMON_URL がなく|TOURYOU_HUMAN_TOKEN がなく/);
      expect(seen.some((x) => x.headers.authorization !== undefined), cwd).toBe(false);
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
    }
  });

  it("設定が見つからない: 旧パス $HOME/.touryou/config.json へは戻らず、理由と直し方（/touryou:setup・--config）を出して止まる（終了コード 2・何も送らない）", async () => {
    const { f, seen } = fakeFetch({});
    const read: string[] = [];
    const r = await runBin(["reclaim", "a"], {
      env: { HOME: "/home/u" },
      cwd: "/work/other",
      exists: () => false,
      isTTY: TTY,
      fetch: f,
      readFile: (p) => {
        read.push(p);
        return JSON.stringify({ stateDir: "/s" });
      },
      readSecret: () => TOKEN,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("見つからない");
    expect(r.stderr).toContain("/touryou:setup");
    expect(r.stderr).toContain("--config");
    expect(read).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("環境変数がなくても、設定の stateDir から窓口と人間のトークンを自分で読む（#115。TOURYOU_DAEMON_CONFIG で指す）", async () => {
    const { f, seen } = fakeFetch({ unbound: true, duplicate: false });
    const reads: string[] = [];
    const r = await runBin(["reclaim", "a"], {
      env: { HOME: "/home/u", TOURYOU_DAEMON_CONFIG: "/home/u/.touryou/config.json" },
      devBuild: false,
      isTTY: TTY,
      fetch: f,
      readFile: (p) => {
        if (p === "/home/u/.touryou/config.json") return JSON.stringify({ stateDir: "/s" });
        throw new Error("no file");
      },
      readSecret: (p) => {
        reads.push(p);
        if (p === "/s/port") return "7777\n";
        if (p === "/s/human-token") return `${TOKEN}\n`;
        throw new Error("no file");
      },
      sleep: async () => {},
    });
    expect(reads.sort()).toEqual(["/s/human-token", "/s/port"]);
    // 「窓口・トークンがない」では止まらず、トークンを送る前の身元の確かめまで進む（身元の秘密がないので、トークンは送らない）
    expect(r.stderr).not.toMatch(/TOURYOU_DAEMON_URL がなく|TOURYOU_HUMAN_TOKEN がなく/);
    expect(seen.some((x) => x.headers.authorization !== undefined)).toBe(false);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("設定から窓口を読めない（port がない・形が違う）ときは、終了コード 2 で、何も送らない", async () => {
    const { f, seen } = fakeFetch({});
    for (const port of [undefined, "abc", "70000"]) {
      const r = await runBin(["reclaim", "a"], {
        env: { HOME: "/home/u", TOURYOU_DAEMON_CONFIG: "/home/u/.touryou/config.json" },
        isTTY: TTY,
        fetch: f,
        readFile: () => JSON.stringify({ stateDir: "/s" }),
        readSecret: (p) => {
          if (p === "/s/port" && port !== undefined) return port;
          if (p === "/s/human-token") return TOKEN;
          throw new Error("no file");
        },
      });
      expect(r.exitCode, String(port)).toBe(2);
      expect(r.stderr).toContain("stateDir の port");
    }
    expect(seen).toEqual([]);
  });

  it("cli が mcp から読むのは @touryou/mcp/relay だけ。relay・identity は MCP SDK・zod を import しない", () => {
    const here = fileURLToPath(new URL("../src", import.meta.url));
    for (const f of readdirSync(here)) {
      const text = readFileSync(join(here, f), "utf8");
      for (const m of text.matchAll(/from\s+["'](@touryou\/mcp[^"']*)["']/g)) {
        expect(m[1], f).toBe("@touryou/mcp/relay");
      }
    }
    const mcp = fileURLToPath(new URL("../../mcp/src", import.meta.url));
    for (const f of ["relay-entry.ts", "relay.ts", "identity.ts"]) {
      const text = readFileSync(join(mcp, f), "utf8");
      expect(text, f).not.toMatch(/@modelcontextprotocol|from\s+["']zod["']/);
      for (const m of text.matchAll(/from\s+["'](\.[^"']*)["']/g)) {
        expect(["./identity.js", "./relay.js"], `${f}: ${m[1]}`).toContain(m[1]);
      }
    }
  });
});
