---
id: "adr-touryou-294-worktreeinclude"
title: "作業ツリーに写すファイルの一覧を .worktreeinclude にする 決定ログ（#294）"
type: "adr"
status: "approved"
sdd-phase: "implement"
sdd-version: "5.3.3"
created: "2026-11-25"
updated: "2026-11-25"
depends-on: []
ticket: "294"
tags: ["touryou", "294", "worktree"]
category: ""
---

# 作業ツリーに写すファイルの一覧を .worktreeinclude にする 決定ログ

#250 で入れた `<repoRoot>/.claude/touryou-worktree-files.json` による一覧を、Claude Code と同じ `.worktreeinclude`（gitignore と同じ構文）に置き換える。

## 2026-11-25 写すファイルの指定を `.worktreeinclude` に一本化し、古い JSON が残っていれば作業ツリーを作らずに止める（#294）

- **Decision**: 写すファイルの指定は `.worktreeinclude` 1 つにする。古い JSON（`.claude/touryou-worktree-files.json`）が残っているときは、作業ツリーを作らずに失敗にし、移行の手順（JSON の各項目を `.worktreeinclude` の行にする規則）を出す。黙って無視しない。
- **Rationale**: Claude Code が作る作業ツリーには `.worktreeinclude` が効くが、daemon が `git worktree add` で作る子の作業ツリーには効かない。同じ意図を 2 つの形式で書かせると、利用者が片方を書き忘れる。JSON を黙って無視すると、写るはずのファイルが写らないまま気づけない。
- **Rejected alternatives**: JSON を黙って無視する（写らないファイルに気づけない）。JSON と `.worktreeinclude` の両方を読む（形式が 2 つ残る）。

## 2026-11-25 この変更は v0.1.7 に入れ、PR は小さく分けて出す（#294）

- **Decision**: 変更は v0.1.7 に入れる。PR は、試験だけの PR、回収の判定の元を記録に変える PR、本体の PR、文書の PR に分けて、順に入れる。本体の PR と文書の PR は同じリリースに入れる。
- **Rationale**: 利用者の決定（v0.1.7 に入れる。PR は小さく分ける）。本体の PR は、利用者が既存の設定を直さないと動かなくなる変更（破壊的な変更）なので、文書と同じリリースに入れ、文書だけ古い状態を作らない。
- **Rejected alternatives**: None considered.
- **未確認**: `CHANGELOG.md` に `0.1.7（2026-11-25）` の節がすでにある。タグと Release が公開済みかは、この決定の時点で確かめていない。公開済みなら、0.1.8 に入れる形を取る必要がある（利用者が決めること）。
