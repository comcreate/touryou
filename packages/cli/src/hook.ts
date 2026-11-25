/**
 * `touryou hook`（Claude Code のフックのコマンド）。従来の `plugin/hooks/touryou-hook.mjs`（削除済み）と同じ判定を、同梱の Node で動く実行ファイルとして持つ
 * （利用者の機械に Node がなくても動く）。標準入力のフック入力（JSON）を、daemon の受け口（`POST /v1/hook`）に送り、判定を返す。依存なし。
 *
 * - 受け口の URL とトークンは、環境変数 `TOURYOU_DAEMON_URL`・`TOURYOU_NODE_TOKEN` で受ける（パスを埋め込まない。NFR_012）。
 * - どちらもなければ、touryou の子ではないセッションとみなし、素通しする（標準エラーに一言）。片方だけなら、設定の誤りとして拒否する。
 * - PreToolUse は、フェイルクローズ: daemon に届かない・時間切れ・200 以外・応答の形が違う・入力が JSON でない、のどれでも拒否する（終了コード 2）。
 * - Notificationは、daemon が入力待ちを受信箱に出す。止められないフックなので、受動のイベントとして扱う。
 * - Stop は、daemon が未読があると返したら、標準出力に `hookSpecificOutput.additionalContext` を出して、続けるよう促す。
 * - PostToolUse・Stop は、判定しない（拒否すると、作業を止められなくなるため）。失敗は、標準エラーに出すだけ（終了コード 0）。
 *   それ以外のイベント名・欠けた入力は、PreToolUse と同じく拒否する。
 * 終了コード 2 のとき、標準エラーの文が、拒否の理由として、モデルに伝わる。トークンの値は、出力に出さない。
 */

import { lstatSync, readFileSync } from "node:fs";
import { locateConfig, ownMcpToolOf, PLUGIN_NAME } from "@touryou/core";
import { type AclCheck, readSecureFile } from "@touryou/core/fs";

const defaultReadFile = (path: string): string => readFileSync(path, "utf8");
/** 印があるか。mcp の detectOpenMode と同じく、lstat が ENOENT・ENOTDIR 以外で失敗したときも、あるとみなす（子の側に倒す）。 */
const markExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
};
const TIMEOUT_MS = 5000;
const PREFIX = "[touryou hook]";

export interface HookInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 標準入力（読み取りの上限で切れていれば、先頭の部分）。 */
  readonly input: string;
  /** 標準入力が、読み取りの上限で切れた（途中までしか読めていない）。 */
  readonly truncated?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * ファイルを読む（トークンのない形で、daemon の窓口を、探した設定（TOURYOU_DAEMON_CONFIG → cwd から上の `.touryou/config.json`）の stateDir の port から知る）。
   * 読めなければ例外。既定は fs の readFileSync。
   */
  readonly readFile?: (path: string) => string;
  /** ファイルがあるか（子の作業ツリーの印・設定ファイルを上へ探すとき。既定は fs の lstat）。 */
  readonly exists?: (path: string) => boolean;
  /** 設定・port の ACL の確かめ（`readFile` を渡さないときに使う。既定は `defaultAclCheck`）。試験で差し替える。 */
  readonly acl?: AclCheck;
  /** 現在時刻（ミリ秒。再試行の予算の計算に使う。試験で差し替える）。 */
  readonly now?: () => number;
  /** 待つ（再試行の間。試験で差し替える）。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface HookResult {
  readonly code: 0 | 2;
  readonly stderr: string;
  /** 標準出力（Stop で続けるよう促すときの JSON）。 */
  readonly stdout?: string;
}

interface Classified {
  readonly event: unknown;
  /** 入力が、完全な JSON として読めた。 */
  readonly parsed: boolean;
  /** 判定するイベント（PreToolUse など）。受動のイベント（PostToolUse・Stop）だけが false。 */
  readonly guarding: boolean;
}

/** `hook_event_name` を、先頭の部分から拾う（切れた入力用）。Claude Code は、この項目を、大きな本文より前に置く。 */
const EVENT_RE = /"hook_event_name"\s*:\s*"([A-Za-z]+)"/;

