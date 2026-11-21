import type { Scope } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { decideToolUse } from "../../src/sdk/hook-policy.js";

/**
 * #179: 探すコマンドが commandNotAllowed で拒否されたとき、どの段で落ちたか・cwd が作業ツリーの中だったかを、違反の記録（violation.diagnosis）に残す。
 * 禁じる場所の実パスは、記録にも拒否の文面にも出さない。
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
const decide = (command: string, toolCwd = WT, p = prot) =>
  decideToolUse(scope, WT, "Bash", { command }, resolve, p, toolCwd);

describe("commandNotAllowed の記録に、落ちた段と cwd の内外が残る", () => {
  it.each([
    ["フックの cwd が作業ツリーの外", "ls", "/home/u/elsewhere", "cwdOutside", false],
    ["展開文字", "ls *.md", WT, "unquotedExpansion", true],
    ["許さないオプション", "find . -delete", WT, "optionNotAllowed", true],
    ["位置の引数が外", "ls out", WT, "pathOutside", true],
    ["ほかのコマンドが混在", "ls && rm -rf x", WT, "notSearchCommand", true],
    ["探すコマンドではない", "rm -rf x", WT, "notSearchCommand", true],
    ["許さない区切り", "ls & ls", WT, "separator", true],
    ["絞るコマンドが先頭", "head -n 5", WT, "filterRejected", true],
  ] as const)("%s: %s", async (_name, command, cwd, stage, cwdInside) => {
    const d = await decide(command, cwd);
    expect(d.allow).toBe(false);
    if (d.allow) return;
    // 診断は、Bash の範囲の拒否すべてに付く（理由は commandNotAllowed のほか、indirectExecution などもある）
    expect(d.violation?.diagnosis).toEqual({ cwdInside, stage });
  });

  it("commandNotAllowed の拒否に診断が付く", async () => {
    const d = await decide("ls *.md");
    expect(d.allow).toBe(false);
    if (d.allow) return;
    expect(d.violation?.reason).toBe("commandNotAllowed");
    expect(d.violation?.diagnosis?.stage).toBe("unquotedExpansion");
  });

  it("禁じる場所が作業ツリーと重なるとき（protectedOverlap）", async () => {
    const overlap = { ...prot, roots: [{ path: `${WT}/.state`, kind: "stateDir" as const }] };
    const d = await decide("ls", WT, overlap);
    expect(d.allow).toBe(false);
    if (d.allow) return;
    expect(d.violation?.diagnosis).toEqual({ cwdInside: true, stage: "protectedOverlap" });
  });

  it("許可されるコマンドと、これまでの拒否の理由は変わらない", async () => {
    expect((await decide("ls docs")).allow).toBe(true);
    const d = await decide("rm -rf x");
    expect(d.allow).toBe(false);
    if (d.allow) return;
    expect(d.violation?.reason).toBe("commandNotAllowed");
    expect(d.violation?.subject).toBe("rm -rf x");
  });

  it("禁じる場所の実パスは、記録にも拒否の文面にも出ない", async () => {
    for (const [command, cwd] of [
      ["ls", "/home/u/elsewhere"],
      ["ls out", WT],
      ["rm -rf x", WT],
    ] as const) {
      const d = await decide(command, cwd);
      expect(d.allow).toBe(false);
      if (d.allow) continue;
      expect(JSON.stringify(d)).not.toContain(S);
    }
  });
});
