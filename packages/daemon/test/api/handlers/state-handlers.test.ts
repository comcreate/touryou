import { type EventBody, failure, isSafeId, type NodeEvent, stateOf } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createCredentialStore } from "../../../src/api/credentials.js";
import { createInstructionDelivery } from "../../../src/api/handlers/instruction-delivery.js";
import { createStateHandlers } from "../../../src/api/handlers/state-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { isCliChildOf } from "../../../src/compose.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";

const SYS = { system: true } as const;
let n = 0;
const clock = (): string => "2026-10-20T00:00:00Z";

/** root ─ m1 ─ a(running) / root ─ m2 ─ b(running) */
const rig = () => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const created = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
  const start = (nodeId: string) =>
    add({ type: "node.stateChanged", payload: { nodeId, event: { type: "start" } } });
  created("root", "integrator", null);
  start("root");
  created("m1", "integrator", "root");
  start("m1");
  created("a", "implement", "m1");
  start("a");
  created("m2", "integrator", "root");
  start("m2");
  created("b", "implement", "m2");
  start("b");
  const h = createStateHandlers({ log, clock });
  const req = <Op extends keyof typeof h>(
    operation: Op,
    params: Record<string, unknown>,
    who: { role: "child" | "integrator"; nodeId: string } | "human",
    requestId = `q-${++n}`,
  ) =>
    ({
      requestId,
      operation,
      role: who === "human" ? "human" : who.role,
      ...(who === "human" ? {} : { caller: { nodeId: who.nodeId } }),
      params,
    }) as unknown as HandlerRequest<never>;
  const call = async (op: keyof typeof h, r: HandlerRequest<never>) =>
    // biome-ignore lint/suspicious/noExplicitAny: 操作ごとの型は呼び出し側で保証
    (await (h[op] as any)(r)) as {
      ok: boolean;
      // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
      value?: any;
      error?: { code: string; cause: string };
    };
  return { log, h, req, call, state: () => log.state() };
};
const EVIDENCE = [{ criterion: "テスト", evidence: "通過" }];
const A = { role: "child", nodeId: "a" } as const;
const M1 = { role: "integrator", nodeId: "m1" } as const;
const ROOT = { role: "integrator", nodeId: "root" } as const;

describe("判断の取り下げ（#196）", () => {
  const ask = async (r: ReturnType<typeof rig>): Promise<string> => {
    const res = await r.call(
      "report.decision",
      r.req("report.decision", { question: "どちらにするか", options: ["X", "Y"] }, A),
    );
    expect(res.ok).toBe(true);
    return res.value.decisionId as string;
  };

  it("waiting で report.done すると、人の回答待ちと、要らなくなったときの道を文に出して断る", async () => {
    const r = rig();
    await ask(r);
    expect(stateOf(r.state(), "a")).toBe("waiting");
    const res = await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalidTransition");
    expect(res.error?.cause).toContain("判断への回答待ち");
    expect(res.error?.cause).toContain("取り下げる");
  });

  it("取り下げると、判断が閉じ、受信箱の判断の項目が消え、running に戻り、親に知らせが届く。そのあと完了を報告できる", async () => {
    const r = rig();
    const decisionId = await ask(r);
    const res = await r.call(
      "decision.withdraw",
      r.req("decision.withdraw", { decisionId }, A, "w-1"),
    );
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ withdrawn: true, resumed: true });
    expect(stateOf(r.state(), "a")).toBe("running");
    const d = r.state().decisions.find((x) => x.decisionId === decisionId);
    expect(d?.status).toBe("closed");
    expect(d?.closedReason).toBe("withdrawn");
    const decisionItem = r.state().inbox.find((i) => i.kind === "decision" && i.ref === decisionId);
    expect(decisionItem?.resolved).toBeDefined();
    expect(r.state().inbox.some((i) => i.kind === "info" && i.nodeId === "a")).toBe(true);
    // 再送は成功のまま（もう一度は書かない）
    const again = await r.call(
      "decision.withdraw",
      r.req("decision.withdraw", { decisionId }, A, "w-1"),
    );
    expect(again.ok).toBe(true);
    const done = await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    expect(done.ok).toBe(true);
    expect(stateOf(r.state(), "a")).toBe("done");
  });

  it("取り下げた判断に人が答えても、decisionClosed で断る", async () => {
    const r = rig();
    const decisionId = await ask(r);
    await r.call("decision.withdraw", r.req("decision.withdraw", { decisionId }, A));
    const ans = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId, choice: "X" }, "human"),
    );
    expect(ans.ok).toBe(false);
    expect(ans.error?.code).toBe("decisionClosed");
  });

  it("ほかのノードの判断・回答済みの判断は取り下げられない", async () => {
    const r = rig();
    const decisionId = await ask(r);
    const other = await r.call(
      "decision.withdraw",
      r.req("decision.withdraw", { decisionId }, { role: "child", nodeId: "b" }),
    );
    expect(other.ok).toBe(false);
    expect(other.error?.code).toBe("notFound");
    await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId, choice: "X" }, "human"),
    );
    const late = await r.call("decision.withdraw", r.req("decision.withdraw", { decisionId }, A));
    expect(late.ok).toBe(false);
    expect(late.error?.code).toBe("decisionNotOpen");
  });
});

describe("report.done の報告の文（#149）", () => {
  it("報告にも、受信箱と同じ鍵と値（msg）を載せる。text は日本語の文のまま", async () => {
    const r = rig();
    const res = await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    expect(res.ok).toBe(true);
    const report = r.state().reports.find((x) => x.nodeId === "a" && x.kind === "done");
    expect(report?.text).toBe("完了報告（根拠 1 件）");
    expect(report?.msg).toEqual({ key: "doneReport", args: { count: 1 } });
    const item = r.state().inbox.find((i) => i.nodeId === "a" && i.kind === "done");
    expect(item?.msg).toEqual(report?.msg);
    expect(item?.summary).toBe(report?.text);
  });
});

