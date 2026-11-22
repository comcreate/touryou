/**
 * `touryou launchd init`。daemon を launchd で常駐させるための plist を、
 * `<base>/launchd` に生成する（`docs/launchd.md`）。plist は、同梱の node で daemon の JS を直に起こす（shell を通さない。#64）。
 *
 * やらないこと（決定済みの方針）:
 * - `launchctl` を実行しない（読み込み・LaunchAgents への配置は、人が行う。ここは案内を出すだけ。子プロセスを起動しない）。
 * - 秘密を扱わない（子の認証は扱わない。plist・起動スクリプトに秘密を書かない）。
 * - 常駐は daemon だけ（子用の HTTP の touryou-mcp の常駐は外した）。
 * - 既存のファイルを黙って上書きしない（同じ内容なら何もしない。違えば、何も書かずに止まる。古い形の生成物と同じものだけは、置き換える）。
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { readSecureFile } from "@touryou/core/fs";
import type { CommandResult } from "./commands.js";
import {
  DEFAULT_PATH,
  daemonPlistNames,
  pathPrefixArgs,
  pathValueOf,
  plainPath,
  plistConfigOf,
  readDaemonPlist,
} from "./launchd-plists.js";

export interface LaunchdDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 設定の検査（`<base>/current/bin/touryou-daemon --check-config`）を実行する。 */
  readonly checkConfig: ConfigChecker;
}

/** 外部コマンドの結果。 */
export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
/**
 * daemon の入口（`cmd`）を、引数 `args`・環境 `env` だけで実行する（呼んだ側の環境は渡さない。常駐のときと同じ HOME・PATH にする）。
 */
