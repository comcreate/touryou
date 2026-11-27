# 設定ファイル（daemon・touryou-mcp）

daemon（`touryou-daemon --config <設定ファイル>`）と、統合セッションの `touryou-mcp --stdio`（`stateDir` を読む）・`touryou` は、**同じ設定ファイル**を読みます。正本は `packages/daemon/src/config.ts`（`DaemonConfig`）で、この文書はその要約です。食い違いがあれば、コードが正しいものとします。

- JSON。権限は **0600**、所有者は自分にします（緩いと起動しません）。
- 未知のキーは、設定の誤りとして起動を拒否します。ただし、外した設定（`mcpUrl`・`childMcp`・`childHome`・`childPluginDir`・`childEnvAllow`）は、受け取って無視します（下の「外した項目」）。
- パスは絶対パスで書きます（`rootScope` の場所だけは `rootCwd` からの相対パス）。
- **トークンの値は、設定ファイルに書きません**（トークンは daemon が `stateDir` に作ります）。
- 前提: `git`（Xcode の Command Line Tools）が要ります（daemon が、子の作業ツリーを `git worktree` で作るため。Xcode か Command Line Tools のどちらかがあればよい）。入っていなければ、Terminal で `xcode-select --install` を実行します。git がないと、子の作成・回収は失敗し、原因の先頭に「git（Xcode Command Line Tools）が使えません」と出ます。

## 設定ファイルの探し方（全入口で共通）

`touryou`・フック（`touryou hook`）・`touryou ui`・`touryou-mcp --stdio`（`child_bind` を含む）は、次の順で設定ファイルを決めます（共有関数 `locateConfig`。正本は `packages/core/src/config-locate.ts`）。

1. `--config <設定ファイル>`（`touryou ui`・`touryou-mcp --stdio` が取る引数）
2. 環境変数 `TOURYOU_DAEMON_CONFIG`（空は無視する）
3. 実行した場所（cwd）から上へ、各階層の `<dir>/.touryou/config.json` を探し、いちばん近いものを使う。**git のリポジトリの根（`<dir>/.git/HEAD` がある階層）で止まる**（その階層の設定は調べる）

**設定は、いま居るリポジトリの中だけで探します。見つからないときは `/touryou:setup`、リポジトリの外に置いた設定は `--config` で指します。**

- 子の作業ツリー（`<repoRoot>/.touryou/worktrees/<子>`）の中からでも、どの深さからでも、親のリポジトリの `<repoRoot>/.touryou/config.json` に届きます。git worktree で作った作業ツリー（子の作業ツリーもこれ）は、`.git` がファイルで `.git/HEAD` がないので、根とみなしません。そのため、`repoRoot` の外に置いた `worktreeRoot` の子の作業ツリーからも、祖先の設定に届きます。
- 根で止めるのは、リポジトリの外の祖先（たとえば `~/src/github.com/<org>/.touryou/config.json`）にある、**別のリポジトリの設定を拾わない**ためです。止めないと、その祖先の下の、まだ設定のない別のリポジトリでも `CONFIG: present` になり、`/touryou:setup` が設定の作成・移行（`touryou migrate`）を案内せず、別の `repoRoot` の daemon につながってしまいます。
- 例外: `$HOME` は特別に扱いません。リポジトリでない場所から実行したときだけ、`$HOME/.touryou/config.json` に届きます。
- 設定が根の外にあるときは、`--config`・`TOURYOU_DAEMON_CONFIG` で指します。

開発者向け: 導入の script（`plugin/scripts/install-runtime.sh` の `config_in_ancestors`）も、同じ範囲で探します（ただし script は、`$HOME/.touryou/config.json` を前の置き場として当てません）。

**見つからないときは、旧パス（`$HOME/.touryou/config.json`）へ黙って戻りません。** 探した場所（cwd）と直し方（`/touryou:setup` を実行する、または `--config`・`TOURYOU_DAEMON_CONFIG` で指す）を出して止まります。

入口ごとの違い:

