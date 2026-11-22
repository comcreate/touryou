/**
 * 根の権限の方針（`RootPolicy`）の検査と正規化（#194 の設計書 § 3.1・§ 3.5・§ 4.1。PR2）。
 *
 * config の `permissions`（`allow`・`deny`・`ask`）と `autoApprove`（`allow`）を、起動のときに検査し、
 * `rootScope` と合わせて 1 つの方針に畳む。**判定（フック・承認）には、まだ接続しない**（PR3 以降）。
 *
 * - 解析できない規則は、無視せず、設定の誤りとして断る（フェイルクローズ。`parseRule`）。
 * - `Bash(...)` の規則は、`allow` にも `autoApprove` にも、子の許可と同じ検査（`commandEntryProblem`）を通す。
 * - `autoApprove` は、読み取りだけで副作用のないものに限る。書き込み（`Edit`）・サーバー全体の MCP 規則・
 *   読み取り専用の表にないコマンドは書けない。`allow` の内側で、`deny`・`ask` に当たらないこと。
 * - `rootScope` からの変換は、**表せるものだけ**を方針に入れる（表せないものは入れない。方針が狭くなる側に倒れる）。
 *   範囲の判定そのもの（`rootScope`）は、今までどおり別に効く。
 */

import {
  evaluate,
  type ParsedRule,
  type PermissionOp,
  parseRule,
  type RuleError,
  type RuleProblem,
  type Scope,
  wordsCover,
} from "@touryou/core";
import { commandEntryProblem } from "./sdk/child-permissions.js";
import { READ_ONLY_COMMAND_HEADS } from "./sdk/read-only-search.js";

/** 規則の一覧 1 つの件数の上限と、規則 1 つの長さの上限。 */
export const RULES_MAX = 200;
export const RULE_MAX_LENGTH = 512;

/** config の `permissions`。省略した一覧は空。 */
export interface PermissionsConfig {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
}

/** config の `autoApprove`。省略した一覧は空。 */
export interface AutoApproveConfig {
  readonly allow: readonly string[];
}

/** 1 つの root の権限の方針（設計書 § 3.1。daemon の正本）。 */
export interface RootPolicy {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
  /** 自動承認してよい規則（`allow` の部分集合）。 */
  readonly autoApprove: readonly string[];
  /** `allow` の MCP ツール（`mcp__<サーバー>__<道具>` の完全一致）。`Scope.allowedMcpTools` と同じ形。 */
  readonly allowedMcpTools: readonly string[];
}

type ListResult =
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly cause: string };

const PROBLEM_TEXT: Readonly<Record<RuleProblem, string>> = {
  empty: "空の規則",
  unsupported:
    "対応していない書き方（対応: Bash(<語>:*)・Bash(<語>)・Edit(<場所>/**)・mcp__<サーバー>__<道具>・mcp__<サーバー>）",
  emptyCommand: "コマンドが空",
  unparsable: "コマンドが 1 つの命令として読めない",
  invalidPath: "場所が不正（絶対パス・.. ・空は不可。作業ツリーからの相対で書く）",
  invalidMcpName: "MCP の名前の文字が不正（英数字・_・- だけ）",
};

const describe = (e: RuleError): string =>
  `${JSON.stringify(e.rule)}（${PROBLEM_TEXT[e.problem]}）`;

/** 規則の一覧（文字列の配列）の形を検査する。 */
function listOf(name: string, v: unknown): ListResult {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    return { ok: false, cause: `${name} は、規則（文字列）の配列` };
  }
  if (v.length > RULES_MAX) return { ok: false, cause: `${name} は ${RULES_MAX} 件以下` };
  if (v.some((x: string) => x.length > RULE_MAX_LENGTH)) {
    return { ok: false, cause: `${name} の規則は ${RULE_MAX_LENGTH} 文字以下` };
  }
  if (new Set(v).size !== v.length) return { ok: false, cause: `${name} に同じ規則が重複している` };
  return { ok: true, value: [...(v as string[])] };
}

function keyedLists(
  name: string,
  v: unknown,
  keys: readonly string[],
): { ok: true; value: Record<string, readonly string[]> } | { ok: false; cause: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { ok: false, cause: `${name} は、${keys.join("・")} だけを持つオブジェクト` };
  }
  const rec = v as Record<string, unknown>;
  if (Object.keys(rec).some((k) => !keys.includes(k))) {
    return { ok: false, cause: `${name} は、${keys.join("・")} だけを持つオブジェクト` };
  }
  const out: Record<string, readonly string[]> = {};
  for (const k of keys) {
    const r = listOf(`${name}.${k}`, rec[k]);
    if (!r.ok) return r;
    out[k] = r.value;
  }
  return { ok: true, value: out };
}

