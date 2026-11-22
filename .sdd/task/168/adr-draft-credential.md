---
id: "adr-touryou-subintegrator-credential"
title: "サブ統括の資格 決定ログ（案）"
type: "adr"
status: "draft"
sdd-phase: "plan"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: []
tags: ["touryou", "168"]
category: ""
---

# サブ統括の資格 決定ログ（案）

> 案。承認後に `.sdd/adr/touryou.md` の末尾へ追記する（そのとき status の扱いはテンプレートに従う）。判断 1 は利用者が案 A を選択済み（親経由・受信箱 3487）。

## 2026-11-22 サブ統括の紐付けはノードのロールに従った統合トークンで行う

- **Decision**: `bind.redeem` は、bind コードに結びつくノードの `role` を読み、`integrator` なら統合トークン、`child` なら子トークンを発行する。ロールは呼び出し側の引数から受け取らない。`checkPrincipal` の「トークンのロール＝ノードのロール」は維持し、`node.bindCode`・`node.hookToken` の `integratorNotSupported` を解除する。bind コードは直接の親の統合ノードが `node.bindCode` で発行する（一度きり・10 分の期限は保つ。human の発行は現状どおり）。
- **Rationale**: 紐付けの経路を 1 本に保てる（一度きり・10 分・SHA-256 保持の既存の防御をそのまま使う）。ロールがノードの属性で決まるので、子が自分で統合に昇格する経路ができない。権限の違いは `ROLE_OPERATIONS` と部分木の規則で表され、サブ統括の操作は自分の部分木の外に効かない。root の常駐トークンと違い、ブリーフ（範囲）を持つ。
- **Rejected alternatives**: 統合用の別の bind 経路 — 経路が 2 本になり、防御（期限・スロットル）を二重に保つ必要がある。root が統合トークンを代行発行 — 一度きり・期限の仕組みを迂回し、root に秘密の受け渡しが集中する。統合ノードの紐付けを今後も不可にする — #168 の目的を満たさない。
