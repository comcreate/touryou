/**
 * `touryou-mcp --stdio`: 統合セッション用の入口。Claude Code が plugin の `.mcp.json`（stdio 型）から、
 * 統合セッションごとに 1 つ起動する。子用の HTTP の `touryou-mcp`（`main.ts`）は、そのまま残る。
 *
 * - 状態の置き場: 設定ファイルの `stateDir`。設定ファイルは、`--config` の引数 → 環境変数 `TOURYOU_DAEMON_CONFIG`（空は無視）→
 *   `$HOME/.touryou/config.json` の順に決める。設定ファイルの親ディレクトリも、下の `$HOME/.touryou` と同じ検査を通す。
 * - 根のトークン: `<stateDir>/root-token` だけから読む（環境変数は使わない。Claude Code の環境に残ると、Bash などで見えうるため）。
 *   ファイルは、リンクを開かない（`O_NOFOLLOW`）・通常のファイル・自分の・権限の文字列が `-rw-------`（macOS の拡張属性 `@` は可、
 *   ACL の `+` は不可）のときだけ読む。`$HOME/.touryou`・`stateDir`・その親も、リンクでない・自分の・権限の文字列が `drwx------` か
 *   `drwxr-xr-x`（`@` は可）のディレクトリであること（以前の headersHelper と同じ水準）。設定ファイル・`port` も、リンクを開かず、
 *   自分の・他の人が書けないファイルだけを読む。
 *   トークンは、引数・環境変数（子プロセスへ）・ログ・失敗の原因に出さない。
 * - daemon の窓口: `<stateDir>/port` から `http://127.0.0.1:<port>` を作る（書き写さない）。
 * - daemon の身元: `<stateDir>/daemon-identity` で、トークンつきの要求の直前に毎回検証する（HTTP の入口と同じ）。
 * - daemon の再起動への追従: 要求が `daemon_unreachable`・`unauthenticated`・身元の失敗で終わったら、置き場を読み直し、
 *   窓口かトークンが変わっていれば、1 回だけ送り直す。
 * - daemon の自動起動はしない。動いていなければ、分かる文で失敗する（終了コード 1。Claude Code の /mcp に failed と出る）。
 * - 標準出力は MCP の通信に使うので、ログ・失敗は標準エラーだけに出す。標準入力が閉じたら（Claude Code のセッションの終わり）、
 *   接続を閉じて終わる。
 *
 */
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type Failure, failure, isSessionId, ok, type Result } from "@touryou/core";
import { aclProblemOfMode, modeString, readSecureFile } from "@touryou/core/fs";
import { type CodeFileOps, isCodeShape, readCodeFile, removeCodeFile } from "./bind-code-file.js";
import { bindChild, type ChildBindOptions, rebindChild } from "./child-bind.js";
import { detectOpenMode, type MarkerOps } from "./child-marker.js";
import { createIdentityVerifier, IDENTITY_FILE } from "./identity.js";
import { createNodeCredentialStore, type NodeCredentialStore } from "./node-credential.js";
import {
  AUTH_RETRY_MS,
  type NodeSubscriber,
  type SubscribeTarget,
  startNodeSubscriber,
} from "./node-subscriber.js";
import { notificationText, socketFromEnv, writeNotification } from "./notify-socket.js";
import { createRelay, type Relay } from "./relay.js";
import { createInboxProblemReporter, createToolServer, openSession } from "./server.js";

