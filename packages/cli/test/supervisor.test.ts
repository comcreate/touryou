import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToRegistry, registryPath } from "../src/registry.js";
import {
  DAEMON_PID_FILE,
  detectDaemon,
  makeSpawnDaemon,
  reconcile,
  type SupervisorDeps,
} from "../src/supervisor.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "touryou-supervisor-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 設定ファイルと stateDir を作る。 */
function makeRepo(name: string): { config: string; stateDir: string } {
  const dir = join(root, name, ".touryou");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir }));
  return { config, stateDir };
}

function deps(over: Partial<SupervisorDeps> = {}): SupervisorDeps & { spawned: string[] } {
  const spawned: string[] = [];
  return {
    registryFile: registryPath(root),
    spawnDaemon: (config) => {
      spawned.push(config);
      return 4242;
    },
    probe: async () => undefined,
    isPidAlive: () => false,
    ...over,
    spawned,
  };
}

describe("detectDaemon（動いているかの判定）", () => {
  it("窓口が 401 を返せば running（手で起こしたものも見つかる）", async () => {
    const { stateDir } = makeRepo("a");
    writeFileSync(join(stateDir, "port"), "5555\n");
    expect(await detectDaemon(stateDir, { probe: async (p) => (p === 5555 ? 401 : undefined) })).toBe(
      "running",
    );
  });

  it("ロック（pid）だけ残り、応答がないとき: pid が生きていれば unresponsive（起動しない）", async () => {
    const { stateDir } = makeRepo("a");
    writeFileSync(join(stateDir, "port"), "5555\n");
    writeFileSync(join(stateDir, DAEMON_PID_FILE), "777\n");
    expect(await detectDaemon(stateDir, { probe: async () => undefined, isPidAlive: () => true })).toBe(
      "unresponsive",
    );
  });

  it("ロックだけ残り、応答も pid もない（異常終了の残り）なら absent（起動してよい）", async () => {
    const { stateDir } = makeRepo("a");
    writeFileSync(join(stateDir, "port"), "5555\n");
    writeFileSync(join(stateDir, DAEMON_PID_FILE), "777\n");
    expect(await detectDaemon(stateDir, { probe: async () => undefined, isPidAlive: () => false })).toBe(
      "absent",
    );
  });

  it("401 以外の応答（別のものが同じポートを使っている）は、動いているとは見なさない", async () => {
    const { stateDir } = makeRepo("a");
    writeFileSync(join(stateDir, "port"), "5555\n");
    expect(await detectDaemon(stateDir, { probe: async () => 200 })).toBe("absent");
  });
});

describe("reconcile", () => {
  it("先勝ち: すでに動いている daemon があれば起動せず理由を出す。足りないものだけ起動する", async () => {
    const a = makeRepo("a");
    const b = makeRepo("b");
    addToRegistry(registryPath(root), a.config);
    addToRegistry(registryPath(root), b.config);
    writeFileSync(join(a.stateDir, "port"), "5555\n");
    const d = deps({ probe: async (p) => (p === 5555 ? 401 : undefined) });
    const r = await reconcile(d);
    expect(d.spawned).toEqual([b.config]);
    expect(r.kind === "ok" && r.entries.map((e) => e.state)).toEqual(["running", "started"]);
    const first = r.kind === "ok" ? r.entries[0] : undefined;
    expect(first && "reason" in first ? first.reason : "").toContain("先勝ち");
  });

  it("ロックだけ残り応答がない: pid が生きていれば起動しない。死んでいれば残りを消して起動する", async () => {
    const a = makeRepo("a");
    addToRegistry(registryPath(root), a.config);
    writeFileSync(join(a.stateDir, DAEMON_PID_FILE), "777\n");
    const alive = deps({ isPidAlive: () => true });
    const r1 = await reconcile(alive);
    expect(alive.spawned).toEqual([]);
    expect(r1.kind === "ok" && r1.entries[0]?.state).toBe("unresponsive");
    const dead = deps({ isPidAlive: () => false });
    const r2 = await reconcile(dead);
    expect(dead.spawned).toEqual([a.config]);
    expect(r2.kind === "ok" && r2.entries[0]?.state).toBe("started");
  });

  it("消えたパスは起動せず理由つきで返し、登録簿から外さない。壊れた設定も起動しない", async () => {
    const a = makeRepo("a");
    const bad = makeRepo("bad");
    writeFileSync(bad.config, "{oops");
    const gone = join(root, "gone", ".touryou", "config.json");
    for (const c of [gone, bad.config, a.config]) addToRegistry(registryPath(root), c);
    const d = deps();
    const r = await reconcile(d);
    expect(d.spawned).toEqual([a.config]);
    expect(r.kind === "ok" && r.entries.map((e) => e.state)).toEqual(["missing", "invalid", "started"]);
    const again = await reconcile(deps({ isPidAlive: () => false }));
    expect(again.kind === "ok" && again.entries[0]?.config).toBe(gone);
  });

  it("壊れた登録簿では、何も起動せず、再登録の手順を返す", async () => {
    mkdirSync(join(root, ".touryou"));
    writeFileSync(registryPath(root), "{oops");
    const d = deps();
    const r = await reconcile(d);
    expect(r.kind).toBe("broken");
    expect(d.spawned).toEqual([]);
  });
});

describe("supervisor が落ちても daemon が残る（実プロセス）", () => {
  const pids: number[] = [];
  afterEach(() => {
    for (const p of pids.splice(0)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // すでに終わっている
      }
    }
  });

  it("起こした daemon は残り、起動し直した supervisor は足りないものだけを起動する", async () => {
    const script = join(root, "fake-daemon.mjs");
    writeFileSync(
      script,
      `import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const config = process.argv[process.argv.indexOf("--config") + 1];
const { stateDir } = JSON.parse(readFileSync(config, "utf8"));
const server = createServer((_q, res) => { res.statusCode = 401; res.end(); });
server.listen(0, "127.0.0.1", () => writeFileSync(join(stateDir, "port"), server.address().port + "\\n"));
`,
    );
    const a = makeRepo("a");
    const b = makeRepo("b");
    addToRegistry(registryPath(root), a.config);
    const spawnDaemon = makeSpawnDaemon([process.execPath, script]);
    const real = (over: Partial<SupervisorDeps> = {}): SupervisorDeps => ({
      registryFile: registryPath(root),
      spawnDaemon,
      ...over,
    });
    const waitRunning = async (stateDir: string): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if ((await detectDaemon(stateDir)) === "running") return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`daemon が応答しない: ${stateDir}`);
    };

    // 1 代目の supervisor が a を起こす
    const r1 = await reconcile(real());
    const s1 = r1.kind === "ok" ? r1.entries[0] : undefined;
    expect(s1?.state).toBe("started");
    if (s1?.state === "started") pids.push(s1.pid);
    await waitRunning(a.stateDir);

    // 1 代目は落ちた（何も止めない）。b が登録され、2 代目の supervisor が起動し直す
    addToRegistry(registryPath(root), b.config);
    const r2 = await reconcile(real());
    expect(r2.kind === "ok" && r2.entries.map((e) => e.state)).toEqual(["running", "started"]);
    const s2 = r2.kind === "ok" ? r2.entries[1] : undefined;
    if (s2?.state === "started") pids.push(s2.pid);
    await waitRunning(b.stateDir);
    if (s1?.state === "started") expect(() => process.kill(s1.pid, 0)).not.toThrow();
  });
});
