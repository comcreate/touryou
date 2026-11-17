/**
 * 関係図（`/ui/graph.js`）の束ね（#89 の試作）。esbuild で、自前の入口（`packages/daemon/src/ui/graph-entry.ts`）と
 * rete・rete-area-plugin・rete-readonly-plugin を 1 つの IIFE にする（グローバルに出す名前は `touryouGraph` の 1 つ。`draw`・`destroy` だけ）。
 * いまは試験の中だけで使う（配布物の画面には、まだ出さない。PR-5 で配る）。
 * 束は `UI_GRAPH_JS`（`packages/daemon/ui-graph/ui-graph-js.ts` の文字列）として置き、試験で、lockfile の版から作り直したものと一致することを確かめる。
 * 使い方: node scripts/ui-graph-bundle.mjs（大きさを出す）／ node scripts/ui-graph-bundle.mjs --write（束を作り直して置く）
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * `@babel/runtime/regenerator` は、作った実行部を大域の `regeneratorRuntime` に置き、置けないときの予備に
 * `Function("r", "regeneratorRuntime = r")` を持つ（いまのブラウザでは通らない道だが、束に `Function(` が残る）。
 * 束では、実行部を作って返すだけの形に置き換える（大域に置かない・`Function` を含めない）。中身は同じ版の `helpers/regeneratorRuntime`。
 * 置き換えが 1 回も効かなければ（版を上げてパスが変わったなど）、束ねを止める。
 * `helpers/regeneratorRuntime` が無い版（Babel 8 では消える見込み）では、解決ができず束ねが止まる。そのときは置き換えを見直す。
 */
function noGlobalRegenerator(hits) {
  return {
    name: "no-global-regenerator",
    setup(b) {
      b.onLoad({ filter: /[\\/]@babel[\\/]runtime[\\/]regenerator[\\/]index\.js$/ }, (args) => {
        hits.count++;
        return {
          contents: 'module.exports = require("../helpers/regeneratorRuntime")();\n',
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

const DAEMON = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "daemon");

export const GRAPH_JS_PATH = join(DAEMON, "ui-graph", "ui-graph-js.ts");

/** 束を、`UI_GRAPH_JS` を出す TS の文字にする。 */
export const graphModule = (js) =>
  `// 自動で作るファイル（node scripts/ui-graph-bundle.mjs --write）。手で直さない。\n// 関係図の束（#89）。lockfile の版から束ね直したものと一致することを、試験で比べる。\nexport const UI_GRAPH_JS: string = ${JSON.stringify(js)};\n`;

const LIBS = ["rete", "rete-area-plugin", "rete-readonly-plugin"];

/** 束の頭に置く、ライセンスの表示（MIT の決まりで、写しには著作権の表示と許諾の文を含める）。 */
function licenseBanner() {
  const req = createRequire(join(DAEMON, "package.json"));
  const lines = LIBS.map((name) => {
    const j = JSON.parse(readFileSync(req.resolve(`${name}/package.json`), "utf8"));
    return ` * ${j.name}@${j.version} — ${j.license} — (c) ${j.author}`;
  });
  // @babel/runtime は rete-area-plugin の依存（daemon から直には見えない）
  const babelDir = dirname(
    createRequire(req.resolve("rete-area-plugin/package.json")).resolve(
      "@babel/runtime/package.json",
    ),
  );
  const babel = JSON.parse(readFileSync(join(babelDir, "package.json"), "utf8"));
  const babelLicense = readFileSync(join(babelDir, "LICENSE"), "utf8")
    .trim()
    .replaceAll("*/", "* /");
  return [
    "/*!",
    " * touryou の関係図（/ui/graph.js）。次のものを束ねている（どれも MIT License）。",
    ...lines,
    ` * ${babel.name}@${babel.version} — ${babel.license}`,
    " *",
    ...babelLicense.split("\n").map((l) => ` * ${l}`.trimEnd()),
    " */",
  ].join("\n");
}

/** @returns {Promise<string>} 束ねた JS（最小化あり） */
export async function bundleGraph({ minify = true } = {}) {
  const { build } = await import("esbuild");
  const hits = { count: 0 };
  const r = await build({
    entryPoints: [join(DAEMON, "src", "ui", "graph-entry.ts")],
    absWorkingDir: DAEMON,
    bundle: true,
    write: false,
    format: "iife",
    globalName: "touryouGraph",
    platform: "browser",
    target: "es2022",
    minify,
    legalComments: "inline",
    logLevel: "silent",
    banner: { js: licenseBanner() },
    plugins: [noGlobalRegenerator(hits)],
  });
  if (hits.count === 0)
    throw new Error("@babel/runtime/regenerator の置き換えが効いていない（パスが変わったか）");
  const out = r.outputFiles?.[0];
  if (out === undefined) throw new Error("束ねの出力がない");
  return out.text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const js = await bundleGraph();
  if (process.argv.includes("--write")) writeFileSync(GRAPH_JS_PATH, graphModule(js));
  const raw = Buffer.byteLength(js);
  console.log(
    `graph.js: ${(raw / 1024).toFixed(1)} KB（最小化）・${(gzipSync(js).length / 1024).toFixed(1)} KB（gzip）`,
  );
}