export const ROOT_TOKEN_FILE = "root-token";
export const PORT_FILE = "port";
/** 根のトークンの形（daemon と同じ範囲。以前の headersHelper の検査と同じ）。 */
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const MAX_BYTES = 64 * 1024;
/** 秘密のファイルの権限の文字列（`ls -ld` の 1 列目）。`@` は macOS の拡張属性（アクセス制御ではない）。`+`（ACL）は不可。 */
const SECRET_MODES = new Set(["-rw-------", "-rw-------@"]);
const DIR_MODES = new Set(["drwx------", "drwx------@", "drwxr-xr-x", "drwxr-xr-x@"]);
/** 送り直しでも変えない requestId（relay の形と同じ: 英数字・ハイフン）。 */
const newRequestId = (): string =>
  `mcp-stdio-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
/** 置き場を読み直して送り直す失敗。 */
const RELOAD_CODES = new Set(["daemon_unreachable", "unauthenticated", "daemon_identity_failed"]);

export interface FileOps {
  /** ファイルを安全に読む（リンクを開かない・通常のファイル・自分の・`forbid` の権限のビットがない）。満たさなければ例外。 */
  readonly read: (path: string, forbid: number) => string;
  /** `ls -ld` の 1 列目（権限の文字列。ACL・拡張属性の印を含む）。読めなければ `undefined`。 */
  readonly modeString: (path: string) => string | undefined;
  /** リンクでない・ディレクトリ・自分の、を満たさなければ、理由。 */
  readonly checkDir: (path: string) => string | undefined;
}

function readOwned(path: string, forbid: number): string {
  return readSecureFile(path, { forbid, maxBytes: MAX_BYTES });
}

function checkDir(path: string): string | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return "ない";
  }
  if (st.isSymbolicLink()) return "リンクになっている（リンクは受け付けない）";
  if (!st.isDirectory()) return "ディレクトリでない";
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return "自分のものでない";
  return undefined;
}

const defaultOps: FileOps = { read: readOwned, modeString: (p) => modeString(p), checkDir };

/** 設定・port の ACL（mode ビットは `read` が見る。ここは ACL だけ。分からないときは拒む）。 */
const fileAclProblem = (path: string, ops: FileOps): string | undefined =>
  aclProblemOfMode(ops.modeString(path));

export interface StdioDeps {
  readonly files?: Partial<FileOps>;
  /** 子のセッションの作業ディレクトリ（紐付けで送る。既定は `process.cwd()`。テストで差し替える）。 */
  readonly cwd?: () => string;
  /** 子のセッションの ID（紐付けで送る。`runStdio` が環境変数 `CLAUDE_CODE_SESSION_ID` から渡す）。 */
  readonly sessionId?: string;
  /** この mcp の plugin の場所（`CLAUDE_PLUGIN_ROOT`）。根のモードで、`parent_request` に添える。 */
  readonly pluginRoot?: string;
  /** 子の作業ツリーの印の確かめ（テストで差し替える）。 */
  readonly marker?: MarkerOps;
  /** 紐付けのコードのファイルの確かめ（テストで uid を差し替える）。 */
  readonly codeFile?: CodeFileOps;
  /** 印（`touryou-child`）に書かれたノードの ID（`child_bind` を引数なしで呼んだときに使う）。 */
  readonly markerNodeId?: string;
  /** 子ごとの資格情報の入れ物（紐付けの成功で set、401 で clear。購読が読む）。省略すると、この接続の中で作る。 */
  readonly credentials?: NodeCredentialStore;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface StdioTarget {
  readonly daemonUrl: string;
  readonly token: string;
  readonly identityPath: string;
}

const fail = (
  code: string,
  cause: string,
  ...next: readonly [string, ...string[]]
): Result<never> => ({
  ok: false,
  error: failure(code, cause, ...next),
});

const SETUP =
  "Claude Code で /touryou:setup を先に実行する（デスクトップアプリの拡張機能で使うときも、Claude Code で実行する。docs/desktop-extension.md）";
const START_DAEMON = "daemon が動いていません。launchd か touryou-daemon で起動してください";
const FIX_DIR = "chmod 700 で直す（ACL は chmod -N で外す）";

/** 接続先（daemon の窓口・身元の秘密の場所）。根のトークンは持たない（紐付け待ちの道は、これだけを使う）。 */
export interface DaemonEndpoint {
  readonly daemonUrl: string;
  readonly identityPath: string;
  readonly stateDir: string;
}

/** 引数・設定・状態の置き場から、接続先と根のトークンを決める。値（トークン）は、失敗の原因に出さない。 */
export function resolveStdioTarget(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: StdioDeps = {},
): Result<StdioTarget> {
  const ep = resolveDaemonEndpoint(argv, env, deps);
  if (!ep.ok) return ep;
  return readRootTarget(ep.value, { ...defaultOps, ...deps.files });
}

/** 引数・設定・状態の置き場から、接続先だけを決める（根のトークンは読まない）。 */
export function resolveDaemonEndpoint(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: StdioDeps = {},
): Result<DaemonEndpoint> {
  const ops: FileOps = { ...defaultOps, ...deps.files };
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--config" && value !== undefined && value !== "") configPath = value;
    else
      return fail(
        "invalid_config",
        `未知の引数、または値がない: ${String(flag)}`,
        "touryou-mcp --stdio [--config <daemon の設定>]",
      );
  }
  // 統合セッション用は $HOME/.touryou を置き場にする。
  const home = env.HOME;
  if (home === undefined || home === "" || !isAbsolute(home)) {
    return fail("invalid_config", "HOME が絶対パスでない（置き場を決められない）", SETUP);
  }
  const touryou = join(home, ".touryou");
  // 優先順位: --config の引数 → 環境変数 TOURYOU_DAEMON_CONFIG（空は無視）→ $HOME/.touryou/config.json（touryou の cli と同じ）
  const envConfig = env.TOURYOU_DAEMON_CONFIG;
  configPath ??=
    envConfig === undefined || envConfig === "" ? join(touryou, "config.json") : envConfig;
  const dirProblem = (dir: string): Result<never> | undefined => {
    const why = ops.checkDir(dir);
    if (why !== undefined)
      return fail(
        "invalid_config",
        `設定ファイルの置き場のディレクトリが使えない（${dir}）: ${why}`,
        SETUP,
      );
    const m = ops.modeString(dir);
    if (m === undefined || !DIR_MODES.has(m)) {
      return fail(
        "invalid_config",
        "置き場のディレクトリの権限が、他の人に書き込みを許す、または ACL が付いている",
        FIX_DIR,
      );
    }
    return undefined;
  };
  // 設定が $HOME/.touryou の外にあっても検査が通るよう、対象は設定ファイルの親ディレクトリにする
  const configDirProblem = dirProblem(dirname(configPath));
  if (configDirProblem !== undefined) return configDirProblem;
  let json: unknown;
  try {
    json = JSON.parse(ops.read(configPath, 0o022));
  } catch {
    return fail(
      "invalid_config",
      "daemon の設定ファイルを読めない（ない・リンク・自分のでない・他の人が書ける・JSON でない、のどれか）",
      SETUP,
    );
  }
  const configAcl = fileAclProblem(configPath, ops);
  if (configAcl !== undefined) {
    return fail("invalid_config", `daemon の設定ファイルが使えない: ${configAcl}`, SETUP);
  }
  const stateDir =
    typeof json === "object" && json !== null
      ? (json as Record<string, unknown>).stateDir
      : undefined;
  if (typeof stateDir !== "string" || !isAbsolute(stateDir)) {
    return fail("invalid_config", "daemon の設定の stateDir が、絶対パスでない", SETUP);
  }
  for (const dir of new Set([dirname(stateDir), stateDir])) {
    const p = dirProblem(dir);
    if (p !== undefined) return p;
  }
  const port = readPort(stateDir, ops);
  if (!port.ok) return port;
  return ok({ daemonUrl: port.value, identityPath: join(stateDir, IDENTITY_FILE), stateDir });
}

/** 根のトークンを読む（根で開くときだけ。紐付け待ちの道からは呼ばない）。 */
function readRootTarget(ep: DaemonEndpoint, ops: FileOps): Result<StdioTarget> {
  const tokenPath = join(ep.stateDir, ROOT_TOKEN_FILE);
  let token: string;
  try {
    token = ops.read(tokenPath, 0o077).trim();
  } catch {
    return fail(
      "unauthenticated",
      "根のトークン（state の root-token）を読めない（ない・リンク・自分のでない・他の人に読める、のどれか）",
      START_DAEMON,
      "権限は chmod 600 で直す",
    );
  }
  const tm = ops.modeString(tokenPath);
  if (tm === undefined || !SECRET_MODES.has(tm)) {
    return fail(
      "unauthenticated",
      "state の root-token の権限が 0600 でない、または ACL が付いている",
      "chmod 600 で直す（ACL は chmod -N で外す）",
    );
  }
  if (!TOKEN_RE.test(token)) {
    return fail(
      "unauthenticated",
      "根のトークンが、空・使えない文字を含む・長さが正しくない（16〜512 文字）",
      START_DAEMON,
    );
  }
  return ok({ daemonUrl: ep.daemonUrl, token, identityPath: ep.identityPath });
}

/** `<stateDir>/port` から、daemon の窓口の URL を作る（書き写さない）。 */
function readPort(stateDir: string, ops: FileOps): Result<string> {
  let portText: string;
  try {
    portText = ops.read(join(stateDir, PORT_FILE), 0o022).trim();
  } catch {
    return fail(
      "daemon_unreachable",
      "daemon の窓口のポート（state の port）を読めない",
      START_DAEMON,
    );
  }
  const portAcl = fileAclProblem(join(stateDir, PORT_FILE), ops);
  if (portAcl !== undefined) {
    return fail("daemon_unreachable", `state の port が使えない: ${portAcl}`, START_DAEMON);
  }
  if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    return fail("daemon_unreachable", "state の port が、1〜65535 の整数でない", START_DAEMON);
  }
  return ok(`http://127.0.0.1:${Number(portText)}`);
}

