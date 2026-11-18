import { runInNewContext } from "node:vm";
import {
  INBOX_MESSAGE_LIMITS,
  INBOX_MESSAGES,
  type InboxMessage,
  inboxMessage,
  inboxMessageText,
  messagePart,
  placeholdersOf,
} from "@touryou/core";
import { describe, expect, it } from "vitest";
import { UI_HTML, UI_JS } from "../../src/api/ui-assets.js";
import { GRAPH_TEXT, type Lang as GraphLang, graphString } from "../../src/ui/graph-text.js";
import {
  inboxItemText,
  LANGS,
  type Lang,
  pickLang,
  storedLang,
  UI_TEXT,
  type UiTextKey,
  uiString,
} from "../../src/ui/i18n.js";

describe("画面の文字の表（#140）", () => {
  it("どの鍵も、日本語と英語の両方を持ち、空でない。差し込みの名前は両方で同じ。英語に日本語の文字を入れない", () => {
    const cjk = /[぀-ヿ㐀-鿿]/;
    for (const [key, t] of Object.entries(UI_TEXT)) {
      expect(key).toMatch(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/);
      for (const lang of LANGS) expect(t[lang].trim().length, `${key}.${lang}`).toBeGreaterThan(0);
      expect(placeholdersOf(t.en), key).toEqual(placeholdersOf(t.ja));
      expect(cjk.test(t.en), `${key}.en`).toBe(false);
    }
    expect(uiString("en", "lang.label")).toBe("Language");
  });

  it("pickLang：ブラウザの言語が ja で始まれば日本語、ほかは英語。storedLang は、表にある言語だけ", () => {
    expect(pickLang("ja")).toBe("ja");
    expect(pickLang("ja-JP")).toBe("ja");
    expect(pickLang("en-US")).toBe("en");
    expect(pickLang("jav")).toBe("en");
    expect(pickLang(undefined)).toBe("en");
    expect(storedLang("en")).toBe("en");
    expect(storedLang("fr")).toBe(undefined);
    expect(storedLang(1)).toBe(undefined);
  });

  it("inboxItemText：daemon が書いた知らせは、選んだ言語の文。msg のない・知らない鍵の知らせは、summary のまま（利用者の決め）", () => {
    const m = inboxMessage("unreadInstruction", { node: "c1", seq: 7, minutes: 10 });
    const item = { summary: m.summary, msg: m.msg };
    expect(inboxItemText("ja", item)).toBe(m.summary);
    expect(inboxItemText("en", item)).toBe(
      "Child c1 has not picked up instruction #7 after 10 min. Check that the child is running",
    );
    expect(inboxItemText("en", { summary: "子が書いた進み具合" })).toBe("子が書いた進み具合");
    expect(inboxItemText("en", { summary: "古い", msg: { key: "laterKey", args: {} } })).toBe(
      "古い",
    );
    expect(inboxItemText("en", {})).toBe("");
  });
});