function classify(input: string, truncated: boolean): Classified {
  let event: unknown;
  let parsed = false;
  if (truncated) {
    event = EVENT_RE.exec(input)?.[1];
  } else {
    try {
      event = (JSON.parse(input) as { hook_event_name?: unknown } | null)?.hook_event_name;
      parsed = true;
    } catch {
      parsed = false;
    }
  }
  // 受動のイベント（判定しない）だけを列挙し、それ以外（欠けている・未知・表記が違う）は、判定するものとして扱う（フェイルクローズ）。
  const passive = event === "PostToolUse" || event === "Stop" || event === "Notification";
  return { event, parsed, guarding: !passive };
}

const SILENT: HookResult = { code: 0, stderr: "" };

/**
 * touryou の子の作業ツリーの印（daemon の `CHILD_WORKTREE_MARKER` と同じ）。作業ツリーの git のディレクトリ
 * （`git rev-parse --absolute-git-dir`）の直下の `touryou-child`。中身はノード ID だが、ここでは、あるかどうかだけを見る。
 * `.git` のファイルの相対の gitdir は、そのファイルの場所から解く。
 */
export const CHILD_MARK = "touryou-child";

/** 作業ツリーの中を探す読み取りだけのコマンド（daemon が `permit: "readOnlySearch"` を付けた許可。#92）。理由は EXTENSION_ALLOW と同じ。 */
const SEARCH_ALLOW: HookResult = {
  code: 0,
  stderr: "",
  stdout: JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "touryou: 作業ツリーの中を探す読み取りだけのコマンドとして許可した",
    },
  }),
};

/**
 * 起動のあとに承認した拡張でだけ通る Bash（daemon が `permit: "extension"` を付けた許可。#91）。子は dontAsk で、起動のときの
 * 許可の一覧（`--settings`）に、あとから承認したコマンドがない。終了コード 0 だけでは Claude Code が一覧で断るので、明示の許可を返す。
 * 判定は daemon のフック（有効な範囲）が済ませている。deny の規則（禁止の場所の Edit・Read）は、Claude Code の側でそのまま効く（Claude Code の文書の hooks の `permissionDecision` と、permissions の「Precedence among rules, hooks, and mods」）。
 */
const EXTENSION_ALLOW: HookResult = {
  code: 0,
  stderr: "",
  stdout: JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "touryou: 承認済みの範囲の拡張で許可した",
    },
  }),
};

/**
 * 紐付けの前に、印のある作業ツリーでも通す道具か（印のある作業ツリーで、紐付けの前でも許す例外）。
 * - 紐付けを終えるための touryou の mcp の道具（`child_bind`・`whoami`）。plugin の mcp は `mcp__plugin_<plugin>_node__<道具>`、
 *   直に入れた mcp は `mcp__node__<道具>`。
 * - `ToolSearch`（読み取りだけ。mcp の道具が遅れて読み込まれるとき、child_bind の形を読むのに要る）。
 * - `Skill` のうち、touryou の plugin の skill（入力の `skill` が `<plugin>:` で始まる）だけ。ほかの skill は通さない。
 */
export const isBindTool = (toolName: unknown, toolInput?: unknown): boolean => {
  if (typeof toolName !== "string") return false;
  if (toolName === "ToolSearch") return true;
  if (toolName === "Skill") {
    const skill = (toolInput as { skill?: unknown } | null | undefined)?.skill;
    return (
      typeof skill === "string" &&
      skill.startsWith(`${PLUGIN_NAME}:`) &&
      skill.length > PLUGIN_NAME.length + 1
    );
  }
  const own = ownMcpToolOf(toolName);
  return own === "child_bind" || own === "whoami";
};

/**
 * cwd が touryou の子の作業ツリーの中か（印があるか）。cwd から上にたどって `.git` を探し、ファイル（`gitdir: <path>`。git worktree）
 * なら指す先、ディレクトリならそれを git のディレクトリとして、印があるかを見る。読めなければ偽。
 */
