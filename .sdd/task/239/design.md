# #239 + #234 スカッシュマージ後の verified の回収と、統合済みの子の一括回収（統合設計）

状態: 設計（利用者の決定待ち）。コードは変更しない。
対象: issue #239（スカッシュマージ後の `verified` を回収できない）と #234（統合済みの子の一括回収）を 1 つの設計にまとめる（利用者の決定）。

## 0. 記号

- 【確認】: 作業ツリーのコード・文書を読んで確かめた事実（ファイルと行を付ける）。
- 【参照】: `ref-234-design.md`・`ref-239-issue.md` の記述。#234 の実装そのものは、この作業ツリーに無く（`git grep reclaimBatch` が 0 件）、コードでは確かめていない。
- 【推測】: 確かめていない見込み。実装の前に確かめる。

## 1. 事実

### 1.1 統合済みの判定（条件 1）

- 【確認】`assessReclaim` の条件 1 は、事実 `merged === true` だけで満たす（`packages/core/src/reclaim.ts:146,252`）。`merged` は daemon の `factsFor` が決める。
- 【確認】`factsFor` は、`git rev-parse --abbrev-ref <branch>@{upstream}` が取れて、`git merge-base --is-ancestor <branch> <upstream>` が成功したときだけ `merged: true`（`packages/daemon/src/git-ports.ts:1069-1079`）。上流がない・祖先でないなら `false`。スカッシュ・リベースのマージでは、子の commit が上流に残らず、`false` になる。
- 【確認】**判定は 2 か所にある**。実際の削除の `removeWorktree` が、同じ祖先判定をもう一度行い、通らなければ `branchNotMerged` で、何も消さずに失敗する（`git-ports.ts:1117-1130`）。さらに、ブランチの削除は `git branch -d`（`force` でなければ。`git-ports.ts:1176-1178`）。`-d` は、HEAD（または上流）に統合済みでないブランチを断る。したがって、**`merged` の判定だけを広げても、スカッシュ後の回収は、削除の段階で止まる**。この設計は、判定（`factsFor`）・実行前の確認（`removeWorktree` の 1117 行）・ブランチの削除（1178 行）の 3 点を、同じ根拠でそろえる必要がある。
- 【確認】`dirty` の判定 `isClean` は `git status --porcelain --untracked-files=all --ignored=matching` を使い、許可リスト（`seededPaths()`・`regenerable`）・シンボリックリンク以外を `dirty` とする（`git-ports.ts:413-441`）。許可リストの中身は、この設計では確かめていない（Issue #239 の `node_modules`・`.envrc` の報告は【参照】）。
- 【確認】daemon のコードに、GitHub（`gh`）を呼ぶ処理はない（`git grep -E "gh pr|headRefOid|mergeCommit|squash|スカッシュ" -- packages/daemon/src packages/core/src` が 0 件）。PR の head・マージの有無を、daemon は知らない。
- 【確認】`@{upstream}` は、`git rev-parse --abbrev-ref <branch>@{upstream}`（`git-ports.ts:1070`）。作業ツリー作成時に上流を何にするかは、この設計では確かめていない【推測】（子のブランチは親のブランチを上流にする、という前提で `merged` の意味が成り立っている）。

### 1.2 verified に破棄の道がない

- 【確認】`verified` への `stop` は `alreadyFinished`（`packages/core/src/transition.ts:98-102`。`default` 分岐）。`verified` が止められるのは、`transition` の表にない。
- 【確認】`markReclaimable`: `verified` は無条件で `reclaimable` に進む（`transition.ts:136`）。`stopped` は `discarded` が要る（137-146）。判定（`assessReclaim`）が、`verified` は `merged && clean` を要求する（`reclaim.ts:252-253`）。
- 【確認】破棄の経路（`discardPath`）に入るのは、`stopped`、または `reclaimable` で `merged` でないもの（`reclaim.ts:242-243`）。`verified` は入らない。
- 【確認】破棄の指示 `node.reclaimInstruct` は、`state === "stopped"` か、すでに `discarded` が記録されているノードだけ受ける。`verified` は `notStopped`（`reclaim-handlers.ts:428-437`）。メッセージ自身が「統合済みで検証済みのノードは、破棄でなく、通常の回収を使う」と案内している（436 行）。
- 【確認】強制（`--force`・`-D`）を行うのは、`discarded` が記録されていて、状態が `stopped` か `reclaimable` のノードだけ（`reclaim-handlers.ts:741-743`、`forceCandidate` 212-213）。強制の直前に、先端を `refs/touryou/discarded/` に保管する（`git-ports.ts:553-583,1139-1156`）。

