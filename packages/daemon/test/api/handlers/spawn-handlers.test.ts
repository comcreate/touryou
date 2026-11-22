import {
  type EventBody,
  type Failure,
  failure,
  type NodeEvent,
  type NodeRuntime,
  ok,
  type Result,
  type Scope,
  stateOf,
} from "@touryou/core";
import { describe, expect, it } from "vitest";
import { derivedRequestId, deriveId } from "../../../src/api/handlers/context.js";
import { createSpawnHandlers, type SpawnPorts } from "../../../src/api/handlers/spawn-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import type { RuntimeAdapter, StartRequest, StartValue } from "../../../src/sdk/runtime.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
const WT = "/wt";
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
const brief = (over: Record<string, unknown> = {}) => ({
  role: "implement",
  objective: "UI を直す",
  acceptanceCriteria: ["テストが通る"],
  scope: CHILD_SCOPE,
  ...over,
});

/** root ─ m1(統合・範囲 PARENT_SCOPE・running) ─ a(running)、root ─ m2(統合)。呼び出し元は既定で m1 */
const ROOT_SCOPE: Scope = {
  writableLocations: ["src", "docs"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test"],
};
const rig = (
  opts: { rootScope?: Scope | null; runtime?: NodeRuntime; maxTreeDepth?: number } = {},
) => {
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
    provisioned: [] as string[],
    removed: [] as string[],
    issued: [] as [string, string][],
    revoked: [] as string[],
    started: [] as StartRequest[],
    stopped: [] as string[],
    sent: [] as [string, string][],
    adapterStops: [] as string[],
    failures: [] as string[],
  };
  const flags = {
    startFails: false,
    startThrows: false,
    adapterStop: "ok" as "ok" | "throws" | "incomplete",
    stopFails: false,
    issueThrows: false,
    removeFails: false,
    revokeThrows: false,
    provisionFails: false,
    worktreePath: undefined as string | undefined,
    cwdOfParent: `${WT}/m1` as string | undefined,
  };
  const adapter = {
    kind: "cli" as const,
    capabilities: () => ({
      send: "ok",
      stopGraceful: true,
      stopImmediate: true,
      hooks: "ok",
      sessionId: true,
    }),
    async start(req: StartRequest): Promise<Result<StartValue, Failure>> {
      calls.started.push(req);
      if (flags.startThrows) throw new Error("起動が例外");
      if (flags.startFails)
        return { ok: false, error: failure("startFailed", "内部の詳細X", "内部の次の操作") };
      return ok({ sessionId: "sess", cwd: req.worktreePath, removedEnv: [] });
    },
    async send(id: string, text: string) {
      calls.sent.push([id, text]);
      return ok({ status: "queued" as const });
    },
    async stop(id: string) {
      calls.adapterStops.push(id);
      if (flags.adapterStop === "throws") throw new Error("止められない");
      return ok({
        state:
          flags.adapterStop === "incomplete" ? ("stopIncomplete" as const) : ("stopped" as const),
        outcome: "aborted" as const,
        blockers: [],
      });
    },
    updateScope: () => ok(undefined),
  } as unknown as RuntimeAdapter;
  const ports: SpawnPorts = {
    cwdOf: async (id) => (id === "m1" ? flags.cwdOfParent : id === "m2" ? `${WT}/m2` : undefined),
    provisionWorktree: async ({ nodeId }) => {
      calls.provisioned.push(nodeId);
      if (flags.provisionFails)
        return { ok: false, error: failure("provisionFailed", "作れない", "確認する") };
      return ok({ worktreePath: flags.worktreePath ?? `${WT}/${nodeId}` });
    },
    removeWorktree: async (id) => {
      calls.removed.push(id);
      if (flags.removeFails) throw new Error("rm 失敗");
      return ok(undefined);
    },
    worktreeRoot: WT,
  };
  const credentials = {
    issueNodeToken: (id: string, role: string) => {
      if (flags.issueThrows) throw new Error("保存できない");
      calls.issued.push([id, role]);
      return `tok-${id}`;
    },
    revokeNode: (id: string) => {
      calls.revoked.push(id);
      if (flags.revokeThrows) throw new Error("失効できない");
    },
  };
  const h = createSpawnHandlers({
    log,
    clock,
    adapterFor: () => adapter,
    ...(opts.runtime === undefined ? {} : { runtime: opts.runtime }),
    ports,
    credentials,
    ...(opts.rootScope === null ? {} : { rootScope: opts.rootScope ?? ROOT_SCOPE }),
    ...(opts.maxTreeDepth === undefined ? {} : { maxTreeDepth: opts.maxTreeDepth }),
    stop: async (req) => {
      calls.stopped.push(req.params.nodeId);
      if (flags.stopFails) return { ok: false, error: failure("stopFailed", "x", "y") };
      return ok({ state: "stopping" as const });
    },
    onFailure: (_id, cause) => calls.failures.push(cause),
  });
  const call = async (
    op: keyof typeof h,
    params: Record<string, unknown>,
    caller = "m1",
    requestId = `q-${++n}`,
  ) => {
    const req = {
      requestId,
      operation: op,
      role: "integrator",
      caller: { nodeId: caller },
      params,
    } as unknown as HandlerRequest<never>;
    // biome-ignore lint/suspicious/noExplicitAny: 操作ごとの型は呼び出し側で保証
    return (await (h[op] as any)(req)) as { ok: boolean; value?: any; error?: Failure };
  };
  return { log, call, calls, flags, ev, s: () => log.state() };
};

