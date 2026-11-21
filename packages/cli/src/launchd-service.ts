/**
 * `touryou launchd apply|status|restart|stop|uninstall`。`touryou launchd init` が生成した plist・起動スクリプトを使い、
 * launchd の常駐を、決まった操作だけで行う（`docs/launchd.md`）。
 *
 * 決めごと:
 * - 永続化（apply）と削除（uninstall）は、`--yes` がないと何もしない（利用者の同意を取ったことの明示。/setup・/service の定型文で聞く）。
 * - 秘密を扱わない（子の認証は扱わない）。
 * - 既存のファイルを黙って上書きしない。消すのは、touryou が生成したと判定できたものだけ（Label・起動スクリプトの場所・見出しの行）。
 * - logs と state は消さない。
 * - 常駐は daemon だけ。名前を touryou にそろえる前の常駐は扱わない（手で外す。docs/launchd.md）。
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CommandResult } from "./commands.js";
import type { RunResult } from "./launchd.js";
import {
  appBundlePath,
  type ConfigChecker,
  configPathOf,
  configProblem,
  DAEMON_PLIST,
  DEFAULT_PATH,
  daemonNameOf,
  daemonProgramArguments,
  describeSharing,
  LSREGISTER,
  labelOf,
  legacyPlistText,
  legacyScriptPath,
  maskValues,
  OTHER_PLIST,
  otherPlistNames,
  plainPath,
  plistConfigOf,
  plistText,
  REVERSE_DOMAIN,
  runDaemonScript,
  stateDirOf,
  stateDirSharedWith,
  usableConfigPath,
  v011PlistText,
} from "./launchd.js";

export type { RunResult } from "./launchd.js";

export interface LaunchdServiceDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 外部コマンド（launchctl と lsregister だけ）を実行する。 */
  readonly run: (cmd: string, args: readonly string[]) => RunResult;
  /** apply の前の、設定の検査（`touryou-daemon --check-config`）を実行する。 */
  readonly checkConfig: ConfigChecker;
  readonly uid: () => number;
  /** `http://127.0.0.1:<port>/v1/whoami` の HTTP の状態コード。届かなければ undefined。 */
  readonly probe: (port: number) => Promise<number | undefined>;
  readonly sleep: (ms: number) => Promise<void>;
  /** daemon の窓口の応答を待つ時間（ミリ秒。既定 60 秒）。 */
  readonly waitMs?: number;
  /** 今の時刻（ミリ秒。試験で差し替える）。 */
  readonly now?: () => number;
}

export const SERVICE_SUBCOMMANDS = ["apply", "status", "restart", "stop", "uninstall"] as const;
type Sub = (typeof SERVICE_SUBCOMMANDS)[number];

const TOURYOU = '"$HOME/.touryou/current/bin/touryou"';

/** この操作の対象（--config・--others・--org）を、そのまま付けた touryou launchd のコマンド。案内に出して、同じ対象で打ち直せるようにする。 */
const cmd = (ctx: Ctx, sub: Sub, flags = ""): string =>
  `${TOURYOU} launchd ${sub}${flags}${ctx.selector}`;

/** apply・restart が途中で止まったときの状態の案内。 */
const partial = (ctx: Ctx): string =>
  `daemon は読み込み済みのまま（KeepAlive で動き続けうる）。止めるなら ${cmd(ctx, "stop")}、直してからやり直すなら ${cmd(ctx, "apply", " --yes")}`;

const fail = (cause: string, exitCode: 1 | 2 = 2, stdout = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr: `${cause}\n`,
});

const lstatOr = (p: string): Stats | undefined => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};
/** 通常のファイルだけを読む（リンクは辿らない。開いたあとで通常のファイルかを確かめる）。 */
const readOr = (p: string): string | undefined => {
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
};

interface Ctx {
  readonly deps: LaunchdServiceDeps;
  readonly home: string;
  readonly base: string;
  readonly binDir: string;
  readonly logsDir: string;
  readonly plistDir: string;
  readonly agentsDir: string;
  readonly domain: string;
  readonly units: readonly Unit[];
  /** 案内のコマンドに付ける、対象の指定（` --config "<設定>"`・` --others`・` --org <組織>`）。既定の設定だけなら空。 */
  readonly selector: string;
}
interface Unit {
  /** `daemon`（既定の設定）か、`daemon-<8 文字>`（`--config` の設定。#165）。 */
  readonly name: string;
  /** daemon の設定ファイルと、その stateDir（daemon ごとに別）。stateDir は、設定を読めないとき undefined（uninstall だけが、この unit を扱う）。 */
  readonly configPath: string;
  readonly stateDir: string | undefined;
  /** 既定の設定（`<base>/config.json`）の daemon か。 */
  readonly isDefault: boolean;
  readonly label: string;
  /** 古い形（v0.1.0 まで）の起動スクリプト。いまは生成しない。古い形と同じなら、uninstall で消す。 */
  readonly legacyScript: string;
  readonly plistSrc: string;
  readonly plistDest: string;
  readonly log: string;
}

