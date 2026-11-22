/**
 * 作業ツリーの中を探す、読み取りだけのコマンド（設計 6.4「探すコマンド」。Issue #92）。純粋関数。
 *
 * Claude Code の native 版（find・grep を内蔵の bfs・ugrep に差し替える版）は、Glob・Grep の道具を出さず、Bash の
 * `find`・`grep` で探させる。子は、範囲の allowedCommands にないコマンドをフックで止められるので、道具がないと何も探せない。
 * そこで、次の形のコマンドだけは、範囲の allowedCommands によらず、フックで許す（FR_014: 読み込みは制限しない）。
 *
 * - 1 語目が `ls`・`find`・`grep`、または `git ls-files`・`git grep`（git の大域のオプションは付けない）。
 * - オプションは、**許す表にあるものだけ**（断る表ではない）。長いオプションは名前がそっくり同じときだけ（略した形は断る）。
 *   リンクをたどる旗（`find -L`・`-H`・`-follow`、grep の `-R`・`-S`・`--dereference*`）、コマンドを動かす・書く・
 *   設定を読む旗（`find -exec`・`-delete`・`-fprint`、ugrep の `--filter`・`---FILE`、`git grep -O`・`--textconv`、
 *   ファイルを取る `-f`・`-X` など）は、表にないので断る。
 * - 引用符の外に、パターンの文字（`*`・`?`・`[`）や `~` があれば断る（シェルが展開すると、リンクの先や外を指しうる）。
 *   引用符の中なら、語はそのままコマンドに渡る（`find -name '*.md'`・`grep -e 'a.*b'`）。
 * - 位置の引数（grep・git grep の最初の引数〔パターン〕と、旗の値を除く）は、作業ツリーの外を指さない（絶対パス・`..`。
 *   実パスにできるものは、リンクを解いても中にあること）。禁じる場所は、これより先に `checkProtected` が拒否する。
 *   禁じる場所が作業ツリーの中にあるときは、使わない（パスを書かない再帰で中まで読めるため）。
 * - 先頭の 1 つだけの `cd <作業ツリーの中> &&`（以後の相対パスの基準になる。`;`・`||`・`|` でつないだ cd、2 つ目の cd、
 *   行き先に `..` を含む cd は使わない）と、`|` の直後の `head`・`tail`・`wc`・`sort`・`uniq`（旗だけ。位置の引数は許さない）は
 *   混ぜてよい。エラー出力を捨てるだけの `2>/dev/null`・`2>&1` は除いて見る。
 * - ほかのリダイレクト・置換・サブシェルは、字句解析（core の `commandWords`）が拒否する。ほかのコマンドが混じれば、使わない。
 *
 * 子の permissions（`--settings` の allow）には足さない。`Bash(find:*)` などを足すと、フックのない子で `find -exec` まで通るため。
 * そのかわり、CLI の子（dontAsk）のフックは、これで許したときに明示の許可（`permit: "readOnlySearch"`）を返す（compose の decideCliHook）。
 */

import { commandWords, type SearchStage } from "@touryou/core";

export type ResolveReal = (absPath: string) => Promise<string>;

/**
 * 探すコマンドの、先頭の語の並び（`SPECS` の見出しと `find`）。範囲によらずフックが許す形の入口。
 * 設定の `autoApprove` が、「読み取りだけのコマンド」かを確かめる基準にする（#194）。表を足すときは、ここも同じ表から決まる。
 */
export const READ_ONLY_COMMAND_HEADS: ReadonlyArray<readonly string[]> = [
  ["find"],
  ["ls"],
  ["grep"],
  ["git", "grep"],
  ["git", "ls-files"],
];

interface Spec {
  /** 値を取らない短い旗の文字（束ねてよい）。 */
  readonly flags: string;
  /** 値を取る短い旗の文字（値は続けて書くか、次の語）。値はパスとして扱わない（数・パターン）。 */
  readonly valueFlags: string;
  /** 値を取らない長いオプション（そっくり同じ名前だけ）。 */
  readonly long: ReadonlySet<string>;
  /** `--名前=値` の形で値を取る長いオプション（値はパターン。パスとして扱わない）。 */
  readonly longValue: ReadonlySet<string>;
  /** 最初の位置の引数がパターンか（`-e` がなければ）。 */
  readonly patternFirst: boolean;
}