### 1.3 実体のない verified

- 【確認】作業ツリーもブランチもない（`gone`）事実は、`factsFor` が作る（`git-ports.ts:1055-1063`）が、ハンドラが使うのは `stopped` と、破棄を経た `reclaimable` のノードだけ（`reclaim-handlers.ts:267-270`）。それ以外は `undefined` にされ、`assessReclaim` が `factsMissing` を返す（`reclaim.ts:249-250`）。
- 【確認】`gone` の記録だけを `archived` にする実行の道は、すでにある（`execute` が `removeWorktree`・`markReclaimable`・`archive` を順に通す。`reclaim-handlers.ts:640-766`。`docs/reclaim-loss.md:48` に「記録だけを archived にする」とある）。足りないのは、`verified` が `gone` を使えないこと（判定の入口）だけ。
- 【確認】`node.reclaim` の実行は、`reclaimable` を経由する。`markReclaimable` は `verified` を許す（`transition.ts:136`）ので、状態の遷移は足りている。
- 【推測】実体のない `verified` に対して `node.reclaim` を呼ぶと `factsMissing` で断られる（`goneUsable` が偽。実行はしていない）。

### 1.4 #234 の実装（【参照】）

- 一括の対象は、祖先判定で `merged: true` と分かるものだけ（`ref-234-design.md:7`）。スカッシュ済みは `notMerged` で対象外に出る（同 7 行）。
- 操作 `node.reclaimBatchPreview`・`node.reclaimBatch`（人間のロールだけ）、CLI `touryou reclaim-merged`、`--yes --expect <digest>`（sha256 の先頭 12 桁。回収できる子と先端の組。同 8 行）。
- `reclaimBatch` の params は `expectDigest` だけ。daemon が実行の直前に再計算して、違えば `digestMismatch`（同 10 行）。
- 1 件の失敗は `failed` に入れて続ける。強制は使わない（同 13 行）。MCP には出さない（同 14 行）。
- 実装の場所は、この作業ツリーでは確かめられない（`main` 未統合）。**取り込んだあとに、行番号を確かめ直す**。

## 2. 要件

1. スカッシュ・リベースでマージされた子を、`notMerged` と誤判定せず、安全に回収できる（#239 期待 1）。
2. `verified` に、人が決める破棄の道がある（#239 期待 2）。
3. 実体のない `verified` を、state.db を直接書き換えずに `archived` にできる（#239 期待 3）。
4. 統合済みの子を、人が確認してから一括で回収できる（#234）。一括は人間のロールだけ・強制なし・digest 照合を保つ。
5. 未統合の成果を、誤判定で消さない（最優先）。

## 3. 設計案 1: 統合済みの判定を広げる

### 3.1 誤判定の危険（共通）

判定を広げる目的は「内容が base に入っている」を言うこと。誤って「入っている」と判定すると、**未統合の成果を `-D` 相当で消す**。したがって、広げた判定で消すときは、次を満たす:

- 消す前に、ブランチの先端を `refs/touryou/discarded/` と同じ仕組みで保管する（取り戻せる。`git-ports.ts:553-583`）。【推奨。案によらない】
- 判定した先端を、実行の直前に照合する（digest・`expectTips`。既存の仕組みと同じ形）。
- 広げた判定を使うことを、人間の確認の画面に、根拠つきで出す。

### 3.2 案 A: PR の head と、作業ツリーの HEAD の一致（GitHub の事実）

