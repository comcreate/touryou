/**
 * フック（PreToolUse）の判定。ツール呼び出しを、core の `evaluateScope`（作業範囲の判定）に対応づける純粋関数。
 * PRD: FR_014, IR_002 / design 6.4
 *
 * - 読み込み系（Read・Glob・Grep・NotebookRead）と、読み取りのみで無害なツール（LS・TodoWrite・ToolSearch・BashOutput）は
 *   許可（FR_014: 読み込みは制限しない）。**例外**: 禁じる場所（stateDir・daemon の設定ファイル。`ProtectedPaths`）は、読み取りも
 *   拒否する。Bash は、語のうちパスに見えるものだけを見る歯止めで、確実ではない（`docs/desktop-runtime.md`）。許可するツール名は、確かめたうえで固定する。
 * - 書き込み系（Write・Edit・MultiEdit・NotebookEdit）は、対象のパス（絶対にして、最も深い既存の祖先を実パスにしたもの。
 *   リンク経由の範囲外への書き込みを防ぐ）を書き込みとして判定する。解決に失敗したら拒否する。
 *   フック入力の `cwd`（`HookInput.cwd`）は使わない。基準は、起動時に実パスにした作業ツリー。
 * - Bash は、コマンドとして判定する。`run_in_background` が `undefined`・`false` 以外、
 *   `dangerouslyDisableSandbox` が `true` なら拒否する（ADR 未決の既定）。
 * - 自ノードの MCP ツールは、子のロールの道具だけ（`mcp__node__<道具>`・`mcp__plugin_<plugin>_node__<道具>`）を許可する。権限の絞り込みは窓口のロール別の操作表（NFR_004）の責務。
 * - それ以外（別の MCP サーバー、サブエージェント、ウェブ、未知のツール）は拒否する（フェイルクローズ）。
 *   範囲の違反ではないため `violation` は持たず（`unknownTool`）、`scope.violation` として記録しない（受信箱に載せない）。
 * 例外を出さない: 入力の形が不正なら拒否する。
 */

import { stat } from "node:fs/promises";
import {
  CHILD_MCP_TOOL_NAMES,
  commandWords,
  entryWords,
  evaluateScope,
  ownMcpToolOf,
  type Scope,
  type ScopeViolationReason,
} from "@touryou/core";
import { commandEntryProblem } from "./child-permissions.js";

/** パスの実パス化（書き込み先の判定用）。解決できなければ reject する。 */
export type ResolvePath = (absPath: string) => Promise<string>;

export interface ToolViolation {
  readonly reason: ScopeViolationReason;
  /** 違反した場所またはコマンド（記録用）。 */
  readonly subject: string;
}

export type ToolDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      /** 範囲の違反（記録する）。未知のツールの拒否では持たない。 */
      readonly violation?: ToolViolation;
      /** 許可していないツールの名前（範囲の違反ではない）。 */
      readonly unknownTool?: string;
      /** モデルへ伝える理由（フックの拒否の理由）。 */
      readonly reason: string;
    };

const ALLOW: ToolDecision = { allow: true };

/**
 * 読み取りも禁じる場所（FR_014 の例外）。daemon が起動時に実パスにしたものを、全ノードで共通に使う。
 * `allow` は、禁じる場所の中で、そのノードに読み取りを許す場所（自分の HOME・子に渡す skill の写し）。
 */
export interface ProtectedPaths {
  readonly roots: readonly { readonly path: string; readonly kind: ProtectedKind }[];
  readonly allow: readonly string[];
  /** 子のシェルが `~` を展開する先（子の HOME）。なければ `~` で始まる語は禁じる場所の判定から外れない（拒否する）。 */
  readonly home?: string | undefined;
  /**
   * そのノード自身の引き出し（`<D>/<鍵>`。実パス）。禁じる場所の中のまま、次の 2 つだけを許す:
   * Bash の `touryou child bind|report` の `--dir` の値（引き出しそのもの。中のファイルの語は許さない〔token とその一時ファイルを含む〕）と、
   * Write の道具で `<引き出し>/code` を書くこと。読み取りの道具（Read・Glob・Grep など）は許さない（token をモデルに読ませない）。
   * ほかのノードの引き出しは、禁じる場所のまま。
   */
  readonly drawer?: string | undefined;
  /** 作業ツリー（実パス）。あれば、Bash の `cd`・`pushd` の行き先がこの外なら拒否する（outsideWorktree）。 */
  readonly worktree?: string | undefined;
  /** daemon の環境の CDPATH。あれば、`./` などで始まらない相対の `cd` を拒否する（子の環境は分からないため）。 */
  readonly cdpath?: string | undefined;
  /**
   * `touryou` を起動する語（設定 `touryouCommand` を語に分けたもの。例: `["node", "/opt/touryou/bin.js"]`）。`drawer` の例外は、区切りの先頭の
   * 語がこれと一致し、続く 2 語が `child` と `bind`・`report` のときだけ効く。なければ、先頭の語が `touryou`（または末尾が `/touryou`）のとき。
   */
  readonly touryouCommand?: readonly string[] | undefined;
  /**
   * 書き込みだけを禁じる場所（読み取りは許す。Desktop の子の作業ツリーの `.claude/`。見張りの設定を書き換えさせない）。
   * 書き込みの道具は、範囲の決まりによらず拒否する。
   */
  readonly writeDenied?: readonly string[] | undefined;
}

