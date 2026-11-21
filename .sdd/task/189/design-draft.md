# #189 設計メモ: bind トークンの idle 失効を、状態画面に出し、失効の前に知らせる（v0.1.6）

## 課題

紐付け（bind）のトークンは、使わなければ 1 時間（`tokenExpiryMinutes.bindIdle`）で切れる。いまは次の 3 点が足りない。

1. 切れても、状態画面の子のカードに出ない（受信箱に info が 1 件出るだけで、カードでは「知らせ N 件（たたんでいます）」の中）。
2. 切れる前の知らせがない（子が止まって見えるだけで、親も人も、切れる前に動けない）。
3. 切れたときの知らせと docs に、期限を `tokenExpiryMinutes.bindIdle` で変えられることが書いていない。

関連: #145（つなぎ直し `rebindNodeToken`。期限は延ばさない）、#170（外れた子が自分で原因を探さない）、#185・#186（紐付けの案内の文）。

## 調べて分かったこと（コードの実態）

- 失効は `credentials.ts` の `expiredReason`（bind は発行から `bindAbsoluteMs`、最後に使ってから `bindIdleMs`）。`sweepExpired`（定期の見回り。compose の `tokenSweep`）と、認証の呼び出しで失効する。失効すると `onExpired` が呼ばれ、compose の `notifyTokenExpired` が、受信箱に info を 1 件出す（鍵 `tokenExpiredIdleBind` など。要求 ID は `token-expired/<ノード>/<発行の時刻>` で、同じトークンには 1 回だけ）。出すのは running・waiting・done の子だけ。
- 判断待ち・done の子は、使わなければ切れる時計が止まる（`isIdlePaused`）。役目の終わった子（`isRetired`）は、知らせない。
- 紐付けの成功は、`node.sessionBound` として記録に残る（`node.sessionId`）が、ノードには最新の `sessionId` しか残らず、「いまトークンが有効か」は記録から分からない。トークンの有無はメモリ（`credentials`）だけが知る。
- 子への知らせの道は、記録の `node.instructed`（system が書ける。`wake.ts` が同じ形）と、ノードの購読（SSE）。子の mcp が 1 行の知らせをセッションに書き、子は `inbox_fetch` で読む。新しい道は作らない。
- 認証を通る呼び出しは、どれも `touch` される（`authenticate`）。子が touryou の道具を 1 つ呼べば、idle の時計は延びる。

## 決めたこと

### (1) 状態画面のカード

- `UiNode` に、任意の `bindExpired?: "idle" | "absolute"` を足す（真のときだけ付ける。既存の `...(cond ? {...} : {})` の形）。
- `uiViewOf` は、その子の**未解決**の受信箱の項目のうち、`msg.key` が `tokenExpiredIdleBind`・`tokenExpiredAbsoluteBind` のものから導く（summary の文は見ない。`isStopRequest` の `EXTERNAL_CHECK_KEYS` と同じ形）。両方あれば、新しい（seq が大きい）ほう。
- **消し方**: 項目を解決にして消す。紐付けが成功したとき（`onBindSucceeded`。コードによる紐付けと、#145 のつなぎ直しの両方）、daemon が、その子の未解決の `tokenExpired*Bind` の項目を、system の `inbox.resolved` で解決にする（冪等。対象がなければ何も足さない）。画面が「切れた」を出し続けないようにするため。
- `needsHuman`・`band`・図の札は**変えない**。次の操作をするのは人ではなく親（`node_bindCode`）で、並び順・既存の試験にも響かせないため。カードの頭の札と文で伝える。
- 文（`app-text.ts` に、鍵を literal で足す。動的に組み立てない）:
  - 札: `card.bindExpired.idle`（「紐付けが切れた（idle: 使わない時間が長かった）」）・`card.bindExpired.absolute`（「紐付けが切れた（発行から時間がたった）」）
  - 次の操作: `card.bindExpiredNext.cli`（親が `node_bindCode` でコードを出し直し、子が `child_bind` を引数なしで呼ぶ）・`card.bindExpiredNext.desktop`（親が `node_bindCode` で文面を出し直し、子が新しい文面で 1 からやり直す）・`card.bindExpiredNext.unknown`（`runtime` が分からない子。どちらでも通じる文）
  - `n.runtime` で、この 3 つから選ぶ（描画は `el()` と `textContent` だけ。`setAttribute` は使わない。新しい `.prop` の代入は足さない）。
