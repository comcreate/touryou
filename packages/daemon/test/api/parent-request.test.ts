/**
 * 親への依頼（設計 6.1・6.2）: CLI の子のアダプタ（起動の依頼・コードのファイル）、`parent.request`・`parent.report`、
 * 知らせの宛先（親のセッションだけ）、`node.bindCode` の出し直し（コードを応答に入れない）。
 */
import type { EventBody, NodeEvent } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createBindCodes } from "../../src/api/bind.js";
import { createBindHandlers } from "../../src/api/handlers/bind-handlers.js";
import { createParentRequestHandlers } from "../../src/api/handlers/parent-request-handlers.js";
import type { HandlerRequest } from "../../src/api/server.js";
import { nodeFeedOf } from "../../src/api/sse-hub.js";
import { validateParams } from "../../src/api/validate.js";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";
import { ParentRequestCliAdapter } from "../../src/sdk/cli-adapter.js";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const SCOPE = { writableLocations: ["src"], forbiddenLocations: [], allowedCommands: [] };
let n = 0;

const rig = (
  opts: {
    failWrite?: boolean;
    pluginDir?: import("../../src/sdk/plugin-dir.js").PluginDirPorts;
  } = {},
) => {
  const clockIso = "2026-11-12T00:00:00Z";
  const opened = EventLog.open(createMemoryStore().open(), { clock: () => clockIso });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
    return r.value.event.seq;
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) => {
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
    ev(nodeId, { type: "start" });
  };
  node("root", "integrator", null);
  node("a", "implement", "root");
  node("b", "implement", "root");
  let now = Date.parse(clockIso);
  const bind = createBindCodes({ clock: () => now });
  const files = new Map<string, string>();
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const adapter = new ParentRequestCliAdapter({
    log,
    clock: () => clockIso,
    bind,
    writeCodeFile: (wt, code) => {
      if (opts.failWrite === true) throw new Error("disk");
      files.set(wt, code);
    },
    removeCodeFile: (wt) => {
      files.delete(wt);
    },
    after: (ms, fn) => {
      const t = { at: now + ms, fn, cancelled: false };
      timers.push(t);
      return { cancel: () => (t.cancelled = true) };
    },
    nowMs: () => now,
    newRef: () => `preq-${++n}`,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers)
      if (!t.cancelled && t.at <= now) {
        t.cancelled = true;
        t.fn();
      }
  };
  const handlers = createParentRequestHandlers({
    log,
    clock: () => clockIso,
    ...(opts.pluginDir === undefined ? {} : { pluginDir: opts.pluginDir }),
  });
  const call = <Op extends "parent.request" | "parent.report">(
    operation: Op,
    params: HandlerRequest<Op>["params"],
    requestId = `q-${++n}`,
  ) =>
    (
      handlers[operation] as unknown as (r: HandlerRequest<Op>) => ReturnType<(typeof handlers)[Op]>
    )({
      requestId,
      operation,
      role: "integrator",
      caller: { nodeId: "root" },
      params,
    } as unknown as HandlerRequest<Op>);
  const start = (nodeId: string) =>
    adapter.start({ nodeId, worktreePath: `/w/trees/${nodeId}`, scope: SCOPE, instruction: "x" });
  return { log, add, ev, adapter, bind, files, advance, call, start };
};

