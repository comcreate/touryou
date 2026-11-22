import { evaluate } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { type DaemonConfig, parseConfig, rootPolicyOf } from "../src/config.js";

const base = {
  stateDir: "/var/touryou/state",
  repoRoot: "/work/repo",
  worktreeRoot: "/work/worktrees",
  rootCwd: "/work/repo",
  rootScope: {
    writableLocations: ["src", "docs"],
    forbiddenLocations: [".git"],
    allowedCommands: ["pnpm test", "git status"],
  },
};

const load = (over: Record<string, unknown>) => parseConfig(JSON.stringify({ ...base, ...over }));

const ok = (over: Record<string, unknown>): DaemonConfig => {
  const r = load(over);
  if (!r.ok) throw new Error(`読めない: ${r.error.cause}`);
  return r.value;
};

const bad = (over: Record<string, unknown>, cause: string): void => {
  const r = load(over);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.code).toBe("invalidConfig");
  expect(r.error.cause).toContain(cause);
  expect(r.error.nextActions.length).toBeGreaterThan(0);
};

describe("config の permissions・autoApprove（#194 PR2）", () => {
  it("旧の設定（permissions・autoApprove なし）は、そのまま読め、方針は rootScope から作る", () => {
    const c = ok({});
    expect(c.permissions).toBeUndefined();
    expect(c.autoApprove).toBeUndefined();
    expect(rootPolicyOf(c)).toEqual({
      allow: ["Bash(pnpm test:*)", "Bash(git status:*)", "Edit(src/**)", "Edit(docs/**)"],
      deny: ["Edit(.git/**)"],
      ask: [],
      autoApprove: [],
      allowedMcpTools: [],
    });
  });

  it("新しい設定を読み込み、rootScope と畳む（重複は 1 つ）", () => {
    const c = ok({
      permissions: {
        allow: ["Bash(grep -rn:*)", "Bash(pnpm test:*)", "mcp__playwright__browser_snapshot"],
        deny: ["Bash(git push:*)", "mcp__playwright__browser_navigate"],
        ask: ["Bash(git commit:*)"],
      },
      autoApprove: { allow: ["Bash(grep -rn:*)", "mcp__playwright__browser_snapshot"] },
    });
    const p = rootPolicyOf(c);
    expect(p.allow).toEqual([
      "Bash(pnpm test:*)",
      "Bash(git status:*)",
      "Edit(src/**)",
      "Edit(docs/**)",
      "Bash(grep -rn:*)",
      "mcp__playwright__browser_snapshot",
    ]);
    expect(p.deny).toEqual([
      "Edit(.git/**)",
      "Bash(git push:*)",
      "mcp__playwright__browser_navigate",
    ]);
    expect(p.ask).toEqual(["Bash(git commit:*)"]);
    expect(p.autoApprove).toEqual(["Bash(grep -rn:*)", "mcp__playwright__browser_snapshot"]);
    expect(p.allowedMcpTools).toEqual(["mcp__playwright__browser_snapshot"]);
  });

  it("一覧は省略できる（省略は空）。空のオブジェクトも読める", () => {
    expect(ok({ permissions: {} }).permissions).toEqual({ allow: [], deny: [], ask: [] });
    expect(ok({ autoApprove: {} }).autoApprove).toEqual({ allow: [] });
  });

  it("形が違えば拒否する（未知のキー・配列でない・文字列でない・重複・件数・長さ）", () => {
    bad({ permissions: [] }, "permissions");
    bad({ permissions: { allow: "Bash(ls -a:*)" } }, "permissions.allow");
    bad({ permissions: { allow: [1] } }, "permissions.allow");
    bad({ permissions: { extra: [] } }, "permissions");
    bad({ permissions: { deny: ["Bash(git push:*)", "Bash(git push:*)"] } }, "重複");
    bad({ permissions: { deny: Array.from({ length: 201 }, (_, i) => `Bash(a${i} b:*)`) } }, "200");
    bad({ permissions: { deny: [`Bash(${"a ".repeat(300)}:*)`] } }, "512");
    bad({ autoApprove: { deny: [] } }, "autoApprove");
    bad({ autoApprove: "x" }, "autoApprove");
  });

  it("解析できない規則は、理由つきで起動を拒否する（無視しない）", () => {
    bad({ permissions: { deny: ["Write(src/**)"] } }, "対応していない書き方");
    bad({ permissions: { deny: ["Bash(a *)"] } }, "対応していない書き方");
    bad({ permissions: { deny: ["mcp__playwright__*"] } }, "permissions.deny");
    bad({ permissions: { ask: ["Edit(../x/**)"] } }, "場所が不正");
    bad({ permissions: { ask: ["Edit(/abs/**)"] } }, "場所が不正");
    bad({ permissions: { deny: ["Bash(a; b:*)"] } }, "1 つの命令として読めない");
    bad({ permissions: { deny: [""] } }, "空の規則");
    bad({ permissions: { deny: [" Bash(ls -a:*)"] } }, "permissions.deny");
  });

  it("allow の Bash は、子の許可と同じ検査を通す（1 語・任意のコードが動く形・cd 始まりは不可）", () => {
    bad({ permissions: { allow: ["Bash(grep:*)"] } }, "1 語だけ");
    bad({ permissions: { allow: ["Bash(node -e:*)"] } }, "任意のコード");
    bad({ permissions: { allow: ["Bash(npm exec:*)"] } }, "任意のコード");
    bad({ permissions: { allow: ["Bash(find . -exec:*)"] } }, "任意のコード");
    bad({ permissions: { allow: ["Bash(cd src:*)"] } }, "cd");
    // deny・ask は、1 語でもよい（広く止める側）
    expect(
      ok({ permissions: { deny: ["Bash(curl:*)"], ask: ["Bash(git:*)"] } }).permissions?.deny,
    ).toEqual(["Bash(curl:*)"]);
  });

  describe("autoApprove の検査", () => {
    const allow = [
      "Bash(grep -rn:*)",
      "Bash(git ls-files:*)",
      "Bash(pnpm test:*)",
      "Edit(docs/**)",
      "mcp__a__read",
      "mcp__b",
    ];

    it("読み取り専用の表のコマンド・名前を書いた MCP ツールだけが書ける", () => {
      const c = ok({
        permissions: { allow },
        autoApprove: { allow: ["Bash(grep -rn:*)", "Bash(git ls-files)", "mcp__a__read"] },
      });
      expect(c.autoApprove?.allow).toHaveLength(3);
    });

    it("書き込み（Edit）は書けない", () => {
      bad({ permissions: { allow }, autoApprove: { allow: ["Edit(docs/**)"] } }, "書き込み");
    });

    it("MCP のサーバー全体は書けない（道具の名前を 1 つずつ）", () => {
      bad({ permissions: { allow }, autoApprove: { allow: ["mcp__b"] } }, "サーバー全体");
      // サーバー全体を allow に書いて、その中の道具を名前で自動承認するのは、よい
      expect(
        ok({ permissions: { allow }, autoApprove: { allow: ["mcp__b__snapshot"] } }).autoApprove
          ?.allow,
      ).toEqual(["mcp__b__snapshot"]);
    });

    it("読み取り専用の表にないコマンドは書けない（書き込み・実行・ネットワーク・リポジトリを変えるもの）", () => {
      bad(
        { permissions: { allow }, autoApprove: { allow: ["Bash(pnpm test:*)"] } },
        "読み取り専用",
      );
      const more = [...allow, "Bash(git add -A:*)", "Bash(curl -s:*)", "Bash(tail -n:*)"];
      for (const r of ["Bash(git add -A:*)", "Bash(curl -s:*)", "Bash(tail -n:*)"]) {
        bad({ permissions: { allow: more }, autoApprove: { allow: [r] } }, "読み取り専用");
      }
    });

    it("allow（上限）の内側にないものは書けない", () => {
      bad(
        { permissions: { allow: [] }, autoApprove: { allow: ["Bash(grep -rn:*)"] } },
        "内側にない",
      );
      bad({ autoApprove: { allow: ["mcp__a__read"] } }, "内側にない");
      // 上限より広い前方一致は不可（grep -rn の上限に、grep -r の自動承認は入らない）
      bad({ permissions: { allow }, autoApprove: { allow: ["Bash(grep -r:*)"] } }, "内側にない");
      // 上限が完全一致なら、前方一致の自動承認は上限を超える
      bad(
        {
          permissions: { allow: ["Bash(grep -rn)"] },
          autoApprove: { allow: ["Bash(grep -rn:*)"] },
        },
        "内側にない",
      );
      // rootScope.allowedCommands（旧の書き方）も上限に数える
      const c = ok({
        rootScope: { ...base.rootScope, allowedCommands: ["grep -rn"] },
        autoApprove: { allow: ["Bash(grep -rn:*)"] },
      });
      expect(rootPolicyOf(c).autoApprove).toEqual(["Bash(grep -rn:*)"]);
    });

    it("deny・ask に当たるものは書けない", () => {
      const deny = { allow, deny: ["Bash(grep -rn:*)"] };
      bad(
        { permissions: deny, autoApprove: { allow: ["Bash(grep -rn:*)"] } },
        "deny か permissions.ask",
      );
      bad(
        {
          permissions: { allow, deny: ["Bash(grep:*)"] },
          autoApprove: { allow: ["Bash(grep -rn:*)"] },
        },
        "deny か permissions.ask",
      );
      bad(
        { permissions: { allow, ask: ["mcp__a__read"] }, autoApprove: { allow: ["mcp__a__read"] } },
        "deny か permissions.ask",
      );
      // 自動承認より狭い deny は、自動承認を妨げない（deny が判定で勝つ）
      expect(
        ok({
          permissions: { allow, deny: ["Bash(grep -rn secret:*)"] },
          autoApprove: { allow: ["Bash(grep -rn:*)"] },
        }).autoApprove?.allow,
      ).toEqual(["Bash(grep -rn:*)"]);
    });

    it("autoApprove の Bash にも、子の許可と同じ検査を通す", () => {
      bad({ permissions: { allow }, autoApprove: { allow: ["Bash(grep:*)"] } }, "1 語だけ");
      bad(
        { permissions: { allow }, autoApprove: { allow: ["Bash(find -exec:*)"] } },
        "任意のコード",
      );
    });
  });

  describe("rootPolicyOf（方針への畳み込み）", () => {
    it("表せない rootScope の項目は、方針に入れない（狭くなる側）", () => {
      const c = ok({
        rootScope: {
          writableLocations: ["."],
          forbiddenLocations: ["secret/"],
          allowedCommands: ["git status", "a * b", "x; y"],
        },
      });
      const p = rootPolicyOf(c);
      expect(p.allow).toEqual(["Bash(git status:*)"]);
      expect(p.deny).toEqual(["Edit(secret/**)"]);
    });

    it("同じ規則が allow と deny にあれば、判定では deny が勝つ", () => {
      const c = ok({
        permissions: { allow: ["Bash(git push origin:*)"], deny: ["Bash(git push:*)"] },
      });
      const p = rootPolicyOf(c);
      expect(evaluate(p, { kind: "command", command: "git push origin main" })).toBe("deny");
      expect(evaluate(p, { kind: "write", path: ".git/config" })).toBe("deny");
      expect(evaluate(p, { kind: "write", path: "src/a.ts" })).toBe("allow");
      expect(evaluate(p, { kind: "command", command: "git status -s" })).toBe("allow");
      expect(evaluate(p, { kind: "command", command: "git log" })).toBe("none");
    });
  });

  it("未知のキーの文に、新しい版の項目かもしれないこと・docs を示す", () => {
    const r = load({ roots: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.cause).toContain("roots");
      expect(r.error.cause).toContain("daemon の版を上げる");
      expect(r.error.cause).toContain("docs/config.md");
    }
  });
});