/** 区切りの語が `touryou child bind|report …` か（`touryouCommand` と一致する先頭・`child`・`bind|report`）。 */
function isTouryouChildCommand(words: readonly string[], p: ProtectedPaths): boolean {
  const head =
    p.touryouCommand !== undefined && p.touryouCommand.length > 0
      ? p.touryouCommand
      : words[0] === "touryou" || (words[0]?.endsWith("/touryou") ?? false)
        ? [words[0] as string]
        : undefined;
  if (head === undefined || words.length < head.length + 2) return false;
  if (head.some((w, i) => words[i] !== w)) return false;
  const sub = words[head.length + 1];
  return words[head.length] === "child" && (sub === "bind" || sub === "report");
}

/** 引き出しの中で、子が Write で書いてよいファイル（紐付けのコードと、報告の本文）。 */
export const DRAWER_WRITABLE_FILES = ["code", "report"] as const;
/** 禁じる場所の種類（拒否の文面と記録には、種類だけを出す。実パスは出さない）。 */
export type ProtectedKind =
  | "stateDir"
  | "daemonConfig"
  | "processEnv"
  | "hookSettings"
  | "hookSettingsWrite"
  | "outsideWorktree"
  /** ほかのノードの作業ツリーの git のディレクトリ（`.git/worktrees/<ほかの名前>/`。紐付けのコードのファイルがある）。 */
  | "otherNodeGitDir";
const KIND_TEXT: Readonly<Record<ProtectedKind, string>> = {
  stateDir: "daemon の状態の置き場",
  daemonConfig: "daemon の設定ファイル",
  processEnv: "プロセスの環境変数（/proc の environ）",
  hookSettings: "見張り（フック）の設定",
  hookSettingsWrite: "見張り（フック）の設定の置き場",
  outsideWorktree: "作業ツリーの外",
  otherNodeGitDir: "ほかのノードの作業ツリーの git のディレクトリ",
};

