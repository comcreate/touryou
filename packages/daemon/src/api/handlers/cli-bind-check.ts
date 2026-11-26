/**
 * CLI の子の紐付けの、作業ツリーの確認（FR_006。設計 6.2）。
 *
 * CLI の子は、親のセッションが `(cd <作業ツリー> && claude --bg …)` で起動する（daemon は起動しない）。紐付け（`POST /v1/bind`）で、
 * 子のセッションの mcp が自分の作業ディレクトリ（`cwd`）を送る。daemon は、それが次をすべて満たすときだけ紐付ける:
 *
 * - `cwd` が絶対パスで、実のパス（symlink を解いたもの）が、そのノードの作業ツリーの実のパスと同じ。
 * - その作業ツリーが、git の追加の作業ツリー（`<作業ツリー>/.git` が、ディレクトリではなくファイル）。
 *
 * 満たさなければ、コードは消費しない（正しいセッションから、同じコードでやり直せる）。紐付けが済むまで、子はトークンを
 * 持たないので、子のロールの操作（書き込みの op を含む）は、窓口の認証で断られる（401）。
 *
 * 注意（推測）: Claude Code が plugin の stdio の mcp を、セッションの作業ディレクトリで起動することを前提にしている。
 * この前提は、まだ確かめていない。
 */

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface WorktreeCheckDeps {
  /** そのノードの作業ツリー（なければ undefined）。 */
  readonly cwdOf: (nodeId: string) => Promise<string | undefined>;
  /** 実のパス（テストで差し替える）。失敗は例外。 */
  readonly realpath?: (path: string) => string;
  /** `<作業ツリー>/.git` がファイルか（テストで差し替える）。 */
  readonly gitIsFile?: (worktree: string) => boolean;
}

const defaultGitIsFile = (worktree: string): boolean => {
  try {
    return lstatSync(join(worktree, ".git")).isFile();
  } catch {
    return false;
  }
};

/** `POST /v1/bind` の `bindWorktreeOk` に渡す関数を作る。例外は投げず、偽を返す。 */
export function createBindWorktreeCheck(
  deps: WorktreeCheckDeps,
): (nodeId: string, cwd: string | undefined) => Promise<boolean> {
  const realpath = deps.realpath ?? ((p: string) => realpathSync(p));
  const gitIsFile = deps.gitIsFile ?? defaultGitIsFile;
  return async (nodeId, cwd) => {
    if (cwd === undefined || !isAbsolute(cwd)) return false;
    try {
      const tree = await deps.cwdOf(nodeId);
      if (tree === undefined) return false;
      const want = realpath(tree);
      return realpath(cwd) === want && gitIsFile(want);
    } catch {
      return false;
    }
  };
}