const GREP: Spec = {
  flags: "rinwlLcvEFHhosxIq",
  valueFlags: "emABC",
  long: new Set([
    "--recursive",
    "--ignore-case",
    "--line-number",
    "--word-regexp",
    "--line-regexp",
    "--files-with-matches",
    "--files-without-match",
    "--count",
    "--invert-match",
    "--extended-regexp",
    "--fixed-strings",
    "--with-filename",
    "--no-filename",
    "--only-matching",
    "--no-messages",
    "--quiet",
  ]),
  longValue: new Set(["--include", "--exclude", "--exclude-dir", "--max-count", "--regexp"]),
  patternFirst: true,
};

const SPECS: ReadonlyArray<readonly [readonly string[], Spec]> = [
  [
    ["ls"],
    {
      flags: "1aAdFhlrRSt",
      valueFlags: "",
      long: new Set(["--all", "--almost-all", "--recursive"]),
      longValue: new Set(),
      patternFirst: false,
    },
  ],
  [["grep"], GREP],
  [
    ["git", "grep"],
    {
      flags: "inwlLcvEFhHIo",
      valueFlags: "eABCm",
      long: new Set([
        "--cached",
        "--untracked",
        "--ignore-case",
        "--line-number",
        "--word-regexp",
        "--files-with-matches",
        "--files-without-match",
        "--count",
        "--invert-match",
        "--extended-regexp",
        "--fixed-strings",
        "--and",
        "--or",
        "--not",
      ]),
      longValue: new Set(),
      patternFirst: true,
    },
  ],
  [
    ["git", "ls-files"],
    {
      flags: "comdstz",
      valueFlags: "",
      long: new Set([
        "--cached",
        "--others",
        "--modified",
        "--deleted",
        "--stage",
        "--exclude-standard",
        "--directory",
        "--full-name",
      ]),
      longValue: new Set(),
      patternFirst: false,
    },
  ],
];

/**
 * 探すコマンドの出力を、`|` の直後で絞るだけのコマンド。**位置の引数は 1 つも許さない**（`-` も。標準入力だけを読む）。
 * `uniq` の 2 つ目の引数（出力のファイル）や、`head -c 5 <ほかのファイル>` を閉じるため。旗の値は数だけ。
 */
const FILTER_ARG: Readonly<Record<string, RegExp>> = {
  head: /^-(\d+|[nc]\d+|q)$/,
  tail: /^-(\d+|[nc]\d+|q)$/,
  wc: /^-[lwcm]+$/,
  sort: /^-[rnuf]+$/,
  uniq: /^-c$/,
};

function filterOk(words: readonly string[]): boolean {
  const name = words[0] as string;
  const re = FILTER_ARG[name];
  if (re === undefined) return false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as string;
    if (re.test(w)) continue;
    // `head -n 20` の形（値は次の語。数だけ）
    if ((name === "head" || name === "tail") && (w === "-n" || w === "-c")) {
      if (!/^\d+$/.test(words[i + 1] ?? "")) return false;
      i++;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * 引用符の外の区切りを、順に返す（core の字句解析と同じ規則で引用符・`\\` を読み飛ばす）。`&&`・`||`・`|`・`|&`・`;`・改行・`&`。
 */
function separatorsOf(command: string): string[] {
  const out: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    const next = command.charAt(i + 1);
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "&") {
      if (next === "&") {
        out.push("&&");
        i++;
      } else out.push("&");
    } else if (c === "|") {
      if (next === "|" || next === "&") {
        out.push(`|${next}`);
        i++;
      } else out.push("|");
    } else if (c === ";" || c === "\n") out.push(";");
  }
  return out;
}

/**
 * 引用符の外の、エラー出力を捨てるだけのリダイレクト（`2>/dev/null`・`2>&1`）を除く。ほかのリダイレクトは残す（字句解析が拒否する）。
 * 語の始めにあるものだけを除く（`a2>/dev/null` のような語の途中は除かない）。
 */
