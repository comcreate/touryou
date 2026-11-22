---
id: "adr-touryou-168-integrator-child-operations"
title: "サブ統括が親へ使う子の操作と、フックの道具の許可 決定ログ（#168 サブ統括）"
type: "adr"
status: "accepted"
sdd-phase: "implement"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: []
tags: ["touryou", "168"]
category: ""
---

# サブ統括が親へ使う子の操作と、フックの道具の許可 決定ログ（#168 サブ統括）

> PR3（daemon・mcp: 許可とフック）の実装中に、設計書にない 2 つの穴が見つかった。利用者の判断で、どちらも PR3 の中で埋めた。設計書（`.sdd/task/168/design.md`）の「判定コードは変えない」は、この方針で上書きする。

## 2026-11-22 統合ロールに、子の操作を足す

- **背景**: サブ統括は、自分の親に対しては「子」でもある。完了の報告（`report.done`）・範囲の拡張の要求（`scope.extend`）・自分の受信箱の読み取り（`child.inbox`）などが要る。ところが、サブ統括のトークンのロールは integrator で、`ROLE_OPERATIONS.integrator` に子の操作がなく、窓口（`authorizeRole`）が拒否する。このままでは、サブ統括は親へ完了を報告できず、承認の連鎖（孫 → サブ統括 → 親）の後半も成り立たない（[touryou-168-approval-route.md](./touryou-168-approval-route.md)）。
- **Decision**: 子の操作 7 つ（`report.progress`・`report.decision`・`decision.withdraw`・`report.outOfScope`・`report.done`・`scope.extend`・`child.inbox`）を、`ROLE_OPERATIONS.integrator` にも足す（共通の定数 `CHILD_OPERATIONS`）。
  - 部分木の分類（`INTEGRATOR_OPERATION_CLASS`）に新しい種類 `self` を足し、7 つはすべて `self` にする。`self` は「呼び出したノード自身の分だけを扱う」操作で、対象は呼び出し側の資格情報で決まり、引数に対象のノードを取らない。
  - `authorizeScope` は、`self` の操作を、親を持つ統合ノード（サブ統括）だけに通す。親を持たない根は、`rootHasNoParent` で拒否する。**根の判定は変わらない**（根は、これまでも子の操作を持たなかった）。
  - mcp の道具名は、操作名の `.` を `_` にする。`child.inbox` だけは、子では `inbox_fetch`（統合の `inbox.fetch` と同じ名前だが、ロールごとに片方だけが出る）、統合（サブ統括）では `child_inbox`。`inbox_fetch` は統合ロールでは統合の受信箱なので、衝突を避けた。変換は core の `mcpToolName(op, role)` に 1 か所にまとめ、mcp の `toolName`・core の道具名の一覧が同じ関数を使う。
  - `child.inbox` のハンドラは、ロールが人間でなければ通す（窓口の `authorize` が根を拒否済み）。前置きの知らせだけを読む呼び出しで時計を延ばさない例外（`isPrefaceOnlyInboxRead`）も、同じロールの範囲に広げる。
- **Rationale**: 契約（`ROLE_OPERATIONS`）は、操作と mcp の道具の唯一の情報源（NFR_004）。別の名前の操作（`report.doneAsSub` など）を作るより、同じ操作を同じ意味で統合ロールにも許す方が、ハンドラ・状態遷移・知らせの経路を共有できる。呼ぶ側の宛先は「呼び出したノードの直接の親」で決まる（`parent.request`・`parent.report` と同じ考え方）。`self` の分類は、型の網羅（操作を足すと分類の表に足すまでコンパイルできない）を保ったまま、根を拒否できる。
- **Rejected alternatives**:
  - サブ統括に、子のロールのトークンを別に持たせる — 1 つのノードがロールの違うトークンを 2 つ持つことになり、`checkPrincipal`（トークンのロールとノードのロールの一致）の規則を崩す。
  - 根も子の操作を使えるようにする — 根には親がなく、報告の宛先がない。人間への知らせは、既存の道（受信箱・`decision.present`）がある。
  - 統合ロールの子の操作を、別の名前にする — 状態遷移・ハンドラを複製することになる。
