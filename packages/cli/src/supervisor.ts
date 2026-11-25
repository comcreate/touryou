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
  | { readonly config: string; readonly state: "startFailed"; readonly reason: string }
  | { readonly config: string; readonly state: "backoff"; readonly reason: string };

/** 起動のあと、一度も動いている姿を見ずに落ちた回数と、次に起こしてよい時刻（メモリの中だけ）。 */
export interface StartFailure {
  /** 連続の失敗の回数。動いている姿を見たら 0 に戻す（記録ごと消す）。 */
  readonly count: number;
  /** この時刻（ms）までは、起こさない。 */
  readonly nextAt: number;
  /** 起こしたあと、まだ動いている姿を見ていない（次の周で absent なら失敗）。 */
  readonly awaiting: boolean;
}

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

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
  /**
   * 連続の失敗の記録（設定のパスごと）。渡すと、起こした直後に落ちる daemon を、毎周は起こし直さない（指数の待ち）。
   * 渡さなければ、周ごとに状態を持たず、足りなければ毎周起こす。
   */
  readonly failures?: Map<string, StartFailure>;
  readonly now?: () => number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
}

/** 失敗の回数から、次に起こしてよい時刻までの待ち（ms）。 */
function backoffDelay(count: number, deps: SupervisorDeps): number {
  const base = deps.backoffBaseMs ?? BACKOFF_BASE_MS;
  const max = deps.backoffMaxMs ?? BACKOFF_MAX_MS;
  return Math.min(base * 2 ** count, max);
}

/** 設定ファイルから stateDir を読む（検査の本体は daemon の `--check-config`。ここでは場所だけ）。 */
export function readStateDir(config: string): { stateDir: string } | { invalid: string } {
  try {
    const stateDir = (JSON.parse(readFileSync(config, "utf8")) as { stateDir?: unknown }).stateDir;
    if (typeof stateDir !== "string" || !stateDir.startsWith("/")) {
      return { invalid: `設定の stateDir が絶対パスでない（${config}）` };
    }
    return { stateDir };
  } catch (e) {
    return {
      invalid: `設定を読めない（${config}: ${String(e instanceof Error ? e.message : e)}）`,
    };
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
    const now = (deps.now ?? Date.now)();
    if (live === "running") deps.failures?.delete(item.config); // 動いている姿を見たら、失敗の数え直し
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
    const logFile = join(dirname(item.config), "logs", "daemon.log");
    // 起こしたのに、動いている姿を見ないまま落ちた = 失敗。連続の回数に応じて、待ってから起こす
    let prev = deps.failures?.get(item.config);
    if (deps.failures !== undefined && prev?.awaiting === true) {
      const count = prev.count + 1;
      prev = { count, nextAt: now + backoffDelay(count, deps), awaiting: false };
      deps.failures.set(item.config, prev);
    }
    if (prev !== undefined && now < prev.nextAt) {
      entries.push({
        config: item.config,
        state: "backoff",
        reason: `起動直後に落ちる（連続 ${prev.count} 回）。${Math.ceil((prev.nextAt - now) / 1000)} 秒あとまで、起こさない。原因はログ（${logFile}）を見る`,
      });
      continue;
    }
    try {
      mkdirSync(dirs.stateDir, { recursive: true, mode: 0o700 }); // 起こす前に作る（起こしたあとの失敗で、pid が残らなくなるのを避ける）
      const pid = deps.spawnDaemon(item.config, logFile);
      writeFileSync(join(dirs.stateDir, DAEMON_PID_FILE), `${pid}\n`, { mode: 0o600 });
      deps.failures?.set(item.config, {
        count: prev?.count ?? 0,
        nextAt: 0,
        awaiting: true,
      });
      entries.push({ config: item.config, state: "started", pid });
    } catch (e) {
      const count = (prev?.count ?? 0) + 1;
      deps.failures?.set(item.config, {
        count,
        nextAt: now + backoffDelay(count, deps),
        awaiting: false,
      });
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
    child.on("error", () => {}); // 実行ファイルがない等の非同期の失敗で、supervisor が落ちないように（pid がなければ下で throw する）
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
  // 連続の失敗の記録は、ループの間だけメモリに持つ（supervisor が起動し直されたら、数え直し）
  const loopDeps: SupervisorDeps = { ...deps, failures: deps.failures ?? new Map() };
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      options.onReport(await reconcile(loopDeps));
    } catch (e) {
      // 1 周の失敗で supervisor を落とさない。次の周で、やり直す
      try {
        options.onReport({
          kind: "broken",
          reason: `1 周の処理に失敗（${String(e instanceof Error ? e.message : e)}）`,
          fix: "原因を直す。supervisor は次の周でやり直す",
        });
      } catch {}
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