export interface StdioIo {
  stderr(t: string): void;
}

/**
 * 置き場を読み直して追従する relay。失敗が `RELOAD_CODES` のときだけ、`reload` で接続先を読み直し、窓口かトークンが
 * 変わっていれば、新しい relay で 1 回だけ送り直す（変わっていなければ、送り直さない）。
 */
export function createReloadingRelay(
  initial: StdioTarget,
  reload: () => Result<StdioTarget>,
  make: (t: StdioTarget) => Result<Relay>,
): Result<Relay> {
  let target = initial;
  const first = make(target);
  if (!first.ok) return first;
  let relay = first.value;
  const again = async <T>(run: (r: Relay) => Promise<Result<T>>): Promise<Result<T>> => {
    const r = await run(relay);
    if (r.ok || !RELOAD_CODES.has(r.error.code)) return r;
    const next = reload();
    if (!next.ok) return r;
    if (next.value.daemonUrl === target.daemonUrl && next.value.token === target.token) return r;
    const made = make(next.value);
    if (!made.ok) return r;
    target = next.value;
    relay = made.value;
    return run(relay);
  };
  return ok({
    whoami: () => again((r) => r.whoami()),
    // 前提（daemon 側。packages/daemon/src/api/handlers/context.ts の callerKey・deriveId・derivedRequestId）: daemon は、
    // 記録の requestId を「呼び出し元の鍵 + requestId」から導く。呼び出し元の鍵は、ノードのトークンなら actor.nodeId で、
    // 統合セッション（根）では設定の rootNodeId（既定 "root"。config.ts）。daemon を再起動しても、root-token を発行し直しても、
    // 設定を変えない限り同じ値なので、送り直しでも同じ記録の requestId になり、重複の照合（findByRequestId・alreadyApplied）が効く。
    // rootNodeId を変えると、この前提が崩れる（再起動の前後で別の呼び出し元として扱われる）。
    // requestId は、送り直しでも同じものを使う（daemon は requestId で重複を記録するので、1 回目が実行済みでも、2 回目は
    // 同じ結果を返すだけで、操作を重ねない。記録は SQLite にあり、daemon を再起動しても残る）。
    request: (operation, params, options) => {
      const requestId = options?.requestId ?? newRequestId();
      return again((r) => r.request(operation, params, { ...options, requestId }));
    },
  });
}

