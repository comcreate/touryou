/**
 * 子の許可の一覧（設計 6.2「子の許可」）。純粋関数。
 *
 * 子は `--permission-mode dontAsk` で起動し、ここで作る `permissions.allow` にあるものだけを確認なしで使う。
 * 一覧にない操作は、確認を出さずに断られる（決定）。範囲の外が要るときは、子が受信箱で範囲の拡張を頼む。
 *
 * 中身は次の 4 つだけ。
 * 1. 子の touryou の道具。`mcp__node__<道具>` と `mcp__plugin_<plugin 名>_node__<道具>` の 2 つの形。
 * 2. 範囲の allowedCommands を `Bash(<コマンド>:*)` に。`*` `;` `&` `|` `` ` `` `$` `<` `>` `"` `'` `\\` 括弧・改行を含むもの、
 *    `cd` で始まるもの、1 語だけのもの（`git`・`node` など。前方一致で任意のコードを動かせる）は失敗にする。
 * 3. 範囲の writableLocations を `Edit(<相対>/**)` に（作業ツリーからの相対。外を指すものは失敗）。
 *    ファイルを書く道具（Edit・Write など）の規則は `Edit(...)` にまとめて照合される（Claude Code は `Write(...)` の規則に
 *    「never matches · use Edit(...)」と警告する）ので、`Write(...)` は入れない。
 * 4. 作業ツリーの中の読み取り（`Read(./**)`・`Grep(./**)`・`Glob(./**)`）。
 *
 * deny（allow より強い前提）: forbiddenLocations と `.git` の `Edit`・`Read`。フックのない子でも、禁止の場所を守る。
 *
 * 入れないもの: ほかの MCP の道具、WebFetch、範囲の外の Bash、`Bash(cd:*)`。フックの範囲の判定（hook-policy）は、これと別に効く。
 */

import { CHILD_MCP_TOOL_NAMES, PLUGIN_NAME, type Result, type Scope } from "@touryou/core";

export { PLUGIN_NAME };

/** plugin の `.mcp.json` の、子が使う MCP サーバの名前。 */
export const NODE_MCP_SERVER = "node";

/** 子のロールの touryou の道具の名前（core の `CHILD_MCP_TOOL_NAMES`。フックの `ownMcpToolOf` と同じ一覧）。 */
export const childToolNames = (): readonly string[] => CHILD_MCP_TOOL_NAMES;