// APFS は大文字小文字・Unicode の正規化（NFD/NFC）の違いを区別しないので、比べる前にそろえる（区別する FS では、厳しめに倒れる）。
const fold = (x: string): string => x.normalize("NFC").toLowerCase();
const under = (p: string, root: string): boolean => {
  const a = fold(p);
  const b = fold(root);
  return a === b || a.startsWith(`${b}/`);
};
/** グロブ・波括弧・拡張グロブ（`@( +( !( ?( *(`）の文字。 */
const GLOB = /[*?[{]|[@+!?*]\(/;
const PROC_ENVIRON = /^\/proc\/(?:self|thread-self|\d+)(?:\/task\/\d+)?\/environ$/;
const PROC_DIR = /^\/proc\/(?:self|thread-self|\d+)(?:\/task(?:\/\d+)?)?$/;
/** 波括弧の展開の候補の上限（超えたら確かめきれないので拒否する）。 */
const BRACE_MAX = 64;

/**
 * 実パス `real` が、禁じる場所の中（`ancestorToo` なら、禁じる場所を含む祖先も）なら、その種類。許された場所の中なら undefined。
 * 祖先も禁じるのは、再帰的に読む道具（Glob・Grep・Bash の grep -r など）で、禁じる場所の中まで読まれるため。
 */
function protectedKind(
  real: string,
  p: ProtectedPaths,
  ancestorToo: boolean,
): ProtectedKind | undefined {
  if (p.allow.some((a) => under(real, a))) return undefined;
  // Linux の /proc の environ（自分と、ほかのプロセスの環境変数。子のトークン〔TOURYOU_MCP_TOKEN〕を含む）。
  // 再帰で読む道具は、/proc と、その下のプロセスのディレクトリも祖先として拒否する。
  if (PROC_ENVIRON.test(real)) return "processEnv";
  if (ancestorToo && (real === "/proc" || PROC_DIR.test(real))) return "processEnv";
  for (const r of p.roots) {
    if (under(real, r.path)) return r.kind;
    if (ancestorToo && (real === "/" || fold(r.path).startsWith(`${fold(real)}/`))) return r.kind;
  }
  return undefined;
}

const denyProtected = (kind: ProtectedKind): ToolDecision => ({
  allow: false,
  violation: { reason: "forbiddenLocation", subject: `protected:${kind}` },
  reason:
    kind === "outsideWorktree"
      ? "作業範囲の外の操作です（cd・pushd で作業ツリーの外に移ることはできません）。作業は作業ツリーの中で行ってください。"
      : kind === "hookSettingsWrite"
        ? `作業範囲の外の操作です（${KIND_TEXT[kind]}は、Bash では名前も使えず、消す・動かすコマンドで作業ツリーごと扱うこともできません。読むときは Read の道具を使う）。`
        : `作業範囲の外の操作です（${KIND_TEXT[kind]}は、読み取りもできません）。この場所は、作業に使いません。`,
});

/** グロブの 1 段（`*`・`?`・`[...]`）を正規表現にする。拡張グロブ・波括弧は、ここでは扱わない（呼ぶ前に展開・拒否する）。 */
function globSegment(seg: string): RegExp {
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] as string;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const j = seg.indexOf("]", i + 1);
      if (j < 0) re += "\\[";
      else {
        const body = seg
          .slice(i + 1, j)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        re += `[${body}]`;
        i = j;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

/**
 * 語（cwd からの相対・絶対、グロブを含む）が、書き込みを禁じる場所 `w`（実パス）そのもの・その中・その祖先に当たりうるか
 * （`rm -rf .claude`・`.cla*`・`mv .claude x` などの、`/` を含まない語も見る）。
 */
async function wordHitsWriteDenied(
  word: string,
  cwds: readonly string[],
  denied: readonly string[],
  resolve: ResolvePath,
): Promise<boolean> {
  const candidates = expandBraces(word) ?? [word];
  for (const c of candidates) {
    for (const cwd of c.startsWith("/") ? [cwds[0] ?? "/"] : cwds) {
      const abs = c.startsWith("/") ? c : `${cwd}/${c}`;
      if (!GLOB.test(abs)) {
        let real: string;
        try {
          real = await resolve(abs);
        } catch {
          continue;
        }
        if (denied.some((w) => under(real, w))) return true;
        continue;
      }
      // グロブ: 固定の部分を実パスにし、残りの段を、禁じる場所までの段と突き合わせる
      const parts = abs.split("/");
      const i = parts.findIndex((x) => GLOB.test(x));
      let base: string;
      try {
        base = await resolve(parts.slice(0, i).join("/") || "/");
      } catch {
        continue;
      }
      const rest = parts.slice(i).filter((x) => x !== "");
      for (const w of denied) {
        if (!under(w, base) || fold(w) === fold(base)) continue;
        const rel = w
          .slice(base.length)
          .split("/")
          .filter((x) => x !== "");
        const n = Math.min(rel.length, rest.length);
        let all = n > 0;
        for (let k = 0; k < n && all; k++) {
          if (!globSegment(rest[k] as string).test(rel[k] as string)) all = false;
        }
        if (all) return true;
      }
    }
  }
  return false;
}

/** git の大域のオプションのうち、値をとるもの。 */
const GIT_VALUE_OPTIONS = [
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
] as const;
/** 書かせない git の設定の鍵（エイリアス、設定の読み込み〔include.path・includeIf.*〕）。大文字・小文字を問わない。 */
const GIT_DENIED_CONFIG = /^(?:alias|include|includeif)\./i;
/** `git config` の読むだけの指定（alias.* を読むのは許す）。 */
const GIT_CONFIG_READ: ReadonlySet<string> = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
  "get",
  "list",
]);
/** 値がパスのもの（禁じる場所・作業ツリーの外を指せば拒否する）。 */
const GIT_PATH_OPTIONS: ReadonlySet<string> = new Set(["-C", "--git-dir", "--work-tree"]);

/** 消す・動かす・権限を変えるコマンド（作業ツリーそのもの・その親を対象にしたら拒否する）。 */
const DESTRUCTIVE = new Set(["rm", "rmdir", "mv", "chmod", "chown", "chflags", "unlink", "shred"]);

/**
 * 波括弧を展開する（入れ子・カンマ・`a..b` の並びを含む）。候補が多すぎる・対応が取れないときは undefined（確かめきれない）。
 * 展開できない形の `{`（`{}` など）は、そのまま残る。
 */
export function expandBraces(word: string): string[] | undefined {
  let out = [word];
  for (let guard = 0; guard < 16; guard++) {
    const next: string[] = [];
    let changed = false;
    for (const w of out) {
      const e = expandOnce(w);
      if (e === "bad") return undefined;
      if (e === null) next.push(w);
      else {
        changed = true;
        next.push(...e);
      }
      if (next.length > BRACE_MAX) return undefined;
    }
    out = next;
    if (!changed) return out;
  }
  return undefined;
}

/** いちばん外側の、最初の展開できる `{…}` を 1 つ展開する。なければ null。 */
function expandOnce(w: string): string[] | null | "bad" {
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== "{") continue;
    let depth = 0;
    const commas: number[] = [];
    let j = i;
    for (; j < w.length; j++) {
      const c = w[j];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      } else if (c === "," && depth === 1) commas.push(j);
    }
    if (j >= w.length) return "bad"; // 閉じていない
    const body = w.slice(i + 1, j);
    const pre = w.slice(0, i);
    const post = w.slice(j + 1);
    if (commas.length > 0) {
      const parts: string[] = [];
      let k = i + 1;
      for (const c of commas) {
        parts.push(w.slice(k, c));
        k = c + 1;
      }
      parts.push(w.slice(k, j));
      return parts.map((x) => pre + x + post);
    }
    const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(\.\.-?\d+)?$/.exec(body);
    if (range !== null) return "bad"; // 並びの展開は、候補が多くなりうるので確かめない（拒否）
    // `{}`・`{x}` は展開されない。次の `{` を探す
    i = j;
  }
  return null;
}

/** 語の固定の部分（最初のグロブの文字を含む段より前）。 */
const fixedPrefix = (word: string): string => {
  if (!GLOB.test(word)) return word;
  const parts = word.split("/");
  const i = parts.findIndex((x) => GLOB.test(x));
  const head = parts.slice(0, i).join("/");
  return head === "" ? (word.startsWith("/") ? "/" : ".") : head;
};

