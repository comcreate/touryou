/**
 * 2 段の停止・削除・見張り（設計 6.2）。
 * - 停止: (1) 子へ停止の指示（記録から知らせ）→ 猶予の間、作業ツリーのプロセスがなくなれば stopped。(2) 猶予を過ぎたら、親に
 *   `claude stop` を依頼して stopIncomplete。親の「止めた」のあとも、`lsof-probe` で確かめてから stopped。
 * - 削除: 停止を確かめたら `claude rm` を依頼。拒まれたら消さずに受信箱へ。成果を捨てる旗は、人間が破棄を決めたときだけ。
 * - 見張り: 記録の時刻だけで、止まっているかもしれない子と、読まれていない指示を受信箱に出す。
 */
import type { EventBody, NodeEvent, ProcessInfo } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createBindCodes } from "../../src/api/bind.js";
import {
  createParentRequestHandlers,
  SESSION_GONE,
} from "../../src/api/handlers/parent-request-handlers.js";
import type { HandlerRequest } from "../../src/api/server.js";
import { nodeFeedOf } from "../../src/api/sse-hub.js";
import { recordWatchFindings, watchFindings } from "../../src/cli-watch.js";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";
import { ParentRequestCliAdapter } from "../../src/sdk/cli-adapter.js";

const T0 = "2026-11-12T00:00:00.000Z";
const SCOPE = { writableLocations: ["src"], forbiddenLocations: [], allowedCommands: [] };
const S1 = "11111111-1111-4111-8111-111111111111";
let n = 0;

const rig = () => {
  let clockIso = T0;
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
  for (const [id, parent] of [
    ["root", null],
    ["a", "root"],
  ] as const) {
    add({
      type: "node.created",
      payload: {
        nodeId: id,
        role: id === "root" ? "integrator" : "implement",
        parentId: parent,
        dependsOn: [],
      },
    });
    ev(id, { type: "start" });
  }
  add({ type: "node.parentSessionSet", payload: { nodeId: "a", sessionId: S1 } });
  // 作業ツリーのプロセス（試験で入れ替える）。null は調べられない
  let procs: readonly ProcessInfo[] | null = [];
  const probe = async () => procs;
  let now = Date.parse(T0);
  const timers = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      onSleep?.();
    },
  };
  let onSleep: (() => void) | undefined;
  const adapter = new ParentRequestCliAdapter({
    log,
    clock: () => clockIso,
    bind: createBindCodes(),
    writeCodeFile: () => undefined,
    removeCodeFile: () => undefined,
    after: () => ({ cancel: () => undefined }),
    newRef: () => `preq-${++n}`,
    probe,
    timers,
    pollMs: 5_000,
  });
  const h = createParentRequestHandlers({
    log,
    clock: () => clockIso,
    probe,
    release: (id) => adapter.release(id),
  });
  const call = async <Op extends "parent.request" | "parent.report">(
    operation: Op,
    params: HandlerRequest<Op>["params"],
  ) =>
    (h[operation] as unknown as (r: HandlerRequest<Op>) => unknown)({
      requestId: `q-${++n}`,
      operation,
      role: "integrator",
      caller: { nodeId: "root" },
      params,
    } as unknown as HandlerRequest<Op>) as Promise<{
      ok: boolean;
      value?: Record<string, unknown>;
      error?: { code: string };
    }>;
  /** 起動して、親が起動を報告した状態にする。 */
  const launched = async () => {
    await adapter.start({ nodeId: "a", worktreePath: "/w/a", scope: SCOPE, instruction: "x" });
    const ref = log.state().parentRequests[0]?.requestRef as string;
    await call("parent.report", {
      nodeId: "a",
      requestRef: ref,
      outcome: "done",
      sessionRef: "sess-a",
    });
  };
  const stateOfA = () => log.state().nodes.find((x) => x.id === "a")?.state;
  const open = () => [...log.state().parentRequests].reverse().find((r) => r.report === undefined);
  return {
    log,
    ev,
    add,
    adapter,
    call,
    launched,
    stateOfA,
    open,
    setProcs: (p: readonly ProcessInfo[] | null) => {
      procs = p;
    },
    onSleep: (f: () => void) => {
      onSleep = f;
    },
    setNow: (iso: string) => {
      clockIso = iso;
    },
  };
};

