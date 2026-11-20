/**
 * 子の受信箱（`child.inbox`）: ブリーフといまだ受け取っていない指示を、自分のノードの分だけ返す。受け取った印
 * （`deliveredSeq`）は、mcp が応答を受け取ったあとの `ackThrough` で付き、Stop のフックの未読（`pendingForChild`）と同じ印で数える。
 */
import type { EventBody, NodeEvent } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createChildInboxHandlers } from "../../src/api/handlers/child-inbox-handlers.js";
import { pendingForChild, stopOutcome } from "../../src/api/handlers/hook-handlers.js";
import type { HandlerRequest } from "../../src/api/server.js";
import { validateParams } from "../../src/api/validate.js";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";

const SCOPE = { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] };
let n = 0;

const rig = () => {
  const store = createMemoryStore();
  const open = () => {
    const o = EventLog.open(store.open(), { clock: () => "2026-11-12T00:00:00Z" });
    if (!o.ok) throw new Error(o.error.code);
    return o.value;
  };
  let log = open();
  const add = (body: EventBody, actor: { system: true } | { human: true } = { system: true }) => {
    const r = log.append({ requestId: `seed-${++n}`, actor, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
    return r.value.event.seq;
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  ev("root", { type: "start" });
  for (const id of ["a", "b"]) {
    add({
      type: "node.created",
      payload: {
        nodeId: id,
        role: "implement",
        parentId: "root",
        dependsOn: [],
        objective: `${id} を直す`,
        acceptanceCriteria: ["テストが通る"],
        scope: SCOPE,
      },
    });
    ev(id, { type: "start" });
  }
  const instruct = (nodeId: string, text: string) =>
    add({ type: "node.instructed", payload: { nodeId, text } }, { human: true });
  const call = (nodeId: string, params: HandlerRequest<"child.inbox">["params"] = {}) =>
    createChildInboxHandlers({ log, clock: () => "2026-11-12T00:00:00Z" })["child.inbox"]({
      requestId: `ci-${++n}`,
      operation: "child.inbox",
      role: "child",
      caller: { nodeId },
      params,
    } as unknown as HandlerRequest<"child.inbox">);
  const restart = () => {
    log = open();
  };
  return {
    get log() {
      return log;
    },
    instruct,
    call,
    restart,
  };
};

describe("child.inbox", () => {
  it("ブリーフはいつも返る（未読がなくても）。指示の本文は引用の形", () => {
    const r = rig();
    const empty = r.call("a");
    expect(empty.ok && empty.value.brief).toMatchObject({
      nodeId: "a",
      objective: "> a を直す",
      acceptanceCriteria: ["> テストが通る"],
      scope: { writableLocations: ["> src"], forbiddenLocations: ["> .git"], allowedCommands: [] },
      dependsOn: [],
    });
    expect(empty.ok && empty.value.instructions).toEqual([]);
    r.instruct("a", "1 行目\n2 行目");
    const got = r.call("a");
    expect(got.ok && got.value.instructions.map((i) => i.quotedText)).toEqual([
      "> 1 行目\n> 2 行目",
    ]);
  });

  it("自分のノードの指示だけを返す（ほかのノードの指示は返らない）", () => {
    const r = rig();
    r.instruct("a", "a へ");
    r.instruct("b", "b へ");
    const got = r.call("a");
    expect(got.ok && got.value.instructions.map((i) => i.quotedText)).toEqual(["> a へ"]);
    expect(got.ok && got.value.brief.nodeId).toBe("a");
  });

  it("受け取った印は ackThrough で付く。付いたら Stop のフックの未読がなくなり、allow になる", () => {
    const r = rig();
    const s1 = r.instruct("a", "続けて");
    expect(pendingForChild(r.log.state(), "a")).toBe(1);
    expect(stopOutcome(r.log.state(), "a", false).decision).toBe("continue");
    const got = r.call("a");
    expect(got.ok && got.value.instructions.map((i) => i.seq)).toEqual([s1]);
    // 応答を返しただけでは、印は付かない
    expect(pendingForChild(r.log.state(), "a")).toBe(1);
    const ack = r.call("a", { ackThrough: s1 });
    expect(ack.ok && ack.value.instructions).toEqual([]);
    expect(pendingForChild(r.log.state(), "a")).toBe(0);
    expect(stopOutcome(r.log.state(), "a", false).decision).toBe("allow");
    // 未読がなくなった。all: true なら読み直せる（印は変えない）
    const none = r.call("a");
    expect(none.ok && none.value.instructions).toEqual([]);
    const all = r.call("a", { all: true });
    expect(all.ok && all.value.instructions.map((i) => [i.seq, i.received])).toEqual([[s1, true]]);
  });

  it("応答が途中で切れた（ackThrough が来ない）ら、次の呼び出しで同じものを返す。ackThrough は付け直しても害がない", () => {
    const r = rig();
    const s1 = r.instruct("a", "x");
    const s2 = r.instruct("a", "y");
    r.call("a"); // 切れた
    const again = r.call("a");
    expect(again.ok && again.value.instructions.map((i) => i.seq)).toEqual([s1, s2]);
    // 一部だけ受け取った（s1 まで）
    r.call("a", { ackThrough: s1 });
    r.call("a", { ackThrough: s1 });
    const rest = r.call("a");
    expect(rest.ok && rest.value.instructions.map((i) => i.seq)).toEqual([s2]);
  });

  it("daemon の再起動のあとも、受け取った印は記録から戻る", () => {
    const r = rig();
    const s1 = r.instruct("a", "x");
    const s2 = r.instruct("a", "y");
    r.call("a", { ackThrough: s1 });
    r.restart();
    expect(r.log.state().instructions.find((i) => i.seq === s1)?.deliveredSeq).toEqual(
      expect.any(Number),
    );
    const got = r.call("a");
    expect(got.ok && got.value.instructions.map((i) => i.seq)).toEqual([s2]);
    expect(pendingForChild(r.log.state(), "a")).toBe(1);
  });

  it("子のロールの、呼んだノードの分だけ（統合のロールからは使えない）。窓口の検査", () => {
    const r = rig();
    const h = createChildInboxHandlers({ log: r.log, clock: () => "t" })["child.inbox"];
    const asIntegrator = h({
      requestId: "x",
      operation: "child.inbox",
      role: "integrator",
      caller: { nodeId: "root" },
      params: {},
    } as unknown as HandlerRequest<"child.inbox">);
    expect(asIntegrator.ok).toBe(false);
    expect(validateParams("child.inbox", { all: true }).ok).toBe(true);
    expect(validateParams("child.inbox", { ackThrough: 3 }).ok).toBe(true);
    expect(validateParams("child.inbox", { ackThrough: -1 }).ok).toBe(false);
    expect(validateParams("child.inbox", { nodeId: "b" }).ok).toBe(false);
  });

  it("inbox.fetch の ackItemIds（#102）は、項目の ID の配列（100 件まで）だけ受ける", () => {
    expect(validateParams("inbox.fetch", {}).ok).toBe(true);
    expect(validateParams("inbox.fetch", { sinceSeq: 3 }).ok).toBe(true);
    expect(validateParams("inbox.fetch", { ackItemIds: ["i1", "i2"] }).ok).toBe(true);
    expect(validateParams("inbox.fetch", { sinceSeq: 3, ackItemIds: [] }).ok).toBe(true);
    expect(validateParams("inbox.fetch", { ackItemIds: "i1" }).ok).toBe(false);
    expect(validateParams("inbox.fetch", { ackItemIds: [1] }).ok).toBe(false);
    expect(validateParams("inbox.fetch", { ackItemIds: ["a b"] }).ok).toBe(false);
    expect(
      validateParams("inbox.fetch", { ackItemIds: Array.from({ length: 101 }, (_, i) => `i${i}`) })
        .ok,
    ).toBe(false);
    expect(validateParams("inbox.fetch", { ackThrough: 3 }).ok).toBe(false);
  });
});
