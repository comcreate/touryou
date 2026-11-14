import { type DaemonRequest, ok, type Result } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { type DaemonClient, runCommand } from "../src/index.js";

function fakeClient(results: Record<string, Result<unknown> | (() => never)>) {
  const sent: DaemonRequest<"human">[] = [];
  const client: DaemonClient = {
    call: async (req) => {
      sent.push(req);
      const r = results[req.operation];
      if (r === undefined) throw new Error(`想定外の操作: ${req.operation}`);
      return (typeof r === "function" ? r() : r) as never;
    },
  };
  return { client, sent };
}
const deps = (client: DaemonClient) => ({ client, newRequestId: () => "req-1" });
const ops = (sent: readonly DaemonRequest<"human">[]) => sent.map((s) => s.operation);

const TREE = {
  table: "| id |\n|----|\n| n1 |",
  nodes: [
    {
      id: "n1",
      role: "integrator",
      state: "running",
      parentId: null,
      dependsOn: [],
      openItems: 2,
      discarded: false,
    },
    {
      id: "n2",
      role: "implement",
      state: "waiting",
      parentId: "n1",
      dependsOn: ["n1"],
      openItems: 0,
      discarded: true,
    },
  ],
};

describe("touryou tree / state", () => {
  it("touryou tree は tree.list を呼び、表を出す", async () => {
    const { client, sent } = fakeClient({ "tree.list": ok(TREE) });
    const r = await runCommand(["tree"], deps(client));
    expect(r.exitCode).toBe(0);
    expect(ops(sent)).toEqual(["tree.list"]);
    expect(r.stdout).toContain("| id |");
  });

  it("touryou tree --json はノードの配列を JSON で出す", async () => {
    const { client } = fakeClient({ "tree.list": ok(TREE) });
    const r = await runCommand(["tree", "--json"], deps(client));
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveLength(2);
  });

  it("touryou tree <nodeId> は 1 ノードの詳しい状態を出す", async () => {
    const { client } = fakeClient({ "tree.list": ok(TREE) });
    const r = await runCommand(["tree", "n2"], deps(client));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ノード: n2");
    expect(r.stdout).toContain("親: n1");
    expect(r.stdout).toContain("破棄の判断: 済み");
  });

  it("nodes に pendingDecisions があれば、1 ノードの表示に止まった子の未回答の判断を出す", async () => {
    const tree = {
      ...TREE,
      nodes: TREE.nodes.map((n) =>
        n.id === "n2" ? { ...n, pendingDecisions: { undeliverable: 1, stopped: 2 } } : n,
      ),
    };
    const { client } = fakeClient({ "tree.list": ok(tree) });
    const r = await runCommand(["tree", "n2"], deps(client));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("止まった子の未回答の判断: 1（届かない）+2（止まった子）");
    const none = await runCommand(
      ["tree", "n1"],
      deps(fakeClient({ "tree.list": ok(TREE) }).client),
    );
    // 古い daemon（pendingDecisions なし）では、行を出さない
    expect(none.stdout).not.toContain("未回答の判断");
  });

  it("pendingDecisions の形が違えば、応答の形が違うとして扱う", async () => {
    const tree = {
      ...TREE,
      nodes: TREE.nodes.map((n) =>
        n.id === "n2" ? { ...n, pendingDecisions: { stopped: -1 } } : n,
      ),
    };
    const { client } = fakeClient({ "tree.list": ok(tree) });
    const r = await runCommand(["tree", "n2"], deps(client));
    expect(r.exitCode).not.toBe(0);
  });

  it("touryou state <nodeId> は JSON も出せる", async () => {
    const { client } = fakeClient({ "tree.list": ok(TREE) });
    const r = await runCommand(["state", "n1", "--json"], deps(client));
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ id: "n1", openItems: 2 });
  });

  it("touryou state の無いノードは、見つからないと伝える（終了コード 1）", async () => {
    const { client } = fakeClient({ "tree.list": ok(TREE) });
    const r = await runCommand(["state", "zzz"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("見つからない");
  });

  it("touryou state は nodeId が必須", async () => {
    const { client } = fakeClient({ "tree.list": ok(TREE) });
    const r = await runCommand(["state"], deps(client));
    expect(r.exitCode).toBe(2);
  });
});

const INBOX_DECISIONS = {
  items: [
    {
      id: "i1",
      kind: "decision",
      nodeId: "n2",
      at: "2026-01-01T00:00:00Z",
      seq: 5,
      summary: "A か B か",
      ref: "dec-1",
      dependsOn: [],
    },
    {
      id: "i2",
      kind: "progress",
      nodeId: "n2",
      at: "2026-01-01T00:00:01Z",
      seq: 6,
      summary: "進捗",
      dependsOn: [],
    },
  ],
};

