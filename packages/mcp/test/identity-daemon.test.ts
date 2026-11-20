/**
 * 身元確認と、本物の daemon の窓口（`createApiServer` の `GET /v1/identity`）の統合。
 * 偽の窓口（別のプロセスがポートを奪った・本物の identity を中継した）には、トークンを一切送らないことを確かめる。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { foldEvents, type OrchEvent, type OrchState } from "@touryou/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../daemon/src/api/credentials.js";
import { type ApiServer, createApiServer } from "../../daemon/src/api/server.js";
import { createIdentityVerifier } from "../src/identity.js";
import { createRelay } from "../src/relay.js";
import { createToolServer } from "../src/server.js";

const DAEMON_ID = "00112233445566778899aabbccddeeff";
const SECRET = "ab".repeat(32);

const state = (): OrchState => {
  let n = 0;
  const ev = (body: object): OrchEvent =>
    ({
      seq: ++n,
      at: "2026-10-20T00:00:00Z",
      requestId: `r${n}`,
      actor: { system: true },
      ...body,
    }) as OrchEvent;
  const r = foldEvents([
    ev({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    ev({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
    }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

let dir: string;
let daemon: ApiServer | undefined;
const extra: Server[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "touryou-mcp-identity-"));
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const s of extra.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const identityFile = (secret = SECRET, daemonId = DAEMON_ID): string => {
  const p = join(dir, "daemon-identity");
  writeFileSync(p, `${JSON.stringify({ version: 1, daemonId, secret })}\n`, { mode: 0o600 });
  return p;
};
const startDaemon = async (port = 0) => {
  const credentials = createCredentialStore({
    humanToken: "human-token-human-token-human-token-1234",
  });
  daemon = createApiServer({
    credentials,
    getState: () => state(),
    handlers: {},
    identity: () => ({ daemonId: DAEMON_ID, secret: SECRET }),
  });
  const { url } = await daemon.listen(port);
  return { url, token: credentials.issueNodeToken("a", "child") };
};

/** 窓口を奪った偽のプロセス。受け取った要求（パスと Authorization の有無）を記録する。 */
const startAttacker = async (
  port: number,
  mode: "relay" | "forged" | "silent",
  genuineUrl?: string,
) => {
  const seen: { path: string; authorization: string | undefined }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const path = req.url ?? "";
    seen.push({ path, authorization: req.headers.authorization });
    if (path.startsWith("/v1/identity") && mode === "relay" && genuineUrl !== undefined) {
      // 本物の daemon の identity を、そのまま中継する。
      fetch(`${genuineUrl}${path}`)
        .then(async (r) => {
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(await r.text());
        })
        .catch(() => res.destroy());
      return;
    }
    if (path.startsWith("/v1/identity") && mode === "forged") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, value: { daemonId: DAEMON_ID, proof: "0".repeat(64) } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, value: { role: "child" } }));
  });
  extra.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  const actual = (server.address() as { port: number }).port;
  return { seen, url: `http://127.0.0.1:${actual}`, port: actual };
};

const relayFor = (url: string, token: string, path: string) => {
  const r = createRelay({
    daemonUrl: url,
    token,
    verifier: createIdentityVerifier({ daemonUrl: url, identityPath: path }),
  });
  if (!r.ok) throw new Error(r.error.cause);
  return r.value;
};

describe("whoami ツールと身元の検証", () => {
  it("whoami ツールを 2 回呼ぶと、検証（verifier）も 2 回走る（キャッシュしない）。どちらも、本物の daemon が返した nodeId が出る", async () => {
    const { url, token } = await startDaemon();
    const path = identityFile();
    const real = createIdentityVerifier({ daemonUrl: url, identityPath: path });
    let verifies = 0;
    const verifier = {
      verify: async () => {
        verifies++;
        return real.verify();
      },
    };
    const relay = createRelay({ daemonUrl: url, token, verifier });
    if (!relay.ok) throw new Error(relay.error.cause);
    const server = createToolServer({ role: "child", relay: relay.value });
    const client = new Client({ name: "t", version: "0" });
    const [x, y] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(x), client.connect(y)]);
    const call = async () =>
      JSON.parse(
        (
          (await client.callTool({ name: "whoami", arguments: {} })).content as { text: string }[]
        )[0]?.text ?? "null",
      );
    expect(await call()).toEqual({ nodeId: "a", role: "child" });
    expect(verifies).toBe(1);
    expect(await call()).toEqual({ nodeId: "a", role: "child" });
    expect(verifies).toBe(2);
  });
});

