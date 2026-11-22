/**
 * 保管した成果の消去（`node.discardedDrop`）の結線。daemon を組み立て、窓口（/v1/request）から呼んで、
 * - 人間のトークンだけが、git の口（discardedDrop）まで届く。統合ノード・子のトークンは届かない
 * - ノード ID の指定は、そのノードの保管の鍵に決まって、鍵と、一覧で見た先端が、口に渡る。監査の記録（discarded.discardedDropped）が残る
 * - 先端が違えば（tipMismatch）、口の失敗がそのまま返り、監査の記録は残らない
 * - Desktop の子がありうる木（allowDesktopChildren）では、確認待ちになり、確認するまで口を呼ばない。確認すると 1 回だけ呼ぶ
 * ことを確かめる。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Failure, failure, ok, type Result } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type Daemon, type WorktreePorts } from "../src/compose.js";
import type { DaemonConfig } from "../src/config.js";
import { FakeCliAdapter } from "./sdk/fakes.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const TIP = "a".repeat(40);
const OTHER_TIP = "b".repeat(40);

const boot = async (over: Partial<DaemonConfig> = {}) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-discarded-drop-")));
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
    ...over,
  };
  /** 口に届いた消去の呼び出し（鍵・先端）。 */
  const drops: { key: string; expectTip: string }[] = [];
  /** 保管している先端（鍵 → 先端）。 */
  const kept = new Map<string, string>();
  const worktree: WorktreePorts = {
    factsFor: async () => undefined,
    removeWorktree: async (): Promise<Result<undefined, Failure>> => ok(undefined),
    provisionWorktree: async ({ nodeId }) => {
      const p = join(worktreeRoot, nodeId);
      mkdirSync(p, { recursive: true });
      return ok({ worktreePath: p });
    },
    cwdOf: async (nodeId) => join(worktreeRoot, nodeId),
    discardedKeyOf: (nodeId) => `k-${nodeId}`,
    discardedList: async () =>
      ok({ max: 200, items: [...kept].map(([key, tip]) => ({ key, tip })) }),
    discardedRestore: async ({ key }) => ok({ branch: `restored/${key}`, tip: TIP }),
    discardedDrop: async (key, expectTip) => {
      if (kept.get(key) !== expectTip) {
        return {
          ok: false,
          error: failure("tipMismatch", "先端が一覧と違う", "list で確かめ直す"),
        };
      }
      drops.push({ key, expectTip });
      kept.delete(key);
      return ok({ key, tip: expectTip });
    },
  };
  const terminal: string[] = [];
  const launcher = new FakeCliAdapter();
  const made = createDaemon(config, {
    cliAdapter: launcher,
    worktree,
    probe: async () => [],
    logLine: () => undefined,
    confirmationOut: (l) => terminal.push(l),
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
  const call = async (token: string, operation: string, params: unknown) => {
    const res = await fetch(`${run.url}/v1/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: `q-${Math.random()}`.replace(".", ""),
        operation,
        params,
      }),
    });
    return {
      status: res.status,
      // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
      json: (await res.json()) as { ok: boolean; value?: any; error?: Failure },
    };
  };
  /** 子を作り、その保管（先端 TIP）を 1 件置く。子のノード ID を返す。 */
  const spawnWithKept = async (): Promise<string> => {
    const spawn = await call(rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      objective: "直す",
      acceptanceCriteria: ["通る"],
      scope: { writableLocations: ["src/x"], forbiddenLocations: [".git"], allowedCommands: [] },
    });
    expect(spawn.json.ok, JSON.stringify(spawn.json)).toBe(true);
    const nodeId: string = spawn.json.value.nodeId;
    kept.set(`k-${nodeId}`, TIP);
    return nodeId;
  };
  return { daemon, call, rootToken, humanToken, drops, kept, terminal, spawnWithKept, run };
};

describe("保管した成果の消去（node.discardedDrop）の結線", () => {
  it("人間のトークンの、ノード ID の指定の消去が、そのノードの鍵と先端で口に届く。保管は消える", async () => {
    const r = await boot();
    const nodeId = await r.spawnWithKept();
    const res = await r.call(r.humanToken, "node.discardedDrop", {
      target: nodeId,
      expectTip: TIP,
    });
    expect(res.json.ok, JSON.stringify(res.json)).toBe(true);
    expect(res.json.value).toEqual({ dropped: true, key: `k-${nodeId}`, tip: TIP });
    expect(r.drops).toEqual([{ key: `k-${nodeId}`, expectTip: TIP }]);
    expect(r.kept.size).toBe(0);
  });

  it("統合ノード・子のトークンでは、口に届かない（保管は残る）", async () => {
    const r = await boot();
    const nodeId = await r.spawnWithKept();
    const byRoot = await r.call(r.rootToken, "node.discardedDrop", {
      target: nodeId,
      expectTip: TIP,
    });
    expect(byRoot.json.ok).toBe(false);
    expect(byRoot.status).toBe(403);
    expect(r.drops).toEqual([]);
    expect(r.kept.size).toBe(1);
  });

  it("一覧で見た先端と違えば、口の失敗（tipMismatch）がそのまま返り、保管は残る", async () => {
    const r = await boot();
    const nodeId = await r.spawnWithKept();
    const res = await r.call(r.humanToken, "node.discardedDrop", {
      target: nodeId,
      expectTip: OTHER_TIP,
    });
    expect(res.json.ok).toBe(false);
    expect(res.json.error?.code).toBe("tipMismatch");
    expect(r.drops).toEqual([]);
    expect(r.kept.size).toBe(1);
  });

  it("保管がないノード ID は notFound。口に届かない", async () => {
    const r = await boot();
    const nodeId = await r.spawnWithKept();
    r.kept.clear();
    const res = await r.call(r.humanToken, "node.discardedDrop", {
      target: nodeId,
      expectTip: TIP,
    });
    expect(res.json.error?.code).toBe("notFound");
    expect(r.drops).toEqual([]);
  });

  it("Desktop の子がありうる木（allowDesktopChildren）では、確認待ちになり、確認するまで口を呼ばない。確認すると 1 回だけ消す", async () => {
    const r = await boot({ allowDesktopChildren: true });
    const nodeId = await r.spawnWithKept();
    const asked = await r.call(r.humanToken, "node.discardedDrop", {
      target: nodeId,
      expectTip: TIP,
    });
    expect(asked.json.error?.code).toBe("confirmationRequired");
    expect(r.drops).toEqual([]);
    expect(r.kept.size).toBe(1);
    // 端末に出たコードで確認する
    expect(r.terminal).toHaveLength(1);
    const m = r.terminal[0]?.match(/確認コード ([0-9A-Z]{4})-([0-9A-Z]{4})/);
    const code = `${m?.[1]}${m?.[2]}`;
    const ui = await fetch(`${r.run.url}/v1/ui/state`, {
      headers: { authorization: `Bearer ${r.humanToken}` },
    });
    const view = (await ui.json()) as {
      value: { confirmations: { confirmationId: string; operation: string }[] };
    };
    expect(view.value.confirmations.map((c) => c.operation)).toEqual(["node.discardedDrop"]);
    const confirmationId = view.value.confirmations[0]?.confirmationId ?? "";
    const done = await r.call(r.humanToken, "confirm.approve", { confirmationId, code });
    expect(done.json.ok, JSON.stringify(done.json)).toBe(true);
    expect(done.json.value.operation).toBe("node.discardedDrop");
    expect(r.drops).toEqual([{ key: `k-${nodeId}`, expectTip: TIP }]);
    expect(r.kept.size).toBe(0);
  });
});
