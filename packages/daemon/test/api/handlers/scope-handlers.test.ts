import {
  type EventBody,
  type Failure,
  failure,
  type NodeEvent,
  ok,
  type Result,
  type Scope,
  uiViewOf,
} from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createScopeHandlers } from "../../../src/api/handlers/scope-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import type { RuntimeAdapter } from "../../../src/sdk/runtime.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
let n = 0;
const PARENT: Scope = {
  writableLocations: ["src", "docs"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test", "git status"],
};
const CHILD: Scope = {
  writableLocations: ["src/ui"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test"],
};

/** root ─ m1(範囲 PARENT) ─ a(範囲 CHILD・running)。root ─ m2 ─ b。 */
const rig = (
  opts: { rootScope?: Scope; denyRules?: readonly string[]; runtime?: "cli" | "desktop" } = {},
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
  const node = (
    nodeId: string,
    role: "integrator" | "implement",
    parentId: string | null,
    scope?: Scope,
    runtime?: "cli" | "desktop",
  ) =>
    add({
      type: "node.created",
      payload: {
        nodeId,
        role,
        parentId,
        dependsOn: [],
        ...(runtime === undefined ? {} : { runtime }),
        ...(scope === undefined ? {} : { objective: "o", acceptanceCriteria: ["c"], scope }),
      },
    });
  node("root", "integrator", null);
  ev("root", { type: "start" });
  node("m1", "integrator", "root", PARENT);
  ev("m1", { type: "start" });
  node("a", "implement", "m1", CHILD);
  ev("a", { type: "start" });
  node("m2", "integrator", "root", PARENT);
  ev("m2", { type: "start" });
  node("b", "implement", "m2", CHILD);
  ev("b", { type: "start" });
  node("c", "implement", "root", CHILD, opts.runtime);
  ev("c", { type: "start" });

  const calls = {
    updated: [] as [string, Scope][],
    sent: [] as [string, string][],
    failures: [] as string[],
  };
  const flags = { updateFails: false };
  const adapter = {
    kind: opts.runtime ?? ("cli" as const),
    send: async (id: string, text: string) => {
      calls.sent.push([id, text]);
      return ok({ status: "queued" as const });
    },
    updateScope: (id: string, scope: Scope): Result<undefined, Failure> => {
      calls.updated.push([id, scope]);
      return flags.updateFails
        ? { ok: false, error: failure("updateFailed", "x", "y") }
        : ok(undefined);
    },
  } as unknown as RuntimeAdapter;
  const h = createScopeHandlers({
    log,
    clock,
    adapterFor: () => adapter,
    cwdOf: async (id) => `/wt/${id}`,
    onFailure: (_id, cause) => calls.failures.push(cause),
    ...(opts.rootScope === undefined ? {} : { rootScope: opts.rootScope }),
    ...(opts.denyRules === undefined ? {} : { denyRules: opts.denyRules }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
  type Loose = { ok: boolean; value?: any; error?: Failure };
  const extend = async (params: Record<string, unknown>, caller = "a", requestId = `q-${++n}`) =>
    (await h["scope.extend"]({
      requestId,
      operation: "scope.extend",
      role: "child",
      caller: { nodeId: caller },
      params,
    } as unknown as HandlerRequest<"scope.extend">)) as Loose;
  const decide = async (params: Record<string, unknown>, caller = "m1", requestId = `q-${++n}`) =>
    (await h["scope.decide"]({
      requestId,
      operation: "scope.decide",
      role: "integrator",
      caller: { nodeId: caller },
      params,
    } as unknown as HandlerRequest<"scope.decide">)) as Loose;
  const decideAsHuman = async (params: Record<string, unknown>, requestId = `h-${++n}`) =>
    (await h["scope.decide"]({
      requestId,
      operation: "scope.decide",
      role: "human",
      params,
    } as unknown as HandlerRequest<"scope.decide">)) as Loose;
  return { log, extend, decide, decideAsHuman, calls, flags, ev, s: () => log.state() };
};
const GIT = { target: { kind: "command", value: "git status" }, reason: "状態を見たい" };

describe("scope.extend（範囲の拡張要求）", () => {
  it("要求を記録し、親の受信箱に項目（violation）を出す。再送は重複させない", async () => {
    const r = rig();
    const res = await r.extend(GIT, "a", "e-1");
    expect(res.ok).toBe(true);
    const id = res.value.extensionId as string;
    expect(r.s().extensions[0]).toMatchObject({
      extensionId: id,
      nodeId: "a",
      status: "open",
      target: GIT.target,
    });
    expect(r.s().inbox.at(-1)).toMatchObject({ kind: "violation", nodeId: "a", ref: id });
    const seq = r.s().lastSeq;
    expect(await r.extend(GIT, "a", "e-1")).toEqual(res);
    expect(r.s().lastSeq).toBe(seq);
  });

  it("制御文字・glob 文字・シェルの連結子・入れ子の .git・前後の空白は、何も記録せずに拒否する", async () => {
    const r = rig();
    const seq = r.s().lastSeq;
    const bad: [string, string][] = [
      ["write", "src/*.ts"],
      ["write", "src/{a,b}"],
      ["write", "src/a\nb"],
      ["write", "src/.git/hooks"],
      ["write", ".git"],
      ["write", " src"],
      ["write", "src "],
      ["command", "ls && rm -rf x"],
      ["command", "ls; rm x"],
      ["command", "ls | sh"],
      ["command", "ls\nrm x"],
      ["command", "echo `id`"],
      ["command", "echo $(id)"],
      ["command", " ls"],
    ];
    for (const [kind, value] of bad) {
      const res = await r.extend({ target: { kind, value }, reason: "r" });
      expect(res.ok, `${kind}:${value}`).toBe(false);
      expect(res.error?.code).toBe("invalidTarget");
    }
    expect(r.s().lastSeq).toBe(seq);
    expect(
      (await r.extend({ target: { kind: "command", value: "git status" }, reason: "r" })).ok,
    ).toBe(true);
  });

  it("ブリーフを見たまま書き写した「> 」付きの値は、印を外して受け付ける（記録も外した値）", async () => {
    const r = rig();
    const res = await r.extend({ target: { kind: "command", value: "> git status" }, reason: "r" });
    expect(res.ok).toBe(true);
    const w = await r.extend({ target: { kind: "write", value: ">  docs" }, reason: "r" });
    expect(w.ok).toBe(true);
    const values = r.s().extensions.map((x) => x.target.value);
    expect(values).toEqual(expect.arrayContaining(["git status", "docs"]));
    expect(values.some((v) => v.startsWith(">"))).toBe(false);
  });

  it("印を外すと空（「>」「> 」だけ）になる値は、何も記録せずに拒否する", async () => {
    const r = rig();
    const seq = r.s().lastSeq;
    for (const kind of ["command", "write"] as const) {
      for (const value of [">", "> ", ">\t "]) {
        const res = await r.extend({ target: { kind, value }, reason: "r" });
        expect(res.ok, `${kind}:${JSON.stringify(value)}`).toBe(false);
        expect(res.error?.code).toBe("invalidTarget");
      }
    }
    expect(r.s().lastSeq).toBe(seq);
  });

  it("書き込み先の絶対パス・.. ・/ は、何も記録せずに拒否する", async () => {
    const r = rig();
    const seq = r.s().lastSeq;
    for (const value of ["/etc", "../x", "src/../../x", "/"]) {
      const res = await r.extend({ target: { kind: "write", value }, reason: "r" });
      expect(res.ok, value).toBe(false);
      expect(res.error?.code).toBe("invalidTarget");
    }
    expect(r.s().lastSeq).toBe(seq);
  });

  it("未判定が上限（10 件）を超えたら、tooManyOpenExtensions", async () => {
    const r = rig();
    for (let i = 0; i < 10; i++) {
      expect(
        (await r.extend({ target: { kind: "command", value: `cmd${i}` }, reason: "r" })).ok,
      ).toBe(true);
    }
    const res = await r.extend({ target: { kind: "command", value: "cmd10" }, reason: "r" });
    expect(res.error?.code).toBe("tooManyOpenExtensions");
  });

  it("動作中でないノードは要求できない", async () => {
    const r = rig();
    r.ev("a", { type: "reportDone" });
    expect((await r.extend(GIT)).ok).toBe(false);
  });
});

describe("scope.decide（拡張の判定。承認でアダプタの範囲を更新する）", () => {
  const ask = async (r: ReturnType<typeof rig>, target = GIT.target) =>
    (await r.extend({ target, reason: "r" })).value.extensionId as string;

  it("承認: 許可した対象を記録し、有効な範囲でアダプタを更新する", async () => {
    const r = rig();
    const id = await ask(r);
    const res = await r.decide({ extensionId: id, decision: "approve" });
    expect(res).toEqual({ ok: true, value: { state: "running" } });
    expect(r.s().extensions[0]).toMatchObject({ status: "approved", granted: GIT.target });
    expect(r.calls.updated).toHaveLength(1);
    expect(r.calls.updated[0]?.[0]).toBe("a");
    expect(r.calls.updated[0]?.[1].allowedCommands).toEqual(["pnpm test", "git status"]);
  });

  it("人間は、部分木の判定を受けずに、全ノードの拡張を判定できる（判定者は人間として記録する）", async () => {
    const r = rig();
    const idA = await ask(r); // a（m1 の子）
    const idB = (await r.extend({ target: GIT.target, reason: "r" }, "b")).value
      .extensionId as string; // b（m2 の子）
    expect((await r.decideAsHuman({ extensionId: idA, decision: "approve" })).ok).toBe(true);
    expect((await r.decideAsHuman({ extensionId: idB, decision: "reject" })).ok).toBe(true);
    const [a, b] = r.s().extensions;
    expect(a).toMatchObject({ status: "approved", decidedBy: { human: true } });
    expect(b).toMatchObject({ status: "rejected", decidedBy: { human: true } });
    expect(r.calls.updated).toHaveLength(1);
    expect(r.calls.updated[0]?.[0]).toBe("a");
  });

  it("統合ノードは、発生元が自分の子孫でない拡張を判定できない（forbidden）。人間なら未知の要求は notFound", async () => {
    const r = rig();
    const idB = (await r.extend({ target: GIT.target, reason: "r" }, "b")).value
      .extensionId as string;
    const res = await r.decide({ extensionId: idB, decision: "approve" }, "m1");
    expect(res.error?.code).toBe("forbidden");
    expect((await r.decideAsHuman({ extensionId: "nope", decision: "approve" })).error?.code).toBe(
      "notFound",
    );
  });

  it("判定したら、受信箱の拡張要求の項目を解決済みにする（inbox.fetch には出なくなる）", async () => {
    const r = rig();
    const id = await ask(r);
    const item = r.s().inbox.find((i) => i.ref === id);
    expect(item?.resolved).toBeUndefined();
    await r.decide({ extensionId: id, decision: "reject" });
    expect(r.s().inbox.find((i) => i.ref === id)?.resolved).toBeDefined();
  });

  it("却下・切り出し: 記録だけ。アダプタは更新しない", async () => {
    const r = rig();
    const id = await ask(r);
    expect((await r.decide({ extensionId: id, decision: "reject" })).ok).toBe(true);
    expect(r.s().extensions[0]?.status).toBe("rejected");
    const id2 = await ask(r, { kind: "command", value: "ls" });
    expect((await r.decide({ extensionId: id2, decision: "split" })).ok).toBe(true);
    expect(r.calls.updated).toEqual([]);
  });

  it("親の範囲を超える拡張は、承認しない（何も記録しない）", async () => {
    const r = rig();
    const id = await ask(r, { kind: "command", value: "rm" });
    const seq = r.s().lastSeq;
    const res = await r.decide({ extensionId: id, decision: "approve" });
    expect(res.error?.code).toBe("scopeNotSubset");
    // 親がブリーフを持つ（根の範囲が上限でない）ときは、設定ファイルの話を出さない
    expect(JSON.stringify(res.error)).not.toContain("config.json");
    expect(r.s().lastSeq).toBe(seq);
    expect(r.calls.updated).toEqual([]);
  });

  it("根の子の拡張が根の範囲を超えるときは、直す場所（config.json の rootScope）と daemon の起動し直しを出す（Issue #5）", async () => {
    const r = rig({ rootScope: PARENT });
    const id = (
      await r.extend({ target: { kind: "command", value: "git commit" }, reason: "r" }, "c")
    ).value.extensionId as string;
    const res = await r.decide({ extensionId: id, decision: "approve" }, "root");
    expect(res.error?.code).toBe("scopeNotSubset");
    expect(res.error?.cause).toContain("config.json");
    expect(res.error?.cause).toContain("rootScope");
    expect(res.error?.nextActions.join("\n")).toContain("daemon を起動し直");
    expect(r.calls.updated).toEqual([]);
  });

  describe("MCP ツールの依頼（kind: mcp）", () => {
    const TOOL = "mcp__chrome__navigate";
    const WITH_MCP: Scope = { ...PARENT, allowedMcpTools: [TOOL] };
    const ask = (r: ReturnType<typeof rig>, value: string, caller = "c") =>
      r.extend({ target: { kind: "mcp", value }, reason: "r" }, caller);

    it("サーバー全体・自ノードの touryou の道具・形の崩れた名前は、何も記録せずに断る", async () => {
      const r = rig({ rootScope: WITH_MCP });
      const seq = r.s().lastSeq;
      for (const value of [
        "mcp__chrome",
        "mcp__chrome__",
        "mcp__node__whoami",
        "mcp__plugin_touryou_node__report_done",
        "Bash",
        " mcp__chrome__navigate",
      ]) {
        const res = await ask(r, value);
        expect(res.ok, value).toBe(false);
        expect(res.error?.code, value).toBe("invalidTarget");
      }
      expect(r.s().lastSeq).toBe(seq);
    });

    it("Desktop の子からの依頼は断る（MCP は CLI の子だけ）", async () => {
      const r = rig({ rootScope: WITH_MCP, runtime: "desktop" });
      expect((await ask(r, TOOL)).error?.code).toBe("invalidTarget");
    });

    it("上限（rootScope の allowedMcpTools）の中なら、承認でき、子のスコープに入る", async () => {
      const r = rig({ rootScope: WITH_MCP });
      const id = (await ask(r, TOOL)).value.extensionId as string;
      const res = await r.decide({ extensionId: id, decision: "approve" }, "root");
      expect(res.ok).toBe(true);
      expect(r.calls.updated.at(-1)?.[1].allowedMcpTools).toEqual([TOOL]);
    });

    it("上限にない MCP ツールは、承認できない（scopeNotSubset）", async () => {
      const r = rig({ rootScope: WITH_MCP });
      const id = (await ask(r, "mcp__chrome__evaluate")).value.extensionId as string;
      const res = await r.decide({ extensionId: id, decision: "approve" }, "root");
      expect(res.error?.code).toBe("scopeNotSubset");
      expect(r.calls.updated).toEqual([]);
    });

    it("deny の規則に当たる MCP ツールは、上限にあっても承認できない（deny が勝つ）", async () => {
      const r = rig({ rootScope: WITH_MCP, denyRules: ["mcp__chrome__navigate"] });
      const id = (await ask(r, TOOL)).value.extensionId as string;
      const res = await r.decide({ extensionId: id, decision: "approve" }, "root");
      expect(res.error?.code).toBe("scopeDenied");
      expect(r.calls.updated).toEqual([]);
    });
  });

  it("更新に失敗したら、判定は記録済みのまま、受信箱に failure を出して失敗を返す。同じ要求の再送で更新をやり直す", async () => {
    const r = rig();
    const id = await ask(r);
    r.flags.updateFails = true;
    const res = await r.decide({ extensionId: id, decision: "approve" }, "m1", "d-1");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("scopeUpdateFailed");
    expect(r.s().extensions[0]?.status).toBe("approved");
    expect(r.s().inbox.at(-1)).toMatchObject({ kind: "failure", nodeId: "a" });
    r.flags.updateFails = false;
    const retry = await r.decide({ extensionId: id, decision: "approve" }, "m1", "d-1");
    expect(retry.ok).toBe(true);
    expect(r.calls.updated).toHaveLength(2);
  });

  it("すでに approved の拡張への再承認は、記録せず、更新だけをやり直して成功する（requestId が違っても）", async () => {
    const r = rig();
    const id = await ask(r);
    r.flags.updateFails = true;
    await r.decide({ extensionId: id, decision: "approve" }, "m1", "d-1");
    r.flags.updateFails = false;
    const seq = r.s().lastSeq;
    const again = await r.decide({ extensionId: id, decision: "approve" }, "m1", "d-other");
    expect(again.ok).toBe(true);
    expect(r.s().lastSeq).toBe(seq);
    expect(r.calls.updated).toHaveLength(2);
    // 却下済みへの承認は、成功にしない
    const id2 = await ask(r, { kind: "command", value: "ls" });
    await r.decide({ extensionId: id2, decision: "reject" });
    expect((await r.decide({ extensionId: id2, decision: "approve" })).error?.code).toBe(
      "extensionAlreadyDecided",
    );
  });

  it("動作中でないノードの承認は、記録だけ行い、アダプタを更新しない（次回の起動で有効な範囲が使われる）", async () => {
    const r = rig();
    const id = await ask(r);
    r.ev("a", { type: "reportDone" });
    r.ev("a", { type: "accept" });
    const res = await r.decide({ extensionId: id, decision: "approve" });
    expect(res.ok).toBe(true);
    expect(r.s().extensions[0]?.status).toBe("approved");
    expect(r.calls.updated).toEqual([]);
  });

  it("判定の結果を、動作中の子に追加指示として記録して届ける（承認・却下・切り出し）", async () => {
    const r = rig();
    const id = await ask(r);
    await r.decide({ extensionId: id, decision: "approve" });
    expect(r.s().instructions.at(-1)?.nodeId).toBe("a");
    expect(r.s().instructions.at(-1)?.text).toContain("承認");
    expect(r.calls.sent.at(-1)?.[0]).toBe("a");
    const id2 = await ask(r, { kind: "command", value: "ls" });
    await r.decide({ extensionId: id2, decision: "reject" });
    expect(r.s().instructions.at(-1)?.text).toContain("却下");
  });

  it("判定の結果の追加指示は、状態画面のやり取りで「許可」「却下」「切り出し」になる（#115。文の頭が core と合う）", async () => {
    const r = rig();
    const kinds: string[] = [];
    for (const [decision, value] of [
      ["approve", "src/a1"],
      ["reject", "src/a2"],
      ["split", "src/a3"],
    ] as const) {
      const id = await ask(r, { kind: "write", value });
      await r.decide({ extensionId: id, decision });
      const last = r.s().instructions.at(-1);
      const flow = uiViewOf(r.s()).flows.find((f) => f.id === `f-${last?.seq}`);
      kinds.push(flow?.kind ?? "none");
    }
    expect(kinds).toEqual(["approved", "rejected", "split"]);
  });

  it("対象のノードの親（の祖先）でなければ forbidden。判定済みの再判定は拒否される", async () => {
    const r = rig();
    const id = await ask(r);
    expect((await r.decide({ extensionId: id, decision: "approve" }, "m2")).error?.code).toBe(
      "forbidden",
    );
    expect((await r.decide({ extensionId: id, decision: "approve" }, "a")).error?.code).toBe(
      "forbidden",
    );
    await r.decide({ extensionId: id, decision: "reject" });
    const again = await r.decide({ extensionId: id, decision: "approve" });
    expect(again.error?.code).toBe("extensionAlreadyDecided");
  });
});
