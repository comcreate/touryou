/**
 * supervisor の常駐（launchd）と、その操作（`touryou supervisor …`。#288・#300。`docs/launchd.md`）。
 *
 * - 常駐は supervisor の 1 項目だけ（Label `touryou.supervisor`）。supervisor が、登録簿（`~/.touryou/registry.json`）の設定ごとに、
 *   daemon を別プロセスで起こして見張る（`supervisor.ts`）。daemon ごとの plist は作らない（前の形〔launchd init〕は、移行まで残る）。
 * - daemon は detached で起こすので、plist に `AbandonProcessGroup` を付ける（launchd が supervisor を止めるとき、同じプロセスグループの daemon も殺さない）。
 * - 秘密を扱わない。永続化（apply）と削除（uninstall）は `--yes` がないと何もしない。
 * - 登録を外す（unregister）のは、登録簿の 1 行だけ。daemon・設定・state には触れない。supervisor 自体は uninstall で外す。
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { locateConfig } from "@touryou/core";
import type { CommandResult } from "./commands.js";
import {
  appBundlePath,
  argsArray,
  type ConfigChecker,
  canonicalPath,
  configProblem,
  LSREGISTER,
  plistBody,
  type RunResult,
  usableConfigPath,
} from "./launchd.js";
import {
  DEFAULT_PATH,
  daemonPlistNames,
  pathPrefixArgs,
  pathValueOf,
  plainPath,
  readDaemonPlist,
} from "./launchd-plists.js";
import { addToRegistry, inspectEntries, readRegistry, registryPath, removeFromRegistry } from "./registry.js";
import {
  DAEMON_PID_FILE,
  detectDaemon,
  makeSpawnDaemon,
  readStateDir,
  type SupervisorEntryState,
  type SupervisorReport,
  superviseLoop,
} from "./supervisor.js";

export const SUPERVISOR_LABEL = "touryou.supervisor";
export const SUPERVISOR_PLIST = `${SUPERVISOR_LABEL}.plist`;
/** reconcile の間隔（既定）。 */
export const SUPERVISOR_INTERVAL_MS = 30_000;

/** plist の ProgramArguments。TouRyou.app の中の node で、同梱の touryou（cli）の `supervisor run` を直に起こす。current のリンクを通す。 */
export const supervisorProgramArguments = (base: string): readonly string[] => [
  join(appBundlePath(base), "Contents", "MacOS", "TouRyou"),
  join(base, "current", "lib", "node_modules", "@touryou", "cli", "dist", "bin.js"),
  "supervisor",
  "run",
];

/** daemon を起こす入口（supervisor 自身と同じ node で、同梱の daemon の JS を起こす）。 */
export const daemonCommandOf = (base: string, nodeExe: string): readonly string[] => [
  nodeExe,
  join(base, "current", "lib", "dist", "bin.js"),
];

/** supervisor の plist（秘密を含まない）。 */
export function supervisorPlistText(opts: {
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly log: string;
  readonly path: string;
}): string {
  return plistBody(
    argsArray(opts.programArguments),
    { label: SUPERVISOR_LABEL, ...opts },
    "",
    "\n  <key>AbandonProcessGroup</key><true/>",
  );
}

export interface SupervisorCommandDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 実行した場所（設定を上へ探す起点）。 */
  readonly cwd: () => string | undefined;
  /** 設定ファイルがあるか。 */
  readonly exists: (path: string) => boolean;
  /** launchctl・lsregister を実行する。 */
  readonly run: (cmd: string, args: readonly string[]) => RunResult;
  readonly checkConfig: ConfigChecker;
  readonly uid: () => number;
  readonly probe?: (port: number) => Promise<number | undefined>;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export const SUPERVISOR_SUBCOMMANDS = [
  "run",
  "init",
  "apply",
  "status",
  "stop",
  "restart",
  "register",
  "unregister",
  "uninstall",
] as const;
type Sub = (typeof SUPERVISOR_SUBCOMMANDS)[number];

const TOURYOU = '"$HOME/.touryou/current/bin/touryou"';

