import { describe, expect, it } from "vitest";
import {
  type EventBody,
  fillMessage,
  foldEvents,
  INBOX_MESSAGE_LIMITS,
  INBOX_MESSAGES,
  inboxMessage,
  inboxMessageText,
  isInboxMessage,
  isInboxMessageKey,
  isStallSummary,
  LANGS,
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

  it("英語の文には、ひらがな・カタカナ・漢字を入れない。日本語の文には、それを入れる", () => {
    const cjk = /[぀-ヿ㐀-鿿]/;
    for (const [key, t] of entries) {
      expect(cjk.test(t.en), `${key}.en`).toBe(false);
      expect(cjk.test(t.ja), `${key}.ja`).toBe(true);
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