describe("画面（app.js・HTML・図）の文字は、表から引く（#140）", () => {
  const fnOf = (name: string): string => {
    const i = UI_JS.indexOf(`  function ${name}(`);
    expect(i, name).toBeGreaterThan(-1);
    return UI_JS.slice(i, UI_JS.indexOf("\n  }\n", i) + 5);
  };
  const lineOf = (prefix: string): string => {
    const i = UI_JS.indexOf(`  ${prefix}`);
    expect(i, prefix).toBeGreaterThan(-1);
    return UI_JS.slice(i, UI_JS.indexOf("\n", i));
  };
  const app = runInNewContext(
    [
      lineOf("var TEXT ="),
      lineOf("var MESSAGES ="),
      lineOf("var SEPS ="),
      lineOf("var MESSAGE_DEPTH_MAX ="),
      lineOf("var PLACEHOLDER ="),
      "var lang = 'ja';",
      fnOf("t"),
      fnOf("msgText"),
      fnOf("itemText"),
      fnOf("browserLang"),
      "({ setLang: function (l) { lang = l; }, t: t, msgText: msgText, itemText: itemText, browserLang: browserLang })",
    ].join("\n"),
    { navigator: undefined as unknown },
  ) as {
    setLang(l: Lang): void;
    t(key: string, args?: Record<string, unknown>): string;
    msgText(m: unknown): string | null;
    itemText(i: unknown): string;
    browserLang(): Lang;
  };

  it("app.js の知らせの文は、core の inboxMessageText と同じ（どの鍵も、両方の言語で。並べる部分も）", () => {
    const samples: InboxMessage[] = Object.entries(INBOX_MESSAGES).map(([key, t]) => ({
      key,
      args: Object.fromEntries(placeholdersOf(t.ja).map((p, i) => [p, `v${i}`])),
    }));
    samples.push(
      inboxMessage(
        "resumeSkipped",
        { decision: "d1" },
        {
          children: {
            sep: "comma",
            items: [
              messagePart("resumeSkippedChild", { node: "c1", reasonKey: "notResumedDiscarded" }),
            ],
          },
        },
      ).msg,
      inboxMessage("needsInput", { node: "c1", labelKey: "labelIdlePrompt" }).msg,
      { key: "laterKey", args: {} },
      {
        key: "digestTop",
        args: {},
        parts: { items: { sep: "comma", items: [{ key: "nope", args: {} }] } },
      },
    );
    for (const lang of LANGS) {
      app.setLang(lang);
      for (const m of samples)
        expect(app.msgText(m) ?? undefined, `${lang} ${m.key}`).toBe(inboxMessageText(lang, m));
      expect(app.itemText({ summary: "子が書いた文" })).toBe("子が書いた文");
    }
    app.setLang("ja");
  });

  it("app.js は、並べる部分を記録の検査と同じ深さ（INBOX_MESSAGE_LIMITS.depth）までしかたどらない", () => {
    const item = { key: "value", args: { value: "a" } };
    const deep = (d: number): unknown =>
      d === 0
        ? item
        : { key: "digestTop", args: {}, parts: { items: { sep: "none", items: [deep(d - 1)] } } };
    expect(app.msgText(deep(INBOX_MESSAGE_LIMITS.depth - 1))).not.toBe(null);
    expect(app.msgText(deep(INBOX_MESSAGE_LIMITS.depth))).toBe(null);
    expect(app.itemText({ summary: "s", msg: deep(50) })).toBe("s");
  });

  it("app.js のブラウザの言語の選び方は、pickLang と同じ", () => {
    for (const language of ["ja", "ja-JP", "JA", "en-US", "jav", "fr", "", undefined]) {
      const pick = runInNewContext(`${fnOf("browserLang")}\nbrowserLang()`, {
        navigator: { language },
      }) as Lang;
      expect(pick, String(language)).toBe(pickLang(language));
    }
    expect(app.browserLang()).toBe("en"); // navigator がなければ英語
  });

  it("app.js が引く鍵・ページの data-t の鍵は、どれも表にある", () => {
    const keys = new Set<string>();
    for (const m of UI_JS.matchAll(/\bt\('([a-z][A-Za-z0-9.]*)'/g)) keys.add(m[1] as string);
    for (const m of UI_HTML.matchAll(/data-t(?:-aria|-title)?="([^"]+)"/g))
      keys.add(m[1] as string);
    // 名前の表（STATE_NAMES など）の値も鍵
    for (const name of [
      "STATE_NAMES",
      "ROLE_NAMES",
      "KIND_NAMES",
      "FLOW_KIND_NAMES",
      "PRIORITY_NAMES",
      "STATUS_TEXT",
      "RUN_TEXT",
      "DECISION_LABELS",
      "DECISION_NOTES",
      "KIND_LABELS",
      "SUMMARY_WORDS",
      "NOT_RESUMED_TEXT",
      "CONFIRM_OP_LABELS",
      "UNMET_NAMES",
      "HOLD_CHOICES",
      "CLOSED_REASON",
    ]) {
      const at = UI_JS.indexOf(`var ${name} = `);
      expect(at, name).toBeGreaterThan(-1);
      const body = UI_JS.slice(at, UI_JS.indexOf(";", at));
      const vals = [...body.matchAll(/: '([a-z][A-Za-z0-9]*\.[A-Za-z0-9.]+)'/g)].map(
        (m) => m[1] as string,
      );
      expect(vals.length, name).toBeGreaterThan(0);
      for (const v of vals) keys.add(v);
    }
    expect(keys.size).toBeGreaterThan(200);
    for (const k of keys) expect(Object.hasOwn(UI_TEXT, k), k).toBe(true);
  });

  it("app.js のコードに、日本語の文字を書かない（表・コメント・古い記録の見分け・日本語の文の言い換えを除く）", () => {
    const cjk = /[぀-ヿ㐀-鿿]/;
    const left = UI_JS.split("\n")
      .filter((l) => !/^ {2}var (TEXT|MESSAGES|SEPS|EXTERNAL_CHECK_PREFIXES) = /.test(l))
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => cjk.test(l))
      // 日本語の summary（msg のない古い知らせ）の内部の言葉の言い換え（日本語の画面だけ）
      .filter((l) => !l.includes("out.replace(/範囲の拡張要求"));
    expect(left).toEqual([]);
  });

  it("ページの HTML の日本語の文字は、どれも data-t の要素の中（言語の名前・title を除く）", () => {
    const cjk = /[぀-ヿ㐀-鿿]/;
    const bad: string[] = [];
    for (const m of UI_HTML.matchAll(/<([a-z0-9]+)([^>]*)>([^<]*)</g)) {
      const [, tag, attrs, text] = m as unknown as [string, string, string, string];
      if (!cjk.test(text)) continue;
      if (/data-t="/.test(attrs) || /\blang="ja"/.test(attrs) || tag === "title") continue;
      bad.push(text);
    }
    expect(bad).toEqual([]);
    // 属性の日本語（aria-label・title）は、data-t-aria・data-t-title で置き換える
    for (const m of UI_HTML.matchAll(/<[a-z0-9]+([^>]*)>/g)) {
      const attrs = m[1] as string;
      if (/aria-label="[^"]*[぀-ヿ㐀-鿿]/.test(attrs)) expect(attrs).toContain("data-t-aria=");
      if (/\stitle="[^"]*[぀-ヿ㐀-鿿]/.test(attrs)) expect(attrs).toContain("data-t-title=");
    }
  });

  it("図の言葉の表（graph-text.ts）は、画面の表と同じ言葉。図の言語は core の LANGS と同じ", () => {
    for (const [k, v] of Object.entries(GRAPH_TEXT)) expect(UI_TEXT[k as UiTextKey], k).toEqual(v);
    const langs: readonly GraphLang[] = LANGS;
    expect(langs).toEqual(["ja", "en"]);
    expect(graphString("en", "graph.boxLabel", { title: "a", status: "b" })).toBe("a. b");
  });
});
