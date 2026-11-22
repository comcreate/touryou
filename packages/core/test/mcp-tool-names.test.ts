import { describe, expect, it } from "vitest";
import {
  CHILD_MCP_TOOL_NAMES,
  INTEGRATOR_MCP_TOOL_NAMES,
  MCP_TOOL_NAMES_BY_ROLE,
  ROLE_OPERATIONS,
} from "../src/index.js";

describe("INTEGRATOR_MCP_TOOL_NAMES（#168）", () => {
  it("whoami と ROLE_OPERATIONS.integrator の操作（. を _ にした名前）に一致する", () => {
    expect([...INTEGRATOR_MCP_TOOL_NAMES].sort()).toEqual(
      ["whoami", ...ROLE_OPERATIONS.integrator.map((op) => op.replaceAll(".", "_"))].sort(),
    );
  });

  it("重複がなく、紐付けの道具 child_bind は含まない", () => {
    expect(new Set(INTEGRATOR_MCP_TOOL_NAMES).size).toBe(INTEGRATOR_MCP_TOOL_NAMES.length);
    expect(INTEGRATOR_MCP_TOOL_NAMES).not.toContain("child_bind");
  });

  it("統合の道具に、子だけの道具（report_*・scope_extend）は入らない", () => {
    for (const name of ["report_done", "report_progress", "scope_extend"]) {
      expect(INTEGRATOR_MCP_TOOL_NAMES).not.toContain(name);
    }
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
