---
id: "adr-draft-159-runtime-ownership"
title: "子ごとの runtime の持ち場 決定ログ（案）"
type: "adr"
status: "draft"
sdd-phase: "plan"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: ["design-159-v017"]
tags: ["runtime"]
category: "developer-tooling"
---

# 子ごとの runtime の持ち場 決定ログ（案）

親の承認のあと、[touryou.md](../../adr/touryou.md) の末尾に追記する（本書は案。opt-in の方針は、利用者の判断 1 で A に決まった）。

## 2026-11-22 子の runtime はノードの属性を正とし、spawn の引数は入力にとどめる

- **Decision**: 子の実行環境（`cli` | `desktop`）は、`node.created.runtime`（ノードの属性）を正とする。`node_spawn` に任意の `runtime` 引数を足すが、それは入力で、検証して属性に写す。daemon の設定 `childRuntime` は、引数がないときの既定値に格下げする。振り分け（アダプタ・整合・引き出し・フックの受け口・bind の文面）は、すべて 1 つの関数（`runtimeOf`）が返す属性で決める。属性は不変とし、付け替えは、止めてから採用し直す。Desktop の子を足せる条件（opt-in の設定）は利用者の判断 1 で決める（推奨: 設定に明示の許可を足し、既定は無効）。
- **Rationale**: 状態はイベントログから導く（ADR 2026-11-14）。runtime はすでに 0.1.6 で `node.created` に記録されているので、イベントの型を変えず、`STATE_VERSION` も変えずに済む。属性が正なら、daemon の再起動後も、画面・受信箱・起動時の整合・見張りが同じ答えを出す。判定を 1 つの関数に集めるのは、フックの受け口の取り違え（CLI の子に Desktop のポリシーを使う等）が安全面の欠陥になるため。
- **Rejected alternatives**: spawn の引数だけを使い、選択をアダプタのメモリにだけ持つ — 再起動で子の種類が失われ、整合・画面が何で判断するか決まらない。木を runtime ごとに分け、daemon を 2 つ動かす — 「同じ木」にならず、画面・受信箱が割れる。`childRuntime` の設定を木全体の切り替えのまま残す — 今の課題（daemon の再起動と引き換えの切り替え）が解けない。属性を付け替え可能にする — 引き出し・トークン・フック設定の後始末が絡み、安全面の穴になる。
