import { describe, expect, it } from "vitest";
import {
  evaluate,
  isScopeSubset,
  matchRule,
  type ParsedRule,
  parseRule,
  ruleErrors,
  type Scope,
} from "../src/index.js";

const parsed = (rule: string): ParsedRule => {
  const r = parseRule(rule);
  if (!r.ok) throw new Error(`解析できない: ${rule} (${r.problem})`);
  return r.rule;
};
const cmd = (command: string) => ({ kind: "command", command }) as const;
const write = (path: string) => ({ kind: "write", path }) as const;
const mcp = (tool: string) => ({ kind: "mcp", tool }) as const;

describe("parseRule: 正常系", () => {
  it("Bash の前方一致・完全一致", () => {
    expect(parsed("Bash(grep -rn:*)")).toEqual({ kind: "bashPrefix", words: ["grep", "-rn"] });
    expect(parsed("Bash(git status)")).toEqual({ kind: "bashExact", words: ["git", "status"] });
  });
  it("引用符は命令と同じ字句解析で外す", () => {
    expect(parsed('Bash(git grep -E "A|B":*)')).toEqual({
      kind: "bashPrefix",
      words: ["git", "grep", "-E", "A|B"],
    });
  });
  it("Edit は相対パスを畳む", () => {
    expect(parsed("Edit(docs/**)")).toEqual({ kind: "edit", dir: "docs" });
    expect(parsed("Edit(./src/a/**)")).toEqual({ kind: "edit", dir: "src/a" });
  });
  it("MCP のツールとサーバー", () => {
    expect(parsed("mcp__playwright__browser_snapshot")).toEqual({
      kind: "mcpTool",
      server: "playwright",
      tool: "browser_snapshot",
    });
    expect(parsed("mcp__plugin_touryou_node__whoami")).toEqual({
      kind: "mcpTool",
      server: "plugin_touryou_node",
      tool: "whoami",
    });
    expect(parsed("mcp__playwright")).toEqual({ kind: "mcpServer", server: "playwright" });
  });
});

describe("parseRule: 異常系（フェイルクローズ）", () => {
  const problemOf = (rule: string) => {
    const r = parseRule(rule);
    return r.ok ? null : r.problem;
  };
  it("空・前後の空白", () => {
    expect(problemOf("")).toBe("empty");
    expect(problemOf("   ")).toBe("empty");
    expect(problemOf(" Bash(ls:*)")).toBe("unsupported");
  });
  it("対応しない書き方", () => {
    expect(problemOf("Read(docs/**)")).toBe("unsupported");
    expect(problemOf("Bash")).toBe("unsupported");
    expect(problemOf("Bash(a *)")).toBe("unsupported");
    expect(problemOf("Bash(*)")).toBe("unsupported");
    expect(problemOf("mcp__playwright__*")).toBe("unsupported");
    expect(problemOf("mcp__*")).toBe("unsupported");
    expect(problemOf("Edit(docs/*)")).toBe("unsupported");
    expect(problemOf("Edit(docs)")).toBe("unsupported");
  });
  it("Bash の語が不正", () => {
    expect(problemOf("Bash()")).toBe("emptyCommand");
    expect(problemOf("Bash(:*)")).toBe("emptyCommand");
    expect(problemOf("Bash(ls; rm:*)")).toBe("unparsable");
    expect(problemOf("Bash(echo $HOME:*)")).toBe("unparsable");
  });
  it("Edit の場所が不正", () => {
    expect(problemOf("Edit(/etc/**)")).toBe("invalidPath");
    expect(problemOf("Edit(../x/**)")).toBe("invalidPath");
    expect(problemOf("Edit(a/../../x/**)")).toBe("invalidPath");
    expect(problemOf("Edit(/**)")).toBe("invalidPath");
    expect(problemOf("Edit(**)")).toBe("unsupported");
    expect(problemOf("Edit(./**)")).toBe("invalidPath");
  });
  it("MCP の名前が不正", () => {
    expect(problemOf("mcp__")).toBe("invalidMcpName");
    expect(problemOf("mcp__a__")).toBe("invalidMcpName");
    expect(problemOf("mcp____b")).toBe("invalidMcpName");
    expect(problemOf("mcp__a b__c")).toBe("invalidMcpName");
    expect(problemOf("mcp__a__b.c")).toBe("invalidMcpName");
  });
  it("ruleErrors は誤りだけ集める", () => {
    const errs = ruleErrors(["Bash(ls:*)", "bogus", "Edit(../x/**)"]);
    expect(errs.map((e) => e.rule)).toEqual(["bogus", "Edit(../x/**)"]);
  });
});

describe("matchRule: コマンド", () => {
  it("前方一致は語の境界で見る（cd と cdx）", () => {
    const r = parsed("Bash(cd:*)");
    expect(matchRule(r, cmd("cd src"))).toBe(true);
    expect(matchRule(r, cmd("cdx src"))).toBe(false);
  });
  it("前方一致: 語の並びの先頭に一致", () => {
    const r = parsed("Bash(grep -rn:*)");
    expect(matchRule(r, cmd("grep -rn foo"))).toBe(true);
    expect(matchRule(r, cmd("grep -rn"))).toBe(true);
    expect(matchRule(r, cmd("grep -r foo"))).toBe(false);
    expect(matchRule(r, cmd("grep -rnx foo"))).toBe(false);
  });
  it("完全一致は語の数まで同じ", () => {
    const r = parsed("Bash(git status)");
    expect(matchRule(r, cmd("git status"))).toBe(true);
    expect(matchRule(r, cmd("git status -s"))).toBe(false);
  });
  it("複数の命令・解析できない文字列には当たらない（区切りごとに渡す前提）", () => {
    const r = parsed("Bash(git status:*)");
    expect(matchRule(r, cmd("git status; rm -rf x"))).toBe(false);
    expect(matchRule(r, cmd("git status && ls"))).toBe(false);
    expect(matchRule(r, cmd("git status $(ls)"))).toBe(false);
  });
  it("別の種類の操作には当たらない", () => {
    expect(matchRule(parsed("Bash(ls:*)"), write("ls"))).toBe(false);
    expect(matchRule(parsed("Bash(ls:*)"), mcp("ls"))).toBe(false);
  });
});

