/**
 * 状態画面の文字の表（#140）。app.js と graph.js（束）が同じ鍵を使う。
 *
 * - 表は、鍵 → { ja, en } の文字だけ（`{名前}` の差し込みだけを持つ。関数・HTML は持たない）。
 * - graph.js は、この表を import して束に入れる。app.js は、ui-assets.ts の組み立てで、この表を JSON にして埋め込む
 *   （同じ TS の表から作るので、鍵がずれない）。
 * - 差し込んだ文は、`textContent` で入れる（el・textContent・CSP の決まりは変えない）。
 * - 言語は、最初はブラウザの言語に合わせ（`pickLang`）、設定の窓（#139）で変えられる。選んだ言語は、ブラウザごとに覚える
 *   （利用者の決め）。覚える所は、#139 の `touryou.ui.settings` の 1 つの鍵の `lang` だけ（別の鍵・別の保存の場所は使わない）。
 * - daemon が書く知らせの文は、core の `INBOX_MESSAGES`。知らせに `msg` がなければ（古い記録・子や統合が書いた文）、
 *   どの言語でも `summary`（日本語）をそのまま出す（利用者の決め）。
 *
 * 画面の文字を、この表に移すのは、あとの段（#139 のマージのあと）。いまは、土台（表の形・言語の選び方・知らせの文の出し方）。
 */
import { fillMessage, type InboxMessage, inboxMessageText, LANGS, type Lang } from "@touryou/core";

export { LANGS, type Lang };

/** 画面の文字の表。鍵は小文字で始まる英数字と `.`（節ごとに分ける）。 */
export const UI_TEXT = {
  "lang.ja": { ja: "日本語", en: "Japanese" },
  "lang.en": { ja: "英語", en: "English" },
  "lang.label": { ja: "言語", en: "Language" },
} as const satisfies Readonly<Record<string, { readonly ja: string; readonly en: string }>>;

export type UiTextKey = keyof typeof UI_TEXT;

/** 画面の文字（`{名前}` を値で置き換える）。 */
export const uiString = (
  lang: Lang,
  key: UiTextKey,
  args: Readonly<Record<string, string | number>> = {},
): string => fillMessage(UI_TEXT[key][lang], args);

/** ブラウザの言語（`navigator.language` など）から、画面の言語を選ぶ。`ja` で始まれば日本語、ほかは英語。 */
export const pickLang = (browser: unknown): Lang =>
  typeof browser === "string" && /^ja(?:-|$)/i.test(browser) ? "ja" : "en";

/** 覚えておいた言語（形の合わない値は、使わない）。 */
export const storedLang = (x: unknown): Lang | undefined =>
  typeof x === "string" && (LANGS as readonly string[]).includes(x) ? (x as Lang) : undefined;

/**
 * 受信箱の知らせの、画面に出す文。daemon が書いた知らせ（`msg` つき・表にある鍵）は、選んだ言語の文にする。
 * そうでなければ（古い記録・子や統合が書いた文・知らない鍵）、`summary` をそのまま出す。
 */
export function inboxItemText(
  lang: Lang,
  item: { readonly summary?: string; readonly msg?: InboxMessage },
): string {
  const m = item.msg === undefined ? undefined : inboxMessageText(lang, item.msg);
  return m ?? item.summary ?? "";
}