/** config の `permissions` の形を検査して取り出す（規則の中身の検査は `policyProblem`）。 */
export function parsePermissionsConfig(
  v: unknown,
): { ok: true; value: PermissionsConfig } | { ok: false; cause: string } {
  const r = keyedLists("permissions", v, ["allow", "deny", "ask"]);
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      allow: r.value.allow ?? [],
      deny: r.value.deny ?? [],
      ask: r.value.ask ?? [],
    },
  };
}

/** config の `autoApprove` の形を検査して取り出す（規則の中身の検査は `policyProblem`）。 */
export function parseAutoApproveConfig(
  v: unknown,
): { ok: true; value: AutoApproveConfig } | { ok: false; cause: string } {
  const r = keyedLists("autoApprove", v, ["allow"]);
  if (!r.ok) return r;
  return { ok: true, value: { allow: r.value.allow ?? [] } };
}

/** `Bash(<語>:*)` の中身（規則の文字列から取り出す）。照合の対象の命令として使う。 */
const bashBody = (rule: string): string => {
  const inner = rule.slice("Bash(".length, -1);
  return inner.endsWith(":*") ? inner.slice(0, -2) : inner;
};

/** 規則 1 つを、照合の対象の操作に直す（`autoApprove` が `deny`・`ask` に当たるかの確かめ用）。 */
function opOfRule(rule: string, parsed: ParsedRule): PermissionOp | undefined {
  switch (parsed.kind) {
    case "bashPrefix":
    case "bashExact":
      return { kind: "command", command: bashBody(rule) };
    case "mcpTool":
      return { kind: "mcp", tool: `mcp__${parsed.server}__${parsed.tool}` };
    case "edit":
    case "mcpServer":
      return undefined;
  }
}

/** 規則 `inner` が、`outer` に含まれる（`outer` が `inner` の当たるものをすべて当てる）か。 */
function covers(outer: ParsedRule, inner: ParsedRule): boolean {
  switch (inner.kind) {
    case "bashPrefix":
      return outer.kind === "bashPrefix" && wordsCover(outer.words, inner.words);
    case "bashExact":
      return (
        (outer.kind === "bashPrefix" && wordsCover(outer.words, inner.words)) ||
        (outer.kind === "bashExact" &&
          outer.words.length === inner.words.length &&
          wordsCover(outer.words, inner.words))
      );
    case "mcpTool":
      return (
        (outer.kind === "mcpTool" && outer.server === inner.server && outer.tool === inner.tool) ||
        (outer.kind === "mcpServer" && outer.server === inner.server)
      );
    case "mcpServer":
      return outer.kind === "mcpServer" && outer.server === inner.server;
    case "edit":
      return false;
  }
}

/** `Bash(...)` の規則が、子の許可に入れてよい形か（`commandEntryProblem`）。 */
function bashProblem(rule: string, parsed: ParsedRule): string | undefined {
  if (parsed.kind !== "bashPrefix" && parsed.kind !== "bashExact") return undefined;
  const why = commandEntryProblem(parsed.words);
  return why === undefined ? undefined : `${JSON.stringify(rule)}: ${why}`;
}

/** 読み取り専用の表にあるコマンドか（`autoApprove` に書ける Bash の条件）。 */
const isReadOnlyHead = (words: readonly string[]): boolean =>
  READ_ONLY_COMMAND_HEADS.some((head) => wordsCover(head, words));

function parseAll(
  name: string,
  rules: readonly string[],
): { ok: true; value: ParsedRule[] } | { ok: false; cause: string } {
  const out: ParsedRule[] = [];
  for (const r of rules) {
    const p = parseRule(r);
    if (!p.ok) return { ok: false, cause: `${name}: ${describe(p)}` };
    out.push(p.rule);
  }
  return { ok: true, value: out };
}

/**
 * 設定した規則を検査する。誤りがあれば、理由（どの一覧のどの規則か）を返す。なければ undefined。
 *
 * - すべての規則が解析できること。`allow`・`autoApprove` の `Bash(...)` は、子の許可と同じ検査を通ること。
 * - `autoApprove`: `Edit(...)`・`mcp__<サーバー>`（サーバー全体）は書けない。Bash は読み取り専用の表のコマンドだけ。
 *   各規則は `allow` の内側にあり、`deny`・`ask` に当たらないこと。
 */
