import type { Scope } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { childAllowList } from "../../src/sdk/child-permissions.js";
import { decideToolUse } from "../../src/sdk/hook-policy.js";
import { isReadOnlySearch } from "../../src/sdk/read-only-search.js";

/**
 * #92: native 版の Claude Code は Glob・Grep の道具を出さず、Bash の find・grep で探させる。
 * 子は、範囲の allowedCommands が空でも、作業ツリーの中を探す読み取りだけのコマンドを使える。外・禁じる場所・書き込みは拒否する。
 */
const S = "/home/u/state";
const WT = "/home/u/wt/a";
const scope: Scope = { writableLocations: [WT], forbiddenLocations: [], allowedCommands: [] };
const prot = {
  roots: [{ path: S, kind: "stateDir" as const }],
  allow: [] as string[],
  home: "/home/u",
  worktree: WT,
};
const links: Record<string, string> = { [`${WT}/out`]: "/etc" };
const resolve = async (p: string) => {
  const { posix } = await import("node:path");
  const r = posix.resolve(p);
  for (const [from, to] of Object.entries(links)) {
    if (r === from || r.startsWith(`${from}/`)) return to + r.slice(from.length);
  }
  return r;
};
const allowed = async (command: string, toolCwd = WT) =>
  (await decideToolUse(scope, WT, "Bash", { command }, resolve, prot, toolCwd)).allow;

describe("作業ツリーの中を探すコマンドは、範囲が空でも許す", () => {
  it.each([
    "ls",
    "ls -la docs .sdd",
    "find . -name '*.md'",
    "find docs -type f",
    "grep -rn touryou docs",
    "grep -rn 'foo$' .",
    "git ls-files",
    "git ls-files -- '*.ts'",
    "git grep -n childAllowList",
    "git ls-files | grep sdk",
    "ls docs && git grep -n x -- packages",
  ])("%s", async (c) => {
    expect(await allowed(c)).toBe(true);
  });

  it("作業ツリーの配下に cd した先からも、中を探せる", async () => {
    expect(await allowed("grep -rn x ..", `${WT}/docs`)).toBe(true);
  });
});

describe("外・書き込み・コマンドの実行を伴うものは許さない", () => {
  it.each([
    "ls /",
    "ls ..",
    "ls ~",
    "grep -r token /home/u",
    "grep -r x ../b",
    "find / -name x",
    "find . -exec cat {} ;",
    "find . -delete",
    "find . -fprint out.txt",
    "grep --filter=sh x .",
    "grep --pager=less x .",
    "grep -Q x",
    "grep --save-config x",
    "git grep -O x",
    "git grep --open-files-in-pager=vi x",
    "git grep --textconv x",
    "git -C / grep x",
    "git -c core.pager=sh grep x",
    "ls out",
    "grep -r x out/passwd",
    "ls > list.txt",
    "ls $(echo /)",
    "ls &",
    "cd .. && ls",
    "ls && rm -rf x",
    "grep --file=/etc/passwd x .",
  ])("%s", async (c) => {
    expect(await allowed(c)).toBe(false);
  });

  it("禁じる場所（state）は、作業ツリーの下にあっても拒否", async () => {
    const p2 = { ...prot, roots: [{ path: `${WT}/secret`, kind: "stateDir" as const }] };
    const r = await decideToolUse(scope, WT, "Bash", { command: "grep -r x secret" }, resolve, p2);
    expect(r.allow).toBe(false);
    const r2 = await decideToolUse(scope, WT, "Bash", { command: "grep -r x ." }, resolve, p2);
    expect(r2.allow).toBe(false);
  });

  it("作業ツリーの外からは使えない", async () => {
    expect(await isReadOnlySearch("ls", "/home/u", WT, resolve)).toBe(false);
  });
});

describe("子が持つ道具の許し（permissions.allow）", () => {
  it("Read・Grep・Glob は作業ツリーの中だけ。探すコマンドの Bash の規則は足さない（フックのない子で find -exec を通さない）", () => {
    const r = childAllowList({ ...scope, writableLocations: [] }, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.allow).toEqual(["Read(./**)", "Grep(./**)", "Glob(./**)"]);
    expect(r.value.allow.some((a) => a.startsWith("Bash("))).toBe(false);
  });
});