- 内容: `gh pr view --json headRefOid,state,mergedAt,baseRefName` で、PR が `MERGED` で、`headRefOid` が、作業ツリーの HEAD（またはブランチの先端）と一致すれば、統合済み。
- データの出どころ: GitHub（`gh`・認証・ネットワーク）。daemon は `gh` を使えない（上の事実）。取る場所の候補:
  - A-1: 人間の CLI（`touryou reclaim`・`reclaim-merged`）が `gh` で取り、daemon に、証拠（ノード ID・PR の番号・`headRefOid`）として渡す。daemon は、渡された `headRefOid` と、ローカルの先端が一致することだけを確かめる。人間のロールの操作だけなので、AI は、証拠を作れない。
  - A-2: daemon が `gh` を呼ぶ。daemon の実行環境に、認証と `gh` が要る。常駐（launchd）の環境での認証は、確かめていない【推測】。
- 誤判定: head が一致すれば、「マージされた PR の head と同じ内容」だと確かだ（commit の SHA が同じ）。PR のマージ後に、ブランチへ追加した commit は、先端が違うので外れる。**最も誤判定が少ない**。
- 限界: PR の head のあと、マージ前にレビューの修正を足して、先端が動いていると、一致しない（その場合は、人が確かめて案 D へ）。PR がない運用（直 push）には使えない。
- 難易度 ★★★☆☆、有効度 ★★★★★。

### 3.3 案 B: ローカルの git だけで、ブランチの差分が base（上流）に入っているかを見る

- 内容: 子のブランチの、親との分岐点からの変更の**差分の内容**が、上流にすでに入っているかを、ローカルの git で判定する。
  - B-1: `git merge-tree --write-tree <上流> <branch>` で、仮にマージしたときの木が、上流の木と同一なら、すでに入っている（`git rev-parse <上流>^{tree}` と比べる）。マージの結果に変更が出ないことを使う。
  - B-2: `git diff <merge-base>..<branch>` の差分を、`git apply --check --reverse` で上流に当てる（すでに入っているなら、逆向きに当たる）。
  - B-3: `git cherry`（パッチ ID）。スカッシュ（複数の commit が 1 つ）は、パッチ ID が違うので、検出できないことが多い（【参照】ref-234 の 4. A-2）。
- データの出どころ: ローカルの git だけ（daemon の既存の `git()`）。`gh`・ネットワークは要らない。
- 誤判定: B-1 は、「マージしても、上流の木が変わらない」ことを言う。**上流がその後に進み、同じ箇所を変えていると、衝突や差が出て、未統合に見える（安全側の誤り）**。逆に、上流が子の変更を**あとで取り消した**場合は、子の変更は「入っていない」のに、マージの結果は上流と同一になり得る（取り消したものを、子のブランチが再び入れるのでなく、上流のままだから）。**取り消し済みの変更を「統合済み」と読む**危険がある【推測。要・試験】。つまり、「差分が base に入っている」と「入って、残っている」を区別できない。
- 難易度 ★★★★☆、有効度 ★★★☆☆。

### 3.4 案 C: 子の最後のコミットの木（tree）と、上流の同じパスの内容の一致

- 内容: 子の先端の木と、上流の木を、子が触ったパスだけ比べる（`git diff --name-only <merge-base> <branch>` の各パスについて、`git rev-parse <branch>:<path>` と `git rev-parse <上流>:<path>` が同じ）。
- データの出どころ: ローカルの git だけ。
- 誤判定: 上流がその後に、同じパスを変えると外れる（安全側）。一方、**子が削除したパス・追加したパスの扱い**、リネームなどに穴がある【推測】。「同じ内容が今も上流にある」だけで、「その PR が入った」ことの証拠ではない（別の経路で同じ内容になった場合も一致する。内容が同じなら、失うものはない、という意味では、成果は残る）。
- 難易度 ★★★☆☆、有効度 ★★☆☆☆〜★★★☆☆。

### 3.5 案 D: 人が確かめた証拠を、人間のロールの操作に付けて渡す（確認つきの上書き）

