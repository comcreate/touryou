/**
 * 前の置き場（`$HOME/.touryou/config.json`・`$HOME/.touryou/state`・常駐 `touryou.daemon`）から、
 * リポジトリ単位の置き場（`<repoRoot>/.touryou/`）への移行（`touryou migrate --yes`。#288 決定 10・#301。`docs/launchd.md`）。
 *
 * 「コピー → 検査 → 切り替え」。元の設定・state は消さない（コピーするだけ）。途中で失敗したら、作ったものだけを消し、
 * 止めた前の常駐を起動し直して、元のまま動く状態に戻す。
 *
 * 順（1〜6 は、失敗したら戻せる。7 の失敗は、新しいほうがすでに動いているので戻さず、残りの手作業を案内する）:
 *   0. 下調べ（読み取りだけ）: 前の設定が通常のファイルで読める・repoRoot が絶対パス・新しい置き場に config.json と state がない。
 *   1. 前の daemon を止める（launchd の `touryou.daemon` が読み込まれていれば bootout）。まだ動いていれば（手で起こしたもの）、止めずに断る。
 *      SQLite（WAL）のコピーは、daemon が止まっているときだけ一貫するため。
 *   2. state をコピーする（権限を保つ。リンク・特殊ファイルは断る。`daemon.pid` は写さない）。作ったのは新しい state だけ。
 *   3. 新しい設定を一時の名前（`config.json.migrating`）で書く（`stateDir` だけを新しい state に置き換える。ほかの値は、そのまま）。
 *   4. その一時の設定を、daemon と同じ検査（`--check-config`）にかける（ignore 済みか・実パスか・git のリポジトリか）。
 *   5. `config.json` に名前を変える（ここで、新しい置き場が「設定済み」になる。`locateConfig` は、このファイルの有無で探す）。
 *   6. 登録簿に足す → supervisor を入れて動かす（`supervisor apply --yes`）→ 新しい daemon の窓口が応答するまで待つ。
 *   7. 前の常駐（`touryou.daemon` の plist）を外す（`launchd uninstall --yes`）。新しい daemon が応答してからだけ。
 *      先に外して新しいほうが起動しないと、どちらも動かなくなる。
 *
 * 1 回に移すのは、前の設定の repoRoot の 1 つだけ（複数のリポジトリは、それぞれの `/touryou:setup`）。
 * `touryou launchd init --config` で作った別名の daemon には、触れない。worktreeRoot は、前の値のまま（動いている子の作業ツリーを置き去りにしない）。
 */
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CommandResult } from "./commands.js";
import {
  appBundlePath,
  type ConfigChecker,
  configProblem,
  LSREGISTER,
  type RunResult,
} from "./launchd.js";
import { DEFAULT_PATH, pathValueOf, plainPath, readDaemonPlist } from "./launchd-plists.js";
import { addToRegistry, readRegistry, registryPath, removeFromRegistry } from "./registry.js";
import { DAEMON_PID_FILE, detectDaemon } from "./supervisor.js";

/** 前の置き場の daemon の Label（既定の設定。`--org` つきのものは、対象にしない）。 */
const LEGACY_LABEL = "touryou.daemon";
/** 移行が済んだことの印（前の設定は残すので、/setup が、また移行を勧めないように）。 */
export const MIGRATED_MARKER = "legacy-migrated.json";
/** 新しい設定を検査するときの、一時の名前。 */
export const TMP_CONFIG = "config.json.migrating";

export interface MigrateDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly checkConfig: ConfigChecker;
  /** launchctl・lsregister を実行する。 */
  readonly run: (cmd: string, args: readonly string[]) => RunResult;
  readonly uid: () => number;
  /** `touryou launchd <argv>`（前の daemon の止める・起動し直す・外す）。 */
  readonly launchd: (argv: readonly string[]) => Promise<CommandResult>;
  /** `touryou supervisor <argv>`（supervisor を入れて動かす）。 */
  readonly supervisor: (argv: readonly string[]) => Promise<CommandResult>;
  /** 未認証の `GET /v1/whoami` の状態コード。つながらなければ undefined。 */
  readonly probe?: (port: number) => Promise<number | undefined>;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 待つ時間の上限（ミリ秒）。前の daemon が止まるのと、新しい daemon が応答するのに、それぞれ使う。 */
  readonly stopWaitMs?: number;
  readonly startWaitMs?: number;
  /** state のコピー（試験で差し替える）。既定は `copyStateTree`。 */
  readonly copyState?: (from: string, to: string) => void;
}

