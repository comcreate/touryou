---
id: "adr-touryou-161-multi-daemon"
title: "複数のリポジトリは root ごとに daemon を分ける 決定ログ（#161）"
type: "adr"
sdd-phase: "implement"
status: "approved"
created: "2026-11-21"
updated: "2026-11-21"
depends-on: []
tags: ["touryou", "161"]
category: ""
---

# 複数のリポジトリは root ごとに daemon を分ける 決定ログ（#161）

## 2026-11-21 複数のリポジトリは、1 つの daemon に複数 root を持たせず、root ごとに daemon を分ける

- **Decision**: root ごとに別の daemon（別の設定・stateDir・トークン）を並べる。接続先は `--config` と `TOURYOU_DAEMON_CONFIG` で決める。
- **Rationale**: 「別の root の木・受信箱・トークンに触れない」を、プロセスとファイル権限の境界で満たせる。core と daemon 本体は無変更で、単一 root の利用者に影響しない。弱点として、同じ OS ユーザーなので別の daemon の stateDir を OS の権限では防げない（運用の注意になる）。
- **Rejected alternatives**: 1 つの daemon に複数 root を持たせる案 — イベント・投影・権限・トークン・画面の全層に複数 root の概念を入れる大きな変更で、隔離がアプリ内の論理境界になり、漏れたときの影響が大きい。