- 内容: 人間が、`touryou reclaim <nodeId> --merged-as <PR の head の SHA>` のように、「この先端は、PR #n でマージされた」と宣言する。daemon は、ローカルの先端がその SHA と一致することと、その SHA が親の履歴でなく、**子のブランチの履歴にあること**だけを確かめ、宣言を記録（新しいイベント）して、`merged` の事実を満たす。案 A-1 は、この宣言を `gh` で自動で作る形。
- データの出どころ: 人間の宣言（CLI）。AI は使えない（人間のロールの操作だけ）。
- 誤判定: 人間が間違えると、成果が消える。ただし、先端を保管してから消すので、取り戻せる。宣言の記録が監査に残る。
- 難易度 ★★☆☆☆、有効度 ★★★★☆（人間の確認が、毎回要る。一括には向かない）。

### 3.6 案の比較

| 案 | データの出どころ | gh | 誤判定（未統合を統合済みと見る） | 一括向き | 難易度 | 有効度 |
|:---|:---|:---|:---|:---|:---|:---|
| A PR の head の一致 | GitHub（A-1: CLI が取る） | CLI 側だけ | 最も少ない（SHA 一致） | ○ | ★★★ | ★★★★★ |
| B 差分が base に入っているか | ローカル git | 不要 | 取り消し済みの変更を読み違える危険（推測） | ○ | ★★★★ | ★★★ |
| C 木・パスの一致 | ローカル git | 不要 | 別経路で同じ内容になるのは無害。削除・リネームに穴 | △ | ★★★ | ★★〜★★★ |
| D 人の宣言 | 人間の入力 | 不要 | 人が誤ると起きる（保管で取り戻せる） | ✕（1 件ずつ） | ★★ | ★★★★ |

### 3.7 推奨

**A-1（人間の CLI が `gh` で証拠を取り、daemon はローカルの先端との一致だけ確かめる）を主にし、`gh` が使えない・PR がないものは D（人の宣言）に落とす。** B・C は、daemon に自動判定として持たせない（誤判定の危険が A・D より高く、安全側に倒せる保証が弱い）。

理由（設計原則）: 「事実の判定は、事実のある層で行う」（PR のマージは GitHub にある事実。daemon が推測で再構成しない）。「AI が作れない証拠」（人間のロールが取った証拠だけ）に絞ると、人間のロールだけ・強制なし・digest 照合の原則と、そのままつながる。

### 3.8 判定を広げたときの、daemon の変更の形（案 A-1 + D の場合）

- 新しい記録: 「統合済みの証拠」（`node.mergeEvidenceRecorded`。`nodeId`・`evidenceKind: "prHead" | "human"`・`tip`・任意で `prNumber`）。人間のロールだけが書ける。**先端（`tip`）と紐付けた記録**にして、先端が動いたら無効（`discardDecided` の `expectTip` と同じ考え方。`reclaim-handlers.ts:204-209`）。保存データの版が上がる（`docs/reclaim-loss.md:76` の `STATE_VERSION`）。【確認: 版の上げ方は、この設計では確かめていない】
- `factsFor` の `merged`: 祖先判定が真、または、記録の `tip` が今の先端と一致し、`evidenceKind` が有効なら真。事実に、`mergedBy: "ancestor" | "evidence"` を足す（画面・CLI で出し分ける）。
- `removeWorktree`: 1117 行の確認を、`mergedBy` に合わせる。`evidence` のときは、先端を `keepDiscarded` で保管してから、`git branch -D`（`-d` は、スカッシュ後は断るので使えない）を使う。**この `-D` は、`discarded`（破棄）とは別の理由の強制であり、ポートの `force` を流用しない**。新しい引数（例: `mergedEvidence: { tip }`）を足し、`-D` の直前に先端が `tip` と一致することを確かめる。
- `assessReclaim`（core）は、変えない（事実 `merged` を入力に取るだけ）。

## 4. 設計案 2: verified に、人が決める破棄の道

論点: 「統合済みと証明できない `verified`」（例: PR が閉じられた、別の方法で取り込んだ、不要になった）を、人が破棄したい。

