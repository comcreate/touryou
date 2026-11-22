/**
 * CLI の子の紐付け（child_bind = `POST /v1/bind`）と、フック専用のトークンの結線（#223）。daemon を組み立て、窓口から呼んで、
 * - 紐付け（bind）は、フック専用のトークンを無効にしない（フックは bind より前から動く。bind は同じ子のセッションを木に結ぶだけ）。
 *   結び直し（コードの出し直し→もう一度 bind）でも同じ
 * - 紐付けで出たノードのトークンも、CLI の子ではフックの受け口で通る
 * - bind でない発行（フック専用のトークンの出し直し）は、前のフック専用のトークンを無効にする
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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const boot = async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-hook-bind-")));
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
  const launcher = new FakeCliAdapter();
  const made = createDaemon(config, {
    cliAdapter: launcher,
    worktree,
    probe: async () => [],
    logLine: () => undefined,
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
  const humanToken = readFileSync(run.humanTokenPath, "utf8").trim();
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
  const call = (token: string, operation: string, params: unknown) =>
    post("/v1/request", token, {
      requestId: `q-${Math.random()}`.replace(".", ""),
      operation,
      params,
    });
  /** 子を作る（紐付けはまだ）。 */
  const spawn = async (): Promise<string> => {
    const res = await call(rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      objective: "直す",
      acceptanceCriteria: ["通る"],
      scope: { writableLocations: ["src/x"], forbiddenLocations: [".git"], allowedCommands: [] },
    });
    expect(res.json.ok, JSON.stringify(res.json)).toBe(true);
    return res.json.value.nodeId;
  };
  /** bind コードを出させ、コードで紐付ける（child_bind と同じ道）。ノードのトークンを返す。 */
  const bind = async (nodeId: string): Promise<string> => {
    const code = await call(rootToken, "node.bindCode", { nodeId });
    expect(code.json.ok, JSON.stringify(code.json)).toBe(true);
    const bindCode = /bindCode: (\S+)/.exec(String(code.json.value.instruction))?.[1];
    const bound = await post("/v1/bind", undefined, {
      nodeId,
      bindCode,
      cwd: join(worktreeRoot, nodeId),
    });
    expect(bound.json.ok, JSON.stringify(bound.json)).toBe(true);
    return bound.json.value.token;
  };
  /** フック専用のトークンを、人間のトークンで出させる（touryou hook-env と同じ道）。 */
  const hookEnv = async (nodeId: string): Promise<string> => {
    const res = await call(humanToken, "node.hookToken", { nodeId });
    expect(res.json.ok, JSON.stringify(res.json)).toBe(true);
    return res.json.value.token;
  };
  /** フックの受け口へ、PreToolUse を送る。 */
  const hook = (token: string) =>
    post("/v1/hook", token, {
      hook_event_name: "PreToolUse",
      session_id: "s-1",
      cwd: "/somewhere/else",
      tool_name: "Read",
      tool_input: { file_path: "README.md" },
    });
  return { daemon, spawn, bind, hookEnv, hook };
};

describe("CLI の子の紐付けとフック専用のトークンの結線（#223）", () => {
  it("紐付け（child_bind）をしても、先に出していたフック専用のトークンは無効にならない", async () => {
    const r = await boot();
    const nodeId = await r.spawn();
    const hookToken = await r.hookEnv(nodeId);
    expect((await r.hook(hookToken)).status).toBe(200);
    const nodeToken = await r.bind(nodeId);
    // bind のあとも、フック専用のトークンはそのまま通る
    const after = await r.hook(hookToken);
    expect(after.status, JSON.stringify(after.json)).toBe(200);
    // 紐付けで出たノードのトークンも、CLI の子ではフックの受け口で通る
    const byNode = await r.hook(nodeToken);
    expect(byNode.status, JSON.stringify(byNode.json)).toBe(200);
  });

  it("結び直し（コードの出し直し→もう一度 bind）でも、フック専用のトークンは無効にならない。前のノードのトークンは無効になる", async () => {
    const r = await boot();
    const nodeId = await r.spawn();
    const hookToken = await r.hookEnv(nodeId);
    const first = await r.bind(nodeId);
    const second = await r.bind(nodeId);
    expect(second).not.toBe(first);
    expect((await r.hook(hookToken)).status).toBe(200);
    expect((await r.hook(second)).status).toBe(200);
    // 前のノードのトークンは、結び直しで無効になる（フック専用のトークンだけが残る）
    expect((await r.hook(first)).status).toBe(401);
  });

  it("フック専用のトークンの出し直し（bind でない発行）は、前のフック専用のトークンを無効にする", async () => {
    const r = await boot();
    const nodeId = await r.spawn();
    const old = await r.hookEnv(nodeId);
    await r.bind(nodeId);
    const fresh = await r.hookEnv(nodeId);
    expect(fresh).not.toBe(old);
    expect((await r.hook(old)).status).toBe(401);
    expect((await r.hook(fresh)).status).toBe(200);
  });
});
