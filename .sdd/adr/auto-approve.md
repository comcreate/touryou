---
id: "adr-auto-approve"
title: "子の権限管理 決定ログ（自動承認の範囲）"
type: "adr"
status: "draft"
sdd-phase: "plan"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: ["design-194"]
tags: ["permissions", "auto-approve", "audit"]
category: "security"
---

# 子の権限管理 決定ログ（自動承認の範囲）案

> 案（`.sdd/task/194/adr-draft-auto-approve.md` から、#194 の PR2 で移した）。利用者の回答が食い違っていた（受信箱 3490: D、3515: C）が、この PR の依頼では「B+C の組み合わせ（案 D）」に決まっている。本書は D 前提で書き、C に変わる場合の差も書く。設計は [design.md](../task/194/design.md) の § 3.5。PR2 では、`autoApprove` の読み込みと検査だけを入れた（承認への接続は PR5）。

## 2026-11-22 人間の規則に一致した読み取り専用のものは daemon が決定的に承認し、それ以外は人の上限の内側で root が承認する

- **Decision**: 人間が config の `autoApprove` に書いた規則に一致する依頼は、daemon が決定的に即時承認する（AI を通さない）。対象は読み取り専用で副作用のないものに限り、`autoApprove` は `permissions.allow` の内側に置く。書き込み・外部への送信・`git push` の規則は、`autoApprove` にも上限（`permissions.allow`）にも入れられない（config の読み込みで断る）。`autoApprove` に当たらず、人の上限の内側のものは、AI の root が承認できる。上限の外は、人間だけが決める。全件を `extensionDecided`（`via` つき）で監査し、`scope.extensionRevoked` で取り消せる。1 つの子あたり 50 件の歯止めを置く。
- **Rationale**: 承認の判断を、子が書ける文（`reason`）に影響される AI に任せると、子の文で承認の範囲が広がる。規則に一致した決定的な承認なら、子の文は結果を変えない。読み取り専用に限り、監査と取り消しがあれば、人の確認の手間を減らしつつ、権限の昇格を防げる。
- **Rejected alternatives**: 自動承認なし（A）— 人の手間が減らない（Issue の痛みが残る）。規則一致の承認だけ（B）— 規則に書いていないが上限の内側のものを、毎回人が承認することになる。root の AI の承認だけ（C）— 読み取り専用の定型まで AI の判断に頼り、子の文の影響を受ける。

## 2026-11-22 回答が C に確定した場合の差

- **Decision**: C（AI の root が人の上限の内側で承認）に確定した場合は、`autoApprove`（PR 5）を実装しない。上限の内側の承認は、root が行い、上限の外は人が決める。PR 1〜4（正本・config・MCP の依頼・`config.reload`）は変わらない。
- **Rationale**: `autoApprove` は、PR 1〜4 から独立した追加であり、外しても他の設計に影響しない。
- **Rejected alternatives**: D のまま進める — 利用者の意思が C なら、意図より広い自動化になる。

## 2026-11-22 config の検査で autoApprove に書ける Bash を、読み取り専用の表の先頭の語に限る（PR2 の実装判断）

- **Decision**: `autoApprove` の `Bash(...)` は、先頭の語の並びが、フックの読み取り専用の表（`READ_ONLY_COMMAND_HEADS`: `find`・`ls`・`grep`・`git grep`・`git ls-files`）にあるものだけを config の読み込みで受ける。`head`・`tail`・`wc`・`cat` は、表を広げる PR（設計書 § 3.4 の 1）が入るまで書けない。
- **Rationale**: 設計書の例（`Bash(tail -n:*)`）と、表にないコマンドは書けないという規則が食い違っていた。規則を優先し、表が広がれば、同じ定数から自動的に書けるようになる。
- **Rejected alternatives**: 例に合わせて `tail` などを先に通す — 表の旗の検査とパスの確かめがないまま、読み取りの範囲が広がる。
