---
id: "adr-touryou-approval-route"
title: "承認と依頼の経路 決定ログ（案）"
type: "adr"
status: "draft"
sdd-phase: "plan"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: []
tags: ["touryou", "168"]
category: ""
---

# 承認と依頼の経路 決定ログ（案）

> 案。判断 2・3 は未提出・未回答（推奨で記述）。

## 2026-11-22 範囲拡張の承認は直接の親が決め、親の範囲を超える分は連鎖して上へ上げる

- **Decision**: 孫の `scope_extend` は直接の親（サブ統括）が判定する。サブ統括の有効な範囲を超える拡張は、サブ統括が自分の親へ `scope_extend` を出し、その承認を得てから孫の拡張を承認する。root まで一気に上げることはしない。
- **Rationale**: 孫の範囲は常にサブ統括の内側という不変条件を保つ。承認の責任が階層で分かれ、root の受信箱に孫の細かい拡張が流れ込まない。サブ統括の範囲を超える拡張は、親の範囲を超える拡張と同じ規則になる。
- **Rejected alternatives**: 常に root が承認 — root が孫の数だけ詰まり、サブ統括を置く意味が薄れる。直接の親が決め、超える分は拒否のみ — サブ統括が詰まる。

## 2026-11-22 孫の起動・停止・削除の依頼は直接の親が受ける

- **Decision**: 依頼（`parent_request`）と報告（`parent_report`）の宛先は直接の親（サブ統括）とする。現行の `directChild` の規則のまま変えない。知らせは親セッション（`parentSession`）へ送る。サブ統括が応答しないときの孫の停止は、既存の `node.stop`・`node.confirmStopped` による root の経路で救う（詳細は design.md §5 の宿題）。
- **Rationale**: CLI のアダプタは親のセッションに依頼する作りで、サブ統括は実セッションを持つ。認可の規則の変更が要らない。
- **Rejected alternatives**: root が代行 — 孫の数だけ root が詰まり、`directChild` の規則も変える。

## 2026-11-22 木の深さの上限を設定値にし、既定を 3 とする

- **Decision**: 設定 `maxTreeDepth`（既定 3。root=0）を設け、spawn・adopt で超える深さのノードを `depthExceeded` で断る。`validateTree` にも不変条件として入れる。
- **Rationale**: 起動の同時数・digest・UI・連動停止の検証範囲が深さに比例して増える。設定で調整でき、ログの再生でも壊れた木を作らない。
- **Rejected alternatives**: 上限なし — 検証しきれず、停止の連鎖が深くなる。2 段に固定 — 試験は単純だが、設定では広げられない。
