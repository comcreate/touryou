/**
 * `stateDir` が `repoRoot` の内側にあるときの、起動時の検査（#218）。
 *
 * `stateDir` にはトークンと SQLite が入るので、`git add -A` で誤ってコミットされないよう、内側に置けるのは
 * 「git で ignore 済みで、追跡されていない」ときだけにする。判定は git そのもの（`git check-ignore`・`git ls-files`）に任せ、
 * `.gitignore` を自前で解釈しない（否定・ネスト・`.git/info/exclude`・グローバルの ignore を、git と同じに扱うため）。
 * git が使えない・判定が失敗したときも拒否する（安全側）。
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { type Failure, failure, isPathUnder, type Result } from "@touryou/core";
import type { DaemonConfig } from "./config.js";
import { GIT_MISSING_MESSAGE, type GitRunner, nodeGit } from "./git-ports.js";

/**
 * リンクを解決した実パス。まだないパスは、最も深い既存の祖先を実パスにして、残りを足す（resolveForWrite と同じ考え方）。
 */
export function realPathForWrite(p: string): string {
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
}

/** APFS は大文字小文字・Unicode の正規化の違いを区別しないので、そろえてから比べる（区別する FS では、厳しめに倒れる）。 */
export const foldPath = (x: string): string => x.normalize("NFC").toLowerCase();

const gitFailure = (cause: string, ...next: [string, ...string[]]): Result<undefined, Failure> => ({
  ok: false,
  error: failure("invalidConfig", cause, ...next),
});

/**
 * `stateDir` が `repoRoot` の内側（実パスで、真に内側）にあるとき、git で ignore 済みで、追跡されていないことを確かめる。
 * 内側でなければ、何もしない（成功）。重なりそのものの検査は、`parseConfig`・`realOverlap` が行う。
 */
export async function checkStateDirIgnored(
  config: Pick<DaemonConfig, "stateDir" | "repoRoot">,
  run: GitRunner = nodeGit,
): Promise<Result<undefined, Failure>> {
  const repo = realPathForWrite(config.repoRoot);
  const state = realPathForWrite(config.stateDir);
  if (foldPath(state) === foldPath(repo) || !isPathUnder(foldPath(state), foldPath(repo))) {
    return { ok: true, value: undefined };
  }
  const rel = relative(repo, state);
  if (rel === "" || rel.startsWith("..")) {
    // 大文字小文字の違いなどで、相対パスを正しく作れない（安全側で拒否する）
    return gitFailure(
      "stateDir が repoRoot の内側にあるが、gitignore 済みかを確かめられない（パスの大文字小文字が食い違っている）",
      "stateDir と repoRoot を、同じ綴り（実パス）で書く",
    );
  }
  const fix = `.gitignore に ${rel}/ を足す、または stateDir を repoRoot の外に置く`;
  const tracked = await run(["ls-files", "-z", "--", rel], { cwd: repo });
  if (tracked.code !== 0) return gitUnavailable(tracked.stderr, rel);
  if (tracked.stdout !== "") {
    return gitFailure(
      `stateDir（repoRoot からの ${rel}）が repoRoot の内側にあり、git に追跡されているファイルを含む（トークンや SQLite をコミットしてしまうおそれがある）`,
      "追跡を外す（git rm --cached）か、stateDir を repoRoot の外に置く",
    );
  }
  const ignored = await run(["check-ignore", "-q", "--no-index", "--", `${rel}/`], { cwd: repo });
  if (ignored.code === 0) return { ok: true, value: undefined };
  if (ignored.code === 1) {
    return gitFailure(
      `stateDir（repoRoot からの ${rel}）が repoRoot の内側にあるが、gitignore されていない（トークンや SQLite を誤ってコミットしてしまうおそれがある）`,
      fix,
    );
  }
  return gitUnavailable(ignored.stderr, rel);
}

function gitUnavailable(stderr: string, rel: string): Result<undefined, Failure> {
  if (stderr.startsWith(GIT_MISSING_MESSAGE)) {
    return gitFailure(
      GIT_MISSING_MESSAGE,
      "git を入れ、plist の PATH（--path-prefix）に git の場所を足す",
    );
  }
  return gitFailure(
    `stateDir（repoRoot からの ${rel}）が gitignore 済みかを、git で確かめられなかった`,
    "repoRoot が git のリポジトリであることを確かめる",
    "確かめられないときは、stateDir を repoRoot の外に置く",
  );
}
