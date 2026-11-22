---
id: "adr-draft-159-desktop-reconcile"
title: "Desktop の子の整合と止まり検知 決定ログ（案）"
type: "adr"
status: "draft"
sdd-phase: "plan"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: ["design-159-v017"]
tags: ["desktop", "reconcile", "stall"]
category: "developer-tooling"
---

# Desktop の子の整合と止まり検知 決定ログ（案）

親の承認のあと、[touryou.md](../../adr/touryou.md) の末尾に追記する（本書は案）。2026-11-14「Desktop の子は起動時の整合でプロセスと照合しない」の決定は覆さず、判定の単位を木からノードに変える。

## 2026-11-22 起動時の整合は子の runtime ごとに行い、Desktop の子だけを外部とする

- **Decision**: 起動時の整合（`reconcileOnStartup`）の「外部の子」の判定（`isExternal`）を、木全体の設定でなく、ノードの `runtimeOf` が `desktop` かどうかにする。外部の子は、これまでどおり、プロセスで照合せず、状態も変えず、根の受信箱に stopIncomplete の帯を 1 件だけ出す。混在の木でも、帯に書く子の数と ID は Desktop の子だけで、CLI の子は `lsof` で照合する。`runtime` の記録がなく、起動の報告もない古い子は、木に `runtime` の記録が 1 つもなく、設定が desktop のときだけ、従来どおり外部とみなす。
- **Rationale**: 2026-11-14 の決定の理由（Desktop の子は daemon の外で動き、再起動の影響を受けないので、プロセスで照合すると動いている子を誤って止まったと記録する）は、子ごとに成り立つ。逆に、CLI の子まで外部扱いにすると、止まった子を見つけられない。`reconcile.test.ts` の既存の試験が、判定は子ごとであることをすでに前提にしている。
- **Rejected alternatives**: 木に 1 つでも Desktop の子がいれば、全体を外部扱いにする — CLI の子の照合が失われる。混在の木では、整合を行わない — 再起動で動いていない CLI の子が、記録の上で動作中のまま残る。

## 2026-11-22 止まり検知は CLI の子だけを対象とし、Desktop の子は判定しない

- **Decision**: 止まっているかも・紐付けていない・紐付けが外れているかも、の見張りは、`runtimeOf` が `cli` の子（採用した子を含む）だけを対象にする。Desktop の子は判定しない（#11 の方針のまま）。Desktop の子に「最後にフックを見た時刻」を画面に出す案は、v0.1.8 以降に回す。
- **Rationale**: Desktop の子は、親を閉じても・アプリを再起動しても、動き続ける・自動で再開することがあり、daemon から止まったと決めつけられない。フックの時刻はメモリだけで、daemon の再起動で消える。判定を入れると、再起動の直後に誤った「止まっているかも」が出る。
- **Rejected alternatives**: Desktop の子にも、フックの時刻だけで止まり検知を入れる — 再起動で時刻が消え、誤報が出る。見張りを、起動の報告の有無のまま残す — 採用した CLI の子が、止まっても知らされない。
