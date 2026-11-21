# Issue #186 設計メモ: 紐付け前（外れたとき）の子が親に知らせる手段

## 課題

CLI の子が、紐付けの前、または途中で外れたとき（`/mcp` の再接続・`claude attach`・daemon の再起動・トークンの期限切れなど）に、
親へ「紐付けが外れた」と知らせる手段がない。

- 紐付け前の子の mcp は `child_bind` と `whoami` だけを出す（`packages/mcp/src/stdio.ts` の `openPendingStdioSession`）。
  `report_progress` などの子の道具は、紐付けが済むまで使えない。
- 拒否の文（`hook-policy.ts` の `denyUnknown`、`cli/src/hook.ts` の `noneMessage`）は「画面を見ている人に頼んで待つ」と言う。
  `claude --bg` の子には、画面を見ている人がいないので行き止まりになる。
- すでに、コードを使った紐付けの失敗（コードが無効・使用済み・期限切れ）は、daemon が受信箱に「紐付けをやり直して」（`rebind`）を出す
  （`onBindInvalid` → compose.ts の `noticeRebind`。ノードごとに 1 回。`node.bindCode` の出し直しで解ける）。
- **出ない道**: コードなしのつなぎ直し（#145。コードのファイルがないとき、mcp が `POST /v1/bind` に nodeId・cwd・sessionId だけを送る）の失敗。
  つなぎ直しが通らない理由（session_id が記録と違う・トークンが切れた・失効した）のとき、daemon は 401 を返すだけで、受信箱には何も出さない
  （`cli-rebind-server.test.ts` が「onBindInvalid は出さない」と固定している）。子はコードのファイルもなく、親に知らせる道具もない。

## 方針（データソースに近い層で構造化する）

新しい道具は作らない。**`child_bind` を引数なしで呼ぶ操作そのものを、知らせの手段にする。**

- 子が「紐付けが外れた」と知っている、という自己申告の文は、daemon に送らない。daemon が自分の確かめ（作業ツリーの中のセッションからの、
  nodeId つきの要求が、つなぎ直せなかった）で知らせの文を組み立てる。認証のない呼び手の自由文を、親（LLM）の受信箱に入れない。
- 受信箱の文は、既存の `rebind`（鍵と値。画面が日本語・英語を選ぶ）をそのまま使う。親がすることは同じ（`node_bindCode` で出し直す）。

### 守りを弱めない理由

- トークンも新しい権限も出さない。`POST /v1/bind` の確かめの順序は変えない（回数の制限・本文の検査・作業ツリーの確認・session_id の重なりの確認）。
- 知らせを出すのは、**作業ツリーの確認を通ったあと**だけ（cwd の実パスが、そのノードの作業ツリーと同じ。別の場所・別のノードの申告では出ない）。
- ノードごとに 1 回（`rebindNoticedAt`。`node.bindCode` の出し直しで消える）。失敗は、これまでどおり全体のスロットルと接続元ごとの
  bucket で数える。
- フック・範囲の判定（`hook-policy.ts` の許可・拒否）は変えない。拒否の**文**だけを変える。

## 変更

1. `packages/daemon/src/api/server.ts`: コードなしのつなぎ直しの失敗（`rebindOk` が偽、またはトークンを出し直せない）で、
   作業ツリーの確認を通っているので、`onBindInvalid(nodeId)` を呼ぶ（コードありの失敗と同じ。応答の文・数え方は変えない）。
2. 拒否の文に、使える MCP の名前を出す。
   - `packages/daemon/src/sdk/hook-policy.ts` の `denyUnknown`。
   - `packages/cli/src/hook.ts` の `noneMessage`（紐付けの前に、フックが実際に出す文）。
   - 名前は、plugin から入れた形 `mcp__plugin_touryou_node__child_bind`（`PLUGIN_NAME` から組み立てる。手書きしない）。
     パスなど、禁じる値は出さない。
3. `packages/mcp/src/stdio.ts`: コードのファイルがないときの案内に、daemon が受信箱に出した（出ていなければ人に頼む）ことを書く。
4. 試験・docs（plugin.md・cli.md）・plugin の child skill・CHANGELOG（未公開）。

## 覆えない道（記録する）

- 印（`touryou-child`）がなく、nodeId が分からない子。
- `CLAUDE_CODE_SESSION_ID` が mcp に渡らない子（つなぎ直しに session_id が要るので、daemon に何も届かない）。
- daemon が動いていない・届かない（`daemon_unreachable`）。
- これらは、紐付けの見張り（`cliWatch.unboundMinutes`。起動の報告から一定時間たっても紐付かない子）が、別の道で拾う。

## 検討して採らなかった案

- 紐付け前だけに出す専用の道具（例: `child_unbound_report`）: 認証のない道具が増え、受信箱への書き込みの入口が 1 つ増える。
  フック側でその名前だけを通す許可も要る。守りの面が広がる。
- 子の自由文を受信箱に入れる: プロンプト注入の入り口になる。