- `touryou-mcp --stdio`・`touryou`: 見つからなければ、`invalid_config`（mcp）・使い方の誤り（終了コード 2。トークンは送らない）で止まります。
- フック: 設定が見つからない・読めないときは、印のある子の作業ツリーでは拒否し（fail-closed）、印のないフォルダ（touryou を使っていない場所）では、何もせずに通します。フックは、入力の `cwd` から上へ探します。
- `touryou ui`: `--config`・環境変数がなく、cwd から上にも見つからないときだけ、候補（`touryou ui --list`）のうち、cwd が `repoRoot`・`worktreeRoot` の中にあるものを、いちばん深いもの（内側の `worktreeRoot` を含む）から選びます。それでも合うものがなければ、止まります。
- `touryou supervisor`（常駐の操作。`status`・`restart`・`register`・`unregister` など）: 対象は、`--config <設定ファイル>`、`--all`（登録簿の全部）、どちらもなければ、上の 3 と同じに、実行した場所から上へ探した設定です。常駐（launchd）の項目は supervisor の 1 つで、daemon は、登録簿（`$HOME/.touryou/registry.json`）の設定ごとに supervisor が起こします（`docs/launchd.md`）。daemon の設定は、リポジトリごとの `<repoRoot>/.touryou/config.json` に置きます。
- `touryou launchd`（前の形。設定ごとの daemon の plist）: 移行（`touryou migrate`。下）の前の置き場の常駐のために残しています。`--config` を省略したときの既定は、従来のまま `$HOME/.touryou/config.json` です。新しい置き場では使いません（`touryou supervisor` を使う）。

## 前の置き場からの移行（`touryou migrate`。#301）

前の置き場（`$HOME/.touryou/config.json`・`$HOME/.touryou/state`・常駐 `touryou.daemon`）は、リポジトリ単位の置き場（`<repoRoot>/.touryou/config.json`・`.touryou/state`）に移します。`/touryou:setup` が、`LEGACY_CONFIG: present` のときに案内します（手で行うなら `"$HOME/.touryou/current/bin/touryou" migrate --yes`）。

- 順は「コピー → 検査 → 切り替え」。**元の設定・`state` は消しません**（動作を確かめてから、自分で消します）。前の設定が指す `repoRoot` の 1 つだけを移します（複数のリポジトリは、それぞれのリポジトリで `/setup`）。別名の daemon（`launchd init --config`）は移しません。
- 新しい設定は、前の設定の値のままで、`stateDir` だけを `<repoRoot>/.touryou/state` に置き換えます（`worktreeRoot` は前の値のまま。動いている子の作業ツリーと、記録の中のパスを置き去りにしないため。推奨の `<repoRoot>/.touryou/worktrees` は、新しく設定を書くときだけです）。
- 検査は、daemon と同じ `--check-config`（`stateDir`・`worktreeRoot` が `repoRoot` の内側なら、ignore 済み・未追跡か）です。**先に `<repoRoot>/.gitignore` に `.touryou/` を足し、コミットしておきます**（TouRyou は `.gitignore` を書き換えません。コミットしないと、`<repoRoot>` の作業ツリーにコミットしていない変更が残り、最初の `node_integrate` が `targetDirty` になります。ファイルを変えたくないときは、`<repoRoot>/.git/info/exclude` に足しても、検査は通ります。通らなければ、移行は何も残さずに止まります）。
- 新しい置き場に、`config.json`・`state` がすでにあれば、上書きも併合もせずに断ります。前の daemon が動いたままなら（手で起こしたもの）、コピーせずに断ります（SQLite を一貫してコピーできないため）。
- 失敗したとき: 作ったもの（新しい `state`・設定・登録簿の 1 行）だけを消し、止めた前の常駐を起動し直します。前の置き場は変わりません。前の常駐を外す段だけが失敗したときは、新しい daemon が動いているので、戻さずに、手で外す手順（`touryou launchd uninstall --yes`）を出して終了コード 1 で終わります。

## 必須の項目

| キー | 内容 |
|:--|:--|
| `stateDir` | 状態（SQLite・トークン・ポートのファイル）の置き場。0700 のディレクトリ |
| `repoRoot` | 子の作業ツリーを作る git リポジトリ |
| `worktreeRoot` | 子の作業ツリーの置き場 |
| `rootCwd` | 根の作業ツリー（`repoRoot` 自身か、その配下） |
| `rootScope` | 根の範囲（子の権限の上限）。`writableLocations`・`forbiddenLocations`・`allowedCommands` |

### 置き場の重なりの検査

`stateDir`・`repoRoot`・`worktreeRoot` は、互いに重なってはいけません。ただし次の 2 つは許します。