/**
 * パスを、禁じる場所と照らす。波括弧は展開して、候補をすべて確かめる。`~` と `~/…` は子の HOME で展開し、それ以外の `~`
 * で始まる形（`~root`・`~+`・`~-` など）は確かめきれないので拒否する。実パスにできなければ拒否する（フェイルクローズ）。
 */
async function checkProtectedPath(
  raw: string,
  cwds: readonly string[],
  p: ProtectedPaths,
  resolve: ResolvePath,
  ancestorToo: boolean,
): Promise<ProtectedKind | "unresolvable" | undefined> {
  const candidates = expandBraces(raw);
  if (candidates === undefined) return "unresolvable";
  for (const c of candidates) {
    let path = fixedPrefix(c);
    const glob = path !== c;
    if (path.startsWith("~")) {
      if (!(path === "~" || path.startsWith("~/")) || p.home === undefined) return "unresolvable";
      path = p.home + path.slice(1);
    }
    for (const cwd of path.startsWith("/") ? [cwds[0] ?? "/"] : cwds) {
      const abs = path.startsWith("/") ? path : `${cwd}/${path}`;
      let real: string;
      try {
        real = await resolve(abs);
      } catch {
        return "unresolvable";
      }
      const k = protectedKind(real, p, ancestorToo || glob);
      if (k !== undefined) return k;
    }
  }
  return undefined;
}

/** 語が、そのノード自身の引き出しそのもの（中のファイルではない）か。グロブ・波括弧・`~` は認めない。 */
async function isDrawer(w: string, p: ProtectedPaths, resolve: ResolvePath): Promise<boolean> {
  if (p.drawer === undefined || !w.startsWith("/") || GLOB.test(w) || w.includes("{")) return false;
  try {
    return fold(await resolve(w)) === fold(p.drawer);
  } catch {
    return false;
  }
}

/** 語がパスに見えるか（/ を含む・~ で始まる・. と ..）。 */
const pathLike = (x: string): boolean =>
  x === "." || x === ".." || x.includes("/") || x.startsWith("~");