const busy: ProcessInfo[] = [{ pid: 42, cwd: "/w/a", hasOpenFiles: true, command: "claude" }];

describe("2 段の停止", () => {
  it("(1) 穏当な停止: 猶予の間に作業ツリーのプロセスがなくなっても stopped にせず、待つのをやめて親に claude stop を依頼する", async () => {
    const r = rig();
    await r.launched();
    r.setProcs(busy);
    let sleeps = 0;
    r.onSleep(() => {
      if (++sleeps === 2) r.setProcs([]);
    });
    const seq = r.ev("a", { type: "stop", mode: "graceful" });
    const s = await r.adapter.stop("a", { mode: "graceful", stopSeq: seq });
    expect(sleeps).toBe(2); // 猶予の終わりまで待たない
    expect(s.ok && s.value.state).toBe("stopIncomplete");
    expect(r.stateOfA()).toBe("stopIncomplete");
    expect(r.open()?.kind).toBe("stop");
    // 停止の指示は、子の購読に流れる（記録から）
    expect(nodeFeedOf(r.log.state(), "a", 0).some((e) => e.kind === "stop")).toBe(true);
    // 親の報告のあと、lsof で確かめて stopped にし、claude rm を依頼する（親の報告の道と同じ順）
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "done",
    });
    expect(r.stateOfA()).toBe("stopped");
    expect(r.open()?.kind).toBe("remove");
  });

  it("(2) 猶予（既定 60 秒）を過ぎても残れば、親に claude stop を依頼して stopIncomplete。依頼は親のセッションに流れる", async () => {
    const r = rig();
    await r.launched();
    r.setProcs(busy);
    let slept = 0;
    r.onSleep(() => {
      slept++;
    });
    const seq = r.ev("a", { type: "stop", mode: "graceful" });
    const s = await r.adapter.stop("a", { mode: "graceful", stopSeq: seq });
    expect(slept).toBe(12); // 60 秒 / 5 秒
    expect(s.ok && s.value.state).toBe("stopIncomplete");
    expect(s.ok && s.value.state === "stopIncomplete" && s.value.delegation).toContain(
      "claude stop",
    );
    expect(r.stateOfA()).toBe("stopIncomplete");
    const req = await r.call("parent.request", { nodeId: "a" });
    expect(req.value).toMatchObject({ kind: "stop", command: "claude stop sess-a" });
    const feed = nodeFeedOf(r.log.state(), "root", 0).filter((e) => e.kind === "request");
    expect(feed).toEqual([expect.objectContaining({ childId: "a", target: S1 })]);
  });

  it("即時の停止は (2) だけ（猶予を待たない）", async () => {
    const r = rig();
    await r.launched();
    r.setProcs(busy);
    let slept = 0;
    r.onSleep(() => {
      slept++;
    });
    const seq = r.ev("a", { type: "stop", mode: "immediate" });
    const s = await r.adapter.stop("a", { mode: "immediate", stopSeq: seq });
    expect(slept).toBe(0);
    expect(s.ok && s.value.state).toBe("stopIncomplete");
    expect(r.open()?.kind).toBe("stop");
  });

  it("親が「止めた」と報告しても、作業ツリーのプロセスがないと確かめてから stopped にし、続けて claude rm を依頼する", async () => {
    const r = rig();
    await r.launched();
    const seq = r.ev("a", { type: "stop", mode: "immediate" });
    await r.adapter.stop("a", { mode: "immediate", stopSeq: seq });
    const stopRef = r.open()?.requestRef as string;
    // 残っている: stopped にしない
    r.setProcs(busy);
    await r.call("parent.report", { nodeId: "a", requestRef: stopRef, outcome: "done" });
    expect(r.stateOfA()).toBe("stopIncomplete");
    expect(
      r.log
        .state()
        .inbox.some((i) => i.kind === "stopIncomplete" && (i.summary ?? "").includes("pid 42")),
    ).toBe(true);
    // 確かめられない（lsof が使えない）: stopped にしない
    const seq2 = r.ev("a", { type: "retryStop" });
    await r.adapter.stop("a", { mode: "immediate", stopSeq: seq2 });
    r.setProcs(null);
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "done",
    });
    expect(r.stateOfA()).toBe("stopIncomplete");
    // いない: stopped。未解決の stopIncomplete は解決し、削除の依頼が出る
    const seq3 = r.ev("a", { type: "retryStop" });
    await r.adapter.stop("a", { mode: "immediate", stopSeq: seq3 });
    r.setProcs([]);
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "done",
    });
    expect(r.stateOfA()).toBe("stopped");
    expect(
      r.log.state().inbox.filter((i) => i.kind === "stopIncomplete" && i.resolved === undefined),
    ).toEqual([]);
    const rm = await r.call("parent.request", { nodeId: "a" });
    expect(rm.value).toMatchObject({ kind: "remove", command: "claude rm sess-a" });
  });

  it("claude rm を拒まれたら（未 push の変更など）、消さずに受信箱へ。--discard-unpushed は、人間が破棄を決めたときだけ", async () => {
    const r = rig();
    await r.launched();
    const seq = r.ev("a", { type: "stop", mode: "immediate" });
    await r.adapter.stop("a", { mode: "immediate", stopSeq: seq });
    r.setProcs([]);
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "done",
    });
    const rmRef = r.open()?.requestRef as string;
    const first = await r.call("parent.request", { nodeId: "a" });
    expect(first.value?.command).toBe("claude rm sess-a");
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: rmRef,
      outcome: "failed",
      reason: "unpushed commits",
    });
    const item = r.log.state().inbox.find((i) => i.kind === "failure" && i.nodeId === "a");
    expect(item?.summary).toContain("消していない");
    expect(item?.summary).toContain("unpushed commits");
    expect(r.stateOfA()).toBe("stopped");
    // 人間が破棄を決めた（node.discardDecided）ノードの削除の依頼には、旗が付く
    r.add({ type: "node.discardDecided", payload: { nodeId: "a", noTip: true } });
    r.add({
      type: "node.parentRequested",
      payload: { nodeId: "a", requestRef: "preq-rm-2", kind: "remove", worktree: "/w/a" },
    });
    const again = await r.call("parent.request", { nodeId: "a" });
    expect(again.value?.command).toBe("claude rm sess-a --discard-unpushed");
  });
});