- **`stateDir` が `repoRoot` の内側にあり、gitignore 済みで、git に追跡されていないとき。** （`rootCwd` との位置は問いません。）
- **`worktreeRoot` が `repoRoot` の内側にあり、gitignore 済みで、git に追跡されていないとき。** たとえば `<repoRoot>/.touryou/worktrees` です。内側に置くと、子の起動（`claude --bg`）で作業フォルダの信頼の確認が要らなくなる見込みです（未測定）。

どちらも、daemon の起動のとき（`touryou-daemon --check-config` も同じ）に `git check-ignore`・`git ls-files` で確かめ、ignore されていない・追跡されているなら起動しません。`.gitignore` に置き場を足してください（たとえば `<repoRoot>/.touryou` の下に置くなら `.touryou/`）。touryou は、`.gitignore` を自分では書き換えません（自己 ignore は置きません）。追跡されているときは、`git rm --cached` で外すか、置き場を `repoRoot` の外に置きます。git が使えない・確かめに失敗したときも、起動しません。

次の重なりは、今までどおり拒否します: 同じ場所、`repoRoot` を囲む向き（`stateDir` も `worktreeRoot` も）、`stateDir` と `worktreeRoot` の重なり（どちらが内側でも、同じ場所でも）。

理由: `stateDir` にはトークン（`root-token`）と SQLite が入り、`worktreeRoot` の下の子の作業ツリーは入れ子の git になります。ignore されていないと、`git add -A` で、トークンや壊れた埋め込みリポジトリを誤って載せてしまうためです。ignore 済みなら、入れ子の作業ツリーの作成・commit・`worktree remove` は、外に置いたときと同じに動きます（テストで確かめています）。置き場が `.gitignore` から外れる・追跡される変更は、起動のときにしか確かめません。

内側の `.touryou/` は、子から守られます。子は、`<repoRoot>/.touryou/` の、自分の作業ツリー以外（state・`config.json`・logs・ほかの子の作業ツリー）を、読み取りも書き込みもできません（リンクを解決した実パスで比べます）。

子の範囲の例には、`forbiddenLocations` に `.touryou` を入れます（`.touryou` は、daemon がもともと守っているので〔`compose.ts` の `protectedRoots`・フックの `touryouDir`〕、設定の読み込みでは足しません。子の範囲は親の `forbiddenLocations` をすべて含める決まりなので、親〔`rootScope`〕に書いたら、子の範囲にも同じものを入れます）。

調べる場所（出典: `packages/daemon/src/config.ts` の `parseConfig`、`packages/daemon/src/compose.ts` の `realOverlap`・`protectedRoots`、`packages/daemon/src/state-dir-ignore.ts` の `checkStateDirIgnored`・`checkWorktreeRootIgnored`）:

- 設定を読むとき: 書かれたパス（`..` をそろえたもの）で比べる。`stateDir`・`worktreeRoot` が、それぞれ `repoRoot` の真に内側にある重なりだけを通す。同じ場所・`repoRoot` を囲む向き・`stateDir` と `worktreeRoot` の重なりは拒否する。失敗の文は「stateDir・repoRoot・worktreeRoot は、互いに重なってはならない」（`invalidConfig`）。
- daemon の起動のとき（`createDaemon`）: リンクを解決した実パス（まだないパスは、あるいちばん深い祖先を解決して残りを足す）で、大文字小文字・Unicode の正規化をそろえて同じ比べ方をする。失敗の文は「stateDir・repoRoot・worktreeRoot が、リンクを解決すると重なる」。リンクで `repoRoot` の外へ出る置き場は外側と、中へ入るものは内側と判定される。
- 起動の前と `--check-config`（`main.ts`）: 実パスの `stateDir`・`worktreeRoot` が `repoRoot` の内側なら、それぞれ `git ls-files`（追跡済みなら拒否）と `git check-ignore -q --no-index`（ignore 済みでなければ拒否）を呼ぶ。`.gitignore` を自前で読まず、git の判定（否定・ネスト・`.git/info/exclude`・グローバルの ignore）に従う。

`rootCwd` は別で、`repoRoot` 自身かその配下でなければなりません。

## 任意の項目と既定値