describe("matchRule: 書き込み", () => {
  const r = parsed("Edit(docs/**)");
  it("配下に当たる", () => {
    expect(matchRule(r, write("docs/a.md"))).toBe(true);
    expect(matchRule(r, write("docs/x/y.md"))).toBe(true);
    expect(matchRule(r, write("./docs/a.md"))).toBe(true);
  });
  it("兄弟・親・`..` 経由・絶対パスには当たらない", () => {
    expect(matchRule(r, write("docs2/a.md"))).toBe(false);
    expect(matchRule(r, write("src/a.md"))).toBe(false);
    expect(matchRule(r, write("docs/../src/a.md"))).toBe(false);
    expect(matchRule(r, write("/docs/a.md"))).toBe(false);
    expect(matchRule(r, write(""))).toBe(false);
  });
  it("大文字小文字を畳む（scope.ts と同じ比較）", () => {
    expect(matchRule(r, write("DOCS/a.md"))).toBe(true);
  });
  it("書式制御文字を含むパスには当たらない", () => {
    expect(matchRule(r, write("docs/a​.md"))).toBe(false);
  });
});

describe("matchRule: MCP", () => {
  it("ツールは名前の完全一致", () => {
    const r = parsed("mcp__a__b");
    expect(matchRule(r, mcp("mcp__a__b"))).toBe(true);
    expect(matchRule(r, mcp("mcp__a__b2"))).toBe(false);
    expect(matchRule(r, mcp("mcp__a__B"))).toBe(false);
    expect(matchRule(r, mcp("mcp__aa__b"))).toBe(false);
    expect(matchRule(r, mcp("mcp__a__b__c"))).toBe(false);
  });
  it("サーバーは、そのサーバーの全ツールに当たる（別のサーバーには当たらない）", () => {
    const r = parsed("mcp__a");
    expect(matchRule(r, mcp("mcp__a__x"))).toBe(true);
    expect(matchRule(r, mcp("mcp__a__y"))).toBe(true);
    expect(matchRule(r, mcp("mcp__ab__x"))).toBe(false);
  });
});

describe("evaluate: deny > ask > allow", () => {
  const policy = {
    allow: ["Bash(git:*)", "Edit(docs/**)", "mcp__pw__snap"],
    deny: ["Bash(git push:*)", "Edit(docs/secret/**)"],
    ask: ["Bash(git commit:*)"],
  };
  it("allow だけに当たれば allow", () => {
    expect(evaluate(policy, cmd("git status"))).toBe("allow");
    expect(evaluate(policy, write("docs/a.md"))).toBe("allow");
    expect(evaluate(policy, mcp("mcp__pw__snap"))).toBe("allow");
  });
  it("deny は allow より強い（同じ規則が両方にあっても deny）", () => {
    expect(evaluate(policy, cmd("git push origin main"))).toBe("deny");
    expect(evaluate(policy, write("docs/secret/k.md"))).toBe("deny");
    expect(
      evaluate({ allow: ["Bash(ls:*)"], deny: ["Bash(ls:*)"], ask: [] }, cmd("ls -l")),
    ).toBe("deny");
  });
  it("ask は allow より強く、deny より弱い", () => {
    expect(evaluate(policy, cmd("git commit -m x"))).toBe("ask");
    const both = { allow: ["Bash(git:*)"], deny: ["Bash(git commit:*)"], ask: ["Bash(git commit:*)"] };
    expect(evaluate(both, cmd("git commit -m x"))).toBe("deny");
  });
  it("どれにも当たらなければ none", () => {
    expect(evaluate(policy, cmd("ls"))).toBe("none");
    expect(evaluate(policy, mcp("mcp__pw__navigate"))).toBe("none");
    expect(evaluate({ allow: [], deny: [], ask: [] }, cmd("ls"))).toBe("none");
  });
  it("解析できない規則が混じる方針は、安全側に deny", () => {
    expect(evaluate({ allow: ["Bash(ls:*)", "bogus"], deny: [], ask: [] }, cmd("ls"))).toBe("deny");
    expect(evaluate({ allow: [], deny: ["bogus"], ask: [] }, cmd("ls"))).toBe("deny");
  });
});

describe("Scope.allowedMcpTools と isScopeSubset", () => {
  const base: Scope = {
    writableLocations: ["src"],
    forbiddenLocations: [".git"],
    allowedCommands: ["git status"],
  };
  it("省略は空として扱い、既存の判定は変わらない", () => {
    expect(isScopeSubset(base, base)).toBe(true);
    expect(isScopeSubset({ ...base, allowedMcpTools: [] }, base)).toBe(true);
  });
  it("子の MCP は、親の MCP に完全一致で含まれること", () => {
    const parent = { ...base, allowedMcpTools: ["mcp__a__b"] };
    expect(isScopeSubset({ ...base, allowedMcpTools: ["mcp__a__b"] }, parent)).toBe(true);
    expect(isScopeSubset({ ...base, allowedMcpTools: ["mcp__a__c"] }, parent)).toBe(false);
    expect(isScopeSubset({ ...base, allowedMcpTools: ["mcp__a__b"] }, base)).toBe(false);
  });
});
