# daemon を常駐させる（launchd）

macOS（arm64）で、`touryou-daemon` を、ログイン時に自動で動かす手順です。常駐させるのは **daemon だけ**です（統合セッション用の `touryou-mcp` は、plugin が stdio で起動するので、常駐は要りません）。

- **plist は、`touryou launchd init` が生成します**（起動スクリプトは作りません。plist から、同梱の node で daemon を直に起こします。#64）。読み込み・止める・外すは、`touryou launchd apply|status|restart|stop|uninstall`（`docs/cli.md`）か、plugin の `/touryou:setup`（手順 3）・`/touryou:service` で行います。
- 生成物にも plist にも、秘密は入りません（TouRyou は Anthropic の認証を扱いません。daemon が作るトークンは `state` の中だけにあります）。
- 文書では、パスを記号で書きます: `<H>` は、自分の `$HOME` の絶対パス（`printf %s "$HOME"` で得る）。
- 事実（docs の記載・コードで確認）と、推測・未確認は、分けて書きます。

## 0. 前提と、できないこと

| 項目 | 内容 | 区分 |
|:--|:--|:--|
| 対象 | macOS の arm64。`/setup` を実行済み（`<H>/.touryou/current`・`<H>/.touryou/config.json`・`<H>/.touryou/state` がある） | 決定 |
| ポート | daemon の窓口のポートは、`state` の `port` に保存され、再起動しても変わらない | 事実（`docs/plugin.md`） |
| 同じ `stateDir` | 2 つの daemon を、同時に動かさない（SQLite を二重に開くと、`storeLocked` で失敗する。`packages/daemon/src/sqlite-store.ts`）。保存したポートが使われているときは、別のポートに移らず、`savedPortUnavailable` で起動しない（`packages/daemon/src/port-file.ts`）。端末で動かした daemon は、常駐を始める前に止める | 事実（コードで確認） |

### 取り消せない操作の確認（常駐では使えない）

`node.purge`（最終削除）・`node.discardedDrop`（保管の削除）・`node.reclaimInstruct`（破棄して回収）は、**Desktop の子の木では**、daemon の制御端末（`/dev/tty`）に出る確認コードで、人間の確認を要求します。**launchd で動かした daemon には、制御端末がない**ので、これらは `confirmationUnavailable` で実行できません（CLI の子だけの木は、確認が要らず、影響なし）。

- 対処: **Desktop の木で、これらが必要なときは、常駐を止めて（`touryou launchd stop`）、端末から `touryou-daemon` を起動し直す**。終わったら、常駐に戻す（`touryou launchd apply --yes`）。
- **確認の迂回（ファイルでの確認など）は、設計しない**（端末の確認コードの前提を弱めるため）。
- 未確認（推測）: launchd 配下の daemon に `/dev/tty` がないこと。

## 1. 生成する（`touryou launchd init`）

```sh
"$HOME/.touryou/current/bin/touryou" launchd init [--org <逆ドメイン>] [--path-prefix <git のある場所>]
```

- 前提: `/setup` を実行済み。`launchctl` は実行しない。既存と違う内容のファイルがあれば、黙って上書きせず、何も書かずに止まる。生成先がシンボリックリンクなら、辿らずに止まる。
- **Label**: `--org` を省略すると、組織のドメインを含まない **`touryou.daemon`**（決定）。自分のドメインにしたいときは `--org com.example` のように付けると **`com.example.touryou.daemon`** になる（小文字の英数字とハイフンのラベルを、ドットで 2 つ以上つないだ形だけ）。launchd の Label は、一意な文字列であればよく、逆ドメインは慣習（`launchd.plist(5)`）。**`--org` を付けたら、`apply`・`status`・`restart`・`stop`・`uninstall` にも同じ値を付ける**。
- 生成するもの（`<H>/.touryou` の下。`LaunchAgents` には置かない）:

| ファイル | 権限 | 中身 |
|:--|:--|:--|
| `launchd/<Label>.plist` | 0644 | 下の 2 |
| `logs/`（ディレクトリ） | 0700 | daemon のログ `daemon.log` |

- **古い形からの引っ越し**: v0.1.0 までの `init` は、`bin/run-daemon.sh`（`#!/bin/sh`）を作り、plist はそれを起こしていました。新しい `init` は、`launchd/<Label>.plist` と `bin/run-daemon.sh` が、**同じ `--org`・`--path-prefix` の古い `init` が生成したものとバイト単位で同じとき**だけ、plist を新しい形に置き換えます（`run-daemon.sh` は、`LaunchAgents` の古い形が次のログインで起こしうるので、まだ消しません）。どちらかを手で直していれば、何も書かず・消さずに止まります。`apply` は、`LaunchAgents` の plist が同じ `PATH` の古い形なら、止めて（`launchctl bootout`）から置き換えて読み込み、そのあとで `run-daemon.sh`（古い形と同じもの）を消します。`uninstall` は、古い形・新しい形のどちらも外します。
- `--path-prefix`: plist の `PATH` の先頭に足すディレクトリ（コロン区切りの絶対パス。Homebrew の `git` を使うときなど）。既定の `PATH` は `/usr/bin:/bin:/usr/sbin:/sbin`。