### 4.1 案 P: `verified` からも `node.reclaimInstruct` を受ける（`stopped` の経路を広げる）

- `reclaimInstruct` の入口（`reclaim-handlers.ts:428`）を、`stopped` に加えて `verified` にも許す。記録は同じ `node.discardDecided`（`expectTip`・`noTip`）。
- core の変更: `assessReclaim` の `discardPath`（`reclaim.ts:242-243`）に、`verified` で `discarded` が記録されているものを足す。`transition.ts` の `markReclaimable` は、`verified` を、すでに無条件で許す（136 行）ので、遷移の表は変えない。
- 強制の判定 `forceCandidate`・`force`（`reclaim-handlers.ts:212,741`）は、状態 `verified` も対象にする。ただし、`verified` は、**人が `discarded` を決めたものだけ**が `-D`・`--force` になる（`verified` のまま、`discarded` なしでは、強制にならない。既存の `-d` の通常の回収のまま）。
- 影響: `verified` は「依存元が完了とみなす」状態（`COMPLETED_STATES`。`transition.ts:16-20`）。破棄を決めた `verified` が `reclaimable` を経て `archived` になっても、依存元の扱いは変わらない（COMPLETED のまま）。ただし、**成果が捨てられたのに、依存元が「完了」とみなして起動する**。この点は、`discardDecided` を記録する時点で、依存元が未完了でないことを確かめるか、破棄が依存元に影響することを、確認の画面に出す【推測。要確認】。
- 難易度 ★★★☆☆、有効度 ★★★★★。

### 4.2 案 Q: `verified` を、いったん `stopped` に戻す遷移を足す

- `transition.ts` に、`verified → stopped`（`demote` のような新しいイベント）を足し、既存の `stopped` の破棄の道をそのまま使う。
- 欠点: `verified`（親が受理した）の意味が、後から逆戻りする。`COMPLETED_STATES` の意味（依存元が起動できる）と、後戻りが衝突する（依存元がすでに走っているとき）。遷移の表と、`events.ts` の再生（`node.stateChanged`）の両方を変える。
- 難易度 ★★★★☆、有効度 ★★★☆☆。

### 4.3 案 R: 破棄の道を作らず、`stop` を `verified` に許す

- `stop`（`transition.ts:78-104`）の `verified` を許し、`stopping → stopped` へ流す。`verified` の子は、プロセスがない（受理のときに `claude stop`・`claude rm`。`SKILL.md:64`）ので、`stopping` は、プロセスの不在の確認で、すぐ `stopped` になる【推測】。
- 欠点: 案 Q と同じく、意味の逆戻り。`alreadyFinished` の文言（`transition.ts:73-77`）の「検証済みは停止の対象にならない」という契約を壊す。
- 難易度 ★★★☆☆、有効度 ★★★☆☆。

### 4.4 推奨

**案 P。** 状態の意味（`verified` は受理済み）を変えず、「破棄の判断」という**記録（イベント）の上に**道を作る。`stopped` の経路と、同じ記録・同じ強制・同じ保管・同じ照合（`expectTips`）を使える。変えるのは、入口の条件（`reclaim-handlers.ts:428`）、`discardPath`（`reclaim.ts:242`）、`forceCandidate`（`reclaim-handlers.ts:212`）、画面・CLI の入口の 4 点（【確認】コード上の行）。

安全: 破棄は人間のロールだけ（既存。`node.reclaimInstruct` は人間のみ。`docs/reclaim-loss.md:26`）。先端の照合・保管（`-D` の直前）はそのまま。

## 5. 設計案 3: 実体のない verified を archived にする

### 5.1 案 S: `goneUsable` に、`verified` を足す（判定の入口を広げる）