interface UnitInfo {
  readonly loaded: boolean;
  readonly state?: string;
  readonly pid?: string;
  readonly lastExit?: string;
}

function info(ctx: Ctx, u: Unit): UnitInfo {
  const r = ctx.deps.run("launchctl", ["print", `${ctx.domain}/${u.label}`]);
  if (r.status !== 0) return { loaded: false };
  const pick = (re: RegExp): string | undefined => re.exec(r.stdout)?.[1];
  const state = pick(/^\s*state = (\S+)/m);
  const pid = pick(/^\s*pid = (\d+)/m);
  const lastExit = pick(/^\s*last exit code = (.+)$/m);
  return {
    loaded: true,
    ...(state === undefined ? {} : { state }),
    ...(pid === undefined ? {} : { pid }),
    ...(lastExit === undefined ? {} : { lastExit: lastExit.trim() }),
  };
}

/** state の port（数字だけ）。 */
function portOf(u: Unit): number | undefined {
  if (u.stateDir === undefined) return undefined;
  const text = readOr(join(u.stateDir, "port"));
  const first = text?.split("\n")[0]?.trim();
  return first !== undefined && /^[0-9]{1,5}$/.test(first) ? Number(first) : undefined;
}

async function whoami(ctx: Ctx, u: Unit): Promise<number | undefined> {
  const port = portOf(u);
  return port === undefined ? undefined : ctx.deps.probe(port);
}

/** daemon の窓口が、未認証の whoami に 401 を返すまで待つ。 */
async function waitDaemon(ctx: Ctx, u: Unit): Promise<boolean> {
  const now = ctx.deps.now ?? Date.now;
  const deadline = now() + (ctx.deps.waitMs ?? 60_000);
  for (;;) {
    if ((await whoami(ctx, u)) === 401) return true;
    if (now() + 1000 > deadline) return false;
    await ctx.deps.sleep(1000);
  }
}

/** すべての daemon の窓口を並べて待ち、応答しなかった最初の unit（並びの順）を返す。全部応答したら undefined。 */
async function firstUnresponsive(ctx: Ctx): Promise<Unit | undefined> {
  const results = await Promise.all(ctx.units.map((u) => waitDaemon(ctx, u)));
  return ctx.units.find((_, i) => !results[i]);
}

/** ログの末尾で読む大きさ（バイト）。 */
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * ログ（plist の StandardErrorPath）の末尾から、最後の失敗の行（daemon の `失敗 [code]: …`）を、値を伏せて返す。
 * 読めない・ないなら undefined。リンクは辿らない。
 */
