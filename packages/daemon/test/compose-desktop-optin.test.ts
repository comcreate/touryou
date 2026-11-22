import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Failure, ok, type Result, runtimeOf } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type Daemon, type DaemonDeps, type WorktreePorts } from "../src/compose.js";
import type { DaemonConfig } from "../src/config.js";
import { EventLog } from "../src/eventlog.js";
import { EXTERNAL_CHECK_SUMMARY } from "../src/external-check.js";
import { openSqliteStore } from "../src/sqlite-store.js";
import { FakeCliAdapter } from "./sdk/fakes.js";

// opt-in（allowDesktopChildren）の木の専用の試験（#159 PR2b）。
// (1) 取り消せない操作の確認ゲート、(2) CLI の子と Desktop の子が 1 つの木にあるときの、子ごとの runtime での振り分け。

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "touryou-optin-")));

const rig = (
  over: Partial<DaemonConfig> = {},
  terminal: { write: (line: string) => void } = { write: () => {} },
) => {
  const base = tmp();
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
    rootScope: {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    },
    port: 0,
    ...over,
  };
  const launcher = new FakeCliAdapter();
  const worktree: WorktreePorts = {
    factsFor: async () => undefined,
    removeWorktree: async (): Promise<Result<undefined, Failure>> => ok(undefined),
    provisionWorktree: async ({ nodeId }) => {
      const p = join(worktreeRoot, nodeId);
      mkdirSync(p, { recursive: true });
      return ok({ worktreePath: p });
    },
    cwdOf: async (id) => join(worktreeRoot, id),
  };
  const logs: string[] = [];
  const deps: DaemonDeps = {
    cliAdapter: launcher,
    worktree,
    probe: async () => [],
    logLine: (l) => logs.push(l),
    confirmationOut: (l) => terminal.write(l),
  };
  return { config, deps, launcher, logs };
};

const boot = async (r: ReturnType<typeof rig>) => {
  const made = createDaemon(r.config, r.deps);
  if (!made.ok) throw new Error(`${made.error.code}: ${made.error.cause}`);
  const run = await made.value.start();
  cleanups.push(() => made.value.stop());
  const log = made.value.log;
  r.launcher.sink = { record: (q) => log.append(q), recordAll: (qs) => log.appendAll(qs) };
  return {
    daemon: made.value as Daemon,
    url: run.url,
    rootToken: readFileSync(run.rootTokenPath, "utf8").trim(),
    humanToken: readFileSync(run.humanTokenPath, "utf8").trim(),
  };
};

const call = async (
  url: string,
  token: string,
  operation: string,
  params: unknown,
  requestId = `q-${Math.random()}`.replace(".", ""),
) => {
  const res = await fetch(`${url}/v1/request`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId, operation, params }),
  });
  return {
    status: res.status,
    // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
    json: (await res.json()) as { ok: boolean; value?: any; error?: Failure },
  };
};

const brief = {
  objective: "x",
  acceptanceCriteria: ["x"],
  scope: {
    writableLocations: ["src"],
    forbiddenLocations: [".git"],
    allowedCommands: ["pnpm test"],
  },
};
const touryouCommand = [process.execPath, "/opt/touryou/bin.js"];

/** 前回の実行から残った、アーカイブ済みの木 t（子 c）を、状態の置き場に用意する。 */
const seedArchivedTree = (r: ReturnType<typeof rig>) => {
  mkdirSync(r.config.stateDir, { mode: 0o700 });
  const store = openSqliteStore(join(r.config.stateDir, "state.db"));
  if (!store.ok) throw new Error("store");
  const log = EventLog.open(store.value, { clock: () => new Date().toISOString() });
  if (!log.ok) throw new Error("log");
  let k = 0;
  const add = (body: Parameters<typeof log.value.append>[0]["body"]) => {
    const x = log.value.append({ requestId: `seed-${++k}`, actor: { system: true }, body });
    if (!x.ok) throw new Error(`${x.error.code}: ${x.error.cause}`);
  };
  const ev = (nodeId: string, event: { type: string; [k: string]: unknown }) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } } as never);
  const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
  node("root", "integrator", null);
  ev("root", { type: "start" });
  node("t", "integrator", "root");
  ev("t", { type: "start" });
  node("c", "implement", "t");
  ev("c", { type: "start" });
  for (const id of ["c", "t"]) {
    ev(id, { type: "reportDone" });
    ev(id, { type: "accept" });
    ev(id, { type: "markReclaimable", discarded: false });
    ev(id, { type: "archive" });
  }
  store.value.close();
};

