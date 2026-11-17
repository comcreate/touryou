/**
 * 関係図（`/ui/graph.js`）の束ね（#89 の試作）。esbuild で、自前の入口（`packages/daemon/src/ui-graph/graph-entry.ts`）と
 * rete・rete-area-plugin・rete-readonly-plugin を 1 つの IIFE にする（グローバル名 `TouryouGraph`）。
 * いまは試験の中だけで使う（配布物の画面には、まだ出さない。PR-5 で配る）。
 * 使い方（大きさを測る）: node scripts/ui-graph-bundle.mjs
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * `@babel/runtime/regenerator` は、作った実行部を大域の `regeneratorRuntime` に置き、置けないときの予備に
 * `Function("r", "regeneratorRuntime = r")` を持つ（いまのブラウザでは通らない道だが、束に `Function(` が残る）。
 * 束では、実行部を作って返すだけの形に置き換える（大域に置かない・`Function` を含めない）。中身は同じ版の `helpers/regeneratorRuntime`。
 */
const noGlobalRegenerator = {
  name: "no-global-regenerator",
  setup(b) {
    b.onLoad({ filter: /[\\/]@babel[\\/]runtime[\\/]regenerator[\\/]index\.js$/ }, (args) => ({
      contents: 'module.exports = require("../helpers/regeneratorRuntime")();\n',
      loader: "js",
      resolveDir: dirname(args.path),
    }));
  },
};

const DAEMON = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "daemon");

/** @returns {Promise<string>} 束ねた JS（最小化あり） */
export async function bundleGraph({ minify = true } = {}) {
  const { build } = await import("esbuild");
  const r = await build({
    entryPoints: [join(DAEMON, "src", "ui-graph", "graph-entry.ts")],
    absWorkingDir: DAEMON,
    bundle: true,
    write: false,
    format: "iife",
    globalName: "TouryouGraph",
    platform: "browser",
    target: "es2022",
    minify,
    legalComments: "inline",
    logLevel: "silent",
    plugins: [noGlobalRegenerator],
  });
  const out = r.outputFiles?.[0];
  if (out === undefined) throw new Error("束ねの出力がない");
  return out.text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const js = await bundleGraph();
  const raw = Buffer.byteLength(js);
  console.log(
    `graph.js: ${(raw / 1024).toFixed(1)} KB（最小化）・${(gzipSync(js).length / 1024).toFixed(1)} KB（gzip）`,
  );
}