describe("本物の daemon（createApiServer）", () => {
  it("本物なら、検証に成功して、トークンつきの whoami・request が通る", async () => {
    const { url, token } = await startDaemon();
    const relay = relayFor(url, token, identityFile());
    const who = await relay.whoami();
    expect(who.ok && who.value.role).toBe("child");
    const list = await relay.request("tree.list", {});
    expect(list.ok || list.error.code).not.toBe("daemon_identity_failed");
  });

  it("秘密が違う（古いファイル・別の daemon のファイル）と、daemon_identity_failed", async () => {
    const { url, token } = await startDaemon();
    const relay = relayFor(url, token, identityFile("cd".repeat(32)));
    const who = await relay.whoami();
    expect(!who.ok && who.error.code).toBe("daemon_identity_failed");
  });
});

describe("偽の窓口には、トークンを送らない", () => {
  it("本物の identity を、別のポートから中継する偽の daemon: proof が一致せず、トークンは届かない", async () => {
    const real = await startDaemon();
    const fake = await startAttacker(0, "relay", real.url);
    const relay = relayFor(fake.url, real.token, identityFile());
    const who = await relay.whoami();
    expect(!who.ok && who.error.code).toBe("daemon_identity_failed");
    const req = await relay.request("tree.list", {});
    expect(!req.ok && req.error.code).toBe("daemon_identity_failed");
    expect(fake.seen.length).toBeGreaterThan(0);
    expect(fake.seen.every((s) => s.path.startsWith("/v1/identity"))).toBe(true);
    expect(fake.seen.every((s) => s.authorization === undefined)).toBe(true);
  });

  it("secret を知らない偽の daemon（proof を偽造）: トークンは届かない", async () => {
    const real = await startDaemon();
    const fake = await startAttacker(0, "forged");
    const relay = relayFor(fake.url, real.token, identityFile());
    const who = await relay.whoami();
    expect(!who.ok && who.error.code).toBe("daemon_identity_failed");
    expect(fake.seen.every((s) => s.authorization === undefined)).toBe(true);
  });

  it("検証のあとでポートが奪われても、次の要求から、毎回検証し直すので、トークンは届かない（キャッシュしない。その 1 回の窓は防げない。docs §5）", async () => {
    const real = await startDaemon();
    const file = identityFile();
    const relay = relayFor(real.url, real.token, file);
    expect((await relay.whoami()).ok).toBe(true);
    const port = Number(new URL(real.url).port);
    await daemon?.close();
    daemon = undefined;
    const fake = await startAttacker(port, "forged");
    // 最初の 1 回は、古い接続（keep-alive）の切断で、接続の失敗になることがある。どちらでも、トークンは送らない。
    const first = await relay.request("tree.list", {});
    expect(first.ok).toBe(false);
    const after = await relay.request("tree.list", {});
    expect(!after.ok && after.error.code).toBe("daemon_identity_failed");
    expect(fake.seen.length).toBeGreaterThan(0);
    expect(fake.seen.every((s) => s.authorization === undefined)).toBe(true);
  });
});

describe("検証から送信までの窓（残余リスク）: 防止はできないが、検知する", () => {
  it("検証のあとで、別のプロセスに入れ替わると、トークンは届くが、応答を捨てて daemon_identity_failed にし、知らせる", async () => {
    const real = await startDaemon();
    // 偽の窓口: 検証（/v1/identity）は本物へ通し、トークンつきの要求だけ、偽が受ける（窓で入れ替わった状況の再現）。
    const fake = await startAttacker(0, "forged");
    let mismatches = 0;
    const realFetch = globalThis.fetch;
    const relay = createRelay({
      daemonUrl: real.url,
      token: real.token,
      verifier: createIdentityVerifier({ daemonUrl: real.url, identityPath: identityFile() }),
      onIdentityMismatch: () => {
        mismatches++;
      },
      fetch: ((u: string, init?: RequestInit) =>
        realFetch(
          u.includes("/v1/identity") ? u : u.replace(real.url, fake.url),
          init,
        )) as typeof fetch,
    });
    if (!relay.ok) throw new Error(relay.error.cause);
    const who = await relay.value.whoami();
    expect(!who.ok && who.error.code).toBe("daemon_identity_failed");
    expect(JSON.stringify(who)).not.toContain("child");
    expect(mismatches).toBe(1);
    // 防止ではない: トークンは、偽に届いている（docs §5 の残余リスク。トークンの再発行が要る）。
    expect(fake.seen.some((s) => s.authorization !== undefined)).toBe(true);
  });
});