describe("受理のあとの後片付け：削除の依頼で、セッションがもうない（#115）", () => {
  it("止めた時点で一覧から消えていれば、削除の失敗は済んだ扱い。受信箱に「うまくいかなかった」を出さない", async () => {
    const r = rig();
    await r.launched();
    const seq = r.ev("a", { type: "stop", mode: "immediate" });
    await r.adapter.stop("a", { mode: "immediate", stopSeq: seq });
    r.setProcs([]);
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "done",
    });
    const rmRef = r.open()?.requestRef as string;
    const req = await r.call("parent.request", { nodeId: "a" });
    expect(req.value?.next).toContain("一覧にない");
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: rmRef,
      outcome: "failed",
      reason: "Error: session sess-a not found",
    });
    const s = r.log.state();
    expect(s.inbox.some((i) => i.kind === "failure" && i.nodeId === "a")).toBe(false);
    expect(s.inbox.some((i) => (i.summary ?? "").includes("もう一覧になかった"))).toBe(true);
    expect(s.parentRequests.find((x) => x.requestRef === rmRef)?.report?.outcome).toBe("done");
  });

  it("ほかの理由の失敗（未 push の変更など）は、これまでどおり受信箱に出す", () => {
    for (const t of [
      "unpushed commits",
      "claude: command not found",
      "zsh: no such file or directory: claude",
      "Error: config file does not exist",
      "見つからない",
    ])
      expect(SESSION_GONE.test(t), t).toBe(false);
    for (const t of [
      "Error: session sess-a not found",
      "agent sess-a does not exist",
      "セッションが見つからない",
      "一覧にない",
      "claude agents --json の一覧にもない",
    ])
      expect(SESSION_GONE.test(t), t).toBe(true);
  });
});

