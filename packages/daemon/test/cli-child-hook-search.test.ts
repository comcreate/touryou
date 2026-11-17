/**
 * #92: CLI の子のフック（POST /v1/hook）の道で、作業ツリーの中を探す読み取りだけのコマンドが通ること。
 * 本物の daemon（createDaemon）と、本物の git の作業ツリー（git worktree add）で確かめる。
 * CLI の子は dontAsk で、起動のときの許可の一覧はブリーフの範囲だけなので、daemon は明示の許可（permit: readOnlySearch）を返す。
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ok } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type DaemonDeps, type WorktreePorts } from "../src/compose.js";
import { FakeCliAdapter } from "./sdk/fakes.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [
    "-C",
    cwd,
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "user.name=t",
    ...args,
  ]);

const scope = {
  writableLocations: ["src"],
  forbiddenLocations: [".git"],
  allowedCommands: ["git status"],
};

async function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-cli-search-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  const stateDir = join(base, "state");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  git(repoRoot, "init", "-q");
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "src", "a.ts"), "export const foo = 1;\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-q", "-m", "init");
  const launcher = new FakeCliAdapter();
  const worktree: WorktreePorts = {
    factsFor: async () => undefined,
    removeWorktree: async () => ok(undefined),
    provisionWorktree: async ({ nodeId }) => {
      const p = join(worktreeRoot, nodeId);
      git(repoRoot, "worktree", "add", "-q", "-b", `touryou/${nodeId}`, p);
      return ok({ worktreePath: p });
    },
    cwdOf: async (id) => join(worktreeRoot, id),
  };
  const deps: DaemonDeps = {
    cliAdapter: launcher,
    worktree,
    probe: async () => [],
    logLine: () => {},
    confirmationOut: () => {},
  };
  const made = createDaemon(
    {
      stateDir,
      repoRoot,
      worktreeRoot,
      rootCwd: repoRoot,
      rootNodeId: "root",
      rootScope: scope,
      port: 0,
    },
    deps,
  );
  if (!made.ok) throw new Error(`${made.error.code}: ${made.error.cause}`);
  const run = await made.value.start();
  cleanups.push(() => made.value.stop());
  const log = made.value.log;
  launcher.sink = { record: (q) => log.append(q), recordAll: (qs) => log.appendAll(qs) };
  const rootToken = readFileSync(run.rootTokenPath, "utf8").trim();
  const spawnOne = async () => {
    const res = await fetch(`${run.url}/v1/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${rootToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: `q-${Math.random()}`.replace(".", ""),
        operation: "node.spawn",
        params: {
          parentId: "root",
          role: "implement",
          objective: "x",
          acceptanceCriteria: ["x"],
          scope,
        },
      }),
    });
    const json = (await res.json()) as { ok: boolean; value: { nodeId: string } };
    expect(json.ok, JSON.stringify(json)).toBe(true);
    return { nodeId: json.value.nodeId, token: launcher.sessions.at(-1)?.token ?? "" };
  };
  const child = await spawnOne();
  const other = await spawnOne();
  const tree = join(worktreeRoot, child.nodeId);
  // 作業ツリーの中を指すリンク（`cd l && cd ../../..` で外へ出られないことを確かめる）
  mkdirSync(join(tree, "src", "b", "c"), { recursive: true });
  symlinkSync(join(tree, "src", "b", "c"), join(tree, "l"));
  // 作業ツリーの外を指すリンク（`ls x/..` で外へ出られないことを確かめる）
  mkdirSync(join(base, "outside", "out", "deep"), { recursive: true });
  writeFileSync(join(base, "outside", "out", "secret.txt"), "foo\n");
  symlinkSync(join(base, "outside", "out", "deep"), join(tree, "x"));
  const hook = async (command: string, cwd = tree) => {
    const res = await fetch(`${run.url}/v1/hook`, {
      method: "POST",
      headers: { authorization: `Bearer ${child.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "s-1",
        cwd,
        tool_name: "Bash",
        tool_input: { command, description: "探す" },
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { value: { decision: string; permit?: string } }).value;
  };
  // macOS の /var → /private/var のように、リンクを通る作業ツリーの置き場
  const link = join(base, "link");
  symlinkSync(worktreeRoot, link);
  const linkedTree = join(link, child.nodeId);
  return { base, repoRoot, stateDir, tree, linkedTree, other, hook };
}

describe("CLI の子のフック: 作業ツリーの中を探すコマンド（#92）", () => {
  it("範囲の allowedCommands になくても通り、明示の許可（permit: readOnlySearch）が付く", async () => {
    const s = await setup();
    for (const command of [
      "ls src",
      "find src -name '*.ts'",
      "grep -rn foo src",
      "git ls-files",
      "git grep foo",
    ]) {
      expect(await s.hook(command), command).toEqual({
        decision: "allow",
        permit: "readOnlySearch",
      });
    }
    // 作業ツリーの配下に cd したときも、相対のパスはそこから解く
    expect(await s.hook("ls .", join(s.tree, "src"))).toEqual({
      decision: "allow",
      permit: "readOnlySearch",
    });
  });

  it("実機の Claude Code が送りがちな形も通る（cd を前に付ける・旗をまとめる・エラー出力を捨てる・head で絞る・絶対パス・リンクを通る置き場）", async () => {
    const s = await setup();
    const cases: [string, string][] = [
      [`cd ${s.tree} && ls src`, s.tree],
      ["cd src && ls", s.tree],
      ["ls -la src", s.tree],
      ["ls src/", s.tree],
      ["ls src 2>/dev/null", s.tree],
      ["find src -type f | head -50", s.tree],
      ["find src -name '*.ts' 2>/dev/null | head -n 20", s.tree],
      ["grep -rn \"TODO\" src --include='*.ts'", s.tree],
      ["grep -rln foo src | sort | uniq -c | wc -l", s.tree],
      [`ls ${s.tree}/src`, s.tree],
      ["ls ../src", join(s.tree, "src")],
      ["ls", join(s.tree, "src")],
      [`ls ${s.linkedTree}/src`, s.tree],
      ["cd l && ls", s.tree],
      ["ls src", s.linkedTree],
      [`cd ${s.tree}/src && grep -rn foo .`, s.tree],
      ["cd src && ls ..", s.tree],
      ["cd src && ls | head", s.tree],
    ];
    for (const [command, cwd] of cases) {
      expect(await s.hook(command, cwd), `${command}（cwd: ${cwd}）`).toEqual({
        decision: "allow",
        permit: "readOnlySearch",
      });
    }
  });

  it("範囲にあるコマンドは、明示の許可を付けずに通す（起動のときの一覧で通る）", async () => {
    const s = await setup();
    expect(await s.hook("git status")).toEqual({ decision: "allow" });
  });

  it("作業ツリーの外のパス・禁じる場所・許さない旗は断る", async () => {
    const s = await setup();
    for (const command of [
      "ls /etc",
      "ls ..",
      "grep -rn foo ../",
      `find ${s.repoRoot} -name '*.ts'`,
      `ls ${s.stateDir}`,
      `ls ${join(s.repoRoot, ".git", "worktrees", s.other.nodeId)}`,
      "find src -exec cat {} +",
      "ls src > out",
      "ls src 2>out",
      "ls src >/dev/null 2>&1 && rm -rf src",
      "find -L src -name x",
      "grep -R foo src",
      `cd ${s.repoRoot} && ls src`,
      "cd .. && ls",
      "cd /etc && ls",
      "cd src",
      "cd src; ls",
      "cd src || ls",
      "cd src | ls",
      "cd src && cd .. && ls",
      "cd src && ls ../..",
      "cd - && ls",
      "cd ~ && ls",
      "cd -P src && ls",
      "cd $HOME && ls",
      "ls src && cd src && ls",
      `cd ${s.linkedTree} && git grep foo`,
      "cd l && cd ../../.. && ls",
      "cd l && ls ../../..",
      "cd l/.. && ls",
      "ls src | uniq - out.txt",
      "ls src | uniq src/x src/y",
      "ls src | head -c 5 src/a.ts",
      "ls src ; head",
      "ls x/..",
      "grep -r foo x/..",
      "find x/.. -name secret.txt",
      "cd src && ls ../x/..",
      "ls src && wc",
      `ls ${join(s.repoRoot, ".git", "worktrees", basename(s.tree))}`,
      "head src/a.ts",
      "find src | tail -f",
      "find src | sort -o out",
      "find src | xargs cat",
      `ls ${join(s.base, "link")}`,
      `ls ${s.linkedTree}/../`,
    ]) {
      expect((await s.hook(command)).decision, command).toBe("deny");
    }
    // cwd が作業ツリーの外なら、探すコマンドとしては許さない
    expect((await s.hook("ls src", s.repoRoot)).decision).toBe("deny");
  });
});
