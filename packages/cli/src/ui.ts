/**
 * `touryou ui`（Issue #88）: 状態画面を、使い捨てのチケットで、既定のブラウザで開く。
 *
 * 1. `$HOME/.touryou/config.json`（または `TOURYOU_DAEMON_CONFIG`）の `stateDir` から、`port` と `human-token` を自分で読む。
 * 2. daemon の身元を確かめる（`docs/daemon-identity.md`。今の `touryou` コマンドと同じ）。合わなければ、トークンを送らずに止まる。
 * 3. `POST /v1/ui/ticket`（`human-token`）でチケット（60 秒・1 回だけ）をもらう。
 * 4. `http://127.0.0.1:<port>/ui#ticket=<チケット>` を、macOS の `open` で開く。
 *
 * `human-token` は、メモリの中だけで使い、標準出力・標準エラー・引数・ログに出さない。チケットも、標準出力・標準エラーに出さない
 * （`open` の引数にだけ渡す。`ps` に出るのは、使い捨てのチケットだけ）。ブラウザを開けないときは、URL を出さずに止まる。
 */
import { join } from "node:path";
import { readSecureFile } from "@touryou/core/fs";
import { createIdentityVerifier, IDENTITY_FILE, type IdentityVerifier } from "@touryou/mcp/relay";
import type { CommandResult } from "./commands.js";
import { agentsDirOf, canonicalPath, plistDirOf, usableConfigPath } from "./launchd.js";
import { daemonPlistNames, plistConfigOf, readDaemonPlist } from "./launchd-plists.js";

export interface UiDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 安全な読み取り（他の人が書ける・リンク・持ち主の違うファイルは例外）。`forbid` は禁じる権限のビット。 */
  readonly readFile?: (path: string, forbid: number) => string;
  readonly fetch?: typeof fetch;
  readonly verifierFor?: (daemonUrl: string, identityPath: string) => IdentityVerifier;
  /** ブラウザで開く。開けたら true。既定は macOS の `open`（ほかの OS では false）。 */
  readonly openUrl?: (url: string) => boolean;
  /**
   * 実行したディレクトリ（関数なら、候補の選びで必要になったときだけ呼ぶ。投げたら、取れなかったとして扱う）。
   * 複数の daemon があるとき、repoRoot がこの中にある daemon を既定にする。
   */
  readonly cwd?: string | (() => string);
  /** ディレクトリの一覧（試験用）。 */
  readonly readDir?: (path: string) => string[];
}

const MAX_BYTES = 64 * 1024;
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const fail = (cause: string, ...next: string[]): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: `状態画面を開けません: ${cause}\n${next.map((n) => `次の操作: ${n}\n`).join("")}`,
});

const NOT_MAC = fail(
  "ブラウザを開けない（この端末では、既定のブラウザを開けない。Claude Code がクラウドで動いている など）",
  'Mac のターミナルで "$HOME/.touryou/current/bin/touryou" ui を実行してください（Claude Code では /touryou:ui）',
);

interface Candidate {
  readonly configPath: string;
  /** その設定の repoRoot・worktreeRoot（読めなければ undefined）。子の作業ツリーは worktreeRoot の下にある。 */
  readonly repoRoot?: string;
  readonly worktreeRoot?: string;
}

/**
 * 別名の daemon の plist から、設定のパスを集める（絶対パスのものだけ）。
 * 対象は、`--others`・版上げと同じ、LaunchAgents に置いた（常駐にした）もの。init しただけの plist は候補にしない。
 * 元の plist（`<home>/.touryou/launchd`）が消えていて LaunchAgents にだけ残るものは、LaunchAgents のものを読む。
 */
function otherConfigs(
  home: string,
  deps: UiDeps,
  read: (p: string, f: number) => string,
): string[] {
  const agentsDir = agentsDirOf(home);
  const plistDir = plistDirOf(home);
  const out: string[] = [];
  for (const n of daemonPlistNames(agentsDir, "others", deps.readDir)) {
    const plist = readDaemonPlist([plistDir, agentsDir], n.file, read);
    const cfg = plist === undefined ? undefined : plistConfigOf(plist.text);
    if (cfg !== undefined && cfg.startsWith("/")) out.push(cfg);
  }
  return out;
}

