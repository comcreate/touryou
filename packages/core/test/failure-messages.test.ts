import { describe, expect, it } from "vitest";
import {
  FAILURE_MESSAGES,
  failureMessageText,
  failureMsg,
  isFailure,
  isFailureMessage,
  LANGS,
  placeholdersOf,
} from "../src/index.js";

describe("失敗の文の表（#141）", () => {
  it("どの鍵も、日本語と英語の両方を持ち、空でない。差し込みの名前は両方で同じ。英語に日本語の文字を入れない", () => {
    const cjk = /[぀-ヿ㐀-鿿]/;
    for (const [key, t] of Object.entries(FAILURE_MESSAGES)) {
      expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
      for (const lang of LANGS) expect(t[lang].trim().length, `${key}.${lang}`).toBeGreaterThan(0);
      expect(placeholdersOf(t.en), key).toEqual(placeholdersOf(t.ja));
      expect(cjk.test(t.en), `${key}.en`).toBe(false);
    }
  });

  it("failureMsg: cause は日本語の文（これまでと同じ）、msg は鍵と値。nextActions は日本語のまま、isFailure も通る", () => {
    const f = failureMsg(
      "confirmationInvalid",
      "confirmationWrongCode",
      { left: 2 },
      "もう一度打つ",
    );
    expect(f.code).toBe("confirmationInvalid");
    expect(f.cause).toBe("コードが違う（残り 2 回）");
    expect(f.nextActions).toEqual(["もう一度打つ"]);
    expect(f.msg).toEqual({ key: "confirmationWrongCode", args: { left: 2 } });
    expect(isFailure(f)).toBe(true);
    expect(isFailureMessage(f.msg)).toBe(true);
    expect(failureMessageText("en", f.msg as never)).toBe("Wrong code (2 attempts left)");
  });

  it("並びの値（名前が List で終わる）は、言語の区切りでつなぐ。空は「なし」「none」。Key の値は、その鍵の文にする", () => {
    const m = {
      key: "tipUnknownDone",
      args: { whenKey: "whenBeforeReclaim", idsList: "a,b,c", doneList: "" },
    };
    expect(failureMessageText("ja", m)).toBe(
      "回収の前に、ブランチの先端を取得できない（不明）ノード: a、b、c（回収済み: なし）",
    );
    expect(failureMessageText("en", m)).toBe(
      "Before reclaiming, the branch tip could not be read (unknown) for node(s): a, b, c (already reclaimed: none)",
    );
  });

  it("表にない鍵は undefined。値の制御文字は空白にし、長すぎる値は切る", () => {
    expect(failureMessageText("en", { key: "noSuchKey", args: {} })).toBeUndefined();
    const f = failureMsg("forbidden", "roleLacksOperation", { role: "a\nb", op: "x".repeat(2000) }, "直す");
    const args = (f.msg as { args: Record<string, string> }).args;
    expect(args.role).toBe("a b");
    expect(args.op).toHaveLength(1000);
  });

  it("isFailureMessage: 形の合わないものを断る", () => {
    expect(isFailureMessage(undefined)).toBe(false);
    expect(isFailureMessage({ key: 1, args: {} })).toBe(false);
    expect(isFailureMessage({ key: "a", args: [] })).toBe(false);
    expect(isFailureMessage({ key: "a", args: { x: {} } })).toBe(false);
  });
});
