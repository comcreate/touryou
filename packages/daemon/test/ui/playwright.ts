/**
 * 試験で使う Playwright（#89）。依存に加えず、環境にあるもの（`TOURYOU_PLAYWRIGHT` のパスか `playwright`）を読む。
 * 見つからなければ `pw` は null（その試験は飛ばす。CI で流す道は docs/ui.md）。
 */
import { createRequire } from "node:module";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Loc {
  count(): Promise<number>;
  textContent(): Promise<string | null>;
  boundingBox(): Promise<Box | null>;
}
export interface Msg {
  type(): string;
  text(): string;
}
export interface Page {
  on(event: "console", f: (m: Msg) => void): void;
  on(event: "pageerror", f: (e: Error) => void): void;
  addInitScript(f: () => void): Promise<void>;
  goto(url: string): Promise<unknown>;
  addScriptTag(o: { url: string }): Promise<unknown>;
  close(): Promise<void>;
  waitForSelector(s: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<R, A = undefined>(f: (a: A) => R, a?: A): Promise<R>;
  locator(s: string): Loc;
  screenshot(o: { path: string }): Promise<unknown>;
  emulateMedia(o: { reducedMotion: "reduce" | "no-preference" }): Promise<void>;
  request: { get(url: string): Promise<{ headers(): Record<string, string> }> };
  mouse: {
    move(x: number, y: number, o?: { steps: number }): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
  };
}
export interface Browser {
  newPage(o: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
}
export type Pw = { chromium: { launch(): Promise<Browser> } };
export type Win = Window & { __csp?: string[] };
const require = createRequire(import.meta.url);
export const pw: Pw | null = (() => {
  try {
    return require(process.env.TOURYOU_PLAYWRIGHT ?? "playwright") as Pw;
  } catch {
    return null;
  }
})();

export const must = <T>(x: T | null): T => {
  if (x === null) throw new Error("missing");
  return x;
};