| キー | 既定 | 内容 |
|:--|:--|:--|
| `rootNodeId` | `root` | 根のノードの ID |
| `permissions` | なし（空） | 権限の規則（`allow`・`deny`・`ask`）。Claude Code の `permissions` と同じ書き方の部分集合。下の「権限の規則（`permissions`・`autoApprove`）」 |
| `autoApprove` | なし（空） | 自動承認してよい規則（`allow` だけ）。読み取りだけのものに限る。下の「権限の規則（`permissions`・`autoApprove`）」 |
| `port` | `0` | 窓口のポート（127.0.0.1）。0 なら `--port` → 保存した前回のポート → 空いているポート（`docs/plugin.md` の「使う順序」） |
| `childRuntime` | `cli` | 子の実行環境の**既定値**（`node_spawn` の `runtime` を省略したときの値）。`cli` は親のセッションが `claude --bg` で起動する子（TouRyou は起動しない。親への依頼の形。[`plugin.md`](plugin.md) の「親から子を起動する流れ」）。`desktop` は実験的（[`desktop-runtime.md`](desktop-runtime.md)）。`desktop` にすると、`allowDesktopChildren` を暗に許可したものとみなす（互換）。記録のない古い子は、この値で扱う |
| `allowDesktopChildren` | `false` | Desktop の子を足してよいか（opt-in。#159）。`true` のときだけ、`node_spawn` の `runtime: "desktop"` を受け、CLI の子と Desktop の子を 1 つの木に混ぜられる。許可がないのに `runtime: "desktop"` を指定すると `desktopChildNotAllowed` で失敗する。**`true` にすると、取り消せない操作（`touryou purge`・`discarded-drop`・回収の指示）は、端末つきで動いている daemon でしか通らない**（CLI の子だけの操作も同じ。launchd 経由では `confirmationUnavailable`）。既定の `false` の木は、これまでどおり。画面の設定の窓に、有効なときの注記が出る |
| `maxTreeDepth` | `3` | 木の深さの上限（2〜10 の整数。根を深さ 0 と数える）。`node_spawn`・`node_adopt` は、新しいノードの深さがこの値以上になるとき、理由と直し方を添えて `depthExceeded` で断る。既定の 3 は、根（0）・サブ統括（1）・その下の孫（2）まで。書き方は `"maxTreeDepth": 4` のように整数 1 つ。範囲の外・整数でない値は、起動時に理由つきで拒否される。変えたら daemon を起動し直す（起動し直すまで、変更は効かない）。深くするほど、同時の起動・要約・停止の連動の検証範囲が増える |
| `maxTurns` | `100` | 子ごとのターン数の上限 |
| `maxBudgetUsd` | `5` | 子ごとの費用の上限（USD） |
| `startLimits` | `perParent: 4`・`total: 4` | スケジューラが同時に起動する数の上限（1〜64） |
| `tokenExpiryMinutes` | `sdkIdle: 360`・`sdkAbsolute: 10080`・`bindAbsolute: 1440`・`bindIdle: 60`・`hookAbsolute: 1440` | トークンの期限（分）。`bindIdle` は、紐付けのトークンが使われなければ切れる期限で、切れる前（既定 10 分前）に知らせが出る（「使われる」には、知らせの購読の接続と heartbeat も数えるので、購読して待つ子には、この知らせは出ない。`docs/plugin.md` の「トークンの期限」）。`bindAbsolute` は、発行からの期限。切れたときの知らせと状態画面のカードは、この 2 つの変え方を案内する。`docs/plugin.md` の「トークンの期限」 |
| `retentionDays` | `90` | 最終削除の保持期間（日） |
| `purgeTombstone` | `true` | `node.purge` で墓標を残すか |
| `autoPurge` | 無効 | 自動の最終削除（[`auto-purge.md`](auto-purge.md)）。有効にするなら `retentionDays` は 7 以上 |
| `discardedRefsMax` | `200` | 保管する破棄した成果の数の上限（[`discarded-work.md`](discarded-work.md)） |
| `regenerableIgnored` | `node_modules`・`dist`・`.turbo` | 残っていてもコミットしていない変更とみなさない gitignore の対象 |
| `digest` | 有効（`intervalSec: 30` など） | 配下の要約（[`digest.md`](digest.md)） |
| `wake` | 無効 | 中間統合ノードを起こす（[`digest.md`](digest.md)） |
| `rateLimit` | 常に有効（主体ごと容量 60・毎秒 20 など） | 窓口の回数の制限の調整（[`rate-limit.md`](rate-limit.md)） |
| `connection` | `requestTimeoutMs: 30000` など | 接続の上限とタイムアウト |
| `inProgress` | `waitMs: 20000` など | 同じ要求の重複の扱い（[`request-dedup.md`](request-dedup.md)） |
| `gitPath` | `/usr/bin/git` | daemon が使う git |
| `desktopRequireVerifiedHooks` | `true` | Desktop の子で、フックの確認前の起動を拒否する |
| `touryouCommand` | なし | Desktop の子が `touryou` を起動する語（Desktop の子で必要） |
| `hookFreshSeconds` | `30` | Desktop の子のフックの鮮度の窓（秒） |
| `cliWatch` | `{ "stallMinutes": 30, "unreadMinutes": 30, "unboundMinutes": 3, "unsubscribedMinutes": 15, "echoMinutes": 5, "intervalSec": 60 }` | CLI の子（`runtime` が cli の子。親が起動を報告した子と、採用〔`node_adopt`〕した子。Desktop の子は対象外。#159）の見張り。採用した子の「紐付けていない」は、起動の報告でなく採用の記録の時刻から数える。`unsubscribedMinutes`（1〜1440）分、有効な紐付けのトークンがあるのに、通知を受け取る接続（購読）がない状態が続いた running・waiting の子を「紐付けが外れているかも」として、親の受信箱に出す（`claude attach`・`/mcp` の再接続・mcp の再起動で、子の mcp が認証を失うと、401 は出ず、daemon 側のトークンは有効なまま、購読だけが止まる。使われない子は `child_bind` も呼ばないので、daemon が見つける）。途切れ 1 回につき 1 回だけ。購読が戻る・結び直す（`child_bind` の成功）・トークンが切れる（切れた知らせが別にある）・子が止まると解決にする。daemon の起動の直後は、起動後の最初の見回りから数え始める。ノードごとの 1 日の上限に数える。読み取りだけで、権限や紐付けの条件は変えない。`unboundMinutes` 分、親の起動の報告（done）のあとも紐付け（`child_bind`）がない子を、子ごとに 1 回だけ受信箱に出す（TouRyou の plugin が子の設定の置き場にない見込み。`--plugin-dir` だけでは子に付かない）。`stallMinutes` 分、報告・道具の使用・指示のやり取り（送った時刻も受け取った時刻も）の記録がない子を「止まっているかもしれない」として受信箱に出す（知らせの購読の heartbeat は数えない。トークンの `bindIdle` の時計とは別）。`unreadMinutes` 分、子が受け取らない指示も受信箱に出す。`echoMinutes`（1〜1440）分、指示の復唱（受け取った指示を子が言い直して返す確認。#261）が返らない指示を、指示ごとに 1 回だけ受信箱に出す（知らせの名前は `echoMissing`。詳しくは下の「指示の復唱の知らせ」）。`intervalSec` は見回りの間隔 |
| `hookSettingsCheckSeconds` | `2` | Desktop の子の見張りの間隔（秒） |
| `hookFirstSeenMinutes` | `5` | Desktop の子でフックが来ないときに知らせるまでの時間（分） |
| `claudeConfigDirs` | なし | 見張りが守る設定のディレクトリに足す場所（`~/.claude` と `CLAUDE_CONFIG_DIR` に加えて） |

