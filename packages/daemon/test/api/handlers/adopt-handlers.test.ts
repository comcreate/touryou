import {
  type EventBody,
  type Failure,
  failure,
  type NodeEvent,
  ok,
  type Result,
  type Scope,
  stateOf,
} from "@touryou/core";
import { describe, expect, it } from "vitest";
import { type AdoptPorts, createAdoptHandlers } from "../../../src/api/handlers/adopt-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-11-20T00:00:00Z";
const WT = "/wt";
const ADOPTED_WT = "/home/me/wt-existing";
let n = 0;

const PARENT_SCOPE: Scope = {
  writableLocations: ["src", "docs"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test", "git status"],
};
const CHILD_SCOPE: Scope = {
  writableLocations: ["src/ui"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test"],
};
const params = (over: Record<string, unknown> = {}) => ({
  parentId: "m1",
  role: "implement",
  worktree: ADOPTED_WT,
  branch: "feature/existing",
  objective: "UI を直す",
  acceptanceCriteria: ["テストが通る"],
  scope: CHILD_SCOPE,
  ...over,
});

/** root ─ m1(統合・範囲 PARENT_SCOPE・running) ─ a(実装・running)、root ─ m2(統合)。呼び出し元は既定で m1 */
const rig = () => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  ev("root", { type: "start" });
  add({
    type: "node.created",
    payload: {
      nodeId: "m1",
      role: "integrator",
      parentId: "root",
      dependsOn: [],
      objective: "統合",
      acceptanceCriteria: ["完了"],
      scope: PARENT_SCOPE,
    },
  });
  ev("m1", { type: "start" });
  add({
    type: "node.created",
    payload: {
      nodeId: "a",
      role: "implement",
      parentId: "m1",
      dependsOn: [],
      objective: "a",
      acceptanceCriteria: ["a"],
      scope: PARENT_SCOPE,
    },
  });
  ev("a", { type: "start" });
  add({
    type: "node.created",
    payload: { nodeId: "m2", role: "integrator", parentId: "root", dependsOn: [] },
  });
  ev("m2", { type: "start" });

  const calls = {
    inspected: [] as { parentId: string; worktree: string; branch: string }[],
    marked: [] as [string, string][],
    unmarked: [] as string[],
    issued: [] as [string, string][],
    discarded: [] as [string, string][],
    failures: [] as string[],
  };
  const flags = {
    inspectError: undefined as Failure | undefined,
    inspectThrows: false,
    dirty: false,
    markFails: false,
    issueThrows: false,
    cwdOfParent: `${WT}/m1` as string | undefined,
  };
  const ports: AdoptPorts = {
    cwdOf: async (id) => (id === "m1" ? flags.cwdOfParent : id === "m2" ? `${WT}/m2` : undefined),
    inspectAdoption: async (req) => {
      calls.inspected.push(req);
      if (flags.inspectThrows) throw new Error("git が落ちた");
      if (flags.inspectError !== undefined) return { ok: false, error: flags.inspectError };
      return ok({ worktreePath: req.worktree, branch: req.branch, dirty: flags.dirty });
    },
    markAdopted: async (id, path) => {
      calls.marked.push([id, path]);
      if (flags.markFails) return { ok: false, error: failure("x", "内部の詳細M", "y") };
      return ok(undefined);
    },
    unmarkAdopted: async (path) => {
      calls.unmarked.push(path);
    },
    issueBindCode: (id, path) => {
      if (flags.issueThrows) throw new Error("書けない");
      calls.issued.push([id, path]);
    },
    discardBindCode: (id, path) => {
      calls.discarded.push([id, path]);
    },
  };
  const h = createAdoptHandlers({
    log,
    clock,
    ports,
    rootScope: PARENT_SCOPE,
    onFailure: (_id, cause) => calls.failures.push(cause),
  }).handlers;
  const call = async (
    p: Record<string, unknown>,
    caller = "m1",
    requestId = `q-${++n}`,
    // biome-ignore lint/suspicious/noExplicitAny: 試験の戻り値の形を緩く受ける
  ): Promise<{ ok: boolean; value?: any; error?: Failure }> => {
    const req = {
      requestId,
      operation: "node.adopt",
      role: "integrator",
      caller: { nodeId: caller },
      params: p,
    } as unknown as HandlerRequest<"node.adopt">;
    // biome-ignore lint/suspicious/noExplicitAny: 試験の戻り値の形を緩く受ける
    return (await h["node.adopt"](req)) as Result<any, Failure> as {
      ok: boolean;
      // biome-ignore lint/suspicious/noExplicitAny: 試験の戻り値の形を緩く受ける
      value?: any;
      error?: Failure;
    };
  };
  return { log, call, calls, flags, s: () => log.state() };
};

describe("node.adopt（既存の作業ツリーの採用。#163）", () => {
  it("検査・印・コードのあと、node.created・start・node.adopted を 1 回で記録する", async () => {
    const r = rig();
    const before = r.s().lastSeq;
    const res = await r.call(params());
    expect(res.ok).toBe(true);
    const id = res.value.nodeId as string;
    expect(res.value).toMatchObject({
      nodeId: id,
      worktree: ADOPTED_WT,
      branch: "feature/existing",
      dirty: false,
      duplicate: false,
    });
    expect(res.value.instruction).toContain("child_bind");
    expect(res.value.instruction).toContain("Reconnect");
    expect(stateOf(r.s(), id)).toBe("running");
    const rec = r.s().nodes.find((x) => x.id === id);
    expect(rec).toMatchObject({
      parentId: "m1",
      role: "implement",
      objective: "UI を直す",
      scope: CHILD_SCOPE,
      adopted: { worktree: ADOPTED_WT, branch: "feature/existing", by: { nodeId: "m1" } },
    });
    // 3 つのイベントが、連続した seq で追記される
    expect(r.s().lastSeq).toBe(before + 3);
    expect(r.calls.inspected).toEqual([
      { parentId: "m1", worktree: ADOPTED_WT, branch: "feature/existing" },
    ]);
    expect(r.calls.marked).toEqual([[id, ADOPTED_WT]]);
    expect(r.calls.issued).toEqual([[id, ADOPTED_WT]]);
    expect(r.calls.unmarked).toEqual([]);
  });

  it("未コミットの変更がある作業ツリーも採用し、dirty を返して指示に注意を足す", async () => {
    const r = rig();
    r.flags.dirty = true;
    const res = await r.call(params());
    expect(res.ok).toBe(true);
    expect(res.value.dirty).toBe(true);
    expect(res.value.instruction).toContain("未コミット");
  });

  it("検査の拒否は、原因と次の操作をそのまま返し、何も書かない", async () => {
    const r = rig();
    r.flags.inspectError = failure("adoptDetachedHead", "ブランチが付いていない", "ブランチを切る");
    const res = await r.call(params());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("adoptDetachedHead");
    expect(res.error?.nextActions).toEqual(["ブランチを切る"]);
    expect(r.s().nodes.map((x) => x.id)).toEqual(["root", "m1", "a", "m2"]);
    expect(r.calls.marked).toEqual([]);
    expect(r.calls.issued).toEqual([]);
  });

  it("検査が例外なら、内部の詳細を応答に出さず、何も書かない", async () => {
    const r = rig();
    r.flags.inspectThrows = true;
    const res = await r.call(params());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("adoptInspectFailed");
    expect(JSON.stringify(res.error)).not.toContain("git が落ちた");
    expect(r.calls.failures.join("")).toContain("git が落ちた");
    expect(r.calls.marked).toEqual([]);
  });

  it("親の範囲に収まらない子の範囲は、作業ツリーに触れる前に scopeNotSubset で失敗する", async () => {
    const r = rig();
    const res = await r.call(params({ scope: { ...CHILD_SCOPE, allowedCommands: ["rm -rf"] } }));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("scopeNotSubset");
    expect(r.s().nodes.map((x) => x.id)).toEqual(["root", "m1", "a", "m2"]);
    expect(r.calls.inspected).toEqual([]);
    expect(r.calls.marked).toEqual([]);
    expect(r.calls.issued).toEqual([]);
  });

  it("親の作業ツリーを取得できなければ、何もせずに失敗する（安全側）", async () => {
    const r = rig();
    r.flags.cwdOfParent = undefined;
    const res = await r.call(params());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("worktreeUnknown");
    expect(r.calls.inspected).toEqual([]);
  });

  it("親の確認: 存在しない親・部分木の外・統合でない親・統合ノードの採用を断る", async () => {
    const r = rig();
    expect((await r.call(params({ parentId: "ghost" }))).error?.code).toBe("notFound");
    expect((await r.call(params({ parentId: "m2" }))).error?.code).toBe("forbidden");
    expect((await r.call(params({ parentId: "a" }))).error?.code).toBe("notActive");
    expect((await r.call(params({ role: "integrator" }))).error?.code).toBe("adoptRoleInvalid");
    expect(r.calls.inspected).toEqual([]);
    expect(r.s().nodes).toHaveLength(4);
  });

  it("範囲が作業ツリーの規則を満たさなければ、印を書かずに scopeInvalid で失敗する", async () => {
    const r = rig();
    const res = await r.call(params({ scope: { ...CHILD_SCOPE, writableLocations: ["/etc"] } }));
    expect(res.ok).toBe(false);
    expect(["scopeNotSubset", "scopeInvalid"]).toContain(res.error?.code);
    expect(r.calls.marked).toEqual([]);
  });

  it("印を書けなければ、コードも記録もせずに失敗する", async () => {
    const r = rig();
    r.flags.markFails = true;
    const res = await r.call(params());
    expect(res.ok).toBe(false);
    expect(r.calls.issued).toEqual([]);
    expect(r.s().nodes).toHaveLength(4);
  });

  it("コードを書けなければ、書いた印だけを片付けて失敗する（作業ツリーとブランチは消さない）", async () => {
    const r = rig();
    r.flags.issueThrows = true;
    const res = await r.call(params());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("bindCodeFileFailed");
    expect(r.calls.unmarked).toEqual([ADOPTED_WT]);
    expect(r.s().nodes).toHaveLength(4);
  });

  it("同じ requestId の再送は、印・コードを重複させず、同じ nodeId を duplicate で返す", async () => {
    const r = rig();
    const first = await r.call(params(), "m1", "ad-1");
    const seq = r.s().lastSeq;
    const again = await r.call(params(), "m1", "ad-1");
    expect(again.ok).toBe(true);
    expect(again.value.nodeId).toBe(first.value.nodeId);
    expect(again.value.duplicate).toBe(true);
    expect(r.s().lastSeq).toBe(seq);
    expect(r.calls.marked).toHaveLength(1);
    expect(r.calls.issued).toHaveLength(1);
    const conflict = await r.call(params({ branch: "feature/other" }), "m1", "ad-1");
    expect(conflict.error?.code).toBe("requestIdConflict");
  });

  it("parentSessionId があれば、node.parentSessionSet を記録する", async () => {
    const r = rig();
    const res = await r.call(params({ parentSessionId: "sess-parent" }));
    expect(res.ok).toBe(true);
    const rec = r.s().nodes.find((x) => x.id === res.value.nodeId);
    expect(rec?.parentSession?.sessionId).toBe("sess-parent");
  });
});