describe("見張り", () => {
  const spec = { stallMs: 30 * 60_000, unreadMs: 30 * 60_000 };

  it("報告も道具の使用の記録もない子を、止まっているかもしれないとして 1 回だけ受信箱に出す。フックが来れば数え直す", async () => {
    const r = rig();
    await r.launched();
    const at = (min: number) => Date.parse(T0) + min * 60_000;
    expect(watchFindings(r.log.state(), at(29), spec).stalled).toEqual([]);
    const f = watchFindings(r.log.state(), at(31), spec);
    expect(f.stalled.map((x) => x.nodeId)).toEqual(["a"]);
    expect(recordWatchFindings(r.log, () => T0, f, spec)).toBe(1);
    expect(
      recordWatchFindings(r.log, () => T0, watchFindings(r.log.state(), at(40), spec), spec),
    ).toBe(0);
    expect(
      r.log.state().inbox.some((i) => (i.summary ?? "").includes("止まっているかもしれない")),
    ).toBe(true);
    // 画面のための鍵と値も載る（#140。画面が言語を選んで文にする）
    expect(r.log.state().inbox.find((i) => i.msg?.key === "stall")?.msg).toEqual({
      key: "stall",
      args: { node: "a", minutes: 30 },
    });
    // 道具の使用（フック）があれば止まっていない
    expect(watchFindings(r.log.state(), at(50), spec, () => at(45)).stalled).toEqual([]);
    // 判断待ちは出さない
    r.ev("a", { type: "requestDecision" });
    expect(watchFindings(r.log.state(), at(90), spec).stalled).toEqual([]);
  });

  it("範囲の頼みの判定を待っているだけの子には、止まっているかもを出さない（#115）", async () => {
    const r = rig();
    await r.launched();
    const at = (min: number) => Date.parse(T0) + min * 60_000;
    r.add({
      type: "scope.extensionRequested",
      payload: {
        extensionId: "x1",
        nodeId: "a",
        reason: "テストを足したい",
        target: { kind: "write", value: "src/x.ts" },
      },
    });
    expect(watchFindings(r.log.state(), at(90), spec).stalled).toEqual([]);
    // 人が判定した時刻も「最後の動き」に入る（判定した直後には出さない）
    const s0 = r.log.state();
    const decided = {
      ...s0,
      extensions: s0.extensions.map((x) => ({
        ...x,
        status: "approved" as const,
        decidedAt: new Date(at(80)).toISOString(),
      })),
    };
    expect(watchFindings(decided, at(100), spec).stalled).toEqual([]);
    expect(watchFindings(decided, at(111), spec).stalled.map((x) => x.nodeId)).toEqual(["a"]);
  });

  it("同じ子の未解決の止まっているかもは 1 件だけ（#115）。知らせのあとに子が動いたら、古い知らせは解決済みにする（#136）", async () => {
    const r = rig();
    await r.launched();
    const at = (min: number) => Date.parse(T0) + min * 60_000;
    const stalls = () =>
      r.log.state().inbox.filter((i) => (i.summary ?? "").includes("止まっているかもしれない"));
    const open = () => stalls().filter((i) => i.resolved === undefined);
    expect(
      recordWatchFindings(r.log, () => T0, watchFindings(r.log.state(), at(31), spec), spec),
    ).toBe(1);
    // まだ止まったまま: 同じ知らせのまま（並べない）
    expect(
      recordWatchFindings(r.log, () => T0, watchFindings(r.log.state(), at(50), spec), spec),
    ).toBe(0);
    expect(open()).toHaveLength(1);
    // フックで最後の動きが進み（知らせのあと）、そのあとまた止まった: 古い知らせは解決し、新しい知らせを 1 件だけ出す
    const later = watchFindings(r.log.state(), at(100), spec, () => at(60));
    expect(later.stalled.map((x) => x.nodeId)).toEqual(["a"]);
    expect(later.resolvedStalls).toHaveLength(1);
    expect(recordWatchFindings(r.log, () => T0, later, spec)).toBe(1);
    expect(stalls()).toHaveLength(2);
    expect(open()).toHaveLength(1);
  });

  it("子が動いたあと・終わったあとは、止まっているかもの知らせを解決済みにする（#136）", async () => {
    const r = rig();
    await r.launched();
    const at = (min: number) => Date.parse(T0) + min * 60_000;
    const open = () =>
      r.log
        .state()
        .inbox.filter(
          (i) => (i.summary ?? "").includes("止まっているかもしれない") && i.resolved === undefined,
        );
    recordWatchFindings(r.log, () => T0, watchFindings(r.log.state(), at(31), spec), spec);
    expect(open()).toHaveLength(1);
    // フックで子が動いた（まだ止まりの時間を超えていない）: 知らせは解決し、新しい知らせは出さない
    const moved = watchFindings(r.log.state(), at(40), spec, () => at(35));
    expect(moved.stalled).toEqual([]);
    expect(recordWatchFindings(r.log, () => T0, moved, spec)).toBe(0);
    expect(open()).toHaveLength(0);
  });

  it("子が判断の答えを待っているあいだは、止まっているかもの知らせを解決済みにする（#136）", async () => {
    const r = rig();
    await r.launched();
    const at = (min: number) => Date.parse(T0) + min * 60_000;
    const open = () =>
      r.log
        .state()
        .inbox.filter(
          (i) => (i.summary ?? "").includes("止まっているかもしれない") && i.resolved === undefined,
        );
    recordWatchFindings(r.log, () => T0, watchFindings(r.log.state(), at(31), spec), spec);
    expect(open()).toHaveLength(1);
    r.add({
      type: "decision.requested",
      payload: { decisionId: "d1", nodeId: "a", question: "どちらにする？" },
    } as never);
    const f = watchFindings(r.log.state(), at(40), spec);
    expect(f.resolvedStalls).toHaveLength(1);
    recordWatchFindings(r.log, () => T0, f, spec);
    expect(open()).toHaveLength(0);
  });

  it("子が done になったら、止まっているかもの知らせを解決済みにし、新しく出さない（#136）", async () => {
    const r = rig();
    await r.launched();
    const at = (min: number) => Date.parse(T0) + min * 60_000;
    const open = () =>
      r.log
        .state()
        .inbox.filter(
          (i) => (i.summary ?? "").includes("止まっているかもしれない") && i.resolved === undefined,
        );
    recordWatchFindings(r.log, () => T0, watchFindings(r.log.state(), at(31), spec), spec);
    expect(open()).toHaveLength(1);
    r.ev("a", { type: "reportDone" });
    const f = watchFindings(r.log.state(), at(200), spec);
    expect(f.stalled).toEqual([]);
    recordWatchFindings(r.log, () => T0, f, spec);
    expect(open()).toHaveLength(0);
  });

  it("子が受け取らないまま所定の時間を超えた指示を、指示ごとに 1 回だけ受信箱に出す（FR_009）", async () => {
    const r = rig();
    await r.launched();
    const seq = r.add({ type: "node.instructed", payload: { nodeId: "a", text: "続けて" } });
    const later = Date.parse(T0) + 31 * 60_000;
    const f = watchFindings(r.log.state(), later, spec);
    expect(f.unread).toEqual([{ nodeId: "a", seq }]);
    expect(recordWatchFindings(r.log, () => T0, f, spec)).toBeGreaterThan(0);
    expect(
      recordWatchFindings(r.log, () => T0, watchFindings(r.log.state(), later, spec), spec),
    ).toBe(0);
    // 受け取ったら出さない
    r.add({ type: "node.instructionDelivered", payload: { instructedSeq: seq } });
    expect(watchFindings(r.log.state(), later, spec).unread).toEqual([]);
  });

  it("起動の報告から所定の時間を超えても紐付けていない子を、子ごとに 1 回だけ受信箱に出す", async () => {
    const r = rig();
    await r.launched();
    const s3 = { ...spec, unboundMs: 3 * 60_000 };
    const at = (min: number) => Date.parse(T0) + min * 60_000;
    expect(watchFindings(r.log.state(), at(2), s3).unbound).toEqual([]);
    const f = watchFindings(r.log.state(), at(4), s3);
    expect(f.unbound).toEqual([{ nodeId: "a" }]);
    expect(recordWatchFindings(r.log, () => T0, f, s3)).toBe(1);
    expect(recordWatchFindings(r.log, () => T0, watchFindings(r.log.state(), at(10), s3), s3)).toBe(
      0,
    );
    const item = r.log.state().inbox.find((i) => (i.summary ?? "").includes("紐付けていない"));
    expect(item?.summary).toContain("--plugin-dir");
    expect(item?.summary).toContain("/touryou:setup");
    expect(item?.kind).toBe("failure");
    // 項目の nodeId は子。知らせの宛先決めで、親（root）の購読の、子の親のセッションに流れる
    expect(item?.nodeId).toBe("a");
    const feed = nodeFeedOf(r.log.state(), "root", 0).filter((e) => e.seq === item?.seq);
    expect(feed).toEqual([expect.objectContaining({ kind: "child", childId: "a", target: S1 })]);
    // 数え直し（新しい数の表）でも、記録の ID で 2 回出ない
    expect(recordWatchFindings(r.log, () => T0, f, s3, new Map())).toBe(0);
    // 紐付けた子は出さない
    expect(watchFindings(r.log.state(), at(10), s3, undefined, () => true).unbound).toEqual([]);
    r.add({ type: "node.sessionBound", payload: { nodeId: "a", sessionId: "sess-a" } });
    expect(watchFindings(r.log.state(), at(10), s3).unbound).toEqual([]);
  });

  it("報告（system の failure など）がある子でも、紐付けていなければ出す", async () => {
    const r = rig();
    await r.launched();
    r.add({
      type: "report.added",
      payload: { reportId: "rep-sys-1", nodeId: "a", kind: "failure", text: "配送に失敗" },
    });
    expect(r.log.state().reports.some((x) => x.nodeId === "a")).toBe(true);
    const s3 = { ...spec, unboundMs: 3 * 60_000 };
    expect(watchFindings(r.log.state(), Date.parse(T0) + 4 * 60_000, s3).unbound).toEqual([
      { nodeId: "a" },
    ]);
  });

  it("daemon の起動より前に起動の報告があった子は出さない（紐付けをやり直して、に任せる）", async () => {
    const r = rig();
    await r.launched();
    const at = (min: number) => Date.parse(T0) + min * 60_000;
    const s3 = { ...spec, unboundMs: 3 * 60_000, sinceMs: at(1) };
    expect(watchFindings(r.log.state(), at(60), s3, undefined, () => false).unbound).toEqual([]);
  });

  it("親のない子には出さず、onSkip でログに残す", () => {
    const r = rig();
    const skipped: string[] = [];
    const n = recordWatchFindings(
      r.log,
      () => T0,
      { stalled: [], unread: [], unbound: [{ nodeId: "root" }] },
      { ...spec, unboundMs: 60_000 },
      new Map(),
      Date.parse(T0),
      (id) => skipped.push(id),
    );
    expect(n).toBe(0);
    expect(skipped).toEqual(["root"]);
  });

  it("起動の報告がない子・報告が failed の子は、紐付けがなくても出さない", async () => {
    const s3 = { ...spec, unboundMs: 3 * 60_000 };
    const later = Date.parse(T0) + 60 * 60_000;
    const r = rig();
    await r.adapter.start({ nodeId: "a", worktreePath: "/w/a", scope: SCOPE, instruction: "x" });
    expect(watchFindings(r.log.state(), later, s3).unbound).toEqual([]);
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "failed",
      reason: "x",
    });
    expect(watchFindings(r.log.state(), later, s3).unbound).toEqual([]);
  });

  it("親が起動を報告していない子（Desktop・まだ起動していない）は見張らない", () => {
    const r = rig();
    expect(watchFindings(r.log.state(), Date.parse(T0) + 999 * 60_000, spec).stalled).toEqual([]);
    expect(
      watchFindings(r.log.state(), Date.parse(T0) + 999 * 60_000, { ...spec, unboundMs: 60_000 })
        .unbound,
    ).toEqual([]);
  });
});

