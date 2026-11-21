# Issue #196 調査・設計メモ

## 原因
- `transition.ts` は reportDone を running からだけ通す。判断要求で waiting になった子は、判断が要らなくなっても done にできない。
- 判断への回答は人だけ（`decision.answer`）。判断を取り下げる操作がなく、waiting から running へ戻る道は人の回答（resume）しかなかった。

## 設計（親の承認済み。既存の decision.* ・イベント・fold に沿う）
- 操作 `decision.withdraw`（子のロールだけ。自分の判断だけ）。MCP の道具は `decision_withdraw`、CLI は `touryou child report decision-withdraw`。
- イベント `decision.withdrawn { decisionId }`。fold は判断を `closed`・`closedReason: "withdrawn"` にする。開いていない判断は `decisionNotOpen`、無い判断は `unknownDecision`。
- 同じ追記で、waiting かつほかに開いた判断がなければ `node.stateChanged{resume}` を入れて running に戻す。受信箱の判断の項目は `inbox.resolved`、親へは info を出す。
- 状態画面（ui-view）は、取り下げた判断を出さない。人が後から答えると `decisionClosed`（取り下げ済みの文）。
- 再送は `alreadyApplied` で成功にする。
- `waiting` で `reportDone` したときの `invalidTransition` の文に、人の回答待ちと、取り下げ（decision_withdraw）の道を出す。

## 試験
- core: transition.test.ts（waiting+reportDone の文）。
- daemon: state-handlers.test.ts（取り下げの流れ・再送・人の回答の拒否・他ノードの判断・回答済み）。
- mcp / cli: 道具の一覧・schemas・操作表の期待値を更新。