function lastFailure(log: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(log, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    const len = Math.min(st.size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    const line = buf
      .toString("utf8")
      .split("\n")
      .filter(
        (l) =>
          /^失敗 \[[A-Za-z]+\]/.test(l) ||
          /"event":"(uncaughtException|unhandledRejection)"/.test(l),
      )
      .at(-1);
    return line === undefined ? undefined : maskValues(line);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function statusLines(ctx: Ctx): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  let ok = true;
  let loadedCount = 0;
  for (const u of ctx.units) {
    const i = info(ctx, u);
    if (i.loaded) loadedCount += 1;
    if (!i.loaded) {
      lines.push(`${u.label}: 読み込まれていない`);
      ok = false;
      continue;
    }
    const parts = [`state=${i.state ?? "不明"}`];
    if (i.pid !== undefined) parts.push(`pid=${i.pid}`);
    if (i.lastExit !== undefined) parts.push(`last exit code=${i.lastExit}`);
    lines.push(`${u.label}: 読み込み済み（${parts.join("・")}）`);
    if (i.state !== "running") ok = false;
    const exit = i.lastExit === undefined ? Number.NaN : Number.parseInt(i.lastExit, 10);
    if (Number.isInteger(exit) && exit !== 0) {
      const last = lastFailure(u.log);
      lines.push(
        last === undefined
          ? `  最後の失敗: ログ（logs/${u.name}.log）に、失敗の行がない`
          : `  最後の失敗（logs/${u.name}.log。値は伏せた）: ${last}`,
      );
    }
  }
  if (loadedCount === 0) {
    // 止めた後に restart を案内されないように、戻し方をここで出す（restart は読み込まれていないと使えない）。
    // apply は、止めたときと同じ対象（--config・--others・--org）を付けた形で出す
    lines.push(
      ctx.units.every((u) => lstatOr(u.plistDest) !== undefined)
        ? `読み込まれていない（stop で止めた後）。次のログインで、また動く。すぐ動かすなら ${cmd(ctx, "apply", " --yes")}（利用者の同意のあとだけ）。restart は、読み込まれていないので使えない`
        : "読み込まれていない（常駐にしていない）。常駐にするなら /setup の手順 3-A。restart は、読み込まれていないので使えない",
    );
  }
  for (const u of ctx.units) {
    // 複数の daemon があるときは、どの daemon の行かが分かるように、Label を頭に付ける（既定の 1 つだけなら、今までどおり）
    const head = ctx.units.length > 1 || !u.isDefault ? `${u.label} の窓口` : "daemon の窓口";
    const code = await whoami(ctx, u);
    if (code === 401) {
      lines.push(`${head}: 応答あり（未認証の whoami が 401）`);
    } else {
      ok = false;
      lines.push(
        code === undefined
          ? `${head}: 応答なし（state の port がない、または届かない）`
          : `${head}: 想定外の応答（whoami が ${code}）`,
      );
    }
  }
  return { lines, ok };
}

/** plist の PATH の値（init の `--path-prefix` の有無で変わる）。形が違えば undefined。 */
function pathValueOf(text: string): string | undefined {
  const v = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(text)?.[1];
  if (v === undefined) return undefined;
  if (v === DEFAULT_PATH) return v;
  const prefix = v.endsWith(`:${DEFAULT_PATH}`) ? v.slice(0, -(DEFAULT_PATH.length + 1)) : "";
  return prefix !== "" && prefix.split(":").every((d) => d !== "" && plainPath(d)) ? v : undefined;
}

/** init が生成するのと、バイト単位で同じ plist か（PATH の値だけは、ファイルから取って作り直す）。 */
function isGeneratedPlist(ctx: Ctx, u: Unit, text: string): boolean {
  const path = pathValueOf(text);
  return (
    path !== undefined &&
    text ===
      plistText({
        label: u.label,
        programArguments: daemonProgramArguments(ctx.base, u.configPath),
        workingDirectory: ctx.base,
        log: u.log,
        path,
      })
  );
}

/**
 * 前の形の init が生成するのと、バイト単位で同じ plist か（PATH の値の扱いは、新しい形と同じ）。
 * 前の形は 2 つ: v0.1.0 まで（run-daemon.sh を起こす。#64）と、v0.1.1（current/bin/node を直に起こす。#73）。
 */
function isLegacyPlist(ctx: Ctx, u: Unit, text: string): boolean {
  // 別名の設定（--config。#165）には、前の形がない
  if (!u.isDefault) return false;
  const path = pathValueOf(text);
  if (path === undefined) return false;
  const common = { label: u.label, workingDirectory: ctx.base, log: u.log, path };
  return (
    text === legacyPlistText({ ...common, script: u.legacyScript }) ||
    text === v011PlistText({ ...common, base: ctx.base })
  );
}

/** 版のディレクトリ（`<base>/v<版>/<配布物の名前>/TouRyou.app`）の実パスの一覧。 */
function versionApps(ctx: Ctx): string[] {
  const apps: string[] = [];
  let vs: string[] = [];
  try {
    vs = readdirSync(ctx.base).filter((n) => /^v[0-9]/.test(n));
  } catch {
    return apps;
  }
  for (const v of vs) {
    let ds: string[] = [];
    try {
      ds = readdirSync(join(ctx.base, v));
    } catch {
      continue;
    }
    for (const d of ds) {
      const app = join(ctx.base, v, d, "TouRyou.app");
      if (lstatOr(app)?.isDirectory() === true) apps.push(app);
    }
  }
  return apps;
}

/**
 * TouRyou.app を LaunchServices に登録する（`-f`）・登録を解く（`-u`）（#73）。ログイン項目が、app の名前とアイコンを引けるように。
 * 登録は current のリンクの先（版のディレクトリ）の実パスで行い、ほかの版の TouRyou.app の登録は解く（同じ bundle ID の登録を、版の数だけためない）。
 * 解くときは、全部の版で解く。失敗しても常駐は動くので、止めずに、知らせの行を返す。
 */
function lsregister(ctx: Ctx, flag: "-f" | "-u"): string[] {
  let current: string | undefined;
  try {
    current = realpathSync(appBundlePath(ctx.base));
  } catch {
    current = undefined;
  }
  const others = versionApps(ctx).filter((a) => {
    try {
      return realpathSync(a) !== current;
    } catch {
      return false;
    }
  });
  const out: string[] = [];
  let failed = 0;
  const call = (f: "-f" | "-u", app: string): void => {
    if (ctx.deps.run(LSREGISTER, [f, app]).status !== 0) failed += 1;
  };
  for (const a of others) call("-u", a);
  if (flag === "-f") {
    if (current === undefined) {
      out.push("TouRyou.app（current の中）がないので、LaunchServices の登録は飛ばした");
    } else {
      call("-f", current);
      out.push("TouRyou.app を LaunchServices に登録した");
    }
  } else {
    if (current === undefined) {
      out.push("TouRyou.app（current の中）がないので、LaunchServices の登録の解除は飛ばした");
    } else {
      call("-u", current);
      out.push("TouRyou.app の LaunchServices の登録を解いた");
    }
  }
  if (others.length > 0) out.push(`ほかの版の TouRyou.app の登録を解いた（${others.length} 個）`);
  if (failed > 0)
    out.push(`LaunchServices の登録・解除のうち ${failed} 回が失敗した（常駐には影響しない）`);
  return out;
}

/** 古い形の init が生成するのと、バイト単位で同じ起動スクリプトか。 */
const isLegacyScript = (ctx: Ctx, _u: Unit, text: string): boolean =>
  text === runDaemonScript(ctx.base);

const isRegular = (p: string): boolean => lstatOr(p)?.isFile() === true;

async function apply(ctx: Ctx): Promise<CommandResult> {
  const missing = ctx.units.map((u) => u.plistSrc).filter((p) => !isRegular(p));
  if (missing.length > 0) {
    return fail(
      `"$HOME/.touryou/current/bin/touryou" launchd init の生成物がない（または通常のファイルでない）:\n${missing.map((p) => `  ${p}`).join("\n")}\n先に "$HOME/.touryou/current/bin/touryou" launchd init を実行する`,
      1,
    );
  }
  for (const u of ctx.units) {
    const text = readOr(u.plistSrc) ?? "";
    if (isLegacyPlist(ctx, u, text)) {
      return fail(
        `${u.plistSrc} が、古い形（run-daemon.sh か bin/node を起こす。v0.1.1 まで）のまま。同じ --org・--path-prefix で "$HOME/.touryou/current/bin/touryou" launchd init を実行して、新しい形に置き換えてから、やり直す`,
        1,
      );
    }
    if (!isGeneratedPlist(ctx, u, text)) {
      return fail(
        `${u.plistSrc} が、"$HOME/.touryou/current/bin/touryou" launchd init の生成するものと違う（--org〔${u.label}〕が違う・手で直した）。同じ --org で "$HOME/.touryou/current/bin/touryou" launchd init を実行し直す`,
        1,
      );
    }
    // 同じ stateDir を別の設定の daemon が使うと、同じ state を取り合って壊れる。init のあとに設定を直した場合もあるので、apply でも確かめる
    const sharing =
      u.stateDir === undefined
        ? undefined
        : stateDirSharedWith(
            ctx.base,
            ctx.plistDir,
            ctx.agentsDir,
            u.configPath,
            u.stateDir,
            u.label,
          );
    if (sharing !== undefined) {
      return fail(
        `${u.label} の stateDir が、別の設定（${describeSharing(sharing)}）の daemon と同じ。同じ state を 2 つの daemon が使うと壊れるので、何も置かずに止めた。設定ごとに、別の stateDir にする`,
        1,
      );
    }
    // 通らない設定で常駐にすると、KeepAlive で起こし直され、起動のたびに落ち続ける。plist を置く前・launchctl の前に止める
    const problem = configProblem(
      ctx.home,
      pathValueOf(text) ?? DEFAULT_PATH,
      ctx.deps.checkConfig,
      u.configPath,
    );
    if (problem !== undefined) return fail(problem, 1);
  }

  const agents = lstatOr(ctx.agentsDir);
  if (agents !== undefined && !agents.isDirectory()) {
    return fail(
      `${ctx.agentsDir} が通常のディレクトリでない（シンボリックリンクなど）。何も変えずに止めた`,
      1,
    );
  }
  // 先に全部を確かめる（違う内容の既存があれば、何も置かない）
  const toCopy: Unit[] = [];
  const toReplace: Unit[] = [];
  for (const u of ctx.units) {
    const st = lstatOr(u.plistDest);
    const dest = st?.isFile() === true ? readOr(u.plistDest) : undefined;
    const src = readOr(u.plistSrc) ?? "";
    if (st === undefined) {
      toCopy.push(u);
    } else if (
      dest !== undefined &&
      isLegacyPlist(ctx, u, dest) &&
      pathValueOf(dest) === pathValueOf(src)
    ) {
      // 古い形（v0.1.1 まで）を apply が置いたもの。同じ --org・PATH の新しい形に、置き換える（#64・#73）
      toReplace.push(u);
    } else if (dest === undefined || dest !== src) {
      return fail(
        `${u.plistDest} が、生成した plist と違う（または通常のファイルでない）。何も変えずに止めた。中身を確かめ、要らなければ "$HOME/.touryou/current/bin/touryou" launchd uninstall --yes で外してから、やり直す`,
        1,
      );
    }
  }
  if (agents === undefined) mkdirSync(ctx.agentsDir, { recursive: true, mode: 0o755 });
  const out: string[] = [];
  for (const u of toReplace) {
    // 読み込んだままでは、古い plist で動き続ける。止めてから、置き換える
    if (info(ctx, u).loaded) {
      const r = ctx.deps.run("launchctl", ["bootout", `${ctx.domain}/${u.label}`]);
      if (r.status !== 0) {
        return fail(
          `launchctl bootout ${u.label} に失敗（古い形の plist を置き換える前）: ${r.stderr.trim()}。何も置き換えていない`,
          1,
        );
      }
      out.push(`${u.label}: 古い形の plist で動いていたので、止めた`);
    }
    const tmp = `${u.plistDest}.new`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, readOr(u.plistSrc) ?? "", { flag: "wx", mode: 0o644 });
    renameSync(tmp, u.plistDest);
    out.push(`置き換えた（古い形 → 新しい形）: ${u.plistDest}`);
  }
  for (const u of toCopy) {
    writeFileSync(u.plistDest, readOr(u.plistSrc) ?? "", { flag: "wx", mode: 0o644 });
    out.push(`置いた: ${u.plistDest}`);
  }
  out.push(...lsregister(ctx, "-f"));
  for (const u of ctx.units) {
    if (info(ctx, u).loaded) {
      out.push(`${u.label}: 読み込み済み（そのまま）`);
    } else {
      const r = ctx.deps.run("launchctl", ["bootstrap", ctx.domain, u.plistDest]);
      if (r.status !== 0) {
        return fail(
          `launchctl bootstrap ${u.label} に失敗（終了コード ${r.status ?? "なし"}）: ${r.stderr.trim()}`,
          1,
          `${out.join("\n")}\n`,
        );
      }
      out.push(`${u.label}: 読み込んだ`);
    }
  }
  // 窓口の応答は、全部の daemon を読み込んだあとに、並べて待つ（daemon の数だけ待ち時間が伸びない）
  const unresponsive = await firstUnresponsive(ctx);
  if (unresponsive !== undefined) {
    const st = await statusLines(ctx);
    return fail(
      `${unresponsive.label} の窓口が応答しない（未認証の whoami が 401 にならない）\n${partial(ctx)}`,
      1,
      `${[...out, "", ...st.lines].join("\n")}\n`,
    );
  }
  // LaunchAgents が新しい形になったら、古い形の起動スクリプトは、もうどこからも起こされない。古い形と同じなら消す（#64）
  for (const u of ctx.units) {
    const dest = readOr(u.plistDest);
    const script = readOr(u.legacyScript);
    // 古い形の起動スクリプトは、既定の設定の daemon のものだけ（別名の daemon が、既定と共有するスクリプトを消さない）
    if (
      u.isDefault &&
      dest !== undefined &&
      isGeneratedPlist(ctx, u, dest) &&
      script !== undefined &&
      isLegacyScript(ctx, u, script)
    ) {
      rmSync(u.legacyScript);
      out.push(`消した: ${u.legacyScript}（古い形の起動スクリプト）`);
    }
  }
  const st = await statusLines(ctx);
  out.push("", ...st.lines, "");
  out.push(
    "ログイン時に自動で動くようになった。システム設定の「一般」→「ログイン項目と機能拡張」→「バックグラウンドでの実行を許可」に「TouRyou」の 1 項目が出る。「開発元を識別できない項目」と出るのは、TouRyou に同梱した node を TouRyou の名前で手元の署名（ad-hoc）にしたためで、正常（docs/launchd.md）。",
  );
  return {
    exitCode: st.ok ? 0 : 1,
    stdout: `${out.join("\n")}\n`,
    stderr: st.ok ? "" : "起動の確認で、問題があった\n",
  };
}

async function restart(ctx: Ctx): Promise<CommandResult> {
  const out: string[] = [];
  // 先に全部の読み込み状態を確かめる（一部が停止中なら、先の unit だけ起動し直してから失敗しないように、何も起動し直さない）
  const notLoaded = ctx.units.filter((u) => !info(ctx, u).loaded);
  if (notLoaded.length > 0) {
    return fail(
      `${notLoaded.map((u) => u.label).join("・")} が読み込まれていない。何も起動し直していない。先に ${cmd(ctx, "apply", " --yes")} を実行する`,
      1,
    );
  }
  for (const u of ctx.units) {
    const r = ctx.deps.run("launchctl", ["kickstart", "-k", `${ctx.domain}/${u.label}`]);
    if (r.status !== 0) {
      return fail(
        `launchctl kickstart ${u.label} に失敗: ${r.stderr.trim()}`,
        1,
        `${out.join("\n")}\n`,
      );
    }
    out.push(`${u.label}: 起動し直した`);
  }
  const unresponsive = await firstUnresponsive(ctx);
  if (unresponsive !== undefined) {
    const st = await statusLines(ctx);
    return fail(
      `${unresponsive.label} の窓口が応答しない\n${partial(ctx)}`,
      1,
      `${[...out, "", ...st.lines].join("\n")}\n`,
    );
  }
  const st = await statusLines(ctx);
  return {
    exitCode: st.ok ? 0 : 1,
    stdout: `${[...out, "", ...st.lines].join("\n")}\n`,
    stderr: "",
  };
}

/**
 * すべての unit を止める。1 つの bootout が失敗しても打ち切らず、残りも試す（残りが動いたままにならないように）。
 * 止められなかった unit と、まとめた失敗の文を返す（失敗がなければ、failed は空・err は undefined）。
 */
function stopUnits(
  ctx: Ctx,
  out: string[],
): { readonly failed: ReadonlySet<Unit>; readonly err: string | undefined } {
  const failed = new Set<Unit>();
  const errs: string[] = [];
  for (const u of [...ctx.units].reverse()) {
    if (!info(ctx, u).loaded) {
      out.push(`${u.label}: 読み込まれていない（そのまま）`);
      continue;
    }
    const r = ctx.deps.run("launchctl", ["bootout", `${ctx.domain}/${u.label}`]);
    if (r.status !== 0) {
      failed.add(u);
      errs.push(`launchctl bootout ${u.label} に失敗: ${r.stderr.trim()}`);
      continue;
    }
    out.push(`${u.label}: 止めた`);
  }
  return { failed, err: errs.length === 0 ? undefined : errs.join("\n") };
}

function stop(ctx: Ctx): CommandResult {
  const out: string[] = [];
  const { err } = stopUnits(ctx, out);
  if (err !== undefined) return fail(err, 1, `${out.join("\n")}\n`);
  out.push(
    "",
    `plist は LaunchAgents に残っているので、次のログインで、また動く。すぐ動かすなら ${cmd(ctx, "apply", " --yes")}。常駐をやめるなら ${cmd(ctx, "uninstall", " --yes")}`,
  );
  return { exitCode: 0, stdout: `${out.join("\n")}\n`, stderr: "" };
}

/**
 * 消したあとの LaunchAgents に残る、touryou の daemon の plist（常駐にしたもの。残した自分の plist も含む）。
 * `<base>/launchd` の plist は見ない（init しただけで、まだ launchd に読まれていないものが、TouRyou.app の登録解除を止めないように）。
 */
function remainingPlists(ctx: Ctx): string[] {
  try {
    return readdirSync(ctx.agentsDir)
      .filter((n) => DAEMON_PLIST.test(n))
      .map((n) => join(ctx.agentsDir, n));
  } catch {
    return [];
  }
}

function uninstall(ctx: Ctx): CommandResult {
  const out: string[] = [];
  const { failed, err } = stopUnits(ctx, out);
  const kept: string[] = [];
  if (err !== undefined) {
    // 止められなかった unit は、動いたまま plist がなくならないように、何も消さない（LaunchAgents の plist も、元の plist も。
    // 元の plist が残るので、同じコマンドを再実行すれば、その unit を同じ手順で止めて外せる）。止められた unit は、後始末を進める
    kept.push(
      ...err.split("\n"),
      ...[...failed].flatMap((u) =>
        [u.plistDest, u.plistSrc]
          .filter((p) => lstatOr(p) !== undefined)
          .map((p) => `${p}（${u.label} を止められなかったので、消さずに残した）`),
      ),
    );
  }
  /** 消したか、もともとなければ true。判定できずに残したら false。 */
  const remove = (p: string, ok: (text: string) => boolean, why?: string): boolean => {
    const st = lstatOr(p);
    if (st === undefined) return true;
    const text = st.isFile() ? readOr(p) : undefined;
    if (text === undefined || !ok(text)) {
      kept.push(
        `${p}（${why ?? "touryou が生成したものと判定できない〔手で直した・リンクなど〕"}。残した）`,
      );
      return false;
    }
    rmSync(p);
    out.push(`消した: ${p}`);
    return true;
  };
  for (const u of ctx.units) {
    if (failed.has(u)) continue;
    // LaunchAgents の plist は、.touryou/launchd の plist とバイト単位で同じとき（apply が置いたもの）だけ消す。
    // 古い形（v0.1.0 まで）を apply が置いたまま、init だけ新しい形にした場面では、同じ PATH の古い形も消す（#64）
    const src = readOr(u.plistSrc);
    const srcOk =
      src !== undefined && (isGeneratedPlist(ctx, u, src) || isLegacyPlist(ctx, u, src));
    // 別名の daemon（--others）は、元の plist（.touryou/launchd）が消えていても外せるように、LaunchAgents の plist が
    // init の生成するものとバイト単位で同じかだけを見る。既定の daemon は、従来どおり、元の plist がなければ残す
    const byDest = src === undefined && !u.isDefault;
    const destKept = !remove(
      u.plistDest,
      (t) =>
        byDest
          ? isGeneratedPlist(ctx, u, t)
          : srcOk &&
            (t === src || (isLegacyPlist(ctx, u, t) && pathValueOf(t) === pathValueOf(src ?? ""))),
      src === undefined && !byDest
        ? `"$HOME/.touryou/current/bin/touryou" launchd init の生成物〔${u.plistSrc}〕がないので、apply が置いたものか確かめられない`
        : undefined,
    );
    remove(u.plistSrc, (t) => isGeneratedPlist(ctx, u, t) || isLegacyPlist(ctx, u, t));
    // 古い形の起動スクリプトは、既定の設定の daemon のもの。別名の daemon は、既定と共有するスクリプトに触れない
    if (!u.isDefault) continue;
    if (destKept) {
      // 残した plist が古い形なら、次のログインで、もうない起動スクリプトを指さないように、対のスクリプトも残す
      if (lstatOr(u.legacyScript) !== undefined) {
        kept.push(
          `${u.legacyScript}（${u.plistDest} を残したので、古い形の起動スクリプトも残した）`,
        );
      }
    } else {
      remove(u.legacyScript, (t) => isLegacyScript(ctx, u, t));
    }
  }
  // LaunchAgents に daemon の plist が残っているうちは、TouRyou.app の登録を解かない（残った daemon が、同じ app を使う）
  const remaining = remainingPlists(ctx);
  if (remaining.length > 0) {
    out.push(
      `LaunchAgents に daemon の plist が残っているので、TouRyou.app の LaunchServices の登録は解かなかった（残っているもの: ${remaining.join("・")}）。全部外すなら、残りの daemon も ${TOURYOU} launchd uninstall --yes --config <設定> か --others で外す（最後の 1 つを外すときに、登録も解く）`,
    );
  } else {
    out.push(...lsregister(ctx, "-u"));
  }
  const stateDirs = ctx.units.flatMap((u) => (u.stateDir === undefined ? [] : [u.stateDir]));
  out.push(
    `残した: ${ctx.logsDir}（ログ）${stateDirs.length === 0 ? "" : `・${stateDirs.join("・")}（daemon の状態）`}`,
  );
  if (kept.length > 0) out.push("", ...kept);
  return {
    exitCode: kept.length > 0 ? 1 : 0,
    stdout: `${out.join("\n")}\n`,
    stderr: kept.length > 0 ? "消せなかったものがある\n" : "",
  };
}

export async function runLaunchdService(
  argv: readonly string[],
  deps: LaunchdServiceDeps,
): Promise<CommandResult> {
  const sub = argv[0] as Sub;
  if (!SERVICE_SUBCOMMANDS.includes(sub)) return fail(`不明なサブコマンド: ${argv[0] ?? ""}`);
  let org: string | undefined;
  let configArg: string | undefined;
  let others = false;
  let yes = false;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--org" || a === "--config") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return fail(`${a} には値を指定する`);
      if (a === "--org") org = v;
      else configArg = v;
      i += 1;
    } else if (a === "--others") {
      others = true;
    } else if (a === "--yes" && (sub === "apply" || sub === "uninstall")) {
      yes = true;
    } else {
      return fail(`不明な引数: ${a}（"$HOME/.touryou/current/bin/touryou" launchd --help）`);
    }
  }
  if (org !== undefined && !REVERSE_DOMAIN.test(org))
    return fail("--org は、小文字の英数字とハイフンのラベルを、ドットで 2 つ以上つないだ形にする");
  if ((sub === "apply" || sub === "uninstall") && !yes) {
    return fail(
      sub === "apply"
        ? '"$HOME/.touryou/current/bin/touryou" launchd apply は、ログイン時に自動で動く設定（永続化）を入れる。利用者の同意を取ってから --yes を付けて実行する。何もしていない'
        : '"$HOME/.touryou/current/bin/touryou" launchd uninstall は、常駐を止めて生成物を消す。利用者の同意を取ってから --yes を付けて実行する。何もしていない',
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
  if (others && configArg !== undefined) return fail("--others と --config は、同時に指定できない");
  if (configArg !== undefined && !usableConfigPath(configArg)) {
    return fail(
      "--config は、設定ファイルの絶対パスにする。英数字・. _ / @ + 空白 - だけが使える（.. の要素・// は使えない）",
    );
  }
  const base = join(home, ".touryou");
  const binDir = join(base, "bin");
  const plistDir = join(base, "launchd");
  const agentsDir = join(home, "Library", "LaunchAgents");
  const logsDir = join(base, "logs");
  const unit = (
    label: string,
    name: string,
    configPath: string,
    stateDir: string | undefined,
  ): Unit => ({
    name,
    configPath,
    stateDir,
    isDefault: name === "daemon",
    label,
    legacyScript: legacyScriptPath(base),
    plistSrc: join(plistDir, `${label}.plist`),
    plistDest: join(agentsDir, `${label}.plist`),
    log: join(logsDir, `${name}.log`),
  });
  let units: Unit[] = [];
  // 読めない plist 1 つのために、全体を止めない。その unit だけ警告して飛ばす
  const warnings: string[] = [];
  // 飛ばした unit があるのに成功と言わない: uninstall 以外は非 0 で終わる（版上げの script が成功と見なさない）。
  // uninstall は後始末なので、終了コードは変えず、飛ばしたものを出力（標準出力）にも明示する
  const withWarnings = (r: CommandResult): CommandResult => {
    if (warnings.length === 0) return r;
    const stderr = `${warnings.map((w) => `警告: ${w}`).join("\n")}\n${r.stderr}`;
    if (sub === "uninstall") {
      return {
        ...r,
        stdout: `${r.stdout}\n飛ばした daemon（${warnings.length} 件。外していない）:\n${warnings.map((w) => `  ${w}`).join("\n")}\n`,
        stderr,
      };
    }
    return { ...r, exitCode: r.exitCode === 0 ? 1 : r.exitCode, stderr };
  };
  if (others) {
    // init が生成した別名の daemon（--config で作ったもの）すべて。plist の ProgramArguments の設定から、対象を決める
    // 対象は、LaunchAgents に置いた（常駐にした）ものと、uninstall では init しただけのもの。元の plist（.touryou/launchd）が
    // 消えていても、LaunchAgents に残っていれば、そちらを読んで対象にする（stop・uninstall できるように）
    const installed = otherPlistNames(agentsDir);
    const names = [
      ...new Set([...installed, ...(sub === "uninstall" ? otherPlistNames(plistDir) : [])]),
    ].sort();
    for (const n of names) {
      const m = OTHER_PLIST.exec(n);
      if (m === null) continue;
      // --org があれば、その組織の Label のものだけ（なければ、すべての組織のもの）
      if (org !== undefined && m[1] !== labelOf(org, `daemon-${m[2] as string}`)) continue;
      const srcFile = join(plistDir, n);
      const file = readOr(srcFile) !== undefined ? srcFile : join(agentsDir, n);
      const text = readOr(file);
      const cfg = text === undefined ? undefined : plistConfigOf(text);
      if (cfg === undefined || !usableConfigPath(cfg)) {
        warnings.push(
          `${file} の設定（--config）を読めないので、この daemon は飛ばした。手で外すか、${TOURYOU} launchd init --config <設定> で作り直す`,
        );
        continue;
      }
      const sd = stateDirOf(cfg);
      const stateDir = sd !== undefined && plainPath(sd) ? sd : undefined;
      // stateDir を読めなくても、uninstall は plist・ログを後始末できる（設定を消したあとの片づけ）。ほかは、窓口を確かめられないので飛ばす
      if (stateDir === undefined && sub !== "uninstall") {
        warnings.push(
          `${file} の設定（${cfg}）の stateDir を読めないので、この daemon は飛ばした（設定がない・他の人が書ける・stateDir が絶対パスでない）。設定を直すか、${TOURYOU} launchd uninstall --yes --others で外す`,
        );
        continue;
      }
      units.push(unit(m[1] as string, `daemon-${m[2] as string}`, cfg, stateDir));
    }
    // uninstall のほかは、LaunchAgents に置いた（常駐にした）ものだけ。init しただけの plist を、apply・restart で常駐にしない
    if (sub !== "uninstall") units = units.filter((u) => lstatOr(u.plistDest) !== undefined);
    if (units.length === 0) {
      return withWarnings({
        exitCode: 0,
        stdout: "別名の設定（--config）の daemon は、常駐にしたものがない（何もしていない）\n",
        stderr: "",
      });
    }
  } else {
    // --config を明示したときだけ、init と同じに実パスにそろえる（リンク経由の指定でも、init が作った plist・Label と同じ daemon を指す）。
    // 省略は <base>/config.json のまま（init が plist に書くものと同じ）
    const configPath = configPathOf(base, configArg);
    if (!usableConfigPath(configPath)) {
      return fail("--config の実パス（リンクを解決したもの）が、使えない文字を含む");
    }
    const sd = stateDirOf(configPath);
    const stateDir = sd !== undefined && plainPath(sd) ? sd : undefined;
    // 設定を消した・壊したあとでも、uninstall は plist を後始末できるようにする（stateDir は、窓口を見る操作だけが要る）
    if (stateDir === undefined && sub !== "uninstall") {
      return fail(
        configArg === undefined
          ? "config.json の stateDir を読めない。先に /setup を実行する"
          : "--config の設定ファイルの stateDir を読めない（ファイルがない・他の人が書ける・stateDir が絶対パスでない）",
        1,
      );
    }
    const name = daemonNameOf(base, configPath);
    units = [unit(labelOf(org, name), name, configPath, stateDir)];
  }
  const orgFlag = org === undefined ? "" : ` --org ${org}`;
  const targetFlag = others
    ? " --others"
    : units[0]?.isDefault === true
      ? ""
      : ` --config "${units[0]?.configPath ?? ""}"`;
  const ctx: Ctx = {
    deps,
    home,
    base,
    binDir,
    logsDir,
    plistDir,
    agentsDir,
    domain: `gui/${uid}`,
    units,
    selector: `${orgFlag}${targetFlag}`,
  };
  switch (sub) {
    case "apply":
      return withWarnings(await apply(ctx));
    case "status": {
      const st = await statusLines(ctx);
      return withWarnings({
        exitCode: st.ok ? 0 : 1,
        stdout: `${st.lines.join("\n")}\n`,
        stderr: "",
      });
    }
    case "restart":
      return withWarnings(await restart(ctx));
    case "stop":
      return withWarnings(stop(ctx));
    case "uninstall":
      return withWarnings(uninstall(ctx));
  }
}
