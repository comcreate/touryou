import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CHILD_WORKTREE_MARKER, detectOpenMode } from "../src/child-marker.js";
import { runStdio } from "../src/stdio.js";

// 子の作業ツリーの印で、mcp の開き方を決める。
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const hasGit = spawnSync("git", ["--version"]).error === undefined;

describe("detectOpenMode", () => {
  type K = "file" | "dir" | "other" | "none" | "unknown";
  const fs = (kinds: Record<string, K>, files: Record<string, string | Error> = {}) => ({
    kindOf: (p: string): K => kinds[p] ?? "none",
    read: (p: string): string => {
      const v = files[p];
      if (v === undefined) throw new Error("ENOENT");
      if (v instanceof Error) throw v;
      return v;
    },
  });
  it("`.git` が見つからないなら root", () => {
    expect(detectOpenMode("/x/y", fs({}))).toEqual({ kind: "root" });
  });
  it("元のリポジトリ（`.git` がディレクトリ）で印がないなら root", () => {
    expect(detectOpenMode("/r/sub", fs({ "/r/.git": "dir" }))).toEqual({ kind: "root" });
  });
  it("追加の作業ツリーで印があれば pending（相対の gitdir も解く。git は呼ばない）", () => {
    const ops = fs(
      { "/w/a/.git": "file", "/r/.git/worktrees/a/touryou-child": "file" },
      {
        "/w/a/.git": "gitdir: ../../r/.git/worktrees/a\n",
        "/r/.git/worktrees/a/touryou-child": "node-a\n",
      },
    );
    expect(detectOpenMode("/w/a", ops)).toEqual({ kind: "pending", nodeId: "node-a" });
    expect(detectOpenMode("/w/a/src/deep", ops)).toEqual({ kind: "pending", nodeId: "node-a" });
  });
  it("追加の作業ツリーで印がないなら root（利用者が自分で作った作業ツリー）", () => {
    const ops = fs({ "/w/a/.git": "file" }, { "/w/a/.git": "gitdir: /r/.git/worktrees/a" });
    expect(detectOpenMode("/w/a", ops)).toEqual({ kind: "root" });
  });
  it("`.git` のファイルが読めない・形が変・読めない `.git` は pending に倒す（git がない・時間切れの代わり）", () => {
    expect(
      detectOpenMode("/w/a", fs({ "/w/a/.git": "file" }, { "/w/a/.git": new Error("EACCES") })),
    ).toEqual({
      kind: "pending",
    });
    expect(detectOpenMode("/w/a", fs({ "/w/a/.git": "file" }, { "/w/a/.git": "garbage" }))).toEqual(
      {
        kind: "pending",
      },
    );
    expect(detectOpenMode("/w/a", fs({ "/w/a/.git": "unknown" }))).toEqual({ kind: "pending" });
  });
  it("印があるのに読めない・形が変なら pending に倒す", () => {
    const base = { "/w/a/.git": "file" as K, "/g/touryou-child": "file" as K };
    expect(
      detectOpenMode(
        "/w/a",
        fs(base, { "/w/a/.git": "gitdir: /g", "/g/touryou-child": new Error("EACCES") }),
      ),
    ).toEqual({ kind: "pending" });
    expect(
      detectOpenMode("/w/a", fs(base, { "/w/a/.git": "gitdir: /g", "/g/touryou-child": "../x y" })),
    ).toEqual({ kind: "pending" });
    expect(
      detectOpenMode(
        "/w/a",
        fs({ "/w/a/.git": "file", "/g/touryou-child": "unknown" }, { "/w/a/.git": "gitdir: /g" }),
      ),
    ).toEqual({
      kind: "pending",
    });
  });

  it.skipIf(!hasGit)(
    "本物の git: 追加の作業ツリーの git のディレクトリに置いた印を見つける。元のリポジトリは root",
    () => {
      const d = mkdtempSync(join(tmpdir(), "touryou-marker-"));
      made.push(d);
      const repo = join(d, "repo");
      mkdirSync(repo);
      const git = (args: string[], cwd = repo) => {
        const r = spawnSync("git", args, { cwd, encoding: "utf8" });
        if (r.status !== 0) throw new Error(r.stderr);
        return r.stdout.trim();
      };
      git(["init", "-q"]);
      git([
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
      ]);
      const tree = join(d, "tree");
      git(["worktree", "add", "-q", tree]);
      const dir = git(["rev-parse", "--absolute-git-dir"], tree);
      writeFileSync(join(dir, CHILD_WORKTREE_MARKER), "node-a\n");
      expect(detectOpenMode(tree)).toEqual({ kind: "pending", nodeId: "node-a" });
      expect(detectOpenMode(repo)).toEqual({ kind: "root" });
      // 印は追跡されない（作業ツリーは綺麗なまま）
      expect(git(["status", "--porcelain"], tree)).toBe("");
    },
  );
});

