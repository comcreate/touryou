/**
 * 紐付けのコードのファイル（設計 6.2）。CLI の子の起動の依頼（`claude --bg`）に、コードを入れないための写し。
 *
 * - 置き場: 子の作業ツリーの git のディレクトリ（`<作業ツリー>/.git` のファイルの `gitdir:` の先。印 `touryou-child` と同じ所。
 *   追跡されない）の `touryou-bind-code`。中身は 1 行目がコード、2 行目が書いた daemon の公開 ID（`daemon=<ID>`）。権限は 0600。
 * - 書き方: 置き場がリンクでない実のディレクトリかを確かめ、ファイルの名前がリンクでないことを確かめてから、同じディレクトリの
 *   一時ファイル（`O_EXCL`・0600）に書いて、名前を替える（途中の中身を読ませない。リンクの先へ書かない）。
 * - コードの正は daemon のメモリ（`BindCodes`）。ファイルは写しで、daemon の再起動のあとは使えない（紐付けは失敗し、親が
 *   `node.bindCode` で出し直す。そのときファイルも書き直す）。
 * - 消すとき: コードが使われた・期限が切れた・ノードを止めた。消すのは、リンクでない通常のファイルだけ（リンクなら、リンクだけを消す）。
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type AclCheck, defaultAclCheck } from "@touryou/core/fs";

/** `packages/mcp/src/bind-code-file.ts` の `BIND_CODE_FILE` と同じ値。 */
export const BIND_CODE_FILE = "touryou-bind-code";

export class BindCodeFileError extends Error {}

/** 作業ツリーの git のディレクトリ（`.git` のファイルの `gitdir:`）。`.git` がディレクトリ・リンク・形が変なら例外。 */
export function gitDirOf(worktree: string): string {
  const dotGit = join(worktree, ".git");
  const st = lstatSync(dotGit);
  if (!st.isFile()) throw new BindCodeFileError(".git がファイルでない（追加の作業ツリーでない）");
  const m = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(readFileSync(dotGit, "utf8"));
  if (m?.[1] === undefined) throw new BindCodeFileError(".git の形が変");
  const dir = isAbsolute(m[1]) ? m[1] : resolve(worktree, m[1]);
  const d = lstatSync(dir);
  if (d.isSymbolicLink() || !d.isDirectory())
    throw new BindCodeFileError("git のディレクトリが、リンクか、ディレクトリでない");
  return dir;
}

/**
 * ファイルの中身の 2 行目（書いた daemon の公開 ID。`daemon=<16 進 32 桁>`）。子の mcp は、接続先の daemon の ID と合うときだけ、
 * コードを送る（接続先違いを、別の daemon のコードとして区別する）。公開 ID は秘密でない（窓口の応答の `x-touryou-daemon-id` と同じ）。
 * 1 行目（コードだけ）の古い形も、mcp は読める。
 */
export const bindCodeFileBody = (code: string, daemonId?: string): string =>
  daemonId === undefined ? `${code}\n` : `${code}\ndaemon=${daemonId}\n`;

export interface BindCodeFileOps {
  /** 書いた daemon の公開 ID（`api/identity.ts` の `daemonId`）。省略すると、古い形（コードだけ）で書く。 */
  readonly daemonId?: string;
  readonly random?: (n: number) => Buffer;
  /** ACL の確かめ（既定は `defaultAclCheck`。試験で差し替える）。 */
  readonly acl?: AclCheck;
}

/** コードを書く（0600・一時ファイルから名前を替える）。書いたパスを返す。失敗は例外。 */
export function writeBindCodeFile(
  worktree: string,
  code: string,
  ops: BindCodeFileOps = {},
): string {
  const dir = gitDirOf(worktree);
  const path = join(dir, BIND_CODE_FILE);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile())
      throw new BindCodeFileError("コードのファイルの名前が、リンクか、通常のファイルでない");
  } catch (e) {
    if (e instanceof BindCodeFileError) throw e;
    if ((e as { code?: unknown }).code !== "ENOENT") throw e;
  }
  const tmp = join(dir, `.${BIND_CODE_FILE}.${(ops.random ?? randomBytes)(8).toString("hex")}`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    // 置き場（git のディレクトリ）の ACL は、作ったファイルに継承されうる。コードを書く前に確かめる（分からないときは書かない）。
    const why = (ops.acl ?? defaultAclCheck)(tmp);
    if (why !== undefined) throw new BindCodeFileError(`コードのファイルに、${why}`);
    writeSync(fd, bindCodeFileBody(code, ops.daemonId));
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // 片付けの失敗は、元の失敗を隠さない
    }
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 片付けの失敗は、元の失敗を隠さない
    }
    throw e;
  }
  return path;
}

/** コードのファイルを消す（なければ何もしない）。消したら真。例外は出さない。 */
export function removeBindCodeFile(worktree: string): boolean {
  try {
    unlinkSync(join(gitDirOf(worktree), BIND_CODE_FILE));
    return true;
  } catch {
    return false;
  }
}