describe("CLI の子のアダプタ: 起動は親への依頼", () => {
  it("start: コードのファイルを書き、依頼と受信箱の項目を記録する。記録・受信箱にコードは入らない", async () => {
    const r = rig();
    const s = await r.start("a");
    expect(s.ok).toBe(true);
    const code = r.files.get("/w/trees/a") as string;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const st = r.log.state();
    expect(st.parentRequests).toHaveLength(1);
    expect(st.parentRequests[0]).toMatchObject({
      nodeId: "a",
      kind: "launch",
      worktree: "/w/trees/a",
    });
    const item = st.inbox.find((i) => i.nodeId === "a");
    expect(item?.kind).toBe("info");
    expect(item?.summary).toContain("parent_request");
    expect(JSON.stringify(st)).not.toContain(code);
    expect(r.adapter.has("a")).toBe(true);
    expect(r.adapter.has("b")).toBe(false);
    // コードは daemon のメモリのものと同じ（ファイルは写し）
    expect(r.bind.redeem("a", code).ok).toBe(true);
  });

  it("コードの期限が来たら、ファイルを消す", async () => {
    const r = rig();
    await r.start("a");
    r.advance(9 * 60_000);
    expect(r.files.has("/w/trees/a")).toBe(true);
    r.advance(2 * 60_000);
    expect(r.files.has("/w/trees/a")).toBe(false);
  });

  it("ファイルを書けなければ、起動の依頼を記録せず、コードを無効にして失敗する", async () => {
    const r = rig({ failWrite: true });
    const s = await r.start("a");
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error.code).toBe("bindCodeFileFailed");
    expect(r.log.state().parentRequests).toHaveLength(0);
    expect(r.bind.outstanding?.("a")).toBe(false);
  });

  it("stop: 起動の依頼がない子は、止めたと記録する（stopping → stopped）。親が起動の失敗を報告した子も同じ", async () => {
    const r = rig();
    const seq = r.ev("b", { type: "stop", mode: "immediate" });
    const s1 = await r.adapter.stop("b", { mode: "immediate", stopSeq: seq });
    expect(s1.ok && s1.value.state).toBe("stopped");
    expect(r.log.state().nodes.find((x) => x.id === "b")?.state).toBe("stopped");
    expect(r.log.state().stopObservations.at(-1)).toMatchObject({
      nodeId: "b",
      outcome: "aborted",
    });
    // 起動の失敗が報告された子
    await r.start("a");
    const ref = r.log.state().parentRequests[0]?.requestRef as string;
    await r.call("parent.report", { nodeId: "a", requestRef: ref, outcome: "failed", reason: "x" });
    expect(r.adapter.has("a")).toBe(false);
    const seq2 = r.ev("a", { type: "stop", mode: "immediate" });
    const s2 = await r.adapter.stop("a", { mode: "immediate", stopSeq: seq2 });
    expect(s2.ok && s2.value.state).toBe("stopped");
    expect(r.log.state().nodes.find((x) => x.id === "a")?.state).toBe("stopped");
    expect(r.files.has("/w/trees/a")).toBe(false);
    expect(r.bind.outstanding?.("a")).toBe(false);
  });

  it("stop: 起動を依頼したが報告がない子は、止めたと記録しない（親が claude --bg を実行したあとかもしれない）。親に確かめてもらう失敗を返す", async () => {
    const r = rig();
    await r.start("a");
    const seq = r.ev("a", { type: "stop", mode: "graceful" });
    const s = await r.adapter.stop("a", { mode: "graceful", stopSeq: seq });
    expect(s.ok).toBe(false);
    if (!s.ok) {
      expect(s.error.code).toBe("notSupported");
      expect(s.error.cause).toContain("claude agents --json");
    }
    expect(r.log.state().nodes.find((x) => x.id === "a")?.state).toBe("stopping");
    expect(r.adapter.has("a")).toBe(true);
  });
});

