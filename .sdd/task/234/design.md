# #234 統合済みの子の worktree とブランチを一括で回収する（設計）

状態: 決定済み（親の決定 seq 4850: A=4、B=1、C=人間のみ）。実装済み。

## 0. 決定と、実装の実態（設計案からの差分）

- A=4: 祖先判定で `merged: true` と分かるものだけを一括の対象にする。スカッシュ・リベース済みは `notMerged` で対象外に出し、個別の `touryou reclaim <nodeId>` を案内する（docs と CLI の表示に書いた）。
- B=1: `--yes --expect <digest>`。照合の値は daemon が sha256 の先頭 12 桁で計算する（回収できる子と先端の組。`touryou reclaim` の FNV-1a とは別）。
- C: 人間のロールだけ。`ROLE_OPERATIONS.human` にだけ `node.reclaimBatchPreview`・`node.reclaimBatch` を足し、integrator・child には足していない（core の試験と daemon の試験で確かめた）。
- 3.1 の差分: `node.reclaimBatch` の params は `expectDigest` だけ（対象 ID の配列は受けない。daemon が実行の直前に再計算して、照合の値が違えば `digestMismatch` で何も消さない）。
- 3.1・5 の差分: 理由 `unpushed` は足さず、既存の `UnmetReason`（`notMerged`・`dirty` など）に写した。リモートへの push は見ない。親のブランチへの統合と未コミットで、成果の取りこぼしを防ぐ。この限界は docs に書いた。
- 3.3: daemon の作業ツリーの置き場（`worktreeRoot`）の単位で閉じる前提。複数リポジトリを混ぜる設計は、この変更では足していない。
- 1 件の失敗は `failed` に入れて残りを続ける。強制は使わない。
- MCP には、一括の道具を出していない（人間専用）。

## 1. 事実（コードで確かめたもの）

- 回収の判定は `packages/core/src/reclaim.ts` の `assessReclaim`（条件 1〜6）。対象にできる状態は `verified`・`stopped`・`reclaimable`。
- 統合済み（条件 1）は、daemon の `factsFor`（`packages/daemon/src/git-ports.ts`）が決める。
  `git merge-base --is-ancestor <子のブランチ> <上流>` が成功したときだけ `merged: true`。上流がない・祖先でないなら `false`。
  このため、**スカッシュマージ・リベースマージで main に取り込んだ PR は `merged: false`** になる（子の先端が main の祖先でないため）。
- 回収は `node.reclaimPreview`（読み取り）→ `node.reclaim`（実行。1 つの対象と配下を後順に、daemon 全体で直列）。
  `node.reclaim` は部分木（自分を含まない子孫）だけ。人間のロールには、部分木の制限がない読み取りのプレビューだけがある。
- 強制の回収（`--force`・`-D`）は、停止ノードを人間が破棄と判断した（`node.discardDecided`）ときだけ。ふつうの回収（`verified`）は `git worktree remove`（強制なし）と `git branch -d`（統合済みだけ）。
  つまり未コミット・未 push があれば、ふつうの回収は git 自身が失敗で拒否する。ただしこれは最後の防壁で、プレビューの時点で対象外にする。
- `touryou reclaim` は人間のロール（`--yes --expect <digest>`）。照合の値は先端の FNV-1a 畳み込み。破棄の指示は `node.reclaimInstruct`（人間のみ）。
- 現状、`verified` のノードの回収を実行できるのは、親の統合ノード（AI）の `node.reclaim`。**人間が一括で回収する手段はない**。

## 2. 要件（issue #234）

1. 統合済みの子の一覧（プレビュー）。未コミット・未 push があるものは対象外にし、理由つきで出す。
2. 人が確認してから一括で実行する。取り消せない操作なので `node_reclaim` と同じ確認を挟む。
3. リポジトリごとに閉じた片付け（#218・#160 と関連）。

## 3. 設計案

### 3.1 新しい操作

- `node.reclaimBatchPreview`（人間のみ。読み取り）: 候補を一覧にして返す。
  - 候補: 状態が `verified` で、そのノードの PR が統合済みと判定できるもの（判定は「決めること」A）。
  - 各行: `nodeId`・`eligible`・対象外の理由（`dirty`・`unpushed`・`notMerged`・`processesRunning`・`openDecision`・`dependentsIncomplete`・`unknown` など）・失われるものの要約。
  - 対象外の理由は、既存の `assessReclaim` の `unmet` に、`unpushed`（上流より先に進んだ未 push のコミット）を足して表す。
  - 返す値に、対象の一覧の**照合の値**（`digest`。ノード ID と先端の組を畳んだもの）を付ける。
