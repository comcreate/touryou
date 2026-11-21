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
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readSecureFile } from "@touryou/core/fs";
import { createIdentityVerifier, IDENTITY_FILE, type IdentityVerifier } from "@touryou/mcp/relay";
import type { CommandResult } from "./commands.js";

export interface UiDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 安全な読み取り（他の人が書ける・リンク・持ち主の違うファイルは例外）。`forbid` は禁じる権限のビット。 */
  readonly readFile?: (path: string, forbid: number) => string;
  readonly fetch?: typeof fetch;
  readonly verifierFor?: (daemonUrl: string, identityPath: string) => IdentityVerifier;
  /** ブラウザで開く。開けたら true。既定は macOS の `open`（ほかの OS では false）。 */
  readonly openUrl?: (url: string) => boolean;
  /** 実行したディレクトリ。複数の daemon があるとき、repoRoot がこの中にある daemon を既定にする。 */
  readonly cwd?: string;
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

/** init が生成する、別名の設定（`--config`）の daemon の plist のファイル名から、設定のパスを読むための形。 */
const OTHER_PLIST = /touryou\.daemon-[0-9a-f]{8}\.plist$/;
const PLIST_CONFIG = /<string>--config<\/string>\s*<string>([^<]*)<\/string>/;

interface Candidate {
  readonly configPath: string;
  /** その設定の repoRoot（読めなければ undefined）。 */
  readonly repoRoot?: string;
}

/** `<home>/.touryou/launchd` の別名の daemon の plist から、設定のパスを集める（絶対パスのものだけ）。 */
function otherConfigs(home: string, deps: UiDeps, read: (p: string, f: number) => string): string[] {
  const dir = `${home}/.touryou/launchd`;
  let names: string[];
  try {
    names = (deps.readDir ?? ((p: string) => readdirSync(p)))(dir).filter((n) => OTHER_PLIST.test(n));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names.sort()) {
    try {
      const cfg = PLIST_CONFIG.exec(read(`${dir}/${n}`, 0o022))?.[1];
      if (cfg !== undefined && cfg.startsWith("/")) out.push(cfg);
    } catch {
      // 読めない plist は、候補にしない
    }
  }
  return out;
}

const repoRootOf = (path: string, read: (p: string, f: number) => string): string | undefined => {
  try {
    const j = JSON.parse(read(path, 0o022)) as { repoRoot?: unknown } | null;
    return typeof j?.repoRoot === "string" ? j.repoRoot.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
};

const within = (cwd: string, root: string): boolean => cwd === root || cwd.startsWith(`${root}/`);

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
  const read =
    deps.readFile ??
    ((p: string, forbid: number) => readSecureFile(p, { forbid, maxBytes: MAX_BYTES }));
  const home = deps.env.HOME ?? "";
  const defaultConfig = home === "" ? undefined : `${home.replace(/\/+$/, "")}/.touryou/config.json`;
  // 複数の daemon（設定ごと）があるときの候補。既定の設定と、`touryou launchd init --config` で作った別名の設定
  const candidates: Candidate[] = [];
  if (defaultConfig !== undefined) {
    for (const c of [defaultConfig, ...otherConfigs(home.replace(/\/+$/, ""), deps, read)]) {
      const repoRoot = repoRootOf(c, read);
      candidates.push({ configPath: c, ...(repoRoot === undefined ? {} : { repoRoot }) });
    }
  }
  if (list) {
    return {
      exitCode: 0,
      stdout: `${candidates.map((c) => `${c.configPath}${c.repoRoot === undefined ? "" : `（repoRoot: ${c.repoRoot}）`}`).join("\n")}\n`,
      stderr: "",
    };
  }
  // 選び方: --config > TOURYOU_DAEMON_CONFIG > 実行したディレクトリが repoRoot の中にある候補（いちばん深いもの） > 既定の設定
  const fromCwd =
    deps.cwd === undefined || candidates.length < 2
      ? undefined
      : candidates
          .filter((c) => c.repoRoot !== undefined && within(deps.cwd as string, c.repoRoot))
          .sort((a, b) => (b.repoRoot?.length ?? 0) - (a.repoRoot?.length ?? 0))[0]?.configPath;
  const configPath =
    configArg ??
    (deps.env.TOURYOU_DAEMON_CONFIG !== undefined && deps.env.TOURYOU_DAEMON_CONFIG !== ""
      ? deps.env.TOURYOU_DAEMON_CONFIG
      : (fromCwd ?? defaultConfig));
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
      "daemon の設定ファイル（~/.touryou/config.json）を読めない、または stateDir が絶対パスでない",
      "/touryou:setup で設定を作る（または確かめる）",
    );
  }
  let port: number;
  try {
    const text = read(join(stateDir, "port"), 0o077).trim();
    if (!/^[0-9]{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535)
      throw new Error("port");
    port = Number(text);
  } catch {
    return fail(
      "daemon のポートが分からない（daemon が動いていない・起動の途中）",
      'daemon を起動する（/touryou:start、常駐なら "$HOME/.touryou/current/bin/touryou" launchd status で確かめる）',
      '起動したら、もう一度 "$HOME/.touryou/current/bin/touryou" ui を実行する',
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
      '状態画面を、既定のブラウザで開きました（60 秒のうちに開かないと、使えなくなります。そのときは、もう一度 "$HOME/.touryou/current/bin/touryou" ui を実行してください）。\n画面を再読み込みしたときも、"$HOME/.touryou/current/bin/touryou" ui で開き直してください。\n',
    stderr: "",
  };
}