export const DEFAULT_STOP_WAIT_MS = 15_000;
export const DEFAULT_START_WAIT_MS = 120_000;
const POLL_MS = 500;

const fail = (cause: string, exitCode: 1 | 2 = 1, stdout = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr: `${cause}\n`,
});

const lstatOr = (p: string): ReturnType<typeof lstatSync> | undefined => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};

/** 通常のファイルだけを読む（リンクは辿らない）。 */
function readRegular(p: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return undefined;
    return readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const messageOf = (e: unknown): string => String(e instanceof Error ? e.message : e);

/**
 * state の木をコピーする。権限を保ち、リンク・特殊ファイルは断る（例外）。`daemon.pid` は写さない（古い pid を持ち込まない）。
 * 写し先（`to`）は、まだないこと（ある場合は例外）。
 */
export function copyStateTree(from: string, to: string): void {
  const st = lstatSync(from);
  if (!st.isDirectory()) throw new Error(`${from} が通常のディレクトリでない（リンクなど）`);
  mkdirSync(to, { mode: 0o700 });
  chmodSync(to, st.mode & 0o777);
  for (const name of readdirSync(from)) {
    if (name === DAEMON_PID_FILE) continue;
    const src = join(from, name);
    const dst = join(to, name);
    const e = lstatSync(src);
    if (e.isDirectory()) {
      copyStateTree(src, dst);
    } else if (e.isFile()) {
      copyFileSync(src, dst, constants.COPYFILE_EXCL);
      chmodSync(dst, e.mode & 0o777);
    } else {
      throw new Error(`${src} が通常のファイル・ディレクトリでない（リンクなど）。コピーしない`);
    }
  }
}

function readNumberFile(path: string): number | undefined {
  const n = Number(readRegular(path)?.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

interface Undo {
  readonly label: string;
  readonly run: () => Promise<void> | void;
}

export async function runMigrate(
  argv: readonly string[],
  deps: MigrateDeps,
): Promise<CommandResult> {
  let yes = false;
  for (const a of argv) {
    if (a === "--yes") yes = true;
    else return fail(`不明な引数: ${a}（touryou migrate --yes）`, 2);
  }
  const TOURYOU = '"$HOME/.touryou/current/bin/touryou"';
  if (!yes) {
    return fail(
      `${TOURYOU} migrate は、前の置き場（HOME の .touryou の config.json・state・常駐）を、リポジトリの .touryou/ に移し、常駐を supervisor に切り替える。利用者の同意を取ってから --yes を付けて実行する。何もしていない`,
      2,
    );
  }
  const home = deps.env.HOME;
  if (home === undefined || home === "" || !isAbsolute(home) || !plainPath(home)) {
    return fail("HOME が、絶対パスでない・空・使えない文字を含む", 2);
  }
  const uid = deps.uid();
  if (!Number.isInteger(uid) || uid < 0) {
    return fail("利用者の uid を得られない（launchd の常駐の操作は macOS だけ）", 2);
  }

  const base = join(home, ".touryou");
  const legacyConfig = join(base, "config.json");
  const registry = registryPath(home);
  const agents = join(home, "Library", "LaunchAgents");
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = deps.isPidAlive ?? defaultAlive;

  // ---- 0. 下調べ（読み取りだけ）----
  if (lstatOr(legacyConfig) === undefined) {
    return {
      exitCode: 0,
      stdout: `移行するものがない（前の置き場の設定 ${legacyConfig} がない）。何もしていない\n`,
      stderr: "",
    };
  }
  const legacyText = readRegular(legacyConfig);
  if (legacyText === undefined) {
    return fail(
      `${legacyConfig} が通常のファイルでない（リンクなど）。何も変えずに止めた。中身を確かめてから、やり直す`,
    );
  }
  let legacy: Record<string, unknown>;
  try {
    const json = JSON.parse(legacyText) as unknown;
    if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("形が違う");
    legacy = json as Record<string, unknown>;
  } catch (e) {
    return fail(`${legacyConfig} を JSON として読めない（${messageOf(e)}）。何も変えずに止めた`);
  }
  const repoRoot = legacy.repoRoot;
  const oldState = legacy.stateDir;
  if (typeof repoRoot !== "string" || !isAbsolute(repoRoot) || !plainPath(repoRoot)) {
    return fail(
      `${legacyConfig} の repoRoot が、絶対パスでない・使えない文字を含む。何も変えずに止めた`,
    );
  }
  if (typeof oldState !== "string" || !isAbsolute(oldState)) {
    return fail(`${legacyConfig} の stateDir が、絶対パスでない。何も変えずに止めた`);
  }
  const repoSt = lstatOr(repoRoot);
  if (repoSt === undefined || !repoSt.isDirectory()) {
    return fail(
      `repoRoot（${repoRoot}）がない・ディレクトリでない。何も変えずに止めた。リポジトリを戻すか、そのリポジトリで /touryou:setup をやり直す`,
    );
  }
  const newDir = join(repoRoot, ".touryou");
  const newConfig = join(newDir, "config.json");
  const tmpConfig = join(newDir, TMP_CONFIG);
  const newState = join(newDir, "state");
  if (oldState === newState) {
    return {
      exitCode: 0,
      stdout: `前の設定の stateDir が、すでに ${newState} を指している。移すものがない。何もしていない\n`,
      stderr: "",
    };
  }
  const dirSt = lstatOr(newDir);
  if (dirSt !== undefined && !dirSt.isDirectory()) {
    return fail(
      `${newDir} が通常のディレクトリでない（リンクなど）。何も変えずに止めた。中身を確かめてから、やり直す`,
    );
  }
  for (const [p, what] of [
    [newConfig, "設定"],
    [tmpConfig, "移行の途中の設定"],
    [newState, "state"],
  ] as const) {
    if (lstatOr(p) !== undefined) {
      return fail(
        `新しい置き場に、${what}（${p}）がすでにある。上書き・混ぜることはしない。何も変えずに止めた。すでに移した（または別に作った）ものなら、移行は要らない。やり直すなら、中身を確かめて、そのファイルを自分で外してから、もう一度実行する`,
      );
    }
  }
  const reg = readRegistry(registry);
  if (reg.kind === "broken") {
    return fail(`${reg.reason}\n${reg.fix}\n何も変えずに止めた`);
  }
  const wasRegistered = reg.configs.includes(newConfig);
  const legacyPlist = readDaemonPlist(
    [join(base, "launchd"), agents],
    `${LEGACY_LABEL}.plist`,
  );
  const pathValue = (legacyPlist === undefined ? undefined : pathValueOf(legacyPlist.text)) ?? DEFAULT_PATH;

  const undo: Undo[] = [];
  const lines: string[] = [];
  const rollback = async (reason: string): Promise<CommandResult> => {
    const notes: string[] = [];
    let stuck = false;
    for (const u of [...undo].reverse()) {
      try {
        await u.run();
        notes.push(`戻した: ${u.label}`);
      } catch (e) {
        stuck = true;
        notes.push(`戻せなかった: ${u.label}（${messageOf(e)}）`);
      }
    }
    return fail(
      `${reason}\n移行を取りやめた。前の置き場（${legacyConfig}・${oldState}）は、変えていない。\n${notes.join("\n")}${stuck ? "\n戻せなかったものは、手で確かめる" : ""}`,
      1,
      lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    );
  };

  // ---- 1. 前の daemon を止める ----
  const loadedBefore =
    deps.run("launchctl", ["print", `gui/${uid}/${LEGACY_LABEL}`]).status === 0;
  if (loadedBefore) {
    const r = await deps.launchd(["stop"]);
    if (r.exitCode !== 0) {
      return fail(
        `前の daemon（${LEGACY_LABEL}）を止められない。何も変えていない。\n${r.stderr.trim()}`,
      );
    }
    lines.push(`前の daemon（${LEGACY_LABEL}）を止めた`);
    undo.push({
      label: `前の daemon（${LEGACY_LABEL}）を起動し直した`,
      run: async () => {
        const back = await deps.launchd(["apply", "--yes"]);
        if (back.exitCode !== 0) {
          throw new Error(
            `${TOURYOU} launchd apply --yes で起動し直す（${back.stderr.trim() || back.stdout.trim()}）`,
          );
        }
      },
    });
  }
  const stopDeadline = Date.now() + (deps.stopWaitMs ?? DEFAULT_STOP_WAIT_MS);
  let live = await detectDaemon(oldState, deps);
  while (live !== "absent" && Date.now() < stopDeadline) {
    await sleep(POLL_MS);
    live = await detectDaemon(oldState, deps);
  }
  if (live !== "absent") {
    return rollback(
      `前の daemon がまだ動いている（${live === "running" ? "窓口が応答している" : "pid が生きているが応答しない"}）。動いているままでは、state を一貫してコピーできない。手で起こしたものなら、その端末で止めてから（Ctrl-C）、もう一度実行する`,
    );
  }

  // ---- 2. state をコピーする ----
  const createdDir = dirSt === undefined;
  try {
    if (createdDir) {
      mkdirSync(newDir, { mode: 0o700 });
      undo.push({
        label: `${newDir}（作ったもの。空のときだけ）`,
        run: () => {
          try {
            rmdirSync(newDir);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw e;
          }
        },
      });
    }
  } catch (e) {
    return rollback(`${newDir} を作れない（${messageOf(e)}）`);
  }
  undo.push({
    label: `新しい state（${newState}）を消した（コピーしたもの）`,
    run: async () => {
      // 新しい daemon が起きていたら、先に止める（動いたまま消さない）
      const pid = readNumberFile(join(newState, DAEMON_PID_FILE));
      if (pid !== undefined && alive(pid)) {
        (deps.kill ?? ((p, s) => process.kill(p, s)))(pid, "SIGTERM");
        const until = Date.now() + (deps.stopWaitMs ?? DEFAULT_STOP_WAIT_MS);
        while (alive(pid) && Date.now() < until) await sleep(POLL_MS);
        if (alive(pid)) {
          throw new Error(
            `新しい daemon（pid ${pid}）が止まらない。止めてから、${newState} を自分で消す`,
          );
        }
      }
      rmSync(newState, { recursive: true, force: true });
    },
  });
  try {
    if (lstatOr(oldState) === undefined) {
      mkdirSync(newState, { mode: 0o700 }); // 前の state がない（daemon を一度も起こしていない）。空で作る
    } else {
      (deps.copyState ?? copyStateTree)(oldState, newState);
    }
  } catch (e) {
    return rollback(`state をコピーできない（${messageOf(e)}）`);
  }
  lines.push(`state をコピーした: ${oldState} → ${newState}（元は残した）`);

  // ---- 3. 新しい設定を、一時の名前で書く ----
  undo.push({ label: `${tmpConfig} を消した`, run: () => rmSync(tmpConfig, { force: true }) });
  try {
    const next = { ...legacy, stateDir: newState };
    writeFileSync(tmpConfig, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (e) {
    return rollback(`新しい設定を書けない（${messageOf(e)}）`);
  }

  // ---- 4. 検査（daemon と同じ） ----
  const problem = configProblem(home, pathValue, deps.checkConfig, tmpConfig);
  if (problem !== undefined) {
    return rollback(
      `${problem}\n新しい置き場の stateDir は repoRoot の中にあるので、${join(repoRoot, ".gitignore")} に .touryou/ を足してあるかも確かめる（touryou は .gitignore を書き換えない）`,
    );
  }

  // ---- 5. 設定の名前を変える（ここから、新しい置き場が「設定済み」） ----
  try {
    renameSync(tmpConfig, newConfig);
  } catch (e) {
    return rollback(`設定の名前を変えられない（${messageOf(e)}）`);
  }
  undo.push({ label: `${newConfig} を消した`, run: () => rmSync(newConfig, { force: true }) });
  lines.push(`新しい設定を置いた: ${newConfig}（検査を通った）`);

  // ---- 6. 切り替え: 登録簿 → supervisor → 新しい daemon の応答 ----
  const added = addToRegistry(registry, newConfig);
  if (!added.ok) return rollback(`登録簿に足せない（${added.reason}）`);
  if (!wasRegistered) {
    undo.push({
      label: "登録簿から外した",
      run: () => {
        const r = removeFromRegistry(registry, newConfig);
        if (!r.ok) throw new Error(r.reason);
      },
    });
  }
  lines.push(`登録簿に足した: ${registry}`);
  const sup = await deps.supervisor(["apply", "--yes"]);
  if (sup.exitCode !== 0) {
    return rollback(`supervisor を入れて動かせない。\n${sup.stderr.trim() || sup.stdout.trim()}`);
  }
  lines.push("supervisor を入れて動かした");
  const startDeadline = Date.now() + (deps.startWaitMs ?? DEFAULT_START_WAIT_MS);
  const probe = deps.probe ?? (async () => undefined);
  let up = false;
  for (;;) {
    const port = readNumberFile(join(newState, "port"));
    const pid = readNumberFile(join(newState, DAEMON_PID_FILE));
    // supervisor が起こした印（daemon.pid）と、窓口の応答（未認証の whoami が 401）の両方
    if (pid !== undefined && port !== undefined && (await probe(port)) === 401) {
      up = true;
      break;
    }
    if (Date.now() >= startDeadline) break;
    await sleep(POLL_MS);
  }
  if (!up) {
    return rollback(
      `新しい daemon の窓口が、${Math.round((deps.startWaitMs ?? DEFAULT_START_WAIT_MS) / 1000)} 秒たっても応答しない。原因は ${join(newDir, "logs", "daemon.log")} を見る`,
    );
  }
  lines.push("新しい daemon が応答した（窓口が 401 を返した）");

  // ---- 7. 前の常駐を外す（新しいほうが動いてから）。ここからは戻さない ----
  const tail: string[] = [];
  let exitCode: 0 | 1 = 0;
  if (lstatOr(join(agents, `${LEGACY_LABEL}.plist`)) !== undefined || loadedBefore) {
    const un = await deps.launchd(["uninstall", "--yes"]);
    if (un.exitCode === 0) {
      lines.push(`前の常駐（${LEGACY_LABEL}）を外した`);
    } else {
      exitCode = 1;
      tail.push(
        `前の常駐（${LEGACY_LABEL}）を外せなかった（新しい daemon は動いている）。このままだと、次のログインで前の daemon も起動して、同じ作業ツリーを 2 つが扱う。${TOURYOU} launchd uninstall --yes を手で実行して外す`,
        un.stderr.trim() || un.stdout.trim(),
      );
    }
    // 前の常駐を外すと、TouRyou.app の登録も解かれる。supervisor が使うので、登録し直す（失敗しても動きには影響しない）
    if (deps.run(LSREGISTER, ["-f", appBundlePath(base)]).status !== 0) {
      tail.push("TouRyou.app の LaunchServices の登録に失敗した（常駐には影響しない）");
    }
  }
  try {
    writeFileSync(
      join(base, MIGRATED_MARKER),
      `${JSON.stringify({ from: legacyConfig, to: newConfig }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (e) {
    tail.push(
      `移行済みの印（${join(base, MIGRATED_MARKER)}）を書けなかった（/setup が、また移行を勧めることがある）: ${messageOf(e)}`,
    );
  }
  lines.push(
    "",
    `前の置き場の設定と state は、消していない（${legacyConfig}・${oldState}）。要らなければ、動作を確かめてから、自分で消す`,
    "新しい daemon に、このセッションの node をつなぎ直す（/mcp で plugin:touryou:node を Reconnect。なければ Claude Code を起動し直す）。そのあと /touryou:start で確かめる",
    ...(tail.length === 0 ? [] : ["", ...tail]),
  );
  return { exitCode, stdout: `${lines.join("\n")}\n`, stderr: exitCode === 0 ? "" : "移行は済んだが、後始末が残っている\n" };
}