describe("parent.request・parent.report", () => {
  it("parent.request: 親のモデル・深さを書き込んだ、変数のない文を返す。コードは入らない", async () => {
    const r = rig();
    await r.start("a");
    const code = r.files.get("/w/trees/a") as string;
    const q = r.call("parent.request", { nodeId: "a", model: "opus", effort: "high" });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.value.kind).toBe("launch");
    expect(
      q.value.command.startsWith(
        '(cd /w/trees/a && claude --bg \'最初に touryou の child_bind を引数なしで呼んで、受信箱の手順に従って\' --name a --model opus --effort high --permission-mode dontAsk --settings \'{"crossSessionInbound":"accept","permissions":{"allow":[',
      ),
    ).toBe(true);
    expect(q.value.command).toContain('"mcp__node__child_bind"');
    expect(q.value.command).not.toContain(code);
    expect(q.value.next).toContain(q.value.requestRef);
    const f = r.call("parent.request", { nodeId: "a", forkSessionRef: "parent-1" });
    expect(f.ok && f.value.command.endsWith("--resume parent-1 --fork-session)")).toBe(true);
  });

  it("parent.request: 起動する道具の許可は、ノードのロールで決まる（サブ統括は統合の道具＋child_bind、子は子の道具）（#168 PR3）", async () => {
    const r = rig();
    r.add({
      type: "node.created",
      payload: { nodeId: "sub", role: "integrator", parentId: "root", dependsOn: [] },
    });
    r.ev("sub", { type: "start" });
    await r.start("a");
    await r.start("sub");
    const child = r.call("parent.request", { nodeId: "a" });
    const sub = r.call("parent.request", { nodeId: "sub" });
    expect(child.ok && sub.ok).toBe(true);
    if (!child.ok || !sub.ok) return;
    // サブ統括: 統合の道具と、親への報告の道具（完了・範囲の拡張・子の受信箱 child_inbox）が入り、人間専用の操作は入らない
    for (const t of [
      "child_bind",
      "whoami",
      "node_spawn",
      "node_review",
      "parent_request",
      "report_done",
      "scope_extend",
      "child_inbox",
    ]) {
      expect(sub.value.command, t).toContain(`"mcp__node__${t}"`);
      expect(sub.value.command, t).toContain(`"mcp__plugin_touryou_node__${t}"`);
    }
    for (const t of ["node_hookToken", "node_purge"]) {
      expect(sub.value.command, t).not.toContain(`"mcp__node__${t}"`);
    }
    // 子: 従来どおり、子の道具だけ
    expect(child.value.command).toContain('"mcp__node__report_done"');
    expect(child.value.command).not.toContain('"mcp__node__node_spawn"');
    // 起動の指示: サブ統括は integrator の skill を指し、子は従来の文のまま
    expect(sub.value.command).toContain(
      "--bg 'touryou の integrator の skill に従って、最初に child_bind を引数なしで呼んで' --name sub",
    );
    expect(child.value.command).toContain(
      "--bg '最初に touryou の child_bind を引数なしで呼んで、受信箱の手順に従って' --name a",
    );
  });

  it("parent.request: plugin の場所が確かめを通れば --plugin-dir を足す。通らなければ付けず、受信箱に理由を 1 回だけ出す", async () => {
    const files: Record<string, string> = {
      "/p/good/.claude-plugin/plugin.json": '{"name":"touryou"}',
      "/p/other/.claude-plugin/plugin.json": '{"name":"other"}',
    };
    const r = rig({
      pluginDir: {
        readFile: (p) => {
          const v = files[p];
          if (v === undefined) throw new Error("ENOENT");
          return v;
        },
        realpath: (p) => (p === "/p/link" ? "/p/good" : p),
        forbiddenRoots: ["/w"],
      },
    });
    await r.start("a");
    const good = r.call("parent.request", { nodeId: "a", pluginRoot: "/p/good" });
    expect(good.ok && good.value.command).toContain(
      " --plugin-dir /p/good --permission-mode dontAsk ",
    );
    for (const bad of ["/p/other", "/p/none", "rel/dir", "/p/it's", "/w/trees/a"]) {
      const q = r.call("parent.request", { nodeId: "a", pluginRoot: bad });
      expect(q.ok && q.value.command).not.toContain("--plugin-dir");
    }
    const items = r.log
      .state()
      .inbox.filter((i) => (i.summary ?? "").includes("plugin を付けられなかった"));
    expect(items).toHaveLength(1);
    expect(items[0]?.summary).not.toContain("/p/");
    const none = r.call("parent.request", { nodeId: "a" });
    expect(none.ok && none.value.command).not.toContain("--plugin-dir");
  });

  it("parent.request: 依頼のない子は noRequest", () => {
    const r = rig();
    const q = r.call("parent.request", { nodeId: "a" });
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.error.code).toBe("noRequest");
  });

  it("parent.report（done）: 子のセッションの参照を記録し、依頼の受信箱の項目を解決する。同じ要求の再送は重複", async () => {
    const r = rig();
    await r.start("a");
    const ref = r.log.state().parentRequests[0]?.requestRef as string;
    const p = await r.call(
      "parent.report",
      { nodeId: "a", requestRef: ref, outcome: "done", sessionRef: "abc-1" },
      "rep-1",
    );
    expect(p.ok && p.value).toEqual({ recorded: true, duplicate: false });
    const st = r.log.state();
    expect(st.parentRequests[0]?.report).toMatchObject({
      outcome: "done",
      sessionRef: "abc-1",
      actor: { nodeId: "root" },
    });
    expect(st.inbox.find((i) => i.nodeId === "a")?.resolved).toBeDefined();
    const again = await r.call(
      "parent.report",
      { nodeId: "a", requestRef: ref, outcome: "done", sessionRef: "abc-1" },
      "rep-1",
    );
    expect(again.ok && again.value.duplicate).toBe(true);
    // 別の要求で二度目の報告は拒否
    const other = await r.call("parent.report", {
      nodeId: "a",
      requestRef: ref,
      outcome: "failed",
      reason: "x",
    });
    expect(other.ok).toBe(false);
    // 報告のあとは、まだ報告のない依頼はない
    expect(r.call("parent.request", { nodeId: "a" }).ok).toBe(false);
  });

  it("parent.report（failed）は受信箱に failure を出す。止まっていそうな子の状態（need_input）は受信箱に出す", async () => {
    const r = rig();
    await r.start("a");
    await r.start("b");
    const refOf = (id: string) =>
      r.log.state().parentRequests.find((x) => x.nodeId === id)?.requestRef as string;
    expect(
      (
        await r.call("parent.report", {
          nodeId: "a",
          requestRef: refOf("a"),
          outcome: "failed",
          reason: "信頼の画面で止まった",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await r.call("parent.report", {
          nodeId: "b",
          requestRef: refOf("b"),
          outcome: "done",
          sessionRef: "s-b",
          agentState: "need_input",
        })
      ).ok,
    ).toBe(true);
    const inbox = r.log.state().inbox;
    expect(inbox.find((i) => i.nodeId === "a" && i.kind === "failure")?.summary).toContain(
      "信頼の画面で止まった",
    );
    expect(
      inbox.find((i) => i.nodeId === "b" && i.kind === "info" && i.resolved === undefined)?.summary,
    ).toContain("need_input");
  });

  it("parent.report: ほかのノードの依頼の参照は notFound", async () => {
    const r = rig();
    await r.start("a");
    const ref = r.log.state().parentRequests[0]?.requestRef as string;
    const p = await r.call("parent.report", { nodeId: "b", requestRef: ref, outcome: "done" });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.code).toBe("notFound");
  });

  it("窓口の検査: モデル・深さ・参照・状態の形", () => {
    expect(
      validateParams("parent.request", { nodeId: "a", model: "opus", effort: "high" }).ok,
    ).toBe(true);
    expect(validateParams("parent.request", { nodeId: "a", model: "o p" }).ok).toBe(false);
    expect(validateParams("parent.request", { nodeId: "a", effort: "ultra" }).ok).toBe(false);
    expect(validateParams("parent.request", { nodeId: "a", forkSessionRef: "$(x)" }).ok).toBe(
      false,
    );
    expect(
      validateParams("parent.report", {
        nodeId: "a",
        requestRef: "p1",
        outcome: "done",
        agentState: "need_input",
      }).ok,
    ).toBe(true);
    expect(
      validateParams("parent.report", { nodeId: "a", requestRef: "p1", outcome: "ok" }).ok,
    ).toBe(false);
    expect(
      validateParams("parent.report", {
        nodeId: "a",
        requestRef: "p1",
        outcome: "done",
        sessionRef: "a b",
      }).ok,
    ).toBe(false);
  });
});