describe("tree.list（状態から決定的に生成した木の一覧表。呼び出し側の部分木だけ）", () => {
  it("部分木のノードを、作成順に、役割・状態・親・依存つきの表にする", async () => {
    const r = rig();
    const res = await r.call("tree.list", r.req("tree.list", {}, M1));
    expect(res.ok).toBe(true);
    const lines = (res.value.table as string).split("\n");
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("state");
    expect(
      lines.some((l) => l.includes("m1") && l.includes("integrator") && l.includes("running")),
    ).toBe(true);
    expect(lines.some((l) => /\ba\b/.test(l) && l.includes("implement"))).toBe(true);
    expect(res.value.table).not.toContain("m2");
    expect(res.value.table).not.toMatch(/\bb\b/);
  });

  it("呼び出したノード自身の行に、self の印（あなた）を付ける。人間・ほかのノードの行には付けない", async () => {
    const r = rig();
    const rowOf = (table: string, id: string) =>
      table.split("\n").find((l) => l.split("|")[1]?.trim() === id) ?? "";
    const m1 = (await r.call("tree.list", r.req("tree.list", {}, M1))).value.table as string;
    expect(m1.split("\n")[0]).toContain("self");
    expect(rowOf(m1, "m1")).toContain("あなた");
    expect(rowOf(m1, "a")).not.toContain("あなた");
    const root = (await r.call("tree.list", r.req("tree.list", {}, ROOT))).value.table as string;
    expect(rowOf(root, "root")).toContain("あなた");
    expect(rowOf(root, "m1")).not.toContain("あなた");
    const human = (await r.call("tree.list", r.req("tree.list", {}, "human"))).value
      .table as string;
    expect(human).not.toContain("あなた");
  });

  it("根は全体。同じ状態からは同じ表（決定的）", async () => {
    const r = rig();
    const t1 = (await r.call("tree.list", r.req("tree.list", {}, ROOT))).value.table as string;
    const t2 = (await r.call("tree.list", r.req("tree.list", {}, ROOT))).value.table as string;
    expect(t1).toBe(t2);
    for (const id of ["root", "m1", "a", "m2", "b"]) expect(t1).toContain(id);
  });

  it("人間は全ノードを、構造（nodes）でも受け取る（touryou tree）。統合ノードは自分の部分木だけ", async () => {
    const r = rig();
    const human = (await r.call("tree.list", r.req("tree.list", {}, "human"))).value.nodes as {
      id: string;
      parentId: string | null;
      role: string;
    }[];
    expect(human.map((n) => n.id).sort()).toEqual(["a", "b", "m1", "m2", "root"]);
    expect(human.find((n) => n.id === "a")).toMatchObject({ parentId: "m1", role: "implement" });
    const m1 = (await r.call("tree.list", r.req("tree.list", {}, M1))).value.nodes as {
      id: string;
    }[];
    expect(m1.map((n) => n.id).sort()).toEqual(["a", "m1"]);
  });
});

describe("report.*（子 → 親への報告。報告の保存と、受信箱への追加）", () => {
  it("report.progress: 報告を保存し、受信箱に progress の項目（ref つき）を足す", async () => {
    const r = rig();
    const res = await r.call(
      "report.progress",
      r.req("report.progress", { text: "半分終わった" }, A),
    );
    expect(res).toEqual({ ok: true, value: { accepted: true } });
    const s = r.state();
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0]).toMatchObject({
      nodeId: "a",
      kind: "progress",
      text: "半分終わった",
      actor: { nodeId: "a" },
    });
    const item = s.inbox.at(-1);
    expect(item).toMatchObject({ kind: "progress", nodeId: "a", ref: s.reports[0]?.reportId });
    expect(item?.summary).toContain("半分");
    expect(isSafeId(item?.id)).toBe(true);
    expect(isSafeId(s.reports[0]?.reportId)).toBe(true);
    expect(stateOf(s, "a")).toBe("running");
  });

  it("report.outOfScope: info の項目", async () => {
    const r = rig();
    await r.call("report.outOfScope", r.req("report.outOfScope", { text: "別件を見つけた" }, A));
    expect(r.state().reports[0]?.kind).toBe("outOfScope");
    expect(r.state().inbox.at(-1)?.kind).toBe("info");
  });

  it("要約は 1 行にして上限に収める。本文の全文は報告に残る", async () => {
    const r = rig();
    const text = `${"長い".repeat(300)}\n二行目\n\t三行目`;
    await r.call("report.progress", r.req("report.progress", { text }, A));
    const item = r.state().inbox.at(-1);
    expect(item?.summary).not.toContain("\n");
    expect([...(item?.summary ?? "")].length).toBeLessThanOrEqual(200);
    expect(r.state().reports[0]?.text).toBe(text);
  });

  it("report.done: 完了報告（根拠つき）を保存し、done に遷移し、done の項目を足す", async () => {
    const r = rig();
    const evidence = [{ criterion: "テスト", evidence: "pnpm test 通過" }];
    const res = await r.call("report.done", r.req("report.done", { evidence }, A));
    expect(res.ok).toBe(true);
    const s = r.state();
    expect(stateOf(s, "a")).toBe("done");
    expect(s.reports[0]).toMatchObject({ kind: "done", evidence });
    expect(s.inbox.at(-1)).toMatchObject({
      kind: "done",
      nodeId: "a",
      ref: s.reports[0]?.reportId,
    });
  });

  it("動作中でない子の報告は、何も書かずに失敗する（pending・done など）", async () => {
    const r = rig();
    await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    const before = r.state().lastSeq;
    const res = await r.call("report.progress", r.req("report.progress", { text: "x" }, A));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("notActive");
    expect(r.state().lastSeq).toBe(before);
  });

  it("同じ requestId の再試行は、重複して記録しない（冪等）", async () => {
    const r = rig();
    const rq = () => r.req("report.progress", { text: "x" }, A, "same-request");
    const a = await r.call("report.progress", rq());
    const b = await r.call("report.progress", rq());
    expect(a.ok && b.ok).toBe(true);
    expect(r.state().reports).toHaveLength(1);
    expect(r.state().inbox).toHaveLength(1);
  });

  it("report.decision: 判断要求を作り、子を waiting にし、decision の項目（ref は decisionId）を足す", async () => {
    const r = rig();
    const res = await r.call(
      "report.decision",
      r.req("report.decision", { question: "どちら？", options: ["A", "B"] }, A),
    );
    expect(res.ok).toBe(true);
    const s = r.state();
    const d = s.decisions[0];
    expect(d).toMatchObject({
      nodeId: "a",
      status: "open",
      question: "どちら？",
      options: ["A", "B"],
    });
    expect(res.value).toEqual({ decisionId: d?.decisionId });
    expect(stateOf(s, "a")).toBe("waiting");
    expect(s.inbox.at(-1)).toMatchObject({ kind: "decision", nodeId: "a", ref: d?.decisionId });
  });
});