describe("touryou decisions", () => {
  it("inbox.fetch から decision だけを出し、子の状態を添える", async () => {
    const { client, sent } = fakeClient({
      "inbox.fetch": ok(INBOX_DECISIONS),
      "tree.list": ok(TREE),
      "decision.get": ok(DECISION_OPEN),
    });
    const r = await runCommand(["decisions"], deps(client));
    expect(r.exitCode).toBe(0);
    expect(ops(sent)).toEqual(["inbox.fetch", "tree.list", "decision.get"]);
    expect(r.stdout).toContain("dec-1");
    expect(r.stdout).toContain("子の状態: waiting（届ける手段があれば、子に届く）");
    expect(r.stdout).not.toContain("届かない");
    expect(r.stdout).not.toContain("進捗");
  });

  it("止まった子の判断には、答えが届かないと出す", async () => {
    const stopped = {
      ...TREE,
      nodes: TREE.nodes.map((n) => (n.id === "n2" ? { ...n, state: "stopped" } : n)),
    };
    const { client } = fakeClient({ "inbox.fetch": ok(INBOX_DECISIONS), "tree.list": ok(stopped) });
    const r = await runCommand(["decisions"], deps(client));
    expect(r.stdout).toContain("この子は stopped なので、答えは子に届かない");
  });

  it("open でない判断は、答えられないと出す", async () => {
    const { client } = fakeClient({
      "inbox.fetch": ok(INBOX_DECISIONS),
      "tree.list": ok(TREE),
      "decision.get": ok({ ...DECISION_OPEN, status: "closed", closedReason: "破棄" }),
    });
    const r = await runCommand(["decisions"], deps(client));
    expect(r.stdout).toContain("答えられない（status: closed（理由: 破棄）");
  });

  it("--json", async () => {
    const { client } = fakeClient({ "inbox.fetch": ok(INBOX_DECISIONS), "tree.list": ok(TREE) });
    const r = await runCommand(["decisions", "--json"], deps(client));
    expect(JSON.parse(r.stdout)).toEqual([
      {
        decisionId: "dec-1",
        nodeId: "n2",
        summary: "A か B か",
        at: "2026-01-01T00:00:00Z",
        nodeState: "waiting",
        deliverable: true,
      },
    ]);
  });
});

const DECISION_OPEN = {
  decisionId: "dec-1",
  nodeId: "n2",
  status: "open" as const,
  question: "A か B か",
  options: ["A", "B"],
};
const NO_OPTIONS = { ...DECISION_OPEN, options: [] as string[] };

/** 表示（--yes なし）から照合の値を取る。 */
async function digestOf(decision: object): Promise<string> {
  const { client } = fakeClient({ "decision.get": ok(decision), "tree.list": ok(TREE) });
  const r = await runCommand(["answer", "dec-1"], deps(client));
  const m = /照合の値: ([0-9a-f]{12})/.exec(r.stdout);
  if (m?.[1] === undefined) throw new Error(r.stdout);
  return m[1];
}

