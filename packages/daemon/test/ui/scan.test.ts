import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bundleGraph, GRAPH_JS_PATH, graphModule } from "../../../../scripts/ui-graph-bundle.mjs";
import { UI_GRAPH_JS } from "../../src/api/ui-graph-js.js";

const DIR = new URL("../../src/ui/", import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
/** 文字列・コメントを除いた、自前のコード。 */
const codeOf = (f: string): string =>
  readFileSync(new URL(f, DIR), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
const src = (f: string): string => readFileSync(new URL(f, DIR), "utf8");
const all = files.map(src).join("\n");

/** 図の自前のコード（束ねる前の `src/ui/*.ts`）の走査。いまの app.js の走査と同じ決まり（#89。設計の下書き 6 節）。 */
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
    const tags = ["svg", "g", "path", "rect", "text", "title"];
    for (const tag of tags) expect(src("svg-el.ts")).toMatch(new RegExp(`TAGS[^;]*"${tag}"`));
    // 彗星の mask・グラデーションは、流星に置き換えたので、タグも許可しない
    for (const tag of ["defs", "mask", "linearGradient", "stop"])
      expect(src("svg-el.ts")).not.toContain(`"${tag}"`);
    expect(src("svg-el.ts")).toContain('new Set(["x", "y", "width", "height", "rx"])');
  });

  it("要素の style・offsetPath には触らない（流星・火花は SVG の path・g と CSS のクラスだけで動く）", () => {
    expect([...all.matchAll(/offsetPath/g)]).toHaveLength(0);
    expect([...all.matchAll(/\.style\b/g)]).toHaveLength(0);
  });

  it("流星は、線と同じ d の重ね線（pathLength=100）で、彗星（mask・id）は残っていない。属性は pathLength=100 と translate だけ", () => {
    const entry = src("graph-entry.ts");
    // 重ね線は、線の `d` をそのまま使う（尾・頭・芯の 3 本）
    expect(entry).toContain('svgEl("path", { class: `${k} ${cls}`, d: s.d, pathLength: 100 })');
    expect(entry).toContain("if (s.meteor !== undefined) svg.append(...meteorOf(s, look));");
    // 火花は、流星のある線すべて（上りは強く、下りは弱く）
    expect(entry).toContain("if (s.meteor !== undefined) svg.append(sparkOf(s, look));");
    // 流す本数の上限は、上り 3 本・下り 2 本
    expect(entry).toContain("{ strong: 3, weak: 2 }");
    // 縁の光は答え待ち・失敗の箱だけ（stall には出ない）。上限を超える分は光らせない。選び方は graph-model.ts の glowIdsOf（試験は graph-glow.test.ts）
    expect(entry).toContain("glowIdsOf(model.nodes, GLOW_MAX)");
    const model = src("graph-model.ts");
    expect(model).toContain('.filter((n) => n.status === "wait" || n.status === "fail")');
    expect(model).toContain(".slice(0, max)");
    expect(entry).not.toContain('n.status === "stall"');
    expect(model).not.toContain('n.status === "stall"');
    expect(entry).not.toMatch(/comet/i);
    const el = src("svg-el.ts");
    expect(el).not.toMatch(/comet|mask|maskUnits/i);
    expect(el).toContain("TRANSLATE_PATTERN");
    expect(el).toContain("if (v !== 100) throw new Error(`svgEl: ${name}`);");
  });

  it("合図の受け手は addEventListener だけで付け、どれも destroy で外れる形（signal）。文字列の受け手は使わない", () => {
    const entry = codeOf("graph-entry.ts");
    const adds = [...entry.matchAll(/addEventListener\(/g)].length;
    expect(adds).toBeGreaterThan(0);
    // どの addEventListener も、destroy で abort する signal を付ける
    expect([...entry.matchAll(/\bopt,?\s*\)/g)].length).toBe(adds);
    expect(src("graph-entry.ts")).toContain("const opt = { signal: ac.signal };");
    expect(src("graph-entry.ts")).toMatch(/listening\?\.abort\(\);/);
    for (const f of files)
      expect(codeOf(f)).not.toMatch(/\.on[a-z]+\s*=|setAttribute(NS)?\(\s*[^,]*["'`]on/);
  });

  it("HTML の要素を作るのは el の 1 か所（div・span だけ）。el に渡すタグも div・span だけ", () => {
    expect([...all.matchAll(/createElement\(/g)]).toHaveLength(1);
    expect(src("graph-entry.ts")).toContain("Object.hasOwn(TAGS, tag)");
    const tags = [...all.matchAll(/\bel\(\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(tags.length).toBeGreaterThan(2);
    for (const t of tags) expect(["div", "span"]).toContain(t);
    const svgTags = [...all.matchAll(/\bsvgEl\(\s*"([^"]*)"/g)].map((m) => m[1]);
    for (const t of svgTags)
      expect([
        "svg",
        "g",
        "path",
        "rect",
        "text",
        "title",
        "defs",
        "mask",
        "linearGradient",
        "stop",
      ]).toContain(t);
  });

  it("許可リスト: `.` の後ろのプロパティ名（DOM に触れるもの）は、安全な集合にあるものだけ", () => {
    const DOM_SAFE = new Set([
      "textContent",
      "className",
      "classList",
      "remove",
      // draw の 3 つめの引数の受け手（画面の関数。読むだけで、要素の属性には入れない）
      "onPick",
      "dataset",
      "id",
      "append",
      "replaceChildren",
      "createElement",
      "createElementNS",
      "setAttributeNS",
      // 中ボタンでの移動（ポインタを捕まえる。文字列は渡さない）と、札の地の置き換え（要素どうし）
      "setPointerCapture",
      "replaceWith",
      // 「何分前」を計算し直す interval（#204。関数だけを渡す。文字列は渡さない）
      "setInterval",
      // 図の言葉の差し込み（#140。graph-text.ts の文字列の replace。DOM には触れない）
      "replace",
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

/** 束に禁じた API の一覧（名前と、見つける形）。 */
const BANNED: readonly [string, RegExp][] = [
  ["eval", /\beval\s*\(/],
  ["new Function・Function(", /new\s+Function\b|\bFunction\s*\(/],
  ["document.write", /document\s*\.\s*write/],
  ["<style> の差し込み", /createElement\(\s*["'`]style|<style/i],
  ["adoptedStyleSheets・CSSStyleSheet", /adoptedStyleSheets|CSSStyleSheet|insertRule/],
  ['setAttribute("style"', /setAttribute\(\s*["'`]style/],
  ["cssText", /cssText/],
  ["動的 import・importScripts", /\bimport\s*\(|importScripts/],
  ["postMessage・window.open", /postMessage|window\s*\.\s*open/],
  ["storage・cookie", /localStorage|sessionStorage|document\s*\.\s*cookie|indexedDB/],
  ["通信", /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/],
  ["大域の regeneratorRuntime", /regeneratorRuntime\s*=/],
  ["文字列の setTimeout・setInterval", /set(Timeout|Interval)\s*\(\s*["'`]/],
  ['setAttribute("on…', /setAttribute(NS)?\(\s*(null\s*,\s*)?["'`]on/i],
  // 角括弧で、文字の名前を書いて触る形（`e["innerHTML"]` など。下の数えからも、すり抜けない）
  [
    "角括弧の文字の名前で、危ない名前に触る",
    /\[\s*["'`](?:\w*HTML\w*|srcdoc|on[a-z]+|eval|Function|write\w*|cookie|setAttribute\w*|src|href)["'`]\s*\]/i,
  ],
];
/** HTML を解釈する名前。出てきてよいのは `.innerHTML=""` のあとが `;`・`,`・`}`・`)` で終わる形だけ。 */
const HTML_SINKS =
  /innerHTML|outerHTML|insertAdjacentHTML|srcdoc|setHTML|createContextualFragment|DOMParser/g;
const EMPTY_INNER_HTML = /\.innerHTML\s*=\s*(?:""|''|``)(?=\s*[;,})]|\s*$)/g;

/** 束（文字）から、禁じた API を見つけて、その名前を返す。 */
export function bannedIn(js: string): string[] {
  const found = BANNED.filter(([, re]) => re.test(js)).map(([name]) => name);
  const sinks = [...js.matchAll(HTML_SINKS)].length;
  const allowed = [...js.matchAll(EMPTY_INNER_HTML)].length;
  if (sinks !== allowed)
    found.push(`HTML を解釈する名前（${sinks} か所。許す形は ${allowed} か所）`);
  return found;
}

describe("禁止の API の見つけ方（すり抜ける書き方を見つける）", () => {
  it.each([
    'a.innerHTML=""+x;',
    'a.innerHTML = "" + html;',
    'a.outerHTML=""+x;',
    "a.innerHTML=``+x;",
    'a.innerHTML=""\n+x;',
    "a.innerHTML+=x;",
    'a.innerHTML="<b>";',
    'e["innerHTML"]=x;',
    "e['outerHTML']=x;",
    "e[`insertAdjacentHTML`](0,x);",
    'a.outerHTML="";',
    "x=a.innerHTML;",
    'f.srcdoc="x";',
    'f["srcdoc"]=x;',
    'e["onclick"]=x;',
    'a.setAttribute("onload","x");',
    'Function("x")();',
    "setTimeout('x()',1);",
  ])("%s を見つける", (code) => {
    expect(bannedIn(code)).not.toEqual([]);
  });
  it("中身を消すだけの形は通す", () => {
    expect(bannedIn('a.innerHTML="";b.innerHTML=""}c(d.innerHTML=""),e.innerHTML="",f')).toEqual(
      [],
    );
  });
});

/** 束ねたあとの graph.js（ライブラリを含む）。いまの走査の外なので、禁止の API の不在を確かめる（版を上げるたびに通す）。 */
describe("束ねた graph.js（禁止の API の不在）", async () => {
  const js = await bundleGraph();
  it('禁じた API がない（innerHTML は `=""` で中身を消す形だけ）', () => {
    expect(bannedIn(js)).toEqual([]);
    expect([...js.matchAll(EMPTY_INNER_HTML)].length).toBe(1); // rete-area-plugin の destroy の 1 か所
  });

  it("ライセンスの表示（MIT）が、束の頭に残る", () => {
    expect(js.startsWith("/*!")).toBe(true);
    for (const name of ["rete@2.0.6", "rete-area-plugin@2.3.2", "rete-readonly-plugin@2.0.2"])
      expect(js).toContain(`${name} — MIT — (c) Vitaliy Stoliarov`);
    expect(js).toContain("@babel/runtime@");
    expect(js).toContain("Permission is hereby granted, free of charge");
  });

  it("SVG を作るのは自前の svgEl の 1 か所だけ（ライブラリは createElementNS・setAttributeNS を使わない）", () => {
    const ns = [...js.matchAll(/createElementNS/g)];
    expect(ns).toHaveLength(1);
    expect(js.slice(Math.max(0, (ns[0]?.index ?? 0) - 80), ns[0]?.index)).toContain("svgEl:");
    expect([...js.matchAll(/setAttributeNS/g)]).toHaveLength(1);
  });

  it("置いてある束（UI_GRAPH_JS）は、lockfile の版から作り直したものと一致する", () => {
    const hint = "node scripts/ui-graph-bundle.mjs --write で作り直す";
    expect(UI_GRAPH_JS === js, hint).toBe(true);
    expect(readFileSync(GRAPH_JS_PATH, "utf8") === graphModule(js), hint).toBe(true);
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

  it("外に出すのは window.touryouGraph（draw・destroy）の 1 つだけ。rete-connection-plugin は入らない。大きさ（gzip）は 20 KB 以下", () => {
    expect(js).toMatch(/\*\/\n(?:"use strict";)?var touryouGraph=/);
    expect(js).not.toMatch(/\b(window|globalThis|self)\.[A-Za-z_$][\w$]*\s*=[^=]/); // ほかの名前を大域に置かない
    const g = runInNewContext(`${js};touryouGraph`, {}) as Record<string, unknown>;
    expect(Object.keys(g).sort()).toEqual(["destroy", "draw"]);
    expect(js).not.toContain("rete-connection-plugin");
    expect(gzipSync(js).length).toBeLessThanOrEqual(20 * 1024);
  });
});
