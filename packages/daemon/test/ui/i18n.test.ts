import { inboxMessage, placeholdersOf } from "@touryou/core";
import { describe, expect, it } from "vitest";
import {
  inboxItemText,
  LANGS,
  pickLang,
  storedLang,
  UI_TEXT,
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
