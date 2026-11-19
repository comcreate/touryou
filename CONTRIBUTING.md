# 貢献のしかた

## 開発の準備

- macOS（Apple Silicon）か Linux。Node 22 以上と pnpm（`packageManager` で固定。`corepack enable`）。
- `pnpm install --frozen-lockfile` → `pnpm build`。

## 確かめ

変更を出す前に、手元で次を通してください（CI と同じ検査です）。

```sh
bash scripts/check.sh
```

- 起動スクリプト・plugin の中のシェルは、macOS の `/bin/bash`（3.2）と `/bin/sh` でも動く書き方にします（`sed -E` だけ・`awk` を使わない・`$変数` の直後に ASCII でない文字を置かない、など）。
- 実機でしか確かめられないことは、`docs/manual-verification-checklist.md` に項目を足します。

## 進め方（AI-SDD）

このリポジトリは、AI-SDD（仕様駆動の開発）に従います。要求・仕様・設計・タスクは `.sdd/` にあります（`.sdd/AI-SDD-PRINCIPLES.md`）。機能を足すときは、`.sdd/task/` のタスクの表に行を足してから実装します。

手元の Mac で、統括（root）のセッションと常駐の手伝いのセッション（見回り・ボード・UI レビュー・UX レビュー）で進めるときの skill は `.claude/skills/` にあります。使い方と設定（環境変数・設定のファイル）は [`docs/dev-orchestration.md`](docs/dev-orchestration.md)。

## PR

- 1 つの PR は 1 つの目的にします。説明には、変えたこと・確かめたこと（手元の検査の結果）・実機で確かめることを書きます。
- トークン・API キー・個人のパス・ユーザー名・メールアドレスを、コード・文書・PR・ログに書かないでください（ホームは `<H>` と書きます）。
- 文書は日本語で書きます。

## 行動の規範

相手を尊重して、具体的に話してください。