export type ConfigChecker = (
  cmd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => RunResult;

/**
 * 出す前に、値を伏せる: 絶対パスを `<パス>` に置き換え、制御文字を除き、長さを切る（設定・ログの値を、そのまま出さない）。
 */
export function maskValues(text: string, max = 200): string {
  const t = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を取り除く
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(^|[\s(（「"'=:])\/[^\s)）」"',、。]*/g, "$1<パス>")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 常駐にする前に、config.json を daemon と同じ検査にかける（daemon の `--check-config`。設定の読み込み・
 * repoRoot・rootCwd・worktreeRoot が実在する実パスか・repoRoot が git のリポジトリか）。
 * 通れば undefined。通らなければ、止める理由と直し方（値は伏せる）。
 */
export function configProblem(
  home: string,
  path: string,
  check: ConfigChecker,
  configPath?: string,
): string | undefined {
  const base = join(home, ".touryou");
  const daemon = join(base, "current", "bin", "touryou-daemon");
  // plist と同じ HOME・PATH（git は、この PATH で探す）
  const r = check(daemon, ["--check-config", "--config", configPath ?? join(base, "config.json")], {
    HOME: home,
    PATH: path,
  });
  if (r.status === 0) return undefined;
  if (r.status !== 1) {
    // 起動できない・タイムアウト（null）、引数の誤り（2。--check-config を知らない古い daemon）は、設定の誤りと分ける
    return `current の daemon で、設定を検査できない（終了コード ${r.status ?? "なし"}。daemon が置かれていない・版が古い・時間切れ）。何もせずに止めた。/touryou:setup で入れ直してから、もう一度実行する`;
  }
  const lines = r.stderr
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(0, 12)
    .map((l) => `  ${maskValues(l)}`);
  return [
    "config.json が、daemon の設定の検査を通らない。常駐にすると、daemon が起動のたびに落ち続けるので、何もせずに止めた:",
    ...(lines.length > 0 ? lines : [`  検査を実行できない（終了コード ${r.status ?? "なし"}）`]),
    "直し方: config.json の repoRoot・rootCwd・worktreeRoot を、今ある git のリポジトリ・フォルダの実パス（リンクを解決したもの）にする（/setup のやり直しでもよい）。直したら、もう一度実行する",
  ].join("\n");
}

/** 組織の逆ドメイン（2 つ以上のラベル。小文字の英数字とハイフン）。 */
export const REVERSE_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** LaunchServices に app を登録する・登録を解く道具（macOS 付属）。 */
export const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/**
 * launchd の Label。`--org` を省略すると、組織のドメインを含まない中立な `touryou.<name>`（例: `touryou.daemon`）。
 * `--org com.example` なら `com.example.touryou.<name>`（自分のドメインにしたい人向け）。
 * launchd の Label は一意な文字列であればよく、逆ドメインは慣習（launchd.plist(5)）。
 */
export const labelOf = (org: string | undefined, name: string): string =>
  org === undefined ? `touryou.${name}` : `${org}.touryou.${name}`;

const HELP = `touryou launchd init [--org <組織の逆ドメイン>] [--path-prefix <ディレクトリ[:ディレクトリ…]>] [--config <設定ファイルの絶対パス>]
touryou launchd init --others

daemon を、launchd で常駐させるための plist を生成する（同梱の node で daemon を直に起こす。起動スクリプトは作らない）。\`launchctl\` は実行しない。秘密は扱わない。

  --org            plist の Label に使う、組織の逆ドメイン（省略すると Label は touryou.daemon。例: com.example → com.example.touryou.daemon。小文字の英数字とハイフン、ドットで 2 つ以上）
  --path-prefix    plist の PATH の先頭に足す、絶対パスのディレクトリ（git の場所。例: Homebrew の bin）。省略可
  --config         別の daemon の設定ファイル（絶対パス）。省略すると $HOME/.touryou/config.json（今までどおり）。指定すると、設定ごとに
                   別の Label（touryou.daemon-<8 文字>）・plist・ログ（logs/daemon-<8 文字>.log）・stateDir になる（docs/launchd.md の「複数の daemon」）
  --others         （単独で使う。ほかの引数は受けない）LaunchAgents に置いた別名の daemon（--config で作ったもの）すべての plist を、その plist の設定・組織（Label）・PATH のままで、現在の版の形に作り直す（版上げが使う）
  -h, --help       この使い方を表示する

常駐の操作（launchctl を実行する。docs/launchd.md）。どれも --config <設定> で対象の daemon を選ぶ（省略すると既定の設定）:
  touryou launchd apply --yes [--org …] [--config …]   plist を LaunchAgents に置き、daemon を読み込む（ログイン時に自動で動くようになる）
  touryou launchd status [--org …] [--config …]        読み込みの状態・終了コードと、窓口の応答（whoami が 401）を表示する
  touryou launchd restart [--org …] [--config …]       daemon を起動し直す（版を上げたあと）
  touryou launchd stop [--org …] [--config …]          daemon を止める（plist は残るので、次のログインでまた動く）
  touryou launchd uninstall --yes [--org …] [--config …]
                                         止めて、touryou が生成した plist（古い形の run-daemon.sh も）を消す（logs・state は残す）
  --config の代わりに --others を付けると、init が生成した別名の daemon（--config で作ったもの）が対象（apply・status・restart・stop・uninstall。版上げが使う）。
  apply・status・restart・stop では、LaunchAgents に置いた（常駐にした）ものだけ。uninstall では、init しただけのものも含む。--org を付けると、その組織の Label のものだけ

出力先: <HOME>/.touryou/launchd（plist 0644）・<HOME>/.touryou/logs（0700）。
古い形（v0.1.0 まで。<HOME>/.touryou/bin/run-daemon.sh を起こす plist）は、生成したものと同じときだけ、新しい形に置き換える。
前提: /setup を実行済み（<HOME>/.touryou/config.json と <HOME>/.touryou/current がある）。再実行できる（既存のファイルは上書きしない）。
`;

const fail = (cause: string, exitCode: 1 | 2 = 2): CommandResult => ({
  exitCode,
  stdout: "",
  stderr: `${cause}\n`,
});

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 古い形（v0.1.0 まで）の起動スクリプト（daemon）。いまは生成しない。古い形の生成物と、バイト単位で同じかを確かめて、
 * 新しい形へ引っ越す（init）・外す（uninstall）ときだけに使う（#64）。
 */
export function runDaemonScript(base: string): string {
  return `#!/bin/sh
# touryou launchd init が生成した（手で直さない。直すときは、いったん削除して、再生成する）
set -eu
base="${base}"
exec "$base/current/bin/touryou-daemon" --config "$base/config.json"
`;
}

/** 古い形（v0.1.0 まで）の起動スクリプトの置き場所。 */
export const legacyScriptPath = (base: string): string => join(base, "bin", "run-daemon.sh");

/**
 * 同梱の node を入れた TouRyou.app の bundle ID（#73）。組織の公開のドメイン（comcreate-info.com）の逆 DNS の形。
 * 配布物の Info.plist（scripts/dist-build.sh）と、plist の AssociatedBundleIdentifiers で同じ値を使う。
 */
export const BUNDLE_ID = "com.comcreate-info.touryou";

/** 同梱の node を入れた TouRyou.app（current のリンクを通す）。 */
export const appBundlePath = (base: string): string => join(base, "current", "TouRyou.app");

/**
 * plist の ProgramArguments（#73）。shell を通さず、TouRyou.app の中の node（実行ファイルの名前が TouRyou）で daemon の JS を直に起こす。
 * ログイン項目には「TouRyou」の 1 項目が出る（node の名前ではなく）。current のリンクを通すので、版を上げても変わらない。
 */
export const daemonProgramArguments = (
  base: string,
  configPath: string = join(base, "config.json"),
): readonly string[] => [
  join(appBundlePath(base), "Contents", "MacOS", "TouRyou"),
  join(base, "current", "lib", "dist", "bin.js"),
  "--config",
  configPath,
];

/**
 * 既定でない設定（`--config`）の daemon の名前（Label・ログ・plist のファイル名に使う）。設定のパスの sha256 の先頭 8 文字で、
 * 設定ごとに別になる（#165）。既定の設定（`<base>/config.json`）は、今までどおり `daemon`。
 */
export const daemonNameOf = (base: string, configPath: string): string => {
  // リンク経由でも、同じ設定は同じ daemon になるように、実パスで比べる・名前にする
  const canonical = canonicalPath(configPath);
  return canonical === canonicalPath(join(base, "config.json"))
    ? "daemon"
    : `daemon-${createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`;
};

/**
 * 実パス（リンクを解決したもの）。実在しないときは、存在する親ディレクトリまでの実パスに、存在しない末尾を結合する
 * （設定を消したあとでも、init のときと同じ名前・Label になるように）。
 */
export const canonicalPath = (p: string): string => {
  try {
    // native（realpath(3)）は、大文字小文字を区別しない macOS で、実体の綴りに直す（JS 実装の realpathSync は、渡した綴りのまま返す）
    return realpathSync.native(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(canonicalPath(parent), basename(p));
  }
};

/**
 * plist に書く設定のパス。`--config` を明示したときだけ、実パス（リンクを解決したもの）にする。
 * 省略（既定の設定）は、従来どおり `<base>/config.json` のまま（HOME がリンクでも、plist の内容を変えない）。
 * 明示した設定が既定の設定と同じ実体なら、既定のパスにそろえる。
 */
export const configPathOf = (base: string, configArg: string | undefined): string => {
  const def = join(base, "config.json");
  if (configArg === undefined) return def;
  const canonical = canonicalPath(configArg);
  return canonical === canonicalPath(def) ? def : canonical;
};

/** init の出力先（`<home>/.touryou/launchd`）。 */
export const plistDirOf = (home: string): string => join(home, ".touryou", "launchd");

/** 常駐にした plist の置き場（`<home>/Library/LaunchAgents`）。`--others`・版上げの対象は、ここに置いたもの。 */
export const agentsDirOf = (home: string): string => join(home, "Library", "LaunchAgents");

/** `--config` に渡せる設定のパス（絶対パスで、使える文字だけ）。 */
export const usableConfigPath = (p: string): boolean => isAbsolute(p) && plainPath(p);

/** 前の形（v0.1.1。#64）の ProgramArguments。同梱の node（`current/bin/node`）を直に起こす。引っ越し・外すときの確かめだけに使う。 */
export const v011ProgramArguments = (base: string): readonly string[] => [
  join(base, "current", "bin", "node"),
  join(base, "current", "lib", "dist", "bin.js"),
  "--config",
  join(base, "config.json"),
];

const plistBody = (
  programArguments: string,
  opts: {
    readonly label: string;
    readonly workingDirectory: string;
    readonly log: string;
    readonly path: string;
  },
  associated = "",
): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(opts.label)}</string>${associated}
  <key>ProgramArguments</key>
  ${programArguments}
  <key>WorkingDirectory</key><string>${xml(opts.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(opts.path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(opts.log)}</string>
  <key>StandardErrorPath</key><string>${xml(opts.log)}</string>
</dict>
</plist>
`;

const argsArray = (args: readonly string[]): string =>
  `<array>\n${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}\n  </array>`;

/**
 * plist（秘密を含まない）。`programArguments` は、daemonProgramArguments の値。
 * AssociatedBundleIdentifiers で、ログイン項目を TouRyou.app に結び付ける（ad-hoc の署名では効かない見込み。将来の署名で効く。害はない）。
 */
export function plistText(opts: {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly log: string;
  readonly path: string;
}): string {
  return plistBody(
    argsArray(opts.programArguments),
    opts,
    `\n  <key>AssociatedBundleIdentifiers</key>\n  <array><string>${BUNDLE_ID}</string></array>`,
  );
}

/** 前の形（v0.1.1。#64。current/bin/node を直に起こす）の plist。引っ越し・外すときの確かめだけに使う。 */
export function v011PlistText(opts: {
  readonly label: string;
  readonly workingDirectory: string;
  readonly log: string;
  readonly path: string;
  readonly base: string;
}): string {
  return plistBody(argsArray(v011ProgramArguments(opts.base)), opts);
}

/** 古い形（v0.1.0 まで。ProgramArguments が起動スクリプト 1 つ）の plist。引っ越し・外すときの確かめだけに使う。 */
export function legacyPlistText(opts: {
  readonly label: string;
  readonly script: string;
  readonly workingDirectory: string;
  readonly log: string;
  readonly path: string;
}): string {
  return plistBody(`<array><string>${xml(opts.script)}</string></array>`, opts);
}

interface Target {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}

const lstatOrUndefined = (path: string): ReturnType<typeof lstatSync> | undefined => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};
const modeOf = (path: string): number => lstatSync(path).mode & 0o777;
const oct = (n: number): string => n.toString(8).padStart(4, "0");

/** daemon の設定の `stateDir`（絶対パス）。読めない・形が違えば undefined。 */
export function stateDirOf(configPath: string): string | undefined {
  try {
    // 他の人が書けない・リンクでない・自分の・ACL のないファイルだけを読む（daemon の loadConfigFile と同じ確かめ）
    const json = JSON.parse(
      readSecureFile(configPath, { forbid: 0o022, maxBytes: 1024 * 1024 }),
    ) as unknown;
    const dir =
      typeof json === "object" && json !== null
        ? (json as Record<string, unknown>).stateDir
        : undefined;
    return typeof dir === "string" && isAbsolute(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** 同じ stateDir を使う、ほかの daemon。`label` は、その plist の Label（既定の設定の、plist がまだない分は無し）。 */
export interface StateDirSharing {
  readonly configPath: string;
  readonly label?: string;
}

/** 案内に出す、同じ stateDir を使う相手の説明。同じ設定を別の Label で init したものは、Label も示す。 */
export const describeSharing = (s: StateDirSharing): string =>
  s.label === undefined
    ? s.configPath
    : `${s.configPath}。Label ${s.label} の plist が、同じ設定を使っている`;

/** 入れ済みの daemon（既定の設定と、init 済みの plist）の 1 件。stateDir は実パス（読めなければ undefined）。 */
export interface DaemonEntry extends StateDirSharing {
  readonly stateDir: string | undefined;
}

/**
 * 入れ済みの daemon の一覧: 既定の設定（`<base>/config.json`）と、init 済みの plist（既定・別名のどちらも。`--org` 違いの Label も）。
 * 元の plist（.touryou/launchd）が消えて、LaunchAgents にだけ残る daemon も含める（--others・ui と同じ。両方にあれば元の plist を読む）。
 * plist と設定を読むのは、ここで 1 回だけ（検査のたびに読み直さない）。読めない plist は飛ばす。
 */
export function listDaemons(base: string, plistDir: string, agentsDir: string): DaemonEntry[] {
  const entry = (configPath: string, label?: string): DaemonEntry => {
    const sd = stateDirOf(configPath);
    return {
      configPath,
      ...(label === undefined ? {} : { label }),
      stateDir: sd === undefined ? undefined : canonicalPath(sd),
    };
  };
  const out: DaemonEntry[] = [entry(join(base, "config.json"))];
  const names = new Map(
    [...daemonPlistNames(plistDir), ...daemonPlistNames(agentsDir)].map((p) => [p.file, p]),
  );
  for (const p of [...names.values()].sort((a, b) => a.file.localeCompare(b.file))) {
    const cfg = readDaemonPlist([plistDir, agentsDir], p.file);
    const configPath = cfg === undefined ? undefined : plistConfigOf(cfg.text);
    if (configPath !== undefined) out.push(entry(configPath, p.label));
  }
  return out;
}

/**
 * 同じ stateDir（実パスで比べる）を使う、ほかの daemon（`daemons` は listDaemons の値。呼ぶ側が 1 回だけ作る）。
 * 自分の plist（`selfLabel`）だけは、同じ daemon なので飛ばす（同じ --org の init のやり直しを止めない）。
 * 同じ設定でも Label が違う plist（別の --org で 2 回 init した）は、別の daemon として検査し、見つけたら止める。
 * 見つかったら、その設定のパス（と Label）。なければ undefined。
 */
export function stateDirSharedWith(
  daemons: readonly DaemonEntry[],
  base: string,
  configPath: string,
  stateDir: string,
  selfLabel: string,
): StateDirSharing | undefined {
  const self = canonicalPath(configPath);
  const mine = canonicalPath(stateDir);
  const selfIsDefault = self === canonicalPath(join(base, "config.json"));
  for (const c of daemons) {
    // 自分の plist（同じ Label）は、同じ daemon なので飛ばす。
    // 既定の設定は、--org を変えて並べられる（既存の動き。plist だけが別名になる）ので、同じ設定どうしは飛ばす。
    // 別名の設定（--config）は、Label（--org）が違っても同じ設定なら、同じ stateDir の別の daemon として止める
    if (c.label === selfLabel) continue;
    if (selfIsDefault && canonicalPath(c.configPath) === self) continue;
    if (c.stateDir !== undefined && c.stateDir === mine) return c;
  }
  return undefined;
}

/**
 * `init --others`: init 済みの別名の設定（--config で作ったもの）すべてを、同じ --org・--path-prefix・--config で init し直す
 * （版上げのあと、新しい版の形にそろえる。既存と同じなら何もしない）。--org・--path-prefix は、plist の Label・PATH から読み戻す。
 */
function initOthers(args: readonly string[], deps: LaunchdDeps): CommandResult {
  if (args.length !== 1) return fail("--others は、ほかの引数と一緒に指定できない");
  const home = deps.env.HOME;
  if (home === undefined || home === "" || !isAbsolute(home) || !plainPath(home)) {
    return fail("HOME が、絶対パスでない・空・使えない文字を含む");
  }
  const plistDir = plistDirOf(home);
  // 対象は、LaunchAgents に置いた（常駐にした）ものだけ（has_extra_daemons・stop/apply --others と同じ集合）。
  // init しただけで使っていない plist は、壊れていても見ない
  const agentsDir = agentsDirOf(home);
  const names = daemonPlistNames(agentsDir, "others");
  if (names.length === 0) {
    return {
      exitCode: 0,
      stdout: "別名の設定（--config）の daemon は、常駐にしたものがない（何もしていない）\n",
      stderr: "",
    };
  }
  // 先に、全部の設定を検査する（1 つでも通らなければ、何も書かない。新旧の plist が混ざらないように）
  const plans: InitPlan[] = [];
  const failures: string[] = [];
  for (const n of names) {
    // 元の plist（.touryou/launchd）が消えていれば、LaunchAgents のものから設定・PATH を読み戻す
    const plist = readDaemonPlist([plistDir, agentsDir], n.file);
    const cfg = plist === undefined ? undefined : plistConfigOf(plist.text);
    const pathValue = plist === undefined ? undefined : pathValueOf(plist.text);
    if (cfg === undefined || pathValue === undefined) {
      failures.push(
        `  ${plist?.file ?? join(agentsDir, n.file)}: 設定（--config）または PATH を読めない。手で外すか、"$HOME/.touryou/current/bin/touryou" launchd init --config <設定> で作り直す`,
      );
      continue;
    }
    const planned = planInit(
      [
        "--config",
        cfg,
        ...(n.org === undefined ? [] : ["--org", n.org]),
        ...pathPrefixArgs(pathValue),
      ],
      deps,
    );
    if ("exitCode" in planned) {
      const reason = planned.stderr
        .trim()
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n");
      failures.push(`  --config ${cfg}:\n${reason}`);
    } else {
      plans.push(planned);
    }
  }
  if (failures.length > 0) {
    return fail(
      `init --others: 作り直せない設定が ${failures.length} 件ある。何も書かずに止めた（全部を検査してから書くので、新旧の plist は混ざらない）:\n${failures.join("\n")}\n直してから、もう一度実行する`,
      1,
    );
  }
  // 全部の下ごしらえ（一時ファイル）が済んでから、置き換える。下ごしらえの途中で例外が出たら、
  // 一時ファイルを全部消して止める（本物の plist は、1 つも変わっていない。新旧の plist が混ざらない）
  const staged: Staged[] = [];
  try {
    for (const p of plans) staged.push(stageInit(p));
  } catch (e) {
    for (const s of staged) discardStaged(s);
    return fail(
      `init --others: plist の下ごしらえに失敗した（${maskValues(e instanceof Error ? e.message : String(e))}）。何も置き換えずに止めた（新旧の plist は混ざらない）。原因を直してから、もう一度実行する`,
      1,
    );
  }
  const results = plans.map((p, i) => writeInit(p, staged[i] as Staged));
  const failed = results.find((r) => r.exitCode !== 0);
  return {
    exitCode: failed?.exitCode ?? 0,
    stdout: results.map((r) => r.stdout).join(""),
    stderr: results.map((r) => r.stderr).join(""),
  };
}

export function runLaunchd(argv: readonly string[], deps: LaunchdDeps): CommandResult {
  if (argv[0] !== "init") {
    return fail(
      `touryou launchd には、init・apply・status・restart・stop・uninstall のどれかを指定する\n\n${HELP}`,
    );
  }
  const args = argv.slice(1);
  if (args.includes("--help") || args.includes("-h")) {
    return { exitCode: 0, stdout: HELP, stderr: "" };
  }
  if (args.includes("--others")) return initOthers(args, deps);
  const planned = planInit(args, deps);
  return "exitCode" in planned ? planned : writeInit(planned);
}

/** init の検査が済んだ、書く内容。書く前に、全部の設定で作る（`init --others` が、検査と書き込みを分けるため）。 */
interface InitPlan {
  readonly home: string;
  readonly base: string;
  readonly logsDir: string;
  readonly plistDir: string;
  readonly daemonLabel: string;
  readonly targets: readonly Target[];
  readonly toWrite: readonly Target[];
  readonly toReplace: readonly Target[];
  readonly same: readonly string[];
  readonly legacyScript: string;
  readonly scriptIsLegacy: boolean;
}

/** init の引数と、書く先の状態を全部確かめる（何も書かない）。書けなければ、止める理由（CommandResult）を返す。 */
function planInit(args: readonly string[], deps: LaunchdDeps): InitPlan | CommandResult {
  let org: string | undefined;
  let pathPrefix = "";
  let prefixGiven = false;
  let configArg: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    const v = args[i + 1];
    if (a === "--org" || a === "--path-prefix" || a === "--config") {
      if (v === undefined || v.startsWith("--")) return fail(`${a} には値を指定する`);
      if (a === "--org") org = v;
      else if (a === "--config") configArg = v;
      else {
        pathPrefix = v;
        prefixGiven = true;
      }
      i += 1;
    } else {
      return fail(`不明な引数: ${a}\n\n${HELP}`);
    }
  }
  if (org !== undefined && !REVERSE_DOMAIN.test(org)) {
    return fail(
      "--org は、小文字の英数字とハイフンのラベルを、ドットで 2 つ以上つないだ形（例: com.example）にする",
    );
  }
  let pathValue = DEFAULT_PATH;
  if (prefixGiven) {
    const dirs = pathPrefix.split(":");
    if (dirs.some((d) => d === "" || !plainPath(d))) {
      return fail(
        "--path-prefix は、絶対パスのディレクトリ（コロン区切り）にする。英数字・. _ / @ + 空白 - だけが使える（.. の要素・// は使えない）",
      );
    }
    pathValue = `${pathPrefix}:${DEFAULT_PATH}`;
  }

  const home = deps.env.HOME;
  if (home === undefined || home === "" || !isAbsolute(home) || !plainPath(home)) {
    return fail(
      "HOME が、絶対パスでない・空・使えない文字を含む（英数字・. _ / @ + 空白 - だけが使える。.. の要素・// は使えない）",
    );
  }
  const base = join(home, ".touryou");
  if (configArg !== undefined && !usableConfigPath(configArg)) {
    return fail(
      "--config は、設定ファイルの絶対パスにする。英数字・. _ / @ + 空白 - だけが使える（.. の要素・// は使えない）",
    );
  }
  // --config を明示したときだけ、plist に書く設定のパスを実パスにそろえる（リンク経由の指定でも、同じ設定は同じ plist・Label になる）。
  // 省略（既定の設定）は <base>/config.json のまま（HOME がリンクでも、plist の内容を変えない）
  const configPath = configPathOf(base, configArg);
  if (!usableConfigPath(configPath)) {
    return fail(
      "--config の実パス（リンクを解決したもの）が、使えない文字を含む。英数字・. _ / @ + 空白 - だけが使える（.. の要素・// は使えない）",
    );
  }
  const daemonName = daemonNameOf(base, configPath);
  const isDefault = daemonName === "daemon";
  if (!existsSync(configPath) || !existsSync(join(base, "current"))) {
    return fail(
      isDefault
        ? "/setup が済んでいない（HOME の .touryou に config.json と current がない）。先に /setup を実行する"
        : "--config の設定ファイルがない、または /setup が済んでいない（HOME の .touryou に current がない）",
      1,
    );
  }
  const stateDir = stateDirOf(configPath);
  if (stateDir === undefined || !plainPath(stateDir)) {
    return fail(
      "config.json の stateDir を読めない（絶対パスでない・使えない文字を含む）。/setup のやり直しを検討する",
      1,
    );
  }
  const problem = configProblem(home, pathValue, deps.checkConfig, configPath);
  if (problem !== undefined) return fail(problem, 1);

  const binDir = join(base, "bin");
  const logsDir = join(base, "logs");
  const plistDir = join(base, "launchd");
  // 同じ stateDir（port・トークン・DB の置き場）を、別の設定の daemon が使うと、同じ state を取り合って壊れる。
  // 同じ設定を別の --org で init したもの（Label が違う plist）も、別の daemon として数える
  const daemonLabel = labelOf(org, daemonName);
  const sharing = stateDirSharedWith(
    listDaemons(base, plistDir, agentsDirOf(home)),
    base,
    configPath,
    stateDir,
    daemonLabel,
  );
  if (sharing !== undefined) {
    return fail(
      `stateDir が、別の設定（${describeSharing(sharing)}）の daemon と同じ。同じ state を 2 つの daemon が使うと壊れるので、何も書かずに止めた。設定ごとに、別の stateDir にする（同じ設定を別の --org で作り直すときは、先に uninstall --yes で外す）`,
      1,
    );
  }
  // 生成先のディレクトリが、リンクだと、辿って別の場所へ書いてしまう。リンク・通常のディレクトリでないものは、書かずに止める
  const badDirs = [base, binDir, logsDir, plistDir].filter((d) => {
    const st = lstatOrUndefined(d);
    return st !== undefined && !st.isDirectory();
  });
  if (badDirs.length > 0) {
    return fail(
      `生成先が、通常のディレクトリでない（シンボリックリンクなど）ので、何も書かずに止めた:\n${badDirs
        .map((d) => `  ${d}`)
        .join("\n")}\nリンクでない、通常のディレクトリにしてから、もう一度実行する`,
      1,
    );
  }
  const plistPath = join(plistDir, `${daemonLabel}.plist`);
  const common = {
    label: daemonLabel,
    workingDirectory: base,
    log: join(logsDir, `${daemonName}.log`),
    path: pathValue,
  };
  const targets: Target[] = [
    {
      path: plistPath,
      content: plistText({
        ...common,
        programArguments: daemonProgramArguments(base, configPath),
      }),
      mode: 0o644,
    },
  ];
  // 古い形（v0.1.0 まで）の生成物。同じ --org・--path-prefix の init が生成したものと、バイト単位で同じときだけ、置き換える（#64）。
  // 別名の設定（--config）には、古い形がない（#165）ので、見ない
  const legacyScript = legacyScriptPath(base);
  const legacyPlist = isDefault ? legacyPlistText({ ...common, script: legacyScript }) : undefined;
  const v011Plist = isDefault ? v011PlistText({ ...common, base }) : undefined;
  const readRegular = (p: string): string | undefined => {
    const st = lstatOrUndefined(p);
    return st?.isFile() === true ? readFileSync(p, "utf8") : undefined;
  };
  const scriptSt = isDefault ? lstatOrUndefined(legacyScript) : undefined;
  const scriptIsLegacy = isDefault && readRegular(legacyScript) === runDaemonScript(base);

  // 先に全部を確かめる（1 つでも、違う内容の既存があれば、何も書かない）
  const toWrite: Target[] = [];
  const toReplace: Target[] = [];
  const same: string[] = [];
  const conflicts: string[] = [];
  for (const t of targets) {
    const st = lstatOrUndefined(t.path);
    const text = readRegular(t.path);
    if (st === undefined) {
      toWrite.push(t);
    } else if (text === t.content) {
      same.push(t.path);
    } else if (
      legacyPlist !== undefined &&
      text === legacyPlist &&
      (scriptSt === undefined || scriptIsLegacy)
    ) {
      toReplace.push(t);
    } else if (v011Plist !== undefined && text === v011Plist) {
      // v0.1.1 の形（current/bin/node を直に起こす）。同じ --org・--path-prefix の v0.1.1 の init の生成物と同じときだけ（#73）
      toReplace.push(t);
    } else {
      conflicts.push(t.path);
    }
  }
  // 古い形の起動スクリプトは、古い形と同じときだけ消す。違えば（手で直した・リンクなど）、止める
  if (scriptSt !== undefined && !scriptIsLegacy) conflicts.push(legacyScript);
  if (conflicts.length > 0) {
    return fail(
      `既存のファイルが、生成する内容と違う（または通常のファイルでない）ので、何も書かずに止めた（黙って上書きしない）:\n${conflicts
        .map((p) => `  ${p}`)
        .join(
          "\n",
        )}\n中身を確かめ、不要なら自分で削除してから、もう一度実行する（組織の逆ドメインや --path-prefix を変えたときも、同じ）`,
      1,
    );
  }
  return {
    home,
    base,
    logsDir,
    plistDir,
    daemonLabel,
    targets,
    toWrite,
    toReplace,
    same,
    legacyScript,
    scriptIsLegacy,
  };
}

/** 書く前の下ごしらえの結果: 権限の注意と、一時ファイル（`<plist>.new`）。 */
interface Staged {
  readonly dirNotes: readonly string[];
  readonly files: readonly { readonly tmp: string; readonly dest: string }[];
}

/**
 * 下ごしらえ: ディレクトリを作り、書く内容を、全部一時ファイルに書く。本物の plist は、まだ 1 つも変えない
 * （ここで例外が出ても、一時ファイルを消して投げ直す。`init --others` が、全部の下ごしらえが済んでから置き換えるため）。
 */
function stageInit(plan: InitPlan): Staged {
  const { logsDir, plistDir, toWrite, toReplace } = plan;
  // ディレクトリ（自分が作るものだけ、権限を設定する。既存のものは、権限を確かめる）
  const dirNotes: string[] = [];
  for (const [dir, mode] of [
    [logsDir, 0o700],
    [plistDir, 0o755],
  ] as const) {
    if (lstatOrUndefined(dir) === undefined) {
      mkdirSync(dir, { recursive: true, mode });
      chmodSync(dir, mode);
    } else if (mode === 0o700 && (modeOf(dir) & 0o077) !== 0) {
      dirNotes.push(`${dir} の権限が ${oct(modeOf(dir))}（直す: chmod 700 "${dir}"）`);
    }
  }
  const files: { tmp: string; dest: string }[] = [];
  try {
    for (const t of [...toWrite, ...toReplace]) {
      mkdirSync(dirname(t.path), { recursive: true });
      const tmp = `${t.path}.new`;
      files.push({ tmp, dest: t.path });
      rmSync(tmp, { force: true });
      writeFileSync(tmp, t.content, { flag: "wx", mode: t.mode });
      chmodSync(tmp, t.mode);
    }
  } catch (e) {
    discardStaged({ dirNotes, files });
    throw e;
  }
  return { dirNotes, files };
}

/** 下ごしらえの一時ファイルを消す（置き換えずにやめるとき）。 */
function discardStaged(staged: Staged): void {
  for (const f of staged.files) rmSync(f.tmp, { force: true });
}

/** planInit が確かめた内容を書く（下ごしらえ → 置き換え）。 */
function writeInit(plan: InitPlan, staged: Staged = stageInit(plan)): CommandResult {
  const {
    home,
    base,
    logsDir,
    plistDir,
    daemonLabel,
    targets,
    toWrite,
    toReplace,
    same,
    legacyScript,
    scriptIsLegacy,
  } = plan;
  const dirNotes = [...staged.dirNotes];
  // 古い形からの引っ越しも、新しく書くものも、一時ファイルを置き換える（途中で止まっても、古い形か新しい形のどちらかが残る）
  for (const f of staged.files) renameSync(f.tmp, f.dest);

  // 生成後の確認（権限）
  const problems: string[] = [...dirNotes];
  for (const t of targets) {
    if (modeOf(t.path) !== t.mode) {
      problems.push(
        `${t.path} の権限が ${oct(modeOf(t.path))}（直す: chmod ${oct(t.mode)} "${t.path}"）`,
      );
    }
  }

  const la = join(home, "Library", "LaunchAgents");
  const out: string[] = [];
  out.push("【生成した】");
  for (const t of toWrite) out.push(`  ${t.path}（${oct(t.mode)}）`);
  for (const t of toReplace)
    out.push(
      `  ${t.path}（${oct(t.mode)}。古い形〔run-daemon.sh か bin/node を起こす〕から、新しい形〔TouRyou.app を起こす〕に置き換えた）`,
    );
  if (scriptIsLegacy) {
    // LaunchAgents に古い形が残っているうちは、次のログインで起こされうるので、消さない（apply が置き換えたあと・uninstall で消す）
    out.push(
      `  ${legacyScript}（古い形の起動スクリプト。apply が LaunchAgents の plist を置き換えたあとに消す）`,
    );
  }
  for (const p of same) out.push(`  ${p}（既存と同じ。そのまま）`);
  out.push("");
  out.push(
    "【読み込む】（人が行う。ログイン時に、自動で動くようになる。macOS から、項目が追加された通知が出る）",
  );
  out.push(
    "  ログイン項目には「TouRyou」の 1 項目が出る。「開発元を識別できない項目」と出るのは、同梱の node を TouRyou の名前で手元の署名（ad-hoc）にしたためで、正常（docs/launchd.md）。",
  );
  out.push("  端末で動かしている daemon があれば、先に止める（同じ state・同じポート）。");
  out.push(`  mkdir -p "${la}"`);
  out.push(`  cp "${join(plistDir, `${daemonLabel}.plist`)}" "${la}/"`);
  out.push(`  "${LSREGISTER}" -f "${appBundlePath(base)}"`);
  out.push(`  launchctl bootstrap "gui/$(id -u)" "${join(la, `${daemonLabel}.plist`)}"`);
  out.push("");
  out.push("【止める】（人が行う）");
  out.push(`  launchctl bootout "gui/$(id -u)/${daemonLabel}"`);
  out.push("");
  out.push("【削除する】（人が行う。止めたあと）");
  out.push(`  rm "${join(la, `${daemonLabel}.plist`)}"`);
  out.push(`  rm "${join(plistDir, `${daemonLabel}.plist`)}"`);
  out.push(`  "${LSREGISTER}" -u "${appBundlePath(base)}"`);
  out.push(`  （ログ ${logsDir} は残る。要らなければ、自分で削除する）`);
  out.push("");
  out.push(
    "この生成は、launchctl を実行していない。読み込み・止める・削除は、上の命令を、人が実行する。",
  );
  out.push(
    "取り消せない操作の確認が要る Desktop の木は、常駐では使えない（docs/launchd.md の 0）。",
  );
  if (problems.length > 0) {
    return {
      exitCode: 1,
      stdout: `${out.join("\n")}\n`,
      stderr: `権限の確認で、問題があった:\n${problems.map((p) => `  ${p}`).join("\n")}\n`,
    };
  }
  return { exitCode: 0, stdout: `${out.join("\n")}\n`, stderr: "" };
}