- `reclaim-handlers.ts:267-270` の `goneUsable` に、`self.state === "verified"` を足す。`factsFor` が `gone`（作業ツリーなし・ブランチなし・登録なし。`git-ports.ts:1055-1063`）を返すノードは、`verified` でも、消すものがないので、通常の `execute`（`markReclaimable` → `removeWorktree`（何も消さず成功）→ `archive`）を通る。
- 破棄の判断は要らない（成果の保存先が、すでにない。失うものがない）。ただし、**成果が、本当にどこかへ統合されたのか**は確かめられない（ブランチを手で消した人が責任を持つ）。そのため、**人間のロールだけ**が実行できる形にする（`gone` の `verified` は、AI の `node.reclaim` では扱わない。`reclaim-handlers.ts:593-610` の呼び出し元の role で分ける）。
- 安全: 「消すものがない」ことを、実行の直前にもう一度確かめる（`factsFor` の再取得。既存の `execute` と同じ。651 行）。ブランチが後から復活していたら、`gone` でなくなり、通常の判定に戻る。
- 難易度 ★★☆☆☆、有効度 ★★★★☆。

### 5.2 案 T: 案 P（破棄の判断）に、`gone` の `verified` を含める

- 実体がなくなった `verified` を、`reclaimInstruct`（`noTip: true`）で破棄と決め、`stopped` の `gone` と同じ道（`docs/reclaim-loss.md:48`）で `archived` にする。
- 案 S との違い: 人の判断の記録（`node.discardDecided`）が残る（監査）。案 P の入口を使うだけで、新しい分岐がいらない。
- 難易度 ★☆☆☆☆（案 P ができていれば）、有効度 ★★★★☆。

### 5.3 案 U: state.db を直接書き換える手順を docs に書く

- 採らない（利用者の要望「state.db の直接書き換えは避けたい」。`ref-239-issue.md:17`）。

### 5.4 推奨

**案 T（案 P の道に乗せる）。** 実体のない `verified` は「人が、実体がないと確認した」上で、破棄を決める、という 1 つの流れにする。`gone` の `verified` に限って、`noTip: true` の破棄が自然に通る（先端がないので）。案 S は、案 T の補助（人間がすぐ実行できる）として、必要なら足す（利用者が決める。§8）。

## 6. 設計案 4: #234 の実装を、この設計の上でどう直すか

【参照】#234 は、祖先判定の `merged: true` だけを一括の対象にしている（`ref-234-design.md:7`）。スカッシュ運用のこのリポジトリでは、ほぼ全部が対象外になる（#239 の動機）。以下は、**取り込んだあとの直しの方針**。行番号は、取り込み後に確かめる。

### 6.1 `node.reclaimBatchPreview`

- 候補の条件を、「`merged: true`（祖先）」から、「**統合済みの証拠がある**」へ広げる（§3.7）。証拠は、`mergedBy: "ancestor" | "evidence"` で出し分ける。
- 各行に、`mergedBy`・（`evidence` なら）PR の番号と先端の先頭 12 桁を出す。
- `evidence` のない、スカッシュ済みの行は、`notMerged` で対象外のまま、次の操作を案内する（`touryou reclaim <nodeId> --merged-as …` か、`gh` で証拠を取る手順）。
- `digest` は、これまで（回収できる子と先端の組）に、**`mergedBy` と証拠の `tip`** を畳む（証拠が変わったら、digest が変わる）。
- `verified` の `gone` は、一括の対象にしない（一括は、消すものがある子の片付け。実体のないものは、個別の破棄で扱う。§5。理由: 一括の確認の画面で、「何を消すか」を人が見られない）。【設計の判断。利用者に確認する。§8】

### 6.2 `node.reclaimBatch`

- 実行は、`expectDigest` と、再計算した digest が一致したときだけ（既存のまま）。
- 1 件ごとに、既存の `execute` を通す。**`mergedBy: "evidence"` の子の削除は、§3.8 の「証拠つきの削除」（先端の保管 → `-D`）を使う**。`discarded`（破棄）の強制とは、別の経路（`-D` の理由を、型で分ける）。
- 強制（`--force`）は使わない（作業ツリーの削除は、`dirty` のものを対象外にしてあるので、`--force` は要らない）。
- `evidence` の子は、先端の保管に失敗したら、その子は何も消さずに `failed`（成果を黙って捨てない。既存の `keepFailed`・`discardedStoreFull`。`git-ports.ts:566-570,1149-1154`）。
- 人間のロールだけ（変更なし）。

