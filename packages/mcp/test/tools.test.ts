import { CONTRACT_ROLES, type DaemonOperation, ROLE_OPERATIONS } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { MCP_ROLES, type McpRole, operationForTool, toolName, toolsFor } from "../src/index.js";

const names = (role: McpRole) => toolsFor(role).map((t) => t.name);

// 公開一覧の固定（NFR_004）。ツールを増減したら、このテストを意図して更新する。
const EXPECTED: Record<McpRole, readonly string[]> = {
  integrator: [
    "node_spawn",
    "node_adopt",
    "node_send",
    "node_stop",
    "node_confirmStopped",
    "node_hookUnbind",
    "node_bindCode",
    "inbox_fetch",
    "tree_list",
    "decision_present",
    "node_split",
    "scope_decide",
    "node_review",
    "node_integrate",
    "node_reclaimPreview",
    "node_reclaim",
    "node_capabilities",
    "decision_get",
    "report_get",
    "parent_request",
    "parent_report",
    // サブ統括が自分の親へ使う子の操作（#168）。受信箱は、inbox_fetch が統合の受信箱なので child_inbox
    "report_progress",
    "report_decision",
    "decision_withdraw",
    "report_outOfScope",
    "report_done",
    "scope_extend",
    "child_inbox",
  ],
  child: [
    "report_progress",
    "report_decision",
    "decision_withdraw",
    "report_outOfScope",
    "report_done",
    "scope_extend",
    "inbox_fetch",
  ],
};

describe("ロール別のツール公開（NFR_004）", () => {
  it.each(MCP_ROLES)("%s の公開一覧が固定されている（CLI）", (role) => {
    expect(names(role)).toEqual(EXPECTED[role]);
  });

  it("node_bind はどのロールにも公開されない（紐付けは POST /v1/bind）", () => {
    for (const role of MCP_ROLES) {
      expect(names(role)).not.toContain("node_bind");
      expect(operationForTool(role, "node_bind").ok).toBe(false);
    }
  });

  it.each(["human", "constructor", "__proto__", "toString", "", "admin"])(
    "MCP のロールでない %j には何も公開しない",
    (role) => {
      expect(toolsFor(role as McpRole)).toEqual([]);
      const r = operationForTool(role as McpRole, "node_spawn");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("role_not_exposed");
    },
  );

  it("MCP で公開するのは統合と子だけで、人間用の操作は含まない", () => {
    expect([...MCP_ROLES]).toEqual(["integrator", "child"]);
    // 人間専用の操作（最終削除など）は、どのロールにも公開しない。人間と統合で共有する操作（scope.decide）は統合に公開してよい。
    const shared = new Set<DaemonOperation>(MCP_ROLES.flatMap((r) => ROLE_OPERATIONS[r]));
    const humanOnly = new Set<DaemonOperation>(ROLE_OPERATIONS.human.filter((o) => !shared.has(o)));
    expect(humanOnly.has("node.purge")).toBe(true);
    for (const role of MCP_ROLES) {
      for (const tool of toolsFor(role)) expect(humanOnly.has(tool.operation)).toBe(false);
    }
  });

  it("child には子の生成・停止・人間宛ての連絡・最終削除が公開されない", () => {
    const forbidden = [
      "node_spawn",
      "node_stop",
      "node_send",
      "node_split",
      "decision_present",
      "node_reclaim",
      "node_purge",
    ];
    for (const n of forbidden) expect(names("child")).not.toContain(n);
  });

  it("最終削除（node.purge）はどのロールにも公開されない（DC_003）", () => {
    for (const role of MCP_ROLES) {
      expect(toolsFor(role).some((t) => t.operation === "node.purge")).toBe(false);
    }
  });

  it("統合済みの証拠の記録（node.mergeEvidence。#239）は、どの MCP のロールにも公開されない（AI は証拠を作れない）", () => {
    for (const role of MCP_ROLES) {
      expect(toolsFor(role).some((t) => t.operation === "node.mergeEvidence")).toBe(false);
      expect(names(role)).not.toContain("node_mergeEvidence");
      expect(operationForTool(role, "node_mergeEvidence").ok).toBe(false);
      expect((ROLE_OPERATIONS[role] as readonly string[]).includes("node.mergeEvidence")).toBe(
        false,
      );
    }
  });

  it("情報源は core の ROLE_OPERATIONS（操作の並びが一致する）", () => {
    for (const role of MCP_ROLES) {
      expect(toolsFor(role).map((t) => t.operation)).toEqual([...ROLE_OPERATIONS[role]]);
    }
    expect(CONTRACT_ROLES).toContain("human");
  });

  it("ツール名は（ロールの中で）重複せず、説明がある。ロールをまたいで同じ名前は、子の操作（サブ統括も使う。#168）と、別の操作が同名の inbox_fetch", () => {
    for (const r of MCP_ROLES) {
      const tools = toolsFor(r);
      expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    }
    const all = MCP_ROLES.flatMap((r) => toolsFor(r));
    const names = all.map((t) => t.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i).sort()).toEqual(
      [
        "decision_withdraw",
        "inbox_fetch",
        "report_decision",
        "report_done",
        "report_outOfScope",
        "report_progress",
        "scope_extend",
      ].sort(),
    );
    for (const t of all) expect(t.description.length).toBeGreaterThan(0);
  });
});