const rootsOf = (
  path: string,
  read: (p: string, f: number) => string,
): Pick<Candidate, "repoRoot" | "worktreeRoot"> => {
  try {
    const j = JSON.parse(read(path, 0o022)) as {
      repoRoot?: unknown;
      worktreeRoot?: unknown;
    } | null;
    const root = (v: unknown): string | undefined =>
      typeof v === "string" && v !== "" ? v.replace(/\/+$/, "") : undefined;
    const repoRoot = root(j?.repoRoot);
    const worktreeRoot = root(j?.worktreeRoot);
    return {
      ...(repoRoot === undefined ? {} : { repoRoot }),
      ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
    };
  } catch {
    return {};
  }
};

const within = (cwd: string, root: string): boolean => cwd === root || cwd.startsWith(`${root}/`);

/** cwd が、その設定の repoRoot か worktreeRoot の中にあれば、中にある root の長さ（長いほど深い）。外なら undefined。 */
const depthOf = (cwd: string, c: Candidate): number | undefined => {
  const hits = [c.repoRoot, c.worktreeRoot]
    .filter((r): r is string => r !== undefined && within(cwd, r))
    .map((r) => r.length);
  return hits.length === 0 ? undefined : Math.max(...hits);
};

const describeCandidate = (c: Candidate): string => {
  const roots = [
    ...(c.repoRoot === undefined ? [] : [`repoRoot: ${c.repoRoot}`]),
    ...(c.worktreeRoot === undefined ? [] : [`worktreeRoot: ${c.worktreeRoot}`]),
  ];
  return `${c.configPath}${roots.length === 0 ? "" : `（${roots.join("・")}）`}`;
};