- **影響**:
  - 根（root）の mcp の道具の一覧も、7 つ増える（名前は `report_*`・`scope_extend`・`decision_withdraw`・`child_inbox`）。呼んでも `rootHasNoParent` で拒否される。道具の一覧を、根かサブ統括かで分けるには、道具の一覧が接続のノードを知る必要があり（`tools/list` の時点では、ノードの親の有無が分からない）、PR3 では分けていない。気になるなら、後続で「親を持つ統合ノードだけ」に絞る（`whoami` に親の有無を足す）。
  - サブ統括の起動時の許可の一覧に、7 つが入る（`launchToolNames("integrator")`）。

## 2026-11-22 フックの道具の許可を、ノードのロールで切り替える（「判定コードは変えない」の上書き）

- **背景**: 設計書は、PR3 で「フックの試験を足すだけで、判定のコードは変えない」としていた。しかし、フック（`decideToolUse` の末尾）は、自分の mcp の道具を、子のロールの一覧（`CHILD_MCP_TOOL_NAMES`）だけ許し、ほかのロールの道具は `denyUnknown` で拒否する。サブ統括が `node_spawn`・`node_review` などを呼ぶと、窓口の許可・起動時の許可の一覧を通っても、フックで必ず拒否される。判定のコードを変えない限り、サブ統括は孫を生成できない。
- **Decision**: `decideToolUse` に、呼び出したノードのロールを渡す（省略は `child`）。道具の許可の一覧を、`integrator` なら `launchToolNames("integrator")`（統合の道具＋`child_bind`）、`child` なら `CHILD_MCP_TOOL_NAMES` にする。**変えるのは、自分の mcp の道具の許可の一覧だけ**。範囲（`writableLocations`・`allowedCommands`）、禁じる場所（`forbiddenLocations`・`protectedPaths`）、固定の守り（git のディレクトリ・設定ファイル・`.claude` の書き込み禁止）の判定は、ロールによらず同じ。
  - `decideCliHook` が、ノードのロール（イベント列の `nodes[].role`）を渡す。Desktop の子のフック（`decideDesktopHook`）は、子のロールのまま。
  - フックの受け口（`/v1/hook`）は、フック専用のトークンの主体のロールを、ノードのロールに合わせる（以前は常に child）。`checkPrincipal` はトークンのロールとノードのロールの一致を見るので、合わせないと、サブ統括のフックが、受け口で `tokenRoleMismatch` になる。受け口は、人間以外（子・サブ統括）を通す。
- **Rationale**: 道具の許可の一覧は、ロールごとの「何ができるか」で、範囲の判定ではない。サブ統括の起動時の許可の一覧（`launchToolNames`）と同じ一覧をフックでも使うので、起動時とフックで食い違わない。判定の入口を増やさず、既存の関数に引数を 1 つ足すだけで済み、引数を省略した呼び出し（子・既存の試験）の挙動は変わらない。
- **Rejected alternatives**: サブ統括のフックだけ別の関数にする — 範囲・禁じる場所の判定を複製し、片方だけ直す事故を呼ぶ。サブ統括の道具をフックで一括許可する — 人間専用の道具・ほかの plugin の道具まで許してしまう（フェイルクローズに反する）。
- **試験**: サブ統括は、統合の道具・親への報告の道具・`child_bind` を 2 つの名前の形で許可される。人間専用の道具・知らない道具・ほかの plugin は拒否される。子（ロールの指定なし）は、`node_spawn` などを拒否される。ロールが変わっても、範囲外の書き込みは拒否される。窓口の試験は、サブ統括が子の操作を使え、根は `forbidden` になることを確かめる。