const fail = (cause: string, exitCode: 1 | 2 = 2, stdout = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr: `${cause}\n`,
});
const ok = (lines: readonly string[]): CommandResult => ({
  exitCode: 0,
  stdout: `${lines.join("\n")}\n`,
  stderr: "",
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
/** 一時ファイルに書いてから置き換える。 */
function writeAtomic(path: string, text: string, mode: number): void {
  const tmp = `${path}.new`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, { flag: "wx", mode });
  renameSync(tmp, path);
}

interface Ctx {
  readonly deps: SupervisorCommandDeps;
  readonly home: string;
  readonly base: string;
  readonly plistSrc: string;
  readonly plistDest: string;
  readonly log: string;
  readonly domain: string;
  readonly registry: string;
}

/** 対象の設定: `--config <絶対パス>`・`--all`・なければ実行した場所から上へ探した設定。 */
type Target =
  | { readonly kind: "all" }
  | { readonly kind: "one"; readonly config: string }
  | { readonly kind: "none"; readonly reason: string };

function resolveTarget(
  configArg: string | undefined,
  all: boolean,
  deps: SupervisorCommandDeps,
): Target | CommandResult {
  if (all && configArg !== undefined) return fail("--all と --config は、同時に指定できない");
  if (all) return { kind: "all" };
  if (configArg !== undefined) {
    if (!usableConfigPath(configArg)) {
      return fail(
        "--config は、設定ファイルの絶対パスにする。英数字・. _ / @ + 空白 - だけが使える（.. の要素・// は使えない）",
      );
    }
    return { kind: "one", config: canonicalPath(configArg) };
  }
  const located = locateConfig({ env: deps.env, cwd: deps.cwd(), exists: deps.exists });
  if (!located.ok) return { kind: "none", reason: `${located.reason}。直し方: ${located.fix}` };
  if (!usableConfigPath(located.path)) {
    return fail("見つけた設定のパスが、絶対パスでない・使えない文字を含む");
  }
  return { kind: "one", config: canonicalPath(located.path) };
}

const isTarget = (t: Target | CommandResult): t is Target => "kind" in t;

/** インストール済みの plist の PATH（なければ既定）。daemon の設定の検査を、daemon が動くときと同じ PATH で行う。 */
function pathOf(ctx: Ctx): string {
  const plist = readDaemonPlist([join(ctx.base, "launchd"), join(ctx.home, "Library", "LaunchAgents")], SUPERVISOR_PLIST);
  return (plist === undefined ? undefined : pathValueOf(plist.text)) ?? DEFAULT_PATH;
}

function plistFor(ctx: Ctx, pathValue: string): string {
  return supervisorPlistText({
    programArguments: supervisorProgramArguments(ctx.base),
    workingDirectory: ctx.base,
    log: ctx.log,
    path: pathValue,
  });
}

function loaded(ctx: Ctx): { loaded: boolean; state?: string; pid?: string } {
  const r = ctx.deps.run("launchctl", ["print", `${ctx.domain}/${SUPERVISOR_LABEL}`]);
  if (r.status !== 0) return { loaded: false };
  const state = /^\s*state = (\S+)/m.exec(r.stdout)?.[1];
  const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1];
  return { loaded: true, ...(state === undefined ? {} : { state }), ...(pid === undefined ? {} : { pid }) };
}

/** init: plist を `<base>/launchd` に作る（同じ内容なら何もしない。違う内容の既存は上書きしない）。 */
function init(ctx: Ctx, pathValue: string): CommandResult {
  if (lstatOr(join(ctx.base, "current")) === undefined) {
    return fail("/setup が済んでいない（HOME の .touryou に current がない）。先に /setup を実行する", 1);
  }
  const text = plistFor(ctx, pathValue);
  const dir = join(ctx.base, "launchd");
  const logsDir = join(ctx.base, "logs");
  for (const d of [dir, logsDir]) {
    const st = lstatOr(d);
    if (st !== undefined && !st.isDirectory()) {
      return fail(`${d} が通常のディレクトリでない（シンボリックリンクなど）。何も書かずに止めた`, 1);
    }
  }
  const st = lstatOr(ctx.plistSrc);
  if (st !== undefined && readRegular(ctx.plistSrc) !== text) {
    return fail(
      `${ctx.plistSrc} が、生成する内容と違う（手で直した・--path-prefix が違う・通常のファイルでない）。何も書かずに止めた。要らなければ ${TOURYOU} supervisor uninstall --yes で外してから、やり直す`,
      1,
    );
  }
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (st === undefined) writeAtomic(ctx.plistSrc, text, 0o644);
  return ok([st === undefined ? `生成した: ${ctx.plistSrc}` : `既存と同じ（そのまま）: ${ctx.plistSrc}`]);
}