### 設定の検査（`init`・`apply` の前）

`init` と `apply` は、何かを書く・置く・`launchctl` を呼ぶ前に、`config.json` を **daemon と同じ検査**にかけます（`<H>/.touryou/current/bin/touryou-daemon --check-config --config <H>/.touryou/config.json`。daemon は起動せず、窓口・`state` に触れません）。

- 中身: 設定の読み込み（daemon の起動と同じ検査）と、`repoRoot`・`worktreeRoot` が実在する実パス（リンクを解決したもの）であること・`rootCwd` が `repoRoot` の配下に実在すること・`repoRoot` が git のリポジトリであること。
- 検査には、`HOME` と plist と同じ `PATH`（`--path-prefix` を含む）だけを渡します（常駐のときと同じ場所で `git` を探す。呼んだ側の環境は受け継がない）。
- 検査そのものを実行できない（daemon が置かれていない・`--check-config` を知らない古い版・時間切れ）ときは、設定の誤りと分けて「設定を検査できない」と出し、`/touryou:setup` での入れ直しを案内して止まります。
- 版を上げるとき（`/setup` の `--restart-daemon`）は、常駐の daemon を止める**前に**、新しい版の daemon で同じ検査をします。通らなければ、何も止めずに終わります。
- 通らなければ、**何も生成せず・plist を置かず・`launchctl` を呼ばずに**、終了コード 1 で止まります。理由（daemon の `失敗 [code]: …` と「次の操作」）と直し方を出します。**値（パス）は `<パス>` に伏せます**。
- 例: 前の日に消したフォルダを `repoRoot` が指したまま常駐にすると、daemon は起動のたびに `invalidConfig` で落ち、`KeepAlive` で起こし直され続けます。これを、常駐にする前に止めます。直したら（`config.json` の値を、今ある git のリポジトリ・フォルダの実パスにする。`/setup` のやり直しでもよい）、もう一度実行します。

## 2. plist の中身

- `ProgramArguments`: `<H>/.touryou/current/bin/node`・`<H>/.touryou/current/lib/dist/bin.js`・`--config`・`<H>/.touryou/config.json` の 4 つ（shell を通さない。#64）。`current` のリンクを通すので、版を上げても plist は変わりません。`WorkingDirectory`: `<H>/.touryou`。
- 版（`touryou-daemon --version`）は、plist に書きません。daemon が、配布物の版の印 `lib/dist-version`（`scripts/dist-build.sh` が置く）から読みます。
- `EnvironmentVariables`: `PATH` だけ（daemon は `git` を使うので、`git` のある場所を含める）。
- `RunAtLoad`: true。`KeepAlive`: `SuccessfulExit` が false（異常終了したときだけ、起動し直す）。`ThrottleInterval`: 30 秒。`Umask`: 077。
  - 設定の誤りでも、異常終了なので起こし直されます（30 秒ごと）。`KeepAlive` は変えず（ふつうの落ちたときの起こし直しを残す）、設定の誤りは、上の「設定の検査」で常駐にする前に止め、起きてしまったときは `status` の「最後の失敗」で理由を見せます。
- `StandardOutPath`・`StandardErrorPath`: `<H>/.touryou/logs/daemon.log`。

## 3. 読み込む・操作する（`touryou launchd …`）

| 操作 | コマンド | すること |
|:--|:--|:--|
| 常駐にする | `touryou launchd apply --yes` | plist を `<H>/Library/LaunchAgents` に置き、`launchctl bootstrap`、窓口の応答（未認証の whoami が 401）を約 60 秒まで待つ |
| 状態を見る | `touryou launchd status` | `launchctl print` の state・pid・last exit code と、窓口の応答。last exit code が 0 以外なら、`daemon.log`（plist の `StandardErrorPath`）の最後の失敗の行（`失敗 [code]: …`。値は `<パス>` に伏せ、200 字で切る） |
| 起動し直す | `touryou launchd restart` | `launchctl kickstart -k`（版を上げたあと） |
| 止める | `touryou launchd stop` | `launchctl bootout`（plist は残るので、次のログインでまた動く） |
| 外す | `touryou launchd uninstall --yes` | 止めてから、TouRyou が生成したと判定できる plist（古い形の `run-daemon.sh` も）だけを消す（`logs`・`state` は残す） |

- `apply`・`uninstall` は、`--yes` がないと何もしない（永続化・削除なので、利用者の同意を取ってから付ける。`/setup`・`/touryou:service` は定型文で聞く）。
- 読み込むと、システム設定の「一般」→「ログイン項目と機能拡張」→「バックグラウンドでの実行を許可」に、**TouRyou**（1 項目）が出ます（#73）。「開発元を識別できない項目」と出るのは、TouRyou に同梱した node を TouRyou の名前で手元の署名（ad-hoc）にしたためで、正常です。plist は `current/TouRyou.app/Contents/MacOS/TouRyou`（同梱の node。`bin/node` はそこへのリンク）で daemon を起こし、`AssociatedBundleIdentifiers` に `com.comcreate-info.touryou` を入れます。`touryou launchd apply` は TouRyou.app を LaunchServices に登録し（`lsregister -f`）、`uninstall` は登録を解きます（`lsregister -u`）。v0.1.1 では「Node.js Foundation」の項目でした。Apple の開発者の署名（Developer ID）は、まだ使いません（ADR）。

