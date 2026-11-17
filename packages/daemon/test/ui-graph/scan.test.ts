import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bundleGraph, GRAPH_JS_PATH } from "../../../../scripts/ui-graph-bundle.mjs";

const DIR = new URL("../../src/ui-graph/", import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
/** 文字列・コメントを除いた、自前のコード。 */
const codeOf = (f: string): string =>
  readFileSync(new URL(f, DIR), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
const src = (f: string): string => readFileSync(new URL(f, DIR), "utf8");
const all = files.map(src).join("\n");

/** 図の自前のコード（束ねる前の `ui-graph/*.ts`）の走査。いまの app.js の走査と同じ決まり（#89。設計の下書き 6 節）。 */
describe("図の自前のコード（走査）", () => {
  const FORBIDDEN: readonly [string, RegExp][] = [
    ["innerHTML", /innerHTML/],
    ["outerHTML", /outerHTML/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["document.write", /document\s*\.\s*write/],
    ["eval", /\beval\s*\(/],
    ["new Function", /new\s+Function\b|\bFunction\s*\(/],
    ["setAttribute（名前空間なし）", /\.setAttribute\s*\(/],
    [".attributes", /\.attributes\b/],
    ["on* への代入", /\.on[a-z]+\s*=[^=]/],
    ["location", /\blocation\b/],
    ["srcdoc", /srcdoc/],
    ["文字列の setTimeout・setInterval", /set(Timeout|Interval)\s*\(\s*['"`]/],
    ["storage・cookie", /localStorage|sessionStorage|document\s*\.\s*cookie|indexedDB/],
    ["importScripts・動的 import", /importScripts|\bimport\s*\(/],
    ["postMessage・window.open", /postMessage|window\s*\.\s*open/],
    ["fetch・XMLHttpRequest・WebSocket", /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/],
    [
      "HTML を解釈する API",
      /setHTMLUnsafe|parseHTMLUnsafe|setHTML\b|createContextualFragment|DOMParser|createRange/,
    ],
    ["href・src・action への代入", /\.(href|src|action|formAction)\s*=[^=]/],
    [
      "style 属性・cssText・<style>",
      /cssText|setProperty|createElement\s*\(\s*["'`]style|adoptedStyleSheets|CSSStyleSheet/,
    ],
  ];
  for (const [name, re] of FORBIDDEN)
    it(`${name} を使わない`, () => {
      for (const f of files) expect(re.test(codeOf(f)), `${f}: ${name}`).toBe(false);
    });

  it("SVG を作るのは svg-el.ts の 1 か所だけ（createElementNS・setAttributeNS を数える）", () => {
    expect([...all.matchAll(/createElementNS/g)]).toHaveLength(1);
    expect([...all.matchAll(/setAttributeNS/g)]).toHaveLength(1);
    expect(src("svg-el.ts")).toMatch(/document\.createElementNS\(NS, tag\)/);
    expect(src("svg-el.ts")).toContain('new Set(["svg", "g", "path", "rect", "text", "title"])');
    expect(src("svg-el.ts")).toContain('new Set(["x", "y", "width", "height", "rx"])');
  });

  it("offsetPath を設定するのは graph-path.ts の setRunnerPath の 1 か所だけ。.style の使い方はそこだけ", () => {
    expect([...all.matchAll(/offsetPath/g)]).toHaveLength(1);
    expect([...all.matchAll(/\.style\b/g)]).toHaveLength(1);
    const fn = src("graph-path.ts").slice(
      src("graph-path.ts").indexOf("export function setRunnerPath"),
    );
    expect(fn).toMatch(
      /if \(!PATH_PATTERN\.test\(d\)\) throw[^\n]*\n\s*dot\.style\.offsetPath = `path\('\$\{d\}'\)`/,
    );
  });

  it("HTML の要素を作るのは el の 1 か所（div・span だけ）。el に渡すタグも div・span だけ", () => {
    expect([...all.matchAll(/createElement\(/g)]).toHaveLength(1);
    expect(src("graph-entry.ts")).toContain("Object.hasOwn(TAGS, tag)");
    const tags = [...all.matchAll(/\bel\(\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(tags.length).toBeGreaterThan(2);
    for (const t of tags) expect(["div", "span"]).toContain(t);
    const svgTags = [...all.matchAll(/\bsvgEl\(\s*"([^"]*)"/g)].map((m) => m[1]);
    for (const t of svgTags) expect(["svg", "g", "path", "rect", "text", "title"]).toContain(t);
  });

  it("許可リスト: `.` の後ろのプロパティ名（DOM に触れるもの）は、安全な集合にあるものだけ", () => {
    const DOM_SAFE = new Set([
      "textContent",
      "className",
      "dataset",
      "id",
      "style",
      "offsetPath",
      "append",
      "replaceChildren",
      "createElement",
      "createElementNS",
      "setAttributeNS",
    ]);
    // document・要素に対する操作として使う名前（ほかは配列・Map・数の操作）
    const DOM_LIKE =
      /^(textContent|innerText|className|classList|dataset|style|offsetPath|append\w*|prepend|replace\w*|insert\w*|create\w*|set\w*|remove\w*|outer\w*|inner\w*|attributes|on\w+|href|src)$/;
    const used = new Set(
      files.flatMap((f) =>
        [...codeOf(f).matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1] as string),
      ),
    );
    expect(used.has("textContent")).toBe(true);
    const unknown = [...used].filter((x) => DOM_LIKE.test(x) && !DOM_SAFE.has(x) && x !== "set");
    expect(unknown).toEqual([]);
  });
});

/** 束ねたあとの graph.js（ライブラリを含む）。いまの走査の外なので、禁止の API の不在を確かめる（版を上げるたびに通す）。 */
describe("束ねた graph.js（禁止の API の不在）", async () => {
  const js = await bundleGraph();
  const BANNED: readonly [string, RegExp][] = [
    ["eval", /\beval\s*\(/],
    ["new Function・Function(", /new\s+Function\b|\bFunction\s*\(/],
    ["document.write", /document\s*\.\s*write/],
    ["<style> の差し込み", /createElement\(\s*["'`]style|<style/i],
    ["adoptedStyleSheets・CSSStyleSheet", /adoptedStyleSheets|CSSStyleSheet|insertRule/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["outerHTML", /outerHTML/],
    ["innerHTML への空でない代入", /innerHTML\s*(?:\+?=)\s*(?!""|''|``)/],
    ["innerHTML を読む", /innerHTML(?!\s*=)/],
    ['setAttribute("style"', /setAttribute\(\s*["'`]style/],
    ["cssText", /cssText/],
    ["動的 import・importScripts", /\bimport\s*\(|importScripts/],
    ["postMessage・window.open", /postMessage|window\s*\.\s*open/],
    ["storage・cookie", /localStorage|sessionStorage|document\s*\.\s*cookie|indexedDB/],
    ["通信", /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/],
    ["大域の regeneratorRuntime", /regeneratorRuntime\s*=/],
    ["文字列の setTimeout・setInterval", /set(Timeout|Interval)\s*\(\s*["'`]/],
    ["srcdoc", /srcdoc/],
    ['setAttribute("on…', /setAttribute(NS)?\(\s*(null\s*,\s*)?["'`]on/i],
  ];
  for (const [name, re] of BANNED)
    it(`${name} がない`, () => {
      const m = re.exec(js);
      expect(m === null ? "" : js.slice(Math.max(0, m.index - 60), m.index + 60), name).toBe("");
    });

  it("SVG を作るのは自前の svgEl の 1 か所だけ（ライブラリは createElementNS・setAttributeNS を使わない）", () => {
    const ns = [...js.matchAll(/createElementNS/g)];
    expect(ns).toHaveLength(1);
    expect(js.slice(Math.max(0, (ns[0]?.index ?? 0) - 80), ns[0]?.index)).toContain("svgEl:");
    expect([...js.matchAll(/setAttributeNS/g)]).toHaveLength(1);
  });

  it("置いてある束（packages/daemon/ui-graph/graph.js）は、lockfile の版から作り直したものと一致する", () => {
    expect(
      readFileSync(GRAPH_JS_PATH, "utf8") === js,
      "node scripts/ui-graph-bundle.mjs --write で作り直す",
    ).toBe(true);
    // 入っている版が、package.json の固定の版・lockfile と同じ
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const lock = readFileSync(new URL("../../../../pnpm-lock.yaml", import.meta.url), "utf8");
    const req = createRequire(new URL("../../package.json", import.meta.url));
    for (const name of ["rete", "rete-area-plugin", "rete-readonly-plugin"]) {
      const pinned = pkg.devDependencies[name] as string;
      expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock).toContain(`${name}@${pinned}`);
      expect(JSON.parse(readFileSync(req.resolve(`${name}/package.json`), "utf8")).version).toBe(
        pinned,
      );
    }
    expect(js).not.toMatch(/\/home\/|\/Users\/|node_modules/); // 手元のパスを含まない（どこで作っても同じ）
  });

  it("入口（window.touryouGraph.drawGraph）がある。グローバルに出す名前は touryouGraph の 1 つ。rete-connection-plugin は入らない。大きさ（gzip）は 20 KB 以下", () => {
    expect(js).toMatch(/^"use strict";var touryouGraph=|^var touryouGraph=/);
    expect(js).not.toMatch(/\b(window|globalThis|self)\.[A-Za-z_$][\w$]*\s*=[^=]/); // ほかの名前を大域に置かない
    expect(js).toContain("drawGraph");
    expect(js).not.toContain("rete-connection-plugin");
    expect(gzipSync(js).length).toBeLessThanOrEqual(20 * 1024);
  });
});
