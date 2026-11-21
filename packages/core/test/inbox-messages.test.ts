import { describe, expect, it } from "vitest";
import {
  DIGEST_STATE_NAMES,
  digestMessage,
  type EventBody,
  fillMessage,
  foldEvents,
  INBOX_MESSAGE_LIMITS,
  INBOX_MESSAGES,
  INBOX_SUMMARY_MAX,
  inboxMessage,
  inboxMessageText,
  isInboxMessage,
  isInboxMessageKey,
  isStallSummary,
  LANGS,
  messagePart,
  type OrchEvent,
  placeholdersOf,
  stallSummary,
  uiViewOf,
} from "../src/index.js";

const SYS = { system: true } as const;
const AT = "2026-10-20T00:00:00Z";
let n = 0;
const ev = (body: EventBody): OrchEvent =>
  ({ seq: ++n, at: AT, requestId: `r${n}`, actor: SYS, ...body }) as OrchEvent;
const base = (): OrchEvent[] => {
  n = 0;
  return [
    ev({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    } as never),
  ];
};
const added = (extra: Record<string, unknown>) =>
  ev({
    type: "inbox.added",
    payload: { id: `i${n + 1}`, kind: "info", nodeId: "root", ...extra },
  } as never);

describe("知らせの文の表（#140）", () => {
  const entries = Object.entries(INBOX_MESSAGES);

  it("どの鍵も、日本語と英語の両方を持ち、空でない。差し込みの名前は両方で同じ", () => {
    expect(entries.length).toBeGreaterThan(10);
    for (const [key, t] of entries) {
      expect(key).toMatch(/^[a-z][A-Za-z0-9]{0,63}$/);
      for (const lang of LANGS) {
        expect(typeof t[lang], `${key}.${lang}`).toBe("string");
        expect(t[lang].trim().length, `${key}.${lang}`).toBeGreaterThan(0);
      }
      expect(placeholdersOf(t.en), key).toEqual(placeholdersOf(t.ja));
    }
  });

  it("紐付けが外れているかも: 実際の長さのノード ID でも、日本語の要約は上限に収まり、次にすることが残る", () => {
    const m = inboxMessage("bindLostSuspect", {
      node: `node-${"0".repeat(32)}`,
      minutes: 1440,
    });
    expect([...m.summary].length).toBeLessThanOrEqual(INBOX_SUMMARY_MAX);
    for (const word of ["いまの状態", "次にすること", "node_send", "child_bind", "node_bindCode"]) {
      expect(m.summary).toContain(word);
    }
    const en = inboxMessageText("en", m.msg) ?? "";
    for (const word of ["node_send", "child_bind", "node_bindCode"]) expect(en).toContain(word);
  });

  it("英語の文には、ひらがな・カタカナ・漢字を入れない。日本語の文には、それを入れる", () => {
    const cjk = /[぀-ヿ㐀-鿿]/;
    for (const [key, t] of entries) {
      expect(cjk.test(t.en), `${key}.en`).toBe(false);
      // 値と区切りだけの項目（並べる部分の項目。例 `{label} {n}`）は、日本語の文字を持たなくてよい
      const bare = t.ja.replace(/\{[a-z][A-Za-z0-9]*\}/g, "").replace(/[\s（）]/g, "") === "";
      if (!bare) expect(cjk.test(t.ja), `${key}.ja`).toBe(true);
    }
  });

  it("inboxMessage：日本語の summary と、鍵と値の msg を作る。止まっているかもの文は、これまでと同じ形で見分けられる", () => {
    const m = inboxMessage("stall", { node: "c4", minutes: 30 });
    expect(m.summary).toBe(stallSummary("c4", 30));
    expect(isStallSummary(m.summary)).toBe(true);
    expect(m.msg).toEqual({ key: "stall", args: { node: "c4", minutes: 30 } });
    expect(inboxMessageText("en", m.msg)).toBe(
      "Child c4 may be stuck (30 min with no report and no tool use). The parent checks with claude agents --json and reports agentState with parent_report, or asks a person to attach",
    );
    expect(inboxMessageText("ja", m.msg)).toBe(m.summary);
  });

  it("inboxMessage：値の制御文字は空白にし、長すぎる値は切る（記録の検査に通る形）", () => {
    const m = inboxMessage("violation", {
      reason: "a\nb",
      subject: "x".repeat(INBOX_MESSAGE_LIMITS.value + 50),
    });
    expect(m.msg.args.reason).toBe("a b");
    expect(String(m.msg.args.subject).length).toBe(INBOX_MESSAGE_LIMITS.value);
    expect(isInboxMessage(m.msg)).toBe(true);
  });

  it("値の名前が 名前Key で表の鍵なら、{名前} を同じ言語のその文にする（入力待ちの種類の言葉）。知らない鍵は残す", () => {
    const m = inboxMessage("needsInput", { node: "c1", labelKey: "labelPermissionPrompt" });
    expect(m.summary).toBe(
      "子 c1 が止まっている（許可の確認）。人が子のセッションを開いて（attach）応える",
    );
    expect(inboxMessageText("en", m.msg)).toBe(
      "Child c1 is stuck (permission prompt). A person should open (attach to) the child's session and respond",
    );
    // 知らない種類は、種類の名前をそのまま値に入れる
    expect(inboxMessage("needsInput", { node: "c1", label: "new_type" }).summary).toContain(
      "（new_type）",
    );
    expect(fillMessage("{label}", { labelKey: "nope" }, "en")).toBe("{label}");
    expect(fillMessage("{label}", { labelKey: "labelIdlePrompt" })).toBe("{label}"); // 言語を渡さなければ、置き換えない
  });

  it("fillMessage：無い名前はそのまま残す。知らない鍵は、文にしない（画面は summary を出す）", () => {
    expect(fillMessage("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
    expect(isInboxMessageKey("nope")).toBe(false);
    expect(inboxMessageText("en", { key: "nope", args: {} })).toBe(undefined);
  });

  it("isInboxMessage：形の合わないものは断る", () => {
    expect(isInboxMessage({ key: "stall", args: { node: "a", minutes: 1 } })).toBe(true);
    // 知らない鍵でも、形が合えば記録できる（新しい daemon の記録を、古い画面が読むこともある）
    expect(isInboxMessage({ key: "laterKey", args: {} })).toBe(true);
    for (const bad of [
      null,
      [],
      "stall",
      { key: "Stall", args: {} },
      { key: "stall" },
      { key: "stall", args: [] },
      { key: "stall", args: {}, extra: 1 },
      { key: "stall", args: { "bad-name": "x" } },
      { key: "stall", args: { node: { a: 1 } } },
      { key: "stall", args: { node: "a\nb" } },
      { key: "stall", args: { n: Number.NaN } },
      { key: "stall", args: { node: "x".repeat(INBOX_MESSAGE_LIMITS.value + 1) } },
      {
        key: "stall",
        args: Object.fromEntries(
          Array.from({ length: INBOX_MESSAGE_LIMITS.args + 1 }, (_, i) => [`a${i}`, i]),
        ),
      },
    ])
      expect(isInboxMessage(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("並べる部分 parts（#140）", () => {
  it("項目を、言語ごとの区切りでつなぐ。値の鍵の参照も、項目の中で効く", () => {
    const m = inboxMessage(
      "resumeSkipped",
      { decision: "d1" },
      {
        children: {
          sep: "comma",
          items: [
            messagePart("resumeSkippedChild", { node: "c1", reasonKey: "notResumedDiscarded" }),
            messagePart("resumeSkippedChild", {
              node: "c2",
              reasonKey: "notResumedStoppedByOther",
            }),
          ],
        },
      },
    );
    expect(m.summary).toBe(
      "判断 d1 の回答で、再開しなかった子: c1（破棄の判断を経たため）、c2（判断のほかに止められたため）",
    );
    expect(inboxMessageText("en", m.msg)).toBe(
      "Children not resumed after the answer to decision d1: c1 (a discard decision was made), c2 (it was stopped for a reason other than the decision)",
    );
    expect(isInboxMessage(m.msg)).toBe(true);
  });

  it("項目に知らない鍵があれば、文にしない（画面は summary を出す）", () => {
    expect(
      inboxMessageText("en", {
        key: "resumeSkipped",
        args: { decision: "d" },
        parts: { children: { sep: "comma", items: [{ key: "laterKey", args: {} }] } },
      }),
    ).toBe(undefined);
  });

  it("isInboxMessage：parts の形・区切り・数・深さを見る", () => {
    const item = { key: "value", args: { value: "a" } };
    const ok = { key: "digestTop", args: {}, parts: { items: { sep: "comma", items: [item] } } };
    expect(isInboxMessage(ok)).toBe(true);
    const deep = (d: number): unknown =>
      d === 0
        ? item
        : { key: "digestTop", args: {}, parts: { items: { sep: "none", items: [deep(d - 1)] } } };
    expect(isInboxMessage(deep(INBOX_MESSAGE_LIMITS.depth - 1))).toBe(true);
    expect(isInboxMessage(deep(INBOX_MESSAGE_LIMITS.depth))).toBe(false);
    for (const parts of [
      [],
      { items: { sep: "space", items: [item] } },
      { items: { sep: "comma", items: {} } },
      { items: { sep: "comma", items: [item], extra: 1 } },
      { "bad-name": { sep: "comma", items: [item] } },
      { items: { sep: "comma", items: Array(INBOX_MESSAGE_LIMITS.items + 1).fill(item) } },
      { items: { sep: "comma", items: [{ key: "value", args: { value: "a\nb" } }] } },
    ])
      expect(isInboxMessage({ key: "digestTop", args: {}, parts }), JSON.stringify(parts)).toBe(
        false,
      );
    // 値と同じ名前の parts は断る（どちらを入れるか曖昧）
    expect(
      isInboxMessage({
        key: "digestTop",
        args: { items: 1 },
        parts: { items: { sep: "comma", items: [] } },
      }),
    ).toBe(false);
  });

  it("要約（digest）：日本語の文は表の文から作り、状態の名前は DIGEST_STATE_NAMES と同じ。英語も同じ数の項目を出す", () => {
    for (const [s, name] of Object.entries(DIGEST_STATE_NAMES)) {
      const k = `digestState${s.charAt(0).toUpperCase()}${s.slice(1)}`;
      expect(INBOX_MESSAGES[k as keyof typeof INBOX_MESSAGES]?.ja, k).toBe(name);
    }
    const facts = {
      nodeId: "m1",
      descendants: 3,
      byState: { running: 2, stopped: 1 },
      unresolved: { decision: 1, info: 2 },
      openDecisions: 1,
      openExtensions: 0,
      top: ["i1", "i2"],
      oldestBlockingMinutes: 5,
    };
    const m = digestMessage(facts);
    expect(m.summary).toBe(
      "配下 3（実行 2・停止 1）。未解決: 要判断 1・情報 2。未回答の判断 1・未判定の拡張要求 0。最古の要判断 5 分。最優先: i1、i2",
    );
    expect(inboxMessageText("ja", m.msg)).toBe(m.summary);
    expect(inboxMessageText("en", m.msg)).toBe(
      "3 below (2 running, 1 stopped). Open: 1 needs decision, 2 info. Unanswered decisions 1, undecided extension requests 0. Oldest item needing a decision: 5 min. Top priority: i1, i2",
    );
    // 長いときは、日本語の長さで最優先の ID を減らし、英語も同じ数にする
    const long = digestMessage({
      ...facts,
      top: Array.from({ length: 5 }, (_, i) => `i${i}-${"x".repeat(60)}`),
    });
    expect([...long.summary].length).toBeLessThanOrEqual(INBOX_SUMMARY_MAX);
    expect(inboxMessageText("ja", long.msg)).toBe(long.summary);
    const shown = long.summary.split("、").length;
    expect(inboxMessageText("en", long.msg)?.split(", i").length).toBe(shown);
  });
});

describe("記録と表示モデルの msg（#140）", () => {
  it("msg つきの知らせは、記録にも表示モデルにも msg が載る。summary は日本語のまま", () => {
    const m = inboxMessage("stall", { node: "root", minutes: 30 });
    const r = foldEvents([...base(), added({ summary: m.summary, msg: m.msg })]);
    if (!r.ok) throw new Error(r.error.cause);
    expect(r.value.inbox[0]?.msg).toEqual(m.msg);
    const item = uiViewOf(r.value).inbox[0];
    expect(item?.msg).toEqual(m.msg);
    expect(item?.summary).toBe(m.summary);
    expect(item?.stall).toBe(true);
  });

  const withParts: readonly (readonly [string, { summary: string; msg: never }])[] = [
    [
      "配下の要約",
      digestMessage({
        nodeId: "root",
        descendants: 2,
        byState: { running: 2 },
        unresolved: { info: 1 },
        openDecisions: 0,
        openExtensions: 1,
        top: ["i1"],
      }) as never,
    ],
    [
      "窓口の警告",
      inboxMessage(
        "apiAlert",
        {},
        {
          window: { sep: "none", items: [messagePart("apiWindow", { sec: 60 })] },
          kinds: {
            sep: "dot",
            items: [
              messagePart(
                "apiKindDetail",
                { labelKey: "apiAuthFailed", total: 40 },
                {
                  detail: {
                    sep: "dot",
                    items: [messagePart("nameCount", { name: "invalid", n: 40 })],
                  },
                },
              ),
              messagePart("apiKind", { labelKey: "apiRateLimited", total: 31 }),
            ],
          },
          hint: { sep: "comma", items: [messagePart("apiHintBrute")] },
        },
      ) as never,
    ],
    [
      "再開しなかった子",
      inboxMessage(
        "resumeSkipped",
        { decision: "d1" },
        {
          children: {
            sep: "comma",
            items: [
              messagePart("resumeSkippedChild", { node: "c1", reasonKey: "notResumedDiscarded" }),
              messagePart("resumeSkippedChild", {
                node: "c2",
                reasonKey: "notResumedStoppedByOther",
              }),
            ],
          },
        },
      ) as never,
    ],
  ];

  it.each(withParts)(
    "parts のある知らせ（%s）も、表示モデルを通って同じ文になる。英語に差し込み残りがない",
    (_, d) => {
      const r = foldEvents([...base(), added({ summary: d.summary, msg: d.msg })]);
      if (!r.ok) throw new Error(r.error.cause);
      const msg = uiViewOf(r.value).inbox[0]?.msg;
      expect(msg).toEqual(d.msg);
      if (msg === undefined) throw new Error("msg がない");
      expect(inboxMessageText("ja", msg)).toBe(d.summary);
      const en = inboxMessageText("en", msg);
      expect(en).toBeDefined();
      expect(en).not.toContain("{");
    },
  );

  it("msg のない知らせ（古い記録・子や統合が書いたもの）は、msg を持たない", () => {
    const r = foldEvents([...base(), added({ summary: "子が書いた進み具合" })]);
    if (!r.ok) throw new Error(r.error.cause);
    expect(uiViewOf(r.value).inbox[0]).not.toHaveProperty("msg");
  });

  it("形の合わない msg の記録は、畳むときに断る", () => {
    const r = foldEvents([...base(), added({ summary: "x", msg: { key: "stall", args: [] } })]);
    expect(r.ok).toBe(false);
  });
});