function stripHarmlessRedirects(command: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (quote === "'") {
      if (c === "'") quote = null;
      out += c;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") {
        out += c + command.charAt(i + 1);
        i++;
        continue;
      }
      if (c === '"') quote = null;
      out += c;
      continue;
    }
    if (c === "\\") {
      out += c + command.charAt(i + 1);
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      continue;
    }
    if (c === "2" && (i === 0 || /\s/.test(command.charAt(i - 1)))) {
      const m = /^2>(?:\s*\/dev\/null|&1)(?=$|[\s|;&])/.exec(command.slice(i));
      if (m !== null) {
        i += m[0].length - 1;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** find の式で使ってよいもの。値を取るものは、値がパターン・数・型（パスではない）。 */
const FIND_NO_VALUE = new Set([
  "-print",
  "-print0",
  "-empty",
  "-prune",
  "-not",
  "-o",
  "-a",
  "-or",
  "-and",
  "!",
  "-true",
  "-false",
]);
const FIND_VALUE = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
  "-regex",
  "-iregex",
  "-type",
  "-maxdepth",
  "-mindepth",
  "-size",
  "-mtime",
  "-mmin",
]);

const inside = (p: string, root: string): boolean => {
  const r = root.replace(/\/+$/, "");
  return p === r || p.startsWith(`${r}/`);
};

/** 引用符の外に、シェルが展開する文字（パターン・`~`・波括弧）があるか。 */
function hasUnquotedExpansion(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let wordStart = true;
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      wordStart = false;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      wordStart = false;
      continue;
    }
    if (c === "*" || c === "?" || c === "[" || c === "{") return true;
    if (c === "~" && wordStart) return true;
    wordStart = /[\s|;&=:]/.test(c);
  }
  return false;
}

/** 語が作業ツリーの外を指すか（字句の上と、実パスにできれば実パスの上で）。 */
async function pointsOutside(
  w: string,
  toolCwd: string,
  worktree: string,
  resolve: ResolveReal,
): Promise<boolean> {
  if (w === "" || w === "-") return false;
  if (w.startsWith("~")) return true;
  // 語のまま（`..` を字句でつぶさずに）実パスにする。カーネルは `x/..` の `x` を先に解く（`x` が外へのリンクなら外に着く）ので、
  // 字句でつぶすと食い違う。resolve は、今ある部分をカーネルと同じ順で実パスにし、まだない残りを足す（残りに `..` があれば失敗）。
  // 実パスにできなければ外と見なす（macOS の /var は /private/var へのリンク。作業ツリーは実パス）
  const abs = w.startsWith("/") ? w : `${toolCwd}/${w}`;
  try {
    return !inside(await resolve(abs), worktree);
  } catch {
    return true;
  }
}

/** `cd <dir>` の行き先（実パス）。作業ツリーの外・確かめられないときは undefined。 */
async function cdTarget(
  args: readonly string[],
  toolCwd: string,
  worktree: string,
  resolve: ResolveReal,
): Promise<string | undefined> {
  const dir = args[0];
  if (
    args.length !== 1 ||
    dir === undefined ||
    dir === "" ||
    dir.startsWith("-") ||
    dir.startsWith("~") ||
    // シェルの cd は `..` を字句で解く（cd -L）。確かめは実パスなので、`..` があるとリンクをはさんで食い違う。`..` がなければ同じ場所
    dir.split("/").includes("..")
  )
    return undefined;
  try {
    const real = await resolve(dir.startsWith("/") ? dir : `${toolCwd}/${dir}`);
    return inside(real, worktree) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** 1 つのコマンドの、位置の引数（パスとして確かめる語）を返す。許さない旗があれば undefined。 */
function positionalsOf(spec: Spec, args: readonly string[]): string[] | undefined {
  const out: string[] = [];
  let pattern = false;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as string;
    if (endOfOptions || !w.startsWith("-") || w === "-") {
      out.push(w);
      continue;
    }
    if (w === "--") {
      endOfOptions = true;
      continue;
    }
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      if (eq < 0) {
        if (!spec.long.has(w)) return undefined;
      } else if (!spec.longValue.has(w.slice(0, eq))) return undefined;
      if (w.startsWith("--regexp=")) pattern = true;
      continue;
    }
    // 短い旗の束ね。値を取る旗があれば、残りか次の語が値
    for (let k = 1; k < w.length; k++) {
      const c = w.charAt(k);
      if (spec.flags.includes(c)) continue;
      if (spec.valueFlags.includes(c)) {
        if (k === w.length - 1) {
          if (i + 1 >= args.length) return undefined;
          i++;
        }
        if (c === "e") pattern = true;
        break;
      }
      return undefined;
    }
  }
  if (spec.patternFirst && !pattern) out.shift();
  return out;
}