describe("opt-in の木: 取り消せない操作の確認ゲート", () => {
  it("allowDesktopChildren が true: 端末つきの daemon では、人間のトークンの最終削除は確認待ち。確認するまで消えない", async () => {
    const lines: string[] = [];
    const r = rig({ retentionDays: 0, allowDesktopChildren: true }, { write: (l) => lines.push(l) });
    seedArchivedTree(r);
    const d = await boot(r);
    const asked = await call(d.url, d.humanToken, "node.purge", { nodeId: "t" }, "purge-1");
    expect(asked.json.ok).toBe(false);
    expect(asked.json.error?.code).toBe("confirmationRequired");
    expect(lines).toHaveLength(1);
    expect(d.daemon.log.state().nodes.some((n) => n.id === "t")).toBe(true);
    // 端末に出たコードで確認すると、1 回だけ実行する
    const m = lines[0]?.match(/確認コード ([0-9A-Z]{4})-([0-9A-Z]{4})/);
    const code = `${m?.[1]}${m?.[2]}`;
    const ui = await fetch(`${d.url}/v1/ui/state`, {
      headers: { authorization: `Bearer ${d.humanToken}` },
    });
    const view = (await ui.json()) as {
      value: { confirmations: { confirmationId: string; operation: string }[] };
    };
    expect(view.value.confirmations.map((c) => c.operation)).toEqual(["node.purge"]);
    const confirmationId = view.value.confirmations[0]?.confirmationId ?? "";
    const done = await call(d.url, d.humanToken, "confirm.approve", { confirmationId, code });
    expect(done.json.ok, JSON.stringify(done.json)).toBe(true);
    expect(d.daemon.log.state().nodes.map((n) => n.id)).toEqual(["root"]);
  });

  it("allowDesktopChildren が true で、端末がない（launchd 経由）: confirmationUnavailable で失敗し、確認待ちも作らず、何も消さない", async () => {
    const r = rig(
      { retentionDays: 0, allowDesktopChildren: true },
      {
        write: () => {
          throw new Error("/dev/tty を開けない");
        },
      },
    );
    seedArchivedTree(r);
    const d = await boot(r);
    const asked = await call(d.url, d.humanToken, "node.purge", { nodeId: "t" }, "purge-1");
    expect(asked.json.ok).toBe(false);
    expect(asked.json.error?.code).toBe("confirmationUnavailable");
    expect(d.daemon.log.state().nodes.some((n) => n.id === "t")).toBe(true);
    const ui = await fetch(`${d.url}/v1/ui/state`, {
      headers: { authorization: `Bearer ${d.humanToken}` },
    });
    const view = (await ui.json()) as { value: { confirmations: unknown[] } };
    expect(view.value.confirmations).toHaveLength(0);
  });

  it("allowDesktopChildren が true: 回収の指示（node.reclaimInstruct）も、人間のトークンでは確認待ち（端末なしなら confirmationUnavailable）", async () => {
    const lines: string[] = [];
    const withTty = rig({ allowDesktopChildren: true }, { write: (l) => lines.push(l) });
    const a = await boot(withTty);
    const asked = await call(a.url, a.humanToken, "node.reclaimInstruct", {
      nodeId: "root",
      expectTips: {},
    });
    expect(asked.json.error?.code).toBe("confirmationRequired");
    expect(lines).toHaveLength(1);
    const noTty = rig(
      { allowDesktopChildren: true },
      {
        write: () => {
          throw new Error("端末なし");
        },
      },
    );
    const b = await boot(noTty);
    const denied = await call(b.url, b.humanToken, "node.reclaimInstruct", {
      nodeId: "root",
      expectTips: {},
    });
    expect(denied.json.error?.code).toBe("confirmationUnavailable");
  });

  it("既定（allowDesktopChildren なし）の木: 端末がなくても、これまでどおり、すぐ実行される（確認待ちにしない）", async () => {
    const lines: string[] = [];
    const r = rig({ retentionDays: 0 }, { write: (l) => lines.push(l) });
    seedArchivedTree(r);
    const d = await boot(r);
    const done = await call(d.url, d.humanToken, "node.purge", { nodeId: "t" });
    expect(done.json.ok, JSON.stringify(done.json)).toBe(true);
    expect(lines).toHaveLength(0);
    // 明示の false も同じ
    const off = rig(
      { retentionDays: 0, allowDesktopChildren: false },
      {
        write: () => {
          throw new Error("端末なし");
        },
      },
    );
    seedArchivedTree(off);
    const d2 = await boot(off);
    const done2 = await call(d2.url, d2.humanToken, "node.purge", { nodeId: "t" });
    expect(done2.json.ok, JSON.stringify(done2.json)).toBe(true);
  });
});

