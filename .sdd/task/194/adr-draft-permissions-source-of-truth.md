---
id: "adr-permissions-source-of-truth"
title: "子の権限管理 決定ログ（正本と上限の変更の方式）"
type: "adr"
status: "draft"
sdd-phase: "plan"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: ["design-194"]
tags: ["permissions", "scope", "config"]
category: "security"
---

# 子の権限管理 決定ログ（正本と上限の変更の方式）案

> 案。親の承認の後に、`.sdd/adr/touryou.md`（または機能ごとの決定ログ）へ追記する。状態は承認までは draft。設計は [design.md](design.md) の § 3.1〜3.3。

## 2026-11-22 権限の正本を daemon 側に置き形式を permissions の部分集合にする

- **Decision**: 子の権限の正本は、daemon 側（リポジトリの外）の config.json とイベント列（stateDir）に置く。書き方は Claude Code の `permissions`（allow / deny / ask）の部分集合（`Bash(<語>:*)`・`Edit(<相対>/**)`・`mcp__<サーバー>__<道具>`）にそろえ、解析できない書き方は、無視せず設定の誤りとして断る。作業ツリーの `.claude/settings*.json` は、daemon が読まない。
- **Rationale**: 作業ツリーの中のファイルは、子が書き換えられる。権限の正本を、権限を受ける側が書けるところに置くと、権限の意味がなくなる。daemon の config と stateDir は、すでに子の読み書きが禁じられている（`hook-policy.ts` の `ProtectedKind`）。書き方を Claude Code にそろえると、利用者が学ぶものが増えない。解析できない書き方を黙って無視すると、利用者は規則が効いていると思い込む（deny の取りこぼしが最も危険）ので、フェイルクローズにする。
- **Rejected alternatives**: リポジトリ内の settings.json を正本にする — 子が書き換えて、自分で権限を広げられる。独自の書き方 — 利用者の学習が増え、Claude Code の規則との食い違いが出る。解析できない項目を無視する — deny の取りこぼしが、黙って起きる。

## 2026-11-22 上限の変更を読み込み直しと実行中の追加の二層にし再起動を要しなくする

- **Decision**: 子に付与できる範囲の上限（`permissions.allow`）は、「config の方針（人間が編集し、`config.reload` で読み込み直す）」と「実行中に足した規則（イベント `policy.ruleChanged`。行為者は人間だけ）」の和で決める。root の AI は、上限を広げられず、上限の内側で承認できるだけにする。読み込み直しは、`rootScope`・`permissions`・`autoApprove` だけを対象にし、原子的に入れ替える（検査に失敗したら今の方針のまま）。ファイルの自動監視はしない。
- **Rationale**: 再起動が要る本当の理由は、上限が config にあって起動のときだけ読まれること（`scope-handlers.ts` の `checkApprove`）。コマンドの承認自体は、`effectiveScope` がイベント列から導くので、もともと再起動を要しない。上限の拡大は権限の昇格にあたるので、行為者を人間に限る。実行中の追加をイベントにすると、監査・取り消し・再起動後の復元が、既存の拡張と同じ仕組みで得られる（状態に二重に持たない）。自動監視は、編集の途中を読む・利用者の知らない間に権限が変わる危険がある。
- **Rejected alternatives**: ファイルの変更を自動で監視して反映する — 編集の途中の読み込みと、意図しない権限の変更。root の AI にも上限を広げさせる — AI の判断（子の文に影響される）で権限が昇格する。config だけを読み込み直し、実行中の追加は持たない — 画面から上限に足す流れがなく、利用者が config を編集する手間が残る。上限の変更を、再起動のままにする — Issue の痛み（紐付けの出し直し）が解消しない。