async function apply(ctx: Ctx, pathValue: string): Promise<CommandResult> {
  const made = init(ctx, pathValue);
  if (made.exitCode !== 0) return made;
  const out = [made.stdout.trimEnd()];
  const agents = join(ctx.home, "Library", "LaunchAgents");
  const agentsSt = lstatOr(agents);
  if (agentsSt !== undefined && !agentsSt.isDirectory()) {
    return fail(`${agents} が通常のディレクトリでない（シンボリックリンクなど）。何も変えずに止めた`, 1);
  }
  const text = plistFor(ctx, pathValue);
  const destSt = lstatOr(ctx.plistDest);
  if (destSt !== undefined && readRegular(ctx.plistDest) !== text) {
    return fail(
      `${ctx.plistDest} が、生成した plist と違う（または通常のファイルでない）。何も変えずに止めた。中身を確かめ、要らなければ ${TOURYOU} supervisor uninstall --yes で外してから、やり直す`,
      1,
    );
  }
  if (agentsSt === undefined) mkdirSync(agents, { recursive: true, mode: 0o755 });
  if (destSt === undefined) {
    writeFileSync(ctx.plistDest, text, { flag: "wx", mode: 0o644 });
    out.push(`置いた: ${ctx.plistDest}`);
  }
  // ログイン項目が TouRyou の名前を引けるように登録する（失敗しても常駐は動く）
  if (ctx.deps.run(LSREGISTER, ["-f", appBundlePath(ctx.base)]).status !== 0) {
    out.push("TouRyou.app の LaunchServices の登録に失敗した（常駐には影響しない）");
  }
  if (loaded(ctx).loaded) {
    out.push(`${SUPERVISOR_LABEL}: 読み込み済み（そのまま）`);
  } else {
    const r = ctx.deps.run("launchctl", ["bootstrap", ctx.domain, ctx.plistDest]);
    if (r.status !== 0) {
      return fail(`launchctl bootstrap ${SUPERVISOR_LABEL} に失敗（終了コード ${r.status ?? "なし"}）: ${r.stderr.trim()}`, 1, `${out.join("\n")}\n`);
    }
    out.push(`${SUPERVISOR_LABEL}: 読み込んだ`);
  }
  out.push(
    "",
    "ログイン時に自動で動くようになった。supervisor は、登録簿（~/.touryou/registry.json）の設定ごとに、daemon を起こして見張る。リポジトリの登録は /touryou:setup、または touryou supervisor register",
  );
  return ok(out);
}

function stop(ctx: Ctx): CommandResult {
  if (!loaded(ctx).loaded) return ok([`${SUPERVISOR_LABEL}: 読み込まれていない（そのまま）`]);
  const r = ctx.deps.run("launchctl", ["bootout", `${ctx.domain}/${SUPERVISOR_LABEL}`]);
  if (r.status !== 0) return fail(`launchctl bootout ${SUPERVISOR_LABEL} に失敗: ${r.stderr.trim()}`, 1);
  return ok([
    `${SUPERVISOR_LABEL}: 止めた`,
    "起こした daemon は止まらない（supervisor が落ちても、daemon は残る）。plist は残るので、次のログインで、また動く。すぐ動かすなら supervisor apply --yes",
  ]);
}

function uninstall(ctx: Ctx): CommandResult {
  const out: string[] = [];
  const kept: string[] = [];
  if (loaded(ctx).loaded) {
    const r = ctx.deps.run("launchctl", ["bootout", `${ctx.domain}/${SUPERVISOR_LABEL}`]);
    if (r.status !== 0) {
      return fail(`launchctl bootout ${SUPERVISOR_LABEL} に失敗: ${r.stderr.trim()}。何も消していない`, 1);
    }
    out.push(`${SUPERVISOR_LABEL}: 止めた`);
  }
  const pathValue = pathOf(ctx);
  for (const p of [ctx.plistDest, ctx.plistSrc]) {
    const st = lstatOr(p);
    if (st === undefined) continue;
    if (st.isFile() && readRegular(p) === plistFor(ctx, pathValue)) {
      rmSync(p);
      out.push(`消した: ${p}`);
    } else {
      kept.push(`${p}（touryou が生成したものと判定できない〔手で直した・リンクなど〕。残した）`);
    }
  }
  // 前の形の daemon の plist が残っているうちは、TouRyou.app の登録を解かない
  if (daemonPlistNames(join(ctx.home, "Library", "LaunchAgents")).length === 0) {
    ctx.deps.run(LSREGISTER, ["-u", appBundlePath(ctx.base)]);
  }
  out.push(
    `残した: ${join(ctx.base, "logs")}（ログ）・${ctx.registry}（登録簿）・各リポジトリの .touryou（設定・state・daemon）。起こした daemon は止まらない`,
  );
  if (kept.length > 0) out.push("", ...kept);
  return {
    exitCode: kept.length > 0 ? 1 : 0,
    stdout: `${out.join("\n")}\n`,
    stderr: kept.length > 0 ? "消せなかったものがある\n" : "",
  };
}

