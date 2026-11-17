/**
 * 作業ツリーの中を探す、読み取りだけのコマンド（設計 6.4「探すコマンド」。Issue #92）。純粋関数。
 *
 * Claude Code の native 版（find・grep を内蔵の bfs・ugrep に差し替える版）は、Glob・Grep の道具を出さず、Bash の
 * `find`・`grep` で探させる。子は、範囲の allowedCommands にないコマンドをフックで止められるので、道具がないと何も探せない。
 * そこで、次の形のコマンドだけは、範囲の allowedCommands によらず、フックで許す（FR_014: 読み込みは制限しない）。
 *
 * - 1 語目が `ls`・`find`・`grep`、または `git ls-files`・`git grep`（git の大域のオプションは付けない）。
 * - 書き込み・コマンドの実行・外へのつながりを伴うオプションは付けない（`find -exec`・`-delete`・`-fprint`、
 *   ugrep の `--filter`・`--pager`・`--view`・`-Q`・`--save-config`・`--config`・`--index`、`git grep -O`・`--textconv` など）。
 * - パスに見える語（オプションの `=` の右も）が、作業ツリーの外を指さない（絶対パス・`~`・`..` で外へ出るもの。
 *   実パスにできるものは、リンクを解決しても中にあること）。禁じる場所は、これより先に `checkProtected` が拒否する。
 *   禁じる場所（stateDir など）が作業ツリーの中にあるときは、使わない（パスを書かない再帰で中まで読めるため）。
 * - リダイレクト・置換・サブシェルは、字句解析（core の `commandWords`）が拒否する。`cd` などほかのコマンドが混じれば、使わない。
 *
 * 子の permissions（`--settings` の allow）には足さない。Claude Code は、これらを読み取りだけのコマンドとして、安全な旗と
 * 作業ツリーの中のパスに限って確認なしで通す。allow に `Bash(find:*)` などを足すと、フックのない子で `find -exec` まで通るため。
 */

import { posix } from "node:path";
import { commandWords } from "@touryou/core";

export type ResolveReal = (absPath: string) => Promise<string>;

/** 探すコマンド（語の並びの先頭）。 */
export const READ_ONLY_SEARCH_COMMANDS: readonly (readonly string[])[] = [
  ["ls"],
  ["find"],
  ["grep"],
  ["git", "ls-files"],
  ["git", "grep"],
];

const FIND_DENIED = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
/** grep（GNU grep と、native 版の ugrep）の、コマンドを動かす・書く・対話するオプション。 */
const GREP_DENIED_LONG =
  /^--(filter|pager|view|query|save-config|config|index|pre|open-files-in-pager|textconv|ext-diff)/;
const GIT_GREP_DENIED_SHORT = /^-[A-Za-z]*O/;
const GREP_DENIED_SHORT = /^-[A-Za-z]*Q/;

function headOf(words: readonly string[]): readonly string[] | undefined {
  return READ_ONLY_SEARCH_COMMANDS.find((h) => h.every((w, i) => words[i] === w));
}

function deniedOption(head: readonly string[], w: string): boolean {
  if (!w.startsWith("-")) return false;
  const name = head.join(" ");
  if (name === "find") return FIND_DENIED.has(w);
  if (GREP_DENIED_LONG.test(w)) return true;
  if (name === "grep" && !w.startsWith("--") && GREP_DENIED_SHORT.test(w)) return true;
  if (name === "git grep" && !w.startsWith("--") && GIT_GREP_DENIED_SHORT.test(w)) return true;
  return false;
}

const inside = (p: string, root: string): boolean => {
  const r = root.replace(/\/+$/, "");
  return p === r || p.startsWith(`${r}/`);
};

/** 語が作業ツリーの外を指すか（字句の上と、実パスにできれば実パスの上で）。 */
async function pointsOutside(
  w: string,
  toolCwd: string,
  worktree: string,
  resolve: ResolveReal,
): Promise<boolean> {
  if (w === "") return false;
  if (w.startsWith("~")) return true;
  const abs = posix.normalize(w.startsWith("/") ? w : `${toolCwd}/${w}`);
  if (!inside(abs, worktree)) return true;
  try {
    return !inside(await resolve(abs), worktree);
  } catch {
    return false; // まだない・パターンの語。字句の上で中にある
  }
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
  if (!inside(toolCwd, worktree)) return false;
  // 禁じる場所が作業ツリーの中にあれば、名前だけの語や、パスを書かない再帰（`grep -r x`・`find`）で中まで読めるので使わない
  if (protectedRoots.some((r) => inside(r, worktree) || inside(worktree, r))) return false;
  const segs = commandWords(command)?.filter((s) => s.length > 0);
  if (segs === undefined || segs.length === 0) return false;
  if (/(^|[^&])&($|[^&])/.test(command)) return false; // 裏での実行
  for (const words of segs) {
    const head = headOf(words);
    if (head === undefined) return false;
    for (const w of words.slice(head.length)) {
      if (deniedOption(head, w)) return false;
      const eq = w.startsWith("-") ? w.indexOf("=") : -1;
      const target = eq >= 0 ? w.slice(eq + 1) : w.startsWith("-") ? "" : w;
      if (await pointsOutside(target, toolCwd, worktree, resolve)) return false;
    }
  }
  return true;
}