/** `cd`・`pushd` の行き先の語（`~` は子の HOME に展開）。確かめきれない形は "unresolvable"。 */
function cdDest(words: readonly string[], p: ProtectedPaths): string | "unresolvable" {
  // `-L` と `--` のほかのオプション（`-P`・`-e`・`-@` など。`-P` は実パスで辿るので、字句の上のパスと食い違う）と、
  // pushd の `+N`・`-N`（スタックの回転）は、確かめきれない
  if (
    words
      .slice(1)
      .some(
        (x) => (x.startsWith("-") && x !== "-" && x !== "-L" && x !== "--") || /^[+-]\d+$/.test(x),
      )
  )
    return "unresolvable";
  // 引数なしの pushd は、先頭の 2 つの入れ替え（行き先は、スタックの中身）
  if (words[0] === "pushd" && words.length === 1) return "unresolvable";
  const args = words.slice(1).filter((x) => !(x.startsWith("-") && x !== "-"));
  const target = args[0];
  if (args.length > 1 || target === "-" || (target !== undefined && GLOB.test(target)))
    return "unresolvable";
  let dest: string | undefined = target ?? p.home;
  if (target?.startsWith("~") === true) {
    if (!(target === "~" || target.startsWith("~/")) || p.home === undefined) return "unresolvable";
    dest = p.home + target.slice(1);
  }
  if (dest === undefined) return "unresolvable";
  // CDPATH があると、`./` や `/` で始まらない相対の行き先は、別の場所に移りうる（子の環境は分からないので、daemon の環境の CDPATH で見る）
  if (
    p.cdpath !== undefined &&
    p.cdpath !== "" &&
    !(dest.startsWith("/") || dest === "." || dest === ".." || /^\.{1,2}\//.test(dest))
  )
    return "unresolvable";
  return dest;
}

/** `/` 区切りの字句の上で `.` と `..` を畳む（リンクは辿らない。bash の `cd` の既定〔-L〕と同じ）。 */
function lexical(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/**
 * `cd`・`pushd` の行き先のすべて（字句の上のパス。次の cd の基準になる）。行き先は、字句の上のパスと実パスの両方が作業ツリーの中で、
 * ディレクトリでなければならない（作業ツリーの外なら "outsideWorktree"、ディレクトリでない・確かめきれないなら "unresolvable"）。
 */
async function cdOutside(
  dest: string,
  bases: readonly string[],
  p: ProtectedPaths,
  resolve: ResolvePath,
): Promise<string[] | "outsideWorktree" | "unresolvable"> {
  const out: string[] = [];
  for (const base of dest.startsWith("/") ? [bases[0] ?? "/"] : bases) {
    const logical = lexical(dest.startsWith("/") ? dest : `${base}/${dest}`);
    let real: string;
    try {
      real = await resolve(logical);
      if (!(await stat(real)).isDirectory()) return "unresolvable";
    } catch {
      return "unresolvable";
    }
    if (p.worktree !== undefined && !(under(logical, p.worktree) && under(real, p.worktree)))
      return "outsideWorktree";
    out.push(logical);
  }
  return out;
}

/**
 * Bash の命令の、パスに見える語を、禁じる場所と照らす。
 * - 語全体に加えて、語の中の `/` のたびに、その位置から後ろも絶対パスとして確かめる（`-C/path`・`a=b=/p`・`x:/p` など）。
 *   語の途中から切り出した部分は、祖先の判定をしない（`src/` の末尾の `/` などで、作業を妨げないため）。
 * - `cd`・`pushd` を順に追い、相対の語は、元の作業ツリーと、それまでに移った先のすべてを基準に確かめる（パイプの中の cd は
 *   続かないが、厳しめに倒す）。行き先を確かめきれない `cd`（`cd -`・`popd`・グロブなど）は拒否する。
 */
async function checkBash(
  command: string,
  cwd: string,
  p: ProtectedPaths,
  resolve: ResolvePath,
): Promise<ProtectedKind | "unresolvable" | "cdUnresolvable" | undefined> {
  const segs = commandWords(command);
  if (segs === undefined) return undefined; // 解析できない命令は、範囲の判定が拒否する
  const cwds: string[] = [cwd];
  // 作業ツリーの外に出る cd の判定用の、いまいる場所（字句の上のパス）の候補。`|`・`||`・`;`・改行があると、cd が続かない・失敗して
  // 元の場所に残ることがあるので、足していく（厳しめ。引用符の中の `|` も数える既知の近似）。`&&` だけなら、移った先に置き換える。
  const union = /[|;\n]/.test(command);
  let cur: string[] = [cwd];
  for (const words of segs) {
    const name = words[0];
    if ((name === "cd" || name === "pushd") && p.worktree !== undefined) {
      const dest = cdDest(words, p);
      if (dest === "unresolvable") return "cdUnresolvable";
      const out = await cdOutside(dest, cur, p, resolve);
      if (out === "unresolvable") return "cdUnresolvable";
      if (out === "outsideWorktree") return out;
      cur = union ? [...cur, ...out] : out;
    }
    if (name === "popd") return "cdUnresolvable";
    // 書き込みを禁じる場所（作業ツリーの .claude/）があるときの、Bash の守り
    const denied = p.writeDenied ?? [];
    if (denied.length > 0) {
      // git clean・git stash --all/-a/-u は、追跡していないファイルを消す・退避する。禁じる場所が作業ツリーの中にある
      // （Desktop の子の .claude/）ときは、対象を問わず拒否する。禁じる場所がすべて作業ツリーの外か `<作業ツリー>/.git`（git clean
      // では消えない）だけ（CLI の子）なら、作業ツリーの中だけを対象にするので許す
      const wt = p.worktree;
      // git の大域のオプション（-C・-c・--git-dir・--work-tree など）を読み飛ばしてから副コマンドを取る。-C・--git-dir・
      // --work-tree の値が、禁じる場所か作業ツリーの外を指すなら拒否する
      let sub: string | undefined;
      let subAt = -1;
      if (name === "git") {
        for (let k = 1; k < words.length; k++) {
          const w = words[k] as string;
          // `--exec-path` は値なしでも使える（場所を表示する）ので、`=` つきのときだけ値をとる
          const withValue = GIT_VALUE_OPTIONS.find(
            (o) => (w === o && o !== "--exec-path") || w.startsWith(`${o}=`),
          );
          if (withValue !== undefined) {
            const value = w === withValue ? words[++k] : w.slice(withValue.length + 1);
            if (value === undefined) return "unresolvable";
            // `-c alias.名前=…`・`--config-env=alias.…` で、その場のエイリアスを作らせない（エイリアスで worktree などを隠せる）
            if (
              (withValue === "-c" || withValue === "--config-env") &&
              GIT_DENIED_CONFIG.test(value)
            ) {
              return "hookSettingsWrite";
            }
            if (GIT_PATH_OPTIONS.has(withValue)) {
              if (await wordHitsWriteDenied(value, cwds, denied, resolve))
                return "hookSettingsWrite";
              if (wt !== undefined) {
                let real: string;
                try {
                  real = await resolve(
                    value.startsWith("/") ? value : `${cwds[0] ?? "/"}/${value}`,
                  );
                } catch {
                  return "unresolvable";
                }
                if (!under(real, wt)) return "hookSettingsWrite";
              }
            }
            continue;
          }
          if (w.startsWith("-")) continue;
          sub = w;
          subAt = k;
          break;
        }
      }
      const after = subAt < 0 ? [] : words.slice(subAt + 1);
      // git clean・git stash --all/-a/-u は、追跡していないファイルを消す・退避する。禁じる場所が作業ツリーの中にある
      // （Desktop の子の .claude/）ときは、対象を問わず拒否する。禁じる場所がすべて作業ツリーの外か `<作業ツリー>/.git`（git clean
      // では消えない）だけ（CLI の子）なら、作業ツリーの中だけを対象にするので許す
      const insideDenied =
        wt === undefined ||
        denied.some((d) => under(d, wt) && fold(d) !== fold(`${wt.replace(/\/+$/, "")}/.git`));
      if (
        insideDenied &&
        name === "git" &&
        (sub === "clean" ||
          (sub === "stash" &&
            after.some((w) => ["--all", "-a", "-u", "--include-untracked"].includes(w))))
      ) {
        return "hookSettingsWrite";
      }
      // `git config` で alias.* を書く操作を拒む（--global・--local・--file を問わない）。読むだけ（--get 系・--list）は許す
      if (
        name === "git" &&
        sub === "config" &&
        after.some((w) => GIT_DENIED_CONFIG.test(w)) &&
        !after.some((w) => GIT_CONFIG_READ.has(w))
      ) {
        return "hookSettingsWrite";
      }
      // git worktree の書き換え（remove・move・prune・repair・add・lock・unlock）は、作業ツリーの git のディレクトリ（印がある）を
      // 消す・動かすので拒否する（list だけ許す）
      if (
        name === "git" &&
        sub === "worktree" &&
        after.find((w) => !w.startsWith("-")) !== "list"
      ) {
        return "hookSettingsWrite";
      }
      const destructive =
        (name !== undefined && DESTRUCTIVE.has(name)) ||
        (name === "find" && words.includes("-delete"));
      for (const [i, w] of words.entries()) {
        if (i === 0) continue;
        if (await wordHitsWriteDenied(w, cwds, denied, resolve)) return "hookSettingsWrite";
        // `of=パス`・`--output=パス` のような、`=` の右側のパスも見る
        const eq = w.indexOf("=");
        if (eq >= 0 && eq < w.length - 1) {
          if (await wordHitsWriteDenied(w.slice(eq + 1), cwds, denied, resolve)) {
            return "hookSettingsWrite";
          }
        }
        // 消す・動かすコマンドが、作業ツリーそのもの・その親（禁じる場所の祖先）を対象にした
        if (destructive && !w.startsWith("-")) {
          for (const cwd of w.startsWith("/") ? [cwds[0] ?? "/"] : cwds) {
            let real: string;
            try {
              real = await resolve(w.startsWith("/") ? w : `${cwd}/${w}`);
            } catch {
              continue;
            }
            if (denied.some((d) => under(d, real))) return "hookSettingsWrite";
          }
        }
      }
    }
    // `touryou child bind|report --dir <自分の引き出し>` の値だけは、禁じる場所の判定から外す。この命令の --dir は、
    // 自分の引き出しそのものでなければ拒否する。`--dir=値` の形も拒否する（値を別の語にする）
    const childCommand = isTouryouChildCommand(words, p);
    for (const [i, w] of words.entries()) {
      if (childCommand) {
        if (w.startsWith("--dir=")) return "unresolvable";
        if (words[i - 1] === "--dir") {
          if (await isDrawer(w, p, resolve)) continue;
          return "unresolvable";
        }
      }
      if (pathLike(w)) {
        const k = await checkProtectedPath(w, cwds, p, resolve, true);
        if (k !== undefined) return k;
      }
      for (let i = w.indexOf("/", 1); i > 0; i = w.indexOf("/", i + 1)) {
        const tail = w.slice(i);
        if (tail === "/") continue;
        const k = await checkProtectedPath(tail, cwds, p, resolve, false);
        if (k !== undefined) return k;
      }
    }
    if (name === "cd" || name === "pushd") {
      const dest = cdDest(words, p);
      if (dest === "unresolvable") return "cdUnresolvable";
      const next: string[] = [];
      for (const base of dest.startsWith("/") ? [cwd] : cwds) {
        try {
          next.push(await resolve(dest.startsWith("/") ? dest : `${base}/${dest}`));
        } catch {
          return "cdUnresolvable";
        }
      }
      cwds.push(...next);
    }
  }
  return undefined;
}

/** 読み取りの道具 → 対象のパスを持つ入力のキーと、再帰的に読むか。 */
const READ_PATHS: Readonly<
  Record<string, { readonly keys: readonly string[]; readonly recursive: boolean }>
> = {
  Read: { keys: ["file_path"], recursive: false },
  NotebookRead: { keys: ["notebook_path"], recursive: false },
  LS: { keys: ["path"], recursive: false },
  Glob: { keys: ["path"], recursive: true },
  Grep: { keys: ["path"], recursive: true },
};

/** 禁じる場所の判定（読み取りの道具と Bash の引数。書き込みの道具は見ない）。禁じる場所がなければ、何もしない（undefined）。 */
async function checkProtected(
  p: ProtectedPaths | undefined,
  cwd: string,
  toolName: string,
  toolInput: unknown,
  resolve: ResolvePath,
): Promise<ToolDecision | undefined> {
  if (p === undefined || p.roots.length === 0) return undefined;
  const input = isRec(toolInput) ? toolInput : {};
  const verdict = (
    k: ProtectedKind | "unresolvable" | "cdUnresolvable" | undefined,
    subject: string,
  ): ToolDecision | undefined =>
    k === undefined
      ? undefined
      : k === "cdUnresolvable"
        ? deny("invalidPath", "Bash（cd・pushd の行き先を確かめられない）")
        : k === "unresolvable"
          ? deny("invalidPath", subject)
          : denyProtected(k);
  const spec = Object.hasOwn(READ_PATHS, toolName) ? READ_PATHS[toolName] : undefined;
  if (spec !== undefined) {
    const paths = spec.keys
      .map((k) => input[k])
      .filter((v): v is string => typeof v === "string" && v !== "");
    // Glob・Grep で path がなければ、作業ツリーを読む。Glob の pattern は、絶対でも相対でも、基準につないで確かめる。
    if (toolName === "Glob" && typeof input.pattern === "string") {
      const base = paths[0] ?? cwd;
      const pat = input.pattern;
      paths.push(pat.startsWith("/") || pat.startsWith("~") ? pat : `${base}/${pat}`);
    }
    for (const path of paths) {
      const d = verdict(
        await checkProtectedPath(path, [cwd], p, resolve, spec.recursive),
        `${toolName}（パスを確かめられない）`,
      );
      if (d !== undefined) return d;
    }
    return undefined;
  }
  // 書き込みは、今の範囲の決まり（書き込みを許可する場所）のまま判定する（ここでは見ない）。
  if (toolName === "Bash" && typeof input.command === "string") {
    return verdict(await checkBash(input.command, cwd, p, resolve), "Bash（パスを確かめられない）");
  }
  return undefined;
}

const READ_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "NotebookRead",
  "LS",
  "TodoWrite",
  "ToolSearch",
  "BashOutput",
  // skill を読む。中身は SKILL.md の文で、書き込み・コマンドの実行は、それぞれのツールの判定を通る。
  "Skill",
]);
/** 書き込み系のツール → 対象のパスを持つ入力のキー。 */
const WRITE_TOOLS: Readonly<Record<string, string>> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const deny = (reason: ScopeViolationReason, subject: string): ToolDecision => ({
  allow: false,
  violation: { reason, subject },
  reason: `作業範囲の外の操作です（${reason}: ${subject}）。範囲の拡張が必要なら、親へ拡張要求を出してください。`,
});

