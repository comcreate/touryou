/**
 * 指示の復唱のハッシュ値の計算（`@touryou/core/echo`）。`node:crypto` を使うので、core の主の入口には入れない
 * （主の入口は、Node の API を持たない）。daemon（記録した本文から期待する値を求める）と mcp（受け取った本文から復唱を求める）が、
 * 同じ関数を使う。純粋な正規化・照合は `instruction-echo.ts`。
 */

import { createHash } from "node:crypto";

import { ECHO_LENGTH, normalizeInstructionText } from "./instruction-echo.js";

/** 指示の本文（引用の印を付ける前）の復唱。正規化した文字列の SHA-256 の先頭 `ECHO_LENGTH` 桁。 */
export function instructionEcho(text: string): string {
  return createHash("sha256")
    .update(normalizeInstructionText(text), "utf8")
    .digest("hex")
    .slice(0, ECHO_LENGTH);
}
