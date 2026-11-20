# #163 既存の作業ツリーの採用: 設計メモ

## 方針

- 新しい操作 `node.adopt`（統合ノードだけ。subtree の規則 `selfOrDescendant`）。
- 記録は `node.created`（範囲）・`node.stateChanged`・`node.adopted`（作業ツリー・ブランチ・セッション参照）を、`appendAtomically` で 1 回に追記する。採用の事実は `NodeRecord.adopted` に持つので、`STATE_VERSION`（14）は上げない。
- 範囲の検査は、`node.spawn` と共通の `childScopeProblem`（`child-scope-check.ts`）。
- git の確認・子の印の書き込みは `GitPorts`（`inspectAdoption`・`markAdopted`・`unmarkAdopted`）。作業ツリーとブランチの解決は、`useAdopted` の遅延束縛で、`log.state()` の `adopted` から引く（ポートがログより先に作られるため）。
- 紐付けは、既存の `issueCodeFile` を使う。セッションは `/mcp` の Reconnect のあと `child_bind` を引数なしで呼ぶ。

## 決めたこと（親の答えが来なかった判断 `decision-0138a3e294c748ebfbb71d7a81309516` の既定）

- 未コミットの変更がある作業ツリーは採用する。結果の `dirty` を真にして知らせる。
- 回収は、採用した作業ツリーとブランチを消さない（印とコードを外すだけ）。

## 互換性

- `node.adopted` を含むログは、古い daemon では読み直せない。CHANGELOG・docs に書いた。

## 未対応

- 人間の CLI（`touryou adopt`）は足していない。