describe("node.spawn（子の生成と起動）", () => {
  it("作業ツリーを作り、範囲を検査し、ブリーフつきで記録して、トークンを発行して起動する", async () => {
    const r = rig();
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(res.ok).toBe(true);
    const id = res.value.nodeId as string;
    expect(res.value).toEqual({ nodeId: id, status: "running" });
    expect(stateOf(r.s(), id)).toBe("running");
    const rec = r.s().nodes.find((x) => x.id === id);
    expect(rec).toMatchObject({
      parentId: "m1",
      role: "implement",
      objective: "UI を直す",
      acceptanceCriteria: ["テストが通る"],
    });
    expect(r.calls.provisioned).toEqual([id]);
    expect(r.calls.issued).toEqual([[id, "child"]]);
    expect(r.calls.started).toHaveLength(1);
    expect(r.calls.started[0]).toMatchObject({
      nodeId: id,
      worktreePath: `${WT}/${id}`,
      scope: CHILD_SCOPE,
    });
    // 自分のノード ID・role・親が、指示の先頭にある（作業ツリーの名前から推測して、取り違えないように）
    const text0 = r.calls.started[0]?.instruction ?? "";
    expect(text0.split("\n")[0]).toBe(`あなたのノード ID: ${id}（role: implement、親: m1）`);
    expect(r.calls.started[0]?.instruction).toContain("UI を直す");
    expect(r.calls.started[0]?.instruction).toContain("テストが通る");
    expect(r.calls.started[0]?.mcp).toEqual({ token: `tok-${id}` });
  });

  it("設定の実行環境（runtime）を、子の node.created に記録する。渡さなければ記録しない（#159）", async () => {
    for (const runtime of ["cli", "desktop"] as const) {
      const r = rig({ runtime });
      const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
      expect(res.ok).toBe(true);
      expect(r.s().nodes.find((x) => x.id === res.value.nodeId)?.runtime).toBe(runtime);
    }
    const r = rig();
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(r.s().nodes.find((x) => x.id === res.value.nodeId)).not.toHaveProperty("runtime");
  });

  it("親の範囲に収まらない子の範囲は、何も記録せず、作った作業ツリーを片付けて失敗する", async () => {
    const r = rig();
    const res = await r.call("node.spawn", {
      parentId: "m1",
      ...brief({ scope: { ...CHILD_SCOPE, allowedCommands: ["rm -rf"] } }),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("scopeNotSubset");
    // 親がブリーフを持つ（根の範囲が上限でない）ときは、従来の文のまま。設定ファイルの話を出さない
    expect(res.error?.cause).toBe(
      "子の範囲が、親の範囲に収まらない（コマンド・書き込み可能な場所・禁止の場所）",
    );
    expect(JSON.stringify(res.error)).not.toContain("config.json");
    expect(r.s().nodes.map((x) => x.id)).toEqual(["root", "m1", "a", "m2"]);
    expect(r.calls.provisioned).toEqual([]); // 範囲の検査は、作業ツリーを作る前
    expect(r.calls.issued).toEqual([]);
    expect(r.calls.started).toEqual([]);
  });

  it("ポートが返す作業ツリーのパスが、置き場の外・相対なら、消さずに失敗する", async () => {
    for (const bad of ["/elsewhere/x", "relative/x", WT]) {
      const r = rig();
      r.flags.worktreePath = bad;
      const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
      expect(res.error?.code).toBe("provisionFailed");
      expect(r.calls.removed).toEqual([]);
      expect(r.s().nodes).toHaveLength(4);
    }
  });

  it("親の作業ツリーを取得できなければ、何もせずに失敗する（安全側）", async () => {
    const r = rig();
    r.flags.cwdOfParent = undefined;
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(res.ok).toBe(false);
    expect(r.calls.provisioned).toEqual([]);
  });

  it("依存が未完了なら、作業ツリーを作って pending を記録して返す（起動しない）", async () => {
    const r = rig();
    const res = await r.call("node.spawn", { parentId: "m1", ...brief({ dependsOn: ["a"] }) });
    expect(res.ok).toBe(true);
    expect(stateOf(r.s(), res.value.nodeId)).toBe("pending");
    expect(res.value).toMatchObject({ status: "pending", waitingFor: ["a"] });
    expect(res.value).toMatchObject({ status: "pending", waitingFor: ["a"] });
    expect(r.calls.provisioned).toHaveLength(1);
    expect(r.calls.issued).toEqual([]);
    expect(r.calls.started).toEqual([]);
  });

  it("同じ requestId の再試行は、作業ツリー・トークン・起動を重複させず、同じ nodeId を返す", async () => {
    const r = rig();
    const first = await r.call("node.spawn", { parentId: "m1", ...brief() }, "m1", "sp-1");
    const seq = r.s().lastSeq;
    const again = await r.call("node.spawn", { parentId: "m1", ...brief() }, "m1", "sp-1");
    expect(again).toEqual(first);
    expect(r.s().lastSeq).toBe(seq);
    expect(r.calls.provisioned).toHaveLength(1);
    expect(r.calls.issued).toHaveLength(1);
    expect(r.calls.started).toHaveLength(1);
    const conflict = await r.call(
      "node.spawn",
      { parentId: "m1", ...brief({ objective: "別" }) },
      "m1",
      "sp-1",
    );
    expect(conflict.error?.code).toBe("requestIdConflict");
  });

  it("起動の失敗: トークンを失効し、作業ツリーを消し、ノードを停止済みにして、失敗を返す（後始末の通し）。後始末の失敗は例外にせず記録する", async () => {
    const r = rig();
    r.flags.startFails = true;
    r.flags.removeFails = true;
    r.flags.revokeThrows = true;
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("startFailed");
    expect(JSON.stringify(res.error)).not.toContain("内部の詳細X");
    expect(r.calls.failures.join("")).toContain("内部の詳細X");
    const id = r.calls.provisioned[0] as string;
    expect(r.calls.revoked).toEqual([id]);
    expect(r.calls.removed).toEqual([id]);
    expect(stateOf(r.s(), id)).toBe("stopped");
    expect(r.calls.failures.length).toBeGreaterThanOrEqual(2);
  });

  it("起動が例外なら、停止を確認できたときだけ、作業ツリーを消してアーカイブする。確認できなければ、停止のまま作業ツリーを残す", async () => {
    const ok1 = rig();
    ok1.flags.startThrows = true;
    const a = await ok1.call("node.spawn", { parentId: "m1", ...brief() });
    expect(a.ok).toBe(false);
    const id1 = ok1.calls.provisioned[0] as string;
    expect(ok1.calls.adapterStops).toEqual([id1]);
    expect(stateOf(ok1.s(), id1)).toBe("archived");
    expect(ok1.calls.removed).toEqual([id1]);
    for (const mode of ["throws", "incomplete"] as const) {
      const r = rig();
      r.flags.startThrows = true;
      r.flags.adapterStop = mode;
      const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
      expect(res.ok).toBe(false);
      const id = r.calls.provisioned[0] as string;
      expect(stateOf(r.s(), id)).toBe("stopped");
      expect(r.calls.removed).toEqual([]); // 生きているかもしれない作業ツリーは消さない
      expect(r.calls.revoked).toEqual([id]); // トークンは失効する
      expect(res.error?.cause).toContain("残した");
    }
  });

  it("トークンを発行できなければ、起動せずに後始末して失敗する", async () => {
    const r = rig();
    r.flags.issueThrows = true;
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(res.ok).toBe(false);
    expect(r.calls.started).toEqual([]);
    const id = r.calls.provisioned[0] as string;
    expect(r.calls.removed).toEqual([id]);
    expect(r.calls.revoked).toEqual([id]);
    expect(stateOf(r.s(), id)).toBe("archived"); // 作業ツリーを消せたので、破棄の判断を記録してアーカイブまで進める
    expect(r.s().nodes.find((x) => x.id === id)?.discarded).toBeDefined();
  });

  it("ブリーフのない親（根など）は、設定の根の範囲と比べる。範囲を超える子・設定がない場合は失敗する", async () => {
    const r = rig();
    const ok1 = await r.call("node.spawn", { parentId: "m2", ...brief() }, "m2");
    expect(ok1.ok).toBe(true);
    const wide = await r.call(
      "node.spawn",
      { parentId: "m2", ...brief({ scope: { ...CHILD_SCOPE, allowedCommands: ["git push"] } }) },
      "m2",
    );
    expect(wide.error?.code).toBe("scopeNotSubset");
    // 上限が根の範囲のときは、直す場所（config.json の rootScope）と、daemon の起動し直しが要ることを出す（Issue #5）
    expect(wide.error?.cause).toContain("config.json");
    expect(wide.error?.cause).toContain("rootScope");
    expect(wide.error?.nextActions.join("\n")).toContain("daemon を起動し直す");
    const none = rig({ rootScope: null });
    const res = await none.call("node.spawn", { parentId: "m2", ...brief() }, "m2");
    expect(res.error?.code).toBe("rootScopeUnconfigured");
    expect(none.calls.provisioned).toEqual([]);
    expect(none.calls.started).toEqual([]);
    const badRoot = rig({ rootScope: { ...ROOT_SCOPE, writableLocations: ["/etc"] } });
    expect(
      (await badRoot.call("node.spawn", { parentId: "m2", ...brief() }, "m2")).error?.code,
    ).toBe("rootScopeInvalid");
  });

  it("深さの上限（#168 PR4）: 新しいノードの深さが上限以上なら、ポートに触れる前に depthExceeded で断る", async () => {
    // m1 は深さ 1。その下の子は深さ 2。上限 2 なら断る。
    const r = rig({ maxTreeDepth: 2 });
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("depthExceeded");
    expect(res.error?.cause).toContain("maxTreeDepth");
    expect(res.error?.nextActions.join("\n")).toContain("maxTreeDepth");
    expect(r.calls.provisioned).toEqual([]);
    expect(r.calls.issued).toEqual([]);
    expect(r.calls.started).toEqual([]);
    expect(r.s().nodes).toHaveLength(4);
  });

  it("深さの上限: 上限ちょうどに収まる（上限 3・深さ 2）なら生成できる。深さ 1 の統合ノードの下は、上限 2 だと断る", async () => {
    const fit = await rig({ maxTreeDepth: 3 }).call("node.spawn", { parentId: "m1", ...brief() });
    expect(fit.ok).toBe(true);
    const over = await rig({ maxTreeDepth: 2 }).call(
      "node.spawn",
      { parentId: "m2", ...brief() },
      "m2",
    );
    expect(over.error?.code).toBe("depthExceeded");
  });

  it("深さの上限: 省略したときの既定は 3。サブ統括（深さ 2 の統合ノード）の下の深さ 3 は断る", async () => {
    const r = rig();
    const sub = await r.call("node.spawn", { parentId: "m1", ...brief({ role: "integrator" }) });
    expect(sub.ok).toBe(true);
    const deep = await r.call("node.spawn", { parentId: sub.value.nodeId, ...brief() });
    expect(deep.error?.code).toBe("depthExceeded");
    expect(r.calls.provisioned).toHaveLength(1); // サブ統括の分だけ
  });

  it("node.split も同じ深さの上限に従う（上限 2 の下の切り出しは断る）", async () => {
    const r = rig({ maxTreeDepth: 2 });
    const res = await r.call("node.split", {
      nodeId: "a",
      keep: "mainline",
      ...brief({ role: undefined }),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("depthExceeded");
    expect(r.calls.provisioned).toEqual([]);
    expect(r.s().nodes).toHaveLength(4);
  });

  it("作業ツリーを作れなければ、何も記録せずに失敗する", async () => {
    const r = rig();
    r.flags.provisionFails = true;
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(res.error?.code).toBe("provisionFailed");
    expect(r.s().nodes).toHaveLength(4);
  });

  it("親が動作中の統合ノードでない・呼び出し元の部分木の外・依存が木の外なら、何もせずに失敗する", async () => {
    const r = rig();
    expect((await r.call("node.spawn", { parentId: "a", ...brief() })).ok).toBe(false); // 親が統合ノードでない
    expect((await r.call("node.spawn", { parentId: "m2", ...brief() })).error?.code).toBe(
      "forbidden",
    ); // 別の部分木
    expect(
      (await r.call("node.spawn", { parentId: "m1", ...brief({ dependsOn: ["nope"] }) })).ok,
    ).toBe(false);
    expect(r.calls.provisioned).toEqual([]);
  });
});

describe("再試行・同時実行・起動の手順", () => {
  it("起動の指示に、範囲と依存先を含める", async () => {
    const r = rig();
    await r.call("node.spawn", { parentId: "m1", ...brief({ dependsOn: ["a"] }) });
    expect(r.calls.started).toEqual([]); // a が未完了
    const r2 = rig();
    await r2.call("node.spawn", { parentId: "m1", ...brief() });
    const text = r2.calls.started[0]?.instruction ?? "";
    expect(text).toContain("src/ui");
    expect(text).toContain("pnpm test");
  });

  it("後始末済みの生成を、同じ requestId で再試行しても、成功として返さない（spawnFailedEarlier）", async () => {
    const r = rig();
    r.flags.startFails = true;
    const first = await r.call("node.spawn", { parentId: "m1", ...brief() }, "m1", "sp-f");
    expect(first.ok).toBe(false);
    r.flags.startFails = false;
    const again = await r.call("node.spawn", { parentId: "m1", ...brief() }, "m1", "sp-f");
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe("spawnFailedEarlier");
    expect(r.calls.started).toHaveLength(1);
  });

  it("同時に同じ requestId が 2 つ来ても、作業ツリー・トークン・起動は 1 回で、後始末は走らない", async () => {
    const r = rig();
    const [a, b] = await Promise.all([
      r.call("node.spawn", { parentId: "m1", ...brief() }, "m1", "sp-c"),
      r.call("node.spawn", { parentId: "m1", ...brief() }, "m1", "sp-c"),
    ]);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    expect(r.calls.provisioned).toHaveLength(1);
    expect(r.calls.issued).toHaveLength(1);
    expect(r.calls.started).toHaveLength(1);
    expect(r.calls.removed).toEqual([]);
    expect(r.calls.revoked).toEqual([]);
    expect(stateOf(r.s(), a.value.nodeId)).toBe("running");
    const [x, y] = await Promise.all([
      r.call("node.spawn", { parentId: "m1", ...brief() }, "m1", "sp-d"),
      r.call("node.spawn", { parentId: "m1", ...brief({ objective: "別" }) }, "m1", "sp-d"),
    ]);
    expect([x.error?.code, y.error?.code]).toContain("requestIdConflict");
    expect(r.calls.removed).toEqual([]);
  });

  it("記録済み・未起動（起動の前に異常終了した）の再試行は、起動だけをやり直す", async () => {
    const r = rig();
    const nodeId = deriveId("node", "m1", "sp-r", "spawn");
    r.log.append({
      requestId: derivedRequestId({ nodeId: "m1" }, "sp-r", 0),
      actor: { nodeId: "m1" },
      body: {
        type: "node.created",
        payload: {
          nodeId,
          role: "implement",
          parentId: "m1",
          dependsOn: [],
          objective: "UI を直す",
          acceptanceCriteria: ["テストが通る"],
          scope: CHILD_SCOPE,
        },
      },
    });
    expect(stateOf(r.s(), nodeId)).toBe("pending");
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() }, "m1", "sp-r");
    expect(res).toEqual({ ok: true, value: { nodeId, status: "running" } });
    expect(stateOf(r.s(), nodeId)).toBe("running");
    expect(r.calls.started).toHaveLength(1);
  });
});

describe("node.split（切り出し）", () => {
  it("元のノードと同じ役割・親で新しい子を作る。mainline は元を止めない", async () => {
    const r = rig();
    const res = await r.call("node.split", {
      nodeId: "a",
      keep: "mainline",
      ...brief({ role: undefined }),
    });
    expect(res.ok).toBe(true);
    const rec = r.s().nodes.find((x) => x.id === res.value.newNodeId);
    expect(rec).toMatchObject({ parentId: "m1", role: "implement" });
    expect(stateOf(r.s(), res.value.newNodeId)).toBe("running");
    expect(r.calls.stopped).toEqual([]);
    // 元のノードに、mainline へ復帰する指示を記録して届ける
    expect(r.s().instructions.at(-1)).toMatchObject({ nodeId: "a" });
    expect(r.calls.sent).toHaveLength(1);
    expect(r.calls.sent[0]?.[0]).toBe("a");
  });

  it("元を止められなかったら、新しいノードの ID を添えて失敗し、再送で止める操作だけをやり直す", async () => {
    const r = rig();
    r.flags.stopFails = true;
    const first = await r.call(
      "node.split",
      { nodeId: "a", keep: "stop", ...brief({ role: undefined }) },
      "m1",
      "spl-1",
    );
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("splitStopFailed");
    const created = r.s().nodes.filter((x) => x.parentId === "m1" && x.id !== "a");
    expect(created).toHaveLength(1);
    expect(first.error?.cause).toContain(created[0]?.id as string);
    r.flags.stopFails = false;
    const retry = await r.call(
      "node.split",
      { nodeId: "a", keep: "stop", ...brief({ role: undefined }) },
      "m1",
      "spl-1",
    );
    expect(retry.ok).toBe(true);
    expect(r.s().nodes.filter((x) => x.parentId === "m1" && x.id !== "a")).toHaveLength(1);
    expect(r.calls.started).toHaveLength(1);
  });

  it("keep が stop なら、新しい子の起動のあとで元のノードを止める", async () => {
    const r = rig();
    const res = await r.call("node.split", {
      nodeId: "a",
      keep: "stop",
      ...brief({ role: undefined }),
    });
    expect(res.ok).toBe(true);
    expect(r.calls.stopped).toEqual(["a"]);
  });

  it("動作中でないノード・部分木の外は、何もせずに失敗する", async () => {
    const r = rig();
    r.ev("a", { type: "reportDone" });
    expect(
      (await r.call("node.split", { nodeId: "a", keep: "mainline", ...brief({ role: undefined }) }))
        .ok,
    ).toBe(false);
    expect(
      (
        await r.call("node.split", {
          nodeId: "m2",
          keep: "mainline",
          ...brief({ role: undefined }),
        })
      ).error?.code,
    ).toBe("forbidden");
    expect(r.calls.provisioned).toEqual([]);
  });
});

describe("node.spawn の親のセッション", () => {
  it("parentSessionId を付けると、作った子の親のセッションとして記録する。ブリーフには入れない", async () => {
    const r = rig();
    const sid = "11111111-1111-4111-8111-111111111111";
    const res = await r.call("node.spawn", { parentId: "m1", ...brief(), parentSessionId: sid });
    expect(res.ok).toBe(true);
    const rec = r.s().nodes.find((x) => x.id === res.value.nodeId);
    expect(rec?.parentSession?.sessionId).toBe(sid);
    expect(JSON.stringify(rec?.objective)).not.toContain(sid);
  });
});