describe("依頼の知らせの宛先（C2 の流し方）", () => {
  it("依頼は、その子の親のセッションの購読にだけ流す。親のセッションの記録がない子の依頼は流さない（受信箱とフックで拾う）", async () => {
    const r = rig();
    r.add({ type: "node.parentSessionSet", payload: { nodeId: "a", sessionId: S1 } });
    // b の親のセッションは記録しない。a より後に、別のセッションが最後に親の操作をした
    await r.start("a");
    await r.start("b");
    r.add({ type: "node.parentSessionSet", payload: { nodeId: "root", sessionId: S2 } });
    const feed = nodeFeedOf(r.log.state(), "root", 0).filter((e) => e.kind === "request");
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: "request", childId: "a", target: S1 });
    // 報告のあとは流さない
    const ref = r.log.state().parentRequests.find((x) => x.nodeId === "a")?.requestRef as string;
    await r.call("parent.report", { nodeId: "a", requestRef: ref, outcome: "done" });
    expect(nodeFeedOf(r.log.state(), "root", 0).filter((e) => e.kind === "request")).toHaveLength(
      0,
    );
    // 子の自分の購読には流さない
    expect(nodeFeedOf(r.log.state(), "a", 0).some((e) => e.kind === "request")).toBe(false);
  });
});

describe("node.bindCode の出し直し（CLI の木）", () => {
  it("ファイルを書き直し、応答にコードを入れない。古いコードは無効", async () => {
    const r = rig();
    await r.start("a");
    const first = r.files.get("/w/trees/a") as string;
    const h = createBindHandlers({
      log: r.log,
      bind: r.bind,
      cli: true,
      baseUrl: () => "http://127.0.0.1:7777",
      cliIssueFile: (id) => r.adapter.issueCodeFile(id, `/w/trees/${id}`),
    });
    const res = h["node.bindCode"]({
      requestId: "bc-1",
      operation: "node.bindCode",
      role: "integrator",
      caller: { nodeId: "root" },
      params: { nodeId: "a", parentSessionId: S1 },
    } as unknown as HandlerRequest<"node.bindCode">);
    expect(res.ok).toBe(true);
    const second = r.files.get("/w/trees/a") as string;
    expect(second).not.toBe(first);
    if (res.ok) {
      expect(res.value.instruction).not.toContain(second);
      expect(res.value.instruction).not.toMatch(/[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}/);
      expect(res.value.instruction).toContain("子の MCP が、このファイルを自分で読んで結び直す");
    }
    expect(r.bind.redeem("a", first).ok).toBe(false);
    expect(r.bind.redeem("a", second).ok).toBe(true);
    expect(r.log.state().nodes.find((x) => x.id === "a")?.parentSession?.sessionId).toBe(S1);
  });
});