const denyUnknown = (tool: string): ToolDecision => ({
  allow: false,
  unknownTool: tool,
  reason: `ツール ${tool} は、このノードでは使えない。`,
});

/** scope の場所（writable・forbidden）を実パスにする。解決できない writable は落とし、forbidden は絶対パスのまま残す。 */
export async function resolveScope(
  scope: Scope,
  cwd: string,
  resolve: ResolvePath,
): Promise<Scope> {
  const abs = (d: string): string => (d.startsWith("/") ? d : `${cwd}/${d}`);
  const real = async (d: string): Promise<string | undefined> => {
    if (typeof d !== "string" || d.trim() === "" || d.includes("\0")) return undefined;
    try {
      return await resolve(abs(d));
    } catch {
      return undefined;
    }
  };
  const writable: string[] = [];
  for (const d of scope.writableLocations) {
    const r = await real(d);
    if (r !== undefined) writable.push(r);
  }
  const forbidden: string[] = [];
  for (const d of scope.forbiddenLocations) {
    if (typeof d !== "string") continue;
    forbidden.push((await real(d)) ?? abs(d));
  }
  return { ...scope, writableLocations: writable, forbiddenLocations: forbidden };
}

/**
 * `scope` は `resolveScope` で実パスにしたもの、`cwd` は実パスの作業ツリー。`toolCwd` は、道具の相対パスの基準（子が作業ツリーの
 * 配下に cd したときの、そのディレクトリ。実パス）。省略すると `cwd`。範囲の判定は、`cwd`（作業ツリー）で行う。
 */
