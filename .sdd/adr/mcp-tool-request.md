---
id: "adr-mcp-tool-request"
title: "子の権限管理 決定ログ（MCP ツールの依頼）"
type: "adr"
status: "draft"
sdd-phase: "plan"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: ["design-194"]
tags: ["permissions", "mcp", "scope_extend"]
category: "security"
---

# 子の権限管理 決定ログ（MCP ツールの依頼）案

> 案（`.sdd/task/194/adr-draft-mcp-tool-request.md` から、#194 の PR2 で移した）。状態は、親の承認までは draft。設計は [design.md](../task/194/design.md) の § 3.6。

## 2026-11-22 MCP ツールの依頼を scope_extend の対象の種類として足す

- **Decision**: 子が MCP ツールを頼む入口は、既存の `scope_extend` の対象の種類（kind）に `mcp` を足す形にする（値は `mcp__<サーバー>__<道具>`）。新しい道具・窓口の操作は作らない。承認・反映・通知は、コマンドの拡張と同じ流れ（イベント列から `effectiveScope` を導き、フックが明示の許可を返す）を使う。
- **Rationale**: 認証のない入口を増やさない（#186 と同じ方針）。再起動なしで効く仕組みは、すでにコマンドの拡張にある。Issue の「子が `parent_request` で頼む」は、実装と食い違う（`parent_request` は、親が起動のコマンドを受け取る道具）。
- **Rejected alternatives**: 子専用の新しい道具 — 窓口の操作が増え、フックの許可も増える。`parent_request` を子に使わせる — 親の道具で、役割が違う。MCP を config の上限だけで許し、子の依頼の道は作らない — 利用者が毎回 config を編集することになり、Issue の痛みが残る。

## 2026-11-22 子の依頼で付与できる MCP を道具 1 つに限り自ノードの touryou の道具を断る

- **Decision**: 子の依頼の値は、`mcp__<サーバー>__<道具>` の完全な名前だけを受ける（サーバー全体の `mcp__<サーバー>` は、人間が config に書くときだけ）。自ノードの touryou のサーバー（`ownMcpToolOf` が名前を返すもの）の道具は、依頼で断る。承認は「そのツールを、どんな引数でも使ってよい」と同じ意味で、画面にその旨を出す。
- **Rationale**: Claude Code の規則は、MCP の引数を絞れない。サーバー全体を子の依頼で許すと、後から増える道具も通る。親の道具（`node_spawn` など）が同じサーバーにあるので、拡張で子に付与できると、役割の壁を越える（窓口のロール別の操作表で守られているが、多重に守る）。
- **Rejected alternatives**: サーバー単位の依頼 — 範囲が広すぎ、承認の意味が不明確。MCP の注釈（`readOnlyHint`）を信用して分類する — サーバーの自己申告で、信用できない。
