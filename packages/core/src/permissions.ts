/**
 * 権限の規則の解析・照合・判定（純粋関数。#194 の設計書 § 3.1・§ 3.3）。
 *
 * 規則は Claude Code の `permissions` と同じ書き方の部分集合に限る。解析できない書き方は無視せず、
 * 誤りとして返す（フェイルクローズ）。
 *
 * | 書き方 | 意味 |
 * |:--|:--|
 * | `Bash(<語の並び>:*)` | コマンドの前方一致（語ごとの完全一致。`scope.ts` の `wordsCover` と同じ） |
 * | `Bash(<語の並び>)` | コマンドの完全一致 |
 * | `Edit(<相対パス>/**)` | 書き込みの場所（作業ツリーからの相対。配下すべて） |
 * | `mcp__<サーバー>__<道具>` | MCP ツール 1 つ（名前の完全一致） |
 * | `mcp__<サーバー>` | そのサーバーの全ツール（人間の設定だけで使う。子の依頼では使わない） |
 *
 * この層は、まだどこからも呼ばれていない（挙動の変更なし）。
 */
import { commandWords, isPathUnder, normalizePath, wordsCover } from "./scope.js";

export type ParsedRule =
  | { readonly kind: "bashPrefix"; readonly words: readonly string[] }
  | { readonly kind: "bashExact"; readonly words: readonly string[] }
  | { readonly kind: "edit"; readonly dir: string }
  | { readonly kind: "mcpTool"; readonly server: string; readonly tool: string }
  | { readonly kind: "mcpServer"; readonly server: string };

export type RuleProblem =
  | "empty" // 空文字・空白だけ
  | "unsupported" // 対応する書き方ではない（`*` の混在、別の道具名など）
  | "emptyCommand" // Bash の語が 0 個
  | "unparsable" // Bash の語がシェルの字句解析で 1 つの命令にならない
  | "invalidPath" // Edit の場所が不正（絶対パス・`..`・空・NUL・書式制御文字）
  | "invalidMcpName"; // MCP の名前の文字が不正

export interface RuleError {
  readonly ok: false;
  readonly rule: string;
  readonly problem: RuleProblem;
}

export type ParseResult = { readonly ok: true; readonly rule: ParsedRule } | RuleError;

/** 照合の対象の操作。`path` は作業ツリーからの相対パス。`command` は 1 つの命令（区切りで分けた後の 1 つ）。 */
export type PermissionOp =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "write"; readonly path: string }
  | { readonly kind: "mcp"; readonly tool: string };

export type PermissionVerdict = "deny" | "ask" | "allow" | "none";

/** 1 つの方針。`evaluate` は deny → ask → allow の順に見る。 */
export interface PermissionPolicy {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
}

const MCP_NAME = /^[A-Za-z0-9_-]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の検出が目的
const CONTROL = /[\u0000-\u001f\u007f]|\p{Cf}/u;

const fail = (rule: string, problem: RuleProblem): RuleError => ({ ok: false, rule, problem });

/** `Bash(...)` の中身の語を取り出す。1 つの命令にならないものは undefined。 */
function bashWords(body: string): string[] | undefined {
  const segs = commandWords(body);
  if (segs === undefined) return undefined;
  const nonEmpty = segs.filter((s) => s.length > 0);
  return nonEmpty.length === 1 ? (nonEmpty[0] as string[]) : undefined;
}

function parseBash(rule: string, inner: string): ParseResult {
  let body = inner;
  let prefix = false;
  if (body.endsWith(":*")) {
    prefix = true;
    body = body.slice(0, -2);
  }
  if (body.trim() === "") return fail(rule, "emptyCommand");
  // ワイルドカードの細部（`Bash(a *)` など）は、Claude Code の文書で確かめるまで入れない（設計書 E1）。
  if (body.includes("*")) return fail(rule, "unsupported");
  const words = bashWords(body);
  if (words === undefined) return fail(rule, "unparsable");
  return { ok: true, rule: { kind: prefix ? "bashPrefix" : "bashExact", words } };
}

function parseEdit(rule: string, inner: string): ParseResult {
  if (!inner.endsWith("/**")) return fail(rule, "unsupported");
  const dir = inner.slice(0, -3);
  if (dir.includes("*")) return fail(rule, "unsupported");
  if (dir.trim() === "" || dir.startsWith("/") || CONTROL.test(dir)) {
    return fail(rule, "invalidPath");
  }
  if (dir.split("/").some((seg) => seg === "..")) return fail(rule, "invalidPath");
  const normalized = normalizePath("/", dir);
  if (normalized === "/") return fail(rule, "invalidPath");
  return { ok: true, rule: { kind: "edit", dir: normalized.slice(1) } };
}

