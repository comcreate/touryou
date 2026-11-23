/**
 * 指示の復唱（Prompt Order Telegraph。#261）の、純粋な部分。I/O もハッシュの計算も持たない。
 *
 * - 復唱の中身は、指示の本文のハッシュ値（SHA-256 の先頭 `ECHO_LENGTH` 桁。計算は `@touryou/core/echo` の `instructionEcho`）。
 *   対象は、記録された本文（引用の印を付ける前）を `normalizeInstructionText` で正規化した文字列。
 * - ハッシュ値が確かめるのは、文字列の一致（受領・改変の検出）で、意味の理解ではない。秘密を守る境界でもない
 *   （短い指示は総当たりで当てられうる）。秘密を含む指示を送らない規則は変えない。
 * - 照合（`judgeEcho`）は、期待する値と受け取った値を比べるだけの純粋な関数。決定的で、再送しても同じ答えを返す。
 */

/** 復唱の桁数（16 進数）。親が目で比べられる長さ。 */
export const ECHO_LENGTH = 16;

const ECHO_SHAPE = /^[0-9a-f]{16}$/;

/** 復唱の形（小文字の 16 進数が `ECHO_LENGTH` 桁）か。 */
export const isEchoShape = (x: unknown): x is string => typeof x === "string" && ECHO_SHAPE.test(x);

/** 改行として扱うもの（CRLF・LF・CR・U+2028・U+2029。daemon の `quote` と同じ）。 */
const LINE_BREAKS = new RegExp("\\r\\n|[\\n\\r\\u2028\\u2029]");

/**
 * 指示の本文を、ハッシュを求める前に正規化する。改行を LF にそろえ、各行の末尾の空白と、
 * 本文の末尾の空行を除く。行の先頭の空白は意味を持ちうるので残す。
 */
export function normalizeInstructionText(text: string): string {
  return text
    .split(LINE_BREAKS)
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * 子に見せる引用の形（各行の頭に `> `。daemon の `quote`）から、記録された本文に戻す。頭の `> ` を 1 つだけ外す
 * （行の先頭の空白は、元の文の一部なので残す。daemon の `unquote` は、頭の空白も外すので、照合には使わない）。
 */
export function unquoteInstructionText(quoted: string): string {
  return quoted
    .split("\n")
    .map((line) => (line.startsWith("> ") ? line.slice(2) : line))
    .join("\n");
}

/** 復唱の判定。`missing`: 復唱がない（古い MCP・計算に失敗した）、`match`: 一致、`mismatch`: 食い違い。 */
export type EchoJudgement = "match" | "mismatch" | "missing";

/** 期待する値（記録した本文から求めた復唱）と、子が返した値を比べる。 */
export function judgeEcho(expected: string, received: string | undefined): EchoJudgement {
  if (received === undefined) return "missing";
  return received === expected ? "match" : "mismatch";
}
