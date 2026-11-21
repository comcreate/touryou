# 設定ファイル（daemon・touryou-mcp）

daemon（`touryou-daemon --config <設定ファイル>`）と、統合セッションの `touryou-mcp --stdio`（`stateDir` を読む）・`touryou` は、**同じ設定ファイル**を読みます。正本は `packages/daemon/src/config.ts`（`DaemonConfig`）で、この文書はその要約です。食い違いがあれば、コードが正しいものとします。

- JSON。権限は **0600**、所有者は自分にします（緩いと起動しません）。
- 未知のキーは、設定の誤りとして起動を拒否します。ただし、外した設定（`mcpUrl`・`childMcp`・`childHome`・`childPluginDir`・`childEnvAllow`）は、受け取って無視します（下の「外した項目」）。
- パスは絶対パスで書きます（`rootScope` の場所だけは `rootCwd` からの相対パス）。
- **トークンの値は、設定ファイルに書きません**（トークンは daemon が `stateDir` に作ります）。
- 前提: `git`（Xcode の Command Line Tools）が要ります（daemon が、子の作業ツリーを `git worktree` で作るため。Xcode か Command Line Tools のどちらかがあればよい）。入っていなければ、Terminal で `xcode-select --install` を実行します。git がないと、子の作成・回収は失敗し、原因の先頭に「git（Xcode Command Line Tools）が使えません」と出ます。

## 必須の項目

| キー | 内容 |
|:--|:--|
| `stateDir` | 状態（SQLite・トークン・ポートのファイル）の置き場。0700 のディレクトリ |
| `repoRoot` | 子の作業ツリーを作る git リポジトリ |
| `worktreeRoot` | 子の作業ツリーの置き場 |
| `rootCwd` | 根の作業ツリー（`repoRoot` 自身か、その配下） |
| `rootScope` | 根の範囲（子の権限の上限）。`writableLocations`・`forbiddenLocations`・`allowedCommands` |

## 任意の項目と既定値

| キー | 既定 | 内容 |
|:--|:--|:--|
| `rootNodeId` | `root` | 根のノードの ID |
| `port` | `0` | 窓口のポート（127.0.0.1）。0 なら `--port` → 保存した前回のポート → 空いているポート（`docs/plugin.md` の「使う順序」） |
| `childRuntime` | `cli` | 子の実行環境。`cli` は親のセッションが `claude --bg` で起動する子（TouRyou は起動しない。親への依頼の形。[`plugin.md`](plugin.md) の「親から子を起動する流れ」）。`desktop` は実験的（[`desktop-runtime.md`](desktop-runtime.md)） |
| `maxTurns` | `100` | 子ごとのターン数の上限 |
| `maxBudgetUsd` | `5` | 子ごとの費用の上限（USD） |
| `startLimits` | `perParent: 4`・`total: 4` | スケジューラが同時に起動する数の上限（1〜64） |
| `tokenExpiryMinutes` | `sdkIdle: 360`・`sdkAbsolute: 10080`・`bindAbsolute: 1440`・`bindIdle: 60`・`hookAbsolute: 1440` | トークンの期限（分）。`bindIdle` は、紐付けのトークンが使われなければ切れる期限で、切れる前（既定 10 分前）に知らせが出る。`bindAbsolute` は、発行からの期限。切れたときの知らせと状態画面のカードは、この 2 つの変え方を案内する。`docs/plugin.md` の「トークンの期限」 |
| `retentionDays` | `90` | 最終削除の保持期間（日） |
| `purgeTombstone` | `true` | `node.purge` で墓標を残すか |
| `autoPurge` | 無効 | 自動の最終削除（[`auto-purge.md`](auto-purge.md)）。有効にするなら `retentionDays` は 7 以上 |
| `discardedRefsMax` | `200` | 保管する破棄した成果の数の上限（[`discarded-work.md`](discarded-work.md)） |
| `regenerableIgnored` | `node_modules`・`dist`・`.turbo` | 残っていても未保存の変更とみなさない gitignore の対象 |
| `digest` | 有効（`intervalSec: 30` など） | 配下の要約（[`digest.md`](digest.md)） |
| `wake` | 無効 | 中間統合ノードを起こす（[`digest.md`](digest.md)） |
| `rateLimit` | 常に有効（主体ごと容量 60・毎秒 20 など） | 窓口の回数の制限の調整（[`rate-limit.md`](rate-limit.md)） |
| `connection` | `requestTimeoutMs: 30000` など | 接続の上限とタイムアウト |
| `inProgress` | `waitMs: 20000` など | 同じ要求の重複の扱い（[`request-dedup.md`](request-dedup.md)） |
| `gitPath` | `/usr/bin/git` | daemon が使う git |
| `desktopRequireVerifiedHooks` | `true` | Desktop の子で、フックの確認前の起動を拒否する |
| `touryouCommand` | なし | Desktop の子が `touryou` を起動する語（Desktop の子で必要） |
| `hookFreshSeconds` | `30` | Desktop の子のフックの鮮度の窓（秒） |
| `cliWatch` | `{ "stallMinutes": 30, "unreadMinutes": 30, "unboundMinutes": 3, "intervalSec": 60 }` | CLI の子の見張り。`unboundMinutes` 分、親の起動の報告（done）のあとも紐付け（`child_bind`）がない子を、子ごとに 1 回だけ受信箱に出す（TouRyou の plugin が子の設定の置き場にない見込み。`--plugin-dir` だけでは子に付かない）。`stallMinutes` 分、報告・道具の使用・指示のやり取り（送った時刻も受け取った時刻も）の記録がない子を「止まっているかもしれない」として受信箱に出す。`unreadMinutes` 分、子が受け取らない指示も受信箱に出す。`intervalSec` は見回りの間隔 |
| `hookSettingsCheckSeconds` | `2` | Desktop の子の見張りの間隔（秒） |
| `hookFirstSeenMinutes` | `5` | Desktop の子でフックが来ないときに知らせるまでの時間（分） |
| `claudeConfigDirs` | なし | 見張りが守る設定のディレクトリに足す場所（`~/.claude` と `CLAUDE_CONFIG_DIR` に加えて） |