## 指示の復唱の知らせ（`cliWatch.echoMinutes`）

指示の復唱（#261）は、子が指示を受け取ったことを、親が確かめるための仕組み。子の mcp が、記録された本文のハッシュ値（SHA-256 の先頭 16 桁）を、受け取りの知らせに添える。子の AI は計算しない。受信箱の知らせは 2 つある。

- `echoMismatch`（食い違い）: 復唱が、記録した本文から求めた値と合わない。この設定とは関係なく出る。自動の再送はしない。記録された指示の本文と子の返事を見比べ、必要なら `node_send` で送り直す。
- `echoMissing`（復唱が返らない）: `echoMinutes`（既定 5、1〜1440 の整数）分たっても復唱が返らない。指示ごとに 1 回だけ出る。復唱が届く・指示が消える・子が動いていないと、解決になる。`tree_list` で子の状態を見る。

`unreadMinutes` との重なり（同じ指示に知らせを重ねない）:

| 設定の大小 | 受け取られていない指示 | 受け取ったが復唱がない指示 |
|:--|:--|:--|
| `echoMinutes` ≤ `unreadMinutes` | `echoMissing` が兼ねる（`unreadMinutes` の知らせは出さない） | `echoMissing` |
| `echoMinutes` > `unreadMinutes` | `unreadMinutes` の知らせだけ | `echoMissing` |

