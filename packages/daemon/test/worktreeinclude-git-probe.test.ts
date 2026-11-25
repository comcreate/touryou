// #294 PR0: `.worktreeinclude` を git だけで照合する案 A が成り立つかを、実際の git で確かめる試験。
// 設計: .sdd/task/294/design-draft.md の 3 章（案 A）・10 章（実測が要る項目）。
// daemon の本体（src）は使わない。git の挙動そのものを固定し、挙動が変わったら気づけるようにする。
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/** 利用者のグローバル設定・システム設定が結果に混ざらないようにする。 */
const gitEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});

const makeRepo = () => {
  const base = mkdtempSync(join(tmpdir(), "touryou-wti-"));
  const home = join(base, "home");
  const root = join(base, "repo");
  mkdirSync(home);
  mkdirSync(root);
  const env = gitEnv(home);
  const run = (args: string[], input?: string, cwd = root): string =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", input });
  run(["init", "-q", "-b", "main"]);
  const write = (rel: string, body = "x\n"): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  /** `.worktreeinclude` に書く内容を置き、`git ls-files -z -o -i --exclude-from=<F>` の候補を返す。 */
  const candidates = (include: string): string[] => {
    write(".worktreeinclude", include);
    const out = run([
      "ls-files",
      "-z",
      "-o",
      "-i",
      "--exclude-from=.worktreeinclude",
    ]);
    return out.split("\0").filter((s) => s !== "").sort();
  };
  /** `git check-ignore -z --stdin`。一致なしは終了コード 1 なので、空の配列にする。 */
  const checkIgnore = (paths: string[]): string[] => {
    try {
      const out = run(
        ["check-ignore", "-z", "--stdin"],
        paths.map((p) => `${p}\0`).join(""),
      );
      return out.split("\0").filter((s) => s !== "").sort();
    } catch (e) {
      if ((e as { status?: number }).status === 1) return [];
      throw e;
    }
  };
  return { root, run, write, candidates, checkIgnore };
};

