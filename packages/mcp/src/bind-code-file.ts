/**
 * 紐付けのコードのファイルを読む（設計 6.2）。`child_bind` が引数なしで呼ばれたときの道。
 *
 * - 場所: 作業ディレクトリ（子は、いつも作業ツリーの一番上から起動する）の `.git` のファイルの `gitdir:` の先の `touryou-bind-code`。
 *   daemon が、起動の依頼を作るときと、`node.bindCode` の出し直しのときに書く（`packages/daemon/src/bind-code-file.ts`）。
 *   中身は、1 行目がコード、2 行目が書いた daemon の公開 ID（`daemon=<ID>`。古い形はコードだけ）。
 * - 読む前に確かめる: リンクでない通常のファイル・持ち主が自分・権限が 0600。開くときもリンクを辿らない（`O_NOFOLLOW`）で、
 *   開いたものが確かめたものと同じか（dev・ino）を見る。
 * - コードは、このプロセスのメモリの中で daemon へ送るだけ（ログ・失敗の原因・道具の結果に書かない）。
 * - 消す: bind が通ったとき。通らなかったときも、コードの形が正しくなければ消す（daemon の側は、使われた・期限切れ・止めたときに消す）。
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type AclCheck, defaultAclCheck } from "@touryou/core/fs";

/** `packages/daemon/src/bind-code-file.ts` の `BIND_CODE_FILE` と同じ値。 */
export const BIND_CODE_FILE = "touryou-bind-code";

/** daemon の `BIND_CODE_SHAPE`（区切りの `-`・空白を除いて大文字にしたもの）と同じ形。 */
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const normalizeCode = (s: string): string => s.replace(/[\s-]/g, "").toUpperCase();
export const isCodeShape = (s: string): boolean => CODE_SHAPE.test(normalizeCode(s));

/** 2 行目の、書いた daemon の公開 ID（`daemon=<16 進 32 桁>`。daemon の `bindCodeFileBody` と同じ形）。 */
const DAEMON_LINE = /^daemon=([0-9a-f]{32})$/;

/**
 * ファイルの中身を、コードと、書いた daemon の公開 ID に分ける。1 行目がコード。2 行目以降は、`daemon=<ID>` の行だけを見る
 * （古い形＝コードだけのファイルは、`daemonId` なし。知らない行は無視する）。
 */
export function parseCodeFile(text: string): { readonly code: string; readonly daemonId?: string } {
  const lines = text.split(/\r?\n/);
  const code = (lines[0] ?? "").trim();
  for (const line of lines.slice(1)) {
    const m = DAEMON_LINE.exec(line.trim());
    if (m?.[1] !== undefined) return { code, daemonId: m[1] };
  }
  return { code };
}

export type ReadCodeResult =
  | {
      readonly ok: true;
      readonly code: string;
      readonly path: string;
      /** コードを書いた daemon の公開 ID（古い形のファイルでは、なし）。 */
      readonly daemonId?: string;
    }
  | {
      readonly ok: false;
      readonly reason: "missing" | "unsafe" | "unreadable";
      readonly path?: string;
    };

export interface CodeFileOps {
  /** このプロセスの uid（既定は `process.getuid()`）。 */
  readonly uid?: () => number | undefined;
  /** ACL の確かめ（既定は `defaultAclCheck`。試験で差し替える）。 */
  readonly acl?: AclCheck;
}

/** 作業ディレクトリの `.git` のファイルから、git のディレクトリを引く（ディレクトリ・リンク・形が変なら undefined）。 */
export function gitDirFromCwd(cwd: string): string | undefined {
  try {
    const dotGit = join(cwd, ".git");
    if (!lstatSync(dotGit).isFile()) return undefined;
    const m = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(readFileSync(dotGit, "utf8"));
    if (m?.[1] === undefined) return undefined;
    const dir = isAbsolute(m[1]) ? m[1] : resolve(cwd, m[1]);
    // git のディレクトリそのものも、リンクでない実のディレクトリであること
    const st = lstatSync(dir);
    return st.isSymbolicLink() || !st.isDirectory() ? undefined : dir;
  } catch {
    return undefined;
  }
}

export function codeFilePath(cwd: string): string | undefined {
  const dir = gitDirFromCwd(cwd);
  return dir === undefined ? undefined : join(dir, BIND_CODE_FILE);
}

export function readCodeFile(cwd: string, ops: CodeFileOps = {}): ReadCodeResult {
  const path = codeFilePath(cwd);
  if (path === undefined) return { ok: false, reason: "missing" };
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return { ok: false, reason: "missing", path };
  }
  const uid = (ops.uid ?? (() => process.getuid?.()))();
  if (
    st.isSymbolicLink() ||
    !st.isFile() ||
    (uid !== undefined && st.uid !== uid) ||
    (st.mode & 0o777) !== 0o600 ||
    st.size > 256
  ) {
    return { ok: false, reason: "unsafe", path };
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return { ok: false, reason: "unreadable", path };
  }
  try {
    const f = fstatSync(fd);
    if (f.dev !== st.dev || f.ino !== st.ino) return { ok: false, reason: "unsafe", path };
    if ((ops.acl ?? defaultAclCheck)(path, fd) !== undefined)
      return { ok: false, reason: "unsafe", path };
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return { ok: true, ...parseCodeFile(buf.subarray(0, n).toString("utf8")), path };
  } catch {
    return { ok: false, reason: "unreadable", path };
  } finally {
    closeSync(fd);
  }
}

/** ファイルを消す（ないなら何もしない）。リンクなら、リンクだけが消える。 */
export function removeCodeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 消せなくても、daemon が期限・停止で消す
  }
}
