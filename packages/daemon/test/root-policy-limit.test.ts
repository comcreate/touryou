/**
 * 拡張の対象を、上限に足せるか（`addableLimitRule`。状態画面の「上限にも足して承認」を出すかの判断）の試験。
 * 規則に表せない・長すぎる・足したあとの方針の検査を通らない対象は、規則を返さない（画面はボタンを出さない）。
 */

import { LIMITS } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { addableLimitRule } from "../src/root-policy.js";

const pass = (): undefined => undefined;

describe("addableLimitRule（上限に足せる対象だけ、規則を返す）", () => {
  it("コマンドは前方一致の Bash 規則、MCP ツールは名前そのものになる", () => {
    expect(addableLimitRule({ kind: "command", value: "git status" }, pass)).toBe(
      "Bash(git status:*)",
    );
    expect(addableLimitRule({ kind: "mcp", value: "mcp__srv__tool" }, pass)).toBe("mcp__srv__tool");
  });

  it("規則に表せない対象（解析できないコマンド・作業ツリーの外の書き込み先）は、規則を返さない", () => {
    expect(addableLimitRule({ kind: "command", value: "" }, pass)).toBeUndefined();
    expect(addableLimitRule({ kind: "write", value: "../outside" }, pass)).toBeUndefined();
    expect(addableLimitRule({ kind: "mcp", value: "not an mcp tool" }, pass)).toBeUndefined();
  });

  it("長すぎる規則は、返さない", () => {
    const long = `git ${"a".repeat(LIMITS.policyRule)}`;
    expect(addableLimitRule({ kind: "command", value: long }, pass)).toBeUndefined();
  });

  it("足したあとの方針の検査を通らない規則は、返さない", () => {
    expect(
      addableLimitRule({ kind: "command", value: "git status" }, () => "deny に当たる"),
    ).toBeUndefined();
  });
});