describe("runStdio の紐付け待ち", () => {
  it("印があれば、根のトークンを読まずに開く", async () => {
    const h = mkdtempSync(join(tmpdir(), "touryou-pending-"));
    made.push(h);
    const touryou = join(h, ".touryou");
    const state = join(touryou, "state");
    mkdirSync(state, { recursive: true });
    chmodSync(touryou, 0o700);
    chmodSync(state, 0o700);
    writeFileSync(join(touryou, "config.json"), JSON.stringify({ stateDir: state }), {
      mode: 0o600,
    });
    writeFileSync(join(state, "root-token"), `${"r".repeat(43)}\n`, { mode: 0o600 });
    writeFileSync(join(state, "port"), "45678\n", { mode: 0o600 });
    const readPaths: string[] = [];
    const { readFileSync } = await import("node:fs");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const err: string[] = [];
    const run = runStdio(
      [],
      { HOME: h, TOURYOU_DAEMON_CONFIG: join(touryou, "config.json") },
      { stderr: (x) => err.push(x) },
      {
        streams: { stdin, stdout },
        cwd: () => "/w/a",
        marker: {
          kindOf: (p) => (p === "/w/a/.git" || p === "/g/touryou-child" ? "file" : "none"),
          read: (p) => (p === "/w/a/.git" ? "gitdir: /g" : "a"),
        },
        files: {
          read: (p) => {
            readPaths.push(p);
            if (p.endsWith("root-token")) throw new Error("根のトークンを読んだ");
            return readFileSync(p, "utf8");
          },
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.end();
    expect(await run).toBe(0);
    expect(readPaths.some((p) => p.endsWith("root-token"))).toBe(false);
    expect(err.join("")).toContain("stdioPendingBind");
  });
});

describe("印の探し方（submodule・CRLF・symlink の .git）", () => {
  type K = "file" | "dir" | "other" | "none" | "unknown";
  const fs = (kinds: Record<string, K>, files: Record<string, string> = {}) => ({
    kindOf: (p: string): K => kinds[p] ?? "none",
    read: (p: string): string => {
      const v = files[p];
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
  });
  it("子の作業ツリーの中の submodule で起動しても、上の印を見つけて pending", () => {
    const ops = fs(
      { "/w/a/sub/.git": "file", "/w/a/.git": "file", "/r/.git/worktrees/a/touryou-child": "file" },
      {
        "/w/a/sub/.git": "gitdir: /r/.git/worktrees/a/modules/sub",
        "/w/a/.git": "gitdir: /r/.git/worktrees/a",
        "/r/.git/worktrees/a/touryou-child": "a",
      },
    );
    expect(detectOpenMode("/w/a/sub/x", ops)).toEqual({ kind: "pending", nodeId: "a" });
  });
  it("根のリポジトリの中の submodule は root のまま", () => {
    const ops = fs(
      { "/r/sub/.git": "file", "/r/.git": "dir" },
      { "/r/sub/.git": "gitdir: ../.git/modules/sub" },
    );
    expect(detectOpenMode("/r/sub", ops)).toEqual({ kind: "root" });
  });
  it("CRLF の `.git` のファイルも読める", () => {
    const ops = fs(
      { "/w/a/.git": "file", "/g/touryou-child": "file" },
      { "/w/a/.git": "gitdir: /g\r\n", "/g/touryou-child": "a" },
    );
    expect(detectOpenMode("/w/a", ops)).toEqual({ kind: "pending", nodeId: "a" });
  });
  it("`.git` が symlink のリポジトリ（本物のファイル）は、辿った先がディレクトリなので root", async () => {
    const { symlinkSync } = await import("node:fs");
    const d = mkdtempSync(join(tmpdir(), "touryou-symlink-"));
    made.push(d);
    mkdirSync(join(d, "real-git"));
    mkdirSync(join(d, "repo"));
    symlinkSync(join(d, "real-git"), join(d, "repo", ".git"));
    expect(detectOpenMode(join(d, "repo"))).toEqual({ kind: "root" });
  });
  it("`.git` が壊れた symlink なら pending に倒す（上へ探し続けない）", async () => {
    const { symlinkSync } = await import("node:fs");
    const d = mkdtempSync(join(tmpdir(), "touryou-broken-"));
    made.push(d);
    mkdirSync(join(d, "repo"));
    symlinkSync(join(d, "missing"), join(d, "repo", ".git"));
    expect(detectOpenMode(join(d, "repo"))).toEqual({ kind: "pending" });
  });
});
