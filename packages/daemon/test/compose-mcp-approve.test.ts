/**
 * 子の MCP ツールの依頼（`scope_extend` の `kind: mcp`）の承認とフックの許可の結線（#194 PR3）。daemon を組み立て、窓口から呼んで、
 * - deny に当たる名前の承認は `scopeDenied` になる
 * - 上限（`permissions.allow`）にない道具の承認は `scopeNotSubset` になる
 * - ask に当たる名前は、統合ノードの判定では承認できず（`forbidden`）、人間だけが承認できる
 * - 承認済みの道具だけを、フックが明示の許可（`permit: extension`）にする。近い名前・前方一致・サーバー全体は許可にならない
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

const NAVIGATE = "mcp__chrome__navigate";
const DENIED = "mcp__chrome__evaluate";
const ASKED = "mcp__chrome__click";
const OUTSIDE = "mcp__chrome__screenshot";

const boot = async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-mcp-approve-")));
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
    permissions: { allow: [NAVIGATE, DENIED, ASKED], deny: [DENIED], ask: [ASKED] },
    port: 0,
  };
  const worktree: WorktreePorts = {
    factsFor: async () => undefined,
    removeWorktree: async (): Promise<Result<undefined, Failure>> => ok(undefined),
    provisionWorktree: async ({ nodeId }) => {
      const p = join(worktreeRoot, nodeId);
      mkdirSync(p, { recursive: true });
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
  /** 子を作って紐付け、ノードのトークンを返す。 */
  const childWithToken = async (): Promise<{ nodeId: string; token: string }> => {
    const spawned = await call(rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      objective: "直す",
      acceptanceCriteria: ["通る"],
      scope: { writableLocations: ["src/x"], forbiddenLocations: [".git"], allowedCommands: [] },
    });
    expect(spawned.json.ok, JSON.stringify(spawned.json)).toBe(true);
    const nodeId = spawned.json.value.nodeId as string;
    const code = await call(rootToken, "node.bindCode", { nodeId });
    const bindCode = /bindCode: (\S+)/.exec(String(code.json.value.instruction))?.[1];
    const bound = await post("/v1/bind", undefined, {
      nodeId,
      bindCode,
      cwd: join(worktreeRoot, nodeId),
    });
    expect(bound.json.ok, JSON.stringify(bound.json)).toBe(true);
    return { nodeId, token: bound.json.value.token as string };
  };
  /** 子が MCP ツールを頼み、拡張要求の ID を返す。 */
  const requestRaw = (child: { token: string }, value: string) =>
    call(child.token, "scope.extend", {
      target: { kind: "mcp", value },
      reason: "使いたい",
    });
  const request = async (child: { token: string }, value: string): Promise<string> => {
    const res = await requestRaw(child, value);
    expect(res.json.ok, JSON.stringify(res.json)).toBe(true);
    return res.json.value.extensionId as string;
  };
  const approveBy = (token: string, extensionId: string) =>
    call(token, "scope.decide", { extensionId, decision: "approve" });
  /** フックの受け口へ、PreToolUse を送る（子のトークン）。 */
  const hook = async (child: { nodeId: string; token: string }, toolName: string) => {
    const res = await post("/v1/hook", child.token, {
      hook_event_name: "PreToolUse",
      session_id: "s-1",
      cwd: join(worktreeRoot, child.nodeId),
      tool_name: toolName,
      tool_input: {},
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.value as { decision: string; permit?: string };
  };
  return { childWithToken, request, requestRaw, approveBy, hook, rootToken, humanToken };
};

describe("子の MCP ツールの依頼の承認（compose 越し。#194 PR3）", () => {
  it("deny に当たる名前の承認は scopeDenied になる（上限にあっても、人間でも）", async () => {
    const r = await boot();
    const child = await r.childWithToken();
    // 要求の時点で断られる（承認の画面に出ない。#249）
    const res = await r.requestRaw(child, DENIED);
    expect(res.json.ok).toBe(false);
    expect(res.json.error.code).toBe("scopeDenied");
    expect((await r.hook(child, DENIED)).decision).toBe("deny");
  });

  it("上限（permissions.allow）にない道具の承認は scopeNotSubset になる", async () => {
    const r = await boot();
    const child = await r.childWithToken();
    const id = await r.request(child, OUTSIDE);
    const res = await r.approveBy(r.rootToken, id);
    expect(res.json.ok).toBe(false);
    expect(res.json.error.code).toBe("scopeNotSubset");
    expect((await r.hook(child, OUTSIDE)).decision).toBe("deny");
  });

  it("ask に当たる名前は、統合ノードでは承認できず（forbidden）、人間だけが承認できる", async () => {
    const r = await boot();
    const child = await r.childWithToken();
    const id = await r.request(child, ASKED);
    const byIntegrator = await r.approveBy(r.rootToken, id);
    expect(byIntegrator.json.ok).toBe(false);
    expect(byIntegrator.json.error.code).toBe("forbidden");
    expect((await r.hook(child, ASKED)).decision).toBe("deny");
    const byHuman = await r.approveBy(r.humanToken, id);
    expect(byHuman.json.ok, JSON.stringify(byHuman.json)).toBe(true);
    expect(await r.hook(child, ASKED)).toEqual({ decision: "allow", permit: "extension" });
  });

  it("承認済みの道具だけをフックが明示の許可にする。近い名前・前方一致・サーバー全体は許可にならない", async () => {
    const r = await boot();
    const child = await r.childWithToken();
    // 承認の前は許可にならない
    expect((await r.hook(child, NAVIGATE)).decision).toBe("deny");
    const id = await r.request(child, NAVIGATE);
    const approved = await r.approveBy(r.rootToken, id);
    expect(approved.json.ok, JSON.stringify(approved.json)).toBe(true);
    expect(await r.hook(child, NAVIGATE)).toEqual({ decision: "allow", permit: "extension" });
    for (const near of [
      `${NAVIGATE}2`,
      "mcp__chrome__navigat",
      "mcp__chrome__nav",
      "mcp__chrome",
      "mcp__chrome__",
      "mcp__other__navigate",
      OUTSIDE,
    ]) {
      expect((await r.hook(child, near)).decision, near).toBe("deny");
    }
  });
});