describe("opt-in の木: CLI の子と Desktop の子の混在（compose）", () => {
  const optIn = () => rig({ allowDesktopChildren: true, touryouCommand, desktopRequireVerifiedHooks: false });
  const spawn = async (
    d: Awaited<ReturnType<typeof boot>>,
    runtime: "cli" | "desktop" | undefined,
  ) => {
    const res = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...(runtime === undefined ? {} : { runtime }),
      ...brief,
    });
    expect(res.json.ok, JSON.stringify(res.json)).toBe(true);
    return res.json.value.nodeId as string;
  };

  it("子ごとの runtime で振り分ける: CLI の子だけ SDK のアダプタで起動し、Desktop の子は起動しない。runtime が子ごとに記録される", async () => {
    const r = optIn();
    const d = await boot(r);
    const cliId = await spawn(d, "cli");
    const desktopId = await spawn(d, "desktop");
    const state = d.daemon.log.state();
    expect(runtimeOf(state, cliId)).toBe("cli");
    expect(runtimeOf(state, desktopId)).toBe("desktop");
    expect(r.launcher.sessions).toHaveLength(1);
    // runtime を省略すると、設定の既定（childRuntime 未設定 = cli）
    const omitted = await spawn(d, undefined);
    expect(runtimeOf(d.daemon.log.state(), omitted)).toBe("cli");
    expect(r.launcher.sessions).toHaveLength(2);
  });

  it("再起動のあとの帯（根の受信箱）は、Desktop の子の数だけを書く（CLI の子は数に入れない）", async () => {
    const r = optIn();
    let d = await boot(r);
    const cliId = await spawn(d, "cli");
    const desktopId = await spawn(d, "desktop");
    await d.daemon.stop();
    cleanups.length = 0;
    d = await boot(r);
    const bands = d.daemon.log
      .state()
      .inbox.filter(
        (i) => i.resolved === undefined && i.summary?.startsWith(EXTERNAL_CHECK_SUMMARY) === true,
      );
    expect(bands).toHaveLength(1);
    expect(bands[0]?.summary).toContain(desktopId);
    expect(bands[0]?.summary).not.toContain(cliId);
  }, 15_000);

  it("CLI の子だけが混ざった opt-in の木では、再起動しても、Desktop の帯は出ない", async () => {
    const r = optIn();
    let d = await boot(r);
    await spawn(d, "cli");
    await d.daemon.stop();
    cleanups.length = 0;
    d = await boot(r);
    const bands = d.daemon.log
      .state()
      .inbox.filter(
        (i) => i.resolved === undefined && i.summary?.startsWith(EXTERNAL_CHECK_SUMMARY) === true,
      );
    expect(bands).toHaveLength(0);
  }, 15_000);

  it("フックの受け口: 混在の木でも、Desktop の子の引き出しの hook-token は /v1/hook で受け付けられ（401 にならない）、別の子のものでない文字列は 401", async () => {
    const r = optIn();
    const d = await boot(r);
    const desktopId = await spawn(d, "desktop");
    const bc = await call(d.url, d.rootToken, "node.bindCode", { nodeId: desktopId });
    expect(bc.json.ok, JSON.stringify(bc.json)).toBe(true);
    const lines = (bc.json.value.instruction as string)
      .split("\n")
      .map((l) => l.replace(/^ {3}/, ""));
    const codePath = (lines.find((l) => l.startsWith("ファイル: ")) as string).slice(
      "ファイル: ".length,
    );
    const hookToken = readFileSync(join(dirname(codePath), "hook-token"), "utf8").trim();
    const hook = (token: string) =>
      fetch(`${d.url}/v1/hook`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "s1",
          tool_name: "Bash",
          tool_input: { command: "ls" },
          cwd: join(r.config.worktreeRoot, desktopId),
        }),
      });
    expect((await hook(hookToken)).status).not.toBe(401);
    expect((await hook("not-a-token")).status).toBe(401);
  });
});

describe("単一 runtime の木は変わらない", () => {
  it("既定（opt-in なし）の木: runtime を省略した spawn は CLI の子。runtime: desktop は desktopChildNotAllowed で、何も作られない", async () => {
    const r = rig();
    const d = await boot(r);
    const okRes = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    expect(okRes.json.ok, JSON.stringify(okRes.json)).toBe(true);
    expect(r.launcher.sessions).toHaveLength(1);
    const before = d.daemon.log.state().nodes.length;
    const denied = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      runtime: "desktop",
      ...brief,
    });
    expect(denied.json.ok).toBe(false);
    expect(denied.json.error?.code).toBe("desktopChildNotAllowed");
    expect(d.daemon.log.state().nodes).toHaveLength(before);
    expect(r.launcher.sessions).toHaveLength(1);
  });

  it("childRuntime: desktop だけの木（opt-in なし）: runtime を省略した子は Desktop の子で、SDK では起動しない。取り消せない操作は確認待ち", async () => {
    const lines: string[] = [];
    const r = rig(
      { childRuntime: "desktop", touryouCommand, desktopRequireVerifiedHooks: false },
      { write: (l) => lines.push(l) },
    );
    const d = await boot(r);
    const res = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    expect(res.json.ok, JSON.stringify(res.json)).toBe(true);
    expect(runtimeOf(d.daemon.log.state(), res.json.value.nodeId as string)).toBe("desktop");
    expect(r.launcher.sessions).toHaveLength(0);
    const asked = await call(d.url, d.humanToken, "node.reclaimInstruct", {
      nodeId: "root",
      expectTips: {},
    });
    expect(asked.json.error?.code).toBe("confirmationRequired");
  });
});