describe("decision.present（統合ノード → 人間への判断要求）", () => {
  it("判断要求を作り、decision の項目を足す。呼び出した統合ノード自身は止めない", async () => {
    const r = rig();
    const res = await r.call(
      "decision.present",
      r.req("decision.present", { question: "DB は？", options: ["pg", "sqlite"] }, M1),
    );
    expect(res.ok).toBe(true);
    const s = r.state();
    expect(s.decisions[0]).toMatchObject({
      nodeId: "m1",
      question: "DB は？",
      options: ["pg", "sqlite"],
    });
    expect(stateOf(s, "m1")).toBe("running");
    expect(s.inbox.at(-1)).toMatchObject({
      kind: "decision",
      nodeId: "m1",
      ref: s.decisions[0]?.decisionId,
    });
  });

  it("pauseNodeIds（子の一時停止）は、再開の記録先が core にないため、まだ使えない（notSupported。何も書かない）", async () => {
    const r = rig();
    const before = r.state().lastSeq;
    const res = await r.call(
      "decision.present",
      r.req("decision.present", { question: "q", options: ["A"], pauseNodeIds: ["a"] }, M1),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("notSupported");
    expect(r.state().lastSeq).toBe(before);
    const empty = await r.call(
      "decision.present",
      r.req("decision.present", { question: "q", options: ["A"], pauseNodeIds: [] }, M1),
    );
    expect(empty.ok).toBe(true);
  });
});

describe("decision.answer（人間の回答。一本化）", () => {
  const ask = async (r: ReturnType<typeof rig>) =>
    (
      await r.call(
        "report.decision",
        r.req("report.decision", { question: "どちら？", options: ["A", "B"] }, A),
      )
    ).value.decisionId as string;

  it("選択肢から回答すると、回答を記録し、待っていた子を再開し、answer の項目を足す", async () => {
    const r = rig();
    const decisionId = await ask(r);
    const res = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId, choice: "A" }, "human"),
    );
    expect(res).toEqual({ ok: true, value: { accepted: true } });
    const s = r.state();
    expect(s.decisions[0]).toMatchObject({
      status: "answered",
      answer: "A",
      answeredBy: { human: true },
    });
    expect(stateOf(s, "a")).toBe("running");
    expect(s.inbox.at(-1)).toMatchObject({ kind: "answer", nodeId: "a", ref: decisionId });
  });

  it("採用済みの回答と同じ内容が届いたときは、ok を返し、却下を記録しない（重複の送信）", async () => {
    const r = rig();
    const decisionId = await ask(r);
    await r.call("decision.answer", r.req("decision.answer", { decisionId, choice: "A" }, "human"));
    const seq = r.state().lastSeq;
    const same = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId, choice: "A" }, "human"),
    );
    expect(same).toEqual({ ok: true, value: { accepted: true } });
    expect(r.state().lastSeq).toBe(seq);
    expect(r.state().decisions[0]?.rejected).toEqual([]);
  });

  it("自由入力でも回答できる。選択肢にない choice は拒否する（何も書かない）", async () => {
    const r = rig();
    const decisionId = await ask(r);
    const before = r.state().lastSeq;
    const bad = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId, choice: "C" }, "human"),
    );
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("choiceNotInOptions");
    expect(r.state().lastSeq).toBe(before);
    const free = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId, text: "Z にする" }, "human"),
    );
    expect(free.ok).toBe(true);
    expect(r.state().decisions[0]?.answer).toBe("Z にする");
  });

  it("後から来た回答は採用されず、採用された回答を伝える（alreadyAnswered。却下として記録する）", async () => {
    const r = rig();
    const decisionId = await ask(r);
    await r.call("decision.answer", r.req("decision.answer", { decisionId, choice: "A" }, "human"));
    const late = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId, choice: "B" }, "human"),
    );
    expect(late.ok).toBe(false);
    expect(late.error?.code).toBe("alreadyAnswered");
    expect(late.error?.cause).toContain("A");
    const d = r.state().decisions[0];
    expect(d?.answer).toBe("A");
    expect(d?.rejected.map((x) => x.answer)).toEqual(["B"]);
    expect(stateOf(r.state(), "a")).toBe("running"); // 二重に再開しない
  });

  it("未知の判断要求は notFound。統合ノードの判断要求への回答は、子を再開しようとしない", async () => {
    const r = rig();
    const none = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId: "nope", choice: "A" }, "human"),
    );
    expect(none.error?.code).toBe("notFound");
    const present = await r.call(
      "decision.present",
      r.req("decision.present", { question: "q", options: ["A"] }, M1),
    );
    const ok = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId: present.value.decisionId, choice: "A" }, "human"),
    );
    expect(ok.ok).toBe(true);
    expect(stateOf(r.state(), "m1")).toBe("running");
  });

  it("同じ requestId の再試行は冪等", async () => {
    const r = rig();
    const decisionId = await ask(r);
    const rq = () => r.req("decision.answer", { decisionId, choice: "A" }, "human", "ans-1");
    expect((await r.call("decision.answer", rq())).ok).toBe(true);
    const lastSeq = r.state().lastSeq;
    expect((await r.call("decision.answer", rq())).ok).toBe(true);
    expect(r.state().lastSeq).toBe(lastSeq);
  });
});