export function isTouryouWorktree(
  cwd: string,
  read: (path: string) => string,
  exists: (path: string) => boolean,
): boolean {
  if (!cwd.startsWith("/")) return false;
  let dir = cwd.replace(/\/+$/, "") || "/";
  for (let i = 0; i < 256; i++) {
    const dotGit = `${dir === "/" ? "" : dir}/.git`;
    let gitDir: string | undefined;
    try {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(read(dotGit));
      if (m?.[1] !== undefined) {
        gitDir = m[1].startsWith("/") ? m[1] : `${dir === "/" ? "" : dir}/${m[1]}`;
      }
    } catch {
      if (exists(dotGit)) gitDir = dotGit; // ディレクトリの .git（ふつうのリポジトリ）
    }
    if (gitDir !== undefined) return exists(`${gitDir.replace(/\/+$/, "")}/${CHILD_MARK}`);
    if (dir === "/") return false;
    dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
  }
  return false;
}
/** トークンのない形の 1 回の fetch の時間切れ（pnpm test のような重い処理と重なっても、1 回の遅れで拒否しない長さ）。 */
const SESSION_TIMEOUT_MS = 4000;
/**
 * 一時的な失敗（窓口が分からない・fetch の失敗）の再試行（印のある作業ツリーの PreToolUse だけ）。
 * 最悪の合計時間（hooks.json の PreToolUse の timeout 10 秒に収める）:
 *   1 回目: 窓口の確かめ（readSecureFile が /bin/ls を 2 回、各 2 秒の時間切れ）最悪 4 秒 + fetch 最悪 4 秒 = 8 秒
 *   再試行は「経過 + 待ち 0.3 秒 + 窓口の確かめの最悪 4 秒 + 最低の fetch 0.5 秒」が予算 9 秒に収まるときだけ行う。
 *   2 回目の fetch の時間切れは、残りの予算（最大 4 秒）に切り詰める。
 *   窓口の確かめは中断できない（同期）が、再試行の前に最悪を見込むので、合計は予算 9 秒 + 起動の余裕 1 秒 = 10 秒を超えない。
 */
const RETRY_WAIT_MS = 300;
const RETRY_BUDGET_MS = 9000;
const STATE_READ_WORST_MS = 4000;
const MIN_FETCH_MS = 500;
const MAX_ATTEMPTS = 2;
/** 一時的な失敗の種類（標準エラーと拒否の文に出す。値・パス・トークンは出さない）。 */
type TransientCause = "noUrl" | "connect" | "timeout";
const RETRY_ADVICE =
  "同じ操作を数十秒あけて 1 回だけ再試行する。直らなければ report_progress で親に知らせる";
const TRANSIENT_WHY: Record<TransientCause, string> = {
  noUrl: `届かない（窓口が分からない。一時的な失敗の可能性）。${RETRY_ADVICE}`,
  connect: `届かない（接続の失敗。一時的な失敗の可能性）。${RETRY_ADVICE}`,
  timeout: `届かない（時間切れ。一時的な失敗の可能性）。${RETRY_ADVICE}`,
};
/** 設定・port のファイルの大きさの上限。 */
const STATE_MAX_BYTES = 64 * 1024;

/**
 * 設定ファイル（共有関数 `locateConfig`: TOURYOU_DAEMON_CONFIG → cwd から上へ `<dir>/.touryou/config.json`）の stateDir の port から、
 * daemon の窓口を作る。設定が見つからない・確かめに通らないときは undefined（旧パス `$HOME/.touryou/config.json` へは戻らない）。
 * undefined のとき、印のある子の作業ツリーでは PreToolUse を拒み（フェイルクローズ）、touryou を使っていないフォルダでは何もしない。
 */
function daemonUrlFromState(
  env: HookInput["env"],
  cwd: string | undefined,
  exists: (path: string) => boolean,
  read: (path: string, forbid: number) => string,
): string | undefined {
  const located = locateConfig({ env, cwd, exists });
  if (!located.ok) return undefined;
  const configPath = located.path;
  const j = JSON.parse(read(configPath, 0o022)) as { stateDir?: unknown } | null;
  const stateDir = j?.stateDir;
  if (typeof stateDir !== "string" || !stateDir.startsWith("/")) return undefined;
  const port = read(`${stateDir.replace(/\/+$/, "")}/port`, 0o077).trim();
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return undefined;
  return `http://127.0.0.1:${Number(port)}`;
}