describe("案 A の 1 段目: ls-files -z -o -i --exclude-from=F", () => {
  it("F に一致する未追跡のファイルだけが出る。標準の除外（.gitignore）だけに一致するものは混ざらない", () => {
    const r = makeRepo();
    r.write(".gitignore", ".envrc\nonly-gitignore.txt\nbin/\n");
    r.write("tracked.txt");
    r.run(["add", ".gitignore", "tracked.txt"]);
    r.run(["commit", "-q", "-m", "init"]);
    r.write(".envrc");
    r.write("only-gitignore.txt");
    r.write("untracked-not-ignored.txt");
    // 追跡済みで F にも一致するもの: 出ない
    expect(r.candidates("/.envrc\n/tracked.txt\n")).toEqual([".envrc"]);
  });

  it("F に一致すれば、gitignore 済みでない未追跡のファイルも候補に出る（だから 2 段目の check-ignore が要る）", () => {
    const r = makeRepo();
    r.write(".gitignore", ".envrc\n");
    r.run(["add", ".gitignore"]);
    r.run(["commit", "-q", "-m", "init"]);
    r.write(".envrc");
    r.write("not-ignored.txt");
    const cands = r.candidates("/.envrc\n/not-ignored.txt\n");
    expect(cands).toEqual([".envrc", "not-ignored.txt"]);
    // 2 段目で、gitignore 済みのものだけが残る
    expect(r.checkIgnore(cands)).toEqual([".envrc"]);
  });

  it("コメント行・空行は無視される。パスは -z で、空白・日本語・引用符なしで出る", () => {
    const r = makeRepo();
    r.write(".gitignore", "*.env\n");
    r.write("日本語 名.env");
    r.write("sub dir/a b.env");
    expect(r.candidates("# コメント\n\n*.env\n")).toEqual([
      "sub dir/a b.env",
      "日本語 名.env",
    ]);
  });

  it("`!`（否定）は後勝ち。先頭の `/` は repoRoot に固定、`/` なしは任意の深さに一致する", () => {
    const r = makeRepo();
    r.write(".gitignore", "*.env\n");
    r.write("a.env");
    r.write("keep.env");
    r.write("sub/b.env");
    r.write("sub/keep.env");
    // 後勝ち: keep.env は除かれる（任意の深さ）
    expect(r.candidates("*.env\n!keep.env\n")).toEqual(["a.env", "sub/b.env"]);
    // 順序を逆にすると、否定が先で、後ろの `*.env` が勝つ
    expect(r.candidates("!keep.env\n*.env\n")).toEqual([
      "a.env",
      "keep.env",
      "sub/b.env",
      "sub/keep.env",
    ]);
    // 先頭の `/` は固定
    expect(r.candidates("/a.env\n")).toEqual(["a.env"]);
    expect(r.candidates("/b.env\n")).toEqual([]);
    expect(r.candidates("b.env\n")).toEqual(["sub/b.env"]);
  });

  it("ディレクトリ `dir/`・`dir/**` は、--directory なしで、中のファイルが 1 件ずつ出る", () => {
    const r = makeRepo();
    r.write(".gitignore", "bin/\n");
    r.write("bin/a");
    r.write("bin/sub/b");
    r.write("other/c");
    expect(r.candidates("/bin/\n")).toEqual(["bin/a", "bin/sub/b"]);
    expect(r.candidates("/bin/**\n")).toEqual(["bin/a", "bin/sub/b"]);
    // 中身は check-ignore でも gitignore 済みとして出る
    expect(r.checkIgnore(["bin/a", "bin/sub/b"])).toEqual([
      "bin/a",
      "bin/sub/b",
    ]);
  });

  it("`**/` の規則（git の gitignore と同じ）: 先頭の `**/` は任意の深さ、途中の `/**/` は 0 個以上のディレクトリ", () => {
    const r = makeRepo();
    r.write(".gitignore", "foo\n");
    r.write("foo");
    r.write("a/foo");
    r.write("a/x/y/foo");
    r.write("b/foo");
    expect(r.candidates("**/foo\n")).toEqual(["a/foo", "a/x/y/foo", "b/foo", "foo"]);
    expect(r.candidates("a/**/foo\n")).toEqual(["a/foo", "a/x/y/foo"]);
    expect(r.candidates("/foo\n")).toEqual(["foo"]);
  });

  it("入れ子の git（未追跡の別のリポジトリ）の中のファイルは出ない。`.git` の中も出ない", () => {
    const r = makeRepo();
    r.write(".gitignore", "*.env\n");
    r.write("top.env");
    // 入れ子のリポジトリ（.git を持つディレクトリ）
    mkdirSync(join(r.root, "nested"));
    execFileSync("git", ["init", "-q", "-b", "main"], {
      cwd: join(r.root, "nested"),
      env: gitEnv(join(r.root, "..", "home")),
    });
    r.write("nested/inner.env");
    // どんなパターンでも、`.git` の中身は出ない
    const all = r.candidates("*\n!.gitignore\n");
    expect(all.some((p) => p === ".git" || p.startsWith(".git/"))).toBe(false);
    expect(all.some((p) => p.includes("/.git/") || p.endsWith("/.git"))).toBe(
      false,
    );
    // 入れ子のリポジトリの中のファイルは、1 件ずつは出ない
    expect(all).not.toContain("nested/inner.env");
    expect(r.candidates("*.env\n")).toEqual(["top.env"]);
  });

  it("入れ子の git: 入れ子のリポジトリ自体に一致するパターンは、`dir/` の 1 件（末尾が `/`）になる", () => {
    const r = makeRepo();
    r.write(".gitignore", "nested/\n");
    mkdirSync(join(r.root, "nested"));
    execFileSync("git", ["init", "-q", "-b", "main"], {
      cwd: join(r.root, "nested"),
      env: gitEnv(join(r.root, "..", "home")),
    });
    r.write("nested/inner.txt");
    const cands = r.candidates("/nested/\n");
    // 設計 4 章: 末尾が `/` の候補は、通常のファイルでないものとして扱う
    expect(cands.every((p) => !p.startsWith(".git"))).toBe(true);
    expect(cands).not.toContain("nested/inner.txt");
    expect(cands).not.toContain("nested/.git/HEAD");
  });

  it("リンクは、リンクそのものが 1 件として出る（行き先は辿らない）", () => {
    const r = makeRepo();
    r.write(".gitignore", "link.env\n");
    symlinkSync("/etc/hosts", join(r.root, "link.env"));
    expect(r.candidates("/link.env\n")).toEqual(["link.env"]);
    expect(r.checkIgnore(["link.env"])).toEqual(["link.env"]);
  });

  it("グローバルの除外（core.excludesFile）は、F の側（候補）には効かず、check-ignore の側には効く", () => {
    const r = makeRepo();
    const home = join(r.root, "..", "home");
    writeFileSync(join(home, "global-ignore"), "global.env\n");
    r.run(["config", "core.excludesFile", join(home, "global-ignore")]);
    r.write("global.env");
    r.write("plain.txt");
    // F は plain.txt だけ。グローバルの除外は、候補に混ざらない
    expect(r.candidates("/plain.txt\n")).toEqual(["plain.txt"]);
    // check-ignore は、グローバルの除外を見る（R3: 利用者のマシンで範囲が変わりうる）
    expect(r.checkIgnore(["global.env", "plain.txt"])).toEqual(["global.env"]);
    // .git/info/exclude も同じ
    r.write(".git/info/exclude", "info.env\n");
    r.write("info.env");
    expect(r.checkIgnore(["info.env"])).toEqual(["info.env"]);
  });
});

describe("案 A の 2 段目: check-ignore -z --stdin", () => {
  it("gitignore 済みのディレクトリの中のパスは出る。追跡済み・未追跡で gitignore されていないものは出ない", () => {
    const r = makeRepo();
    r.write(".gitignore", "bin/\n*.env\n");
    r.write("tracked.txt");
    r.write("bin/forced"); // gitignore 済みだが、追跡する（add -f）
    r.run(["add", ".gitignore", "tracked.txt"]);
    r.run(["add", "-f", "bin/forced"]);
    r.run(["commit", "-q", "-m", "init"]);
    r.write("bin/untracked");
    r.write("untracked.txt");
    r.write("x.env");
    expect(
      r.checkIgnore([
        "bin/untracked",
        "untracked.txt",
        "tracked.txt",
        "bin/forced",
        "x.env",
      ]),
    ).toEqual(["bin/untracked", "x.env"]);
  });

  it("一致が 1 件もないときの終了コードは 1（呼び出し側は、失敗と区別して空として扱う）", () => {
    const r = makeRepo();
    r.write("a.txt");
    let status: number | undefined;
    try {
      r.run(["check-ignore", "-z", "--stdin"], "a.txt\0");
    } catch (e) {
      status = (e as { status?: number }).status;
    }
    expect(status).toBe(1);
  });
});

describe("core.ignorecase（R2）", () => {
  it("true のとき、`.Envrc` は `/.envrc` に一致する。false のとき、一致しない", () => {
    const r = makeRepo();
    r.write(".gitignore", ".envrc\n.Envrc\n");
    r.write(".Envrc");
    r.run(["config", "core.ignorecase", "true"]);
    expect(r.candidates("/.envrc\n")).toEqual([".Envrc"]);
    r.run(["config", "core.ignorecase", "false"]);
    expect(r.candidates("/.envrc\n")).toEqual([]);
  });
});
