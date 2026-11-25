import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { decideToolUse } from "../../src/sdk/hook-policy.js";
import { realPathForWrite } from "../../src/state-dir-ignore.js";

/**
 * #288: 子は、`<repoRoot>/.touryou/` の、自分の作業ツリー以外（state・config.json・logs・ほかの子の作業ツリー・リンク経由）を、
 * 読み取り・書き込みとも既定で拒否される。compose.ts の decideCliHook と同じ形（roots は stateDir と `.touryou/` 全体、
 * allow は自分の作業ツリー 1 つ）で渡し、実際のファイルとリンクで確かめる。
 */
const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-dir-")));
const repo = join(base, "repo");
const dir = join(repo, ".touryou");
const state = join(dir, "state");
const logs = join(dir, "logs");
const wtA = join(dir, "worktrees", "a");
const wtB = join(dir, "worktrees", "b");
const wtA0 = join(dir, "worktrees", "a0"); // 名前が「a」で始まる、ほかの子
const config = join(dir, "config.json");
for (const d of [state, logs, wtA, wtB, wtA0]) mkdirSync(d, { recursive: true });
for (const f of [
  join(state, "root-token"),
  join(logs, "daemon.log"),
  join(wtA, "own.txt"),
  join(wtB, "other.txt"),
  join(wtA0, "other.txt"),
  config,
]) {
  writeFileSync(f, "x\n");
}
// 自分の作業ツリーの中から、ほかへ向かうリンク
symlinkSync(wtB, join(wtA, "link-b"));
symlinkSync(wtA0, join(wtA, "link-a0"));
symlinkSync(state, join(wtA, "link-state"));
symlinkSync(config, join(wtA, "link-config"));
symlinkSync(dir, join(wtA, "link-dir"));

const scope: Scope = {
  writableLocations: [wtA],
  forbiddenLocations: [],
  allowedCommands: ["cat", "echo", "ls"],
};
const prot = (allow: string[]) => ({
  roots: [
    { path: state, kind: "stateDir" as const },
    { path: dir, kind: "touryouDir" as const },
  ],
  allow,
  home: base,
  worktree: wtA,
});
const resolve = async (p: string) => realPathForWrite(p);
const verdict = async (tool: string, input: unknown, allow: string[] = [wtA]) => {
  const r = await decideToolUse(scope, wtA, tool, input, resolve, prot(allow), wtA);
  return r.allow ? null : (r.violation?.subject ?? r.violation?.reason ?? "denied");
};

describe("子から .touryou/ を守る（自分の作業ツリーだけ除く）", () => {
  it("自分の作業ツリーの中は、読み書きできる", async () => {
    expect(await verdict("Read", { file_path: join(wtA, "own.txt") })).toBeNull();
    expect(await verdict("Write", { file_path: join(wtA, "new.txt"), content: "x" })).toBeNull();
    expect(await verdict("Bash", { command: `cat ${join(wtA, "own.txt")}` })).toBeNull();
  });

  it("state・config.json・logs・ほかの子の作業ツリーは、読み取りも拒否される", async () => {
    expect(await verdict("Read", { file_path: join(state, "root-token") })).toBe(
      "protected:stateDir",
    );
    expect(await verdict("Read", { file_path: config })).toBe("protected:touryouDir");
    expect(await verdict("Read", { file_path: join(logs, "daemon.log") })).toBe(
      "protected:touryouDir",
    );
    expect(await verdict("Read", { file_path: join(wtB, "other.txt") })).toBe(
      "protected:touryouDir",
    );
    expect(await verdict("Bash", { command: `cat ${config}` })).toBe("protected:touryouDir");
  });

  it("名前が前方一致するだけの、ほかの子の作業ツリー（a0）は、自分（a）の許しに含まれない", async () => {
    expect(await verdict("Read", { file_path: join(wtA0, "other.txt") })).toBe(
      "protected:touryouDir",
    );
  });

  it("書き込みも拒否される（state・config.json・ほかの子）", async () => {
    for (const p of [join(state, "x"), config, join(wtB, "other.txt"), join(logs, "x")]) {
      expect(await verdict("Write", { file_path: p, content: "x" }), p).not.toBeNull();
    }
    expect(await verdict("Bash", { command: `echo x > ${config}` })).not.toBeNull();
  });

  it("自分の作業ツリーの中のリンクを通っても、ほかの子・state・config.json・.touryou/ には届かない", async () => {
    expect(await verdict("Read", { file_path: join(wtA, "link-b", "other.txt") })).toBe(
      "protected:touryouDir",
    );
    expect(await verdict("Read", { file_path: join(wtA, "link-a0", "other.txt") })).toBe(
      "protected:touryouDir",
    );
    expect(await verdict("Read", { file_path: join(wtA, "link-state", "root-token") })).toBe(
      "protected:stateDir",
    );
    expect(await verdict("Read", { file_path: join(wtA, "link-config") })).toBe(
      "protected:touryouDir",
    );
    expect(await verdict("Read", { file_path: join(wtA, "link-dir", "config.json") })).toBe(
      "protected:touryouDir",
    );
    expect(
      await verdict("Write", { file_path: join(wtA, "link-b", "x"), content: "x" }),
    ).not.toBeNull();
    expect(
      await verdict("Write", { file_path: join(wtA, "link-config"), content: "x" }),
    ).not.toBeNull();
    expect(await verdict("Bash", { command: `cat ${join(wtA, "link-b", "other.txt")}` })).toBe(
      "protected:touryouDir",
    );
  });

  it("再帰で読む道具（Grep・Glob）で、.touryou/・worktrees/ 全体を探すと拒否される", async () => {
    // .touryou/ 全体を探すと、配下の state（先に当たる禁じる場所）か .touryou/ のどちらかで、必ず拒否される
    expect(await verdict("Grep", { pattern: "x", path: dir })).toMatch(/^protected:/);
    expect(await verdict("Grep", { pattern: "x", path: join(dir, "worktrees") })).toBe(
      "protected:touryouDir",
    );
    expect(await verdict("Glob", { pattern: join(dir, "**", "*") })).toMatch(/^protected:/);
    expect(await verdict("Grep", { pattern: "x", path: wtA })).toBeNull();
  });
});