describe("daemon の再起動（要求の中で待ってかけ直す）", () => {
  const HUMAN = "human-token-human-token-human-token-1234";
  const ID2 = "ffeeddccbbaa99887766554433221100";
  const SECRET2 = "cd".repeat(32);
  /** 資格の倉庫を引き継いで（本物の daemon は、トークンのハッシュをファイルから読み戻す）、別の秘密・daemonId で起動し直す。 */
  const restart = async (
    port: number,
    credentials: ReturnType<typeof createCredentialStore>,
    path: string,
  ) => {
    await daemon?.close();
    daemon = undefined;
    rmSync(path);
    return async () => {
      daemon = createApiServer({
        credentials,
        getState: () => state(),
        handlers: {},
        identity: () => ({ daemonId: ID2, secret: SECRET2 }),
      });
      await daemon.listen(port);
      identityFile(SECRET2, ID2);
    };
  };
  const boot = async () => {
    const credentials = createCredentialStore({ humanToken: HUMAN });
    daemon = createApiServer({
      credentials,
      getState: () => state(),
      handlers: {},
      identity: () => ({ daemonId: DAEMON_ID, secret: SECRET }),
    });
    const { url } = await daemon.listen(0);
    return {
      url,
      port: Number(new URL(url).port),
      credentials,
      token: credentials.issueNodeToken("a", "child"),
    };
  };

  it("daemon を止めて、別の秘密・daemonId で起動し直す間に whoami を呼ぶと、relay を作り直さずに成功する", async () => {
    const d = await boot();
    const path = identityFile();
    const relay = relayFor(d.url, HUMAN, path);
    expect((await relay.whoami()).ok).toBe(true);
    const start = await restart(d.port, d.credentials, path);
    const pending = relay.whoami();
    await new Promise((r) => setTimeout(r, 700));
    await start();
    const r = await pending;
    expect(r.ok && r.value.role).toBe("human");
  }, 15_000);

  it("身元が違う daemon（秘密が違う）には、トークンを送らずに失敗する", async () => {
    const { url, token } = await startDaemon();
    const { openStdioSession } = await import("../src/stdio.js");
    const session = await openStdioSession(
      { daemonUrl: url, token, identityPath: identityFile("cd".repeat(32)) },
      { stderr: () => {} },
      { sleep: async () => {} },
    );
    expect(session.ok).toBe(false);
  });
});

describe("ビルドした touryou-mcp --stdio（bin.ts と StdioServerTransport の実物の経路）", () => {
  it("initialize → whoami に答え、標準出力は JSON-RPC だけ。標準入力の EOF で、終了コード 0 で終わる", async () => {
    const { spawn } = await import("node:child_process");
    const { chmodSync, existsSync, mkdirSync } = await import("node:fs");
    const bin = join(import.meta.dirname, "..", "dist", "bin.js");
    expect(
      existsSync(bin),
      "先に pnpm build する（scripts/check.sh は build のあとに試験する）",
    ).toBe(true);
    const { url, token } = await startDaemon();
    const home = join(dir, "home");
    const state = join(home, ".touryou", "state");
    mkdirSync(state, { recursive: true });
    chmodSync(join(home, ".touryou"), 0o700);
    chmodSync(state, 0o700);
    writeFileSync(join(home, ".touryou", "config.json"), JSON.stringify({ stateDir: state }), {
      mode: 0o600,
    });
    writeFileSync(join(state, "root-token"), token, { mode: 0o600 });
    writeFileSync(join(state, "port"), new URL(url).port, { mode: 0o600 });
    writeFileSync(
      join(state, "daemon-identity"),
      `${JSON.stringify({ version: 1, daemonId: DAEMON_ID, secret: SECRET })}\n`,
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, [bin, "--stdio"], {
      // 子の作業ツリー（印のあるディレクトリ）で試験を動かしても、根のモードで開くように、印のない場所で起動する
      cwd: dir,
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    const waitFor = async (re: RegExp) => {
      for (let i = 0; i < 200 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 25));
    };
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    await waitFor(/"id":1/);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    });
    await waitFor(/"id":2/);
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise<string>((r) => setTimeout(() => r("timeout"), 5_000)),
    ]);
    if (code === "timeout") child.kill();
    expect(code, err).toBe(0);
    const lines = out.split("\n").filter((l) => l !== "");
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe("2.0");
    expect(out).toContain('\\"nodeId\\":\\"a\\"');
    expect(out + err).not.toContain(token);
  }, 20_000);
});
