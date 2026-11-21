import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BIND_CODE_FILE,
  gitDirOf,
  removeBindCodeFile,
  writeBindCodeFile,
} from "../src/bind-code-file.js";

/** 追加の作業ツリーの形（`.git` はファイルで、`gitdir:` が共通の git の worktrees/<名前> を指す）を作る。 */
const tree = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-bcf-")));
  const gitDir = join(base, "repo", ".git", "worktrees", "a");
  mkdirSync(gitDir, { recursive: true });
  const wt = join(base, "wt", "a");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${gitDir}\n`);
  return { base, gitDir, wt };
};

describe("紐付けのコードのファイル（daemon）", () => {
  it("作業ツリーの git のディレクトリに 0600 で書き、消せる", () => {
    const t = tree();
    const path = writeBindCodeFile(t.wt, "ABC");
    expect(path).toBe(join(t.gitDir, BIND_CODE_FILE));
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("ABC\n");
    // 書き直し（一時ファイルから名前を替える。一時ファイルは残らない）
    writeBindCodeFile(t.wt, "DEF");
    expect(readFileSync(path, "utf8")).toBe("DEF\n");
    expect(readdirSync(t.gitDir).filter((f) => f.includes(BIND_CODE_FILE))).toEqual([
      BIND_CODE_FILE,
    ]);
    expect(removeBindCodeFile(t.wt)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(removeBindCodeFile(t.wt)).toBe(false);
  });

  it("daemonId を渡すと、2 行目に書いた daemon の公開 ID を書く（渡さなければ、古い形のコードだけ）", () => {
    const t = tree();
    const id = "c".repeat(32);
    const path = writeBindCodeFile(t.wt, "ABC", { daemonId: id });
    expect(readFileSync(path, "utf8")).toBe(`ABC\ndaemon=${id}\n`);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    writeBindCodeFile(t.wt, "DEF");
    expect(readFileSync(path, "utf8")).toBe("DEF\n");
  });

  it("ファイルの名前がリンクなら書かない（リンクの先を書き換えない）", () => {
    const t = tree();
    const victim = join(t.base, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, join(t.gitDir, BIND_CODE_FILE));
    expect(() => writeBindCodeFile(t.wt, "ABC")).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });

  it("git のディレクトリがリンク・.git がディレクトリなら書かない", () => {
    const t = tree();
    const real = join(t.base, "elsewhere");
    mkdirSync(real);
    const linked = join(t.base, "repo", ".git", "worktrees", "l");
    symlinkSync(real, linked);
    writeFileSync(join(t.wt, ".git"), `gitdir: ${linked}\n`);
    expect(() => writeBindCodeFile(t.wt, "ABC")).toThrow();
    expect(existsSync(join(real, BIND_CODE_FILE))).toBe(false);
    const main = join(t.base, "main");
    mkdirSync(join(main, ".git"), { recursive: true });
    expect(() => gitDirOf(main)).toThrow();
  });
});

describe("紐付けのコードを書く前の ACL（継承）", () => {
  it("分からないとき・ACL があるときは、コードを書かずに失敗し、一時ファイルを残さない", () => {
    const t = tree();
    expect(() =>
      writeBindCodeFile(t.wt, "ABC", { acl: () => "ACL を確かめられない（差し替え）" }),
    ).toThrow("ACL を確かめられない");
    expect(readdirSync(t.gitDir)).toEqual([]);
    expect(existsSync(join(t.gitDir, BIND_CODE_FILE))).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "macOS: git のディレクトリに継承される ACL があれば、書かない（chmod +a の終了コードを確かめる）",
    () => {
      const t = tree();
      const r = spawnSync("chmod", ["+a", "everyone allow read,file_inherit", t.gitDir], {
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(() => writeBindCodeFile(t.wt, "ABC")).toThrow("ACL");
      expect(readdirSync(t.gitDir)).toEqual([]);
    },
  );
});