- `node.reclaimBatch`（人間のみ）: `expectDigest` と対象 ID の配列を受け、実行の直前に再判定する。
  - `digest` が違えば、何も消さず `tipMismatch`（既存と同じ扱い）。
  - 1 件ずつ、既存の回収（`execute`）を通す。**強制（`-D`・`--force`）は使わない**。破棄の判断が要るもの（`stopped`）は対象に入れない。
  - 1 件が失敗しても、ほかの件は続け、結果に件ごとの成否を返す（リポジトリごとに閉じる。3.3）。

### 3.2 安全の面（最優先）

- 一括の 2 操作は、**人間のロールだけ**。ロール表（`OPERATION_ROLES` など）で root・integrator・child に許さない。表と試験で確かめる。
- 親の AI が一括で消せないことを、既存の `node.reclaim`（親の統合ノードは自分の部分木だけ）と混ぜない。新しい操作は別名にして、AI のトークンでは `forbidden` にする。
- 未コミット・未 push は、プレビューで対象外にし、実行の直前に再判定して、1 つでも変わっていたら、そのノードだけ飛ばして理由を返す。
- 強制は使わない。未 push の成果を黙って捨てない。git 自身の拒否（`-d`・`worktree remove`）が、最後の防壁として残る。
- 人間の確認は、`touryou reclaim` と同じ形（表示 → `--yes --expect <digest>`）。

### 3.3 リポジトリごとに閉じる

- 一括は、ひとつのリポジトリ（daemon が扱う作業ツリー置き場）の中で完結する。別のリポジトリのノードを混ぜない。
- 実装の前に、daemon が複数リポジトリのノードを同じ木で持つのか（#218・#160）を、コードで確かめる。

### 3.4 CLI・MCP・docs

- CLI: `touryou reclaim-merged`（仮）。引数なしでプレビュー、`--yes --expect <digest>` で実行。
- MCP: 子・root の道具には出さない（人間専用）。ロール表と試験で確かめる。
- docs: `docs/reclaim-loss.md` に一括の節、`plugin/skills/integrator` に「一括は人間に依頼する」手順を書く。

## 4. 決めること（利用者の判断が要る）

### A. スカッシュマージで main に取り込み済みかの判定

現状の `--is-ancestor` は、スカッシュマージを検出できない（事実の節）。

1. GitHub の PR の状態（`gh pr view --json state,mergeCommit`）を使う。確実だが、`gh` と認証・ネットワークに依存する。
2. `git cherry`／パッチの同一性で判定する。オフラインで動くが、スカッシュ（複数コミットを 1 つにする）は検出できないことが多い。
3. 「子のブランチの木（tree）と、上流の同じパスの内容が一致する」で判定する。スカッシュ後に main が進んでいると外れる。
4. 一括の対象を、**祖先判定で統合済みと分かるもの（`merged: true`）だけ**にする。スカッシュ済みは対象外に出して、既存の `touryou reclaim`（個別）に任せる。最も安全だが、このリポジトリの運用（スカッシュマージ）では、ほとんど対象にならない可能性が高い。

### B. 一括の確認の形

1. `touryou reclaim` と同じ `--yes --expect <digest>`（対象の一覧全体の照合の値）。
2. 1 に加えて、件数を打ち込ませる（画面は、対象の件数を入力）。
3. 1 件ずつ確認する。

### C. 人間のロールだけに許すか

- 提案: 人間だけ（上記 3.2）。親の統合ノード（AI）にも、確認つきで許す案もあるが、「親の AI が一括で消せない」が最優先の安全の面なので、採らない。

## 5. 試験の方針

- core: `unpushed` の判定、対象外の理由の並び（純粋関数）。
- daemon: プレビュー（対象・対象外の理由）、実行（digest の不一致で何も消さない・未コミット／未 push は飛ばす・強制を使わない）、ロール表（人間以外は `forbidden`）。
- cli: プレビューの表示、`--yes` に `--expect` が要ること。
- mcp: 子・root の道具の一覧に出ないこと（`parent-readonly-tools.test.ts` と同じ形）。