復唱を添えない古い版の子（古い mcp）は、受け取った指示ごとに `echoMissing` が出る。plugin を更新して、子を開き直す。

## 外した項目

SDK による子の起動・子の認証・子の HOME の隔離・子用の HTTP の `touryou-mcp`・子の MCP の中継を外したので（決定ログ `.sdd/adr/touryou.md`）、次の項目は、書いてあっても無視します（消してかまいません）: `mcpUrl`・`childMcp`・`childHome`・`childPluginDir`・`childEnvAllow`。

範囲・下限の細かい値は、`packages/daemon/src/config.ts` の各項目のコメントにあります。

根（統合）のセッションは、TouRyou のフックで絞らない（フックが働くのは、子の印のある作業ツリーだけ。`cli/src/hook.ts`）。根の Bash・書き込みは、利用者の Claude Code の許可の設定のとおりに動く。`rootScope` は、子に渡す範囲の上限で、根自身の操作の制限ではない。

子の範囲は、親の範囲（根の子なら `rootScope`）の内側でなければなりません。外にはみ出すと、子の起動（`node_spawn`）や範囲の拡張の承認が `scopeNotSubset` で失敗します。子に `git add`・`git commit` をさせるなら、`rootScope.allowedCommands` に `"git add"`・`"git commit"` を入れておきます。`rootScope`・`permissions`・`autoApprove` を直したら、`touryou config reload` で読み込み直せます（検査に通ったときだけ入れ替わり、すでに付与した子の範囲は縮めません。新しい上限からはみ出す子は、名前が出ます）。ほかの項目は daemon の起動のときだけ読むので、直したら daemon を起動し直します（常駐なら `/touryou:service` の起動し直し）。`config reload` で、ほかの項目の変更があれば、名前を出して反映しません。実行中だけ規則を足す・外すときは `touryou policy add|remove <allow|deny|ask|autoApprove> <規則>`（人間だけ。`deny` も足せます）。設定ファイルに書いた規則は `policy remove` では外せません（`ruleFromConfig` で断られます）。設定ファイルを直して `touryou config reload` で読み込み直します。受信箱の知らせ・応答・ログには、規則の本文を出さず（秘密が書かれた規則がありうるため）、規則の種類（Bash・Edit・mcp）と足した・外したの別だけを出します（設定ファイルのパスも出しません）。規則の本文は、人間の状態画面の規則の一覧にだけ出ます。設定由来の規則の本文にはパスが含まれうるので、画面の写しを人に見せるときは注意してください。`config reload` は、実行中に足した規則と合わせた方針が検査を通らないときも、入れ替えません。

`rootScope.allowedCommands` の一致の規則: 項目を空白で語に分け、命令の先頭の語から順に、すべて一致すれば許可します（語の単位の前方一致。`"cd"` は `cd sub` を通しますが、`cdx sub` は通しません）。出典は `packages/core/src/scope.ts` の `checkCommand` です。

## 権限の規則（`permissions`・`autoApprove`）

> 状態（#194 の PR2）: **読み込みと検査だけ**です。規則は、起動のときに検査され、`rootScope` と合わせて 1 つの方針（`rootPolicyOf`）に畳まれますが、子の許可・承認の判定には**まだつながっていません**（判定は、今までどおり `rootScope` だけで決まります）。判定への接続は、後の版で入ります。

どちらも省略できます（省略は空）。`rootScope` は、今までどおり必須で、意味も変わりません。

```json
{
  "rootScope": { "writableLocations": ["src"], "forbiddenLocations": [".git", ".touryou"], "allowedCommands": ["git status"] },
  "permissions": {
    "allow": ["Bash(grep -rn:*)", "mcp__playwright__browser_snapshot"],
    "deny": ["Bash(git push:*)", "mcp__playwright__browser_navigate"],
    "ask": ["Bash(git commit:*)"]
  },
  "autoApprove": { "allow": ["Bash(grep -rn:*)"] }
}
```

