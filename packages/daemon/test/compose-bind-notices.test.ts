/**
 * 紐付けの期限の知らせの結線（#189）。daemon を組み立て、単調時計を進めて見回りを回し、
 * - 失効の前（前置き）に入ると、親の受信箱の info と、子への追加指示が 1 回ずつ記録される
 * - 子が結び直す（トークンの発行）と、失効の知らせ・前置きの知らせが解決になる
 * - 使われて切れなくなる・失効する と、前置きの知らせが解決になる
 * ことを確かめる。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Failure, ok, type Result } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type Daemon, type WorktreePorts } from "../src/compose.js";
import type { DaemonConfig } from "../src/config.js";
import { FakeCliAdapter } from "./sdk/fakes.js";

const MIN = 60_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const boot = async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-bind-wiring-")));
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  const config: DaemonConfig = {
    stateDir: join(base, "state"),
    repoRoot,
    worktreeRoot,
    rootCwd: repoRoot,
    rootNodeId: "root",
    rootScope: { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] },
    port: 0,
  };
  const worktree: WorktreePorts = {
    factsFor: async () => undefined,
    removeWorktree: async (): Promise<Result<undefined, Failure>> => ok(undefined),
    provisionWorktree: async ({ nodeId }) => {
      const p = join(worktreeRoot, nodeId);
      mkdirSync(p, { recursive: true });
      // 紐付けの確認は、追加の作業ツリー（`.git` がファイル）だけを通す
      writeFileSync(join(p, ".git"), "gitdir: /dev/null\n");
      return ok({ worktreePath: p });
    },
    cwdOf: async (nodeId) => join(worktreeRoot, nodeId),
  };
  let mono = 1_000_000;
  const launcher = new FakeCliAdapter();
  const made = createDaemon(config, {
    cliAdapter: launcher,
    worktree,
    probe: async () => [],
    logLine: () => undefined,
    monoMs: () => mono,
  });
  if (!made.ok) throw new Error(`${made.error.code}: ${made.error.cause}`);
  const daemon: Daemon = made.value;
  const run = await daemon.start();
  cleanups.push(() => daemon.stop());
  launcher.sink = {
    record: (q) => daemon.log.append(q),
    recordAll: (qs) => daemon.log.appendAll(qs),
  };
  const rootToken = readFileSync(run.rootTokenPath, "utf8").trim();
  const post = async (path: string, token: string | undefined, body: unknown) => {
    const res = await fetch(`${run.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
    // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
    return { status: res.status, json: (await res.json()) as any };
  };
  const request = (operation: string, params: unknown) =>
    post("/v1/request", rootToken, {
      requestId: `q-${Math.random()}`.replace(".", ""),
      operation,
      params,
    });
  /** bind コードを出し直させ、コードで紐付ける。子のトークンを返す。 */
  const bindAgain = async (nodeId: string): Promise<string> => {
    const code = await request("node.bindCode", { nodeId });
    expect(code.json.ok, JSON.stringify(code.json)).toBe(true);
    // コードは、子への案内の文（instruction）の中にだけある
    const bindCode = /bindCode: (\S+)/.exec(String(code.json.value.instruction))?.[1];
    const bound = await post("/v1/bind", undefined, {
      nodeId,
      bindCode,
      cwd: join(worktreeRoot, nodeId),
    });
    expect(bound.json.ok, `${JSON.stringify(bound.json)} / ${JSON.stringify(code.json)}`).toBe(
      true,
    );
    return bound.json.value.token;
  };
  /** 子を作り、bind コードで紐付ける。子のトークンを返す。 */
  const spawnAndBind = async (): Promise<{ nodeId: string; token: string }> => {
    const spawn = await request("node.spawn", {
      parentId: "root",
      role: "implement",
      objective: "直す",
      acceptanceCriteria: ["通る"],
      scope: { writableLocations: ["src/x"], forbiddenLocations: [".git"], allowedCommands: [] },
    });
    expect(spawn.json.ok, JSON.stringify(spawn.json)).toBe(true);
    const nodeId: string = spawn.json.value.nodeId;
    return { nodeId, token: await bindAgain(nodeId) };
  };
  const whoami = (token: string) =>
    fetch(`${run.url}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });
  return {
    daemon,
    spawnAndBind,
    bindAgain,
    whoami,
    advance: (ms: number) => {
      mono += ms;
    },
  };
};

const noticesOf = (d: Daemon, nodeId: string, key: string) =>
  d.log.state().inbox.filter((i) => i.nodeId === nodeId && i.msg?.key === key);
const openOf = (d: Daemon, nodeId: string, key: string) =>
  noticesOf(d, nodeId, key).filter((i) => i.resolved === undefined);

describe("紐付けの期限の知らせの結線（#189）", () => {
  it("前置きに入ると、親の info と子への追加指示が 1 回ずつ。見回りを重ねても増えない", async () => {
    const r = await boot();
    const { nodeId } = await r.spawnAndBind();
    const instructed = () =>
      r.daemon.log.state().instructions.filter((i) => i.nodeId === nodeId).length;
    const before = instructed();
    r.advance(49 * MIN);
    r.daemon.sweepTokens();
    expect(noticesOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0);
    r.advance(2 * MIN); // 切れるまで 9 分
    r.daemon.sweepTokens();
    r.daemon.sweepTokens();
    expect(noticesOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    expect(instructed() - before).toBe(1);
  });

  it("使われて切れなくなったら、前置きの知らせが解決になる。切れたら、失効の知らせが出て、前置きは解決のまま", async () => {
    const r = await boot();
    const { nodeId, token } = await r.spawnAndBind();
    r.advance(52 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    // 使われる（認証が通る）: 時計が延びる。次の見回りで復帰と分かり、解決になる
    expect((await r.whoami(token)).status).toBe(200);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0);
    // もう一度止まり、切れる: 失効の知らせが出る
    r.advance(52 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    r.advance(10 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0);
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(1);
  });

  it("結び直すと、失効の知らせが解決になる", async () => {
    const r = await boot();
    const { nodeId } = await r.spawnAndBind();
    r.advance(61 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(1);
    await r.bindAgain(nodeId);
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(0);
    expect(noticesOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(1);
  });
});
