/**
 * daemon の組み立て（コンポジションルート）。設定（`DaemonConfig`）と、外部への口（git の作業ツリー・エージェントの起動）を受けて、
 * ストア・イベントログ・認証・アダプタ・ハンドラ・窓口を結ぶ。
 *
 * - 状態の置き場（`stateDir`）は 0700。SQLite（`state.db`）・ノードのトークン（`node-tokens.json`、ハッシュだけ）・人間のトークン
 *   （`human-token`）・根のトークン（`root-token`）は、置き場の中に 0600 で置く。
 * - 身元の秘密（`daemon-identity`）は、`start()` のたびに作り直して、待ち受けの前に 0600 で書き、`stop()` で消す。窓口の `GET /v1/identity` が、
 *   秘密と待ち受けのポートから作った `proof` だけを返す（`docs/daemon-identity.md`）。
 * - 根のノード（`rootNodeId`。統合ノード）がなければ作って開始する。あれば、役割・親を確かめる（違えば起動を失敗させる）。
 *   根のトークンは、`root-token` がなければ発行して書く（あれば、保存済みのトークンが有効）。
 * - 起動に失敗する条件（置き場の権限・ストアの破損・根の不一致など）は、例外でなく `Failure` で返す（フェイルクローズ）。
 * - ポートの `cwdOf` は、根のノードだけ設定の `rootCwd` を返し、ほかはポートに任せる。
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  DEFAULT_PURGE_TOMBSTONE,
  type EventBody,
  effectiveScope,
  type Failure,
  failure,
  inboxMessage,
  isPathUnder,
  type Result,
  type ScopeViolationReason,
} from "@touryou/core";
import { createConfirmationGate } from "./api/confirmation-gate.js";
import { assertSecureDirectory, processUid, readSecureSecret } from "./api/fs-safety.js";
import { recoverAnswerDeliveries } from "./api/handlers/answer-delivery.js";
import { createBindHandlers, shellWord } from "./api/handlers/bind-handlers.js";
import { createBindWorktreeCheck } from "./api/handlers/cli-bind-check.js";
import { appendAtomically, deriveId, notice } from "./api/handlers/context.js";
import {
  createHookHandlers,
  createNeedsInputThrottle,
  reportNeedsInput,
  stopOutcome,
} from "./api/handlers/hook-handlers.js";
import { createInstructionDelivery } from "./api/handlers/instruction-delivery.js";
import { discardRemoveBodies, openRequestOf } from "./api/handlers/parent-request-handlers.js";
import { createPurger, type PurgeHandlerDeps } from "./api/handlers/purge-handlers.js";
import { createHookTokens, createSessionBinder, sessionActor } from "./api/hook.js";
import {
  createIdentity,
  IDENTITY_FILE,
  type Identity,
  removeIdentityFile,
  writeIdentityFile,
} from "./api/identity.js";
import {
  type ApiLogger,
  type BindCodes,
  createApiServer,
  createBindCodes,
  createCredentialStore,
  createDiscardedHandlers,
  createHandlersWithScheduler,
  DEFAULT_AUTH_FAILURE_BURST,
  DEFAULT_AUTH_FAILURE_PER_MINUTE,
  DEFAULT_PRINCIPAL_SPEC,
  FileRevokedStore,
  FileTokenRepository,
  loadOrCreateHumanToken,
  type ReclaimPorts,
  type SpawnPorts,
  type SummaryScheduler,
  type WorktreeFacts,
} from "./api/index.js";
import type { Handlers } from "./api/server.js";
import { createSessionBindings } from "./api/session-binding.js";
import {
  ALERT_ID_PREFIX,
  createApiAlert,
  DEFAULT_ALERT_INTERVAL_MINUTES,
  DEFAULT_ALERT_THRESHOLD,
  DEFAULT_RETIRED_ALERT_THRESHOLD,
} from "./api-alert.js";
import { createAutoPurger } from "./auto-purge.js";
import { removeBindCodeFile, writeBindCodeFile } from "./bind-code-file.js";
import {
  CHILD_DIR_NEEDED,
  ChildrenDirError,
  type ChildrenDirs,
  drawerActionFor,
  prepareChildrenDirs,
  safeCause as safeCauseOfChildrenDir,
} from "./children-dir.js";
import { boundInState, recordWatchFindings, type WatchCounts, watchFindings } from "./cli-watch.js";
import type { DaemonConfig } from "./config.js";
import { createDigestIssuer } from "./digest-issuer.js";
import { ownedBy } from "./discarded-keys.js";
import { EventLog } from "./eventlog.js";
import { withExternalCheckResolution } from "./external-check.js";
import type { GitPorts, LossFacts } from "./git-ports.js";
import {
  choosePort,
  PORT_FILE,
  portSaveFailed,
  readSavedPort,
  savedPortUnavailable,
  writeSavedPort,
} from "./port-file.js";
import { reconcileOnStartup } from "./reconcile.js";
import { latestLaunch, ParentRequestCliAdapter } from "./sdk/cli-adapter.js";
import { DesktopRuntimeAdapter, touryouChildCommands } from "./sdk/desktop-adapter.js";
import {
  decideToolUse,
  grantedBashByExtension,
  grantedOnlyByExtension,
  resolveScope,
  withRealWritePath,
} from "./sdk/hook-policy.js";
import { createLsofProbe, nodeExec, type ProcessProbe } from "./sdk/lsof-probe.js";
import { nodeTimers } from "./sdk/node-timers.js";
import { nodeFsOps, resolveForWrite } from "./sdk/path-resolve.js";
import type { PluginDirPorts } from "./sdk/plugin-dir.js";
import { isReadOnlySearch } from "./sdk/read-only-search.js";
import type { RuntimeAdapter, Timers } from "./sdk/runtime.js";
import { openSqliteStore } from "./sqlite-store.js";
import { createWaker } from "./wake.js";

/** 最終削除の保持期間の既定（日。spec 5.8）。 */
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_DIGEST_INTERVAL_SEC = 30;
const DEFAULT_DIGEST_MIN_INTERVAL_SEC = 60;
const DEFAULT_DIGEST_MAX_PER_RUN = 20;
const DEFAULT_WAKE_INTERVAL_SEC = 15;
const DEFAULT_WAKE_MIN_INTERVAL_SEC = 60;
const DEFAULT_WAKE_MAX_PER_RUN = 10;
const DEFAULT_AUTO_PURGE_INTERVAL_MINUTES = 60;
const DEFAULT_AUTO_PURGE_MAX_TREES = 2;
const DEFAULT_AUTO_PURGE_NOTICE_DAYS = 7;

/**
 * 子に付ける plugin の場所の確かめの入出力。realpath はディスクの綴りに直る `realpathSync.native`。
 * 断る根は、確かめのたびに realpath にし直す（`checkPluginDir`）。darwin・win32 では、大文字小文字をそろえて比べる。
 */
export const pluginDirPortsOf = (
  config: Pick<DaemonConfig, "repoRoot" | "worktreeRoot" | "stateDir">,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): PluginDirPorts => ({
  readFile: (p) => readFileSync(p, "utf8"),
  realpath: (p) => realpathSync.native(p),
  forbiddenRoots: [config.repoRoot, config.worktreeRoot, config.stateDir, join(home, ".touryou")],
  foldCase: platform === "darwin" || platform === "win32",
});

/** git の作業ツリーに関わる口（実装は git を呼ぶ。テストはフェイク）。 */
export interface WorktreePorts {
  factsFor(nodeId: string): Promise<WorktreeFacts | undefined>;
  /** 強制の回収で失われるもの（省略すると、回収の事前確認に `loss` を出さない）。 */
  lossFor?(nodeId: string): Promise<LossFacts | undefined>;
  removeWorktree(
    nodeId: string,
    opts: {
      expectedPath: string;
      force?: boolean;
      onTip?: (tip: string, ref?: string) => void;
    },
  ): Promise<Result<undefined, Failure>>;
  /** 保管している、破棄した成果。省略すると、保管の操作（`node.discarded*`）と最終削除での掃除は無効（`notSupported`）。 */
  discardedList?: GitPorts["discardedList"];
  discardedKeyOf?: GitPorts["discardedKeyOf"];
  discardedRestore?: GitPorts["discardedRestore"];
  discardedDrop?: GitPorts["discardedDrop"];
  discardedDeleteFor?: GitPorts["discardedDeleteFor"];
  provisionWorktree(req: {
    parentId: string;
    nodeId: string;
  }): Promise<Result<{ worktreePath: string }, Failure>>;
  /** 根以外のノードの作業ツリー（実パス）。 */
  cwdOf(nodeId: string): Promise<string | undefined>;
  /** 子のブランチを親のブランチへ fast-forward で統合する。省略すると `node.integrate` は `notSupported`。 */
  integrate?: GitPorts["integrate"];
}

export interface DaemonDeps {
  /**
   * CLI の子のアダプタ（試験で差し込む）。既定は、親への依頼の形（`ParentRequestCliAdapter`）。差し込むと、紐付けの
   * コードのファイル（出し直し・使われたときの削除）は扱わない。
   */
  readonly cliAdapter?: RuntimeAdapter & { has(nodeId: string): boolean };
  readonly worktree: WorktreePorts;
  /** プロセスの調査。既定は `lsof`。 */
  readonly probe?: ProcessProbe;
  readonly clock?: () => string;
  /** 単調時計（ミリ秒）。トークンの期限の経過に使う。既定 `performance.now`。試験で差し込む。 */
  readonly monoMs?: () => number;
  /**
   * 見張りの設定に、変更できない印を付ける・外す（既定は macOS の `/usr/bin/chflags uchg|nouchg`。ほかの OS では何もしない）。
   * 試験で差し替える（印が付くと、試験から書き換え・片付けができないため）。
   */
  readonly setImmutable?: (file: string, on: boolean) => Promise<void>;
  readonly timers?: Timers;
  /** 起動オプション `--port` の値（1〜65535）。設定の `port` より優先する（`port-file.ts`）。 */
  readonly port?: number;
  /** 新規のポートの保存（既定は `writeSavedPort`。試験で、保存の失敗を差し替える）。 */
  readonly savePort?: (path: string, port: number) => void;
  /** 単調時計（ミリ秒）。既定は `process.hrtime`。自動の最終削除が、時計が飛んだことを検知するのに使う（試験で差し替える）。 */
  readonly monotonicMs?: () => number;
  /** 窓口の件数のまとめを、窓の終わりに出す予約（試験で差し替える。既定は、`unref` したタイマー）。 */
  readonly summaryScheduler?: SummaryScheduler | null;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** 子の引き出しの置き場を Time Machine から外す処理（既定は macOS の `tmutil addexclusion`。試験で差し替える）。 */
  readonly excludeFromBackup?: (path: string) => Promise<void>;
  /** daemon の設定ファイルのパス（`--config`）。読み取りも禁じる場所に入れる（FR_014 の例外）。 */
  readonly configPath?: string;
  /** 運用の記録（1 行の JSON。秘密を含めない）。既定は標準エラー。 */
  readonly logLine?: (line: string) => void;
  /**
   * 取り消せない操作の確認コードを書く先（Desktop の木だけ）。既定は制御端末（/dev/tty）。標準エラー（構造化のログ）・
   * 記録・ファイルには書かない。書けなければ例外を投げる（確認待ちを作らない。試験で差し替える）。
   */
  readonly confirmationOut?: (line: string) => void;
  /**
   * 最終削除の後に、イベントログの追記のみの保証を確かめられなかったとき（以降の書き込みは拒否される）に呼ぶ。
   * 呼び出し側は daemon を止める（fail closed）。記録（`fatal`）は、これとは別に残す。
   */
  readonly onFatal?: (cause: string) => void;
  /** 試験用: SQLite のストアの試験用フック（最終削除の後のトリガーの確認の失敗を再現する）。 */
  readonly storeHooks?: Parameters<typeof openSqliteStore>[1];
}

export interface RunningDaemon {
  readonly port: number;
  readonly url: string;
  /** 人間のトークンのファイル（0600）。トークンそのものは、ログに出さない。 */
  readonly humanTokenPath: string;
  /** 根の統合ノードのトークンのファイル（0600）。 */
  readonly rootTokenPath: string;
  /** 身元の秘密のファイル（0600。起動ごとに作り直す。停止で消える。`docs/daemon-identity.md`）。 */
  readonly identityPath: string;
}

export interface Daemon {
  start(): Promise<RunningDaemon>;
  stop(): Promise<void>;
  /** テスト・診断用: イベントログ。 */
  readonly log: EventLog;
  /** テスト・診断用: トークンの期限の見回りを、今すぐ 1 回行う（定期の見回りと同じ。失効させたノードの ID）。 */
  sweepTokens(): string[];
  /** CLI の子の見張りを 1 回まわす（試験用）。受信箱に出した件数を返す。 */
  runCliWatch(): number;
}

/** 範囲違反の受信箱の要約。違反はフックが拒んだときだけ記録するので、拒んだことをはっきり言う（Issue #6）。 */
export const violationSummary = (reason: string, subject: string): string =>
  inboxMessage("violation", { reason, subject }).summary;