describe("operationForTool", () => {
  it("公開されたツール名を操作へ解決する", () => {
    expect(operationForTool("integrator", "node_spawn")).toEqual({
      ok: true,
      value: "node.spawn",
    });
  });

  it("そのロールに公開されていないツールは、原因と次の操作つきの失敗にする（NFR_010）", () => {
    const r = operationForTool("child", "node_spawn");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("tool_not_exposed");
      expect(r.error.cause).toContain("node_spawn");
      expect(r.error.nextActions.length).toBeGreaterThan(0);
    }
  });

  it("存在しないツール名も失敗にする", () => {
    const r = operationForTool("integrator", "node_purge");
    expect(r.ok).toBe(false);
  });

  it("近い名前があれば、もしかして候補を次の操作に含める", () => {
    const r = operationForTool("integrator", "node_spwan");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.nextActions.join(" ")).toContain("node_spawn");
  });

  it("説明が、ブリーフと差し戻しの引数を示す", () => {
    const d = (n: string) => toolsFor("integrator").find((t) => t.name === n)?.description ?? "";
    for (const key of [
      "parentId",
      "role",
      "objective",
      "acceptanceCriteria",
      "scope",
      "dependsOn",
    ]) {
      expect(d("node_spawn"), key).toContain(key);
    }
    expect(d("node_spawn")).toContain("ブランチは指定しない");
    expect(d("node_split")).toContain("keep");
    expect(d("node_review")).toContain("feedback");
    expect(d("decision_present")).toContain("pauseNodeIds");
    expect(d("node_send")).toContain("queued");
    expect(d("node_send")).toContain("duplicate");
    expect(d("node_spawn")).toContain("waitingFor");
    expect(d("node_reclaimPreview")).toContain("blockers");
    expect(d("scope_decide")).toContain("子孫");
    expect(d("node_stop")).toContain("graceMs");
    expect(toolsFor("child").find((t) => t.name === "scope_extend")?.description).toContain("kind");
  });

  it("toolName は操作名の . を _ にする", () => {
    expect(toolName("node.review")).toBe("node_review");
  });

  it("ID を引数に取る操作の説明は、自分の ID が起動の指示の先頭にあることと、短縮しないことを書く", () => {
    const d = (n: string) => toolsFor("integrator").find((t) => t.name === n)?.description ?? "";
    for (const name of ["node_spawn", "node_split", "decision_present"]) {
      expect(d(name), name).toContain("起動の指示");
      expect(d(name), name).toContain("tree_list");
      expect(d(name), name).toContain("短縮しない");
    }
    expect(d("tree_list")).toContain("self");
  });

  it("whoami の説明文の先頭 2 文は DESCRIPTION_HEAD_MAX 字までで、流れの道具の名前と「短縮しない」が入る（デスクトップは先頭の約 80〜100 字で切る）", async () => {
    const { whoamiDescription, DESCRIPTION_HEAD_MAX } = await import("../src/tools.js");
    const head = (t: string) => t.split("。").slice(0, 2).join("。");
    const flows = {
      integrator: ["whoami", "tree_list", "node_spawn", "inbox_fetch", "短縮しない"],
      child: ["whoami", "report_progress", "report_done", "scope_extend"],
    } as const;
    for (const role of ["integrator", "child"] as const) {
      const h = head(whoamiDescription(role));
      expect([...h].length, `${role}: ${h}`).toBeLessThanOrEqual(DESCRIPTION_HEAD_MAX);
      for (const w of flows[role]) expect(h, role).toContain(w);
    }
  });

  it("どの道具も、説明文の 1 文目は DESCRIPTION_HEAD_MAX 字まで（切れても何をする道具かが残る）", async () => {
    const { DESCRIPTION_HEAD_MAX } = await import("../src/tools.js");
    for (const role of ["integrator", "child"] as const) {
      for (const t of toolsFor(role)) {
        const first = t.description.split("。")[0] ?? "";
        expect([...first].length, `${t.name}: ${first}`).toBeLessThanOrEqual(DESCRIPTION_HEAD_MAX);
      }
    }
  });

  it("whoami の説明文の先頭に、ロールの流れの要点がある（拡張機能では skill が読まれないため）", async () => {
    const { whoamiDescription, ROLE_GUIDE } = await import("../src/tools.js");
    for (const role of ["integrator", "child"] as const) {
      expect(whoamiDescription(role).startsWith(ROLE_GUIDE[role])).toBe(true);
      const names = toolsFor(role).map((t) => t.name);
      // NFR_012: 絶対パス・個人の値（ホームのパス・アカウント名の形）を入れない
      expect(ROLE_GUIDE[role]).not.toMatch(/(^|[\s（(「'"=])\/[A-Za-z0-9]/);
      expect(ROLE_GUIDE[role]).not.toMatch(/~\/|Users|home\/|@/);
      const { roleInstructions } = await import("../src/tools.js");
      for (const m of `${ROLE_GUIDE[role]}${roleInstructions(role)}`
        .replaceAll("daemon_unreachable", "")
        .matchAll(/[a-z]+_[A-Za-z]+/g)) {
        expect(names, `${role}: ${m[0]}`).toContain(m[0]);
      }
    }
  });
});