| キー | 意味 |
|:--|:--|
| `permissions.allow` | 子に付与できる範囲の上限に足す規則。`rootScope` と同じ意味（子の許可そのものではなく、**付与できる上限**） |
| `permissions.deny` | 常に拒否する規則。`allow`・`ask`・`autoApprove` より強い（同じ規則が `allow` と `deny` にあれば `deny` が勝つ） |
| `permissions.ask` | 承認を人間だけに限る規則（root の AI は承認できず、自動承認もされない） |
| `autoApprove.allow` | 自動承認してよい規則 |

### 書ける規則の形

| 書き方 | 意味 |
|:--|:--|
| `Bash(<語の並び>:*)` | コマンドの前方一致（語の単位。`rootScope.allowedCommands` と同じ）。`Bash(grep -rn:*)` は `grep -rn foo` に当たる |
| `Bash(<語の並び>)` | コマンドの完全一致（語の数まで同じ） |
| `Edit(<相対パス>/**)` | 書き込みの場所（作業ツリーからの相対。配下すべて） |
| `mcp__<サーバー>__<道具>` | MCP のツール 1 つ（名前の完全一致） |
| `mcp__<サーバー>` | そのサーバーの全ツール（人間が config に書くときだけ。`autoApprove` には書けない） |

**解析できない書き方は、無視せず、起動を拒否します**（理由に、どの一覧のどの規則かを出します）。`Bash(a *)`・`mcp__server__*` のようなワイルドカード、`Write(...)`・`Read(...)` など別の道具名、空白で挟んだ規則、`..` や絶対パスの `Edit(...)`、`;` などでつないだ `Bash(...)` は、いまは書けません（Claude Code の書き方の細部を確かめるまで、入れていません）。1 つの一覧は 200 件以下、規則は 512 文字以下、同じ規則の重複は不可です。

### 追加の検査

- **`allow` と `autoApprove` の `Bash(...)`**: 子の許可と同じ検査を通ります。空・`cd` で始まる・**1 語だけ**（`grep`・`tail` など。前方一致で任意の引数が通る）・任意のコードが動く形（`node -e`・`npm exec`・`find -exec` など）は書けません。`deny`・`ask` は、1 語（`Bash(curl:*)` など）でも書けます。
- **`autoApprove`**: 読み取りだけで副作用のないものに限ります。
  - 書き込み（`Edit(...)`）・MCP のサーバー全体（`mcp__<サーバー>`）は書けません（MCP は、道具の名前を 1 つずつ書きます。MCP の注釈は、サーバーの自己申告なので信用しません）。
  - `Bash(...)` は、先頭の語が、フックが範囲によらず許す読み取り専用のコマンド（`find`・`ls`・`grep`・`git grep`・`git ls-files`）のものだけです。`git add`・`git commit`・`git push`・`curl` や、`pnpm test` のようなものは書けません（`head`・`tail`・`wc`・`cat` は、フックが範囲によらず許す形（作業ツリーの中のファイルを読むだけ。`tail -n <数> <ファイル>`・`head -n <数> <ファイル>`・`wc -l <ファイル>`・`cat <ファイル>`。`tail -f` などの旗・標準入力・パイプの直後は不可）になりましたが、自動承認の対象にはまだ入れていません。`autoApprove` には書けません）。
  - 各規則は、`permissions.allow`（または `rootScope.allowedCommands`・`writableLocations` から変換したもの）の**内側**にあること（上限より広い前方一致は不可）。`permissions.deny`・`permissions.ask` に当たるものは書けません（自動承認より狭い `deny` は書けます。判定では `deny` が勝ちます）。

### `rootScope` との関係（正規化）

読み込みのときに、`rootScope` と `permissions` を 1 つの方針に畳みます。

- `allow` = `rootScope.allowedCommands`（`Bash(<コマンド>:*)`）+ `writableLocations`（`Edit(<場所>/**)`）+ `permissions.allow`
- `deny` = `rootScope.forbiddenLocations`（`Edit(<場所>/**)`）+ `permissions.deny`
- 同じ内容は 1 つにまとめます。規則に直せない `rootScope` の項目（作業ツリー全体の `.`・解析できないコマンドなど）は、方針には入りません（`rootScope` としては、今までどおり効きます）。
- `permissions.allow` の MCP ツール（`mcp__<サーバー>__<道具>`）は、方針の `allowedMcpTools` になります（`Scope.allowedMcpTools` と同じ形）。

### MCP ツールの依頼と、上限・deny

