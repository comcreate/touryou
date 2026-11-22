import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitRunner } from "../src/git-ports.js";
import { GIT_MISSING_MESSAGE } from "../src/git-ports.js";
import { checkStateDirIgnored } from "../src/state-dir-ignore.js";

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

/** 実物の git のリポジトリ（空）を作る。リンクを解決した実パスで返す。 */
const makeRepo = (): { base: string; repo: string } => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-ignore-")));
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  return { base, repo };
};

// 利用者のグローバルの ignore（core.excludesFile）に左右されないよう、HOME・XDG の設定を空の場所にする。
let savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "touryou-ignore-home-")));
  savedEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("checkStateDirIgnored（stateDir が repoRoot の内側にあるとき、git で ignore 済み・未追跡か）", () => {
  it("repoRoot の外にある stateDir は、git を呼ばずに通す", async () => {
    const { base, repo } = makeRepo();
    const run: GitRunner = async () => {
      throw new Error("git を呼んではならない");
    };
    const r = await checkStateDirIgnored({ stateDir: join(base, "state"), repoRoot: repo }, run);
    expect(r.ok).toBe(true);
  });

  it("repoRoot と同じ場所は、この検査では通す（重なりそのものは別の検査が拒否する）", async () => {
    const { repo } = makeRepo();
    const r = await checkStateDirIgnored({ stateDir: repo, repoRoot: repo });
    expect(r.ok).toBe(true);
  });

  it(".gitignore の `.touryou/` で ignore 済みなら通る（stateDir がまだなくても）", async () => {
    const { repo } = makeRepo();
    writeFileSync(join(repo, ".gitignore"), ".touryou/\n");
    const r = await checkStateDirIgnored({ stateDir: join(repo, ".touryou"), repoRoot: repo });
    expect(r.ok).toBe(true);
  });

  it("stateDir が作ってあっても、中の階層の stateDir でも、親の ignore で通る", async () => {
    const { repo } = makeRepo();
    writeFileSync(join(repo, ".gitignore"), "/.touryou\n");
    mkdirSync(join(repo, ".touryou", "state"), { recursive: true });
    const r = await checkStateDirIgnored({
      stateDir: join(repo, ".touryou", "state"),
      repoRoot: repo,
    });
    expect(r.ok).toBe(true);
  });

  it("`*` の ignore・.git/info/exclude の ignore も、git の判定どおりに通る", async () => {
    const a = makeRepo();
    writeFileSync(join(a.repo, ".gitignore"), "*\n");
    expect(
      (await checkStateDirIgnored({ stateDir: join(a.repo, "state"), repoRoot: a.repo })).ok,
    ).toBe(true);
    const b = makeRepo();
    writeFileSync(join(b.repo, ".git", "info", "exclude"), "state/\n");
    expect(
      (await checkStateDirIgnored({ stateDir: join(b.repo, "state"), repoRoot: b.repo })).ok,
    ).toBe(true);
  });

  it("ignore されていなければ、invalidConfig で、直し方（.gitignore に足す・外に置く）を出す", async () => {
    const { repo } = makeRepo();
    mkdirSync(join(repo, "state"));
    const r = await checkStateDirIgnored({ stateDir: join(repo, "state"), repoRoot: repo });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("invalidConfig");
    expect(r.error.cause).toContain("gitignore されていない");
    expect(r.error.nextActions.join("\n")).toContain(".gitignore に state/ を足す");
  });

  it("否定（!）で ignore から外れていれば、拒否する", async () => {
    const { repo } = makeRepo();
    writeFileSync(join(repo, ".gitignore"), "state*\n!state/\n");
    const r = await checkStateDirIgnored({ stateDir: join(repo, "state"), repoRoot: repo });
    expect(r.ok).toBe(false);
  });

  it("ignore があっても、追跡されているファイルを含むなら拒否する", async () => {
    const { repo } = makeRepo();
    writeFileSync(join(repo, ".gitignore"), "state/\n");
    mkdirSync(join(repo, "state"));
    writeFileSync(join(repo, "state", "root-token"), "x");
    git(repo, "add", "-f", "state/root-token");
    const r = await checkStateDirIgnored({ stateDir: join(repo, "state"), repoRoot: repo });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.cause).toContain("追跡");
    expect(r.error.nextActions.join("\n")).toContain("git rm --cached");
  });

  it("repoRoot が git のリポジトリでなければ、拒否する（確かめられない）", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-ignore-nogit-")));
    const repo = join(base, "repo");
    mkdirSync(repo);
    // 親が git のリポジトリになっていないことを、前提にする（tmp の下）
    const r = await checkStateDirIgnored({ stateDir: join(repo, "state"), repoRoot: repo });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("invalidConfig");
  });

  it("git が使えないときは、git の説明つきで拒否する", async () => {
    const { repo } = makeRepo();
    const run: GitRunner = async () => ({ code: 1, stdout: "", stderr: GIT_MISSING_MESSAGE });
    const r = await checkStateDirIgnored({ stateDir: join(repo, "state"), repoRoot: repo }, run);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.cause).toContain("git（Xcode Command Line Tools）が使えません");
  });

  it("check-ignore が 128 などで失敗したら、拒否する（安全側）", async () => {
    const { repo } = makeRepo();
    const run: GitRunner = async (args) =>
      args[0] === "ls-files"
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 128, stdout: "", stderr: "fatal: oops" };
    const r = await checkStateDirIgnored({ stateDir: join(repo, "state"), repoRoot: repo }, run);
    expect(r.ok).toBe(false);
  });

  it("リンク: repoRoot の外へのリンクは、実パスで外側と判定され、検査の対象にならない", async () => {
    const { base, repo } = makeRepo();
    mkdirSync(join(base, "outside"));
    symlinkSync(join(base, "outside"), join(repo, "link"));
    const run: GitRunner = async () => {
      throw new Error("git を呼んではならない");
    };
    const r = await checkStateDirIgnored(
      { stateDir: join(repo, "link", "state"), repoRoot: repo },
      run,
    );
    expect(r.ok).toBe(true);
  });

  it("リンク: repoRoot の中へのリンクは、実パスで内側と判定され、ignore を確かめる", async () => {
    const { base, repo } = makeRepo();
    mkdirSync(join(repo, "real"));
    symlinkSync(join(repo, "real"), join(base, "alias"));
    const notIgnored = await checkStateDirIgnored({
      stateDir: join(base, "alias", "state"),
      repoRoot: repo,
    });
    expect(notIgnored.ok).toBe(false);
    writeFileSync(join(repo, ".gitignore"), "real/\n");
    const ignored = await checkStateDirIgnored({
      stateDir: join(base, "alias", "state"),
      repoRoot: repo,
    });
    expect(ignored.ok).toBe(true);
  });
});