- 日本語・英語の両方。

### (2) 失効の少し前の知らせ

- 対象は bind のトークンだけ（sdk は、親が起動し直せるので、対象外）。
- `createCredentialStore` に `idleWarnMs`（前置きの時間）と `onIdleSoon(nodeId, kind, issuedAt, remainingMs)` を足す。判定は `sweepExpired` の中。`expiredReason` と同じ順（根は除く → 役目の終わり → 判断待ち・done は時計を進めて数える）に通すので、判断待ち・done の子には出ない。
  - 条件: `bindIdleMs - (now - lastUsedMs) <= idleWarnMs`、かつまだ失効していない、かつ（発行からの絶対の期限が、先に来るときは出さない。出しても親にできることがないため。絶対の期限は別の知らせ `tokenExpiredAbsoluteBind` のまま）。
  - 一度出した印は、meta にメモリだけで持つ（使われて `lastUsedMs` が進んだら外す。同じ子が使ってからまた止まれば、もう一度出せる）。
- 前置き `idleWarnMs` は、`min(10 分, bindIdle の半分)`。既定 60 分なら 10 分前。手動確認の `bindIdle: 2` でも、1 分前に出る。見回りの間隔より短いと飛ばすことがあるので、見回りの間隔（`TOKEN_SWEEP_MS`）も確かめる。
- **親へ**: 受信箱に info（鍵 `tokenIdleSoonBind`）。要求 ID は `token-idle-soon/<ノード>/<発行の時刻>/<最後に使った時刻>`（同じ止まりには 1 回）。running の子だけ。
- **子へ**: system の `node.instructed`（固定の短い文。子の文字列・件数は含めない）。要求 ID は `token-idle-soon-<ノード>-<最後に使った時刻>`。文は「紐付けの期限が近い。touryou の道具を 1 つ（`inbox_fetch` など）呼べば、期限が延びる」。受け取った子が道具を呼べば、認証の `touch` で時計が延びる。
- 記録の失敗は、失効そのものを止めない（`note` に残すだけ）。

### (3) 文と docs

- `tokenExpiredIdleBind`・`tokenExpiredAbsoluteBind` の知らせに、「期限は `tokenExpiryMinutes.bindIdle`（使わなければ切れる期限）・`bindAbsolute`（発行からの期限）で変えられる」を、日本語・英語の両方に足す。
- 知らせの中の `node.bindCode` は、`rebind` の知らせと同じ `node_bindCode` に揃える。
- docs: `docs/config.md`（`tokenExpiryMinutes` の行）・`docs/plugin.md`（トークンの期限の表）・`docs/ui.md`（カードの節）・CHANGELOG（未公開）。

## 試験

- core: `uiViewOf` が、未解決の `tokenExpiredIdleBind`・`tokenExpiredAbsoluteBind` から `bindExpired` を導く・解決済みなら付けない・どちらも無ければ付けない・ほかの子に付かない。
- core: `inbox-messages` の約束（鍵の差し込みの名前が日本語・英語で一致）。
- daemon（credentials）: 前置きの前は出ない・前置きに入ると 1 回だけ出る・使うと印が外れ、また止まれば出る・判断待ち・done・役目の終わりの子には出ない・sdk には出ない・失効のあとは出ない。
- daemon（compose）: 前置きに入ると、親の受信箱の info と、子への `node.instructed` が 1 回ずつ記録される。紐付けの成功で、未解決の `tokenExpiredIdleBind` が解決になる。
- 画面: カードに、日本語・英語の札と次の操作が出る（CLI・Desktop・runtime 不明）。`ui-assets.test.ts` の走査（`setAttribute` なし・`.prop` の許可リスト）を通る。

## やらないこと

- トークンの期限そのものを変えない（既定の 60 分・24 時間のまま）。つなぎ直し（#145）の守りも変えない。
- 自動で紐付けを出し直さない（親の操作のまま）。
- `needsHuman`・`band`・図の札は変えない。