export async function decideToolUse(
  scope: Scope,
  cwd: string,
  toolName: string,
  toolInput: unknown,
  resolve: ResolvePath,
  protectedPaths?: ProtectedPaths,
  toolCwd: string = cwd,
): Promise<ToolDecision> {
  if (typeof toolName !== "string") return denyUnknown("(ツール名が不正)");
  // 禁じる場所（FR_014 の例外）は、読み取りの道具も含めて、ほかの判定より先に見る。
  const prot = await checkProtected(protectedPaths, toolCwd, toolName, toolInput, resolve);
  if (prot !== undefined) return prot;
  if (READ_TOOLS.has(toolName)) return ALLOW;

  if (Object.hasOwn(WRITE_TOOLS, toolName)) {
    const key = WRITE_TOOLS[toolName] as string;
    const path = isRec(toolInput) ? toolInput[key] : undefined;
    if (typeof path !== "string" || path.trim() === "")
      return deny("invalidPath", `${toolName}（${key} がない）`);
    let target: string;
    try {
      target = await resolve(path.startsWith("/") ? path : `${toolCwd}/${path}`);
    } catch {
      return deny("invalidPath", `${path}（実パスを解決できない）`);
    }
    // 自分の引き出しの code（紐付けのコード）と report（報告の本文）だけは、Write の道具で書いてよい（Edit などは許さない）
    const drawer = protectedPaths?.drawer;
    if (
      toolName === "Write" &&
      drawer !== undefined &&
      DRAWER_WRITABLE_FILES.some((f) => fold(target) === fold(`${drawer}/${f}`))
    ) {
      return ALLOW;
    }
    // 見張りの設定への書き込みは、範囲の決まりによらず拒否する（書き換えて見張りを外させない）
    const deniedRoot = protectedPaths?.roots.find(
      (r) => r.kind === "hookSettings" && under(target, r.path),
    );
    if (deniedRoot !== undefined) return denyProtected(deniedRoot.kind);
    if (protectedPaths?.writeDenied?.some((w) => under(target, w)) === true) {
      return {
        allow: false,
        violation: { reason: "forbiddenLocation", subject: "protected:hookSettings" },
        reason:
          "作業範囲の外の操作です（見張り（フック）の設定の置き場には、書き込めません。読むことはできます）。",
      };
    }
    const d = evaluateScope(scope, cwd, { kind: "write", path: target });
    if (d.allowed) return ALLOW;
    // 判定は今の範囲の決まりのまま。ただし、対象が禁じる場所の中なら、件名（記録と文面）には種類だけを書く（実パスを出さない）
    const hidden = protectedPaths?.roots.find((r) => under(target, r.path));
    return deny(d.reason, hidden === undefined ? d.subject : `protected:${hidden.kind}`);
  }

  if (toolName === "Bash") {
    const command = isRec(toolInput) ? toolInput.command : undefined;
    if (typeof command !== "string" || command.trim() === "")
      return deny("commandNotAllowed", "Bash（command がない）");
    const input = toolInput as Record<string, unknown>;
    if (input.run_in_background !== undefined && input.run_in_background !== false)
      return deny("backgroundExecution", command);
    if (input.dangerouslyDisableSandbox === true)
      return deny("commandNotAllowed", `${command}（dangerouslyDisableSandbox）`);
    const d = evaluateScope(scope, cwd, { kind: "command", command });
    return d.allowed ? ALLOW : deny(d.reason, d.subject);
  }

  // 自分の mcp の道具は、子のロールの道具だけを、2 つの名前の形（直に入れた形・plugin から入れた形）で許す。ほかのロールの道具は拒む
  const own = ownMcpToolOf(toolName);
  if (own !== undefined && CHILD_MCP_TOOL_NAMES.includes(own)) return ALLOW;
  return denyUnknown(toolName === "" ? "(ツール名が空)" : toolName);
}

