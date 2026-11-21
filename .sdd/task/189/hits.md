# キーワード検索の結果: bindIdle|tokenExpiredIdleBind|idleBind|ui-view
docs/config.md:31:| `tokenExpiryMinutes` | `sdkIdle: 360`・`sdkAbsolute: 10080`・`bindAbsolute: 1440`・`bindIdle: 60`・`hookAbsolute: 1440` | トークンの期限（分）。`docs/plugin.md` の「トー
docs/manual-verification-checklist.md:199:5. 期限切れのあとの結び直し: 設定 `tokenExpiryMinutes.bindIdle` を短く（例: 2）して起動し直し、子に 3 分待ってから報告させる → `tokenExpired`（終了コード 3）と、受信箱の知らせ → 親が `nod
docs/plugin.md:177:| Desktop の子（bind） | 発行から 24 時間、または使わなければ 1 時間 | `bindAbsolute`・`bindIdle` | 窓口の呼び出し |
docs/ui.md:85:- **隠れた対象は、承認・切り出しをさせない**（ボタンを無効にし、理由を出す）。却下だけ押せる（注意書きに、「子に、相対パス・単純なコマンドで要求し直すよう依頼する」案内が出る）。切り出しの確認には、「この対象は許可しない。子には、作業を切り出して進めるよう通知される」と出す。「隠れていなければ、`targ
packages/core/src/contract.ts:98: * トークン・秘密・パス（作業ツリーの絶対パス・最終コミットなど）は含めない（`ui-view` と同じ方針）。
packages/core/src/inbox-messages.ts:118:  tokenExpiredIdleBind: {
packages/core/src/index.ts:40:export * from "./ui-view.js";
packages/daemon/src/api/credentials.ts:36:  readonly bindIdleMs: number;
packages/daemon/src/api/credentials.ts:42:  bindIdleMs: 3_600_000,
packages/daemon/src/api/credentials.ts:225:      if (now - m.lastUsedMs >= expiry.bindIdleMs) return "idle";
packages/daemon/src/compose.ts:672:          : "tokenExpiredIdleBind"
packages/daemon/src/compose.ts:720:        bindIdleMs: minutes(te?.bindIdle, 60),
packages/daemon/src/config.ts:202:   * 紐付け（Desktop の子）の、発行からの期限（既定 1440）。`bindIdle`: 紐付けの、使わなければ切れる期限（既定 60）。
packages/daemon/src/config.ts:209:    readonly bindIdle?: number;
packages/daemon/src/config.ts:711:    const names = ["sdkIdle", "sdkAbsolute", "bindAbsolute", "bindIdle", "hookAbsolute"];
packages/daemon/src/config.ts:722:        "tokenExpiryMinutes は、sdkIdle・sdkAbsolute・bindAbsolute・bindIdle・hookAbsolute（どれも 1〜525600 の整数〔分〕。任意）だけを持つオブジェクト",
packages/daemon/src/ui/graph-model.ts:6:import { UI_HUMAN, uiText } from "../../../core/src/ui-view.js";
packages/daemon/test/api/cli-rebind-server.test.ts:171:    // bindIdleMs（既定 1 時間）を過ぎて、トークンが切れる
packages/daemon/test/api/node-events.test.ts:281:      expiry: { sdkIdleMs: 1e9, sdkAbsoluteMs: 1e9, bindAbsoluteMs: 1e9, bindIdleMs: 1 },
packages/daemon/test/api/revoked-store.test.ts:96:      expiry: { sdkIdleMs: 100, sdkAbsoluteMs: 1000, bindAbsoluteMs: 1000, bindIdleMs: 100 },
packages/daemon/test/api/token-expiry.test.ts:274:      { bindIdle: 1.5 },
packages/daemon/test/api/token-expiry.test.ts:295:      ["bind", E.bindIdleMs],
