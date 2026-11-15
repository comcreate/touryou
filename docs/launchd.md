# daemon を常駐させる（launchd）

macOS（arm64）で、`touryou-daemon` を、ログイン時に自動で動かす手順です。常駐させるのは **daemon だけ**です（統合セッション用の `touryou-mcp` は、plugin が stdio で起動するので、常駐は要りません）。

- **起動スクリプトと plist は、`touryou launchd init` が生成します**。読み込み・止める・外すは、`touryou launchd apply|status|restart|stop|uninstall`（`docs/cli.md`）か、plugin の `/touryou:setup`（手順 3）・`/touryou:service` で行います。
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
| `bin/run-daemon.sh` | 0700 | `exec "<H>/.touryou/current/bin/touryou-daemon" --config "<H>/.touryou/config.json"` だけ（秘密を読まない） |
| `launchd/<Label>.plist` | 0644 | 下の 2 |
| `logs/`（ディレクトリ） | 0700 | daemon のログ `daemon.log` |

- `--path-prefix`: plist の `PATH` の先頭に足すディレクトリ（コロン区切りの絶対パス。Homebrew の `git` を使うときなど）。既定の `PATH` は `/usr/bin:/bin:/usr/sbin:/sbin`。

## 2. plist の中身

- `ProgramArguments`: `run-daemon.sh` だけ。`WorkingDirectory`: `<H>/.touryou`。
- `EnvironmentVariables`: `PATH` だけ（daemon は `git` を使うので、`git` のある場所を含める）。
- `RunAtLoad`: true。`KeepAlive`: `SuccessfulExit` が false（異常終了したときだけ、起動し直す）。`ThrottleInterval`: 30 秒。`Umask`: 077。
- `StandardOutPath`・`StandardErrorPath`: `<H>/.touryou/logs/daemon.log`。

## 3. 読み込む・操作する（`touryou launchd …`）

| 操作 | コマンド | すること |
|:--|:--|:--|
| 常駐にする | `touryou launchd apply --yes` | plist を `<H>/Library/LaunchAgents` に置き、`launchctl bootstrap`、窓口の応答（未認証の whoami が 401）を約 60 秒まで待つ |
| 状態を見る | `touryou launchd status` | `launchctl print` の state・pid・last exit code と、窓口の応答 |
| 起動し直す | `touryou launchd restart` | `launchctl kickstart -k`（版を上げたあと） |
| 止める | `touryou launchd stop` | `launchctl bootout`（plist は残るので、次のログインでまた動く） |
| 外す | `touryou launchd uninstall --yes` | 止めてから、TouRyou が生成したと判定できる plist・起動スクリプトだけを消す（`logs`・`state` は残す） |

- `apply`・`uninstall` は、`--yes` がないと何もしない（永続化・削除なので、利用者の同意を取ってから付ける。`/setup`・`/touryou:service` は定型文で聞く）。
- 読み込むと、システム設定の「一般」→「ログイン項目」に、`run-daemon.sh` が「開発元を識別できない項目」として出る（署名しない方針どおり）。
  - 起動の script（`run-daemon.sh`）は `/bin/sh` で動き、macOS の `/bin/sh` は中で `bash` を使う。そのため、`run-daemon.sh` のほかに、`sh`・`bash` の項目も「開発元を識別できない項目」として出ることがある。
  - `sh`・`bash` は、Apple が署名した macOS のプログラム。チーム ID（開発者の番号）がないので、開発元の名前が出ない。確かめ方: `codesign -dvv /bin/sh 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier)'`（`Identifier=com.apple.sh`・`Authority=Software Signing`・`TeamIdentifier=not set`。`/bin/bash` も同じように確かめられる）。
  - 常駐を外す（`uninstall`）と `run-daemon.sh` の項目は消えるが、`sh`・`bash` は残ることがある。何も動かしていないので害はない。スイッチはオフにしない（あとで常駐を入れ直したときに止まるおそれがある）。
- 手で行うときは、`init` が出す命令（`cp` と `launchctl bootstrap "gui/$(id -u)" …`・`launchctl bootout "gui/$(id -u)/<Label>"`）を、そのまま使える。

## 4. 版を上げる

**止める → `/setup` → 起動し直す**の順です（`/setup` の「版を上げる」が、この順で案内します）。`/setup` が新しい版を `current` に入れたあと、`touryou launchd apply --yes`（または `restart`）で起動し直します。

## 5. ログの整理

daemon は、JSON の行を標準エラー（→ `<H>/.touryou/logs/daemon.log`）に出します。**launchd は、ログを回しません**ので、増え続けます。目安として、月に 1 回、サイズを見て（`ls -lh "<H>/.touryou/logs"`）、大きければ、止めてから、古いログを、自分で退避・削除します。トークンの値は、daemon の記録・失敗の文面に出さない設計ですが、共有するときは、中身を確かめてからにします。

## 6. 起動に失敗したとき

| 症状 | 原因の見立て | 直し方 |
|:--|:--|:--|
| `last exit code` が 0 以外。ログに `library load disallowed by system policy` が、約 1 分後に出て、再起動を繰り返す | 配布物に quarantine が付いている（ブラウザなどで取得した） | `/setup` の「起動に失敗したとき」のとおり、取り直す |
| ログに `storeLocked`、または `savedPortUnavailable` | 端末で動かした daemon が残っている（同じ `stateDir`・同じポート）。または、別のものがそのポートを使っている | 端末の daemon を止める。それでもだめなら、ログの案内のとおり |
| 30 秒ごとに再起動を繰り返す | 起動の失敗が続いている（`ThrottleInterval`） | ログの最初のエラーを読む。直るまで、`touryou launchd stop` で止める |
| `git` が見つからない | plist の `PATH` に、`git` の場所がない | `uninstall --yes` → `init --path-prefix …` → `apply --yes` |
| 子の作成・回収が、git の失敗で止まる（ログに「git（Xcode Command Line Tools）が使えません」、または Xcode のライセンスの文面） | Command Line Tools がない（仮の git）、または Xcode のライセンスに未同意 | `xcode-select --install`、またはライセンスへの同意（`sudo xcodebuild -license`）。直したら、daemon を起動し直す |
| 確認コードが出ない（`confirmationUnavailable`） | 常駐（端末なし）では、Desktop の木の、取り消せない操作は実行できない | 上の「取り消せない操作の確認」のとおり |

## 7. 未確認の一覧

- launchd 配下の daemon に `/dev/tty` がないこと（`confirmationUnavailable` になること）
- `launchctl bootstrap`・`kickstart -k`・`bootout` の挙動の細部（macOS の版による）
- 仮の git・Xcode のライセンス未同意のときの、daemon のログの文面
- `gui/<uid>` が、ssh・ログアウト中の Mac では使えないこと（推測）
