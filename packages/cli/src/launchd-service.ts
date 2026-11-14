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
  readFileSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CommandResult } from "./commands.js";
import {
  DEFAULT_PATH,
  labelOf,
  plainPath,
  plistText,
  REVERSE_DOMAIN,
  runDaemonScript,
  stateDirOf,
} from "./launchd.js";

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LaunchdServiceDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 外部コマンド（launchctl だけ）を実行する。 */
  readonly run: (cmd: string, args: readonly string[]) => RunResult;
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

/** apply・restart が途中で止まったときの状態の案内。 */
const PARTIAL =
  "daemon は読み込み済みのまま（KeepAlive で動き続けうる）。止めるなら touryou launchd stop、直してからやり直すなら touryou launchd apply --yes";

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
  readonly stateDir: string;
  readonly binDir: string;
  readonly logsDir: string;
  readonly plistDir: string;
  readonly agentsDir: string;
  readonly domain: string;
  readonly units: readonly Unit[];
}
interface Unit {
  readonly name: "daemon";
  readonly label: string;
  readonly script: string;
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
function portOf(ctx: Ctx): number | undefined {
  const text = readOr(join(ctx.stateDir, "port"));
  const first = text?.split("\n")[0]?.trim();
  return first !== undefined && /^[0-9]{1,5}$/.test(first) ? Number(first) : undefined;
}

async function whoami(ctx: Ctx): Promise<number | undefined> {
  const port = portOf(ctx);
  return port === undefined ? undefined : ctx.deps.probe(port);
}

/** daemon の窓口が、未認証の whoami に 401 を返すまで待つ。 */
async function waitDaemon(ctx: Ctx): Promise<boolean> {
  const now = ctx.deps.now ?? Date.now;
  const deadline = now() + (ctx.deps.waitMs ?? 60_000);
  for (;;) {
    if ((await whoami(ctx)) === 401) return true;
    if (now() + 1000 > deadline) return false;
    await ctx.deps.sleep(1000);
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
  }
  if (loadedCount === 0) {
    // 止めた後に restart を案内されないように、戻し方をここで出す（restart は読み込まれていないと使えない）
    lines.push(
      ctx.units.every((u) => lstatOr(u.plistDest) !== undefined)
        ? "読み込まれていない（stop で止めた後）。次のログインで、また動く。すぐ動かすなら touryou launchd apply --yes（利用者の同意のあとだけ）。restart は、読み込まれていないので使えない"
        : "読み込まれていない（常駐にしていない）。常駐にするなら /setup の手順 3-A。restart は、読み込まれていないので使えない",
    );
  }
  const code = await whoami(ctx);
  if (code === 401) {
    lines.push("daemon の窓口: 応答あり（未認証の whoami が 401）");
  } else {
    ok = false;
    lines.push(
      code === undefined
        ? "daemon の窓口: 応答なし（state の port がない、または届かない）"
        : `daemon の窓口: 想定外の応答（whoami が ${code}）`,
    );
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
      plistText({ label: u.label, script: u.script, workingDirectory: ctx.base, log: u.log, path })
  );
}

/** init が生成するのと、バイト単位で同じ起動スクリプトか。 */
const isGeneratedScript = (ctx: Ctx, _u: Unit, text: string): boolean =>
  text === runDaemonScript(ctx.base);

const isRegular = (p: string): boolean => lstatOr(p)?.isFile() === true;

async function apply(ctx: Ctx): Promise<CommandResult> {
  const missing = ctx.units.flatMap((u) => [u.plistSrc, u.script]).filter((p) => !isRegular(p));
  if (missing.length > 0) {
    return fail(
      `touryou launchd init の生成物がない（または通常のファイルでない）:\n${missing.map((p) => `  ${p}`).join("\n")}\n先に touryou launchd init を実行する`,
      1,
    );
  }
  for (const u of ctx.units) {
    const text = readOr(u.plistSrc) ?? "";
    if (!isGeneratedPlist(ctx, u, text)) {
      return fail(
        `${u.plistSrc} が、touryou launchd init の生成するものと違う（--org〔${u.label}〕が違う・手で直した）。同じ --org で touryou launchd init を実行し直す`,
        1,
      );
    }
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
  for (const u of ctx.units) {
    const st = lstatOr(u.plistDest);
    if (st === undefined) {
      toCopy.push(u);
    } else if (!st.isFile() || readOr(u.plistDest) !== readOr(u.plistSrc)) {
      return fail(
        `${u.plistDest} が、生成した plist と違う（または通常のファイルでない）。何も変えずに止めた。中身を確かめ、要らなければ touryou launchd uninstall --yes で外してから、やり直す`,
        1,
      );
    }
  }
  if (agents === undefined) mkdirSync(ctx.agentsDir, { recursive: true, mode: 0o755 });
  const out: string[] = [];
  for (const u of toCopy) {
    writeFileSync(u.plistDest, readOr(u.plistSrc) ?? "", { flag: "wx", mode: 0o644 });
    out.push(`置いた: ${u.plistDest}`);
  }
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
    if (u.name === "daemon" && !(await waitDaemon(ctx))) {
      const st = await statusLines(ctx);
      return fail(
        `daemon の窓口が応答しない（未認証の whoami が 401 にならない）\n${PARTIAL}`,
        1,
        `${[...out, "", ...st.lines].join("\n")}\n`,
      );
    }
  }
  const st = await statusLines(ctx);
  out.push("", ...st.lines, "");
  out.push(
    "ログイン時に自動で動くようになった。システム設定の「一般」→「ログイン項目」に、run-daemon.sh の項目が「開発元を識別できない項目」として出るのは、正常。",
  );
  return {
    exitCode: st.ok ? 0 : 1,
    stdout: `${out.join("\n")}\n`,
    stderr: st.ok ? "" : "起動の確認で、問題があった\n",
  };
}

async function restart(ctx: Ctx): Promise<CommandResult> {
  const out: string[] = [];
  for (const u of ctx.units) {
    if (!info(ctx, u).loaded) {
      return fail(
        `${u.label} が読み込まれていない。先に touryou launchd apply --yes を実行する`,
        1,
        `${out.join("\n")}\n`,
      );
    }
    const r = ctx.deps.run("launchctl", ["kickstart", "-k", `${ctx.domain}/${u.label}`]);
    if (r.status !== 0) {
      return fail(
        `launchctl kickstart ${u.label} に失敗: ${r.stderr.trim()}`,
        1,
        `${out.join("\n")}\n`,
      );
    }
    out.push(`${u.label}: 起動し直した`);
    if (u.name === "daemon" && !(await waitDaemon(ctx))) {
      const st = await statusLines(ctx);
      return fail(
        `daemon の窓口が応答しない\n${PARTIAL}`,
        1,
        `${[...out, "", ...st.lines].join("\n")}\n`,
      );
    }
  }
  const st = await statusLines(ctx);
  return {
    exitCode: st.ok ? 0 : 1,
    stdout: `${[...out, "", ...st.lines].join("\n")}\n`,
    stderr: "",
  };
}

function stopUnits(ctx: Ctx, out: string[]): string | undefined {
  for (const u of [...ctx.units].reverse()) {
    if (!info(ctx, u).loaded) {
      out.push(`${u.label}: 読み込まれていない（そのまま）`);
      continue;
    }
    const r = ctx.deps.run("launchctl", ["bootout", `${ctx.domain}/${u.label}`]);
    if (r.status !== 0) return `launchctl bootout ${u.label} に失敗: ${r.stderr.trim()}`;
    out.push(`${u.label}: 止めた`);
  }
  return undefined;
}

function stop(ctx: Ctx): CommandResult {
  const out: string[] = [];
  const err = stopUnits(ctx, out);
  if (err !== undefined) return fail(err, 1, `${out.join("\n")}\n`);
  out.push(
    "",
    "plist は LaunchAgents に残っているので、次のログインで、また動く。常駐をやめるなら touryou launchd uninstall --yes",
  );
  return { exitCode: 0, stdout: `${out.join("\n")}\n`, stderr: "" };
}

function uninstall(ctx: Ctx): CommandResult {
  const out: string[] = [];
  const err = stopUnits(ctx, out);
  if (err !== undefined) return fail(`${err}\n何も消していない`, 1, `${out.join("\n")}\n`);
  const kept: string[] = [];
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
    // LaunchAgents の plist は、.touryou/launchd の plist とバイト単位で同じとき（apply が置いたもの）だけ消す
    const src = readOr(u.plistSrc);
    const destKept = !remove(
      u.plistDest,
      (t) => src !== undefined && t === src && isGeneratedPlist(ctx, u, t),
      src === undefined
        ? `touryou launchd init の生成物〔${u.plistSrc}〕がないので、apply が置いたものか確かめられない`
        : undefined,
    );
    remove(u.plistSrc, (t) => isGeneratedPlist(ctx, u, t));
    if (destKept) {
      // 残した plist が、次のログインで、もうない起動スクリプトを指さないように、対のスクリプトも残す
      if (lstatOr(u.script) !== undefined) {
        kept.push(`${u.script}（${u.plistDest} を残したので、対の起動スクリプトも残した）`);
      }
    } else {
      remove(u.script, (t) => isGeneratedScript(ctx, u, t));
    }
  }
  out.push(`残した: ${ctx.logsDir}（ログ）・${ctx.stateDir}（daemon の状態）`);
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
  let yes = false;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--org") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return fail("--org には値を指定する");
      org = v;
      i += 1;
    } else if (a === "--yes" && (sub === "apply" || sub === "uninstall")) {
      yes = true;
    } else {
      return fail(`不明な引数: ${a}（touryou launchd --help）`);
    }
  }
  if (org !== undefined && !REVERSE_DOMAIN.test(org))
    return fail("--org は、小文字の英数字とハイフンのラベルを、ドットで 2 つ以上つないだ形にする");
  if ((sub === "apply" || sub === "uninstall") && !yes) {
    return fail(
      sub === "apply"
        ? "touryou launchd apply は、ログイン時に自動で動く設定（永続化）を入れる。利用者の同意を取ってから --yes を付けて実行する。何もしていない"
        : "touryou launchd uninstall は、常駐を止めて生成物を消す。利用者の同意を取ってから --yes を付けて実行する。何もしていない",
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
  const base = join(home, ".touryou");
  const stateDir = stateDirOf(join(base, "config.json"));
  if (stateDir === undefined || !plainPath(stateDir)) {
    return fail("config.json の stateDir を読めない。先に /setup を実行する", 1);
  }
  const binDir = join(base, "bin");
  const plistDir = join(base, "launchd");
  const agentsDir = join(home, "Library", "LaunchAgents");
  const logsDir = join(base, "logs");
  const unit = (name: Unit["name"]): Unit => {
    const label = labelOf(org, name);
    return {
      name,
      label,
      script: join(binDir, "run-daemon.sh"),
      plistSrc: join(plistDir, `${label}.plist`),
      plistDest: join(agentsDir, `${label}.plist`),
      log: join(logsDir, `${name}.log`),
    };
  };
  const ctx: Ctx = {
    deps,
    home,
    base,
    stateDir,
    binDir,
    logsDir,
    plistDir,
    agentsDir,
    domain: `gui/${uid}`,
    units: [unit("daemon")],
  };
  switch (sub) {
    case "apply":
      return apply(ctx);
    case "status": {
      const st = await statusLines(ctx);
      return { exitCode: st.ok ? 0 : 1, stdout: `${st.lines.join("\n")}\n`, stderr: "" };
    }
    case "restart":
      return restart(ctx);
    case "stop":
      return stop(ctx);
    case "uninstall":
      return uninstall(ctx);
  }
}