/** 受信箱に出す違反の上限を超えたときの要約。 */
export const VIOLATION_OVERFLOW_SUMMARY = inboxMessage("violationOverflow", {}).summary;

const fail = (code: string, cause: string, ...next: [string, ...string[]]) => ({
  ok: false as const,
  error: failure(code, cause, ...next),
});

function prepareStateDir(dir: string): Failure | undefined {
  try {
    let exists = true;
    try {
      lstatSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      exists = false;
    }
    if (!exists) mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertSecureDirectory(dir, processUid());
    // 認証情報・状態を置くので、グループ・他者の権限を一切許さない（0700）。
    const mode = lstatSync(dir).mode;
    if ((mode & 0o077) !== 0) {
      throw new Error(`権限が緩い（${(mode & 0o777).toString(8)}）。0700 にする`);
    }
    return undefined;
  } catch (e) {
    return failure(
      "stateDirInvalid",
      `状態の置き場 ${dir} を使えない（${String(e instanceof Error ? e.message : e)}）`,
      "置き場を、自分だけが書ける 0700 のディレクトリにする",
    );
  }
}

/** 作ったタイマーを覚えておき、止めるときにまとめて取り消す。 */
export function trackTimers(base: Timers): { timers: Timers; cancelAll(): void } {
  const pending = new Set<() => void>();
  return {
    timers: {
      now: () => base.now(),
      sleep: (ms) => base.sleep(ms),
      after(ms) {
        const t = base.after(ms);
        const cancel = (): void => {
          pending.delete(cancel);
          t.cancel();
        };
        pending.add(cancel);
        void t.promise.then(() => pending.delete(cancel));
        return { promise: t.promise, cancel };
      },
    },
    cancelAll() {
      for (const c of [...pending]) c();
    },
  };
}

/** 置き場が、リンクを解決した実パスで、互いに重なっていないか。 */
function realOverlap(config: DaemonConfig): string | undefined {
  // まだないパスも、最も深い既存の祖先を実パスにして、残りを足して比べる（resolveForWrite と同じ考え方）。
  const real = (p: string): string => {
    let head = p;
    const rest: string[] = [];
    for (;;) {
      try {
        const r = realpathSync(head);
        return rest.length === 0 ? r : join(r, ...rest.reverse());
      } catch {
        const parent = dirname(head);
        if (parent === head) return p;
        rest.push(basename(head));
        head = parent;
      }
    }
  };
  const s = real(config.stateDir);
  const r = real(config.repoRoot);
  const w = real(config.worktreeRoot);
  // APFS は大文字小文字・Unicode の正規化の違いを区別しないので、そろえてから比べる（区別する FS では、厳しめに倒れる）。
  const f = (x: string): string => x.normalize("NFC").toLowerCase();
  const o = (a: string, b: string): boolean => isPathUnder(f(a), f(b)) || isPathUnder(f(b), f(a));
  if (o(s, w) || o(s, r) || o(w, r)) {
    return "stateDir・repoRoot・worktreeRoot が、リンクを解決すると重なる";
  }
  return undefined;
}

/**
 * 設定から、窓口の回数の制限・接続・処理中の重複の扱いの deps を作る。省略した項目は、窓口の既定のまま
 * （`connection`・`inProgress` は、設定にあるときだけ渡す）。
 */
export function apiLimitsOf(
  config: DaemonConfig,
  monotonicMs?: () => number,
  summaryScheduler?: SummaryScheduler | null,
): Pick<Parameters<typeof createApiServer>[0], "rateLimit" | "connection" | "inProgress"> {
  return {
    rateLimit: {
      perPrincipal: {
        burst: config.rateLimit?.perPrincipal?.burst ?? DEFAULT_PRINCIPAL_SPEC.burst,
        perSecond: config.rateLimit?.perPrincipal?.perSecond ?? DEFAULT_PRINCIPAL_SPEC.perSecond,
      },
      authFailures: {
        burst: config.rateLimit?.authFailures?.burst ?? DEFAULT_AUTH_FAILURE_BURST,
        perSecond:
          (config.rateLimit?.authFailures?.perMinute ?? DEFAULT_AUTH_FAILURE_PER_MINUTE) / 60,
      },
      ...(config.rateLimit?.maxKeys === undefined ? {} : { maxKeys: config.rateLimit.maxKeys }),
      ...(config.rateLimit?.maxInFlightPerPrincipal === undefined
        ? {}
        : { maxInFlightPerPrincipal: config.rateLimit.maxInFlightPerPrincipal }),
      ...(monotonicMs === undefined ? {} : { monotonicMs }),
      ...(summaryScheduler === undefined ? {} : { summaryScheduler }),
    },
    ...(config.connection === undefined ? {} : { connection: config.connection }),
    ...(config.inProgress === undefined ? {} : { inProgress: config.inProgress }),
  };
}

/**
 * 確認のコードを、制御端末（/dev/tty）に直接書く。標準エラー（構造化のログ）に書くと、`2> file` でファイルに残るため。
 * 開けない（端末なしで動いている）ときは例外（確認待ちを作らない）。
 */
