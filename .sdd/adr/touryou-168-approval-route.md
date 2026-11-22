---
id: "adr-touryou-168-approval-route"
title: "承認と依頼の経路 決定ログ（#168 サブ統括）"
type: "adr"
status: "accepted"
sdd-phase: "implement"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: []
tags: ["touryou", "168"]
category: ""
---

# 承認と依頼の経路 決定ログ（#168 サブ統括）

> 元の案: `.sdd/task/168/adr-draft-approval-route.md`（判断 2・3 は推奨の A で確定済み）。ここには、PR3（daemon・mcp: 許可とフック）で実装が決まった部分だけを書く。深さの上限（`maxTreeDepth`）は PR4 で実装するので、元の案に残す。元の案は親が統合時に消す。

## 2026-11-22 孫の起動・停止・削除の依頼は直接の親が受ける

- **Decision**: 依頼（`parent_request`）と報告（`parent_report`）の宛先は直接の親（サブ統括）とする。現行の `directChild` の規則のまま変えない。知らせは親セッション（`parentSession`）へ送る。サブ統括が応答しないときの孫の停止は、既存の `node.stop`・`node.confirmStopped` による root の経路で救う（詳細は design.md §5 の宿題）。
- **PR3 で実装したこと**: サブ統括の起動時の許可の一覧に、`parent_request`・`parent_report`（と `node_spawn`・`node_review`・`scope_decide` など統合の道具）を入れた（`launchToolNames("integrator")`）。サブ統括が、自分の孫の依頼を実際に受けて実行できる。人間専用の操作（`node_hookToken`・`node_purge` など）は入れない。
- **Rationale**: CLI のアダプタは親のセッションに依頼する作りで、サブ統括は実セッションを持つ。認可の規則の変更が要らない。
- **Rejected alternatives**: root が代行 — 孫の数だけ root が詰まり、`directChild` の規則も変える。

## 2026-11-22 範囲拡張の承認は直接の親が決める（許可の面）

- **Decision**: 孫の `scope_extend` は直接の親（サブ統括）が `scope_decide` で判定する。サブ統括の有効な範囲を超える拡張は、サブ統括が自分の親へ `scope_extend` を出す連鎖にする（元の案どおり）。
- **PR3 で実装したこと**: サブ統括の許可の一覧に `scope_decide` を入れた。連鎖の後半（サブ統括が親へ `scope_extend` を出す）のために、統合ロールに子の操作（`scope.extend`・`report.done` など）を足した（[touryou-168-integrator-child-operations.md](./touryou-168-integrator-child-operations.md)）。サブ統括の `scope_extend` は、サブ統括自身の直接の親が `scope_decide` で判定する。
- **Rationale**: 承認の責任が階層で分かれ、root の受信箱に孫の細かい拡張が流れ込まない。
- **Rejected alternatives**: 常に root が承認 — root が孫の数だけ詰まる。直接の親が決め、超える分は拒否のみ — サブ統括が詰まる。