## 外した項目

SDK による子の起動・子の認証・子の HOME の隔離・子用の HTTP の `touryou-mcp`・子の MCP の中継を外したので（決定ログ `.sdd/adr/touryou.md`）、次の項目は、書いてあっても無視します（消してかまいません）: `mcpUrl`・`childMcp`・`childHome`・`childPluginDir`・`childEnvAllow`。

範囲・下限の細かい値は、`packages/daemon/src/config.ts` の各項目のコメントにあります。

根（統合）のセッションは、TouRyou のフックで絞らない（フックが働くのは、子の印のある作業ツリーだけ。`cli/src/hook.ts`）。根の Bash・書き込みは、利用者の Claude Code の許可の設定のとおりに動く。`rootScope` は、子に渡す範囲の上限で、根自身の操作の制限ではない。

子の範囲は、親の範囲（根の子なら `rootScope`）の内側でなければなりません。外にはみ出すと、子の起動（`node_spawn`）や範囲の拡張の承認が `scopeNotSubset` で失敗します。子に `git add`・`git commit` をさせるなら、`rootScope.allowedCommands` に `"git add"`・`"git commit"` を入れておきます。`config.json` は daemon の起動のときだけ読むので、`rootScope` を直したら daemon を起動し直します（常駐なら `/touryou:service` の起動し直し）。

`rootScope.allowedCommands` の一致の規則: 項目を空白で語に分け、命令の先頭の語から順に、すべて一致すれば許可します（語の単位の前方一致。`"cd"` は `cd sub` を通しますが、`cdx sub` は通しません）。出典は `packages/core/src/scope.ts` の `checkCommand` です。

## 例

`<...>` は自分の環境の値に置き換えます。

```json
{
  "stateDir": "<状態の置き場>",
  "repoRoot": "<作業するリポジトリ>",
  "worktreeRoot": "<作業ツリーの置き場>",
  "rootCwd": "<作業するリポジトリ>",
  "rootScope": {
    "writableLocations": ["src", "docs"],
    "forbiddenLocations": [".git"],
    "allowedCommands": ["git status", "pnpm test"]
  },
  "maxTurns": 100,
  "maxBudgetUsd": 5
}
```

```sh
chmod 600 <設定ファイル>
mkdir -p <状態の置き場> && chmod 700 <状態の置き場>
```

## 環境変数

| 変数 | 使う側 | 内容 |
|:--|:--|:--|
| `TOURYOU_DAEMON_URL` | フック・`touryou` | 窓口の URL（`--daemon-url` の代わり） |
| `TOURYOU_DAEMON_CONFIG` | `touryou`・フック・`touryou ui`・`touryou-mcp --stdio`（MCP） | 設定ファイルのパス（`--config` の代わり）。空は無視する。`touryou-mcp --stdio` では、優先順位は「`--config` の引数 → この環境変数 → `$HOME/.touryou/config.json`」。設定が `$HOME/.touryou` の外にあってもよい（設定ファイルの親ディレクトリが、リンクでない・自分の・`drwx------` か `drwxr-xr-x` であること） |
| `TOURYOU_ROOT_TOKEN` | 使わない | 統合セッションの `touryou-mcp --stdio` は、設定（`TOURYOU_DAEMON_CONFIG`、なければ `$HOME/.touryou/config.json`）の `stateDir` の `root-token` だけから読む（環境変数に置くと、Claude Code の環境に残り、Bash などで見えうるため）。`TOURYOU_MCP_URL` も廃止 |
| `TOURYOU_NODE_TOKEN` | フック | 手動の CLI の子のフック専用のトークン（`touryou hook-env`） |

手順の全体と確かめ方は [`manual-verification-checklist.md`](manual-verification-checklist.md) の H にあります。
