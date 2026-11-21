# #195 調査メモ: 指示後も「止まっているかも」が残る

## 原因
- 見張り（`packages/daemon/src/cli-watch.ts` の `activityMs`）は、指示を `deliveredAt`（子が受け取った時刻）でしか動きに数えなかった。
- 画面（`packages/core/src/ui-view.ts` の `lastActivity`）は、指示の送った時刻（`at`）・受信箱の項目の時刻も数えていた。
- そのため、指示を送った直後で子がまだ受け取っていない間、画面は「動いている」、見張りは「止まっている」となり、知らせが残った。

## 修正（データに近い層＝core に 1 か所）
- `packages/core/src/activity.ts` に `lastActivityMs`・`lastActivityAt`（動きの数え方）、`awaitingHuman`・`intentionallyIdle`（待つと決まっている子）を置いた。
- 数える: 報告・範囲違反・道具の拒否・指示の送った時刻と受け取った時刻・親の依頼の報告・判断の頼みと答え・範囲の頼みと判定。フックの時刻は呼び出し側が足す。
- 数えない: 受信箱の項目。「止まっているかも」の知らせ自体が動きに見えるため（画面は、この点だけ以前と変わる）。
- 見張りの「出す」「片付ける」は、どちらも `intentionallyIdle` と `lastActivityMs` を使う。

## 試験
- `packages/core/test/activity.test.ts`、`packages/daemon/test/cli-watch-activity.test.ts`。

## 範囲外で気づいたこと（未対応）
- この環境の `pnpm test` で、daemon の `scan.test.ts`（graph.js の束が lockfile から作り直したものと不一致）が失敗する。cli-watch とは無関係。
- `reclaim-real-git`・`startup-real-git` は、全体を並列で流すと 5 秒のタイムアウトになることがある。