export async function runUi(argv: readonly string[], deps: UiDeps): Promise<CommandResult> {
  let configArg: string | undefined;
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--list") {
      list = true;
    } else if (a === "--config") {
      const v = argv[i + 1];
      if (v === undefined || !v.startsWith("/")) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "--config には、daemon の設定ファイルの絶対パスを指定する\n",
        };
      }
      configArg = v;
      i += 1;
    } else {
      return {
        exitCode: 2,
        stdout: "",
        stderr:
          '"$HOME/.touryou/current/bin/touryou" ui は、--config <設定ファイルの絶対パス>・--list だけを取る（トークン・URL を引数で渡さない）\n',
      };
    }
  }
  if (list && configArg !== undefined) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "--list と --config は、同時に指定できない（--list は候補の一覧だけを出す）\n",
    };
  }
  const read =
    deps.readFile ??
    ((p: string, forbid: number) => readSecureFile(p, { forbid, maxBytes: MAX_BYTES }));
  const home = deps.env.HOME ?? "";
  const defaultConfig =
    home === "" ? undefined : `${home.replace(/\/+$/, "")}/.touryou/config.json`;
  const envConfig =
    deps.env.TOURYOU_DAEMON_CONFIG !== undefined && deps.env.TOURYOU_DAEMON_CONFIG !== ""
      ? deps.env.TOURYOU_DAEMON_CONFIG
      : undefined;
  // 複数の daemon（設定ごと）があるときの候補。既定の設定・`touryou launchd init --config` で作った別名の設定・
  // 環境変数 TOURYOU_DAEMON_CONFIG の設定（init していない daemon も、これで指せる）
  // 候補が要るのは、--list と、選び方が実行場所（cwd）まで進むとき。--config か TOURYOU_DAEMON_CONFIG で決まるときは、
  // 使わない候補の設定・plist を読まない
  const needCandidates = list || (configArg === undefined && envConfig === undefined);
  const paths: string[] = [];
  const seen = new Set<string>();
  const addPath = (p: string): void => {
    // リンク経由の別の書き方でも、同じ設定は 1 つにまとめる（実パスで比べる）
    const key = canonicalPath(p);
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(p);
  };
  if (needCandidates) {
    if (defaultConfig !== undefined) {
      addPath(defaultConfig);
      for (const c of otherConfigs(home.replace(/\/+$/, ""), deps, read)) addPath(c);
    }
    if (envConfig !== undefined) addPath(envConfig);
  }
  const candidates: Candidate[] = paths.map((c) => ({ configPath: c, ...rootsOf(c, read) }));
  if (list) {
    // HOME が空で、環境変数の設定もないときは、探す場所がない。空の一覧で成功にせず、理由を出す
    if (candidates.length === 0) {
      return fail("daemon の設定ファイルが分からない（HOME がなく、TOURYOU_DAEMON_CONFIG もない）");
    }
    return {
      exitCode: 0,
      stdout: `${candidates.map(describeCandidate).join("\n")}\n`,
      stderr: "",
    };
  }
  // 選び方: --config > TOURYOU_DAEMON_CONFIG > 実行したディレクトリが repoRoot・worktreeRoot の中にある候補（いちばん深いもの） > 既定の設定
  // cwd は、--config・TOURYOU_DAEMON_CONFIG で決まるとき、候補が 1 つ以下のときは読まない（消えた cwd でも開ける）
  let cwd: string | undefined;
  if (needCandidates && candidates.length >= 2 && deps.cwd !== undefined) {
    try {
      cwd = typeof deps.cwd === "function" ? deps.cwd() : deps.cwd;
    } catch {
      return fail(
        "コマンドを実行したディレクトリを取得できない（削除された・入れない）ため、複数の daemon のどれを開くか決められない",
        "存在するディレクトリへ移ってから、もう一度 ui を実行する",
        "または --config <設定ファイルの絶対パス> で開く daemon を指す（候補は ui --list で確かめる）",
      );
    }
  }
  const fromCwd =
    cwd === undefined
      ? undefined
      : candidates
          .map((c) => ({ c, depth: depthOf(cwd, c) }))
          .filter((x): x is { c: Candidate; depth: number } => x.depth !== undefined)
          .sort((a, b) => b.depth - a.depth)[0]?.c.configPath;
  const configPath = configArg ?? envConfig ?? fromCwd ?? defaultConfig;
  if (configPath === undefined) {
    return fail("daemon の設定ファイルが分からない（HOME がない）", "/touryou:setup で設定を作る");
  }
  let stateDir: string;
  try {
    const j = JSON.parse(read(configPath, 0o022)) as { stateDir?: unknown } | null;
    if (typeof j?.stateDir !== "string" || !j.stateDir.startsWith("/")) throw new Error("stateDir");
    stateDir = j.stateDir.replace(/\/+$/, "");
  } catch {
    return fail(
      `daemon の設定ファイル（${configPath}）を読めない、または stateDir が絶対パスでない`,
      configPath === defaultConfig
        ? "/touryou:setup で設定を作る（または確かめる）"
        : `設定ファイル（${configPath}）を直す（--config・TOURYOU_DAEMON_CONFIG・実行した場所で選ばれた設定。別の daemon を開くなら --config で指す）`,
    );
  }
  let port: number;
  try {
    const text = read(join(stateDir, "port"), 0o077).trim();
    if (!/^[0-9]{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535)
      throw new Error("port");
    port = Number(text);
  } catch {
    // 選ばれた設定の daemon を指す（既定の設定のときは、--config を付けない）。launchd が受け付けない書き方の設定は、付けられない
    const target =
      configPath === defaultConfig
        ? ""
        : usableConfigPath(configPath)
          ? ` --config "${configPath}"`
          : undefined;
    const uiCmd = `"$HOME/.touryou/current/bin/touryou" ui${target ?? ""}`;
    return fail(
      `daemon のポートが分からない（設定 ${configPath} の daemon が動いていない・起動の途中）`,
      target === undefined
        ? `daemon を起動する（/touryou:start。設定 ${configPath} のパスが launchd の --config に使えない書き方なので、常駐の確かめは、使える書き方の設定を指して行う）`
        : `daemon を起動する（/touryou:start、常駐なら "$HOME/.touryou/current/bin/touryou" launchd status${target} で確かめる）`,
      `起動したら、もう一度 ${uiCmd} を実行する`,
    );
  }
  let token: string;
  try {
    token = read(join(stateDir, "human-token"), 0o077).trim();
    if (token.length < 32) throw new Error("short");
  } catch {
    return fail(
      "人間のトークンのファイル（stateDir の human-token）を読めない（ない・権限が広い・持ち主が違う）",
      "daemon を一度起動すると作られる。権限は 0600 にする",
    );
  }
  const daemonUrl = `http://127.0.0.1:${port}`;
  const verifier =
    deps.verifierFor?.(daemonUrl, join(stateDir, IDENTITY_FILE)) ??
    createIdentityVerifier({
      daemonUrl,
      identityPath: join(stateDir, IDENTITY_FILE),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
  const v = await verifier.verify({ waitForRestart: false });
  if (!v.ok && v.kind === "transient") {
    return fail(
      "daemon に届かない（止まっているか、起動し直している途中。トークンは送っていない）",
      'daemon が動いているか確かめる（/touryou:status）。戻ったら、もう一度 "$HOME/.touryou/current/bin/touryou" ui を実行する',
    );
  }
  if (!v.ok) {
    return fail(
      "daemon の身元を確かめられない（ポートの相手が、本物の daemon でない恐れ。トークンは送っていない）",
      'daemon を起動し直してから、もう一度 "$HOME/.touryou/current/bin/touryou" ui を実行する',
      "直らなければ、ポートを使っている別のプログラムがないか確かめる",
    );
  }
  let ticket: string | undefined;
  try {
    const res = await (deps.fetch ?? fetch)(`${daemonUrl}/v1/ui/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    // 確かめた相手と、応答した相手が同じか（検証から送信までの間の入れ替わりの検知）
    const id = res.headers.get("x-touryou-daemon-id");
    const text = (await res.text()).slice(0, MAX_BYTES);
    if (id !== v.daemonId) {
      return fail(
        "応答した daemon が、確かめた daemon と違う",
        'daemon を起動し直してから、もう一度 "$HOME/.touryou/current/bin/touryou" ui を実行する',
      );
    }
    if (res.status === 429) {
      return fail(
        "要求が多すぎる",
        'しばらく待ってから、もう一度 "$HOME/.touryou/current/bin/touryou" ui を実行する',
      );
    }
    if (!res.ok) {
      return fail(
        `daemon がチケットを出さなかった（HTTP ${res.status}）`,
        "daemon を新しい版に更新して起動し直す。直らなければ daemon のログを確かめる",
      );
    }
    const body = JSON.parse(text) as { ok?: unknown; value?: { ticket?: unknown } };
    ticket = typeof body.value?.ticket === "string" ? body.value.ticket : undefined;
  } catch {
    ticket = undefined;
  }
  if (ticket === undefined || !TICKET_SHAPE.test(ticket)) {
    return fail(
      "daemon からチケットを受け取れなかった",
      'daemon が動いているか確かめてから、もう一度 "$HOME/.touryou/current/bin/touryou" ui を実行する',
    );
  }
  const opened = (deps.openUrl ?? (() => false))(`${daemonUrl}/ui#ticket=${ticket}`);
  if (!opened) return NOT_MAC;
  return {
    exitCode: 0,
    stdout:
      `開いた設定: ${configPath}\n` +
      '状態画面を、既定のブラウザで開きました（60 秒のうちに開かないと、使えなくなります。そのときは、もう一度 "$HOME/.touryou/current/bin/touryou" ui を実行してください）。\n画面を再読み込みしたときも、"$HOME/.touryou/current/bin/touryou" ui で開き直してください。\n',
    stderr: "",
  };
}