describe("report.done の根拠（1 件以上必須）", () => {
  it("根拠が空の完了報告は、何も書かずに失敗する（evidenceRequired）", async () => {
    const r = rig();
    const before = r.state().lastSeq;
    const res = await r.call("report.done", r.req("report.done", { evidence: [] }, A));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("evidenceRequired");
    expect(r.state().lastSeq).toBe(before);
    expect(stateOf(r.state(), "a")).toBe("running");
  });
});

describe("report.done の基準ごとの網羅（ブリーフを持つノード）", () => {
  const withBrief = () => {
    const r = rig();
    r.log.append({
      requestId: "seed-brief",
      actor: { system: true },
      body: {
        type: "node.created",
        payload: {
          nodeId: "c",
          role: "implement",
          parentId: "m1",
          dependsOn: [],
          objective: "目的",
          acceptanceCriteria: ["X が通る", "Y が通る"],
          scope: { writableLocations: ["src"], forbiddenLocations: [], allowedCommands: [] },
        },
      },
    });
    r.log.append({
      requestId: "seed-brief-start",
      actor: { system: true },
      body: { type: "node.stateChanged", payload: { nodeId: "c", event: { type: "start" } } },
    });
    return r;
  };
  const C = { role: "child", nodeId: "c" } as const;
  it("ブリーフを見たままの「> 」付きの criterion も、元の基準と同じとみなす", async () => {
    const r = withBrief();
    const res = await r.call(
      "report.done",
      r.req(
        "report.done",
        {
          evidence: [
            { criterion: "> X が通る", evidence: "t1" },
            { criterion: ">Y が通る ", evidence: "t2" },
          ],
        },
        C,
      ),
    );
    expect(res.error?.code).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("受け入れ基準の一部に根拠がなければ、何も書かずに失敗し、足りない基準を示す", async () => {
    const r = withBrief();
    const before = r.state().lastSeq;
    const res = await r.call(
      "report.done",
      r.req("report.done", { evidence: [{ criterion: "X が通る", evidence: "t1" }] }, C),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("evidenceRequired");
    expect(res.error?.cause).toContain("Y が通る");
    expect(r.state().lastSeq).toBe(before);
  });
  it("基準の照合は、NFC 正規化と前後の空白の除去をしてから行う", async () => {
    const r = withBrief();
    const res = await r.call(
      "report.done",
      r.req(
        "report.done",
        {
          evidence: [
            { criterion: "  X が通る\n", evidence: "t1" },
            { criterion: "Y が通る ", evidence: "t2" },
          ],
        },
        C,
      ),
    );
    expect(res.ok).toBe(true);
  });
  it("根拠の本文が空白だけのものは、何も書かずに拒否する", async () => {
    const r = withBrief();
    const before = r.state().lastSeq;
    const res = await r.call(
      "report.done",
      r.req(
        "report.done",
        {
          evidence: [
            { criterion: "X が通る", evidence: "t1" },
            { criterion: "Y が通る", evidence: "   " },
          ],
        },
        C,
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("evidenceRequired");
    expect(r.state().lastSeq).toBe(before);
  });
  it("すべての基準に根拠があれば受け付ける", async () => {
    const r = withBrief();
    const res = await r.call(
      "report.done",
      r.req(
        "report.done",
        {
          evidence: [
            { criterion: "X が通る", evidence: "t1" },
            { criterion: "Y が通る", evidence: "t2" },
          ],
        },
        C,
      ),
    );
    expect(res.ok).toBe(true);
    expect(stateOf(r.state(), "c")).toBe("done");
  });
});

describe("node.review の feedback（記録と配送）", () => {
  it("受理の feedback は、報告（kind: review）として記録する", async () => {
    const r = rig();
    await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    const res = await r.call(
      "node.review",
      r.req("node.review", { nodeId: "a", verdict: "accept", feedback: "よくできた" }, M1),
    );
    expect(res.ok).toBe(true);
    expect(r.state().reports.at(-1)).toMatchObject({
      nodeId: "a",
      kind: "review",
      text: "よくできた",
    });
  });

  it("差し戻しの理由を、deliver で子へ届ける。配送に失敗したら失敗を返し、再送で送り直す", async () => {
    const r = rig();
    const delivered: [string, string, number][] = [];
    let fail = true;
    const h = createStateHandlers({
      log: r.log,
      clock,
      deliver: async (id, text, seq) => {
        delivered.push([id, text, seq]);
        if (fail) return { ok: false, error: failure("sendFailed", "x", "y") };
        r.log.append({
          requestId: `dl-${seq}`,
          actor: { system: true },
          body: { type: "node.instructionDelivered", payload: { instructedSeq: seq } },
        });
        return { ok: true, value: undefined };
      },
    });
    await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    const req = r.req(
      "node.review",
      { nodeId: "a", verdict: "reject", feedback: "直して" },
      M1,
      "rv-1",
    );
    const first = (await h["node.review"](req as never)) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("sendFailed");
    expect(r.state().instructions).toHaveLength(1);
    fail = false;
    const retry = (await h["node.review"](req as never)) as { ok: boolean };
    expect(retry.ok).toBe(true);
    expect(delivered).toHaveLength(2);
    expect(r.state().instructions).toHaveLength(1);
    // 配送済みの再送は、送り直さない
    await h["node.review"](req as never);
    expect(delivered).toHaveLength(2);
  });
});

describe("node.review の差し戻し（同時実行・届ける手段）", () => {
  it("同じ requestId の同時の差し戻しは 1 つにまとめる（配送は 1 回）", async () => {
    const r = rig();
    let delivered = 0;
    const h = createStateHandlers({
      log: r.log,
      clock,
      deliver: async (_id, _text, seq) => {
        delivered++;
        await new Promise((res) => setTimeout(res, 5));
        r.log.append({
          requestId: `dl-${seq}`,
          actor: { system: true },
          body: { type: "node.instructionDelivered", payload: { instructedSeq: seq } },
        });
        return { ok: true, value: undefined };
      },
    });
    await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    const req = r.req(
      "node.review",
      { nodeId: "a", verdict: "reject", feedback: "直して" },
      M1,
      "rv-par",
    );
    const [x, y] = await Promise.all([
      h["node.review"](req as never),
      h["node.review"](req as never),
    ]);
    expect(x).toEqual(y);
    expect(delivered).toBe(1);
    expect(r.state().instructions).toHaveLength(1);
  });

  it("届ける手段がなければ、差し戻しを記録せずに失敗する", async () => {
    const r = rig();
    const h = createStateHandlers({
      log: r.log,
      clock,
      deliver: async () => ({ ok: true, value: undefined }),
      canDeliver: () => false,
    });
    await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    const before = r.state().lastSeq;
    const res = (await h["node.review"](
      r.req("node.review", { nodeId: "a", verdict: "reject", feedback: "直して" }, M1) as never,
    )) as { ok: boolean; error?: { code: string } };
    expect(res.error?.code).toBe("noRuntime");
    expect(r.state().lastSeq).toBe(before);
    expect(stateOf(r.state(), "a")).toBe("done");
  });
});

describe("node.review の差し戻し（Desktop のノード）", () => {
  it("知らせを出せないノードなら、差し戻しを記録せずに失敗する", async () => {
    const r = rig();
    const delivery = createInstructionDelivery({ log: r.log, clock });
    const h = createStateHandlers({
      log: r.log,
      clock,
      deliver: delivery.deliver,
      canDeliver: () => false,
    });
    await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    const before = r.state().lastSeq;
    const res = (await h["node.review"](
      r.req("node.review", { nodeId: "a", verdict: "reject", feedback: "直して" }, M1) as never,
    )) as { ok: boolean; error?: { code: string } };
    expect(res.ok).toBe(false);
    expect(r.state().lastSeq).toBe(before);
    expect(stateOf(r.state(), "a")).toBe("done");
  });
});

describe("node.review の feedback", () => {
  it("差し戻しの理由は、追加指示（node.instructed）として記録する（再開した子に届く）", async () => {
    const r = rig();
    await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    await r.call(
      "node.review",
      r.req("node.review", { nodeId: "a", verdict: "reject", feedback: "テストを足して" }, M1),
    );
    expect(r.state().instructions.map((i) => [i.nodeId, i.text])).toEqual([
      ["a", "テストを足して"],
    ]);
  });
});

describe("node.review（完了の判定。受理か差し戻し）", () => {
  const done = async (r: ReturnType<typeof rig>) => {
    await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
  };
  it("accept: done → verified。reject: done → running。結果は新しい状態", async () => {
    const r = rig();
    await done(r);
    const acc = await r.call(
      "node.review",
      r.req("node.review", { nodeId: "a", verdict: "accept" }, M1),
    );
    expect(acc).toEqual({ ok: true, value: { state: "verified" } });
    const r2 = rig();
    await done(r2);
    const rej = await r2.call(
      "node.review",
      r2.req("node.review", { nodeId: "a", verdict: "reject", feedback: "直して" }, M1),
    );
    expect(rej).toEqual({ ok: true, value: { state: "running" } });
  });

  it("ハンドラでも、呼び出し元がそのノードの親であることを確かめる（認可の二重の備え）", async () => {
    const r = rig();
    await done(r);
    const before = r.state().lastSeq;
    // root は a の親ではない（親は m1）
    const res = await r.call(
      "node.review",
      r.req("node.review", { nodeId: "a", verdict: "accept" }, ROOT),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("forbidden");
    expect(r.state().lastSeq).toBe(before);
  });

  it("done でないノードの判定は、何も書かずに失敗する（invalidTransition）", async () => {
    const r = rig();
    const before = r.state().lastSeq;
    const res = await r.call(
      "node.review",
      r.req("node.review", { nodeId: "a", verdict: "accept" }, M1),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalidTransition");
    expect(r.state().lastSeq).toBe(before);
  });
});

describe("inbox.fetch（呼び出し側の部分木の受信箱。差分取得）", () => {
  it("部分木の項目だけを、seq の昇順で返す。sinceSeq より後だけに絞れる", async () => {
    const r = rig();
    await r.call("report.progress", r.req("report.progress", { text: "a1" }, A));
    await r.call(
      "report.progress",
      r.req("report.progress", { text: "b1" }, { role: "child", nodeId: "b" }),
    );
    await r.call("report.progress", r.req("report.progress", { text: "a2" }, A));
    const m1 = await r.call("inbox.fetch", r.req("inbox.fetch", {}, M1));
    expect(m1.value.items.map((i: { nodeId: string }) => i.nodeId)).toEqual(["a", "a"]);
    const seqs = m1.value.items.map((i: { seq: number }) => i.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    const since = await r.call("inbox.fetch", r.req("inbox.fetch", { sinceSeq: seqs[0] }, M1));
    expect(since.value.items).toHaveLength(1);
    const all = await r.call("inbox.fetch", r.req("inbox.fetch", {}, ROOT));
    expect(all.value.items).toHaveLength(3);
  });

  it("人間は全ノードの項目を返す（touryou inbox）。統合ノードは従来どおり部分木だけ", async () => {
    const r = rig();
    await r.call("report.progress", r.req("report.progress", { text: "a1" }, A));
    await r.call(
      "report.progress",
      r.req("report.progress", { text: "b1" }, { role: "child", nodeId: "b" }),
    );
    const human = await r.call("inbox.fetch", r.req("inbox.fetch", {}, "human"));
    expect(human.value.items.map((i: { nodeId: string }) => i.nodeId).sort()).toEqual(["a", "b"]);
    const since = await r.call(
      "inbox.fetch",
      r.req("inbox.fetch", { sinceSeq: human.value.items[0].seq }, "human"),
    );
    expect(since.value.items).toHaveLength(1);
    const m1 = await r.call("inbox.fetch", r.req("inbox.fetch", {}, M1));
    expect(m1.value.items.map((i: { nodeId: string }) => i.nodeId)).toEqual(["a"]);
  });

  it("解決済み（inbox.resolved）の項目は返さない。項目そのものは記録に残る", async () => {
    const r = rig();
    await r.call("report.progress", r.req("report.progress", { text: "a1" }, A));
    await r.call("report.progress", r.req("report.progress", { text: "a2" }, A));
    const before = await r.call("inbox.fetch", r.req("inbox.fetch", {}, M1));
    const [first, second] = before.value.items as { id: string }[];
    const done = r.log.append({
      requestId: "resolve-1",
      actor: { human: true },
      body: { type: "inbox.resolved", payload: { itemId: (first as { id: string }).id } },
    });
    expect(done.ok).toBe(true);
    const after = await r.call("inbox.fetch", r.req("inbox.fetch", {}, M1));
    expect(after.value.items.map((i: { id: string }) => i.id)).toEqual([
      (second as { id: string }).id,
    ]);
    expect(r.state().inbox).toHaveLength(2);
  });

  it("ackItemIds（#102）: 統合ノードが載せた項目の ID だけを、受け取ったものとして記録する。項目は返さず、解決済みにもならない", async () => {
    const r = rig();
    await r.call("report.progress", r.req("report.progress", { text: "a1" }, A));
    await r.call("report.progress", r.req("report.progress", { text: "a2" }, A));
    const fetched = await r.call("inbox.fetch", r.req("inbox.fetch", {}, M1));
    const [first, second] = fetched.value.items as { id: string }[];
    // 受け取りを返さないうちは、記録がない（これまでどおり）
    for (const i of r.state().inbox) expect(i).not.toHaveProperty("acknowledged");
    const ack = await r.call(
      "inbox.fetch",
      r.req("inbox.fetch", { ackItemIds: [(first as { id: string }).id] }, M1),
    );
    expect(ack).toEqual({ ok: true, value: { items: [] } });
    const byId = (id: string) => r.state().inbox.find((i) => i.id === id);
    expect(byId((first as { id: string }).id)?.acknowledged).toMatchObject({
      by: { nodeId: "m1" },
    });
    // 載せなかった項目は、受け取ったことにならない
    expect(byId((second as { id: string }).id)).not.toHaveProperty("acknowledged");
    expect(byId((first as { id: string }).id)).not.toHaveProperty("resolved");
    // 付け直しても、記録は 1 回（最初の記録を残す）
    const before = r.state().lastSeq;
    await r.call(
      "inbox.fetch",
      r.req("inbox.fetch", { ackItemIds: [(first as { id: string }).id] }, M1),
    );
    expect(r.state().lastSeq).toBe(before);
    // 受け取ったあとも、項目は受信箱に残る（解決するまで）
    const again = await r.call("inbox.fetch", r.req("inbox.fetch", {}, M1));
    expect(again.value.items).toHaveLength(2);
  });

  it("ackItemIds: 見えない（部分木の外の）項目・存在しない ID は記録しない。人間の呼び出しは拒む", async () => {
    const r = rig();
    await r.call(
      "report.progress",
      r.req("report.progress", { text: "b1" }, { role: "child", nodeId: "b" }),
    );
    const bItem = r.state().inbox[0] as { id: string };
    const ack = await r.call(
      "inbox.fetch",
      r.req("inbox.fetch", { ackItemIds: [bItem.id, "no-such-item"] }, M1),
    );
    expect(ack.ok).toBe(true);
    expect(r.state().inbox[0]).not.toHaveProperty("acknowledged");
    const human = await r.call(
      "inbox.fetch",
      r.req("inbox.fetch", { ackItemIds: [bItem.id] }, "human"),
    );
    expect(human.ok).toBe(false);
    expect(human.error?.code).toBe("forbidden");
    expect(r.state().inbox[0]).not.toHaveProperty("acknowledged");
    // 部分木の持ち主（root）なら、その項目を受け取れる
    await r.call("inbox.fetch", r.req("inbox.fetch", { ackItemIds: [bItem.id] }, ROOT));
    expect(r.state().inbox[0]?.acknowledged).toMatchObject({ by: { nodeId: "root" } });
  });
});

describe("共通の性質", () => {
  it("操作で生成する ID は、すべて isSafeId を満たし、要求ごとに異なる", async () => {
    const r = rig();
    const sweep = ["x/y z", "日本語", "a".repeat(120)];
    for (const rq of sweep) {
      await r.call("report.progress", r.req("report.progress", { text: "t" }, A, rq));
    }
    const ids = [...r.state().reports.map((x) => x.reportId), ...r.state().inbox.map((x) => x.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isSafeId(id), id).toBe(true);
  });

  it("最大長（128 文字）の requestId でも、派生した requestId が長さの上限を超えず、記録できる。再試行は冪等", async () => {
    const r = rig();
    const long = `r${"x".repeat(127)}`;
    expect(long).toHaveLength(128);
    const a = await r.call("report.progress", r.req("report.progress", { text: "t" }, A, long));
    expect(a.ok).toBe(true);
    const b = await r.call("report.progress", r.req("report.progress", { text: "t" }, A, long));
    expect(b.ok).toBe(true);
    expect(r.state().reports).toHaveLength(1);
    for (const id of Object.keys(r.state().requests)) expect(isSafeId(id), id).toBe(true);
  });

  it("内部の requestId は呼び出し元ごとに分ける。別の呼び出し元が同じ requestId を使っても衝突せず、他の呼び出し元の存在はメッセージに出ない", async () => {
    const r = rig();
    const B = { role: "child", nodeId: "b" } as const;
    const a = await r.call(
      "report.progress",
      r.req("report.progress", { text: "A の報告" }, A, "shared-id"),
    );
    const b = await r.call(
      "report.progress",
      r.req("report.progress", { text: "B の報告" }, B, "shared-id"),
    );
    expect(a.ok && b.ok).toBe(true);
    expect(r.state().reports.map((x) => [x.nodeId, x.text])).toEqual([
      ["a", "A の報告"],
      ["b", "B の報告"],
    ]);
    // 内部の requestId は固定長で、呼び出し元の ID・要求の ID を含まない
    for (const id of Object.keys(r.state().requests).filter((k) => k.startsWith("rq-"))) {
      expect(id).toMatch(/^rq-[0-9a-f]{32}:\d+$/);
      expect(id).not.toContain("shared-id");
    }
    // 同じ呼び出し元の再試行は、冪等のまま
    const again = await r.call(
      "report.progress",
      r.req("report.progress", { text: "A の報告" }, A, "shared-id"),
    );
    expect(again.ok).toBe(true);
    expect(r.state().reports).toHaveLength(2);
  });

  it("途中で失敗する操作は、何も書かない（事前に全体を検査する）", async () => {
    const r = rig();
    await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A)); // a は done
    const before = r.state().lastSeq;
    const res = await r.call(
      "report.decision",
      r.req("report.decision", { question: "q", options: ["A"] }, A),
    );
    expect(res.ok).toBe(false);
    expect(r.state().lastSeq).toBe(before);
    expect(r.state().decisions).toHaveLength(0);
  });
});

void (null as unknown as NodeEvent);

describe("tree.list の pendingDecision 列", () => {
  it("破棄を決めた子の閉じた判断は「届かない」。止まった子の open の判断は「止まった子」", async () => {
    const r = rig();
    // a: 判断を 1 件出し、止めて停止済みにし、破棄を決める（→ closed）。
    r.log.append({
      requestId: "d-a",
      actor: SYS,
      body: { type: "decision.requested", payload: { decisionId: "a-d0", nodeId: "a" } },
    });
    r.log.append({
      requestId: "stop-a",
      actor: SYS,
      body: {
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "stop", mode: "immediate" } },
      },
    });
    r.log.append({
      requestId: "conf-a",
      actor: SYS,
      body: {
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "confirmStopped" } },
      },
    });
    r.log.append({
      requestId: "disc-a",
      actor: { human: true },
      body: { type: "node.discardDecided", payload: { nodeId: "a" } },
    });
    // b: 判断を 1 件出し、止めて停止済みにする（破棄しない → open のまま）。
    r.log.append({
      requestId: "d-b",
      actor: SYS,
      body: { type: "decision.requested", payload: { decisionId: "b-d0", nodeId: "b" } },
    });
    r.log.append({
      requestId: "stop-b",
      actor: SYS,
      body: {
        type: "node.stateChanged",
        payload: { nodeId: "b", event: { type: "stop", mode: "immediate" } },
      },
    });
    r.log.append({
      requestId: "conf-b",
      actor: SYS,
      body: {
        type: "node.stateChanged",
        payload: { nodeId: "b", event: { type: "confirmStopped" } },
      },
    });
    const listed = (await r.call("tree.list", r.req("tree.list", {}, ROOT))).value;
    const table = listed.table as string;
    const rowOf = (id: string) =>
      table.split("\n").find((l) => l.split("|")[1]?.trim() === id) ?? "";
    expect(table.split("\n")[0]).toContain("pendingDecision");
    expect(rowOf("a")).toContain("届かない");
    expect(rowOf("b")).toContain("止まった子");
    // nodes にも同じ数を出す（touryou tree --json・touryou state 用）。
    const nodes = listed.nodes as { id: string; pendingDecisions?: unknown }[];
    const pending = (id: string) => nodes.find((x) => x.id === id)?.pendingDecisions;
    expect(pending("a")).toEqual({ undeliverable: 1, stopped: 0 });
    expect(pending("b")).toEqual({ undeliverable: 0, stopped: 1 });
    expect(pending("root")).toEqual({ undeliverable: 0, stopped: 0 });
  });
});

describe("tree.list の題（#115）", () => {
  it("人には、目的のあるノードに、目的を 1 行に整えた題を付ける。目的のないノード・統合が呼んだときは付けない", async () => {
    const r = rig();
    r.log.append({
      requestId: "seed-title",
      actor: { system: true },
      body: {
        type: "node.created",
        payload: {
          nodeId: "t",
          role: "implement",
          parentId: "m1",
          dependsOn: [],
          objective: "ログインの\n  直し",
          acceptanceCriteria: ["通る"],
          scope: { writableLocations: ["src"], forbiddenLocations: [], allowedCommands: [] },
        },
      },
    });
    const listed = (await r.call("tree.list", r.req("tree.list", {}, "human"))).value;
    const nodes = listed.nodes as { id: string; title?: string }[];
    expect(nodes.find((n) => n.id === "t")?.title).toBe("ログインの 直し");
    expect(nodes.find((n) => n.id === "root")).not.toHaveProperty("title");
    // 統合が呼んだときは、自分の下のノードでも題を付けない（見える範囲を広げない）
    const byRoot = (await r.call("tree.list", r.req("tree.list", {}, ROOT))).value;
    const rootNodes = byRoot.nodes as { id: string; title?: string }[];
    expect(rootNodes.some((n) => n.id === "t")).toBe(true);
    expect(rootNodes.find((n) => n.id === "t")).not.toHaveProperty("title");
  });
});

describe("差し戻しで、CLI の子に購読がないときの案内", () => {
  const rejectRig = (over: { isCliChild?: boolean; hasSubscription?: boolean }) => {
    const r = rig();
    const h = createStateHandlers({
      log: r.log,
      clock,
      deliver: async () => ({ ok: true, value: undefined }),
      canDeliver: () => true,
      isCliChild: () => over.isCliChild ?? true,
      hasSubscription: () => over.hasSubscription ?? false,
    });
    return { r, h };
  };
  const reject = async (h: ReturnType<typeof createStateHandlers>, r: ReturnType<typeof rig>) => {
    await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    return (await h["node.review"](
      r.req("node.review", { nodeId: "a", verdict: "reject", feedback: "直して" }, M1) as never,
    )) as { ok: boolean };
  };

  it("CLI の子で購読がないと、親の受信箱に info を出す（差し戻しは通す）", async () => {
    const { r, h } = rejectRig({ isCliChild: true, hasSubscription: false });
    const res = await reject(h, r);
    expect(res.ok).toBe(true);
    const info = r.state().inbox.filter((i) => i.nodeId === "a" && i.kind === "info");
    expect(info.some((i) => (i.summary ?? "").includes("購読がない"))).toBe(true);
  });

  it("購読があれば、知らせは出さない", async () => {
    const { r, h } = rejectRig({ isCliChild: true, hasSubscription: true });
    await reject(h, r);
    const info = r.state().inbox.filter((i) => i.nodeId === "a" && i.kind === "info");
    expect(info.some((i) => (i.summary ?? "").includes("購読がない"))).toBe(false);
  });

  it("Desktop の子（CLI でない）には、知らせを出さない", async () => {
    const { r, h } = rejectRig({ isCliChild: false, hasSubscription: false });
    await reject(h, r);
    const info = r.state().inbox.filter((i) => i.nodeId === "a" && i.kind === "info");
    expect(info.some((i) => (i.summary ?? "").includes("購読がない"))).toBe(false);
  });
});

describe("CLI の子の見分け（isCliChildOf）", () => {
  it("child_bind で kind bind のトークンを受けた CLI の子でも、CLI の子とみなす", () => {
    const r = rig();
    const credentials = createCredentialStore({ humanToken: "h".repeat(40) });
    credentials.issueNodeToken("a", "child", "bind");
    expect(credentials.hasBindToken?.("a")).toBe(true);
    expect(isCliChildOf("cli", r.state(), "a")).toBe(true);
    expect(isCliChildOf(undefined, r.state(), "a")).toBe(true);
    expect(isCliChildOf("desktop", r.state(), "a")).toBe(false);
    expect(isCliChildOf("cli", r.state(), "root")).toBe(false);
  });

  it("紐付けた CLI の子に reject し、購読がなければ、親の受信箱に info を出す", async () => {
    const r = rig();
    const credentials = createCredentialStore({ humanToken: "h".repeat(40) });
    credentials.issueNodeToken("a", "child", "bind");
    const h = createStateHandlers({
      log: r.log,
      clock,
      deliver: async () => ({ ok: true, value: undefined }),
      canDeliver: () => true,
      isCliChild: (id) => isCliChildOf("cli", r.log.state(), id),
      hasSubscription: () => false,
    });
    await r.call("report.done", r.req("report.done", { evidence: EVIDENCE }, A));
    const res = (await h["node.review"](
      r.req("node.review", { nodeId: "a", verdict: "reject", feedback: "直して" }, M1) as never,
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    const info = r.state().inbox.filter((i) => i.nodeId === "a" && i.kind === "info");
    expect(info.some((i) => (i.summary ?? "").includes("購読がない"))).toBe(true);
  });
});

describe("閉じた判断への回答", () => {
  it("decision.answer は、閉じた判断に何も書かずに decisionClosed を返す", async () => {
    const r = rig();
    const add = (requestId: string, body: EventBody, actor: object = SYS) =>
      r.log.append({ requestId, actor: actor as never, body });
    add("d", {
      type: "decision.requested",
      payload: { decisionId: "a-d0", nodeId: "a", question: "q", options: ["A"] },
    });
    add("s", {
      type: "node.stateChanged",
      payload: { nodeId: "a", event: { type: "stop", mode: "immediate" } },
    });
    add("c", {
      type: "node.stateChanged",
      payload: { nodeId: "a", event: { type: "confirmStopped" } },
    });
    add("x", { type: "node.discardDecided", payload: { nodeId: "a" } }, { human: true });
    const before = r.state().lastSeq;
    const res = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId: "a-d0", choice: "A" }, "human"),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("decisionClosed");
    expect(res.error?.cause).toContain("届かない");
    expect(r.state().lastSeq).toBe(before);
  });
});
