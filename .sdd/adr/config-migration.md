---
id: "adr-config-migration"
title: "子の権限管理 決定ログ（config の移行と版の組み合わせ）"
type: "adr"
status: "draft"
sdd-phase: "plan"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: ["design-194"]
tags: ["config", "migration", "compatibility"]
category: "compatibility"
---

# 子の権限管理 決定ログ（config の移行と版の組み合わせ）案

> 案（`.sdd/task/194/adr-draft-config-migration.md` から、#194 の PR2 で移した）。状態は、親の承認までは draft。設計は [design.md](../task/194/design.md) の § 4。

## 2026-11-22 config は追加だけで拡張し rootScope を残して必須のままにする

- **Decision**: config に、省略できる `permissions`（allow / deny / ask）と `autoApprove` を足す。`rootScope` は残し、必須のままにする（`writableLocations`・`forbiddenLocations` を持つため）。読み込みのときに、`rootScope` と `permissions` を 1 つの方針（`RootPolicy`）に正規化し、同じ内容の重複は 1 つにまとめ、同じ規則が allow と deny にあれば deny が勝つ。`configVersion` のような版の項目は足さない。
- **Rationale**: 追加だけの変更なら、旧の config は、新の daemon でそのまま、同じ意味で動く。`rootScope` の意味（子の範囲の上限）を変えないので、利用者の理解も壊さない。`allowedCommands` は、Issue が「互換のため残す」と求めている。版の項目を足すと、新旧の判定の分岐が増える。
- **Rejected alternatives**: `rootScope` を廃止して `permissions` に一本化する — 既存の利用者の config が、すべて壊れる。`configVersion: 2` を導入する — 追加だけの変更に、分岐を持ち込むだけ。自動で config を書き換えて移行する — 利用者の知らない間に、権限の設定のファイルを変える。

## 2026-11-22 新旧の版の組み合わせは旧の daemon が新しい項目を未知のキーとして拒否する

- **Decision**: 旧の daemon（〜0.1.6）は、新しい config の `permissions`・`autoApprove` を、未知のキーとして起動を拒否する（今の挙動のまま。配布済みなので変えられない）。新の daemon は、旧の config をそのまま読む。新の daemon の「未知のキー」の文に、「新しい版の項目なら daemon の版を上げる」と案内を足す（PR2 で入れた。項目ごとの名前の表は、案内が要る将来の項目ができるまで持たない）。ダウングレードの手順（新しい項目を消してから、旧の daemon を起動する）と、新しい種類のイベント（`kind: mcp`・`revoked`・`policy.ruleChanged`）を書き始めた後は戻せないことを、`docs/` に書く。
- **Rationale**: 権限の設定が、黙って無視されるより、起動が止まるほうが安全（フェイルクローズ）。イベント列は、旧の daemon が未知の種類を読めないので、新しい機能を使い始めるまでは戻せる、という境界を明示するのが正直。任意の `touryou config migrate`（標準出力だけ）で、移行の手間を下げる。
- **Rejected alternatives**: 旧の daemon に、新しい項目を無視させる — 不可能（配布済み）で、もし可能でも deny の取りこぼしが、黙って起きる。スナップショットの互換の層を、新の daemon が持ち、旧の形で書き続ける — 新機能の分岐が、イベントの書き込みの全体に広がる。
