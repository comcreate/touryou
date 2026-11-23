/**
 * 子の受信箱（`child.inbox`）: ブリーフといまだ受け取っていない指示を、自分のノードの分だけ返す。受け取った印
 * （`deliveredSeq`）は、mcp が応答を受け取ったあとの `ackThrough` で付き、Stop のフックの未読（`pendingForChild`）と同じ印で数える。
 */
import {
  type EventBody,
  lastActivityMs,
  type NodeEvent,
  unquoteInstructionText,
} from "@touryou/core";
import { instructionEcho } from "@touryou/core/echo";
import { describe, expect, it } from "vitest";
import {
  createChildInboxHandlers,
  instructionsFor,
  readsOnlyPrefaces,
} from "../../src/api/handlers/child-inbox-handlers.js";
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

  describe("指示の復唱（#261）", () => {
    const echoOf = (text: string) => instructionEcho(text);

    it("一致する復唱は、配送の記録に載る（受領）。受信箱には何も出さない。復唱は新しい動きの時刻を持たない", () => {
      const r = rig();
      const s1 = r.instruct("a", "x を直す\n  字下げ");
      const got = r.call("a");
      // mcp は、応答の引用（> ）を外した本文から復唱を求める。元の本文と同じ値になる
      const quoted = got.ok ? (got.value.instructions[0]?.quotedText ?? "") : "";
      const echo = echoOf(unquoteInstructionText(quoted));
      expect(echo).toBe(echoOf("x を直す\n  字下げ"));
      r.call("a", { ackThrough: s1, echoes: { [String(s1)]: echo } });
      const rec = r.log.state().instructions.find((i) => i.seq === s1);
      expect(rec?.echo).toBe(echo);
      expect(rec?.deliveredAt).toBeDefined();
      expect(r.log.state().inbox).toEqual([]);
      // 最後の動き（#195）は、配送の時刻だけを数える。復唱があっても、ないときと同じ時刻
      const t = Date.parse("2026-11-12T00:00:00Z");
      expect(lastActivityMs(r.log.state(), "a")).toBe(t);
    });

    it("食い違う復唱は、受信箱に「食い違い」を出す（failure。自動の再送はしない。指示の記録は増えない）", () => {
      const r = rig();
      const s1 = r.instruct("a", "x を直す");
      const before = r.log.state().instructions.length;
      r.call("a", { ackThrough: s1, echoes: { [String(s1)]: echoOf("y を直す") } });
      const items = r.log.state().inbox;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: "failure", nodeId: "a", msg: { key: "echoMismatch" } });
      expect(items[0]?.msg?.args).toEqual({ node: "a", seq: s1 });
      // 受信箱の文に、ハッシュ値も本文も出ない
      expect(items[0]?.summary).not.toContain(echoOf("y を直す"));
      expect(items[0]?.summary).not.toContain("x を直す");
      expect(r.log.state().instructions).toHaveLength(before);
      // 付け直しても、同じ知らせを重ねない
      r.call("a", { ackThrough: s1, echoes: { [String(s1)]: echoOf("y を直す") } });
      expect(r.log.state().inbox).toHaveLength(1);
    });

    it("復唱がない呼び出し（古い mcp）は、これまでどおり受け取りだけを記録する。知らせは出さない", () => {
      const r = rig();
      const s1 = r.instruct("a", "x");
      r.call("a", { ackThrough: s1 });
      const rec = r.log.state().instructions.find((i) => i.seq === s1);
      expect(rec?.deliveredSeq).toEqual(expect.any(Number));
      expect(rec?.echo).toBeUndefined();
      expect(r.log.state().inbox).toEqual([]);
    });

    it("復唱は、ackThrough の対象の指示ごとに照合する（ほかのノードの指示の番号は使えない）", () => {
      const r = rig();
      const sa = r.instruct("a", "a へ");
      const sb = r.instruct("b", "b へ");
      // a が、b の指示の番号に復唱を付けても、b の指示の記録は変わらない
      r.call("a", { ackThrough: sb, echoes: { [String(sb)]: echoOf("b へ") } });
      expect(r.log.state().instructions.find((i) => i.seq === sb)?.echo).toBeUndefined();
      expect(r.log.state().instructions.find((i) => i.seq === sa)?.deliveredSeq).toEqual(
        expect.any(Number),
      );
    });

    it("復唱の送信は、前置きだけの呼び出しの扱い（#189。時計を延ばさない）を変えない", () => {
      const r = rig();
      const s1 = r.instruct("a", "ふつうの指示");
      const mine = instructionsFor(r.log.state(), "a");
      // 前置きでないふつうの指示の受け取りは、復唱の有無にかかわらず「前置きだけ」ではない（時計を延ばす）
      expect(readsOnlyPrefaces(mine, { ackThrough: s1 })).toBe(false);
      expect(
        readsOnlyPrefaces(mine, { ackThrough: s1, echoes: { [String(s1)]: echoOf("ふつうの指示") } }),
      ).toBe(false);
    });

    it("窓口の検査: echoes は ackThrough と一緒のときだけ。キーは番号、値は小文字の 16 進数 16 桁、64 件まで", () => {
      const ok = echoOf("x");
      expect(validateParams("child.inbox", { ackThrough: 3, echoes: { "3": ok } }).ok).toBe(true);
      expect(validateParams("child.inbox", { echoes: { "3": ok } }).ok).toBe(false);
      expect(validateParams("child.inbox", { ackThrough: 3, echoes: { x: ok } }).ok).toBe(false);
      expect(validateParams("child.inbox", { ackThrough: 3, echoes: { "03": ok } }).ok).toBe(false);
      expect(validateParams("child.inbox", { ackThrough: 3, echoes: { "3": "短い" } }).ok).toBe(false);
      expect(validateParams("child.inbox", { ackThrough: 3, echoes: { "3": ok.toUpperCase() } }).ok).toBe(
        false,
      );
      expect(validateParams("child.inbox", { ackThrough: 3, echoes: [ok] }).ok).toBe(false);
      const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), ok]));
      expect(validateParams("child.inbox", { ackThrough: 99, echoes: many }).ok).toBe(false);
    });
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