### ログイン項目に `sh`・`bash` が残っているとき

- v0.1.0 までは、plist が `run-daemon.sh`（`#!/bin/sh`）を起こし、それがさらに起動スクリプトを起こしていたので、ログイン項目に `run-daemon.sh`・`sh`・`bash` の 3 つが「開発元を識別できない項目」として出ました（macOS の `/bin/sh` は、`bash` などを呼び直す入口です）。マルウェアではありません。
- `sh`・`bash` は、Apple が署名した macOS のプログラム（チーム ID がないので、開発元の名前が出ない）。確かめ方: `codesign -dvv /bin/sh 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier)'`（`Identifier=com.apple.sh`・`Authority=Software Signing`・`TeamIdentifier=not set`）。スイッチはオフにしない（常駐を入れ直したときに止まるおそれがある）。
- 新しい版へ上げたあと（引っ越しのあと）、および `uninstall` のあとも、`sh`・`bash` の項目が残ることがあります（11-15 の実機で、`uninstall` のあとに残った）。TouRyou は、もうそれらを起こしません。**残っていても害はありません**。
- `sfltool resetbtm` は、ログイン項目の記録を**ほかのアプリの分まで全部**消してしまう（再起動が要り、各アプリの許可を取り直すことになる）ので、**勧めません**。
- 手で行うときは、`init` が出す命令（`cp` と `launchctl bootstrap "gui/$(id -u)" …`・`launchctl bootout "gui/$(id -u)/<Label>"`）を、そのまま使える。

## 4. 版を上げる

**止める → `/setup` → 起動し直す**の順です（`/setup` の「版を上げる」が、この順で案内します）。`/setup` の `--restart-daemon` の道は、古い版の `launchd init`（生成物が同じかの確かめ）→ `stop` → `current` の付け替え → 新しい版の `launchd init`（古い形なら、新しい形に置き換える）→ 新しい版の `apply --yes` です。新しい版の `init`・`apply` が失敗したときは、新しい版の `uninstall --yes` で新しい形を外し、`current` を戻し、古い版の `init`・`apply --yes` で、古い形のまま起動し直します。

## 5. ログの整理

daemon は、JSON の行を標準エラー（→ `<H>/.touryou/logs/daemon.log`）に出します。**launchd は、ログを回しません**ので、増え続けます。目安として、月に 1 回、サイズを見て（`ls -lh "<H>/.touryou/logs"`）、大きければ、止めてから、古いログを、自分で退避・削除します。トークンの値は、daemon の記録・失敗の文面に出さない設計ですが、共有するときは、中身を確かめてからにします。

## 6. 起動に失敗したとき

| 症状 | 原因の見立て | 直し方 |
|:--|:--|:--|
| `last exit code` が 0 以外。ログに `library load disallowed by system policy` が、約 1 分後に出て、再起動を繰り返す | 配布物に quarantine が付いている（ブラウザなどで取得した） | `/setup` の「起動に失敗したとき」のとおり、取り直す |
| ログに `storeLocked`、または `savedPortUnavailable` | 端末で動かした daemon が残っている（同じ `stateDir`・同じポート）。または、別のものがそのポートを使っている | 端末の daemon を止める。それでもだめなら、ログの案内のとおり |
| `status` の最後の失敗が `invalidConfig`（`repoRoot` などが実パスでない・ない・git のリポジトリでない） | `config.json` が、消した・動かしたフォルダを指している | `touryou launchd stop` → `config.json` を直す（または `/setup` のやり直し）→ `apply --yes`（設定の検査が通ってから読み込む） |
| 30 秒ごとに再起動を繰り返す | 起動の失敗が続いている（`ThrottleInterval`） | ログの最初のエラーを読む。直るまで、`touryou launchd stop` で止める |
| `git` が見つからない | plist の `PATH` に、`git` の場所がない | `uninstall --yes` → `init --path-prefix …` → `apply --yes` |
| 子の作成・回収が、git の失敗で止まる（ログに「git（Xcode Command Line Tools）が使えません」、または Xcode のライセンスの文面） | Command Line Tools がない（仮の git）、または Xcode のライセンスに未同意 | `xcode-select --install`、またはライセンスへの同意（`sudo xcodebuild -license`）。直したら、daemon を起動し直す |
| 確認コードが出ない（`confirmationUnavailable`） | 常駐（端末なし）では、Desktop の木の、取り消せない操作は実行できない | 上の「取り消せない操作の確認」のとおり |

## 7. 未確認の一覧

- launchd 配下の daemon に `/dev/tty` がないこと（`confirmationUnavailable` になること）
- `launchctl bootstrap`・`kickstart -k`・`bootout` の挙動の細部（macOS の版による）
- 仮の git・Xcode のライセンス未同意のときの、daemon のログの文面
- `gui/<uid>` が、ssh・ログアウト中の Mac では使えないこと（推測）
