import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { runBin } from "../src/bin.js";
import { runHook } from "../src/hook.js";

// `touryou hook`。従来の touryou-hook.mjs（削除済み。同じ試験を、ここに移した）と同じ判定・終了コード。
const TOKEN = "t".repeat(32);
const ENV = { TOURYOU_DAEMON_URL: "http://127.0.0.1:1", TOURYOU_NODE_TOKEN: TOKEN };
const pre = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "s",
  tool_name: "Write",
  tool_input: {},
});
const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "s" });
const reply = (status: number, json: unknown): typeof fetch =>
  (async () => ({ status, json: async () => json })) as unknown as typeof fetch;
const never: typeof fetch = () => {
  throw new Error("送らない");
};
const down: typeof fetch = () => Promise.reject(new Error("x"));

describe("環境変数", () => {
  it("両方ないときは、素通しし、何も出さない（touryou と関係のないセッションに表示を出さない）", async () => {
    const r = await runHook({ env: {}, input: pre, fetchImpl: never });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("片方だけのときは、拒否する（終了コード 2）。対処が入り、トークンの値は出ない。TOURYOU_ROOT_TOKEN があっても拒否のまま", async () => {
    const secret = "s3cret-".repeat(5);
    const urlOnly = await runHook({
      env: { TOURYOU_DAEMON_URL: ENV.TOURYOU_DAEMON_URL, TOURYOU_ROOT_TOKEN: secret },
      input: pre,
      fetchImpl: never,
    });
    expect(urlOnly.code).toBe(2);
    expect(urlOnly.stderr).toMatch(/片方だけ/);
    expect(urlOnly.stderr).toMatch(/unset TOURYOU_DAEMON_URL/);
    expect(urlOnly.stderr).not.toContain(secret);
    const tokenOnly = await runHook({
      env: { TOURYOU_NODE_TOKEN: TOKEN },
      input: pre,
      fetchImpl: never,
    });
    expect(tokenOnly.code).toBe(2);
    expect(tokenOnly.stderr).toMatch(/unset TOURYOU_NODE_TOKEN/);
    expect(tokenOnly.stderr).not.toContain(TOKEN);
  });

  it("片方だけでも、受動のイベント（Stop）は止めない", async () => {
    const r = await runHook({ env: { TOURYOU_NODE_TOKEN: TOKEN }, input: stop, fetchImpl: never });
    expect(r.code).toBe(0);
  });
});

describe("判定", () => {
  it("許可は終了コード 0、拒否は終了コード 2 と理由。URL とトークンを使って送る", async () => {
    let seen: { url: string; auth: string; body: string } | undefined;
    const allow = await runHook({
      env: { ...ENV, TOURYOU_DAEMON_URL: "http://127.0.0.1:9/" },
      input: pre,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = {
          url,
          auth: (init.headers as Record<string, string>).authorization ?? "",
          body: String(init.body),
        };
        return { status: 200, json: async () => ({ ok: true, value: { decision: "allow" } }) };
      }) as unknown as typeof fetch,
    });
    expect(allow).toEqual({ code: 0, stderr: "" });
    expect(seen).toEqual({ url: "http://127.0.0.1:9/v1/hook", auth: `Bearer ${TOKEN}`, body: pre });
    const deny = await runHook({
      env: ENV,
      input: pre,
      fetchImpl: reply(200, { ok: true, value: { decision: "deny", reason: "範囲外です" } }),
    });
    expect(deny).toEqual({ code: 2, stderr: "範囲外です" });
  });

  it("PreToolUse はフェイルクローズ: 届かない・200 以外・形の違う応答・JSON でない入力は、拒否", async () => {
    const cases: (typeof fetch)[] = [
      () => Promise.reject(new TypeError("fetch failed")),
      reply(413, { ok: false, error: { cause: "本文が大きすぎる" } }),
      reply(500, undefined),
      reply(200, { ok: true, value: { decision: "maybe" } }),
    ];
    for (const fetchImpl of cases) {
      const r = await runHook({ env: ENV, input: pre, fetchImpl });
      expect(r.code, r.stderr).toBe(2);
    }
    const big = await runHook({ env: ENV, input: pre, fetchImpl: cases[1] as typeof fetch });
    expect(big.stderr).toMatch(/本文が大きすぎる/);
    expect((await runHook({ env: ENV, input: "{", fetchImpl: down })).code).toBe(2);
  });

  it("Stop・PostToolUse は、失敗しても止めない（終了コード 0。標準エラーに出す）", async () => {
    const r = await runHook({ env: ENV, input: stop, fetchImpl: down });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/Stop/);
  });

  it("イベント名が欠けている・未知・表記が違う入力は、拒否する（フェイルクローズ）", async () => {
    const ok = reply(200, { ok: true, value: { decision: "deny", reason: "x" } });
    for (const name of [undefined, "Unknown", "pretooluse"]) {
      const input = JSON.stringify({ hook_event_name: name, session_id: "s", tool_name: "Write" });
      expect((await runHook({ env: ENV, input, fetchImpl: down })).code, String(name)).toBe(2);
      expect((await runHook({ env: ENV, input, fetchImpl: ok })).code, String(name)).toBe(2);
    }
  });

  it("受動のイベントは、入力が壊れていて daemon が 400 を返しても、終了コード 0", async () => {
    for (const name of ["Stop", "PostToolUse"]) {
      const input = JSON.stringify({ hook_event_name: name });
      const r = await runHook({
        env: ENV,
        input,
        fetchImpl: reply(400, { ok: false, error: { cause: "x" } }),
      });
      expect(r.code, name).toBe(0);
    }
  });

  it("時間切れも拒否（応答しない受け口）", async () => {
    const server = createServer(() => {});
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    try {
      const r = await runHook({
        env: {
          ...ENV,
          TOURYOU_DAEMON_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        },
        input: pre,
        timeoutMs: 100,
      });
      expect(r.code).toBe(2);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("入力が大きすぎて切れたとき（読み取りの上限）", () => {
  // 切れた入力は、先頭の部分だけ（JSON としては壊れている）。イベント名は、先頭の部分から拾う
  const head = (name: string): string =>
    `{"session_id":"s","transcript_path":"t","cwd":"c","hook_event_name":"${name}","tool_name":"Bash","tool_response":"xxxxxxxx`;
  it("受動のイベント（PostToolUse・Stop）は、止めない（終了コード 0）。daemon には送らない", async () => {
    for (const name of ["PostToolUse", "Stop"]) {
      const r = await runHook({ env: ENV, input: head(name), truncated: true, fetchImpl: never });
      expect(r.code, name).toBe(0);
      expect(r.stderr, name).toMatch(/大きすぎて/);
    }
  });
  it("判定するイベント（PreToolUse・未知・名前が拾えない）は、拒否する（終了コード 2）", async () => {
    for (const input of [head("PreToolUse"), head("Unknown"), "{ここに名前がない"]) {
      const r = await runHook({ env: ENV, input, truncated: true, fetchImpl: never });
      expect(r.code, input).toBe(2);
    }
  });
  it("環境変数が両方ないときは、切れていても素通し", async () => {
    const r = await runHook({
      env: {},
      input: head("PreToolUse"),
      truncated: true,
      fetchImpl: never,
    });
    expect(r.code).toBe(0);
  });
});

describe("touryou hook（runBin）", () => {
  const isTTY = { stdin: false, stdout: false };
  const hookIn =
    (text: string, truncated = false) =>
    async () => ({ text, truncated });

  it("標準入力と環境変数だけを使い、終了コードと標準エラーを返す（人間のトークンは要らない）", async () => {
    const r = await runBin(["hook"], {
      env: ENV,
      isTTY,
      readStdin: async () => pre,
      fetch: reply(200, { ok: true, value: { decision: "deny", reason: "範囲外です" } }),
    });
    expect(r).toEqual({ exitCode: 2, stdout: "", stderr: "範囲外です\n" });
    const ok = await runBin(["hook"], {
      env: ENV,
      isTTY,
      readStdin: async () => pre,
      fetch: reply(200, { ok: true, value: { decision: "allow" } }),
    });
    expect(ok).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("環境変数がなければ（env が空）、人間のトークンがなくても、終了コード 0（/setup 前・touryou の子でない Mac）", async () => {
    const r = await runBin(["hook"], { env: {}, isTTY, readHookStdin: hookIn(pre), fetch: never });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("標準入力を読めなかったときは、PreToolUse 相当として拒否する（終了コード 2）。環境変数がなければ素通し", async () => {
    const broken = async (): Promise<{ text: string; truncated: boolean }> => {
      throw new Error("EIO");
    };
    const r = await runBin(["hook"], { env: ENV, isTTY, readHookStdin: broken, fetch: never });
    expect(r.exitCode).toBe(2);
    const open = await runBin(["hook"], { env: {}, isTTY, readHookStdin: broken, fetch: never });
    expect(open.exitCode).toBe(0);
  });

  it("2MiB を超えて切れた入力: 受動のイベントは 0、PreToolUse は 2", async () => {
    const big = (name: string) =>
      `{"hook_event_name":"${name}","tool_response":"${"x".repeat(1000)}`;
    const post = await runBin(["hook"], {
      env: ENV,
      isTTY,
      readHookStdin: hookIn(big("PostToolUse"), true),
      fetch: never,
    });
    expect(post.exitCode).toBe(0);
    const prev = await runBin(["hook"], {
      env: ENV,
      isTTY,
      readHookStdin: hookIn(big("PreToolUse"), true),
      fetch: never,
    });
    expect(prev.exitCode).toBe(2);
  });

  it("daemon が応答にトークンの値を入れても、出力に出さない（redact）", async () => {
    const r = await runBin(["hook"], {
      env: ENV,
      isTTY,
      readHookStdin: hookIn(pre),
      fetch: reply(200, { ok: true, value: { decision: "deny", reason: `token=${TOKEN}` } }),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).not.toContain(TOKEN);
    expect(r.stderr).toContain("***");
  });
});

describe("実プロセス（ビルド済みの bin。`pnpm build` のあと）", () => {
  const dist = new URL("../dist/hook.js", import.meta.url);
  const bin = new URL("../dist/bin.js", import.meta.url).pathname;
  // dist がない・古い（hook を持たない）ときだけ、飛ばす。`pnpm check`（CI）は、build のあとに動くので、必ず実行される
  const built = existsSync(dist);
  const run = (env: Record<string, string>, input = pre) =>
    spawnSync(process.execPath, [bin, "hook"], {
      input,
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    });

  it.skipIf(!built)("daemon が止まっている（接続できない）と、PreToolUse は終了コード 2", () => {
    const p = run(ENV);
    expect(p.status).toBe(2);
    expect(p.stderr).toMatch(/届かない/);
  });

  it.skipIf(!built)(
    "環境変数がなければ（人間のトークンもなく）、終了コード 0 で、何も出さない",
    () => {
      const p = run({});
      expect(p.status).toBe(0);
      expect(p.stderr).toBe("");
    },
  );

  it.skipIf(!built)("トークンの値は、標準エラーにも標準出力にも出ない", () => {
    const p = run(ENV);
    expect(p.stderr).not.toContain(TOKEN);
    expect(p.stdout).not.toContain(TOKEN);
  });
});

describe("承認済みの範囲の拡張（#91。トークンのある形）", () => {
  it("permit: extension の許可は、明示の許可を返す。permit のない許可は何も出さない", async () => {
    const r = await runHook({
      env: ENV,
      input: pre,
      fetchImpl: reply(200, { ok: true, value: { decision: "allow", permit: "extension" } }),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout ?? "")).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
    const plain = await runHook({
      env: ENV,
      input: pre,
      fetchImpl: reply(200, { ok: true, value: { decision: "allow" } }),
    });
    expect(plain).toEqual({ code: 0, stderr: "" });
  });
});
