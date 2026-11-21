import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHILD_MCP_TOOL_NAMES, ownMcpToolOf, PLUGIN_NAME } from "@touryou/core";
import { describe, expect, it } from "vitest";

describe("plugin の名前", () => {
  it("PLUGIN_NAME は plugin.json の name と一致する", () => {
    const path = fileURLToPath(
      new URL("../../../plugin/.claude-plugin/plugin.json", import.meta.url),
    );
    expect((JSON.parse(readFileSync(path, "utf8")) as { name: string }).name).toBe(PLUGIN_NAME);
  });
  it("2 つの名前の形から道具の名前を取る", () => {
    expect(ownMcpToolOf("mcp__node__inbox_fetch")).toBe("inbox_fetch");
    expect(ownMcpToolOf(`mcp__plugin_${PLUGIN_NAME}_node__report_progress`)).toBe(
      "report_progress",
    );
    expect(ownMcpToolOf("mcp__plugin_x_node__inbox_fetch")).toBeUndefined();
  });
  it("子の道具の一覧は、紐付けの道具と ROLE_OPERATIONS.child", () => {
    expect([...CHILD_MCP_TOOL_NAMES].sort()).toEqual(
      [
        "child_bind",
        "whoami",
        "inbox_fetch",
        "report_progress",
        "report_decision",
        "decision_withdraw",
        "report_outOfScope",
        "report_done",
        "scope_extend",
      ].sort(),
    );
  });
});