### 6.3 `touryou reclaim-merged`

- プレビューの表示に、`mergedBy` の列と、証拠の出どころ（PR の番号）を足す。
- **証拠を取る処理を、CLI に足す**（案 A-1）: 人間の CLI が、`gh pr list`／`gh pr view` で、各ノードのブランチ名に対応する PR の `state`・`headRefOid` を取り、daemon への要求に、証拠として付ける。`gh` が使えないとき（未認証・未インストール）は、祖先判定のものだけを対象にして、そう表示する（黙って何もしないのでなく、理由を出す）。
- `--yes --expect <digest>` は、そのまま。

### 6.4 docs・skill

- `docs/reclaim-loss.md` に、「統合済みの証拠」と「verified の破棄」と「実体のない verified」の節を足す。`plugin/skills/integrator/SKILL.md`（64-66 行の統合と回収）に、「スカッシュ後の子の回収は、人間に依頼する」を足す（AI は、証拠を作れない・一括を実行できない）。

## 7. 安全（まとめ）

1. 誤判定で未統合の成果を消さない:
   - 判定を広げた削除は、必ず、先端を `refs/touryou/discarded/` に保管してから `-D` する（§3.8）。保管できなければ、何も消さない。
   - 証拠は、先端（SHA）に紐付く。先端が動いたら無効（実行の直前に照合）。
   - 自動判定は、PR の head の一致（A）だけを使う。B・C は、daemon の自動判定に入れない。
2. 人間のロールだけ: 証拠の記録・一括・`verified` の破棄の指示・`gone` の `verified` の `archived` は、人間のロールだけ（`ROLE_OPERATIONS.human` にだけ足す。integrator・child には足さない。`docs/reclaim-loss.md:26` と同じ。試験で確かめる）。
3. 強制なし（一括）: 一括は `--force` を使わない。`-D` は、証拠つきの子の、保管のあとだけ。`dirty` の子は対象外。
4. digest 照合: 一括は `--yes --expect <digest>`。digest に、証拠の `tip` と `mergedBy` を含める。
5. 推測の扱い: B・C の誤判定の危険、`verified` の破棄が依存元に与える影響は、【推測】。実装の前に確かめる。

## 8. 利用者に決めてもらう点

| # | 論点 | 選択肢 | 難易度 | 有効度 | 推奨 |
|:--|:---|:---|:---|:---|:---|
| 1 | 統合済みの判定を広げる方法 | **A** PR の head の一致（CLI が `gh` で証拠を取る）+ D（人の宣言）に落とす | ★★★☆☆ | ★★★★★ | **推奨** |
| | | B ローカル git で、差分が base に入っているか | ★★★★☆ | ★★★☆☆ | |
| | | C 木・パスの一致 | ★★★☆☆ | ★★☆☆☆ | |
| | | D だけ（人の宣言。一括は祖先判定のものだけ） | ★★☆☆☆ | ★★★☆☆ | |
| 2 | verified の破棄の道 | **P** `reclaimInstruct` を `verified` にも許す（`stopped` と同じ記録） | ★★★☆☆ | ★★★★★ | **推奨** |
| | | Q `verified → stopped` の遷移を足す | ★★★★☆ | ★★★☆☆ | |
| | | R `stop` を `verified` に許す | ★★★☆☆ | ★★★☆☆ | |
| 3 | 実体のない verified | **T** 案 P の道に乗せる（`noTip: true` の破棄） | ★☆☆☆☆（P のあと） | ★★★★☆ | **推奨** |
| | | S `goneUsable` に `verified` を足す（判断の記録なし。人間のロールだけ） | ★★☆☆☆ | ★★★★☆ | |
| | | U state.db の直接書き換え | — | — | 採らない |
| 4 | 一括の対象の範囲 | **証拠つき（A）を含める**。`gone` の `verified` は含めない | ★★★☆☆ | ★★★★★ | **推奨** |
| | | 祖先判定だけ（#234 のまま。スカッシュ運用では空になりやすい） | ★☆☆☆☆ | ★☆☆☆☆ | |
| | | `gone` の `verified` も一括に含める | ★★★☆☆ | ★★★☆☆ | |
| 5 | `gh` を、どこで呼ぶか | **CLI（人間の側）が呼び、daemon には証拠として渡す** | ★★★☆☆ | ★★★★☆ | **推奨** |
| | | daemon が呼ぶ（常駐の環境に、`gh` と認証が要る） | ★★★★☆ | ★★★☆☆ | |
| 6 | 進め方 | **#234 の実装を `main` に取り込んだあと、この設計の差分を足す**（2〜3 つの PR に分ける: ①判定と証拠 ②verified の破棄・gone ③一括の直し） | ★★★☆☆ | ★★★★☆ | **推奨** |
| | | #234 を取り込む前に、設計を先に実装する | ★★★★☆ | ★★★☆☆ | |