describe("touryou answer", () => {
  it("--yes がなければ、中身と子の状態を表示するだけで答えない。案内には --expect を出す", async () => {
    const { client, sent } = fakeClient({
      "decision.get": ok(DECISION_OPEN),
      "tree.list": ok(TREE),
    });
    const r = await runCommand(["answer", "dec-1"], deps(client));
    expect(r.exitCode).toBe(0);
    expect(ops(sent)).toEqual(["decision.get", "tree.list"]);
    expect(r.stdout).toContain("問い: A か B か");
    expect(r.stdout).toContain("子の状態: waiting（届ける手段があれば、子に届く）");
    expect(r.stderr).toMatch(/--expect [0-9a-f]{12}/);
  });

  it("選択肢のない判断でも、案内に --expect を出す", async () => {
    const { client } = fakeClient({ "decision.get": ok(NO_OPTIONS), "tree.list": ok(TREE) });
    const r = await runCommand(["answer", "dec-1"], deps(client));
    expect(r.stderr).toMatch(/--expect [0-9a-f]{12}/);
  });

  it("--yes だけ（--expect なし）では答えない（終了コード 1、decision.answer を呼ばない）", async () => {
    const { client, sent } = fakeClient({
      "decision.get": ok(NO_OPTIONS),
      "tree.list": ok(TREE),
      "decision.answer": ok({ accepted: true }),
    });
    const r = await runCommand(["answer", "dec-1", "--text", "x", "--yes"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(ops(sent)).not.toContain("decision.answer");
    expect(r.stderr).toContain("--expect");
  });

  it("--yes --expect --choice で答える（decision.answer を呼ぶ）", async () => {
    const dg = await digestOf(DECISION_OPEN);
    const { client, sent } = fakeClient({
      "decision.get": ok(DECISION_OPEN),
      "tree.list": ok(TREE),
      "decision.answer": ok({ accepted: true }),
    });
    const r = await runCommand(
      ["answer", "dec-1", "--choice", "A", "--yes", "--expect", dg],
      deps(client),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(ops(sent)).toEqual(["decision.get", "tree.list", "decision.answer"]);
    expect(sent[2]?.params).toMatchObject({ decisionId: "dec-1", choice: "A" });
  });

  it.each([
    ["delivered", "答えを子に届けた"],
    ["skipped", "答えは子に届けていない"],
  ] as const)(
    "daemon が delivery=%s を返せば、それを出す（子の状態の見込みより優先）",
    async (delivery, text) => {
      const dg = await digestOf(DECISION_OPEN);
      const { client } = fakeClient({
        "decision.get": ok(DECISION_OPEN),
        "tree.list": ok(TREE),
        "decision.answer": ok({ accepted: true, delivery }),
      });
      const r = await runCommand(
        ["answer", "dec-1", "--choice", "A", "--yes", "--expect", dg],
        deps(client),
      );
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toContain(text);
    },
  );

  it("古い daemon（delivery なし）や知らない delivery の値では、今までどおり子の状態から出す", async () => {
    const dg = await digestOf(DECISION_OPEN);
    for (const result of [{ accepted: true }, { accepted: true, delivery: "later" }]) {
      const { client } = fakeClient({
        "decision.get": ok(DECISION_OPEN),
        "tree.list": ok(TREE),
        "decision.answer": ok(result),
      });
      const r = await runCommand(
        ["answer", "dec-1", "--choice", "A", "--yes", "--expect", dg],
        deps(client),
      );
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).not.toContain("届けた");
      expect(r.stdout).not.toContain("届けていない");
    }
  });

  it("止まった子への答えは、届かないと注意する", async () => {
    const stopped = {
      ...TREE,
      nodes: TREE.nodes.map((n) => (n.id === "n2" ? { ...n, state: "stopped" } : n)),
    };
    const dg = await digestOf(NO_OPTIONS);
    const { client } = fakeClient({
      "decision.get": ok(NO_OPTIONS),
      "tree.list": ok(stopped),
      "decision.answer": ok({ accepted: true }),
    });
    const r = await runCommand(
      ["answer", "dec-1", "--text", "x", "--yes", "--expect", dg],
      deps(client),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("答えは子に届かない");
  });

  it("選択肢にない --choice は受け付けない（終了コード 2、decision.answer を呼ばない）", async () => {
    const dg = await digestOf(DECISION_OPEN);
    const { client, sent } = fakeClient({
      "decision.get": ok(DECISION_OPEN),
      "tree.list": ok(TREE),
    });
    const r = await runCommand(
      ["answer", "dec-1", "--choice", "C", "--yes", "--expect", dg],
      deps(client),
    );
    expect(r.exitCode).toBe(2);
    expect(ops(sent)).not.toContain("decision.answer");
  });

  it("--text と --choice は同時に指定できない", async () => {
    const { client } = fakeClient({ "decision.get": ok(DECISION_OPEN) });
    const r = await runCommand(
      ["answer", "dec-1", "--text", "x", "--choice", "A", "--yes"],
      deps(client),
    );
    expect(r.exitCode).toBe(2);
  });

  it("--expect が今の照合の値と違えば、答えない（decision.answer を呼ばない）", async () => {
    const { client, sent } = fakeClient({
      "decision.get": ok(DECISION_OPEN),
      "tree.list": ok(TREE),
      "decision.answer": ok({ accepted: true }),
    });
    const r = await runCommand(
      ["answer", "dec-1", "--choice", "A", "--yes", "--expect", "000000000000"],
      deps(client),
    );
    expect(r.exitCode).toBe(1);
    expect(ops(sent)).not.toContain("decision.answer");
    expect(r.stderr).toContain("照合の値が違う");
  });

  it("status が closed の判断には、--yes --expect を付けても答えない（理由に status と closedReason）", async () => {
    const closed = { ...DECISION_OPEN, status: "closed", closedReason: "人が破棄を決めた" };
    const { client, sent } = fakeClient({
      "decision.get": ok(closed),
      "tree.list": ok(TREE),
      "decision.answer": ok({ accepted: true }),
    });
    const r = await runCommand(
      ["answer", "dec-1", "--choice", "A", "--yes", "--expect", "000000000000"],
      deps(client),
    );
    expect(r.exitCode).toBe(1);
    expect(ops(sent)).not.toContain("decision.answer");
    expect(r.stderr).toContain("status: closed");
    expect(r.stderr).toContain("人が破棄を決めた");
  });

  it("まだ知らない status でも答えない", async () => {
    const { client, sent } = fakeClient({
      "decision.get": ok({ ...DECISION_OPEN, status: "future" }),
    });
    const r = await runCommand(
      ["answer", "dec-1", "--text", "x", "--yes", "--expect", "000000000000"],
      deps(client),
    );
    expect(r.exitCode).toBe(1);
    expect(ops(sent)).not.toContain("decision.answer");
  });

  it("答え済みの判断には答えられない", async () => {
    const { client, sent } = fakeClient({
      "decision.get": ok({ ...DECISION_OPEN, status: "answered", answer: "A" }),
    });
    const r = await runCommand(["answer", "dec-1", "--choice", "A", "--yes"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(ops(sent)).toEqual(["decision.get"]);
    expect(r.stderr).toContain("答え済み");
  });
});
