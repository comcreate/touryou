// 追跡しているファイルに、個人の環境のパス（/Users/<名前>/…・/home/<名前>/…・.claude-home）が入っていないことの試験。
// `node --test scripts/*.test.mjs`（scripts/check.sh）で動く。
// 背景: /sdd-init と SessionStart フックが plugin から作るファイルには、手元の絶対パスが展開されて入る。
// それをそのままコミットすると、公開リポジトリに利用者のユーザー名が出る（#316 の .sdd/MIGRATION_PENDING.md）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 試験・文書の例に使ってよい、架空のユーザー名（実在の人・会社のアカウント名は入れない）
// この試験自身は、検出する文字列を書いているので対象外
const SELF = "scripts/no-personal-paths.test.mjs";

const DUMMY_USERS = new Set(["u", "x", "me", "user", "someone", "secret", "runner"]);

test("個人の環境のパス: 追跡しているファイルに、実在のユーザー名のホームのパスと .claude-home がない", () => {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, "git ls-files が動く");
  const found = [];
  for (const f of r.stdout
    .split("\0")
    .filter((x) => x !== "" && x !== "pnpm-lock.yaml" && x !== SELF)) {
    let text;
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue; // 読めないもの（消えた・シンボリックリンクなど）は対象外
    }
    if (text.includes("\0")) continue; // バイナリは対象外
    for (const m of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9_.-]+)/g)) {
      if (!DUMMY_USERS.has(m[1])) found.push(`${f}: ${m[0]}`);
    }
    if (text.includes(".claude-home")) found.push(`${f}: .claude-home`);
  }
  assert.deepEqual(
    found,
    [],
    "個人の環境のパスがある。生成物ならコミットせず .gitignore に入れる。例なら架空の名前（u・x など）にする",
  );
});
