/**
 * supervisor 本体（#288 決定 11・13・16）。登録簿の設定ごとに daemon を別プロセスで起動・監視する。
 *
 * - 引き継ぎ: daemon は detached で起こし、supervisor は止めるときも daemon に信号を送らない。supervisor が落ちても daemon は残る。
 *   起動し直した supervisor は、`detectDaemon` で動いているものを見つけ、足りないものだけを起こす。
 * - 二重起動は先勝ち: 動いている daemon（窓口が未認証の whoami に 401 を返す）があれば、起動せず理由を出す。
 * - 「動いている」の判定（`detectDaemon`）:
 *     1. stateDir の `port` のファイルのポートへ、未認証で `GET /v1/whoami` → 401 なら **running**（手で起こしたものも見つかる）。
 *     2. 応答がなく、stateDir の `daemon.pid`（supervisor が起こしたときに書く）の pid が生きている → **unresponsive**。
 *        ロック（sqlite の単一の書き手）を持ったまま応答しない可能性があるので、起動しない（二重に開くと storeLocked で失敗するうえ、
 *        pid の使い回しで別のプロセスを殺す危険もあるので、supervisor は pid を kill しない）。理由を状態に出し、人が止める。
 *     3. 応答がなく、pid のファイルがない・pid が死んでいる → **absent**（異常終了の残り。OS のロックはプロセスと共に消えるので、
 *        残った pid のファイルを消して起動する）。
 * - 消えた設定パス・壊れた設定・壊れた登録簿は、起動せず、理由つきで状態に返す（自動では外さない・直さない）。
 * - 「監視」は、一定の間隔の `reconcile` の繰り返し（落ちた daemon は、次の周回で起こし直す）。
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { inspectEntries, readRegistry } from "./registry.js";

export const DAEMON_PID_FILE = "daemon.pid";

export type DaemonLiveness = "running" | "unresponsive" | "absent";

export type SupervisorEntryState =
  | { readonly config: string; readonly state: "started"; readonly pid: number }
  | { readonly config: string; readonly state: "running"; readonly reason: string }
  | { readonly config: string; readonly state: "unresponsive"; readonly reason: string }
  | { readonly config: string; readonly state: "missing"; readonly reason: string }
  | { readonly config: string; readonly state: "invalid"; readonly reason: string }
  | { readonly config: string; readonly state: "startFailed"; readonly reason: string };

export type SupervisorReport =
  | { readonly kind: "ok"; readonly entries: readonly SupervisorEntryState[] }
  | { readonly kind: "broken"; readonly reason: string; readonly fix: string };

export interface SupervisorDeps {
  readonly registryFile: string;
  /** 設定ファイルのパスから daemon を別プロセスで起こし、pid を返す。 */
  readonly spawnDaemon: (config: string, logFile: string) => number;
  /** 未認証の `GET /v1/whoami` の状態コード。つながらなければ `undefined`。 */
  readonly probe?: (port: number) => Promise<number | undefined>;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly exists?: (path: string) => boolean;
}

/** 設定ファイルから stateDir を読む（検査の本体は daemon の `--check-config`。ここでは場所だけ）。 */
function readStateDir(config: string): { stateDir: string } | { invalid: string } {
  try {
    const stateDir = (JSON.parse(readFileSync(config, "utf8")) as { stateDir?: unknown }).stateDir;
    if (typeof stateDir !== "string" || !stateDir.startsWith("/")) {
      return { invalid: `設定の stateDir が絶対パスでない（${config}）` };
    }
    return { stateDir };
  } catch (e) {
    return { invalid: `設定を読めない（${config}: ${String(e instanceof Error ? e.message : e)}）` };
  }
}

const defaultProbe = async (port: number): Promise<number | undefined> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/whoami`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.status;
  } catch {
    return undefined;
  }
};

const defaultIsPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

function readNumberFile(path: string): number | undefined {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** stateDir の daemon が、動いているか（上の 1〜3）。 */
export async function detectDaemon(
  stateDir: string,
  deps: Pick<SupervisorDeps, "probe" | "isPidAlive"> = {},
): Promise<DaemonLiveness> {
  const port = readNumberFile(join(stateDir, "port"));
  if (port !== undefined && (await (deps.probe ?? defaultProbe)(port)) === 401) return "running";
  const pid = readNumberFile(join(stateDir, DAEMON_PID_FILE));
  if (pid !== undefined && (deps.isPidAlive ?? defaultIsPidAlive)(pid)) return "unresponsive";
  return "absent";
}

/** 1 周: 登録簿の設定ごとに、足りない daemon だけを起こす。 */
export async function reconcile(deps: SupervisorDeps): Promise<SupervisorReport> {
  const reg = readRegistry(deps.registryFile);
  if (reg.kind === "broken") return { kind: "broken", reason: reg.reason, fix: reg.fix };
  const entries: SupervisorEntryState[] = [];
  for (const item of inspectEntries(reg.configs, deps.exists ?? existsSync)) {
    if (!item.present) {
      entries.push({ config: item.config, state: "missing", reason: item.reason });
      continue;
    }
    const dirs = readStateDir(item.config);
    if ("invalid" in dirs) {
      entries.push({ config: item.config, state: "invalid", reason: dirs.invalid });
      continue;
    }
    const live = await detectDaemon(dirs.stateDir, deps);
    if (live === "running") {
      entries.push({
        config: item.config,
        state: "running",
        reason: "すでに動いている daemon がある（先勝ち）。起動しない",
      });
      continue;
    }
    if (live === "unresponsive") {
      entries.push({
        config: item.config,
        state: "unresponsive",
        reason: `${join(dirs.stateDir, DAEMON_PID_FILE)} の pid が生きているが、窓口が応答しない。二重に起動しない。止まらないなら、その pid を人が止める`,
      });
      continue;
    }
    rmSync(join(dirs.stateDir, DAEMON_PID_FILE), { force: true }); // 異常終了の残り
    try {
      const logFile = join(dirname(item.config), "logs", "daemon.log");
      const pid = deps.spawnDaemon(item.config, logFile);
      mkdirSync(dirs.stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dirs.stateDir, DAEMON_PID_FILE), `${pid}\n`, { mode: 0o600 });
      entries.push({ config: item.config, state: "started", pid });
    } catch (e) {
      entries.push({
        config: item.config,
        state: "startFailed",
        reason: `起動できない（${String(e instanceof Error ? e.message : e)}）`,
      });
    }
  }
  return { kind: "ok", entries };
}

/**
 * 既定の起こし方: detached（別のセッション）・親から切り離し（unref）。supervisor が落ちても、daemon は止まらない。
 * `daemonCommand` は `[実行ファイル, ...先頭の引数]`（例 `[".../bin/touryou-daemon"]`）。
 */
export function makeSpawnDaemon(daemonCommand: readonly string[]) {
  return (config: string, logFile: string): number => {
    const [cmd, ...head] = daemonCommand;
    if (cmd === undefined) throw new Error("daemon の起動コマンドが空");
    mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
    const fd = openSync(logFile, "a", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(cmd, [...head, "--config", config], {
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    child.unref();
    if (child.pid === undefined) throw new Error("プロセスを起こせなかった");
    return child.pid;
  };
}

/** 一定の間隔で `reconcile` を繰り返す（監視）。止めても、起こした daemon は止めない。 */
export function superviseLoop(
  deps: SupervisorDeps,
  options: { readonly intervalMs: number; readonly onReport: (r: SupervisorReport) => void },
): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      options.onReport(await reconcile(deps));
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), options.intervalMs);
    }
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
