import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { proofOf } from "../src/identity.js";
import { createNodeCredentialStore } from "../src/node-credential.js";
import { notificationText } from "../src/notify-socket.js";
import { createAutoBindWake, openPendingStdioSession } from "../src/stdio.js";
import { flush, manualClock } from "./manual-clock.js";

// #255: 紐付け待ちの mcp が、子の AI にも人にも打たせず、自分で紐付けを戻し、受信箱に 1 行書いて子を起こす。
// 待ち・fetch・コードのファイル・受信箱への書き込みを差し替えて、daemon もソケットもなしで確かめる。
const CODE = "0123456789ABCDEFGHJKMNPQRS";
// 親が出し直した、別のコード（形は同じ）
const CODE2 = "ZYXWVTSRQPNMKJHGFEDCBA9876";
const TOKEN = `tok-${"x".repeat(40)}`;
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

type BindStatus = 200 | 401 | 429;

const setup = async (opts: {
  withCodeFile?: boolean;
  rebindStatus?: BindStatus;
  /** コードつきの紐付けに daemon が返す状態（既定は通す）。 */
  codeStatus?: BindStatus;
  /** 最初の何回かの whoami を失敗させる（紐付いたあとの処理の失敗の試験）。 */
  whoamiFailures?: number;
}) => {
  const dir = mkdtempSync(join(tmpdir(), "touryou-autobind-"));
  made.push(dir);
  const identity = { daemonId: "a".repeat(32), secret: "b".repeat(64) };
  const identityPath = join(dir, "daemon-identity");
  writeFileSync(identityPath, JSON.stringify({ version: 1, ...identity }), { mode: 0o600 });
  chmodSync(identityPath, 0o600);
  // 子の作業ツリー: `.git` のファイルが、git のディレクトリを指す。コードのファイルは、その中
  const tree = join(dir, "tree");
  const gitdir = join(dir, "gitdir");
  mkdirSync(tree);
  mkdirSync(gitdir);
  writeFileSync(join(tree, ".git"), `gitdir: ${gitdir}\n`);
  const codePath = join(gitdir, "touryou-bind-code");
  const writeCode = (code = CODE) => {
    writeFileSync(codePath, `${code}\ndaemon=${identity.daemonId}\n`, { mode: 0o600 });
    chmodSync(codePath, 0o600);
  };
  if (opts.withCodeFile === true) writeCode();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-touryou-daemon-id": identity.daemonId },
    });
  const bindBodies: Record<string, unknown>[] = [];
  let rebindStatus: BindStatus = opts.rebindStatus ?? 200;
  let codeStatus: BindStatus = opts.codeStatus ?? 200;
  const whoami = { calls: 0, failures: opts.whoamiFailures ?? 0 };
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
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bindBodies.push(body);
      // コードつきは通す。コードなし（結び直し）は、試験が決めた状態
      const status = body.bindCode === undefined ? rebindStatus : codeStatus;
      if (status === 429) return json(429, { ok: false, error: { code: "rateLimited" } });
      if (status !== 200) {
        return json(401, {
          ok: false,
          error: { code: "unauthenticated", cause: "x", nextActions: ["x"] },
        });
      }
      return json(200, { ok: true, value: { nodeId: "a", token: TOKEN } });
    }
    if (url.pathname === "/v1/whoami") {
      whoami.calls += 1;
      if (whoami.failures > 0) {
        whoami.failures -= 1;
        return json(503, {
          ok: false,
          error: { code: "unavailable", cause: "x", nextActions: ["x"] },
        });
      }
      return json(200, { ok: true, value: { role: "child", nodeId: "a" } });
    }
    return json(200, { ok: true, value: { accepted: true } });
  }) as unknown as typeof fetch;
  const clock = manualClock();
  const abort = new AbortController();
  const credentials = createNodeCredentialStore();
  const logs: string[] = [];
  // 起こす関数は本物（固定の 1 行を作って書く）。書き込みだけを、書かれた中身の記録に差し替える
  const written: string[] = [];
  const woke = {
    get count() {
      return written.length;
    },
  };
  const wake = createAutoBindWake(
    { path: "/inbox.sock" },
    { stderr: (t) => logs.push(t) },
    async (_target, text) => {
      written.push(text);
      return { written: true };
    },
  );
  const server = openPendingStdioSession(
    { daemonUrl: "http://127.0.0.1:45678", identityPath, stateDir: dir },
    { stderr: (t) => logs.push(t) },
    {
      fetch: fakeFetch,
      cwd: () => tree,
      markerNodeId: "a",
      sessionId: "s-1",
      credentials,
      codeFile: { acl: () => undefined },
      autoBind: {
        sleep: clock.sleep,
        signal: abort.signal,
        wake,
      },
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
  return {
    bindBodies,
    credentials,
    logs,
    woke,
    written,
    whoami,
    clock,
    names,
    call,
    codePath,
    writeCode,
    setRebindStatus: (s: BindStatus) => {
      rebindStatus = s;
    },
    setCodeStatus: (s: BindStatus) => {
      codeStatus = s;
    },
    stop: async () => {
      abort.abort();
      await clock.tick();
    },
  };
};

describe("自動の紐付け（紐付け待ちの mcp が、自分で戻す）", () => {
  it("起動直後（コードのファイルなし・印あり）に、コードなしの結び直しを試し、通れば道具が切り替わって、1 行を 1 回だけ書く", async () => {
    const r = await setup({});
    await flush();
    expect(r.bindBodies).toHaveLength(1);
    expect(r.bindBodies[0]).toMatchObject({ nodeId: "a", sessionId: "s-1" });
    expect("bindCode" in (r.bindBodies[0] ?? {})).toBe(false);
    // 入れ物に入る（購読は、入れ物の変更で張り直される）
    expect(r.credentials.get()?.nodeId).toBe("a");
    expect(await r.names()).toContain("report_progress");
    expect(r.woke.count).toBe(1);
    // そのあとの確かめでは、もう何もしない（1 行は 1 回だけ）
    await r.clock.tick();
    await r.clock.tick();
    expect(r.bindBodies).toHaveLength(1);
    expect(r.woke.count).toBe(1);
    await r.stop();
  });

  it("最初の起動（コードのファイルあり）では、コードなしの結び直しを試さず、ファイルのコードを使って、ファイルを消す", async () => {
    const r = await setup({ withCodeFile: true });
    await flush();
    expect(r.bindBodies).toHaveLength(1);
    expect(r.bindBodies[0]).toMatchObject({ nodeId: "a", bindCode: CODE });
    expect(existsSync(r.codePath)).toBe(false);
    expect(r.credentials.get()?.nodeId).toBe("a");
    expect(await r.names()).toContain("report_progress");
    expect(r.woke.count).toBe(1);
    await r.stop();
  });

  it("結び直しが通らない間は、紐付け待ちのまま。ファイルが現れたら、次の確かめで使って紐付く", async () => {
    const r = await setup({ rebindStatus: 401 });
    await flush();
    expect(r.bindBodies).toHaveLength(1); // 起動直後の結び直し（失敗）
    expect(await r.names()).toEqual(["child_bind", "whoami"]);
    expect(r.woke.count).toBe(0);
    r.writeCode();
    await r.clock.tick(); // 確かめ 1: ファイルがある → 使う
    expect(r.bindBodies).toHaveLength(2);
    expect(r.bindBodies[1]).toMatchObject({ bindCode: CODE });
    expect(await r.names()).toContain("report_progress");
    expect(r.woke.count).toBe(1);
    await r.stop();
  });

  it("結び直しの失敗は倍々で間引かれる（429 を受けたら、さらに長く待つ）", async () => {
    const r = await setup({ rebindStatus: 429 });
    await flush();
    expect(r.bindBodies).toHaveLength(1);
    for (let i = 0; i < 9; i++) await r.clock.tick();
    expect(r.bindBodies).toHaveLength(1); // 上限（10 分 = 10 間隔）まで、daemon を叩かない
    await r.clock.tick();
    expect(r.bindBodies).toHaveLength(2);
    await r.stop();
  });

  it("子の AI の child_bind が、自動の紐付けと重なっても、失敗にならない（コードは 1 回しか送らない）", async () => {
    const r = await setup({ withCodeFile: true });
    // 自動の紐付けは、すでにコードを送っている最中。子の AI が同時に呼ぶ
    const res = await r.call("child_bind");
    expect(res.isError).not.toBe(true);
    expect(JSON.parse(res.content[0]?.text ?? "{}")).toMatchObject({ bound: true, nodeId: "a" });
    await flush();
    expect(r.bindBodies.filter((b) => b.bindCode !== undefined)).toHaveLength(1);
    expect(await r.names()).toContain("report_progress");
    await r.stop();
  });

  it("自動の紐付けが先に済んだあとに、子の AI が child_bind を呼んでも、失敗にならない（もう一度送らない）", async () => {
    const r = await setup({});
    await flush();
    expect(r.credentials.get()).toBeDefined();
    const res = await r.call("child_bind");
    expect(res.isError).not.toBe(true);
    expect(JSON.parse(res.content[0]?.text ?? "{}")).toMatchObject({ bound: true, nodeId: "a" });
    expect(r.bindBodies).toHaveLength(1);
    await r.stop();
  });

  it("コード・トークンは、ログにも道具の結果にも出ない。紐付け待ちに入った理由が、記録に出る", async () => {
    const r = await setup({ withCodeFile: true });
    await flush();
    const res = await r.call("child_bind");
    const all = `${r.logs.join("")}${JSON.stringify(res)}`;
    expect(all).not.toContain(CODE);
    expect(all).not.toContain(TOKEN);
    expect(r.logs.join("")).toContain('"event":"pendingBindEntered"');
    expect(r.logs.join("")).toContain('"reason":"startup"');
    await r.stop();
  });

  it("起こす 1 行は、固定の文で、1 回だけ書かれる（書かれた中身を見る。続く確かめでも増えない）", async () => {
    const r = await setup({});
    await flush();
    expect(r.written).toEqual([notificationText(0)]);
    for (let i = 0; i < 5; i++) await r.clock.tick();
    expect(r.written).toEqual([notificationText(0)]);
    expect(r.logs.join("")).toContain('"event":"autoBindWake","written":true');
    await r.stop();
  });

  it("紐付いた直後の処理（whoami）が失敗しても、次の確かめでその処理だけをやり直し、道具が切り替わって、1 行が 1 回書かれる", async () => {
    const r = await setup({ whoamiFailures: 1 });
    await flush();
    // 紐付けは通った（入れ物に値がある）が、道具は切り替わらず、まだ起こしていない
    expect(r.credentials.get()?.nodeId).toBe("a");
    expect(r.bindBodies).toHaveLength(1);
    expect(await r.names()).toEqual(["child_bind", "whoami"]);
    expect(r.written).toEqual([]);
    expect(r.logs.join("")).toContain('"event":"autoBindFinishFailed"');
    await r.clock.tick(); // 次の確かめ: 処理だけをやり直す
    expect(await r.names()).toContain("report_progress");
    expect(r.written).toEqual([notificationText(0)]);
    // 紐付けそのものは、やり直さない（daemon の紐付けは 1 回のまま）。処理が済んだあとは、daemon を叩かない
    expect(r.bindBodies).toHaveLength(1);
    const calls = r.whoami.calls;
    for (let i = 0; i < 4; i++) await r.clock.tick();
    expect(r.whoami.calls).toBe(calls);
    expect(r.written).toHaveLength(1);
    await r.stop();
  });

  it("紐付いた直後の処理が続けて失敗しても、やり直しの間隔は倍になる（紐付いている間に daemon を叩き続けない）", async () => {
    const r = await setup({ whoamiFailures: 99 });
    await flush();
    const at = () => r.whoami.calls;
    expect(at()).toBe(1);
    await r.clock.tick(); // 1 間隔後: 2 回目
    expect(at()).toBe(2);
    await r.clock.tick();
    expect(at()).toBe(2); // 2 間隔空く
    await r.clock.tick();
    expect(at()).toBe(3);
    expect(r.bindBodies).toHaveLength(1);
    await r.stop();
  });

  it("コードのファイルが残ったまま daemon に断られ続けても、同じ内容のコードは 1 回しか送らない（ファイルは消さない）", async () => {
    const r = await setup({ withCodeFile: true, codeStatus: 401 });
    await flush();
    const codeSends = () => r.bindBodies.filter((b) => b.bindCode !== undefined).length;
    expect(codeSends()).toBe(1);
    for (let i = 0; i < 30; i++) await r.clock.tick();
    expect(codeSends()).toBe(1);
    expect(r.bindBodies).toHaveLength(1); // コードなしの結び直しも試さない（ファイルがあるあいだは、最初の起動の道）
    expect(existsSync(r.codePath)).toBe(true);
    expect(await r.names()).toEqual(["child_bind", "whoami"]);
    // 親がコードを出し直した（内容が変わった）: 間隔を待たずに、次の確かめで使って紐付く
    r.setCodeStatus(200);
    r.writeCode(CODE2);
    await r.clock.tick();
    expect(codeSends()).toBe(2);
    expect(r.bindBodies.at(-1)).toMatchObject({ bindCode: CODE2 });
    expect(await r.names()).toContain("report_progress");
    expect(r.written).toEqual([notificationText(0)]);
    const all = r.logs.join("");
    expect(all).not.toContain(CODE);
    expect(all).not.toContain(CODE2);
    await r.stop();
  });

  it("接続が閉じた（中止の合図）あとは、確かめのタイマーが止まり、daemon を叩かない", async () => {
    const r = await setup({ rebindStatus: 401 });
    await flush();
    expect(r.bindBodies).toHaveLength(1);
    const waits = r.clock.waits.length;
    await r.stop();
    for (let i = 0; i < 20; i++) await r.clock.tick();
    expect(r.clock.waits.length).toBe(waits); // 新しい待ちを張らない
    expect(r.bindBodies).toHaveLength(1);
  });

  it("入れ物が 401 で空になると、理由（rejected）が記録に出て、道具は紐付け待ちに戻る", async () => {
    const r = await setup({});
    await flush();
    r.setRebindStatus(401);
    const used = r.credentials.get()?.token ?? "";
    await r.credentials.reject(used); // 復旧（コードなしの結び直し）も通らない → 空になる
    expect(r.credentials.get()).toBeUndefined();
    expect(r.logs.join("")).toContain('"reason":"rejected"');
    expect(await r.names()).toEqual(["child_bind", "whoami"]);
    await r.stop();
  });
});