/** 設定 1 つの、実態（読み取りだけ）。 */
async function describeEntry(ctx: Ctx, config: string, present: boolean): Promise<string> {
  if (!present) return `${config}: 設定ファイルがない（登録だけが残っている。外すなら supervisor unregister --config <設定>）`;
  const dirs = readStateDir(config);
  if ("invalid" in dirs) return `${config}: ${dirs.invalid}`;
  const live = await detectDaemon(dirs.stateDir, {
    ...(ctx.deps.probe === undefined ? {} : { probe: ctx.deps.probe }),
    ...(ctx.deps.isPidAlive === undefined ? {} : { isPidAlive: ctx.deps.isPidAlive }),
  });
  const word = {
    running: "daemon が動いている（窓口が応答）",
    unresponsive: "daemon の pid は生きているが、窓口が応答しない",
    absent: "daemon が動いていない（supervisor が、次の周で起こす）",
  }[live];
  return `${config}: ${word}`;
}

async function status(ctx: Ctx, target: Target): Promise<CommandResult> {
  const lines: string[] = [];
  const info = loaded(ctx);
  lines.push(
    info.loaded
      ? `${SUPERVISOR_LABEL}: 読み込み済み（state=${info.state ?? "不明"}${info.pid === undefined ? "" : `・pid=${info.pid}`}）`
      : lstatOr(ctx.plistDest) === undefined
        ? `${SUPERVISOR_LABEL}: 読み込まれていない（常駐にしていない）。常駐にするなら /touryou:setup`
        : `${SUPERVISOR_LABEL}: 読み込まれていない（stop で止めた後）。すぐ動かすなら ${TOURYOU} supervisor apply --yes（利用者の同意のあとだけ）`,
  );
  const reg = readRegistry(ctx.registry);
  if (reg.kind === "broken") return fail(`${reg.reason}\n${reg.fix}`, 1, `${lines.join("\n")}\n`);
  const entries = inspectEntries(reg.configs, ctx.deps.exists);
  const shown = target.kind === "one" ? entries.filter((e) => e.config === target.config) : target.kind === "all" ? entries : [];
  if (target.kind === "one" && shown.length === 0) {
    lines.push(`${target.config}: 登録されていない（登録するのは /touryou:setup、または supervisor register）`);
  }
  if (target.kind === "none") {
    lines.push(`対象のリポジトリが決まらない（${target.reason}）。登録済み: ${reg.configs.length} 件（全部を見るなら --all）`);
  }
  for (const e of shown) lines.push(await describeEntry(ctx, e.config, e.present));
  const okAll = info.loaded && info.state === "running";
  return { exitCode: okAll ? 0 : 1, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

function register(ctx: Ctx, target: Target): CommandResult {
  if (target.kind !== "one") {
    return fail(target.kind === "all" ? "register は、--all を取らない（--config か、リポジトリの中で実行する）" : target.reason, 1);
  }
  if (!ctx.deps.exists(target.config)) return fail(`設定ファイルがない（${target.config}）。先に /touryou:setup を実行する`, 1);
  const problem = configProblem(ctx.home, pathOf(ctx), ctx.deps.checkConfig, target.config);
  if (problem !== undefined) return fail(problem, 1);
  const r = addToRegistry(ctx.registry, target.config);
  if (!r.ok) return fail(`${r.reason}\n${r.fix}`, 1);
  return ok([
    `登録した: ${target.config}`,
    `登録は ${r.configs.length} 件。supervisor が、次の周（${SUPERVISOR_INTERVAL_MS / 1000} 秒ごと）に daemon を起こす（すでに動いている daemon があれば、起こさない〔先勝ち〕）`,
  ]);
}

function unregister(ctx: Ctx, target: Target): CommandResult {
  if (target.kind === "none") return fail(target.reason, 1);
  const reg = readRegistry(ctx.registry);
  if (reg.kind === "broken") return fail(`${reg.reason}\n${reg.fix}`, 1);
  const targets = target.kind === "all" ? reg.configs : [target.config];
  const out: string[] = [];
  for (const c of targets) {
    const r = removeFromRegistry(ctx.registry, c);
    if (!r.ok) return fail(`${r.reason}\n${r.fix}`, 1, `${out.join("\n")}\n`);
    out.push(`登録を外した: ${c}`);
  }
  if (out.length === 0) out.push("登録されたものがない（何もしていない）");
  out.push("daemon・設定・state には触れていない。動いている daemon は、そのまま動く");
  return ok(out);
}

/** restart: 動いている daemon（supervisor が起こした pid の記録があるもの）に SIGTERM を送る。supervisor が、次の周で起こし直す。 */
async function restart(ctx: Ctx, target: Target): Promise<CommandResult> {
  if (target.kind === "none") return fail(target.reason, 1);
  const reg = readRegistry(ctx.registry);
  if (reg.kind === "broken") return fail(`${reg.reason}\n${reg.fix}`, 1);
  const configs = target.kind === "all" ? reg.configs : [target.config];
  const kill = ctx.deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const alive = ctx.deps.isPidAlive ?? ((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  });
  const out: string[] = [];
  let failed = false;
  for (const c of configs) {
    const dirs = readStateDir(c);
    if ("invalid" in dirs) {
      out.push(`${c}: ${dirs.invalid}（飛ばした）`);
      failed = true;
      continue;
    }
    const live = await detectDaemon(dirs.stateDir, {
      ...(ctx.deps.probe === undefined ? {} : { probe: ctx.deps.probe }),
      ...(ctx.deps.isPidAlive === undefined ? {} : { isPidAlive: ctx.deps.isPidAlive }),
    });
    if (live === "absent") {
      out.push(`${c}: daemon が動いていない（supervisor が、次の周で起こす）`);
      continue;
    }
    let pid: number | undefined;
    try {
      const n = Number(readFileSync(join(dirs.stateDir, DAEMON_PID_FILE), "utf8").trim());
      pid = Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      pid = undefined;
    }
    if (pid === undefined || !alive(pid)) {
      out.push(
        `${c}: supervisor が起こした記録（${DAEMON_PID_FILE}）がない。手で起こした daemon は、止めない。端末で止めてから、supervisor に起こさせる`,
      );
      failed = true;
      continue;
    }
    kill(pid, "SIGTERM");
    out.push(`${c}: daemon（pid ${pid}）に終了を送った。supervisor が、次の周で起こし直す`);
  }
  if (out.length === 0) out.push("登録されたものがない（何もしていない）");
  return { exitCode: failed ? 1 : 0, stdout: `${out.join("\n")}\n`, stderr: "" };
}

export async function runSupervisorCommand(
  argv: readonly string[],
  deps: SupervisorCommandDeps,
): Promise<CommandResult> {
  const sub = argv[0] as Sub;
  if (!SUPERVISOR_SUBCOMMANDS.includes(sub) || sub === "run") {
    return fail(`不明なサブコマンド: ${argv[0] ?? ""}（init・apply・status・stop・restart・register・unregister・uninstall）`);
  }
  let configArg: string | undefined;
  let all = false;
  let yes = false;
  let pathPrefix: string | undefined;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--config" || a === "--path-prefix") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return fail(`${a} には値を指定する`);
      if (a === "--config") configArg = v;
      else pathPrefix = v;
      i += 1;
    } else if (a === "--all") {
      all = true;
    } else if (a === "--yes" && (sub === "apply" || sub === "uninstall")) {
      yes = true;
    } else {
      return fail(`不明な引数: ${a}`);
    }
  }
  if ((sub === "apply" || sub === "uninstall") && !yes) {
    return fail(
      sub === "apply"
        ? `${TOURYOU} supervisor apply は、ログイン時に自動で動く設定（永続化）を入れる。利用者の同意を取ってから --yes を付けて実行する。何もしていない`
        : `${TOURYOU} supervisor uninstall は、supervisor の常駐を止めて生成物を消す。利用者の同意を取ってから --yes を付けて実行する。何もしていない`,
    );
  }
  const home = deps.env.HOME;
  if (home === undefined || home === "" || !isAbsolute(home) || !plainPath(home)) {
    return fail("HOME が、絶対パスでない・空・使えない文字を含む");
  }
  const uid = deps.uid();
  if (!Number.isInteger(uid) || uid < 0) {
    return fail("利用者の uid を得られない（launchd の常駐の操作は macOS だけ）");
  }
  let pathValue = DEFAULT_PATH;
  if (pathPrefix !== undefined) {
    if (sub !== "init" && sub !== "apply") return fail("--path-prefix は、init・apply だけで使える");
    const dirs = pathPrefix.split(":");
    if (dirs.some((d) => d === "" || !plainPath(d))) {
      return fail("--path-prefix は、絶対パスのディレクトリ（コロン区切り）にする。英数字・. _ / @ + 空白 - だけが使える（.. の要素・// は使えない）");
    }
    pathValue = `${pathPrefix}:${DEFAULT_PATH}`;
  }
  const base = join(home, ".touryou");
  const ctx: Ctx = {
    deps,
    home,
    base,
    plistSrc: join(base, "launchd", SUPERVISOR_PLIST),
    plistDest: join(home, "Library", "LaunchAgents", SUPERVISOR_PLIST),
    log: join(base, "logs", "supervisor.log"),
    domain: `gui/${uid}`,
    registry: registryPath(home),
  };
  // init・apply で --path-prefix がなければ、すでにある plist の PATH を引き継ぐ（apply の再実行で、PATH を黙って変えない）
  const installedPath = pathPrefix === undefined ? pathOf(ctx) : pathValue;
  switch (sub) {
    case "init":
      return init(ctx, installedPath);
    case "apply":
      return apply(ctx, installedPath);
    case "stop":
      return stop(ctx);
    case "uninstall":
      return uninstall(ctx);
    default:
      break;
  }
  const target = resolveTarget(configArg, all, deps);
  if (!isTarget(target)) return target;
  switch (sub) {
    case "status":
      return status(ctx, target);
    case "register":
      return register(ctx, target);
    case "unregister":
      return unregister(ctx, target);
    default:
      return restart(ctx, target);
  }
}