## 9. 試験の方針

- core（純粋関数）: `assessReclaim` に、`verified` で `discarded` が記録されている入力（破棄の経路で `merged`・`clean` を免除。`reclaim.ts:242-253`）。`verified` で `discarded` がなければ、これまでどおり `notMerged`（変更なしの確認）。`transition.ts:136` の `markReclaimable`（`verified`）は、そのまま通ること。
- core: `node.mergeEvidenceRecorded`（新しい記録）の検証（先端の形・人間だけ・重複）と、`ROLE_OPERATIONS`（人間にだけある。integrator・child・root にない。`packages/core/test/loss.test.ts:15` と同じ形）。
- daemon（`git-ports`）: スカッシュを再現した実リポジトリ（PR の head を先端とするブランチを、スカッシュで main に入れる）で、(a) 祖先判定は `false`、(b) 証拠が一致すれば `merged: true`・`mergedBy: "evidence"`、(c) 先端が動いたら証拠が無効、(d) 削除前に `refs/touryou/discarded/` に保管される、(e) 保管に失敗したら何も消えない、(f) `-d` でなく `-D` を使い、`discarded` の強制とは別の理由として扱われる。
- daemon（ハンドラ）: `reclaimInstruct` が `verified` を受け、`expectTips` の照合を行う。`gone` の `verified` が、`noTip` の破棄で `archived` になる。`verified` で破棄なし・`gone` は、これまでどおり `factsMissing`。一括: digest の不一致で何も消さない・`dirty` は飛ばす・証拠なしのスカッシュ済みは対象外・`failed` を残して続ける・ロール表（人間以外は `forbidden`）。
- cli: プレビューの `mergedBy` の表示、`gh` が使えないときの表示（黙って空にしない）、`--yes` に `--expect` が要る、`gh` の出力は信頼できない入力として、端末へ出す前に制御文字を除く（`docs/reclaim-loss.md:30-32` と同じ扱い）。
- mcp: 一括・証拠の記録が、子・root の道具の一覧に出ない（`parent-readonly-tools.test.ts` と同じ形。【参照】ref-234 5.）。
- 手動確認: このリポジトリの実際のスカッシュ済みの `verified` の子で、プレビュー → 実行 → 先端が保管から取り戻せること（`docs/manual-verification-checklist.md` に追記）。

## 10. 未確認のこと（実装の前に確かめる）

1. #234 の実装の行番号（`main` 未統合のため、この作業ツリーに無い）。
2. 実体のない `verified` が、現状 `factsMissing` になること（§1.3 の【推測】。実行して確かめていない）。
3. 子のブランチの `@{upstream}` が何になっているか（§1.1 の【推測】）。
4. `isClean` の許可リスト（`seededPaths()`・`regenerable`）の中身と、#239 の `dirty`（`node_modules`・`.envrc`）の関係。この設計の範囲外（#239 の事実 3 は、別の論点）。
5. 保存データの版を上げる手順（新しい記録 `node.mergeEvidenceRecorded` を足すとき）。
6. `verified` の破棄が、依存元（`COMPLETED_STATES`）に与える影響（§4.1）。
7. 常駐（launchd）の daemon から `gh` を使えるか（案 A-2 を採る場合だけ）。