function parseMcp(rule: string): ParseResult {
  const rest = rule.slice("mcp__".length);
  const at = rest.indexOf("__");
  if (at === -1) {
    if (!MCP_NAME.test(rest))
      return fail(rule, rest.includes("*") ? "unsupported" : "invalidMcpName");
    return { ok: true, rule: { kind: "mcpServer", server: rest } };
  }
  const server = rest.slice(0, at);
  const tool = rest.slice(at + 2);
  if (server === "" || tool === "") return fail(rule, "invalidMcpName");
  if (server.includes("*") || tool.includes("*")) return fail(rule, "unsupported");
  if (!MCP_NAME.test(server) || !MCP_NAME.test(tool)) return fail(rule, "invalidMcpName");
  return { ok: true, rule: { kind: "mcpTool", server, tool } };
}

/** 規則 1 つを解析する。解析できなければ、理由つきの誤りを返す（例外は投げない）。 */
export function parseRule(rule: string): ParseResult {
  if (rule.trim() === "") return fail(rule, "empty");
  if (rule !== rule.trim()) return fail(rule, "unsupported");
  const call = /^(Bash|Edit)\((.*)\)$/s.exec(rule);
  if (call !== null) {
    return call[1] === "Bash" ? parseBash(rule, call[2] ?? "") : parseEdit(rule, call[2] ?? "");
  }
  if (rule.startsWith("mcp__")) return parseMcp(rule);
  return fail(rule, "unsupported");
}

/** 規則の一覧を解析し、誤りだけを集めて返す（設定の検査用）。 */
export function ruleErrors(rules: readonly string[]): RuleError[] {
  const errors: RuleError[] = [];
  for (const r of rules) {
    const p = parseRule(r);
    if (!p.ok) errors.push(p);
  }
  return errors;
}

/**
 * 解析済みの規則が、操作に当たるか。種類が違えば当たらない。
 * コマンドは、1 つの命令だけを対象にする（区切りで複数に分かれる・解析できない文字列は、当たらない）。
 * 呼ぶ側が、区切りごとに分けて 1 つずつ渡す。
 */
export function matchRule(rule: ParsedRule, op: PermissionOp): boolean {
  switch (rule.kind) {
    case "bashPrefix":
    case "bashExact": {
      if (op.kind !== "command") return false;
      const words = bashWords(op.command);
      if (words === undefined) return false;
      if (!wordsCover(rule.words, words)) return false;
      return rule.kind === "bashPrefix" || words.length === rule.words.length;
    }
    case "edit": {
      if (op.kind !== "write") return false;
      if (op.path.trim() === "" || op.path.startsWith("/") || CONTROL.test(op.path)) return false;
      return isPathUnder(normalizePath("/", op.path), normalizePath("/", rule.dir));
    }
    case "mcpTool":
      return op.kind === "mcp" && op.tool === `mcp__${rule.server}__${rule.tool}`;
    case "mcpServer":
      return op.kind === "mcp" && op.tool.startsWith(`mcp__${rule.server}__`);
  }
}

/** 規則の一覧のどれかが操作に当たるか。`undefined` は、解析できない規則が混じっていた印。 */
function anyMatch(rules: readonly string[], op: PermissionOp): boolean | undefined {
  let hit = false;
  for (const r of rules) {
    const p = parseRule(r);
    if (!p.ok) return undefined;
    if (matchRule(p.rule, op)) hit = true;
  }
  return hit;
}

/**
 * 方針に照らして判定する。順序は deny → ask → allow（最初に当たったところで決まる）。どれにも当たらなければ "none"。
 * 方針に解析できない規則が 1 つでもあれば、安全側に "deny" を返す（設定の読み込みで `ruleErrors` が先に断る前提の備え）。
 * 固定の守り（禁じる場所・間接実行など）は、ここでは扱わない。
 */
export function evaluate(policy: PermissionPolicy, op: PermissionOp): PermissionVerdict {
  const d = anyMatch(policy.deny, op);
  const k = anyMatch(policy.ask, op);
  const a = anyMatch(policy.allow, op);
  if (d === undefined || k === undefined || a === undefined) return "deny";
  if (d) return "deny";
  if (k) return "ask";
  if (a) return "allow";
  return "none";
}
