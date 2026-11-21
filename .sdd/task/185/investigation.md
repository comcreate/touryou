# #185・#187 調査メモ（daemon 再起動と、子の紐付け・セッション）

注: この子の Bash は git・pnpm build・pnpm test だけ。検索は、親が作った `hits.md`・`files.md` と、Read での通読による。通読した範囲だけを根拠にしている。

## 確かめたこと（コードを読んだ事実）

### daemon 側: 再起動で残るもの

- ノードのトークンは、ハッシュ・ロール・nodeId・発行日時・最後に使った時刻・種類（sdk / bind）を、`node-tokens.json`（0600）に永続する（`packages/daemon/src/api/token-repository.ts`）。起動時に `createCredentialStore` が `repository.load()` で復元する（`packages/daemon/src/api/credentials.ts:188`）。
- 復元のとき、「使わなかった時間」は起動の時刻から数え直す（`credentials.ts:196`）。再起動の間に、使わなければ切れる期限（bind は 1 時間）が進むことはない。発行からの絶対の期限（bind は 24 時間）は、発行の時刻のまま進む。
- 身元の秘密（`daemon-identity`）は、起動のたびに作り直す（`compose.ts` の `start()`）。mcp の身元確認は、これを毎回読み直し、再起動の途中（ファイルがない・接続の拒否・503）は、最大 8 秒待ってかけ直す（`packages/mcp/src/identity.ts`）。再起動そのものでは、401 にならない。

### daemon 側: 401（`unauthenticated`）になる条件

- トークンが未知・期限切れ・失効（`credentials.authenticate` が `undefined`）。
- トークンは有効でも、`checkPrincipal` が落とす: ノードが木にない・ロールの食い違い・ノードの状態が `stopIncomplete`・`stopped`・`reclaimable`・`archived`（`packages/daemon/src/api/authorize.ts:65-84`）。`/v1/whoami`・`/v1/events`・`/v1/request` のすべてが、理由を区別せず 401 にする（`server.ts:973`）。
- 役目の終わり（`verified`・`reclaimable`・`archived`）の状態は、`isRetired` でトークンを失効させる（`compose.ts:415`）。

### daemon 側: 再起動の整合（reconcile）と CLI の子（#187）

- `reconcileOnStartup` は、待ち受けの前に走る（`compose.ts:2219`）。対象は、動作中（running・waiting）か停止の途中（stopping・stopIncomplete）の、親のいるノードのうち、アダプタが管理している子（`has`）と、Desktop の子（`external`）を除いたもの（`reconcile.ts:83-86`）。
- CLI のアダプタの `has` は、起動の依頼の記録があり、親が起動の失敗を報告していない子、または採用した作業ツリーの子で真（`cli-adapter.ts:115-122`）。**記録から導くので、daemon の再起動で消えない**。つまり、普通に起動した CLI の子は、再起動の整合の対象外で、状態もトークンも変わらない。
- CLI の子は、親が `claude --bg` で起動したセッション（daemon の子プロセスではない。`cli-adapter.ts` の冒頭「daemon は子のセッションを起動しない」）。daemon を止めても、プロセスは止まらない。
- 結論（#187）: `/touryou:service` の「動いている子のセッションは止まります」（`plugin/commands/service.md:23・25・32`）は、**CLI の子では実態と違う**。止まらない。Desktop の子も daemon の外で動くので止まらない（`reconcile.ts` は状態を変えず、人に確かめる依頼を 1 件出す）。
  - 例外: 起動の依頼がない・起動の失敗を報告した子（`has` が偽）で、動作中だった子は、再起動の整合で、プロセスがなければ停止済み（`node.exited`）、あれば停止未完了になる。この 2 つの状態は、トークンを失効させる（`REVOKED_STATES`）。

### mcp 側（子）: 資格情報を捨てる 2 か所（#185 の仮説）

- 道具の口: `packages/mcp/src/stdio.ts:475-478`（`watch`）。`child.whoami` / `child.request` の結果が `unauthenticated` なら、入れ物を空にする。
- 購読の口: `stdio.ts:718-720`。購読（`/v1/events`・whoami）が 401 なら `onAuthFailed` で入れ物を空にする（`node-subscriber.ts:196・215-217・303-313`）。
- 空になった子の道具は、`not_bound`（「このセッションは、まだ touryou に紐付いていない」）を返す（`stdio.ts:381-393`）。**「まだ」と出るので、外れたのか最初からなのか区別がつかない**。
- 空になっても、`child_bind` を引数なしで呼べば、コードのファイルがなくても、印・セッション ID・作業ツリーで daemon に出し直しを頼める（#145・#178。`stdio.ts:424-429`）。ただし、人かモデルが呼ぶまで戻らない（自動ではない）。

## まだ確かめられていないこと

- **再起動の直後に、有効なはずの子のトークンが 401 になる経路**を、通読の範囲では見つけていない。上の「401 になる条件」のうち、再起動で起きうるのは、(a) トークンの絶対の期限（24 時間）が、再起動の間にたまたま切れる、(b) 子のノードが `has` の偽の状態で、再起動の整合で停止済み・停止未完了になる、(c) 未確認の別の経路。仮説（再起動の最中や直後の 401）の裏づけは、まだない。
- 確かめた点（追記）: `createSessionBinder`・`createHookTokens` はメモリだが、session_id の結び付けは `session-binding.ts` が `node.sessionBound` をイベントログに記録し、再起動後も引ける。メモリの分は失われても結び直しになるだけで、紐付けが戻らない原因にはならない見込み。
- `packages/mcp/src/server.ts`（`createToolServer`）は、入れ物（`credentials`）が空になると紐付け待ちへ戻し、`child_bind` を出し直す。空のあと、子の道具は `not_bound`（「まだ touryou に紐付いていない」。`server.ts:279-288`）を返す。外れたことは文に出ない。
- 確かめたい点（検索ができれば、すぐ分かる）: `compose.ts` での `createCredentialStore` の引数（`isRetired`・`isIdlePaused`・`repository` を渡しているか）、`server.ts` の `handleEvents`（`/v1/events`）の認証の部分。

## 方針（案）

401 の出どころが 1 つに決まらなくても成り立つ、mcp 側の直し:

1. 401（`unauthenticated`）を受けたら、資格情報を捨てる前に、#178 の経路（`rebindChild`。印・セッション ID・作業ツリーで、コードなしの結び直し）を 1 回だけ試す。通れば、新しいトークンに差し替えて続ける（購読も張り直す）。通らなければ、これまでどおり空にする。
2. 空にしたあとの `not_bound` の文を、最初から紐付いていない場合（「まだ」）と、紐付いていたのが外れた場合（「紐付けが外れた」）で分ける。外れたときは、「MCP の接続ではなく、紐付けが外れた」と明示し、`child_bind` を引数なしで呼ぶよう案内する。
3. #187: service.md・docs・子が読む文・状態画面の文を、実態（CLI・Desktop の子は止まらない。例外は上の `has` が偽の子）に合わせる。