const describeState = (e: SupervisorEntryState): string =>
  "reason" in e ? `${e.state}: ${e.reason}` : `${e.state}（pid ${e.pid}）`;

/** 1 周の報告を、変わったときだけ出す 1 行にする（毎周、同じ行を出さない）。 */
export function reportLine(r: SupervisorReport): string {
  return r.kind === "broken"
    ? `登録簿が使えない: ${r.reason}（${r.fix}）`
    : r.entries.map((e) => `${e.config} → ${describeState(e)}`).join("\n");
}

/**
 * `touryou supervisor run`: 登録簿の設定ごとに daemon を起こして見張る（止まるまで戻らない）。
 * `signal` が中止されたら、見張りだけを止めて 0 で終わる（起こした daemon には、何もしない）。
 */
export function superviseForever(opts: {
  readonly home: string;
  readonly nodeExe: string;
  readonly signal: AbortSignal;
  readonly write: (line: string) => void;
  readonly intervalMs?: number;
  readonly probe?: (port: number) => Promise<number | undefined>;
}): Promise<CommandResult> {
  const base = join(opts.home, ".touryou");
  let last = "";
  const loop = superviseLoop(
    {
      registryFile: registryPath(opts.home),
      spawnDaemon: makeSpawnDaemon(daemonCommandOf(base, opts.nodeExe)),
      ...(opts.probe === undefined ? {} : { probe: opts.probe }),
    },
    {
      intervalMs: opts.intervalMs ?? SUPERVISOR_INTERVAL_MS,
      onReport: (r) => {
        const line = reportLine(r);
        if (line === last) return;
        last = line;
        opts.write(`${new Date().toISOString()} ${line === "" ? "登録された設定がない" : line}`);
      },
    },
  );
  return new Promise((resolve) => {
    const done = (): void => {
      loop.stop();
      resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    if (opts.signal.aborted) done();
    else opts.signal.addEventListener("abort", done, { once: true });
  });
}

export { pathPrefixArgs };