/**
 * 承認済みの拡張に、明示の許可（`permissionDecision: "allow"`）を返してよい Bash か（#91）。CLI の子（dontAsk）のフックが使う。
 * 明示の許可は、Claude Code の側の確かめ（読み取りだけのコマンドの安全な旗、引用符のない glob など）を飛ばす。
 * deny・ask の規則は、明示の許可のあとも効く（Claude Code の文書: hooks の `permissionDecision`、permissions の
 * 「Precedence among rules, hooks, and mods」）。そのため、次のすべてを満たすときだけ真にする（前方一致のぶんは、フックだけ通し、
 * Claude Code の判定に任せる）。
 * - 命令を区切りで分けた各部分が、承認済みの拡張だけにある項目（ブリーフにない項目）と、語の数まで同じ（完全一致）
 * - その項目が、起動のときの一覧と同じ規則（`commandEntryProblem`: `cd` 始まり・1 語だけ・任意のコードが動く形の禁止）を通る
 * 書き込みの道具（Write・Edit・MultiEdit・NotebookEdit）は、対象の場所がブリーフでは断られ、有効な範囲では通るときだけ真。
 * 禁じる場所の `Edit` の deny は、明示の許可のあとも Claude Code の側で効く。
 * フックの判定（`decideToolUse`）で許可されたあとにだけ呼ぶ（これだけで許可を決めない）。純粋関数。
 */
export function grantedOnlyByExtension(
  brief: Scope,
  effective: Scope,
  toolName: string,
  toolInput: unknown,
  cwd: string,
): boolean {
  const key = WRITE_TOOLS[toolName];
  if (key !== undefined) {
    // 書き込み: ブリーフでは断られ、有効な範囲（承認した書き込みの場所を足したもの）では通る場所。比べられなければ偽（フェイルクローズ）
    const path = isRec(toolInput) ? toolInput[key] : undefined;
    if (typeof path !== "string") return false;
    return (
      !evaluateScope(brief, cwd, { kind: "write", path }).allowed &&
      evaluateScope(effective, cwd, { kind: "write", path }).allowed
    );
  }
  if (toolName !== "Bash") return false;
  const command = (toolInput as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  const segments = commandWords(command)?.filter((s) => s.length > 0);
  if (segments === undefined || segments.length === 0) return false;
  const granted = effective.allowedCommands
    .filter((e) => !brief.allowedCommands.includes(e))
    // 区切り（`;`・`|` など）を含む項目は、承認した形そのものと意味が違う語の並びになるので外す
    .filter((e) => commandWords(e)?.filter((s) => s.length > 0).length === 1)
    .map(entryWords)
    .filter((w) => commandEntryProblem(w) === undefined);
  return segments.every((seg) =>
    granted.some((w) => w.length === seg.length && w.every((x, i) => seg[i] === x)),
  );
}

/**
 * 書き込みの道具の入力のパスを、実パスにした入力を返す（`grantedOnlyByExtension` で、実パスの作業ツリーと比べるため。#91）。
 * 相対パスは `toolCwd` を基準にする。書き込みの道具でない・パスがない・解決できないときは、入力をそのまま返す（比べて偽になる。安全側）。
 */
export async function withRealWritePath(
  toolName: string,
  toolInput: unknown,
  toolCwd: string,
  resolve: ResolvePath,
): Promise<unknown> {
  const key = WRITE_TOOLS[toolName];
  if (key === undefined || !isRec(toolInput)) return toolInput;
  const p = toolInput[key];
  if (typeof p !== "string" || p === "") return toolInput;
  try {
    const abs = p.startsWith("/") ? p : `${toolCwd.replace(/\/+$/, "")}/${p}`;
    return { ...toolInput, [key]: await resolve(abs) };
  } catch {
    return toolInput;
  }
}