const UNSAFE = /[*;&|`$<>"'\\()\n\r]/;

const fail = (cause: string): Result<never> => ({
  ok: false,
  error: {
    code: "invalidScope",
    cause,
    nextActions: [
      "範囲（allowedCommands・writableLocations・forbiddenLocations）を直す（子は scope_extend で頼む）",
    ],
  },
});

/** 作業ツリーからの相対の場所を、`.`・`..` を畳んで返す。外を指す・絶対・不正なら undefined。`""` は作業ツリーそのもの。 */
function relativeOf(location: unknown): string | undefined {
  if (typeof location !== "string" || location.includes("\0") || location.startsWith("/"))
    return undefined;
  if (UNSAFE.test(location)) return undefined;
  const parts: string[] = [];
  for (const seg of location.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** 1 語目が、任意のコードを動かす入口（シェル・解釈系・権限の切り替え）。 */
const RUNNERS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "env",
  "xargs",
  "node",
  "python",
  "python3",
  "deno",
  "bun",
  "npx",
  "eval",
  "exec",
  "sudo",
  "perl",
  "ruby",
  "tsx",
  "ts-node",
  "php",
  "lua",
  "awk",
  "gawk",
  "make",
]);
/** 2 語目が、任意のコードやパッケージを動かす旗・副命令（`npm exec`・`pnpm dlx`・`node -e` など）。 */
const RUNNER_ARGS = new Set(["exec", "dlx", "-e", "-c", "--eval", "x"]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn"]);

/** 前方一致の許可で、任意のコードが動く形なら、その理由を返す。 */
function arbitraryCode(words: readonly string[]): string | undefined {
  const [first = "", w1 = ""] = words;
  // パスの形（`/usr/bin/node`・`./node_modules/.bin/tsx`）も、名前で照合する。
  const w0 = first.slice(first.lastIndexOf("/") + 1);
  if (RUNNERS.has(w0)) return `${w0} はコードを動かす入口`;
  if (RUNNER_ARGS.has(w1)) return `${w0} ${w1} はコードやパッケージを動かす`;
  if (w0 === "git" && w1 === "submodule" && words.includes("foreach"))
    return "git submodule foreach は任意のコマンドを動かす";
  if (w0 === "git" && (w1 === "config" || w1 === "-c"))
    return "git の設定で任意のコマンドを動かせる";
  if (
    w0 === "find" &&
    words.some((w) => w === "-exec" || w === "-execdir" || w === "-delete" || w === "-ok")
  ) {
    return "find の -exec・-delete";
  }
  if (SCRIPT_RUNNERS.has(w0) && w1 === "run" && words.length < 3) return "スクリプトの名前まで書く";
  return undefined;
}

/**
 * 許可のコマンドの語の並びが、Claude Code の許可（`Bash(...)`）に入れてよい形か。入れてはいけないなら理由を返す。
 * 空・`cd` 始まり・1 語だけ（前方一致で任意の引数が通る）・任意のコードが動く形。引用符などの文字の確かめ（`UNSAFE`）は含まない。
 * 起動のときの一覧（`childAllowList`）と、承認済みの拡張への明示の許可（hook-policy の `grantedOnlyByExtension`。#91）が、同じ規則を使う。
 */
export function commandEntryProblem(words: readonly string[]): string | undefined {
  if (words.length === 0) return "許可のコマンドが空";
  if (words[0] === "cd") return "cd で始まるコマンドは許可に入れない";
  if (words.length === 1) return "1 語だけのコマンドは許可に入れない（前方一致で任意の引数が通る）";
  const why = arbitraryCode(words);
  return why === undefined ? undefined : `任意のコードを動かせるコマンドは許可に入れない（${why}）`;
}

const under = (rel: string): string => (rel === "" ? "./**" : `./${rel}/**`);

export interface ChildPermissions {
  readonly allow: string[];
  readonly deny: string[];
}

export function childAllowList(
  scope: Scope,
  toolNames: readonly string[],
): Result<ChildPermissions> {
  const allow: string[] = [];
  for (const t of toolNames) {
    if (!/^[A-Za-z_]+$/.test(t)) return fail(`道具の名前が不正: ${t}`);
    allow.push(
      `mcp__${NODE_MCP_SERVER}__${t}`,
      `mcp__plugin_${PLUGIN_NAME}_${NODE_MCP_SERVER}__${t}`,
    );
  }
  for (const c of scope.allowedCommands) {
    if (typeof c !== "string" || UNSAFE.test(c)) {
      return fail(`許可のコマンドに使えない文字がある: ${JSON.stringify(c)}`);
    }
    const words = c
      .trim()
      .split(/\s+/)
      .filter((w) => w !== "");
    const cmd = words.join(" ");
    const why = commandEntryProblem(words);
    if (why !== undefined) return fail(`${why}: ${cmd}`);
    allow.push(`Bash(${cmd}:*)`);
  }
  for (const w of scope.writableLocations) {
    const rel = relativeOf(w);
    if (rel === undefined)
      return fail(`書き込みの場所が作業ツリーの中の相対でない: ${JSON.stringify(w)}`);
    allow.push(`Edit(${under(rel)})`);
  }
  allow.push("Read(./**)", "Grep(./**)", "Glob(./**)");
  const deny: string[] = [];
  for (const f of [".git", ...scope.forbiddenLocations]) {
    // 作業ツリーの外（絶対・`..`）の禁止は、`./` の規則で書けないので入れない。allow（`./**`）にも入らないので、dontAsk が断る。
    const rel = relativeOf(f);
    if (rel === undefined) {
      if (typeof f === "string" && !UNSAFE.test(f) && !f.includes("\0")) continue;
      return fail(`禁止の場所が作業ツリーの中の相対でない: ${JSON.stringify(f)}`);
    }
    if (rel === "") return fail("禁止の場所に作業ツリーそのもの（.）は書けない");
    // 場所はファイルかディレクトリか分からない（作業ツリーの `.git` はファイル）ので、両方の形を入れる。
    for (const pattern of [`./${rel}`, `./${rel}/**`]) {
      deny.push(`Edit(${pattern})`, `Read(${pattern})`);
    }
  }
  return { ok: true, value: { allow: [...new Set(allow)], deny: [...new Set(deny)] } };
}