- 子は、`scope_extend` の `kind: mcp` で、使いたい MCP ツールを**完全な名前**（`mcp__<サーバー>__<道具>`）で頼みます。サーバー全体（`mcp__<サーバー>`）と、touryou 自身の道具（`node_spawn` など）は、頼めません（人間が `permissions.allow` に書くときだけ、サーバー全体を書けます）。
- 承認できるのは、**`permissions.allow` に書いた MCP ツールの内側**だけです。書いていないものは、承認できません（上限を広げるのは人間です。判定のときに `touryou scope decide <ID> approve --also-limit`（上限にも足して承認）にするか、`config.json` を直して `touryou config reload` で読み込み直してから、もう一度判定します）。
- `permissions.deny` に当たる MCP ツールは、上限の内側でも承認できず、承認済みでもフックが許しません（deny が最優先）。
- 承認は、そのツールを、**どんな引数でも使ってよいのと同じ**意味です（Claude Code の規則は、名前だけで、引数を絞れません）。ブラウザなど外部へ届くツールは、承認の前に理由を確かめてください。自動承認（`autoApprove`）は、まだ MCP の依頼につながっていません。
- 依頼できるのは CLI の子だけです（Desktop の子は v0.2.0 以降）。
- `permissions.ask` に当たる MCP ツールは、子の依頼を統合ノードの判定（`scope_decide`）で承認できず、人間（状態画面）だけが承認できます（`forbidden`。deny に当たるものは、人間でも承認できません）。

### 版の組み合わせとダウングレード

- 旧の daemon（〜0.1.6）は、`permissions`・`autoApprove` を**未知のキーとして起動を拒否します**（権限の設定が黙って無視されるより、安全です）。旧の daemon に戻すときは、`permissions`・`autoApprove` を設定ファイルから消してから起動します。
- 新の daemon は、`permissions`・`autoApprove` のない旧の設定を、そのまま同じ意味で読みます。
- 新しい版の項目を、古い daemon の設定に書いたときの「未知のキー」の文には、「新しい版の項目なら daemon の版を上げる」と案内が付きます。
- MCP ツールの依頼（`scope_extend` の `kind: mcp`）を使い始めると、イベント列に、旧の daemon（〜0.1.6）が読めない種類の値（拡張の対象 `mcp`）が入ります。**1 度でも MCP ツールを頼んだら、旧の daemon には戻せません**（状態のスナップショットの版も 15 に上がります）。MCP ツールを頼む前なら、`permissions`・`autoApprove` を消して、旧の daemon に戻せます。
- 戻したときの記録の扱い（`eventlog.ts`・`events.ts` の読み込みより）: 状態のスナップショットは版（`STATE_VERSION`。今は 15）が合わないと使われず、記録の全体を最初から再生する。再生では、拡張の対象を読む `parseExtensionTarget`（`scope.extensionRequested` の `target`・`scope.extensionDecided` の `granted`）が、旧の daemon の知る種類（`write`・`command`）以外を `invalidPayload` で拒否するので、`kind: mcp` の記録が 1 つでもあると、状態を復元できない（記録は読み飛ばされない）。

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
    "forbiddenLocations": [".git", ".touryou"],
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
| `TOURYOU_DAEMON_CONFIG` | `touryou`・フック・`touryou ui`・`touryou-mcp --stdio`（MCP） | 設定ファイルのパス（`--config` の代わり）。空は無視する。優先順位は「`--config` の引数 → この環境変数 → cwd から上へ `<dir>/.touryou/config.json`」で、見つからなければ止まる（上の「設定ファイルの探し方」）。設定が `$HOME/.touryou` の外にあってもよい（設定ファイルの親ディレクトリが、リンクでない・自分の・`drwx------` か `drwxr-xr-x` であること） |
| `TOURYOU_ROOT_TOKEN` | 使わない | 統合セッションの `touryou-mcp --stdio` は、設定（`--config`・`TOURYOU_DAEMON_CONFIG`、なければ cwd から上の `.touryou/config.json`）の `stateDir` の `root-token` だけから読む（環境変数に置くと、Claude Code の環境に残り、Bash などで見えうるため）。`TOURYOU_MCP_URL` も廃止 |
| `TOURYOU_NODE_TOKEN` | フック | 手動の CLI の子のフック専用のトークン（`touryou hook-env`） |

手順の全体と確かめ方は [`manual-verification-checklist.md`](manual-verification-checklist.md) の H にあります。