/**
 * トークンのない形（設計 6.4）。daemon が session_id で紐付けたノードを引く。
 * - daemon の窓口が分からない・届かない・形の違う応答・知らないセッション（`none`）は、何も出さずに 0（ふつうのセッションを妨げない）。
 * - `deny` は 2（理由つき）。Stop の `continue` は、標準出力に additionalContext。
 * - ただし cwd が touryou の子の作業ツリー（印がある）の中なら、daemon に届かない・応答が 200 でないときの PreToolUse は拒否する（フェイルクローズ）。
 */
async function sessionMode(
  deps: {
    readonly env: HookInput["env"];
    readonly input: string;
    readonly truncated: boolean;
    readonly fetchImpl: typeof fetch;
    readonly timeoutMs: number;
    readonly readFile: HookInput["readFile"];
    readonly exists: HookInput["exists"];
    readonly acl?: HookInput["acl"];
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
  },
  event: unknown,
  parsed: boolean,
): Promise<HookResult> {
  const read = deps.readFile ?? defaultReadFile;
  // 印のある作業ツリーの中（touryou の子）で daemon に届かないときは、PreToolUse を拒否する（フェイルクローズ）。印がなければ、何もしない
  const childTree = (): boolean => {
    if (event !== "PreToolUse") return false;
    try {
      const j = JSON.parse(deps.input) as {
        cwd?: unknown;
        tool_name?: unknown;
        tool_input?: unknown;
      };
      if (isBindTool(j.tool_name, j.tool_input)) return false;
      return typeof j.cwd === "string" && isTouryouWorktree(j.cwd, read, deps.exists ?? markExists);
    } catch {
      return false;
    }
  };
  // 設定を上へ探し始める場所: フック入力の cwd（セッションの作業場所）
  const inputCwd = (): string | undefined => {
    try {
      const c = (JSON.parse(deps.input) as { cwd?: unknown }).cwd;
      return typeof c === "string" ? c : undefined;
    } catch {
      return undefined;
    }
  };
  const unreachable = (why: string): HookResult =>
    childTree()
      ? {
          code: 2,
          stderr: `${PREFIX} 拒否: touryou の子の作業ツリーで、daemon に${why}。daemon が動いているか、人（親）に確かめてもらう`,
        }
      : SILENT;
  try {
    if (deps.truncated || !parsed) return unreachable("送れない（フック入力が読めない）");
    const readState =
      deps.readFile === undefined
        ? (path: string, forbid: number) =>
            readSecureFile(path, {
              forbid,
              maxBytes: STATE_MAX_BYTES,
              ...(deps.acl === undefined ? {} : { acl: deps.acl }),
            })
        : (path: string) => read(path);
    const started = deps.now();
    // 1 回の試み。窓口が分からない・fetch の失敗だけが一時的な失敗（原因を返す）。daemon が応答したら、200 でなくても応答を返す
    const attempt = async (): Promise<{ res: Response } | { cause: TransientCause }> => {
      let url: string | undefined;
      try {
        // 設定・port は、daemon の port-file.ts と同じ確かめ（リンクでない・持ち主・権限・ACL）をしてから読む。
        // 確かめに失敗したら窓口が分からない扱い（印のある作業ツリーでは拒む。印がなければ黙って通す）。
        url = daemonUrlFromState(deps.env, inputCwd(), deps.exists ?? markExists, readState);
      } catch {
        url = undefined;
      }
      if (url === undefined) return { cause: "noUrl" };
      const remaining = RETRY_BUDGET_MS - (deps.now() - started);
      try {
        const res = await deps.fetchImpl(`${url}/v1/hook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: deps.input,
          signal: AbortSignal.timeout(
            Math.max(MIN_FETCH_MS, Math.min(deps.timeoutMs, SESSION_TIMEOUT_MS, remaining)),
          ),
        });
        return { res };
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        return { cause: name === "TimeoutError" || name === "AbortError" ? "timeout" : "connect" };
      }
    };
    // 再試行するのは、子の作業ツリーの PreToolUse だけ（ふつうのセッションを待たせない）
    const retryable = event === "PreToolUse" && childTree();
    let outcome = await attempt();
    for (
      let n = 1;
      "cause" in outcome &&
      retryable &&
      n < MAX_ATTEMPTS &&
      deps.now() - started + RETRY_WAIT_MS + STATE_READ_WORST_MS + MIN_FETCH_MS <= RETRY_BUDGET_MS;
      n++
    ) {
      await deps.sleep(RETRY_WAIT_MS);
      outcome = await attempt();
    }
    if ("cause" in outcome) {
      if (retryable) process.stderr.write(`${PREFIX} 一時的な失敗: ${outcome.cause}\n`);
      return unreachable(TRANSIENT_WHY[outcome.cause]);
    }
    const res = outcome.res;
    if (res.status !== 200) return unreachable(`拒否された（HTTP ${res.status}）`);
    const j = (await res.json()) as {
      ok?: unknown;
      value?: {
        decision?: unknown;
        reason?: unknown;
        noneReason?: unknown;
        state?: unknown;
        permit?: unknown;
      };
    } | null;
    if (j?.ok !== true) return unreachable("届いたが、応答の形が正しくない");
    const decision = j.value?.decision;
    const reason = typeof j.value?.reason === "string" ? j.value.reason : "";
    if (decision === "deny" && event === "PreToolUse") {
      return { code: 2, stderr: reason === "" ? "範囲外の操作" : reason };
    }
    if (decision === "allow" && event === "PreToolUse" && j.value?.permit === "readOnlySearch") {
      return SEARCH_ALLOW;
    }
    if (decision === "allow" && event === "PreToolUse" && j.value?.permit === "extension") {
      return EXTENSION_ALLOW;
    }
    // 印のある作業ツリーの PreToolUse は、daemon が許可（allow）したときだけ通す。none（紐付けの前・外れた・ノードが動いていない・
    // cwd が合わない）は拒否する。例外は、紐付けを終えるための touryou の mcp の道具だけ
    if (event === "PreToolUse" && decision !== "allow" && childTree()) {
      return {
        code: 2,
        stderr: `${PREFIX} 拒否: ${noneMessage(j.value?.noneReason, j.value?.state)}`,
      };
    }
    if (decision === "continue" && event === "Stop" && reason !== "") {
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "Stop", additionalContext: reason },
        }),
      };
    }
    return SILENT;
  } catch {
    return unreachable("届いたが、応答を読めない");
  }
}

/**
 * 印のある作業ツリーで daemon が none を返したときの拒否の文。daemon の理由（noneReason）で出し分ける。
 * 古い daemon が理由を返さないとき・unbound のときは、child_bind の案内。
 */
export function noneMessage(noneReason: unknown, state: unknown): string {
  if (noneReason === "notLive") {
    const s =
      typeof state === "string" && /^[a-z]{1,32}$/.test(state) ? state : "running・waiting 以外";
    return `紐付けは済んでいる。状態が ${s} なので、作業の道具は止めている。親の判断（差し戻しなど）を待つ`;
  }
  if (noneReason === "cwdMismatch") {
    return "cwd が子の作業ツリーの外にある。作業ツリーの中で実行する";
  }
  const bindTool = `mcp__plugin_${PLUGIN_NAME}_node__child_bind`;
  return `touryou の子の作業ツリーで、まだ紐付けが済んでいない（または、紐付けが外れた・daemon がこのセッションを子と認めない）。先に ${bindTool} を引数なしで呼ぶ。それでも通らないときは、自分で原因を探したり別の手を試したりしない。つなぎ直せなければ、daemon が親の受信箱に「紐付けをやり直して」を出すので、親が紐付けを出し直す（node_bindCode）まで待つ`;
}

/** フックを 1 回実行する。例外を出さない（予期しない失敗も、PreToolUse は拒否・受動のイベントは通す）。 */
export async function runHook(deps: HookInput): Promise<HookResult> {
  const c = classify(deps.input, deps.truncated === true);
  try {
    return await decide(deps, c);
  } catch {
    return c.guarding
      ? { code: 2, stderr: `${PREFIX} 拒否: 予期しない失敗（人に知らせる）` }
      : { code: 0, stderr: `${PREFIX} 記録できなかった（予期しない失敗）` };
  }
}

async function decide(
  deps: HookInput,
  { event, parsed, guarding }: Classified,
): Promise<HookResult> {
  const { env, input, truncated = false, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = deps;
  const fail = (why: string): HookResult =>
    guarding
      ? { code: 2, stderr: `${PREFIX} 拒否: ${why}` }
      : { code: 0, stderr: `${PREFIX} ${String(event)} を記録できなかった: ${why}` };

  const url = env.TOURYOU_DAEMON_URL ?? "";
  const token = env.TOURYOU_NODE_TOKEN ?? "";
  if (url === "" && token === "") {
    // トークンのない形（`claude --bg` の子）。紐付けの前・touryou と関係のないセッションでは、何も出さずに終わる
    return sessionMode(
      {
        env,
        input,
        truncated,
        fetchImpl,
        timeoutMs,
        readFile: deps.readFile,
        exists: deps.exists,
        acl: deps.acl,
        now: deps.now ?? Date.now,
        sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      },
      event,
      parsed,
    );
  }
  if (url === "" || token === "") {
    const both = "TOURYOU_DAEMON_URL と TOURYOU_NODE_TOKEN の片方だけが設定されている";
    return fail(
      url === ""
        ? `${both}。touryou の子なら TOURYOU_DAEMON_URL も設定して、子でなければ unset TOURYOU_NODE_TOKEN して、起動し直す`
        : `${both}。統合セッションなら unset TOURYOU_DAEMON_URL して、touryou の子なら TOURYOU_NODE_TOKEN も設定して、起動し直す（TOURYOU_DAEMON_URL は touryou-mcp の起動だけに使う）`,
    );
  }
  // 入力が大きすぎて切れた: 切れた JSON は、daemon に送れない。受動のイベントは止めず（従来の touryou-hook.mjs は、全部送って daemon の 413 を、受動なので 0 にする）、判定するものは拒否する
  if (truncated) return fail("フック入力が大きすぎて、最後まで読めない");
  if (!parsed) return fail("フック入力が JSON でない");

  let res: Response;
  try {
    res = await fetchImpl(`${url.replace(/\/+$/, "")}/v1/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: input,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    return fail(`daemon の受け口に届かない（${name}）。daemon が動いているか確かめる`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const j = (typeof json === "object" && json !== null ? json : {}) as {
    ok?: unknown;
    value?: { decision?: unknown; reason?: unknown; permit?: unknown };
    error?: { cause?: unknown };
  };
  if (res.status !== 200 || j.ok !== true) {
    const cause = typeof j.error?.cause === "string" ? `: ${j.error.cause}` : "";
    return fail(`daemon が拒否した（HTTP ${res.status}${cause}）`);
  }
  const decision = j.value?.decision;
  if (decision === "allow" && event === "PreToolUse" && j.value?.permit === "readOnlySearch") {
    return SEARCH_ALLOW;
  }
  if (decision === "allow" && event === "PreToolUse" && j.value?.permit === "extension") {
    return EXTENSION_ALLOW;
  }
  if (decision === "allow") return { code: 0, stderr: "" };
  if (decision === "continue" && event === "Stop") {
    const reason = typeof j.value?.reason === "string" ? j.value.reason : "";
    if (reason === "") return { code: 0, stderr: "" };
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "Stop", additionalContext: reason },
      }),
    };
  }
  if (decision === "deny" && guarding) {
    const reason = typeof j.value?.reason === "string" ? j.value.reason : "範囲外の操作";
    return { code: 2, stderr: reason };
  }
  return fail("daemon の応答の形が正しくない");
}
