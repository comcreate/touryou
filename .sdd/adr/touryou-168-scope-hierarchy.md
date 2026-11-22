---
id: "adr-touryou-168-scope-hierarchy"
title: "範囲の階層 決定ログ（#168 サブ統括）"
type: "adr"
status: "accepted"
sdd-phase: "implement"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: []
tags: ["touryou", "168"]
category: ""
---

# 範囲の階層 決定ログ（#168 サブ統括）

> 元の案: `.sdd/task/168/adr-draft-scope-hierarchy.md`（判断 2 は推奨の A で確定済み）。PR3（daemon・mcp: 許可とフック）で実装が決まった。元の案は親が統合時に消す。

## 2026-11-22 孫の守りは孫自身の有効な範囲で判定し、範囲は階層で絞る

- **Decision**: サブ統括の範囲は親の有効な範囲の部分集合、孫の範囲はサブ統括の有効な範囲の部分集合とする（spawn 時に `childScopeProblem` で検査。既存）。孫のフックの判定は、孫自身の `effectiveScope`（ブリーフ＋承認済みの拡張）で行い、root の範囲では行わない。範囲・禁じる場所・固定の守りの判定は変えない（設計書の「判定コードは変えない」は、道具の許可の一覧をロールで切り替える部分だけ上書きした。理由は [touryou-168-integrator-child-operations.md](./touryou-168-integrator-child-operations.md)）。
- **PR3 で実装したこと**:
  - 起動時の許可の一覧（`--settings` の `permissions.allow`）を、ノードのロールで切り替える（`launchToolNames`）。サブ統括は `child_bind` ＋ `INTEGRATOR_MCP_TOOL_NAMES`、子は従来どおり `CHILD_MCP_TOOL_NAMES`。範囲の許可（`Bash(...)`・`Edit(...)`）の検査規則は共通。
  - mcp の `child_bind` は、成功後に新しい資格情報で `whoami` を呼び、そのロール（child・integrator）で道具の一覧を切り替える。ロールを bind の引数や応答の自己申告では決めない（昇格の経路を作らない）。
  - 試験: 孫の範囲がサブ統括の範囲の内側にあるとき、サブ統括の範囲の内でも孫自身の範囲の外なら拒否し、孫自身の範囲の内なら許可する（判定は孫の範囲だけで決まる）。
- **Rationale**: 孫の範囲は spawn 時にサブ統括の内側と保証されるので、孫自身の範囲で判定すれば「サブ統括の外に出ない」が成り立ち、結果として root の範囲も超えない。階層ごとに範囲が絞られるのがサブ統括の意味であり、新しい規則を足さずに済む。
- **Rejected alternatives**: root の範囲で判定 — 孫がサブ統括の範囲の外でも動けてしまい、期待 2 に反する。サブ統括の範囲で動的に判定 — 判定が親の状態に依存し、親の停止・拡張で孫の許可が揺れる。
  - フックの道具の許可（`decideToolUse` の末尾の自分の mcp の道具の判定）を、呼び出したノードのロールで切り替える。サブ統括は統合の道具＋`child_bind`、子は `CHILD_MCP_TOOL_NAMES`。`decideCliHook` がノードのロールを渡す。フックの受け口（`/v1/hook`）は、フック専用トークンのロールをノードのロールに合わせ、サブ統括も通す。
  - 統合ロールに子の操作を足した（[touryou-168-integrator-child-operations.md](./touryou-168-integrator-child-operations.md)）。サブ統括は、自分の親へ完了の報告・範囲の拡張・受信箱の読み取りができる。
- **残る課題**: Desktop の子のフック（`decideDesktopHook`）は、子のロールの一覧のまま。サブ統括は CLI で起動する前提（親のセッションが `parent_request` で起動する）で、Desktop のサブ統括は PR3 の範囲に入れていない。