export function policyProblem(
  rootScope: Scope,
  permissions: PermissionsConfig,
  autoApprove: AutoApproveConfig,
): string | undefined {
  const lists = [
    ["permissions.allow", permissions.allow],
    ["permissions.deny", permissions.deny],
    ["permissions.ask", permissions.ask],
    ["autoApprove.allow", autoApprove.allow],
  ] as const;
  const parsed: Record<string, ParsedRule[]> = {};
  for (const [name, rules] of lists) {
    const r = parseAll(name, rules);
    if (!r.ok) return r.cause;
    parsed[name] = r.value;
  }
  for (const [name, rules] of [
    ["permissions.allow", permissions.allow],
    ["autoApprove.allow", autoApprove.allow],
  ] as const) {
    for (const [i, p] of (parsed[name] ?? []).entries()) {
      const why = bashProblem(rules[i] as string, p);
      if (why !== undefined) return `${name}: ${why}`;
    }
  }
  // 上限は、`permissions.allow` と、`rootScope` から変換した規則（旧の書き方）の和。
  const allowRules = [
    ...legacyRules(rootScope).allow.flatMap((r) => {
      const p = parseRule(r);
      return p.ok ? [p.rule] : [];
    }),
    ...(parsed["permissions.allow"] ?? []),
  ];
  for (const [i, p] of (parsed["autoApprove.allow"] ?? []).entries()) {
    const rule = autoApprove.allow[i] as string;
    const label = `autoApprove.allow: ${JSON.stringify(rule)}`;
    if (p.kind === "edit") {
      return `${label}: 書き込み（Edit）は自動承認に入れられない（読み取りだけのものに限る）`;
    }
    if (p.kind === "mcpServer") {
      return `${label}: MCP のサーバー全体は自動承認に入れられない（道具の名前を 1 つずつ書く）`;
    }
    if ((p.kind === "bashPrefix" || p.kind === "bashExact") && !isReadOnlyHead(p.words)) {
      return `${label}: 読み取り専用のコマンド（${READ_ONLY_COMMAND_HEADS.map((h) => h.join(" ")).join("・")}）だけを自動承認に入れられる`;
    }
    if (!allowRules.some((a) => covers(a, p))) {
      return `${label}: permissions.allow（上限）の内側にない（先に permissions.allow に足す）`;
    }
    const op = opOfRule(rule, p);
    if (
      op !== undefined &&
      evaluate({ allow: [], deny: permissions.deny, ask: permissions.ask }, op) !== "none"
    ) {
      return `${label}: permissions.deny か permissions.ask に当たる（自動承認に入れられない）`;
    }
  }
  return undefined;
}

/** 場所（`rootScope` の相対パス）を `Edit(<場所>/**)` の規則にする。表せなければ undefined（作業ツリーそのもの・外・不正）。 */
function editRuleOf(location: string): string | undefined {
  const trimmed = location.replace(/^\.\//, "").replace(/\/+$/, "");
  const rule = `Edit(${trimmed}/**)`;
  return parseRule(rule).ok ? rule : undefined;
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];

/** `rootScope`（旧の書き方）を規則に直す。表せない項目（解析できないコマンド・作業ツリー全体・外を指す場所）は入れない。 */
function legacyRules(rootScope: Scope): { allow: string[]; deny: string[] } {
  const allow: string[] = [];
  for (const c of rootScope.allowedCommands) {
    const rule = `Bash(${c.trim()}:*)`;
    if (parseRule(rule).ok) allow.push(rule);
  }
  for (const w of rootScope.writableLocations) {
    const rule = editRuleOf(w);
    if (rule !== undefined) allow.push(rule);
  }
  const deny: string[] = [];
  for (const f of rootScope.forbiddenLocations) {
    const rule = editRuleOf(f);
    if (rule !== undefined) deny.push(rule);
  }
  return { allow, deny };
}

/**
 * `rootScope` と `permissions`・`autoApprove` を、1 つの方針に畳む（設計書 § 4.1）。
 *
 * - `allow` = `rootScope.allowedCommands`（`Bash(<コマンド>:*)`）∪ `writableLocations`（`Edit(<場所>/**)`）∪ `permissions.allow`。
 * - `deny` = `rootScope.forbiddenLocations`（`Edit(<場所>/**)`）∪ `permissions.deny`。
 * - 規則に直せない `rootScope` の項目（解析できないコマンド・作業ツリー全体の `.`・外を指す場所）は、方針に入れない。
 *   同じ規則が `allow` と `deny` にあれば、判定のとき `deny` が勝つ（`evaluate`）。
 * - 重複は 1 つにする。
 */
export function buildRootPolicy(
  rootScope: Scope,
  permissions: PermissionsConfig,
  autoApprove: AutoApproveConfig,
): RootPolicy {
  const legacy = legacyRules(rootScope);
  const allow = uniq([...legacy.allow, ...permissions.allow]);
  return {
    allow,
    deny: uniq([...legacy.deny, ...permissions.deny]),
    ask: uniq(permissions.ask),
    autoApprove: uniq(autoApprove.allow),
    allowedMcpTools: allow.filter((r) => {
      const p = parseRule(r);
      return p.ok && p.rule.kind === "mcpTool";
    }),
  };
}