/** find の、起点のパスを返す。許さない式があれば undefined。 */
function findStarts(args: readonly string[]): string[] | undefined {
  const starts: string[] = [];
  let i = 0;
  while (i < args.length && !(args[i] as string).startsWith("-") && args[i] !== "!") {
    starts.push(args[i] as string);
    i++;
  }
  for (; i < args.length; i++) {
    const w = args[i] as string;
    if (FIND_NO_VALUE.has(w)) continue;
    if (FIND_VALUE.has(w)) {
      if (i + 1 >= args.length) return undefined;
      i++;
      continue;
    }
    return undefined;
  }
  return starts;
}

/**
 * コマンドが、作業ツリーの中を探す読み取りだけのコマンド（`|`・`&&`・`;` でつないだものを含む）なら true。
 * `toolCwd`・`worktree` は実パス。
 */
export async function isReadOnlySearch(
  command: string,
  toolCwd: string,
  worktree: string,
  resolve: ResolveReal,
  protectedRoots: readonly string[] = [],
): Promise<boolean> {
  return (
    (await diagnoseReadOnlySearch(command, toolCwd, worktree, resolve, protectedRoots)) ===
    undefined
  );
}

/**
 * `isReadOnlySearch` と同じ判定で、通れば undefined、落ちたらその段（`SearchStage`）を返す。
 * 段の名前だけを返す（実パス・コマンドの語は含めない）。違反の記録（`scope.violation` の `diagnosis`）に使う。
 */
export async function diagnoseReadOnlySearch(
  command: string,
  toolCwd: string,
  worktree: string,
  resolve: ResolveReal,
  protectedRoots: readonly string[] = [],
): Promise<SearchStage | undefined> {
  if (!inside(toolCwd, worktree)) return "cwdOutside";
  if (protectedRoots.some((r) => inside(r, worktree) || inside(worktree, r)))
    return "protectedOverlap";
  if (hasUnquotedExpansion(command)) return "unquotedExpansion";
  const cmd = stripHarmlessRedirects(command);
  const segs = commandWords(cmd);
  if (segs === undefined || segs.length === 0 || segs.some((x) => x.length === 0))
    return "unparsable";
  // 区切りの種類を見る。`cd` は先頭の `&&` の前だけ、絞るコマンドは `|` の直後だけ。`|&`・`&` は使わない
  const seps = separatorsOf(cmd);
  if (seps.length !== segs.length - 1) return "separator";
  if (seps.some((x) => !["&&", "||", "|", ";"].includes(x))) return "separator";
  let here = toolCwd;
  let searched = false;
  let prevPiped = false; // 1 つ前の段が、探すコマンドか絞るコマンドで、`|` でつないだか
  for (const [i, words] of segs.entries()) {
    const sep = i === 0 ? undefined : seps[i - 1];
    // 先頭の 1 つだけの `cd <作業ツリーの中> && …`（Claude Code はこの形でよく送る）。以後の相対パスは、その場所から解く。
    // 2 つ目の cd・`;`・`||`・`|` でつないだ cd は使わない（cd に失敗しても後ろが動く・cd が効かない形）
    if (words[0] === "cd") {
      if (i !== 0 || seps[0] !== "&&") return "cdRejected";
      const next = await cdTarget(words.slice(1), here, worktree, resolve);
      if (next === undefined) return "cdRejected";
      here = next;
      continue;
    }
    if (words[0] !== undefined && words[0] in FILTER_ARG) {
      if (!(sep === "|" && prevPiped) || !filterOk(words)) return "filterRejected";
      prevPiped = true;
      continue;
    }
    let paths: string[] | undefined;
    if (words[0] === "find") paths = findStarts(words.slice(1));
    else {
      const hit = SPECS.find(([h]) => h.every((w, k) => words[k] === w));
      if (hit === undefined) return "notSearchCommand";
      paths = positionalsOf(hit[1], words.slice(hit[0].length));
    }
    if (paths === undefined) return "optionNotAllowed";
    for (const p of paths) {
      if (await pointsOutside(p, here, worktree, resolve)) return "pathOutside";
    }
    searched = true;
    prevPiped = true;
  }
  return searched ? undefined : "noSearchCommand";
}
