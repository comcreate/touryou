---
id: "adr-human-settings"
title: "子の権限管理 決定ログ（人間の settings.json の扱い）"
type: "adr"
status: "draft"
sdd-phase: "plan"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: ["design-194"]
tags: ["permissions", "settings", "deny"]
category: "security"
---

# 子の権限管理 決定ログ（人間の settings.json の扱い）案

> 案。利用者の回答（判断 2/2、案 C）を反映済み。親の承認の後に、決定ログへ追記する。設計は [design.md](design.md) の § 3.7。

## 2026-11-22 人間の settings.json は deny だけを常時読み allow は読まない

- **Decision**: 子の権限が、人間自身の Claude Code の権限より広がらないよう、人間の設定のうち `deny` だけを、daemon の判定に必ず足す。`allow` は読まない（上限は、daemon の config の `permissions.allow` だけで決める）。読む対象は、ユーザー階層（`~/.claude/settings.json`）と管理者の設定だけに限る。作業ツリーの `.claude/settings*.json` は、子が書き換えられるので、読まない。読み込みに失敗したとき・解析できないときは、設定の誤りとして知らせ、その deny を黙って捨てない。
- **Rationale**: 人が deny したものを、子が使えてしまうのは、利用者の意図に反する。deny は、読み損ねると権限が広がる向きなので、読むなら常時にする。allow を読むと、人の広い許可に、子が引きずられる（人間用に広く許した設定が、そのまま子の上限になる）うえ、読み込みの失敗の振る舞いが複雑になる。読む場所を、子が書けない階層に限れば、子が deny を消すことはできない。
- **Rejected alternatives**: 読まない（A）— 人の deny が子に効かない（v0.1.7 の暫定）。取り込みコマンドで 1 回だけ写す（B）— 人が deny を足した後の食い違いが、黙って残る。deny と allow の交わりを上限にする（D）— 人の広い allow に引きずられ、読み込み失敗の扱いが複雑。作業ツリーの設定も読む — 子が書き換えて、権限を変えられる。

## 2026-11-22 段階を分けて v0.1.7 は読まず v0.2.0 で入れる

- **Decision**: v0.1.7 では、人間の settings.json を読まない（A）。daemon の config の `permissions.deny` で、同じ効果を手で書ける。v0.2.0 で、ユーザー階層と管理者の設定の deny を常時読む（C）。
- **Rationale**: 読む処理は、場所の特定（OS・管理者の設定の場所）、書き方の差の吸収、失敗時の扱いを含み、v0.1.7 の主題（正本・MCP・再起動なし）から独立している。先に正本の形を固めれば、deny を足す入口は、判定の順序（deny が最優先）に、すでにある。
- **Rejected alternatives**: v0.1.7 に含める — 範囲が広がり、主題の検証が遅れる。v0.2.0 でも入れない — 人の deny が、いつまでも子に効かない。