const writeControllingTerminal = (line: string): void => {
  const fd = openSync("/dev/tty", "w");
  try {
    writeSync(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
};

/** トークンの期限の見回りの間隔。 */
const TOKEN_SWEEP_MS = 5 * 60_000;

/**
 * ノードのトークンが、もう要らない状態か（種類〔sdk・bind〕を問わない。認証・見回りのたびに見る）。記録にないノードも
 * 要らない。done は残す（差し戻しで動き直す）。
 */
export const TOKEN_RETIRED_STATES: ReadonlySet<string> = new Set([
  "verified",
  "reclaimable",
  "archived",
]);
export const isTokenRetired = (state: string | undefined): boolean =>
  state === undefined || TOKEN_RETIRED_STATES.has(state);
/**
 * その状態に**なったとき**に、トークンを失効させる状態。stopped は、なったときだけ見る（再開は、止まったまま新しい
 * トークンを発行してから起動し、running を記録するので、止まっていることだけで失効させると、再開のトークンを消してしまう）。
 */
/**
 * CLI の子（SSE の購読で指示を受け取る子）か。トークンの種類（sdk・bind）では見ない: CLI の子も
 * child_bind（`/v1/bind`）で kind "bind" のトークンを受けるため。設定の childRuntime が desktop でなく、木の子（根でない）なら真。
 */
export const isCliChildOf = (
  childRuntime: string | undefined,
  state: { readonly nodes: readonly { readonly id: string; readonly parentId: string | null }[] },
  nodeId: string,
): boolean =>
  childRuntime !== "desktop" && state.nodes.some((n) => n.id === nodeId && n.parentId !== null);

export const TOKEN_REVOKE_ON_ENTER: ReadonlySet<string> = new Set([
  "stopped",
  ...TOKEN_RETIRED_STATES,
]);

export function createDaemon(config: DaemonConfig, deps: DaemonDeps): Result<Daemon, Failure> {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const logLine = deps.logLine ?? ((line: string) => process.stderr.write(`${line}\n`));
  const note = (event: string, fields: Record<string, unknown> = {}): void => {
    try {
      logLine(JSON.stringify({ at: clock(), event, ...fields }));
    } catch {
      // 記録先の失敗は、処理を止めない
    }
  };
  // 外した設定の項目は、名前だけを 1 行で記録する（値は出さない）
  if (config.ignoredLegacyKeys !== undefined && config.ignoredLegacyKeys.length > 0) {
    note("legacyConfigIgnored", { keys: [...config.ignoredLegacyKeys] });
  }

  const dirProblem = prepareStateDir(config.stateDir);
  if (dirProblem !== undefined) return { ok: false, error: dirProblem };
  const overlap = realOverlap(config);
  if (overlap !== undefined) {
    return fail("invalidConfig", `設定が不正: ${overlap}`, "置き場を、重ならない別の場所にする");
  }
  // 読み取りも禁じる場所（FR_014 の例外）。起動時に実パスにして、全ノード共通で使う。
  // 子の引き出しの置き場。違っていれば、直さずに起動を止める（理由に実パスを出さない）。
  let childrenDirs: ChildrenDirs;
  try {
    childrenDirs = prepareChildrenDirs(config.stateDir, {
      ...(deps.excludeFromBackup === undefined ? {} : { exclude: deps.excludeFromBackup }),
      onWarning: (cause) => note("childrenDirWarning", { cause }),
    });
  } catch (e) {
    const recovery = e instanceof ChildrenDirError ? e.recovery : [];
    const next = (
      recovery.length > 0
        ? recovery
        : [
            "状態の置き場の children.noindex・children.key を確かめる（自分のもの・0700／0600・リンクでない）",
          ]
    ) as [string, ...string[]];
    return fail(
      "stateDirInvalid",
      `子の引き出しの置き場を使えない（${safeCauseOfChildrenDir(e)}）`,
      ...next,
    );
  }
  const protectedStateDir = realpathSync(config.stateDir);
  const protectedRoots: { path: string; kind: "stateDir" | "daemonConfig" }[] = [
    { path: protectedStateDir, kind: "stateDir" },
  ];
  if (deps.configPath !== undefined) {
    try {
      protectedRoots.push({ path: realpathSync(deps.configPath), kind: "daemonConfig" });
    } catch {
      protectedRoots.push({ path: deps.configPath, kind: "daemonConfig" });
    }
  }

  /** 今ある一番深い祖先を実パスにし、ない部分を足す（~/.claude がまだなくても、HOME がリンクならずれる。macOS の /var）。 */
  const realDeep = (p: string): string => {
    const rest: string[] = [];
    let head = resolvePath(p);
    for (;;) {
      try {
        return join(realpathSync(head), ...rest);
      } catch {
        const parent = dirname(head);
        if (parent === head) return resolvePath(p);
        rest.unshift(basename(head));
        head = parent;
      }
    }
  };
  /**
   * 見張りが守る「利用者の設定のディレクトリ」。`~/.claude`（常に）、daemon の環境の `CLAUDE_CONFIG_DIR`（あれば）、
   * 設定 `claudeConfigDirs`、Desktop の子のフック入力の `transcript_path` から分かった場所。Desktop の子の環境は daemon には
   * 見えないので、ありうる場所をすべて守る。値は実パス（`..` もそろえる）で持ち、重なりは実パスで 1 つにまとめる。
   * 記録には、場所そのものは書かない（NFR_012）。
   */
  const claudeConfigDirs: string[] = [];
  const addConfigDir = (dir: string): boolean => {
    const real = realDeep(dir);
    if (claudeConfigDirs.includes(real)) return false;
    claudeConfigDirs.push(real);
    return true;
  };
  {
    const env = deps.parentEnv ?? process.env;
    const homeDir = env.HOME;
    if (homeDir !== undefined) addConfigDir(join(homeDir, ".claude"));
    const envDir = env.CLAUDE_CONFIG_DIR;
    if (envDir !== undefined && envDir !== "") {
      if (isAbsolute(envDir)) addConfigDir(envDir);
      else
        note("claudeConfigDirWarning", {
          source: "CLAUDE_CONFIG_DIR",
          cause: "相対パスなので使わない",
        });
    }
    (config.claudeConfigDirs ?? []).forEach((d, index) => {
      if (!existsSync(d)) {
        note("claudeConfigDirWarning", { source: "claudeConfigDirs", index, cause: "存在しない" });
      }
      addConfigDir(d);
    });
    // 作業ツリーそのもの・その祖先・その配下が、利用者の設定の場所なら知らせる（子が書ける場所と重なる）
    const wtRoot = realDeep(config.worktreeRoot);
    const overlaps = (a: string, b: string) => a === b || b.startsWith(`${a}/`);
    claudeConfigDirs.forEach((d, index) => {
      if (overlaps(d, wtRoot) || overlaps(wtRoot, d)) {
        note("claudeConfigDirWarning", {
          index,
          cause: "利用者の設定の場所が、作業ツリー（worktreeRoot）と重なる",
        });
      }
    });
  }
  /** 守る利用者の設定ファイル（各ディレクトリの settings.json・settings.local.json）。 */
  const userSettingsFiles = (): string[] =>
    claudeConfigDirs.flatMap((d) =>
      ["settings.json", "settings.local.json"].map((f) => join(d, f)),
    );

  // SQLite のファイル（state.db・-wal・-shm）が、他のユーザーから読めないよう、作る間は umask を 077 にする。
  const previousUmask = process.umask(0o077);
  let opened: ReturnType<typeof openSqliteStore>;
  try {
    opened = openSqliteStore(join(config.stateDir, "state.db"), deps.storeHooks);
  } finally {
    process.umask(previousUmask);
  }
  if (!opened.ok) return opened;
  const store = opened.value;
  let fatalSeen = false;
  const logOpened = EventLog.open(store, {
    clock,
    verifySnapshot: true,
    onSnapshotMismatch: () => note("snapshotMismatch"),
    onFatal: (cause) => {
      fatalSeen = true;
      note("fatal", { cause });
      deps.onFatal?.(cause);
    },
  });
  if (!logOpened.ok) {
    store.close();
    return logOpened;
  }
  const log = logOpened.value;
  /** 起動の時点（整合などでログに書く前）の、最後の記録の時刻。自動の最終削除が、止まっていた時間を検知する。 */
  const startupLastEventAt = log.lastEventAt();
  const closeAll = (): void => {
    try {
      store.close();
    } catch {
      // すでに閉じている
    }
  };

  // 根のノード: なければ作って開始し、起動前（pending）なら開始を記録する。起動できない状態・根でないノードなら失敗する。
  const rootMismatch = (why: string) => {
    closeAll();
    return fail(
      "rootNodeMismatch",
      `ノード ${config.rootNodeId} を、根の統合ノードとして使えない（${why}）`,
      "rootNodeId を、根のノードの ID にする",
      "別の置き場（stateDir）を使う",
    );
  };
  const rootEvent = (requestId: string, body: EventBody): Failure | undefined => {
    const r = log.append({ requestId, actor: { system: true }, body });
    return r.ok ? undefined : r.error;
  };
  const existing = log.state().nodes.find((n) => n.id === config.rootNodeId);
  if (existing === undefined) {
    const err =
      rootEvent("bootstrap-root-created", {
        type: "node.created",
        payload: { nodeId: config.rootNodeId, role: "integrator", parentId: null, dependsOn: [] },
      }) ??
      rootEvent("bootstrap-root-started", {
        type: "node.stateChanged",
        payload: { nodeId: config.rootNodeId, event: { type: "start" } },
      });
    if (err !== undefined) {
      closeAll();
      return fail(
        "bootstrapFailed",
        `根のノード ${config.rootNodeId} を作れない（${err.code}）`,
        "ストアの状態を確認する",
      );
    }
  } else if (existing.role !== "integrator" || existing.parentId !== null) {
    return rootMismatch(`役割: ${existing.role}`);
  } else if (existing.state === "pending") {
    // 作成の記録のあと、開始の前に止まっていた。
    const err = rootEvent("bootstrap-root-started", {
      type: "node.stateChanged",
      payload: { nodeId: config.rootNodeId, event: { type: "start" } },
    });
    if (err !== undefined) return rootMismatch(`開始を記録できない: ${err.code}`);
  } else if (existing.state !== "running" && existing.state !== "waiting") {
    return rootMismatch(`状態: ${existing.state}`);
  }

  // フックの受け口の session_id の結び付け。トークンを発行し直した・失効させたら外す。
  const hookSessions = createSessionBinder();
  // 手動の CLI セッション用の、フック専用のトークン。CLI の子のときだけ。ノードのトークンが変わったら、一緒に無効にする。
  const minutes = (m: number | undefined, d: number): number => (m ?? d) * 60_000;
  const te = config.tokenExpiryMinutes;
  // フック専用のトークン。CLI の手動のセッション（touryou hook-env）と、Desktop の子（引き出しの hook-token）で使う
  const hookTokens: ReturnType<typeof createHookTokens> | undefined = createHookTokens({
    maxAgeMs: minutes(te?.hookAbsolute, 1440),
    ...(deps.monoMs === undefined ? {} : { nowMs: deps.monoMs }),
  });
  // 認証。
  let humanToken: string;
  // トークンの期限: ノードの状態と、期限切れの受信箱への知らせ（同じトークンについて 1 回だけ。要求 ID を、ノードと
  // 発行の時刻から決めるので、重ねて書かれない）。記録にはトークン・ハッシュを書かない。
  const tokenStateOf = (nodeId: string): string | undefined =>
    log.state().nodes.find((n) => n.id === nodeId)?.state;
  const notifyTokenExpired = (
    nodeId: string,
    reason: "absolute" | "idle",
    kind: "sdk" | "bind",
    issuedAt: string,
  ): void => {
    const key = `token-expired/${nodeId}/${issuedAt}`;
    const key2 =
      kind === "bind"
        ? reason === "absolute"
          ? "tokenExpiredAbsoluteBind"
          : "tokenExpiredIdleBind"
        : reason === "absolute"
          ? "tokenExpiredAbsolute"
          : "tokenExpiredIdle";
    const r = appendAtomically(log, clock, key, { system: true }, [
      {
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", key, "token-expired"),
          kind: "info",
          nodeId,
          ...notice(key2, { node: nodeId }),
        },
      },
    ]);
    if (!r.ok) note("tokenExpiredNoticeFailure", { nodeId, cause: r.error.code });
  };
  let credentials: ReturnType<typeof createCredentialStore>;
  // 退役（役目の終わりでの失効）を、ノードの購読へ知らせる（`retired` を送って閉じる。sse-hub は server の中で作られるので、
  // `onSseHub` であとから結ぶ）。
  let sseRetire: ((nodeId: string) => void) | undefined;
  const rootTokenPath = join(config.stateDir, "root-token");
  const humanTokenPath = join(config.stateDir, "human-token");
  try {
    humanToken = loadOrCreateHumanToken(humanTokenPath).token;
    credentials = createCredentialStore({
      humanToken,
      repository: new FileTokenRepository(join(config.stateDir, "node-tokens.json")),
      // 失効の印を保存する（起動し直しのあとも expired と返す）。守りは台帳と同じ（0600・ACL）。
      revokedStore: new FileRevokedStore(join(config.stateDir, "revoked-tokens.json"), {
        nowMs: () => Date.parse(clock()),
        onCorrupt: (cause) => note("revokedStoreCorrupt", { cause }),
      }),
      clock,
      // 起動時の基準は壁時計（保存した時刻と比べる）。動いている間の経過は単調時計で数える（巻き戻しで延びない）
      nowMs: () => Date.parse(clock()),
      monoMs: deps.monoMs ?? (() => performance.now()),
      onNodeTokenChanged: (nodeId) => {
        // Desktop の子のフック専用のトークンは、bind（ノードのトークンの発行）では変えない（フックは bind より前から動く。
        // 止まった・役目の終わった・期限切れは、下の revokeEntered と、引き出しの片付けで失効させる）
        if (config.childRuntime !== "desktop") hookTokens?.revoke(nodeId);
        if (hookSessions.unbind(nodeId)) note("hookUnbound", { reason: "tokenReissued" });
      },
      // トークンの期限。根には付けない。
      expiry: {
        sdkIdleMs: minutes(te?.sdkIdle, 360),
        sdkAbsoluteMs: minutes(te?.sdkAbsolute, 10_080),
        bindAbsoluteMs: minutes(te?.bindAbsolute, 1440),
        bindIdleMs: minutes(te?.bindIdle, 60),
      },
      exemptNodeId: config.rootNodeId,
      // 役目の終わり: verified・reclaimable・archived（記録にないノードも）。種類を問わない。stopped は、なったときに失効させる
      // （下の onCommitted と、起動時）。
      isRetired: (nodeId) => isTokenRetired(tokenStateOf(nodeId)),
      // 判断待ち・done のあいだは、使わなければ切れる時計を進めない（bind の絶対の期限は進む）
      isIdlePaused: (nodeId) => {
        const n = tokenStateOf(nodeId);
        return n === "waiting" || n === "done";
      },
      onExpired: (nodeId, reason, kind, issuedAt) => {
        note("tokenExpired", { nodeId, reason, kind });
        // 退役なら、購読に `retired` を送って閉じる（heartbeat を待たない。子の mcp は張り直さない）。退役でない失効は、今のまま。
        if (reason === "retired") sseRetire?.(nodeId);
        // 知らせは、まだ役目のある子（running・waiting・done）についてだけ（役目の終わり・止まった子は、知らせても次の操作がない）
        const st = tokenStateOf(nodeId);
        if (reason !== "retired" && (st === "running" || st === "waiting" || st === "done")) {
          notifyTokenExpired(nodeId, reason, kind, issuedAt);
        }
      },
    });
    // 止まった・役目の終わった子のトークンを、その状態になったその場で失効させる（見回りを待たない。種類を問わない）。
    // 起動時は、いま止まっている子のトークンも失効させる（前回、止まったあとに失効させられなかった分。再開で発行し直す）。
    const live = credentials;
    const desktopTree = config.childRuntime === "desktop";
    const lastStates = new Map<string, string>();
    const revokeEntered = (
      nodes: readonly { id: string; state: string; parentId: string | null }[],
      boot: boolean,
    ): void => {
      for (const n of nodes) {
        const prev = lastStates.get(n.id);
        lastStates.set(n.id, n.state);
        // Desktop の子の引き出し: 作る・中のファイルを消す・引き出しを消す
        if (desktopTree && n.parentId !== null) {
          const action = drawerActionFor(prev, n.state, boot);
          try {
            if (action === "create") {
              childrenDirs.reset(n.id);
              childrenDirs.writeFile(n.id, "node", n.id);
              // フック専用のトークン（子のフック〔touryou child hook〕が読む。最初の道具の呼び出しから効く）
              childrenDirs.writeFile(n.id, "hook-token", hookTokens.issue(n.id));
            } else if (action === "clearSecrets") {
              childrenDirs.removeFiles(n.id, ["token", "url", "code", "report", "hook-token"]);
            } else if (action === "remove") {
              childrenDirs.remove(n.id);
            }
          } catch (e) {
            note("childrenDirWarning", {
              cause: `引き出しを${action === "create" ? "作れない" : "片付けられない"}（${safeCauseOfChildrenDir(e)}）`,
            });
          }
        }
        if (prev === n.state || !TOKEN_REVOKE_ON_ENTER.has(n.state)) continue;
        if (desktopTree) hookTokens.revoke(n.id);
        try {
          live.expireNode?.(n.id);
        } catch (e) {
          note("tokenRevokeFailure", {
            nodeId: n.id,
            cause: e instanceof Error ? e.name : "unknown",
          });
        }
      }
    };
    revokeEntered(log.state().nodes, true);
    log.onCommitted((st) => {
      // 状態にないノード（最終削除で消えた）は、前の状態を忘れる（同じ実行で ID が再び使われたら、新しいノードとして作り直す）
      if (lastStates.size > st.nodes.length) {
        const live = new Set(st.nodes.map((n) => n.id));
        for (const id of [...lastStates.keys()]) if (!live.has(id)) lastStates.delete(id);
      }
      revokeEntered(st.nodes, false);
    });
    // 根のトークン: ファイルがあり、認証に通るならそのまま。なければ・通らなければ、発行し直して、一時ファイルに書いてから置き換える。
    let current: string | undefined;
    try {
      current = readSecureSecret(rootTokenPath, processUid()).trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        // 権限が緩い・リンクなど。信用せず、発行し直す（古いトークンは無効になる）。
        note("rootTokenReissued", { reason: "ファイルが使えない" });
      }
    }
    const who = current === undefined ? undefined : credentials.authenticate(current);
    const valid =
      who !== undefined &&
      who.role === "integrator" &&
      "nodeId" in who &&
      who.nodeId === config.rootNodeId;
    if (!valid) {
      const token = credentials.issueNodeToken(config.rootNodeId, "integrator");
      const tmp = `${rootTokenPath}.tmp-${randomBytes(6).toString("hex")}`;
      writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
      renameSync(tmp, rootTokenPath);
    }
  } catch (e) {
    closeAll();
    return fail(
      "credentialsFailed",
      `認証情報を用意できない（${String(e instanceof Error ? e.message : e)}）`,
      "stateDir のファイルの権限・内容を確認する",
    );
  }

  // ストアにないノード（最終削除で消えた木など）のトークンは、無効にする（削除の途中で止まったときの残りを含む）。
  const known = new Set(log.state().nodes.map((n) => n.id));
  for (const id of credentials.nodeIds()) {
    if (known.has(id)) continue;
    try {
      credentials.revokeNode(id);
      note("orphanTokenRevoked", { nodeId: id });
    } catch (e) {
      note("orphanTokenRevokeFailed", { nodeId: id, cause: String(e) });
    }
  }

  const probe = deps.probe ?? createLsofProbe(nodeExec);
  const tracked = trackTimers(deps.timers ?? nodeTimers);
  const timers = tracked.timers;
  // 紐付けのコード（一度きり・10 分・メモリだけ）。CLI の子の起動の依頼（ファイルに写す）と、紐付けの窓口で共有する。
  const bind: BindCodes = createBindCodes();
  // CLI の子: 起動は親への依頼。コードは作業ツリーの git のディレクトリのファイルに写す（依頼の文にはコードを入れない）。
  const parentAdapter =
    deps.cliAdapter === undefined
      ? new ParentRequestCliAdapter({
          log,
          clock,
          bind,
          writeCodeFile: (worktree, code) => {
            writeBindCodeFile(worktree, code);
          },
          removeCodeFile: (worktree) => {
            removeBindCodeFile(worktree);
          },
          // 2 段の停止: 猶予の間、作業ツリーのプロセスを調べる
          probe,
          timers,
        })
      : undefined;
  const cliAdapter: RuntimeAdapter & { has(nodeId: string): boolean } =
    deps.cliAdapter ?? (parentAdapter as ParentRequestCliAdapter);
  // 止まった・役目の終わった CLI の子の、紐付けのコードとファイルを片付ける。
  if (parentAdapter !== undefined && config.childRuntime !== "desktop") {
    const seen = new Map<string, string>();
    log.onCommitted((st) => {
      for (const n of st.nodes) {
        const prev = seen.get(n.id);
        seen.set(n.id, n.state);
        if (prev === n.state || !TOKEN_REVOKE_ON_ENTER.has(n.state)) continue;
        const launch = latestLaunch(st, n.id);
        if (launch !== undefined) parentAdapter.discardCode(n.id, launch.worktree, true);
      }
      // 人間が破棄を決めたノードで、削除（claude rm）が拒まれたままなら、旗つきの削除を依頼し直す
      // 追記の通知の中では追記しない（入れ子を避ける）。次の小さな仕事で、その時点の記録から決め直す
      if (
        st.nodes.some((n) => n.discarded !== undefined && discardRemoveBodies(st, n.id).length > 0)
      ) {
        queueMicrotask(() => {
          const now = log.state();
          for (const n of now.nodes) {
            if (n.discarded === undefined) continue;
            const bodies = discardRemoveBodies(now, n.id);
            if (bodies.length === 0) continue;
            const r = appendAtomically(
              log,
              clock,
              `discard-remove-${n.id}-${n.discarded.seq}`,
              { system: true },
              bodies,
            );
            if (!r.ok) note("discardRemoveRequestFailure", { nodeId: n.id, cause: r.error.code });
          }
        });
      }
    });
  }
  // 紐付けのやり直し: コードが無効（daemon の再起動でメモリから消えた・期限切れ）で失敗した、起動の依頼のある動いている子を、
  // 受信箱に出す（親が node.bindCode で出し直す）。bind の窓口は認証の前で、手元のどのプロセスでも呼べるので、偽の知らせを絞る:
  // - 期限内のコードが残っている（打ち間違い・でたらめなコード）ときは出さない。コードがメモリにないときだけ（再起動・期限切れ）。
  // - そのノードが、もう紐付けてある（有効なトークンがある）ときは出さない。
  // - 同じ子には、10 分に 1 件まで（出し直したら数え直す）。
  const REBIND_NOTICE_MS = 10 * 60_000;
  const rebindNoticedAt = new Map<string, number>();
  const noticeRebind = (nodeId: string): void => {
    // 間引きは単調な時計で測る（壁時計の巻き戻しで、間引きが外れたり延びたりしないように）
    const nowMs = (deps.monoMs ?? (() => performance.now()))();
    const last = rebindNoticedAt.get(nodeId);
    if (
      parentAdapter === undefined ||
      (last !== undefined && nowMs - last < REBIND_NOTICE_MS) ||
      bind.outstanding?.(nodeId) === true ||
      credentials.hasBindToken?.(nodeId) === true
    )
      return;
    const st = log.state();
    const node = st.nodes.find((n) => n.id === nodeId);
    const launch = latestLaunch(st, nodeId);
    if (node === undefined || launch === undefined) return;
    if (node.state !== "running" && node.state !== "waiting") return;
    rebindNoticedAt.set(nodeId, nowMs);
    const key = `rebind/${nodeId}/${launch.requestRef}/${st.lastSeq}`;
    const r = appendAtomically(log, clock, key, { system: true }, [
      {
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", key, "rebind"),
          kind: "failure",
          nodeId,
          ...notice("rebind", { node: nodeId }),
        },
      },
    ]);
    if (!r.ok) note("rebindNoticeFailure", { nodeId, cause: r.error.code });
  };
  // 起動時: 前の実行の期限のタイマーは消えていて、メモリのコードはもう無効。残ったコードのファイルを消し、
  // 紐付けていない動いている子は、受信箱に「紐付けをやり直して」を出す（子の mcp は、ファイルがないと daemon に送らないため）。
  if (parentAdapter !== undefined && config.childRuntime !== "desktop") {
    for (const r of log.state().parentRequests) {
      if (r.kind !== "launch" || latestLaunch(log.state(), r.nodeId)?.requestRef !== r.requestRef)
        continue;
      if (removeBindCodeFile(r.worktree)) {
        note("staleBindCodeFileRemoved", { nodeId: r.nodeId });
        noticeRebind(r.nodeId);
      }
    }
  }
  // 起動時の整合（CLI の子）:
  // - 破棄の判断を記録した直後、削除の依頼を追記する前に落ちた場合: 旗つきの削除の依頼を作る。
  // - 猶予の調べの最中（stopping）に落ちた場合: 猶予の調べはメモリの中だけだったので、claude stop の依頼が作られないまま stopping に
  //   残る。親が起動を報告した子で、開いている依頼がなければ、claude stop を依頼して停止未完了にする。
  if (parentAdapter !== undefined && config.childRuntime !== "desktop") {
    const st0 = log.state();
    for (const n of st0.nodes) {
      const bodies: EventBody[] = [];
      if (n.discarded !== undefined) bodies.push(...discardRemoveBodies(st0, n.id));
      const launch = latestLaunch(st0, n.id);
      if (
        n.state === "stopping" &&
        launch?.report?.outcome === "done" &&
        openRequestOf(st0.parentRequests, n.id) === undefined
      ) {
        const lastStop = [...st0.stopRequests].reverse().find((q) => q.nodeId === n.id);
        const requestRef = deriveId("preq", n.id, `restart-stop-${lastStop?.seq ?? 0}`, "stop");
        bodies.push(
          {
            type: "node.parentRequested",
            payload: { nodeId: n.id, requestRef, kind: "stop", worktree: launch.worktree },
          },
          { type: "node.stateChanged", payload: { nodeId: n.id, event: { type: "stopTimeout" } } },
          {
            type: "inbox.added",
            payload: {
              id: deriveId("inbox", "system", requestRef, "restart-stop"),
              kind: "stopIncomplete",
              nodeId: n.id,
              ...notice("restartStopCheck", { node: n.id }),
            },
          },
        );
      }
      if (bodies.length === 0) continue;
      const r = appendAtomically(
        log,
        clock,
        `startup-cli-${n.id}-${st0.lastSeq}`,
        { system: true },
        bodies,
      );
      if (!r.ok) note("startupCliReconcileFailure", { nodeId: n.id, cause: r.error.code });
    }
  }

  // Desktop の子（daemon の外で動く子）か。起動時の照合と、根の「daemon 再起動後」の依頼の解決で、同じ判定を使う。
  const isExternal: ((nodeId: string) => boolean) | undefined =
    config.childRuntime === "desktop" ? () => true : undefined;
  // Desktop の子のときは、追記が成功したあとに、動いているかもしれない子がいなくなっていれば、根の依頼を解決済みにする
  // （操作のハンドラと、Desktop のアダプタの記録口に使う。`external-check.ts`）。
  const resolvingLog =
    isExternal === undefined
      ? log
      : withExternalCheckResolution(log, isExternal, (cause) =>
          note("externalCheckFailure", { cause }),
        );
  // Desktop の子（設定 childRuntime が desktop。仮置き）。木全体で 1 つのアダプタ。フックのゲートは既定で有効。
  const desktopAdapter =
    config.childRuntime === "desktop"
      ? new DesktopRuntimeAdapter({
          sink: {
            record: (r) => resolvingLog.append(r),
            recordAll: (rs) => resolvingLog.appendAll(rs),
          },
          requireVerifiedHooks: config.desktopRequireVerifiedHooks ?? true,
          onWarning: (nodeId, text) => note("desktopHooksGateDisabled", { nodeId, text }),
          ...(config.touryouCommand === undefined
            ? {}
            : { extraAllowedCommands: touryouChildCommands(config.touryouCommand) }),
          prepareWorktree: (nodeId, worktreePath) => prepareDesktopWorktree(nodeId, worktreePath),
        })
      : undefined;
  const adapter: RuntimeAdapter & { has(nodeId: string): boolean } = desktopAdapter ?? cliAdapter;

  // Desktop の子のフック（`touryou child hook` → POST /v1/hook）。範囲は Desktop のアダプタが持つもの（touryou child の 2 つを
  // 足したもの）、作業ツリーは daemon が作ったもの、禁じる場所は CLI の子と同じ（stateDir・設定ファイル）に、そのノードの
  // 引き出しの例外を加える。フック入力の cwd が、daemon の作業ツリーと違えば拒否する（チップで作った子など）。
  const lastHookAt = new Map<string, number>();
  /**
   * git の共通ディレクトリの info/exclude に、行を足す（なければ）。作業ツリーが git の作業ツリーでなければ、何もしない
   * （コミットに混ざる心配がない）。足したファイルの実パスを返す。
   */
  const addToGitExclude = async (worktree: string, line: string): Promise<string | undefined> => {
    const common = await new Promise<string | undefined>((res) => {
      execFile(
        "git",
        ["rev-parse", "--git-common-dir"],
        { cwd: worktree, timeout: 5000 },
        (e, out) => res(e ? undefined : String(out).trim()),
      );
    });
    if (common === undefined || common === "") return undefined;
    const info = join(isAbsolute(common) ? common : join(worktree, common), "info");
    mkdirSync(info, { recursive: true });
    const path = join(info, "exclude");
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (!text.split("\n").includes(line)) {
      writeFileSync(path, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
    }
    return realpath(path);
  };
  /** 見張りの設定を置いた作業ツリーと、その設定の中身のハッシュ・git の共通ディレクトリの info/exclude（メモリだけ）。 */
  const hookSettings = new Map<
    string,
    { worktree: string; hash: string; content: string; exclude?: string; preparedAt: number }
  >();
  /** 利用者の設定（`~/.claude/settings*.json`）の、フックに関わる値（`disableAllHooks`・`hooks`）の控え（書き戻さない）。 */
  let homeHookSnapshot: string | undefined;
  const homeHookKeys = (): string => {
    if (claudeConfigDirs.length === 0) return "";
    const out: Record<string, unknown> = {};
    for (const f of userSettingsFiles()) {
      try {
        const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
        out[f] = { disableAllHooks: j.disableAllHooks ?? null, hooks: j.hooks ?? null };
      } catch (e) {
        out[f] = (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
      }
    }
    return JSON.stringify(out);
  };
  const homeDisablesHooks = (): boolean => {
    try {
      const v = JSON.parse(homeHookKeys() || "{}") as Record<
        string,
        { disableAllHooks?: unknown } | null
      >;
      return Object.values(v).some(
        (x) => x !== null && typeof x === "object" && x.disableAllHooks === true,
      );
    } catch {
      return true;
    }
  };
  /** macOS だけ: 見張りの設定に、変更できない印（uchg）を付ける・外す（歯止め。子も同じユーザーなので外せる。失敗は警告だけ）。 */
  const setUchg = async (file: string, on: boolean): Promise<void> => {
    if (deps.setImmutable !== undefined) return deps.setImmutable(file, on);
    if (process.platform !== "darwin") return;
    await new Promise<void>((res) => {
      execFile("/usr/bin/chflags", [on ? "uchg" : "nouchg", file], { timeout: 5000 }, (e) => {
        if (e)
          note("hookSettingsWarning", { cause: on ? "uchg を付けられない" : "uchg を外せない" });
        res();
      });
    });
  };
  /**
   * 見張りの設定の問題。daemon が置いた settings.json と中身が違う・ない、settings.local.json がある、利用者の設定の
   * `disableAllHooks`・`hooks` が控えと違う、のどれか。問題がなければ undefined。
   */
  const hookSettingsProblem = (
    nodeId: string,
  ): { kind: "worktree" | "home"; text: string } | undefined => {
    const settings = hookSettings.get(nodeId);
    if (settings === undefined) return { kind: "worktree", text: "daemon が置いた設定がない" };
    try {
      const now = createHash("sha256")
        .update(readFileSync(join(settings.worktree, ".claude", "settings.json")))
        .digest("hex");
      if (now !== settings.hash) return { kind: "worktree", text: "settings.json が変わった" };
    } catch {
      return { kind: "worktree", text: "settings.json がない" };
    }
    try {
      lstatSync(join(settings.worktree, ".claude", "settings.local.json"));
      return { kind: "worktree", text: "settings.local.json が置かれた" };
    } catch {
      // ない（よい）
    }
    if (homeHookSnapshot !== undefined && homeHookKeys() !== homeHookSnapshot) {
      return {
        kind: "home",
        text: "利用者の設定（~/.claude または CLAUDE_CONFIG_DIR）のフックの値が変わった",
      };
    }
    return undefined;
  };
  /** daemon が置いた設定に書き戻す（settings.json を置き直し、settings.local.json を消す）。 */
  const restoreHookSettings = async (nodeId: string): Promise<void> => {
    const settings = hookSettings.get(nodeId);
    if (settings === undefined) return;
    const dir = join(settings.worktree, ".claude");
    const file = join(dir, "settings.json");
    try {
      await setUchg(file, false);
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.settings.json.tmp-${randomBytes(6).toString("hex")}`);
      writeFileSync(tmp, settings.content, { flag: "wx", mode: 0o644 });
      renameSync(tmp, file);
      rmSync(join(dir, "settings.local.json"), { force: true, recursive: true });
      await setUchg(file, true);
    } catch (e) {
      note("hookSettingsWarning", {
        nodeId,
        cause: `書き戻せない（${safeCauseOfChildrenDir(e)}）`,
      });
    }
  };
  /** 見張りの設定が書き換えられたと分かったノード（以後のフックをすべて拒否する）。 */
  const tamperedHooks = new Set<string>();
  /** Desktop の子の範囲違反の数え上げ（CLI の子と同じ上限。受信箱には、同じ違反につき 1 度、ノードごとに 20 件まで）。 */
  const desktopViolations = new Map<
    string,
    { keys: Map<string, number>; total: number; items: number; overflow: boolean }
  >();
  let violationSeq = 0;
  let violationsAll = 0;
  const recordDesktopViolation = (
    nodeId: string,
    reason: ScopeViolationReason,
    rawSubject: string,
    /** session_id で引いた要求の記録なら、その印（行為者に写す）。 */
    trust?: "sessionIdOnly",
  ): void => {
    // 件名は長さを切り、トークン・Bearer を含むものは伏せる
    const subject = /bearer|token/i.test(rawSubject) ? "（伏せた）" : rawSubject.slice(0, 200);
    // 全ノードを通した上限。消えたノードの分は、数え上げから消す
    if (violationsAll >= 2000) return;
    if (desktopViolations.size > 0) {
      const liveIds = new Set(log.state().nodes.map((n) => n.id));
      for (const id of [...desktopViolations.keys()])
        if (!liveIds.has(id)) desktopViolations.delete(id);
    }
    const v = desktopViolations.get(nodeId) ?? {
      keys: new Map(),
      total: 0,
      items: 0,
      overflow: false,
    };
    desktopViolations.set(nodeId, v);
    const key = `${reason}\0${subject}`;
    const count = v.keys.get(key) ?? 0;
    if (count >= 10 || v.total >= 200) return;
    const bodies: EventBody[] = [{ type: "scope.violation", payload: { nodeId, reason, subject } }];
    const requestId = `desktop-violation-${randomBytes(8).toString("hex")}-${++violationSeq}`;
    let item = false;
    let overflow = false;
    if (count === 0 && v.items < 20) {
      item = true;
      bodies.push({
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", requestId, "violation"),
          kind: "violation",
          nodeId,
          ...notice("violation", { reason, subject }),
        },
      });
    } else if (count === 0 && !v.overflow) {
      overflow = true;
      bodies.push({
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", requestId, "violation"),
          kind: "violation",
          nodeId,
          ...notice("violationOverflow", {}),
        },
      });
    }
    const r = appendAtomically(
      log,
      clock,
      requestId,
      trust === undefined ? { system: true } : sessionActor(trust),
      bodies,
    );
    if (!r.ok) return;
    v.keys.set(key, count + 1);
    v.total += 1;
    violationsAll += 1;
    if (item) v.items += 1;
    if (overflow) v.overflow = true;
  };
  let tamperSeq = 0;
  /** 動いている Desktop の子の見張りの設定を、すべて確かめる。 */
  const checkAllHookSettings = (): void => {
    const live = new Set(
      log
        .state()
        .nodes.filter((n) => !["stopped", "verified", "reclaimable", "archived"].includes(n.state))
        .map((n) => n.id),
    );
    const firstSeenMs = (config.hookFirstSeenMinutes ?? 5) * 60_000;
    for (const [nodeId, settings] of hookSettings) {
      if (!live.has(nodeId) || tamperedHooks.has(nodeId)) continue;
      const problem = hookSettingsProblem(nodeId);
      if (problem !== undefined) handleTamper(nodeId, problem);
      // 始まってから、フックが 1 度も来ない子。1 度だけ知らせる
      if (
        !lastHookAt.has(nodeId) &&
        !noHookNotified.has(nodeId) &&
        hookNow() - settings.preparedAt >= firstSeenMs
      ) {
        noHookNotified.add(nodeId);
        notifyNoHookYet(nodeId);
      }
    }
  };
  /** フックが 1 度も来ないことを知らせた子（メモリだけ）。 */
  const noHookNotified = new Set<string>();
  const notifyNoHookYet = (nodeId: string): void => {
    const key = `hook-not-seen/${nodeId}`;
    const minutes = config.hookFirstSeenMinutes ?? 5;
    const r = appendAtomically(log, clock, key, { system: true }, [
      {
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", key, "hook-not-seen"),
          kind: "info",
          nodeId,
          ...notice("hookNotSeen", { node: nodeId, minutes }),
        },
      },
    ]);
    if (!r.ok) note("hookNotSeenNoticeFailure", { nodeId, cause: r.error.code });
  };
  /**
   * 見張りが外されたと分かったとき: そのノードの bind のトークンとフック専用のトークンを失効させ、設定を書き戻し、受信箱に
   * 知らせる。以後のフックは、すべて拒否する。印を消すのは、人が node.bindCode を出し直し、daemon が設定を確かめ直して問題が
   * なかったときだけ。
   */
  const handleTamper = (
    nodeId: string,
    problem: { kind: "worktree" | "home"; text: string },
  ): void => {
    if (tamperedHooks.has(nodeId)) return;
    tamperedHooks.add(nodeId);
    try {
      credentials.expireNode?.(nodeId);
    } catch {
      // 記録は下の知らせで
    }
    hookTokens.revoke(nodeId);
    void restoreHookSettings(nodeId);
    notifyHookTampered(nodeId, problem);
  };
  /**
   * フック入力の transcript_path から、子の Claude Code の設定の場所を知る。守る集合の外なら、集合に足し
   * （読み書きの禁止と見回りに入る）、受信箱に知らせる。その場所の設定でフックが切られていれば、見張りが外されたと扱う。
   */
  const learnConfigDir = (nodeId: string, transcriptPath: string | undefined): void => {
    if (transcriptPath === undefined || !isAbsolute(transcriptPath)) return;
    const at = transcriptPath.lastIndexOf("/projects/");
    if (at <= 0) return;
    if (!addConfigDir(transcriptPath.slice(0, at))) return;
    const key = `claude-config-dir-learned/${nodeId}/${claudeConfigDirs.length}`;
    const r = appendAtomically(log, clock, key, { system: true }, [
      {
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", key, "config-dir-learned"),
          kind: "info",
          nodeId,
          ...notice("configDirLearned", { node: nodeId }),
        },
      },
    ]);
    if (!r.ok) note("configDirNoticeFailure", { nodeId, cause: r.error.code });
    if (homeDisablesHooks()) {
      handleTamper(nodeId, { kind: "home", text: "子の設定の場所で、フックが切られている" });
    } else {
      homeHookSnapshot = homeHookKeys();
    }
  };
  /** 見張りが外されたことを、受信箱に知らせる（見つけるたびに 1 件）。 */
  const notifyHookTampered = (
    nodeId: string,
    problem: { kind: "worktree" | "home"; text: string },
  ): void => {
    const key = `hook-settings-tampered/${nodeId}/${++tamperSeq}`;
    const r = appendAtomically(log, clock, key, { system: true }, [
      {
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", key, "hook-tampered"),
          kind: "info",
          nodeId,
          ...notice(problem.kind === "home" ? "hookSettingsHome" : "hookSettingsTampered", {
            node: nodeId,
            detail: problem.text,
          }),
        },
      },
    ]);
    if (!r.ok) note("hookTamperedNoticeFailure", { nodeId, cause: r.error.code });
  };
  /**
   * Desktop の子の作業ツリーに、見張りの設定を置く。PreToolUse は `… || exit 2`（Claude Code は終了コード 2 のときだけ
   * 拒否するので、touryou が起動できない・例外で落ちたときも拒否にする）、PostToolUse・Stop は `… || true`。timeout は、touryou の内側の
   * 時間（身元の確認と、送る 8 秒 × 再試行）より十分長い 90 秒。すでに設定があれば、置かずに失敗する。info/exclude に足して、
   * 設定がコミットに混ざらないようにする。
   */
  const prepareDesktopWorktree = async (
    nodeId: string,
    worktreePath: string,
  ): Promise<Result<undefined, Failure>> => {
    const url = running?.url;
    // touryouCommand がなければ、見張りの設定を作れないので、子を作らない（見張りのない子を作らない）
    if (config.touryouCommand === undefined) {
      return fail(
        "touryouCommandMissing",
        "daemon の設定に touryouCommand がない（Desktop の子の見張りの設定を作れないので、子を作らない）",
        "daemon の設定に touryouCommand を書いて、daemon を起動し直す",
      );
    }
    if (url === undefined) {
      return fail("unavailable", "窓口がまだ待ち受けていない", "少し待って、もう一度試す");
    }
    const dir = join(worktreePath, ".claude");
    const file = join(dir, "settings.json");
    const touryou = config.touryouCommand.map(shellWord).join(" ");
    const command = `${touryou} child hook --dir ${shellWord(childrenDirs.pathOf(nodeId))} --url ${shellWord(url)}`;
    const entry = (suffix: string) => [
      { type: "command", command: `${command} ${suffix}`, timeout: 90 },
    ];
    const content = `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ matcher: "*", hooks: entry("|| exit 2") }],
          PostToolUse: [{ matcher: "*", hooks: entry("|| true") }],
          Stop: [{ hooks: entry("|| true") }],
        },
      },
      null,
      2,
    )}\n`;
    // すでに設定があるとき: daemon が前に置いたものと同じ中身なら（再開など）、そのまま使う。違えば置かずに失敗する
    // 今ある .claude は、実のディレクトリ（リンクでない）で持ち主が自分であること
    try {
      const d = lstatSync(dir);
      if (!d.isDirectory() || d.isSymbolicLink() || d.uid !== process.getuid?.()) {
        return fail(
          "hookSettingsExists",
          "子の作業ツリーの .claude が、実のディレクトリでないか、持ち主が自分でない",
          "作業ツリーの元のリポジトリの .claude を確かめてから、子を作り直す",
        );
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return fail(
          "hookSettingsFailed",
          "見張りの設定を置く場所を確かめられない",
          "作業ツリーを確かめる",
        );
      }
    }
    let existing: string | undefined;
    try {
      const st = lstatSync(file);
      // 使い回す settings.json は、通常のファイル・リンクの数 1・持ち主が自分・ほかの人が書けない
      existing =
        st.isFile() && st.nlink === 1 && st.uid === process.getuid?.() && (st.mode & 0o022) === 0
          ? readFileSync(file, "utf8")
          : "";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return fail(
          "hookSettingsFailed",
          "見張りの設定を置く場所を確かめられない",
          "作業ツリーを確かめる",
        );
      }
    }
    if (existing !== undefined && existing !== content) {
      return fail(
        "hookSettingsExists",
        "子の作業ツリーに、すでに .claude/settings.json がある（見張りの設定を置けない）",
        "作業ツリーの元のリポジトリに .claude/settings.json があるなら、それを外してから、子を作り直す",
      );
    }
    let exclude: string | undefined;
    try {
      mkdirSync(dir, { recursive: true });
      if (existing === undefined) writeFileSync(file, content, { flag: "wx", mode: 0o644 });
      await setUchg(file, true);
      exclude = await addToGitExclude(worktreePath, "/.claude/settings.json");
    } catch (e) {
      return fail(
        "hookSettingsFailed",
        `見張りの設定を置けない（${safeCauseOfChildrenDir(e)}）`,
        "作業ツリーの権限と、git の共通ディレクトリ（info/exclude）を確かめる",
      );
    }
    hookSettings.set(nodeId, {
      worktree: await realpath(worktreePath),
      hash: createHash("sha256").update(content).digest("hex"),
      content,
      ...(exclude === undefined ? {} : { exclude }),
      preparedAt: hookNow(),
    });
    homeHookSnapshot = homeHookKeys();
    tamperedHooks.delete(nodeId); // 見張りの設定を置き直したので、外された印を消す
    return { ok: true, value: undefined };
  };
  const hookNow = deps.monoMs ?? (() => performance.now());
  const resolveHookPath = (p: string) => resolveForWrite(p, nodeFsOps);
  const decideDesktopHook = async (
    nodeId: string,
    toolName: string,
    toolInput: unknown,
    cwd: string | undefined,
    transcriptPath?: string,
  ): Promise<{ allow: true } | { allow: false; reason: string }> => {
    const scope = desktopAdapter?.scopeOf(nodeId);
    const tree = await deps.worktree.cwdOf(nodeId).catch(() => undefined);
    if (scope === undefined || tree === undefined) {
      // アダプタの範囲とフック専用のトークンはメモリだけなので、daemon を再起動すると失われる
      return {
        allow: false,
        reason:
          "daemon がこの子の作業範囲を持っていないため拒否した（daemon を再起動したあとなど）。人（親）に、子を止めたと宣言して、作り直してもらう。",
      };
    }
    let wt: string;
    let here: string;
    let drawer: string;
    try {
      wt = await realpath(tree);
      here = cwd === undefined ? "" : await realpath(cwd);
      drawer = await realpath(childrenDirs.pathOf(nodeId));
    } catch {
      return { allow: false, reason: "作業ツリーを確かめられないため拒否した。" };
    }
    // 作業ツリーそのもの、またはその配下（子が cd すると、Claude Code は移った先を cwd に入れる）。実パスで比べるので、
    // 作業ツリーの中のリンクで外に出たら拒否になる。大文字小文字・正規化の違いはそろえて比べる
    const folded = (x: string) => x.normalize("NFC").toLowerCase();
    if (!(folded(here) === folded(wt) || folded(here).startsWith(`${folded(wt)}/`))) {
      return {
        allow: false,
        reason:
          "daemon が用意した作業ツリーの外のセッションなので拒否した（daemon の作業ツリーを Desktop で開き、「ローカル」で始める）。",
      };
    }
    // 子の Claude Code の設定の場所（transcript_path の /projects/ より前）が、守る集合の外なら、足して知らせ、判定をやり直す
    learnConfigDir(nodeId, transcriptPath);
    // 見張りの設定が、置いたときのままか（呼び出しのたびにも確かめる。外されていれば、書き戻して失効させ、以後をすべて拒否）
    const settings = hookSettings.get(nodeId);
    if (!tamperedHooks.has(nodeId)) {
      const problem = hookSettingsProblem(nodeId);
      if (problem !== undefined) handleTamper(nodeId, problem);
    }
    if (settings === undefined || tamperedHooks.has(nodeId)) {
      return {
        allow: false,
        reason:
          "見張り（フック）の設定が外された（または、daemon が置いた設定がない）ため、すべて拒否する。人（親）に知らせる。",
      };
    }
    const resolved = await resolveScope(scope, wt, resolveHookPath);
    const homeSettings = await Promise.all(userSettingsFiles().map((f) => resolveHookPath(f)));
    const d = await decideToolUse(
      resolved,
      wt,
      toolName,
      toolInput,
      resolveHookPath,
      {
        roots: [
          ...protectedRoots,
          // 見張りの設定（読み書きとも禁じる）: 利用者の設定、git の共通ディレクトリの info/exclude。作業ツリーの .claude/ は
          // 書き込みだけを禁じる（下の writeDenied。commands などを読めるように）
          // 実パスにして比べる（macOS の /var は /private/var へのリンク。HOME が /var の下でも外さない）
          ...homeSettings.map((path) => ({ path, kind: "hookSettings" as const })),
          ...(settings.exclude === undefined
            ? []
            : [{ path: settings.exclude, kind: "hookSettings" as const }]),
        ],
        allow: [],
        home: (deps.parentEnv ?? process.env).HOME,
        writeDenied: [join(settings.worktree, ".claude")],
        drawer,
        worktree: wt,
        cdpath: (deps.parentEnv ?? process.env).CDPATH,
        ...(config.touryouCommand === undefined ? {} : { touryouCommand: config.touryouCommand }),
      },
      here,
    );
    if (d.allow) return { allow: true };
    // CLI の子と同じく、範囲違反として記録する（受信箱にも出す）
    if (d.violation !== undefined)
      recordDesktopViolation(nodeId, d.violation.reason, d.violation.subject);
    return { allow: false, reason: d.reason };
  };

  const CLI_WRITE_TOOLS: ReadonlySet<string> = new Set([
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Bash",
  ]);
  /** git のディレクトリが分からないことを知らせた子（ノードごとに 1 回。メモリだけ）。 */
  const gitDirUnknownNotified = new Set<string>();
  const notifyGitDirUnknown = (nodeId: string): void => {
    if (gitDirUnknownNotified.has(nodeId)) return;
    gitDirUnknownNotified.add(nodeId);
    const key = `git-dir-unknown/${nodeId}`;
    const r = appendAtomically(log, clock, key, { system: true }, [
      {
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", key, "git-dir-unknown"),
          kind: "failure",
          nodeId,
          ...notice("gitDirUnknown", { node: nodeId }),
        },
      },
    ]);
    if (!r.ok) note("gitDirUnknownNoticeFailure", { nodeId, cause: r.error.code });
  };
  /** CLI の子の作業ツリーの git のディレクトリ（`git rev-parse --absolute-git-dir` の実パス。ノードごとに覚える。メモリだけ）。 */
  const cliGitDirs = new Map<string, string>();
  /** 入力待ちの知らせの間引き（daemon が出したものだけを数える。メモリだけ）。 */
  const needsInputThrottle = createNeedsInputThrottle();
  const cliGitDirOf = async (nodeId: string, worktree: string): Promise<string | undefined> => {
    const known = cliGitDirs.get(nodeId);
    if (known !== undefined) return known;
    const out = await new Promise<string | undefined>((res) => {
      execFile(
        "git",
        ["rev-parse", "--absolute-git-dir"],
        { cwd: worktree, timeout: 5000 },
        (e, o) => res(e ? undefined : String(o).trim()),
      );
    });
    if (out === undefined || out === "") return undefined;
    const real = await realpath(out).catch(() => undefined);
    if (real !== undefined) cliGitDirs.set(nodeId, real);
    return real;
  };
  /**
   * CLI の子のフック（plugin の hooks.json → `touryou hook` → POST /v1/hook）。判定は hook-policy.ts のまま。
   * 範囲はノードの記録（scope）、作業ツリーは daemon が作ったもの。範囲違反は、Desktop の子と同じく記録し、受信箱に出す。
   */
  /** 自分の git のディレクトリが `<共通の git>/worktrees/<名前>` なら、その親（ほかのノードの git のディレクトリの置き場）を禁じる場所にする。 */
  const otherGitDirsRoot = (
    gitDir: string | undefined,
  ): { readonly path: string; readonly kind: "otherNodeGitDir" }[] =>
    gitDir !== undefined && basename(dirname(gitDir)) === "worktrees"
      ? [{ path: dirname(gitDir), kind: "otherNodeGitDir" }]
      : [];
  /** CLI の子のフックが最後に来た時刻（見張り。メモリだけ）。 */
  const cliHookAt = new Map<string, number>();
  const decideCliHook = async (
    nodeId: string,
    toolName: string,
    toolInput: unknown,
    cwd: string | undefined,
    trust?: "sessionIdOnly",
  ): Promise<
    { allow: true; permit?: "extension" | "readOnlySearch" } | { allow: false; reason: string }
  > => {
    cliHookAt.set(nodeId, Date.parse(clock()));
    // 有効な範囲（ブリーフの範囲＋承認済みの拡張）。イベント列から毎回導くので、承認は次の呼び出しから効き、再起動でも失われない（#91）
    const scope = effectiveScope(log.state(), nodeId);
    const tree = await deps.worktree.cwdOf(nodeId).catch(() => undefined);
    if (scope === undefined || tree === undefined) {
      return {
        allow: false,
        reason:
          "daemon がこの子の作業範囲か作業ツリーを持っていないため拒否した。人（親）に知らせる。",
      };
    }
    let wt: string;
    let here: string;
    try {
      wt = await realpath(tree);
      here = cwd === undefined ? wt : await realpath(cwd);
    } catch {
      return { allow: false, reason: "作業ツリーを確かめられないため拒否した。" };
    }
    // 作業ツリーの git のディレクトリ（印 touryou-child がある）と、作業ツリーの .git は、書き込み・削除を禁じる（rm・mv・ln・
    // リダイレクトなどの Bash の道も、writeDenied で見る）。git のディレクトリが分からなければ、拒否する（印を守れないため）
    const gitDir = await cliGitDirOf(nodeId, wt);
    // git のディレクトリが分からないとき: 印を守れないので、書き込み系（Write・Edit・MultiEdit・NotebookEdit と、書き込みを
    // 字面で見分けきれない Bash）だけを拒む。読み取りは、下の判定のまま（state のディレクトリの読み取りの拒否も残る）。人に 1 回知らせる
    if (gitDir === undefined && CLI_WRITE_TOOLS.has(toolName)) {
      notifyGitDirUnknown(nodeId);
      return {
        allow: false,
        reason:
          "作業ツリーの git のディレクトリを確かめられないため、書き込みを拒否した。人（親）に知らせる（受信箱に出した）。",
      };
    }
    const resolved = await resolveScope(scope, wt, resolveHookPath);
    const roots = [...protectedRoots, ...otherGitDirsRoot(gitDir)];
    const d = await decideToolUse(
      resolved,
      wt,
      toolName,
      toolInput,
      resolveHookPath,
      {
        // ほかのノードの git のディレクトリ（`.git/worktrees/<ほかの名前>/`。紐付けのコードのファイルがある）は、読み取りも禁じる。
        // 自分の git のディレクトリは除く（自分のコードは mcp が読む。mcp はフックを通らない）。
        roots,
        allow: gitDir === undefined ? [] : [gitDir],
        writeDenied: gitDir === undefined ? [join(wt, ".git")] : [gitDir, join(wt, ".git")],
        home: (deps.parentEnv ?? process.env).HOME,
        worktree: wt,
        cdpath: (deps.parentEnv ?? process.env).CDPATH,
        ...(config.touryouCommand === undefined ? {} : { touryouCommand: config.touryouCommand }),
      },
      here,
    );
    if (d.allow) {
      // 起動のときの許可の一覧（ブリーフの範囲から作る。dontAsk）にない、承認済みの拡張でだけ通る Bash は、明示の許可を返す（#91）
      // 承認済みの書き込みの場所への書き込みも同じ。書き込みのパスは、作業ツリー（実パス）と比べるため実パスにしてから渡す
      // （macOS の /var と /private/var の食い違いで、明示の許可が付かなくなるのを防ぐ）
      // 作業ツリーの中を探す読み取りだけのコマンド（#92）も、明示の許可を返す。CLI の子は dontAsk で、起動のときの許可の一覧は
      // ブリーフの範囲だけなので、何も言わない許しでは Claude Code の側で断られる。判定は上の decideToolUse と同じ確かめ
      const command =
        typeof toolInput === "object" && toolInput !== null
          ? (toolInput as Record<string, unknown>).command
          : undefined;
      if (
        toolName === "Bash" &&
        typeof command === "string" &&
        (await isReadOnlySearch(
          command,
          here,
          wt,
          resolveHookPath,
          roots.map((r) => r.path),
        ))
      ) {
        return { allow: true, permit: "readOnlySearch" };
      }
      const brief = log.state().nodes.find((n) => n.id === nodeId)?.scope;
      // Bash: 承認済みの拡張で通る形。足したパス（mkdir・touch・cp・git rm・git mv。#135）は、実パスで書き込める場所の中かを照らす。
      // 形は承認されているのにパスだけが外のときは、許可なしで通す（Claude Code が理由なく断る）のでなく、理由つきで拒否して記録する
      if (toolName === "Bash" && typeof command === "string") {
        if (brief === undefined) return { allow: true };
        const grant = await grantedBashByExtension(brief, scope, command, {
          scope: resolved,
          worktree: wt,
          here,
          resolve: resolveHookPath,
          guardTrees: gitDir === undefined ? [join(wt, ".git")] : [gitDir, join(wt, ".git")],
        });
        if (grant.granted) return { allow: true, permit: "extension" };
        if (grant.denied !== undefined) {
          if (grant.denied.violation !== undefined)
            recordDesktopViolation(
              nodeId,
              grant.denied.violation.reason,
              grant.denied.violation.subject,
              trust,
            );
          return { allow: false, reason: grant.denied.reason };
        }
        return { allow: true };
      }
      const input = await withRealWritePath(toolName, toolInput, here, resolveHookPath);
      if (brief !== undefined && grantedOnlyByExtension(brief, scope, toolName, input, wt)) {
        return { allow: true, permit: "extension" };
      }
      return { allow: true };
    }
    // session_id で引いた要求の記録は、行為者に印（trust: sessionIdOnly）を写す
    if (d.violation !== undefined)
      recordDesktopViolation(nodeId, d.violation.reason, d.violation.subject, trust);
    return { allow: false, reason: d.reason };
  };

  const cwdOf = async (nodeId: string): Promise<string | undefined> =>
    nodeId === config.rootNodeId ? config.rootCwd : deps.worktree.cwdOf(nodeId);
  const reclaim: ReclaimPorts = {
    factsFor: (id) => deps.worktree.factsFor(id),
    ...(deps.worktree.lossFor === undefined
      ? {}
      : {
          lossFor: (id: string) =>
            (deps.worktree.lossFor as NonNullable<WorktreePorts["lossFor"]>)(id),
        }),
    probe,
    removeWorktree: async (id, opts) => {
      const st = hookSettings.get(id);
      if (st !== undefined) await setUchg(join(st.worktree, ".claude", "settings.json"), false);
      return deps.worktree.removeWorktree(id, opts);
    },
    ...(deps.worktree.integrate === undefined
      ? {}
      : {
          integrate: (id: string) =>
            (deps.worktree.integrate as NonNullable<WorktreePorts["integrate"]>)(id),
        }),
    worktreeRoot: config.worktreeRoot,
    onForced: (nodeId, tip, ref) =>
      note("reclaimForced", { nodeId, tip, ...(ref === undefined ? {} : { ref }) }),
  };
  const spawn: SpawnPorts = {
    cwdOf,
    provisionWorktree: (req) => deps.worktree.provisionWorktree(req),
    removeWorktree: async (id, opts) => {
      const st = hookSettings.get(id);
      if (st !== undefined) await setUchg(join(st.worktree, ".claude", "settings.json"), false);
      return deps.worktree.removeWorktree(id, opts);
    },
    worktreeRoot: config.worktreeRoot,
  };
  const onFailure = (nodeId: string, cause: string): void =>
    note("handlerFailure", { nodeId, cause });
  const purgeDeps: PurgeHandlerDeps = {
    log,
    nowMs: () => Date.parse(clock()),
    retentionDays: config.retentionDays ?? DEFAULT_RETENTION_DAYS,
    defaultTombstone: config.purgeTombstone ?? DEFAULT_PURGE_TOMBSTONE,
    revokeNode: (id) => credentials.revokeNode(id),
    audit: (event, data) => note(`purge.${event}`, data),
    onFailure,
    discardedFor: async (nodeIds) => {
      const list = deps.worktree.discardedList;
      const keyOf = deps.worktree.discardedKeyOf;
      if (list === undefined || keyOf === undefined) throw new Error("保管の口がない");
      const listed = await list.call(deps.worktree);
      if (!listed.ok) throw new Error(listed.error.cause);
      const bases = new Set(nodeIds.map((id) => keyOf.call(deps.worktree, id)));
      return listed.value.items.filter((i) => ownedBy(i.key, bases)).length;
    },
    // 最終削除で、その木のノードの、保管している破棄した成果（refs/touryou/discarded/*）も消す。最終削除の成否には影響させない。
    onPurged: (nodeIds) => {
      const del = deps.worktree.discardedDeleteFor;
      if (del === undefined) return;
      void del
        .call(deps.worktree, nodeIds)
        .then((r) => {
          if (r.deleted.length > 0) note("purge.discardedRefsDeleted", { refs: r.deleted });
          if (r.failed.length > 0) note("purge.discardedRefsFailed", { refs: r.failed });
        })
        .catch((e) => note("purge.discardedRefsFailed", { cause: String(e) }));
    },
  };
  // ノードの購読があるか。sse-hub は server の中で作られるので、`onSseHub` であとから結ぶ。
  let nodeSubscription: ((id: string) => boolean) | undefined;
  const {
    handlers,
    tick: schedule,
    close: closeScheduler,
  } = createHandlersWithScheduler(
    {
      // Desktop の子のときは、根の「daemon 再起動後」の依頼を、状態が変わったあとに判断する（上の resolvingLog）。
      log: resolvingLog,
      clock,
      // 子に付ける plugin の場所: 作業ツリー・リポジトリ・状態・touryou の置き場の中は付けない
      pluginDir: pluginDirPortsOf(config),
      // CLI の子（SSE の購読で指示を受け取る）か。トークンの種類では見ない（CLI の子も
      // child_bind で kind "bind" のトークンを受けるため）。設定の childRuntime で決める（desktop でなければ CLI の子）。
      isCliChild: (id: string) => isCliChildOf(config.childRuntime, log.state(), id),
      // ノードの購読があるか（sse-hub から、あとで結ぶ。未結線のあいだは true とみなして知らせない）。
      hasSubscription: (id: string) => nodeSubscription?.(id) ?? true,
      onFailure,
    },
    {
      adapterFor: () => adapter,
      managed: (id) => adapter.has(id),
      onStopSettled: (nodeId, result) =>
        note("stopSettled", {
          nodeId,
          ok: result.ok,
          ...(result.ok ? { state: result.value.state } : {}),
        }),
    },
    reclaim,
    {
      ports: spawn,
      credentials,
      rootScope: config.rootScope,
      onFailure,
      ...(config.startLimits === undefined ? {} : { startLimits: config.startLimits }),
    },
    purgeDeps,
  );
  // 自動の最終削除（設定で有効にしたときだけ）。人間のコマンドと同じ関数を通る。
  const autoPurger =
    config.autoPurge?.enabled === true
      ? createAutoPurger({
          state: () => log.state(),
          nowMs: purgeDeps.nowMs,
          retentionDays: purgeDeps.retentionDays,
          intervalMs:
            (config.autoPurge.intervalMinutes ?? DEFAULT_AUTO_PURGE_INTERVAL_MINUTES) * 60_000,
          maxTreesPerRun: config.autoPurge.maxTreesPerRun ?? DEFAULT_AUTO_PURGE_MAX_TREES,
          noticeDays: config.autoPurge.noticeDays ?? DEFAULT_AUTO_PURGE_NOTICE_DAYS,
          record: (requestId, body) => log.append({ requestId, actor: { system: true }, body }),
          purgeTreeOf: createPurger(purgeDeps).purgeTreeOf,
          timers,
          note,
          isStopped: () => fatalSeen,
          lastEventAt: () => log.lastEventAt(),
          monoMs: deps.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
          lastEventAtAtStartup: startupLastEventAt,
        })
      : undefined;

  // 配下の要約（既定で有効。`digest.enabled: false` で無効）。文面は、core の `digestOf` の結果だけ。
  const digestIssuer =
    config.digest?.enabled === false
      ? undefined
      : createDigestIssuer({
          state: () => log.state(),
          nowMs: purgeDeps.nowMs,
          monoMs: deps.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
          intervalMs: (config.digest?.intervalSec ?? DEFAULT_DIGEST_INTERVAL_SEC) * 1000,
          minIntervalMs: (config.digest?.minIntervalSec ?? DEFAULT_DIGEST_MIN_INTERVAL_SEC) * 1000,
          maxPerRun: config.digest?.maxPerRun ?? DEFAULT_DIGEST_MAX_PER_RUN,
          record: (requestId, body) => log.append({ requestId, actor: { system: true }, body }),
          timers,
          note,
          isStopped: () => fatalSeen,
        });

  // 中間統合ノードを起こす（**既定で無効**。`wake.enabled: true` で有効）。固定の 1 行の指示を、`node.send` と同じ配送で送る。
  const waker =
    config.wake?.enabled === true
      ? createWaker({
          log,
          clock,
          monoMs: deps.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
          intervalMs: (config.wake.intervalSec ?? DEFAULT_WAKE_INTERVAL_SEC) * 1000,
          minIntervalMs: (config.wake.minIntervalSec ?? DEFAULT_WAKE_MIN_INTERVAL_SEC) * 1000,
          maxPerRun: config.wake.maxPerRun ?? DEFAULT_WAKE_MAX_PER_RUN,
          ...(config.wake.maxPerHour === undefined ? {} : { maxPerHour: config.wake.maxPerHour }),
          // daemon は子を呼ばない。記録に置き、ノードの購読（SSE）で知らせる。
          ...(() => {
            const d = createInstructionDelivery({
              log,
              clock,
              onFailure: (nodeId, cause) => note("handlerFailure", { nodeId, cause }),
            });
            return { deliver: d.deliver, canDeliver: d.available };
          })(),
          timers,
          note,
          isStopped: () => fatalSeen,
        })
      : undefined;

  // 窓口の 429・401 の件数の見える化（既定で有効）。件数のまとめ（apiSummary）が閾値以上なら、根の受信箱に info を 1 件出す。
  const apiAlert =
    config.rateLimit?.alert?.enabled === false
      ? undefined
      : createApiAlert({
          threshold: config.rateLimit?.alert?.threshold ?? DEFAULT_ALERT_THRESHOLD,
          retiredThreshold:
            config.rateLimit?.alert?.retiredThreshold ?? DEFAULT_RETIRED_ALERT_THRESHOLD,
          minIntervalMs:
            (config.rateLimit?.alert?.minIntervalMinutes ?? DEFAULT_ALERT_INTERVAL_MINUTES) *
            60_000,
          rootNodeId: config.rootNodeId,
          monoMs: deps.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
          record: (requestId, body) => log.append({ requestId, actor: { system: true }, body }),
          openAlertIds: () =>
            log
              .state()
              .inbox.filter((i) => i.id.startsWith(ALERT_ID_PREFIX) && i.resolved === undefined)
              .map((i) => i.id),
          note,
        });
  const logger: ApiLogger = (e) => {
    // 秘密（コード・トークン）は、イベントに含まれない（`ApiLogEvent` の規則）。
    if (e.event === "internalError")
      note("apiInternalError", {
        operation: e.operation,
        requestId: e.requestId,
        error: String(e.error),
      });
    else note(e.event, e as unknown as Record<string, unknown>);
    apiAlert?.(e);
  };
  // 紐付けで結んだ session_id → ノード（フックの受け口が、信頼度の低い報告にだけ使う）
  const sessionBindings = createSessionBindings({ log, cwdOf: (id) => deps.worktree.cwdOf(id) });
  // 取り消せない操作の確認。Desktop の木だけ（子が人間のトークンを読めてしまうため）。CLI の子だけの木は今までどおり。
  const confirmGate =
    desktopAdapter === undefined
      ? undefined
      : createConfirmationGate({
          log,
          clock,
          writeTerminal: deps.confirmationOut ?? writeControllingTerminal,
        });
  const wrapConfirm = (h: Handlers): Handlers =>
    confirmGate === undefined ? h : confirmGate.wrap(h);
  const identityPath = join(config.stateDir, IDENTITY_FILE);
  let currentIdentity: Identity | undefined;
  const server = createApiServer({
    identity: () => currentIdentity,
    credentials,
    // ハンドラへ「ノードの購読があるか」を結ぶ。
    onSseHub: (hub) => {
      nodeSubscription = (id) => hub.hasSubscription(id);
      sseRetire = (id) => {
        hub.retire(id);
      };
    },
    // ファイルで設定するフック（plugin の hooks.json）。SDK のコールバックと同じ判定・同じ記録。
    // Desktop の子のフックの継承は、ファイルで設定するフックの経路では未確認。確認までは、受け口では許可しない（仮置き）。
    hook: (nodeId, toolName, toolInput, cwd, transcriptPath, trust) =>
      desktopAdapter === undefined
        ? decideCliHook(nodeId, toolName, toolInput, cwd, trust)
        : decideDesktopHook(nodeId, toolName, toolInput, cwd, transcriptPath),
    // Notification・Stop（設計 6.2 の「止まったことの検出」(1)・6.2b の逃げ道）
    onHookNotification: (nodeId, h, trust) => {
      if (h.notificationType === undefined) return;
      reportNeedsInput(
        { log, clock, throttle: needsInputThrottle },
        nodeId,
        {
          notificationType: h.notificationType,
          ...(h.message === undefined ? {} : { message: h.message }),
          ...(h.title === undefined ? {} : { title: h.title }),
        },
        trust,
      );
    },
    lookupSession: (sessionId) => sessionBindings.lookupNodeBySession(sessionId),
    realpathOf: (p: string) => realpath(p),
    onHookStop: (nodeId, h) => {
      const o = stopOutcome(log.state(), nodeId, h.stopHookActive === true);
      return o.decision === "continue" ? { continueReason: o.reason } : {};
    },
    ...(desktopAdapter === undefined
      ? {}
      : {
          hookFresh: (nodeId: string) => {
            // bind・報告の入口でも、見張りの設定を確かめる
            if (tamperedHooks.has(nodeId)) return false;
            const problem = hookSettingsProblem(nodeId);
            if (problem !== undefined) {
              handleTamper(nodeId, problem);
              return false;
            }
            const at = lastHookAt.get(nodeId);
            return at !== undefined && hookNow() - at <= (config.hookFreshSeconds ?? 30) * 1000;
          },
          onHookSeen: (nodeId: string) => lastHookAt.set(nodeId, hookNow()),
          // Desktop の子の受け口は、フック専用のトークンだけ（ノードのトークンでは呼べない）
          hookTokensOnly: true,
        }),
    hookSessions,
    ...(hookTokens === undefined ? {} : { hookTokens }),
    getState: () => log.state(),
    // 画面の停止の宣言。ハンドラ（node.confirmStopped）と同じく、能力表の stopDelegated だけで決める（管理しているか
    // は見ない。再起動の後も出す）。childRuntime が desktop のとき、Desktop のアダプタの能力表から真になる。
    stopDelegated: stopDelegatedOf(adapter),
    // 画面の claude attach を打つ場所（#136）
    attachDir: config.repoRoot,
    ...(confirmGate === undefined
      ? {}
      : {
          confirmations: () => confirmGate.pending(),
          confirmationsVersion: () => confirmGate.version(),
        }),
    handlers: wrapConfirm({
      ...handlers,
      // フックの結び付けを外す（人間・祖先の統合ノード）。
      ...createHookHandlers({
        log,
        sessions: hookSessions,
        ...(hookTokens === undefined ? {} : { hookTokens }),
        managed: (id) => adapter.has(id),
        baseUrl: () => running?.url,
        desktop: desktopAdapter !== undefined,
      }),
      // Desktop の子の紐付けの文面（仮置き）。コードは記録しない（応答だけ）。
      ...createBindHandlers({
        log,
        bind,
        ...(desktopAdapter === undefined ? { cli: true } : { desktop: desktopAdapter }),
        ...(desktopAdapter === undefined && parentAdapter !== undefined
          ? {
              cliIssueFile: (nodeId: string) => {
                const launch = latestLaunch(log.state(), nodeId);
                if (launch === undefined) throw new Error("起動の依頼がない");
                const issued = parentAdapter.issueCodeFile(nodeId, launch.worktree);
                rebindNoticedAt.delete(nodeId);
                return issued;
              },
            }
          : {}),
        baseUrl: () => running?.url,
        ...(config.touryouCommand === undefined ? {} : { touryouCommand: config.touryouCommand }),
        // 見張りの設定を置いた作業ツリー（文面の「ローカルで始める」手順に書く）
        worktreeOf: (id) => hookSettings.get(id)?.worktree,
        // 引き出しを用意する（なければ作る。node を書き直し、残っている code・token・url・report を消す）。
        // 紐付けは、新しい文面で 1 からやり直す（前の token は、新しいトークンの発行で無効になる）
        prepareDrawer: (nodeId) => {
          // 見張りが外されていた子の復旧: 人が出し直したとき、設定を確かめ直し、問題がなければ印を消す。利用者の設定は、
          // フックを切っていなければ、今の値を控え直す（人が変えた値を受け入れる）
          if (tamperedHooks.has(nodeId)) {
            if (!homeDisablesHooks()) homeHookSnapshot = homeHookKeys();
            if (hookSettingsProblem(nodeId) !== undefined) {
              throw new ChildrenDirError("見張りの設定に、まだ問題がある");
            }
            tamperedHooks.delete(nodeId);
          }
          const dir = childrenDirs.create(nodeId);
          childrenDirs.writeFile(nodeId, "node", nodeId);
          childrenDirs.removeFiles(nodeId, ["code", "token", "url", "report"]);
          // フック専用のトークンを出し直す（24 時間の絶対の期限。結び直しのたびに新しくする）
          childrenDirs.writeFile(nodeId, "hook-token", hookTokens.issue(nodeId));
          // 前のセッションとの結び付きを解く（次の新しいセッションが、許可された最初の呼び出しで結ばれる）
          if (hookSessions.unbind(nodeId)) note("hookUnbound", { reason: "bindCodeReissued" });
          return dir;
        },
      }),
      // 保管している、破棄した成果の操作（人間のみ）。git の口が、保管の操作を持つときだけ有効。
      ...(deps.worktree.discardedList === undefined ||
      deps.worktree.discardedKeyOf === undefined ||
      deps.worktree.discardedRestore === undefined ||
      deps.worktree.discardedDrop === undefined
        ? {}
        : createDiscardedHandlers({
            state: () => log.state(),
            ports: {
              discardedList: () => (deps.worktree.discardedList as GitPorts["discardedList"])(),
              discardedKeyOf: (id) =>
                (deps.worktree.discardedKeyOf as GitPorts["discardedKeyOf"])(id),
              discardedRestore: (r) =>
                (deps.worktree.discardedRestore as GitPorts["discardedRestore"])(r),
              discardedDrop: (k, tip) =>
                (deps.worktree.discardedDrop as GitPorts["discardedDrop"])(k, tip),
            },
            audit: (event, data) => note(`discarded.${event}`, data),
          })),
    }),
    logger,
    bind,
    // CLI の子の紐付けは、そのノードの作業ツリーの中のセッションだけ（FR_006）
    ...(desktopAdapter === undefined
      ? { bindWorktreeOk: createBindWorktreeCheck({ cwdOf: (id) => deps.worktree.cwdOf(id) }) }
      : {}),
    bindSessionOk: (nodeId, sessionId) => {
      if (!sessionBindings.conflicts(nodeId, sessionId)) return true;
      note("bindSessionConflict", { nodeId });
      return false;
    },
    onBindSucceeded: (nodeId, info) => {
      if (!sessionBindings.bound(nodeId, info)) note("sessionBindFailed", { nodeId });
      // 使われたコードのファイルを消す（コードは、もうメモリにない）
      const launch = latestLaunch(log.state(), nodeId);
      if (launch !== undefined) parentAdapter?.discardCode(nodeId, launch.worktree, false);
    },
    ...(desktopAdapter === undefined ? { onBindInvalid: noticeRebind } : {}),
    clock,
    ...apiLimitsOf(config, deps.monotonicMs, deps.summaryScheduler),
  });

  let running: RunningDaemon | undefined;
  let tokenSweep: NodeJS.Timeout | undefined;
  let cliWatchTimer: NodeJS.Timeout | undefined;
  // CLI の子の見張り。記録の時刻と、フックが来た時刻だけで決める（daemon は子を呼ばない）
  const cliWatchSpec = {
    stallMs: (config.cliWatch?.stallMinutes ?? 30) * 60_000,
    unreadMs: (config.cliWatch?.unreadMinutes ?? 30) * 60_000,
    // 紐付けのない子。既定 3 分: 子の最初の番で child_bind を呼ぶので、ふつうは数十秒で済む。遅い起動の余裕を見ても 3 分で足りる
    unboundMs: (config.cliWatch?.unboundMinutes ?? 3) * 60_000,
    // 起動の時刻を「最後の動き」の下限にする（フックの時刻はメモリだけなので）
    sinceMs: Date.parse(clock()),
  };
  const cliWatchCounts: WatchCounts = new Map();
  const runCliWatch = (): number => {
    try {
      const f = watchFindings(
        log.state(),
        Date.parse(clock()),
        cliWatchSpec,
        (id) => cliHookAt.get(id),
        (id) => credentials.hasBindToken?.(id) === true || boundInState(log.state(), id),
      );
      return recordWatchFindings(
        log,
        clock,
        f,
        cliWatchSpec,
        cliWatchCounts,
        Date.parse(clock()),
        (nodeId) => note("cliWatchUnboundNoParent", { nodeId }),
      );
    } catch (e) {
      note("cliWatchFailure", { cause: e instanceof Error ? e.name : "unknown" });
      return 0;
    }
  };
  let hookWatch: NodeJS.Timeout | undefined;
  return {
    ok: true,
    value: {
      log,
      sweepTokens: () => credentials.sweepExpired?.() ?? [],
      runCliWatch,
      async start() {
        if (running !== undefined) return running;
        // 窓口のポート: 起動オプション → 設定 → 保存したポート → 新規（保存する）の順。`port-file.ts`。
        // 照合・配送し直しより前に決める（ファイルの誤りは、記録を何も書く前に止める）。
        const portPath = join(config.stateDir, PORT_FILE);
        const choice = choosePort({
          ...(deps.port === undefined ? {} : { option: deps.port }),
          configPort: config.port,
          saved: () => readSavedPort(portPath),
        });
        // 待ち受けの前に、前回の実行から残った子（記録は動作中だが、アダプタは管理していない）を、記録とプロセスに合わせる。
        const outcomes = await reconcileOnStartup({
          log,
          clock,
          cwdOf,
          probe,
          worktreeRoot: config.worktreeRoot,
          has: (id) => adapter.has(id),
          // Desktop の子は、daemon の外で動くので、プロセスで照合せず、受信箱で人に確かめてもらう。
          ...(isExternal === undefined ? {} : { external: isExternal }),
          onFailure: (nodeId, cause) => note("reconcileFailure", { nodeId, cause }),
        });
        for (const o of outcomes) note("reconciled", { ...o });
        // 引き出しが要る状態の子の鍵でない引き出しを消す（daemon の異常終了・片付いた子の残り）。記録は件数だけ。
        try {
          const needed = log
            .state()
            .nodes.filter((n) => n.parentId !== null && CHILD_DIR_NEEDED[n.state])
            .map((n) => n.id);
          const { removed, failed } = childrenDirs.sweep(needed);
          if (removed > 0) note("childrenDirSwept", { removed });
          if (failed > 0) note("childrenDirWarning", { cause: "消せない引き出しがある", failed });
        } catch (e) {
          note("childrenDirWarning", { cause: `掃除できない（${safeCauseOfChildrenDir(e)}）` });
        }
        // 判断の回答の指示が、記録と配送の間で途切れていたら、配送し直す（届けられなければ、受信箱に failure を出す）。
        const delivery = createInstructionDelivery({ log, clock });
        const recovered = await recoverAnswerDeliveries({
          log,
          clock,
          deliver: delivery.deliver,
          canDeliver: delivery.available,
          onFailure: (nodeId, cause) => note("answerDeliveryFailure", { nodeId, cause }),
        });
        for (const o of recovered) note("answerRecovered", { ...o });
        // 身元確認: 起動ごとに、新しい秘密を作り、待ち受けの前に、ファイルへ書く（異常終了で残った古いファイルは、上書きされる）。
        const identity = createIdentity();
        try {
          writeIdentityFile(identityPath, identity);
        } catch (e) {
          throw new Error(
            `身元の秘密のファイルを書けない（${String(e instanceof Error ? e.message : e)}）。stateDir の権限を確認する`,
          );
        }
        currentIdentity = identity;
        let listened: { port: number; url: string };
        try {
          listened = await server.listen(choice.port);
        } catch (e) {
          currentIdentity = undefined;
          removeIdentityFile(identityPath, identity);
          if (choice.source === "saved") {
            const cause = String(
              (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : e),
            );
            note("portUnavailable", { port: choice.port, source: choice.source, cause });
            throw savedPortUnavailable(choice.port, cause);
          }
          throw e;
        }
        if (choice.source === "new") {
          try {
            (deps.savePort ?? writeSavedPort)(portPath, listened.port);
          } catch (e) {
            const cause = String(e instanceof Error ? e.message : e);
            note("portSaveFailed", { port: listened.port, cause });
            // Desktop の子は、次の再起動でポートが変わると報告できなくなるので、起動を止める（呼び出し側が stop する）。
            // ほかは、保存できなくても起動は続ける（次回は、また新しいポートになる）。
            if (config.childRuntime === "desktop") throw portSaveFailed(listened.port, cause);
          }
        }
        const { port, url } = listened;
        running = { port, url, humanTokenPath, rootTokenPath, identityPath };
        // 待ち受けの後で、前回から残った、依存の揃った pending の子を起動する（子が窓口へ接続できるように）。
        void schedule();
        // トークンの期限の見回り: 使われずに放置された・役目の終わったトークンも失効させる。
        // 見張りの設定の見回り（フックの呼び出しとは別に、動いている Desktop の子の設定を数秒ごとに確かめる）
        if (desktopAdapter !== undefined) {
          hookWatch = setInterval(
            () => {
              try {
                checkAllHookSettings();
              } catch (e) {
                note("hookSettingsWarning", { cause: e instanceof Error ? e.name : "unknown" });
              }
            },
            (config.hookSettingsCheckSeconds ?? 2) * 1000,
          );
          hookWatch.unref();
        }
        tokenSweep = setInterval(() => {
          try {
            credentials.sweepExpired?.();
          } catch (e) {
            note("tokenSweepFailure", {
              cause: String((e as NodeJS.ErrnoException)?.code ?? "unknown"),
            });
          }
        }, TOKEN_SWEEP_MS);
        tokenSweep.unref();
        if (desktopAdapter === undefined) {
          cliWatchTimer = setInterval(runCliWatch, (config.cliWatch?.intervalSec ?? 60) * 1000);
          cliWatchTimer.unref();
        }
        autoPurger?.start();
        digestIssuer?.start();
        waker?.start();
        note("started", { port, portSource: choice.source, rootNodeId: config.rootNodeId });
        return running;
      },
      async stop() {
        if (tokenSweep !== undefined) clearInterval(tokenSweep);
        if (cliWatchTimer !== undefined) clearInterval(cliWatchTimer);
        cliWatchTimer = undefined;
        if (hookWatch !== undefined) clearInterval(hookWatch);
        hookWatch = undefined;
        tokenSweep = undefined;
        await waker?.stop(); // 実行中の 1 回が終わるのを待つ
        await digestIssuer?.stop(); // 実行中の 1 回が終わるのを待つ（終わる前に、ストアを閉じない）
        await autoPurger?.stop(); // 実行中の 1 回が終わるのを待つ（終わる前に、ストアを閉じない）
        await server.close();
        if (currentIdentity !== undefined) removeIdentityFile(identityPath, currentIdentity);
        currentIdentity = undefined;
        await closeScheduler(); // 起動の途中の tick が終わるのを待つ（終わる前に、タイマー・DB を閉じない）
        tracked.cancelAll(); // アダプタが作った、残りのタイマーを止める
        running = undefined;
        closeAll();
        note("stopped");
      },
    },
  };
}

/**
 * 画面に停止の宣言を出すかの判定。ハンドラ（`node.confirmStopped`）と同じく、能力表の `stopDelegated` だけで決める
 * （アダプタが子を管理しているかは見ない。daemon の再起動の後、管理が空でも、停止未完了のノードに出す）。
 */
export const stopDelegatedOf =
  (adapter: Pick<RuntimeAdapter, "capabilities">) =>
  (nodeId: string): boolean =>
    adapter.capabilities(nodeId).stopDelegated === true;
