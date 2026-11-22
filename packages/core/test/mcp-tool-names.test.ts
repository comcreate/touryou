import { describe, expect, it } from "vitest";
import {
  CHILD_MCP_TOOL_NAMES,
  INTEGRATOR_MCP_TOOL_NAMES,
  MCP_TOOL_NAMES_BY_ROLE,
  ROLE_OPERATIONS,
} from "../src/index.js";

describe("INTEGRATOR_MCP_TOOL_NAMES（#168）", () => {
  it("whoami と ROLE_OPERATIONS.integrator の操作（. を _ にした名前。child.inbox は child_inbox）に一致する", () => {
    expect([...INTEGRATOR_MCP_TOOL_NAMES].sort()).toEqual(
      [
        "whoami",
        ...ROLE_OPERATIONS.integrator.map((op) =>
          op === "child.inbox" ? "child_inbox" : op.replaceAll(".", "_"),
        ),
      ].sort(),
    );
  });

  it("重複がなく、紐付けの道具 child_bind は含まない", () => {
    expect(new Set(INTEGRATOR_MCP_TOOL_NAMES).size).toBe(INTEGRATOR_MCP_TOOL_NAMES.length);
    expect(INTEGRATOR_MCP_TOOL_NAMES).not.toContain("child_bind");
  });

  it("統合の道具に、サブ統括が親へ使う子の操作（report_*・scope_extend・child_inbox）が入る。根は daemon が拒否する（#168）", () => {
    for (const name of ["report_done", "report_progress", "scope_extend", "child_inbox"]) {
      expect(INTEGRATOR_MCP_TOOL_NAMES).toContain(name);
    }
    // 統合の inbox_fetch は統合の受信箱（inbox.fetch）。子の受信箱は child_inbox と別の名前にする
    expect(INTEGRATOR_MCP_TOOL_NAMES.filter((n) => n === "inbox_fetch")).toHaveLength(1);
  });

  it("人間専用の操作（node_hookToken・node_purge）は入らない", () => {
    expect(INTEGRATOR_MCP_TOOL_NAMES).not.toContain("node_hookToken");
    expect(INTEGRATOR_MCP_TOOL_NAMES).not.toContain("node_purge");
  });
});

describe("MCP_TOOL_NAMES_BY_ROLE（#168）", () => {
  it("統合と子の一覧は、それぞれの定数と同じ", () => {
    expect(MCP_TOOL_NAMES_BY_ROLE.integrator).toBe(INTEGRATOR_MCP_TOOL_NAMES);
    expect(MCP_TOOL_NAMES_BY_ROLE.child).toBe(CHILD_MCP_TOOL_NAMES);
  });

  it("human は mcp の道具を持たない", () => {
    expect(Object.keys(MCP_TOOL_NAMES_BY_ROLE).sort()).toEqual(["child", "integrator"]);
  });
});