describe("削除の依頼の作り直し・最後の動きの下限・コマンドの確かめ", () => {
  it("削除が拒まれたあと、人間が破棄を決めたら、旗つきの削除の依頼を作り直す（二度は作らない）", async () => {
    const { discardRemoveBodies } = await import(
      "../../src/api/handlers/parent-request-handlers.js"
    );
    const r = rig();
    await r.launched();
    const seq = r.ev("a", { type: "stop", mode: "immediate" });
    await r.adapter.stop("a", { mode: "immediate", stopSeq: seq });
    r.setProcs([]);
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "done",
    });
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "failed",
      reason: "unpushed",
    });
    // 破棄の判断の前は作らない
    expect(discardRemoveBodies(r.log.state(), "a")).toEqual([]);
    r.add({ type: "node.discardDecided", payload: { nodeId: "a", noTip: true } });
    const bodies = discardRemoveBodies(r.log.state(), "a");
    expect(bodies).toHaveLength(2);
    for (const b of bodies) r.add(b);
    const again = await r.call("parent.request", { nodeId: "a" });
    expect(again.value?.command).toBe("claude rm sess-a --discard-unpushed");
    expect(discardRemoveBodies(r.log.state(), "a")).toEqual([]);
  });

  it("daemon の起動の時刻を「最後の動き」の下限にする（再起動の直後に、止まっているかもしれないと出さない）", async () => {
    const r = rig();
    await r.launched();
    const at = (min: number) => Date.parse(T0) + min * 60_000;
    const spec = { stallMs: 30 * 60_000, unreadMs: 30 * 60_000 };
    expect(watchFindings(r.log.state(), at(100), spec).stalled).toHaveLength(1);
    expect(watchFindings(r.log.state(), at(100), { ...spec, sinceMs: at(90) }).stalled).toEqual([]);
    expect(
      watchFindings(r.log.state(), at(121), { ...spec, sinceMs: at(90) }).stalled,
    ).toHaveLength(1);
  });

  it("claude stop・rm の next に、claude agents --json で id を確かめてから実行することを書く", async () => {
    const r = rig();
    await r.launched();
    const seq = r.ev("a", { type: "stop", mode: "immediate" });
    await r.adapter.stop("a", { mode: "immediate", stopSeq: seq });
    const q = await r.call("parent.request", { nodeId: "a" });
    expect(q.value?.next).toContain("claude agents --json");
    expect(q.value?.next).toContain("名前が a");
  });

  it("起動の報告に sessionRef がないとき、親にコマンドを組ませず、調べた id の報告のあとに command つきの依頼を作る", async () => {
    const r = rig();
    await r.adapter.start({ nodeId: "a", worktreePath: "/w/a", scope: SCOPE, instruction: "x" });
    const launchRef = r.log.state().parentRequests[0]?.requestRef as string;
    await r.call("parent.report", { nodeId: "a", requestRef: launchRef, outcome: "done" });
    const seq = r.ev("a", { type: "stop", mode: "immediate" });
    await r.adapter.stop("a", { mode: "immediate", stopSeq: seq });
    const q = (await r.call("parent.request", { nodeId: "a" })) as unknown as {
      ok: boolean;
      error: { code: string; cause: string; nextActions: string[] };
    };
    expect(q.ok).toBe(false);
    expect(q.error.code).toBe("noSessionRef");
    const text = [q.error.cause, ...q.error.nextActions].join("\n");
    expect(text).not.toMatch(/claude (stop|rm) </);
    expect(text).toContain("sessionRef");
    const stopRef = r.open()?.requestRef as string;
    const rep = await r.call("parent.report", {
      nodeId: "a",
      requestRef: stopRef,
      outcome: "done",
      sessionRef: "sess-a",
    });
    expect(rep.ok).toBe(true);
    // まだ止めていないので、stopped にはしない
    expect(r.stateOfA()).toBe("stopIncomplete");
    const again = r.open();
    expect(again?.kind).toBe("stop");
    expect(again?.requestRef).not.toBe(stopRef);
    const q2 = await r.call("parent.request", { nodeId: "a" });
    expect(q2.value).toMatchObject({ kind: "stop", command: "claude stop sess-a" });
  });

  /** 起動の報告に sessionRef を付けずに起動し、即時の停止で claude stop の依頼まで進める。 */
  const noRefStop = async (r: ReturnType<typeof rig>) => {
    await r.adapter.start({ nodeId: "a", worktreePath: "/w/a", scope: SCOPE, instruction: "x" });
    const launchRef = r.log.state().parentRequests[0]?.requestRef as string;
    await r.call("parent.report", { nodeId: "a", requestRef: launchRef, outcome: "done" });
    const seq = r.ev("a", { type: "stop", mode: "immediate" });
    await r.adapter.stop("a", { mode: "immediate", stopSeq: seq });
  };

  it("形の悪い sessionRef では作り直さない（invalidParams）", async () => {
    const r = rig();
    await noRefStop(r);
    const before = r.log.state().parentRequests.length;
    const rep = await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "done",
      sessionRef: "bad ref; rm -rf",
    });
    expect(rep.ok).toBe(false);
    expect(rep.error?.code).toBe("invalidParams");
    expect(r.log.state().parentRequests.length).toBe(before);
  });

  it("作り直しのあと、さらに done と sessionRef が来ても、3 つ目の依頼はできない", async () => {
    const r = rig();
    await noRefStop(r);
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "done",
      sessionRef: "sess-a",
    });
    const stops = () => r.log.state().parentRequests.filter((x) => x.kind === "stop").length;
    expect(stops()).toBe(2);
    r.setProcs(busy);
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "done",
      sessionRef: "sess-a",
    });
    expect(stops()).toBe(2);
    expect(r.stateOfA()).toBe("stopIncomplete");
  });

  it("削除の経路も、参照なし → 調べた id で作り直し → claude rm <id>。破棄済みなら --discard-unpushed つき", async () => {
    const r = rig();
    await noRefStop(r);
    r.setProcs([]);
    // 親が別の手段で止めたと報告（参照なしのまま）→ stopped と削除の依頼
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "done",
    });
    expect(r.stateOfA()).toBe("stopped");
    expect(r.open()?.kind).toBe("remove");
    const q = await r.call("parent.request", { nodeId: "a" });
    expect(q.error?.code).toBe("noSessionRef");
    r.add({ type: "node.discardDecided", payload: { nodeId: "a", noTip: true } });
    await r.call("parent.report", {
      nodeId: "a",
      requestRef: r.open()?.requestRef as string,
      outcome: "done",
      sessionRef: "sess-a",
    });
    expect(r.open()?.kind).toBe("remove");
    const rm = await r.call("parent.request", { nodeId: "a" });
    expect(rm.value?.command).toBe("claude rm sess-a --discard-unpushed");
  });

  it("参照があるノードの停止の報告に違う sessionRef が付いたら拒み、続く rm の id は変わらない", async () => {
    const r = rig();
    await r.launched();
    const seq = r.ev("a", { type: "stop", mode: "immediate" });
    await r.adapter.stop("a", { mode: "immediate", stopSeq: seq });
    r.setProcs([]);
    const stopRef = r.open()?.requestRef as string;
    const bad = await r.call("parent.report", {
      nodeId: "a",
      requestRef: stopRef,
      outcome: "done",
      sessionRef: "sess-other",
    });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("invalidParams");
    // 同じ id なら受ける
    const good = await r.call("parent.report", {
      nodeId: "a",
      requestRef: stopRef,
      outcome: "done",
      sessionRef: "sess-a",
    });
    expect(good.ok).toBe(true);
    const rm = await r.call("parent.request", { nodeId: "a" });
    expect(rm.value?.command).toBe("claude rm sess-a");
  });

  it("見張りの知らせは、ノードごとに 24 時間で上限まで。超えたら 1 回だけ「多すぎるので止めた」", async () => {
    const r = rig();
    await r.launched();
    const spec = { stallMs: 60_000, unreadMs: 60_000, perNodePerDay: 3 };
    const counts = new Map();
    let total = 0;
    for (let i = 0; i < 6; i++) {
      r.add({ type: "node.instructed", payload: { nodeId: "a", text: `x${i}` } });
      const now = Date.parse(T0) + (10 + i) * 60_000;
      total += recordWatchFindings(
        r.log,
        () => T0,
        watchFindings(r.log.state(), now, spec),
        spec,
        counts,
        now,
      );
    }
    expect(total).toBe(4); // 3 件 + 「多すぎる」1 件
    expect(r.log.state().inbox.filter((i) => (i.summary ?? "").includes("多すぎる"))).toHaveLength(
      1,
    );
  });
});