/** トークンつきの relay を作る（身元の確かめつき）。 */
function relayMaker(deps: StdioDeps, log: (e: unknown) => void) {
  return (t: StdioTarget): Result<Relay> =>
    createRelay({
      daemonUrl: t.daemonUrl,
      token: t.token,
      verifier: verifierOf(t, deps, log),
      onIdentityMismatch: () => log({ event: "identityMismatch", at: new Date().toISOString() }),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
}

function verifierOf(
  t: { readonly daemonUrl: string; readonly identityPath: string },
  deps: StdioDeps,
  log: (e: unknown) => void,
) {
  return createIdentityVerifier({
    daemonUrl: t.daemonUrl,
    identityPath: t.identityPath,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    log,
  });
}

/** 接続を開く（ロールの解決まで）。失敗は、分かる文で返す。`reload` を渡すと、daemon の再起動に追従する。根のセッション用。 */
export async function openStdioSession(
  target: StdioTarget,
  io: StdioIo,
  deps: StdioDeps = {},
  reload?: () => Result<StdioTarget>,
): Promise<Result<Server>> {
  const log = (e: unknown) => io.stderr(`${JSON.stringify(e)}\n`);
  const relay = createReloadingRelay(target, reload ?? (() => ok(target)), relayMaker(deps, log));
  if (!relay.ok) return relay;
  const session = await openSession(
    relay.value,
    createInboxProblemReporter({ log }),
    undefined,
    deps.sessionId,
    deps.pluginRoot,
  );
  if (!session.ok && session.error.code === "daemon_unreachable") {
    return fail(
      "daemon_unreachable",
      START_DAEMON,
      "launchd（docs/launchd.md）か、touryou-daemon --config で起動してから、/mcp で Reconnect する",
    );
  }
  return session;
}

/** 401 のあとの結び直しを、続けて試さない間隔（ミリ秒）。 */
const REBIND_RETRY_MS = 60_000;

/** 紐付けの前の relay（どの操作も、紐付けを促す失敗にする。トークンは持たない）。 */
const unboundRelay: Relay = {
  whoami: async () => notBound(),
  request: async () => notBound(),
};
function notBound(): Result<never> {
  return fail(
    "not_bound",
    "このセッションは、まだ touryou に紐付いていない（子の作業ツリーのセッション）",
    "child_bind を引数なしで呼ぶ",
    "紐付けの文面がなければ、作業を始めずに、会話で人（親）に頼む",
  );
}

/**
 * 「紐付け待ち」で開く。子の作業ツリー（印のファイルがある）で起動したときの道。**根のトークンを読まない**
 * （引数は `DaemonEndpoint` だけで、トークンを持たない）。出す道具は `child_bind` と `whoami` だけで、紐付けが済んだら
 * 子のロールの道具に替える。子のトークンは、このプロセスのメモリの中だけ（`NodeCredentialStore`）に持つ。
 */
export function openPendingStdioSession(
  endpoint: DaemonEndpoint,
  io: StdioIo,
  deps: StdioDeps = {},
): Server {
  const log = (e: unknown) => io.stderr(`${JSON.stringify(e)}\n`);
  const make = relayMaker(deps, log);
  const store = deps.credentials ?? createNodeCredentialStore();
  const childBindOptions = (): ChildBindOptions => ({
    daemonUrl: endpoint.daemonUrl,
    verifier: verifierOf(endpoint, deps, log),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
    ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
  });
  const bind = async (argNodeId: unknown, argCode: unknown): Promise<Result<Relay>> => {
    // 引数なし: ノードの ID は印から、コードは作業ツリーの git のディレクトリのファイルから読む
    let nodeId = argNodeId;
    let code = argCode;
    let filePath: string | undefined;
    /** コードを書いた daemon の公開 ID（ファイルの 2 行目。古い形のファイルは、なし）。 */
    let codeDaemonId: string | undefined;
    if (argNodeId === undefined && argCode === undefined) {
      const read = readCodeFile((deps.cwd ?? (() => process.cwd()))(), deps.codeFile ?? {});
      // コードのファイルがない（使用済み）ときは、`claude attach` で mcp が入れ替わっただけかもしれない。セッションの ID・
      // 作業ツリー・ノードの ID を送って、つなぎ直す（#145）。daemon が記録と合わないと言えば、下の案内に落とす。
      if (!read.ok && read.reason === "missing" && deps.markerNodeId !== undefined) {
        const re = await rebindChild(childBindOptions(), deps.markerNodeId);
        if (re?.ok === true) return adopt(re.value);
        // daemon に届かない・本人確認の失敗・失敗の上限は、案内に落とさずそのまま返す（コードの出し直しでは直らない）
        if (re?.ok === false && re.error.code !== "bind_failed") return re;
      }
      if (!read.ok || deps.markerNodeId === undefined) {
        if (read.ok === false && read.reason === "unsafe" && read.path !== undefined) {
          log({ event: "bindCodeFileUnsafe", at: new Date().toISOString() });
        }
        return fail(
          "bind_code_file_unavailable",
          read.ok === false && read.reason === "unsafe"
            ? "紐付けのコードのファイルが安全でない（リンク・持ち主が違う・権限が 0600 でない）ので読まなかった"
            : "紐付けのコードのファイルがない（使用済み・期限切れ・daemon の再起動のあと）か、このセッションが作業ツリーの一番上で起動されていない。ほかに、子を作った daemon と、この mcp の接続先の daemon が別の可能性もある（plugin が入っていないのとは限らない）",
          "作業を始めずに、会話で人（親）に「紐付けをやり直して」と頼む（親は node_bindCode でコードを出し直す）。出し直されたら、child_bind を引数なしでもう一度呼ぶ",
          "出し直しても同じなら、親に、この子を作った daemon と、plugin（mcp）の接続先（--config・TOURYOU_DAEMON_CONFIG・$HOME/.touryou/config.json）が同じかを確かめてもらう",
          "人が claude attach で子の画面を開いたあとにこうなったなら、MCP がつなぎ直されて紐付けが外れている（#136）。自動のつなぎ直し（#145）は、セッションの ID・作業ツリーが記録と合わない・紐付けの期限が切れた・止められたなどで通らなかった。この場合、daemon が親の受信箱に「紐付けをやり直して」を出している（#186。届かなかったときは、人に頼む）。同じく、親にコードの出し直しを頼む",
        );
      }
      nodeId = deps.markerNodeId;
      code = read.code;
      filePath = read.path;
      codeDaemonId = read.daemonId;
    }
    const cred = await bindChild(
      { ...childBindOptions(), ...(codeDaemonId === undefined ? {} : { codeDaemonId }) },
      nodeId,
      code,
    );
    if (filePath !== undefined) {
      // 通ったら消す。通らなくても、形の正しくないコードは消す（読み直しても使えない）
      if (cred.ok || typeof code !== "string" || !isCodeShape(code)) removeCodeFile(filePath);
    }
    if (!cred.ok) {
      if (filePath !== undefined && cred.error.code === "bind_failed") {
        return fail(
          "bind_failed",
          "紐付けに失敗した（コードが使用済み・期限切れ・daemon の再起動で無効、または作業ツリーの一番上のセッションでない）",
          "作業を始めずに、会話で人（親）に「紐付けをやり直して」と頼む（daemon も受信箱に出す。親は node_bindCode でコードを出し直す）。出し直されたら、child_bind を引数なしでもう一度呼ぶ",
        );
      }
      return cred;
    }
    return adopt(cred.value);
  };
  /** 受け取った資格情報を入れ物に入れ、子の relay にする。 */
  const adopt = (cred: { readonly nodeId: string; readonly token: string }): Result<Relay> => {
    const made = make({
      daemonUrl: endpoint.daemonUrl,
      identityPath: endpoint.identityPath,
      token: cred.token,
    });
    if (!made.ok) return made;
    inner = made.value;
    store.set(cred);
    // daemon の 401 は、先に、コードなしの結び直しを試す（`store.reject`）。通れば、新しい資格情報で 1 回だけ呼び直す
    // （401 は処理の前に断られるので、呼び直しても二重にならない）。通らなければ、入れ物が空になる（購読を止める）。
    const watch = async <T>(call: (r: Relay) => Promise<Result<T>>): Promise<Result<T>> => {
      const used = store.get()?.token;
      const r = await call(inner);
      if (r.ok || r.error.code !== "unauthenticated" || used === undefined) return r;
      return (await store.reject(used)) ? call(inner) : r;
    };
    return ok({
      nodeId: cred.nodeId,
      whoami: () => watch((r) => r.whoami()),
      request: (op, params, o) => watch((r) => r.request(op, params, o)),
    });
  };
  /** いま使っている子の relay（結び直しで、トークンごと差し替える）。 */
  let inner: Relay = unboundRelay;
  // 結び直し（#185）: 紐付けの印があるときだけ。同時に 1 回だけ走らせ、失敗したら REBIND_RETRY_MS は試さない（再起動の直後に
  // 401 の連打で daemon を叩かない）。通ったら、新しいトークンに差し替える（購読は、入れ物の変更で張り直される）。
  let rebinding: Promise<boolean> | undefined;
  let lastRebindAt: number | undefined;
  store.setRecover(async () => {
    if (deps.markerNodeId === undefined) return false;
    if (rebinding !== undefined) return rebinding;
    if (lastRebindAt !== undefined && Date.now() - lastRebindAt < REBIND_RETRY_MS) return false;
    lastRebindAt = Date.now();
    const nodeId = deps.markerNodeId;
    rebinding = (async () => {
      const re = await rebindChild(childBindOptions(), nodeId);
      if (re?.ok !== true) {
        log({
          event: "childRebindFailed",
          ...(re?.ok === false ? { code: re.error.code } : {}),
          at: new Date().toISOString(),
        });
        return false;
      }
      const made = make({
        daemonUrl: endpoint.daemonUrl,
        identityPath: endpoint.identityPath,
        token: re.value.token,
      });
      if (!made.ok) return false;
      inner = made.value;
      store.set(re.value);
      log({ event: "childRebound", at: new Date().toISOString() });
      return true;
    })().finally(() => {
      rebinding = undefined;
    });
    return rebinding;
  });
  return createToolServer({
    role: "child",
    relay: unboundRelay,
    pending: true,
    bindChild: bind,
    credentials: store,
    onInboxProblems: createInboxProblemReporter({ log }),
  });
}

/**
 * 根のモードで、親の操作と購読に付ける session_id（`CLAUDE_CODE_SESSION_ID`）。形が合わない（daemon の検査で拒まれる）ときは
 * 付けない（記録しないだけ。親の操作そのものは通す）。
 */
export const sessionIdFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const sid = env.CLAUDE_CODE_SESSION_ID;
  return sid !== undefined && isSessionId(sid) ? sid : undefined;
};

export interface StdioStreams {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
}

/** `touryou-mcp --stdio` の本体。接続できたら、標準入出力で MCP を話す（標準入力が閉じたら、接続を閉じて 0 で終わる）。 */
export async function runStdio(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: StdioIo,
  deps: StdioDeps & { readonly streams?: StdioStreams } = {},
): Promise<number> {
  const report = (e: Failure): number => {
    io.stderr(
      `[touryou mcp] 失敗 [${e.code}]: ${e.cause}\n  次の操作: ${e.nextActions.join(" / ")}\n`,
    );
    return e.code === "invalid_config" ? 2 : 1;
  };
  // 開き方は、起動したときの作業ディレクトリの印で決める。子の作業ツリーなら、根のトークンを読まない。
  const mode = detectOpenMode((deps.cwd ?? (() => process.cwd()))(), deps.marker);
  let server: Server;
  // 知らせの購読: 子は資格情報の入れ物に従う（紐付けと購読で同じ入れ物を使う）。根のモードだけが根のトークンで購読する。
  let child: Parameters<typeof startNotifications>[4];
  if (mode.kind === "pending") {
    const endpoint = resolveDaemonEndpoint(argv, env, deps);
    if (!endpoint.ok) return report(endpoint.error);
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    const credentials = deps.credentials ?? createNodeCredentialStore();
    child = {
      credentials,
      endpoint: () => resolveDaemonEndpoint(argv, env, deps),
      ...(mode.nodeId === undefined ? {} : { markerNodeId: mode.nodeId }),
    };
    server = openPendingStdioSession(endpoint.value, io, {
      ...deps,
      credentials,
      ...(mode.nodeId === undefined ? {} : { markerNodeId: mode.nodeId }),
      ...(sessionId === undefined || sessionId === "" ? {} : { sessionId }),
    });
    io.stderr(`${JSON.stringify({ event: "stdioPendingBind", at: new Date().toISOString() })}\n`);
  } else {
    const target = resolveStdioTarget(argv, env, deps);
    if (!target.ok) return report(target.error);
    // 根のモード: 自分の session_id を、親の操作（node.bindCode）と根の購読に付ける（知らせの宛先）。
    const sessionId = sessionIdFromEnv(env);
    // plugin の場所: 子の起動の文に `--plugin-dir` を足すため、parent_request に添える。確かめは daemon が行う。
    const pluginRoot = env.CLAUDE_PLUGIN_ROOT;
    const rootDeps = {
      ...deps,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(pluginRoot === undefined || pluginRoot === "" ? {} : { pluginRoot }),
    };
    const session = await openStdioSession(target.value, io, rootDeps, () =>
      resolveStdioTarget(argv, env, deps),
    );
    if (!session.ok) return report(session.error);
    server = session.value;
  }
  const stdin = deps.streams?.stdin ?? process.stdin;
  const stdout = deps.streams?.stdout ?? process.stdout;
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  // SDK の StdioServerTransport は、標準入力の end・close で閉じないので、自分で閉じる。
  const end = () => {
    server.close().catch(() => {});
  };
  stdin.once("end", end);
  stdin.once("close", end);
  await server.connect(
    new StdioServerTransport(stdin as NodeJS.ReadStream, stdout as NodeJS.WriteStream),
  );
  io.stderr(`${JSON.stringify({ event: "stdioConnected", at: new Date().toISOString() })}\n`);
  const subscriber = startNotifications(argv, env, io, deps, child);
  await closed;
  subscriber?.stop();
  io.stderr(`${JSON.stringify({ event: "stdioClosed", at: new Date().toISOString() })}\n`);
  return 0;
}

/**
 * 知らせ（設計 6.3）: 自分のセッションに受信箱のソケットがあれば、自分のノードを購読し、出来事が来たら 1 行を書く。
 * ソケットがない環境（Desktop・古い版）では購読しない（受信箱と番の区切りのフックで拾う）。記録だけ残す。
 *
 * - 子（`credentials` を渡す）: 入れ物が空の間は購読しない。値が入ったら始め、変わったら張り直し、空になったら止める。
 *   トークンは入れ物からだけ取り、ファイル・環境変数からは読まない。
 * - 根（`credentials` なし）: 根のトークン（`resolveStdioTarget`）で、根のノードを購読する。ノードは `/v1/whoami` で引く。
 */
export function startNotifications(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: StdioIo,
  deps: StdioDeps = {},
  /**
   * 子のとき: 資格情報の入れ物と、接続先だけを返す関数（根のトークンを読まない。`resolveDaemonEndpoint` を渡す）。
   */
  child?: {
    readonly credentials: NodeCredentialStore;
    readonly endpoint: () => Result<{ readonly daemonUrl: string; readonly identityPath: string }>;
    /** 作業ツリーの印に書かれたノード（あれば、資格情報のノードと同じことを確かめる）。 */
    readonly markerNodeId?: string;
  },
): { stop(): void } | undefined {
  const log = (e: Record<string, unknown>) => io.stderr(`${JSON.stringify(e)}\n`);
  const socket = socketFromEnv(env);
  if (socket === undefined) {
    log({ event: "notifySocketMissing", at: new Date().toISOString() });
    return undefined;
  }
  const doFetch = deps.fetch ?? globalThis.fetch;
  const endpoint = (): Result<{ readonly daemonUrl: string; readonly identityPath: string }> =>
    child === undefined ? resolveStdioTarget(argv, env, deps) : child.endpoint();
  // 根: 接続先とトークンを読むだけ（ここではトークンを送らない。whoami は、身元を確かめたあとの `resolveNode`）。
  const rootTarget = async (): Promise<Result<SubscribeTarget>> => {
    const t = resolveStdioTarget(argv, env, deps);
    if (!t.ok) return t;
    return ok({ daemonUrl: t.value.daemonUrl, token: t.value.token });
  };
  const resolveNode = async (t: SubscribeTarget): Promise<Result<string>> => {
    try {
      const res = await doFetch(`${t.daemonUrl}/v1/whoami`, {
        headers: { authorization: `Bearer ${t.token}` },
      });
      const body = (await res.json()) as { ok?: boolean; value?: { nodeId?: unknown } };
      const nodeId = body.value?.nodeId;
      // 401 だけを「トークンが拒まれた」とする（購読は張り直しをやめる）。ほかは、張り直す。
      if (res.status === 401) {
        return fail("unauthenticated", "自分のノードを引けない", "資格情報を確かめる");
      }
      if (res.status !== 200 || typeof nodeId !== "string") {
        return fail("daemon_unreachable", "自分のノードを引けない", "daemon を確かめる");
      }
      return ok(nodeId);
    } catch {
      return fail("daemon_unreachable", START_DAEMON, "daemon を起動する");
    }
  };
  const start = (
    target: Parameters<typeof startNodeSubscriber>[0]["target"],
    initialSeq?: number,
    sessionId?: string,
    onAuthFailed?: () => void,
    authRetryMs?: number,
  ): NodeSubscriber =>
    startNodeSubscriber({
      ...(authRetryMs === undefined ? {} : { authRetryMs }),
      ...(onAuthFailed === undefined ? {} : { onAuthFailed }),
      ...(initialSeq === undefined ? {} : { initialSeq }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      log,
      target,
      resolveNode,
      verify: async (t) => {
        const ep = endpoint();
        if (!ep.ok) return false;
        const v = await createIdentityVerifier({
          daemonUrl: t.daemonUrl,
          identityPath: ep.value.identityPath,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          log,
        }).verify();
        return v.ok;
      },
      notify: async (seq, childIds) => {
        const r = await writeNotification(socket, notificationText(seq, childIds));
        if (r.written) log({ event: "notified", seq, at: new Date().toISOString() });
        return r.written ? { written: true } : { written: false, reason: r.reason };
      },
    });
  if (child === undefined) {
    // 根のモード: 自分の session_id を付けて購読する（自分あての出来事だけが届く）。
    // 401 でも止めない（根のトークンの入れ替え・状態の置き場の作り直しのあと、親の mcp を起動し直さずに戻れるように）。
    // 待ちは長く（AUTH_RETRY_MS）、記録は窓ごとに 1 回。
    return start(rootTarget, undefined, sessionIdFromEnv(env), undefined, AUTH_RETRY_MS);
  }
  const { credentials } = child;
  // 子: 入れ物に合わせて、始める・張り直す・止める。
  let current: NodeSubscriber | undefined;
  let currentNode: string | undefined;
  /** 最後に購読したノードと、その続きの seq（失効して空になっても残す。同じノードに紐付け直したら、続きから受ける）。 */
  let lastSeqKept: number | undefined;
  const follow = (c: ReturnType<NodeCredentialStore["get"]>): void => {
    lastSeqKept = current?.lastSeq ?? lastSeqKept;
    current?.stop();
    current = undefined;
    if (c === undefined) {
      log({ event: "subscribeWaitingForBind", at: new Date().toISOString() });
      return;
    }
    // 作業ツリーの印のノードと、資格情報のノードが違えば、購読しない（daemon の紐付けでも、作業ツリーを確かめている）。
    if (child.markerNodeId !== undefined && c.nodeId !== child.markerNodeId) {
      log({ event: "subscribeMarkerMismatch", at: new Date().toISOString() });
      return;
    }
    // 同じノードなら、前の購読の続きから（資格情報の更新・紐付け直しで「今より後」に戻らない）。違うノードなら、今より後から。
    const carried = c.nodeId === currentNode ? lastSeqKept : undefined;
    if (c.nodeId !== currentNode) lastSeqKept = undefined;
    currentNode = c.nodeId;
    current = start(
      async () => {
        const now = credentials.get();
        if (now === undefined) return fail("unauthenticated", "紐付けの前", "紐付けを済ませる");
        const ep = endpoint();
        if (!ep.ok) return ep;
        return ok({ daemonUrl: ep.value.daemonUrl, token: now.token, nodeId: now.nodeId });
      },
      carried,
      undefined,
      // 購読の口で 401 を受けたら、道具の口と同じく入れ物を空にする（以後の道具は紐付け待ちになる）。
      () => {
        credentials.reject(c.token).catch(() => undefined);
      },
    );
  };
  const off = credentials.onChange(follow);
  follow(credentials.get());
  return {
    stop() {
      off();
      current?.stop();
      current = undefined;
    },
  };
}
