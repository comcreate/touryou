---
id: "adr-touryou-89-status-screen-graph"
title: "状態画面の「いま何が起きていて何をすればよいか」の作り 決定ログ（#89）"
type: "adr"
status: "approved"
sdd-phase: "implement"
sdd-version: "5.3.3"
created: "2026-11-17"
updated: "2026-11-17"
depends-on: []
ticket: "89"
tags: ["touryou", "ui", "89"]
category: ""
---

# 状態画面の「いま何が起きていて何をすればよいか」の作り 決定ログ

関係図の描画の道（Rete.js）は、[touryou.md](touryou.md) の 2026-11-17 の決定を正とする。ここには、その後の利用者の答え（2026-11-17 の追記）のうち、見本・表示モデル・操作の範囲・線・箱・動き・図の形に関する決定を残す。

## 2026-11-17 見本を作り直し、上りと下りを動きで分けて示す（#89 D1）

- **Decision**: 見本を作り直す。動きで、上りと下りを分けて示す。
- **Rationale**: 利用者の答え（D1）による。
- **Rejected alternatives**: None considered.

## 2026-11-17 表示モデルに値を足し、題は目的の先頭を約 80 字に整える（#89 D3）

- **Decision**: 表示モデル（`ui-view.ts`）に値を足す。題は、目的の先頭を約 80 字にする。
- **Rationale**: 利用者の答え（D3）による。
- **Rejected alternatives**: None considered.

## 2026-11-17 止まっている子には `claude attach <ノード ID>` と写すボタンを出し、セッション ID は出さない（#89 D5）

- **Decision**: 止まっている子には `claude attach <ノード ID>` と、それを写すボタンを出す。セッション ID は出さない。Desktop の子には、開き方の文を出す。
- **Rationale**: 利用者の答え（D5）による。
- **Rejected alternatives**: None considered.

## 2026-11-17 受信箱は、まずたたむだけにし、片付けは #99 で扱う（#89 D6・E5）

- **Decision**: 受信箱は、まずたたむだけにする。片付けは #99 で扱う。
- **Rationale**: 利用者の答え（D6・E5）による。
- **Rejected alternatives**: None considered.

## 2026-11-17 #88 を先に入れ、#89 の PR-4（画面の作り直し）は #88 のマージのあとにする（#89 D7）

- **Decision**: #88 を先に入れる。#89 の PR-4 は、#88 のマージのあとにする。
- **Rationale**: 利用者の答え（D7）による。
- **Rejected alternatives**: None considered.

## 2026-11-17 動く玉は CSS の `offset-path` で動かし、その設定は 1 か所にする（#89 D8）

- **Decision**: 玉の動きは CSS の `offset-path` で動かす。`offset-path` を設定する場所は 1 か所にする。
- **Rationale**: 利用者の答え（D8）による。
- **Rejected alternatives**: None considered.

## 2026-11-17 線は藍 1 色・すべて破線にし、新しいほど濃くし、柿色は答え待ちだけに使う（#89 F4）

- **Decision**: 線は藍 1 色で、すべて破線にする。新しいほど濃くする。柿色は答え待ちの線だけに使う。
- **Rationale**: 利用者の答え（F4）による。
- **Rejected alternatives**: None considered.

## 2026-11-17 箱は「出番・進んでいる・終わった」の 3 段で示し、印と文字を添える（#89 F5）

- **Decision**: 箱は「出番・進んでいる・終わった」の 3 段で示し、印と文字を添える。
- **Rationale**: 利用者の答え（F5）による。
- **Rejected alternatives**: None considered.

## 2026-11-17 線の動きは sent・delivered・done に合わせ、子 → 親の届いたかは分からないと示す（#89 F6）

- **Decision**: `sent` は速く流れ、`delivered` はゆっくり流れ、`done` は止まる。子 → 親の線は `deliveryUnknown` と示し、頼みの `done` は `doneInferred` と示す。
- **Rationale**: 利用者の答え（F6）による。
- **Rejected alternatives**: None considered.

## 2026-11-17 図は枝分かれの案 B にし、一覧と図は切り替えて持つ（#89 F1・F2）

- **Decision**: 図は案 B とし、親の箱は 80px のままにする。右の幹から子ごとに枝分かれさせ、灰色の線は出さない。やり取りのまだない子は、薄い点線の枝にする。一覧と図は、切り替えて持つ。
- **Rationale**: 利用者の答え（F1・F2）による。
- **Rejected alternatives**: None considered.

## 2026-11-17 図に出す子の数に上限は設けず、たたむ操作は要るようになったら足す（#89 F3）

- **Decision**: 図に出す子の数に上限を設けない。たたむ操作は、要るようになったら足す。
- **Rationale**: 利用者の答え（F3）による。
- **Rejected alternatives**: None considered.

## 2026-11-17 子 → 親の「届いた」の記録（`inbox.acknowledged`）は #102 で扱う（#89 F7）

- **Decision**: 子 → 親の「届いた」の記録（`inbox.acknowledged`）は #102 で扱う。
- **Rationale**: 利用者の答え（F7）による。
- **Rejected alternatives**: None considered.
