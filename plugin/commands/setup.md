---
description: ビルド済みの配布物（macOS の arm64）を、GitHub Release から curl（認証なし）で取得し、sha256 を照合して、決まった場所に置く（daemon・touryou-mcp・touryou を使えるようにする）
allowed-tools: Read
---

touryou の配布物（Node 同梱。daemon・`touryou-mcp`・`touryou`）を、この Mac に置きます。**利用者が、自分で実行するコマンド**です。置く場所は `$HOME` の下の `.touryou` です（実際のパスは、この文書に書きません）。

最初に、利用者に伝える（定型文）: 「これから、約 12 回、コマンドの承認の確認が出ます（最後に常駐にすると、さらに約 3 回）。1 回ごとに、画面のコマンドを読んで、問題なければ承認してください。」

Claude Code の auto モード（権限の自動判定）で実行しているときは、承認の確認はほとんど出ない見込み（推測）。自動判定で止められたときは、出た文面をそのまま利用者に伝え、利用者に手で許可してもらう（書き換えて実行し直さない）。**チャットでの「はい」（常駐の同意など。`--yes` を付ける前の定型文）は、auto モードでも必ず取る**（権限の自動判定とは別のもの）。

## 進め方の決まり

- **この文書に書かれたコマンドを、書かれたとおりに実行する**。引数・取得先・書き込み先を、変えない。ほかのコマンドは、実行しない。**コマンドが失敗したら、書き換えて実行し直さずに止まり**、出力をそのまま人に伝える（書き換えが安全に見えても、文書の外の動きになる）。
- **途中で中断したときは、そのまま `/setup` を最初からやり直してよい**。取得（手順 3。`-o`）と一覧（手順 5。`>|`）は上書きし、展開（手順 6）は同じ版のディレクトリに上書きする。
- このコマンドは、`Read` 以外を、事前に許可していない。**コマンドごとに、承認の確認が出る**（正常）。
- **安全は、「承認のときに、人が、画面のコマンドを確かめること」と「sha256 の照合」に依る。**承認の画面に出るのは、実際のコマンドの文字列で、この文書の説明とは別。モデルが、この文書と違うコマンドを出しても、止められるのは、人の目と、sha256 の照合だけ。**文書どおりに動くことは、試験では保証できない**（試験は、この文書の内容を検査するだけ）。
- 取得は **手順 3 の `curl` だけ**（認証なし。配布物のリポジトリは public）。ブラウザ・メール・AirDrop での取得は、案内しない（quarantine が付いて、daemon が動かないため。下の症状表）。`curl` で取得したファイルには、quarantine が付かない（`curl` は quarantine の属性を付けない）。macOS の版で変わりうるので、**それでも手順 4・7 で、必ず確かめる**。
- **GitHub のトークンを、出さない・読まない・貼らせない**（取得に認証は要らない）。`gh auth token`・`gh auth status --show-token`・`GH_TOKEN` などの環境変数の設定・`Authorization` のヘッダーを使うコマンドは、実行しない。
- **quarantine を、外さない**（`xattr` の書き換え〔`-d`・`-c`・`-w`〕・`sudo`・`rm` は、実行しない）。付いていたら、止まる。macOS が、出所の確かでないコードを実行する前に検査する安全装置なので、黙って外さない。
- `root-token` などのトークンのファイルは、読まない・出さない。トークンの値は、チャットに貼らせない。
- **常駐（launchd）の登録は、利用者が定型文の問いに、はっきり「はい」と答えたときだけ**行う（手順 9）。承認の画面で許可されただけでは、登録しない。**`--yes` は、利用者が定型文の問いにチャットで「はい」と答えたあとにだけ付ける。承認ダイアログの許可だけでは付けない**。登録・止める・起動し直すのは `touryou launchd` の決まったサブコマンドだけで、`launchctl` を直接は実行しない。
- **子の認証は扱わない**（touryou は Anthropic の認証を扱わない。CLI の子は、親のセッションが `claude --bg` で起動する）。
- **「止まる」とは**: 次の手順に進まず、原因（出力）をそのまま利用者に伝え、定型文があれば、それを添える。
- 人が入力するパスは、引用符で囲んで使う。**改行・引用符（`"`・`'`・`` ` ``）・`$`・`;`・`\` を含むときは、止まる**。

## 手順

1. **対象の確認（1 コマンド）**: `uname -sm && xcode-select -p && test -x "$(xcode-select -p)/usr/bin/git"`。`uname -sm` の出力が `Darwin arm64` であること。違えば止まる。
   定型文: 「この配布物は、Apple Silicon（M シリーズ）の Mac だけに対応しています。この Mac では使えません。」
   続けて、`xcode-select -p` が、終了コード 0 で、パス（Command Line Tools か Xcode の場所。どちらかがあればよい）を出し、そのパスの下に `git` が実在すること（Command Line Tools を消した後に、古いパスだけが残る場合に備える）。**失敗したら（終了コードが 0 でない）、止まる**。daemon は、子の作業ツリーを `git` で作るため、`git`（Xcode の Command Line Tools）が要る。**`git --version` は、使わない**（Command Line Tools がない Mac では、macOS に最初からある `git` は仮のプログラムで、実行するとインストールの画面が出うる。確かめていない）。インストール（`xcode-select --install`）は、このコマンドでは実行しない（利用者が、自分で実行する）。
   定型文（Command Line Tools がない）: 「この Mac には、git（Xcode の Command Line Tools）が入っていません。Terminal で `xcode-select --install` を実行して、インストールが終わってから、もう一度 /setup を実行してください（ダウンロードに、ネットワークと時間が要ります。Xcode だけを入れているときは、Xcode を一度開いて、ライセンスに同意してください）。」
2. **配布物の情報を読む**: `Read` で、`${CLAUDE_PLUGIN_ROOT}/checksums.json` と `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` を読む。`${CLAUDE_PLUGIN_ROOT}` が展開されず、読めないときは、plugin のディレクトリ（絶対パス）を、人に尋ねる。**ここで決めた plugin のディレクトリの絶対パス（以降 `<P>`）を、手順 4 でも使う。** 次を**すべて**確かめ、一つでも違えば止まる:
   - `checksums.json` の `version` と、`plugin.json` の `version` が同じで、`<数字>.<数字>.<数字>`（あれば、`-` と英数字・`.`）の形であること
   - `plugin.json` の `repository` が、`https://github.com/comcreate/touryou` であること（これ以外の取得元は、使わない）
   - `checksums.json` の `assets` の `darwin-arm64` の `name` が、`touryou-<版>-darwin-arm64.tar.gz`（`/`・`..`・空白を含まない）であること。`sha256` が、16 進の 64 文字であること
   - `checksums.json` の、ここに挙げたもの以外のキー（`extensions` など。デスクトップアプリの拡張機能の `.mcpb` の sha256）は、読まない・確かめない（知らないキーがあっても、止まらない）
   `checksums.json` がなければ、止まる。
   定型文（`checksums.json` がない・版が違う）: 「この plugin の版には、配布物の情報が入っていません。この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に、確かめてください。」
3. **取得（curl。1 コマンド）**: `mkdir -p "$HOME/.touryou/work" && curl -fL --proto '=https' --proto-redir '=https' -o "$HOME/.touryou/work/<name>" "https://github.com/comcreate/touryou/releases/download/v<版>/<name>"`（`<name>` は手順 2 の `name`、`<版>` は手順 2 の `version`。URL の `https://github.com/comcreate/touryou` は、手順 2 で確かめた `repository`。これ以外の取得元は、使わない）。認証は要らない（配布物のリポジトリは public。GitHub のアカウント・`gh` は要らない）。`-f` で、HTTP の失敗（`404` など）を終了コードにし、`-L` で Release の asset の置き場へのリダイレクトに付いていく（`--proto '=https'`・`--proto-redir '=https'` で、最初の要求もリダイレクトの先も https だけにする）。書き込み先は、`$HOME/.touryou/work/` の下だけ（この tar.gz と、手順 5 の一覧）。**このコマンドは、タイムアウトを長め（最大 10 分）にして実行する**（約 150MB で、遅い回線では、既定のタイムアウトで打ち切られうる）。途中で打ち切られたら、**同じコマンドを、もう一度実行する**（`-o` で上書きする。途中から再開はしない）。
   **失敗したら（終了コードが 0 でない）、止まる**。`curl: (22) … 404` は、その版の Release がない（plugin と Release の版の食い違い）ことが多い。
   定型文: 「配布物を取得します（目安として約 150MB です。回線によっては、数分かかります）。」
   定型文（取得の失敗）: 「配布物を取得できませんでした。ネットワークの接続を確かめて、もう一度 /setup を実行してください。`404` と出たときは、plugin の版の配布物が公開されていません。plugin を新しい版にしてから（`claude plugin marketplace update touryou` と `claude plugin update touryou@touryou`）、もう一度実行してください。分からなければ、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談してください。」
4. **照合と、取得したファイルの quarantine（1 コマンド）**: `grep -c -F "\"sha256\": \"$(shasum -a 256 "$HOME/.touryou/work/<name>" | cut -d' ' -f1)\"" "<P>/checksums.json" && ls -l@ "$HOME/.touryou/work/<name>"`。**ハッシュは、シェルが計算する**（人も、モデルも、書き写さない）。`grep` が、終了コード 0（1 件）で終わったときだけ、`ls -l@` が動く。**0 件なら（`shasum` の失敗を含む）、展開せずに止まる**（`checksums.json` に、この版の `sha256` は、1 行だけある）（取得したファイルは、削除しない。次回の取得が、上書きする）。取得先の `.sha256` は、同じサーバーの値で、`checksums.json` とは別の信頼にならないので、使わない。
   `ls -l@` の出力に `com.apple.quarantine` が**ないこと**。あれば、**外さずに**止まる。`com.apple.provenance` は、macOS が付ける別の属性で、Claude Code の中の Bash から起動するときは、起動を妨げない（利用者の Terminal から起動するときは未確認）。
   定型文（照合の失敗）: 「配布物の検証に失敗しました（改ざん・取得の失敗の可能性）。インストールを止めました。この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に知らせてください。」
   定型文（quarantine）: 「配布物に、macOS の安全確認の印が付いています（ブラウザなどで取得すると付きます）。この setup を、もう一度実行して、取り直してください。それでも付くときは、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談してください。」
5. **展開前の中身の確認（1 コマンド）**: `tar -tzf "$HOME/.touryou/work/<name>" >| "$HOME/.touryou/work/list.txt" && ! grep -q -v -E '^touryou-darwin-arm64/' "$HOME/.touryou/work/list.txt" && ! grep -q -E '(^|/)\.\.(/|$)' "$HOME/.touryou/work/list.txt" && echo OK`。**`tar` が失敗したとき（ファイルがない・壊れている）も、`OK` は出ない**（先に、`tar` の成否を確かめ、一覧を、ファイルに書いてから、検査する）。**`OK` が出なければ、止まる**（先頭が `touryou-darwin-arm64/` 以外・絶対パス・`..` の要素がある）。なお、配布物の中のシンボリックリンクの行き先は、この確認では見えない（守りの本体は、手順 4 の sha256 の照合）。`>|` は、シェルの上書き禁止（noclobber。`set -C`）が有効でも、前回の一覧を上書きする（POSIX sh・bash・zsh で同じ意味。noclobber が無効なら `>` と同じ）。
   定型文: 「配布物の中身が、想定と違います。インストールを止めました。この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に知らせてください。」
6. **展開・配置（1 コマンド）**: `{ [ ! -e "$HOME/.touryou/current" ] || [ -L "$HOME/.touryou/current" ]; } && mkdir -p "$HOME/.touryou/v<版>" && tar -xzf "$HOME/.touryou/work/<name>" -C "$HOME/.touryou/v<版>" && ln -sfn "$HOME/.touryou/v<版>/touryou-darwin-arm64" "$HOME/.touryou/current"`。展開されるのは、`touryou-darwin-arm64`（`bin/`・`lib/`）。呼び出し側は、`current/bin/` を使う。**注意**: ①`current` が、リンクでない実ディレクトリのときは、最初の確認で止まる（上書きしない）。②**daemon・`touryou-mcp` が動いている間は、止めてから**実行する（リンクの付け替えは、実行中のプロセスに効かない。常駐〔launchd〕にしているときは、下の「版を上げるとき」の 1 で止める）。③同じ版の再実行は、上書きで展開する（古いファイルが残りうる。消す操作は、このコマンドではしない）。
   定型文: 「配置します。daemon を動かしている場合は、先に止めてください。」
7. **展開後の quarantine と、動作の確認（1 コマンド）**: `ls -lR@ "$HOME/.touryou/v<版>/touryou-darwin-arm64" | grep -c com.apple.quarantine; "$HOME/.touryou/current/bin/touryou-daemon" --help`。`grep -c` が `0` であること（**終了コード 1 は、「0 件」で、正常**）。`0` でなければ、**外さずに**止まる（手順 4 の「quarantine」の定型文）。`ls -lR@` は、ディレクトリがなくても `grep -c` が `0` になる（正常に見える）ので、**直後の `--help` が、使い方を出すこと**で、展開できていることを確かめる。`--help` が、使い方を出すこと（同梱の Node で動く。システムの Node は要らない。`--help` は、使い方を出して終わる。daemon は起動しない。CI の arm64 の配布物の smoke で確認）。
   定型文: 「インストールできました。次は、設定です。」
8. **設定ファイル**: **`repoRoot` は、git のリポジトリであること**（前提。下の 2 で確かめる。git でないフォルダは使えない）。人に、daemon が作業するリポジトリ（`repoRoot`・`rootCwd`）と、作業ツリーの置き場（`worktreeRoot`）を、**ホームの下の絶対パス**で尋ねる（勝手に決めない。上の「人が入力するパス」の決まりに従う。**`<H>/` で始まらなければ、止まる**）。一時ディレクトリ（macOS の `tmp`・`var` の下）は、リンクのため、使わない。順に:
   1. `printf %s "$HOME"` で、`$HOME` の絶対パス（以降 `<H>`）を得る（`Write` は、絶対パスが必要で、JSON の中も `$HOME` を展開しないため）。
   2. `git -C "<repoRoot>" rev-parse --is-inside-work-tree` が `true` であること（`repoRoot` が git リポジトリであること）。違えば止まる。
   3. `mkdir -p "<H>/.touryou/state" "<worktreeRoot>" && chmod 700 "<H>/.touryou/state"`。
   4. `Write` で、`<H>/.touryou/config.json`（**この 1 か所だけ**）を、下の形で書く。**`stateDir` も絶対パス**（`<H>/.touryou/state`）。
   5. `chmod 600 "<H>/.touryou/config.json"`。
   形（必須の 5 項目だけ。`docs/config.md` と同じ。値は、人に確かめる）:
   ```json
   {
     "stateDir": "<H>/.touryou/state",
     "repoRoot": "<repoRoot>",
     "worktreeRoot": "<worktreeRoot>",
     "rootCwd": "<repoRoot>",
     "rootScope": { "writableLocations": ["src"], "forbiddenLocations": [".git"], "allowedCommands": ["git status"] }
   }
   ```
   `rootScope` は、子の権限の上限（根〔統合〕のセッション自身は touryou のフックで絞らない。根の操作は、利用者の Claude Code の許可の設定のとおり）。この例は最小で、人に確かめる（既定を、勝手に広げない）。**トークンの値は、設定ファイルに書かない**（daemon が `state` の下に作る）。
   **書く前に、次の定型文で、子に commit させるかを尋ねる**。「はい」なら、`allowedCommands` を `["git status", "git add", "git commit"]` にする。「いいえ」・あいまいなら、例のまま（`["git status"]`）にする。ほかに子に使わせたいコマンド（`pnpm test` など）を言われたら、2 語以上の形で足す（下の「子の範囲のコマンド」の決まり）。
   定型文（commit）: 「子（作業のセッション）に、自分の作業ツリーで git add・git commit をさせますか（はい／いいえ）。いいえにすると、子の範囲に git add・git commit を入れて起動したときに、子の起動が scopeNotSubset で失敗します。あとで変えるときは、config.json の rootScope を直して、daemon を起動し直します。」
   定型文: 「daemon が作業するフォルダを、教えてください（ホームの下の、フォルダの場所を、最初から最後まで書いてください）。」
9. **起動のしかたを選ぶ**: 利用者に、次の定型文で尋ねる。答えが「常駐」なら 9-A、「手で」なら 9-B へ進む。分からなければ 9-B。
   定型文: 「daemon の起動のしかたを選んでください。(1) 常駐にする（推奨。ログインしたら自動で動きます。macOS のログイン項目に 1 項目が追加されます） (2) 手で起動する（使うたびに Terminal で起動します）」
   **9-A. 常駐にする**（コマンドは 3 つ。どれも `"$HOME/.touryou/current/bin/touryou"` の `launchd` サブコマンド）:
   1. **同意**: 次の定型文で尋ね、**はっきり「はい」のときだけ**進む。それ以外（「いいえ」・あいまい・質問）は、登録せずに 9-B へ進む。
      定型文: 「これから、ログインしたときに daemon を自動で動かす設定（macOS の launchd。`$HOME/Library/LaunchAgents` に 1 つの plist を置きます）を入れます。システム設定のログイン項目に、1 項目が「開発元を識別できない項目」として追加されます。やめるときは /touryou:service の uninstall で外せます。入れてよいですか（はい／いいえ）」
   2. **生成**: `"$HOME/.touryou/current/bin/touryou" launchd init`。起動スクリプトと plist を `$HOME/.touryou` の下に作る（`launchctl` は実行しない）。既存と違う内容のファイルがあると、何も書かずに終了コード 1 で止まる（上書きしない）。そのときは、出力を利用者に伝えて止まる。
   3. **登録と起動**: `"$HOME/.touryou/current/bin/touryou" launchd apply --yes`（**1 の「はい」のあとだけ**。`--yes` は同意を取ったことの印）。plist を LaunchAgents に置き、daemon を読み込み、窓口の応答（未認証の whoami が 401）を待って、最後に状態を出す。終了コードが 0 なら成功。0 でなければ、出力（状態・`daemon.log` の起動スクリプトの文）をそのまま伝えて止まる。
      定型文（成功）: 「常駐にしました。macOS から「ログイン項目が追加された」という通知が出て、システム設定のログイン項目に run-daemon.sh の 1 項目が「開発元を識別できない項目」として出ます。これは正常です（署名していない起動スクリプトのため）。」
   4. **つながるのを待つ**: この会話の node は、配布物と daemon を見つけると、10 秒ほどで自動でつながる（Reconnect は要らない。plugin の中継〔`bin/touryou-mcp-shim.sh`〕が、道具の一覧が変わったことを Claude Code に知らせる）。そのあと `/touryou:start` で、接続を確かめる。`/start` で node の道具がまだ使えなければ、`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面〔デスクトップ版など〕なら、Claude Code を起動し直す）。以後の確認・起動し直し・止める・外すは、`/touryou:service`。
   **9-B. 手で起動する**（別の端末で行う。起動の順序は daemon → 統合セッション）:
   - `"$HOME/.touryou/current/bin/touryou-daemon" --config "$HOME/.touryou/config.json"`（窓口の URL が出る）
   - 統合セッションの MCP は、plugin の `.mcp.json` が stdio で `touryou-mcp --stdio` を起動し、`touryou-mcp` が `state` の `root-token`・`port` を自分で読む（手で起動しない・環境変数は要らない）。`TOURYOU_DAEMON_URL` は、統合セッションの環境には設定しない。
   - 続けて、**つながるのを待つ**: daemon を起動したあと、この会話の node は、配布物と daemon を見つけると、10 秒ほどで自動でつながる（Reconnect は要らない。plugin の中継〔`bin/touryou-mcp-shim.sh`〕が、道具の一覧が変わったことを Claude Code に知らせる）。そのあと `/touryou:start` で、接続を確かめる。`/start` で node の道具がまだ使えなければ、`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面〔デスクトップ版など〕なら、Claude Code を起動し直す）。
   定型文: 「次のコマンドを、別のターミナルで実行してください。」
   定型文（つながるのを待つ。9-A・9-B のどちらでも）: 「この会話の node は、10 秒ほどで自動でつながります。つながらなければ、/mcp で node を選んで Reconnect してください（または Claude Code を起動し直してください）。」
   デスクトップアプリ（普通のチャット・Cowork〔このコンピュータ〕）でも使うなら、続けて `/touryou:desktop` で拡張機能を入れられる、と 1 行だけ伝える（このコマンドでは入れない）。

## CLI の子と plugin の置き場

**CLI の子と plugin**: `--plugin-dir` で開いたのは、そのセッションだけ。`--plugin-dir` だけで開いた親の子（`claude --bg`）には plugin が付かず、子は `child_bind` を見つけられないまま止まり、touryou のフック（守り）も効かない。そこで touryou は、親の mcp の plugin の場所（`CLAUDE_PLUGIN_ROOT`）が確かめを通れば、子の起動の文に `--plugin-dir` を足す（marketplace から入れた plugin と重なっても 1 つにまとまる）。付けられなかったときは、受信箱に理由が出る。そのときは plugin を設定の置き場に入れる（marketplace から入れる）。daemon は、起動の報告のあと所定の時間（`cliWatch.unboundMinutes`。既定 3 分）紐付けのない子を、受信箱に 1 回だけ出す。

## 許可の一覧（任意。CLI の子を動かすとき）

CLI の子は、親のセッション（統合）が Bash で `claude` のコマンドを実行して、起動・停止・削除します（touryou は起動しない）。auto でないモード（ふつうのモード）では、そのたびに許可の確認が出ます。確認を減らしたいときは、**利用者が自分で**、Claude Code の settings に許可の一覧を足します。この手順では、settings のファイルを書き換えない（案内だけ。利用者に任せる）。

- **plugin の設定では入れられない**: plugin が持てる `settings.json` は、既定の agent などに限られ、許可（`permissions`）は入れられない（Claude Code の plugin の仕様）。そこで、利用者の settings に足してもらう。
- 足す場所: 自分だけなら、利用者の設定の置き場の `settings.json`（全部のプロジェクト。ふつうは `<H>/.claude/settings.json`。`CLAUDE_CONFIG_DIR` を使っているなら、そのディレクトリの下の `settings.json`）か、作業するリポジトリの `.claude/settings.local.json`。
- 勧める中身（`permissions.allow` に足す。すでにある項目は残す）。**Bash で勧めるのは、`claude stop` と `claude agents --json` だけ**:

  ```json
  {
    "permissions": {
      "allow": [
        "Bash(claude agents --json)",
        "Bash(claude stop:*)"
      ]
    }
  }
  ```

- 親（統合）のセッションで、読むだけの touryou の道具も確認なしにしてよい（任意）。足すのは次の 7 つだけ（plugin から入れた親の道具の名前。`whoami`・`inbox_fetch`・`tree_list`・`node_capabilities`・`decision_get`・`report_get`・`node_reclaimPreview`）:

  ```json
  {
    "permissions": {
      "allow": [
        "mcp__plugin_touryou_node__whoami",
        "mcp__plugin_touryou_node__inbox_fetch",
        "mcp__plugin_touryou_node__tree_list",
        "mcp__plugin_touryou_node__node_capabilities",
        "mcp__plugin_touryou_node__decision_get",
        "mcp__plugin_touryou_node__report_get",
        "mcp__plugin_touryou_node__node_reclaimPreview"
      ]
    }
  }
  ```

  - 足さない道具: 書く道具・起動（`node_spawn`）・指示（`node_send`）・停止（`node_stop`・`node_confirmStopped`）・判定（`node_review`・`scope_decide`）・回収（`node_reclaim`）・`node_bindCode`・`decision_present`・`node_split`・`parent_report`・`parent_request`。ものを変える呼び出しは、確認の画面で目で止めるため。`parent_request` は、起動のコマンドを返して Bash で実行させる入口なので、読むだけに見えても足さない。
  - 名前は、Claude Code の `/permissions` で実際の形を確かめてから足す（Desktop の拡張機能や `--plugin-dir` で入れたときは、名前の形が違うことがある。例: `mcp__node__<道具>`）。
- 勧めないもの:
  - `Bash(claude --bg:*)`: 前方一致なので、任意の指示・任意の旗（`--dangerously-skip-permissions`・別の `--settings`・`--permission-mode bypassPermissions` など）の起動も、確認なしで通る。勧めない（起動のたびに確認が出るので、画面のコマンドを目で見る）。入れるなら、任意の旗の起動も通ることを分かったうえで入れる。
  - `Bash(claude rm:*)`: `--discard-unpushed`（未 push の成果を捨てる）つきの削除も、確認なしで通る。入れない（毎回の確認で目で見る）。
- 注意:
  - 起動のコマンドは `cd <作業ツリー> && claude --bg … [--plugin-dir <plugin の場所>] --permission-mode dontAsk --settings …` の形（`--plugin-dir` は、親の plugin の場所が確かめを通ったときだけ。子に plugin が付かなかったときは受信箱に出る）。`cd` の部分で確認が出るかは、Claude Code の版によって違うことがある。
  - **Bash の確認の画面では、いちばん上の「1. Yes」だけを選ぶ**。次のものは選ばない:
    - 「Yes, and don't ask again for: cd *」: 以後、`cd` で始まれば `&&` のあとに何がつながっても確認なしで通ってしまう（起動・停止・削除以外の任意のコマンドも通る）。
    - 「Yes, and switch to auto mode」: 以後の操作がすべて確認なしになる。
    - 「Yes, allow reading from … from this project」: 範囲外の読み取りまで黙って許してしまう。
    理由は、touryou の依頼のコマンド（`cd <作業ツリー> && claude …`・`claude stop`・`claude rm`・`claude agents --json`）だけを、毎回、目で見て通すため。減らしたいときは、下の「`permissions.allow` に足す」の 2 つだけを足す（`cd *` などの広い許可は足さない）。
  - 変数を含むコマンドは「A variable in this command can't be checked before it runs」の確認が、許可の一覧があっても出る。touryou の依頼のコマンドは、変数のない形にしてある。書き換えないで実行する。
  - 足したあとは、Claude Code の `/permissions` で、入ったかを確かめられる。

- 子の許可: 子は `--permission-mode dontAsk` で動き、範囲（書き込みの場所・許可のコマンド）と touryou の道具・作業ツリーの中の読み取りだけを確認なしで使う。範囲の外の操作は、確認を出さずに断られる。要るときは、子が受信箱で範囲の拡張（`scope_extend`）を頼む。子の許可は、利用者の settings に足さなくてよい（touryou が起動の文に入れる）。
- 子の範囲のコマンド（`allowedCommands`）は、2 語以上で書く（`git status`・`git add`・`git commit`・`pnpm test` など）。`git`・`node` のような 1 語だけのものや、`;`・`>`・引用符などを含むものがあると、子の起動の依頼が `invalidScope` で失敗する（前方一致で何でも通ってしまうため）。`bash`・`node`・`npx`・`npm exec`・`pnpm dlx`・`git config`・`find -exec` など任意のコードを動かせる形と、スクリプトの名前のない `pnpm run` も同じく失敗する（`pnpm run build` のように書く）。`yarn <スクリプト>` は `run` がなくてもスクリプトを動かすので、`yarn` で 2 語のコマンドを許すときは、それがスクリプトの名前でないことを確かめる。子に `git add`・`git commit` をさせたいときは、根の範囲（`rootScope`）と子の範囲の両方に入れておく（子の範囲は根の範囲の内側でないと、子の起動が `scopeNotSubset` で失敗する。子の範囲に入れないと、子は確認なしで断られる）。根の範囲を直したら、daemon を起動し直す（`config.json` は起動のときだけ読む）。
- 利用者や作業するリポジトリの settings にある許可（`permissions.allow`）は、子も受け継ぐと見ている（推測）。広い許可を置いていると、子もそれを使える。

定型文: 「CLI の子の停止と状態の確かめのたびに許可の確認が出ます。減らしたいときは、ご自分の Claude Code の settings の permissions.allow に、次の 2 つを足してください。起動（`claude --bg`）と削除（`claude rm`）は、任意の旗の起動や成果を捨てる削除も通ってしまうので、足さずに、毎回の確認で目で見ることを勧めます。」

## 版を上げるとき（常駐にしているとき）

この `/setup` を、新しい版の plugin で、もう一度実行する。**手順 1 の前に**、次の 1 を行い、手順 7 の後に 2 を行う（手順 8・9 は飛ばしてよい。設定と常駐の登録は、そのまま使う）。

1. **常駐の確認と、止める**: `"$HOME/.touryou/current/bin/touryou" launchd status`。「読み込み済み」の行があれば、常駐中。
   常駐中なら、**止める前に** `"$HOME/.touryou/current/bin/touryou" launchd init` で、今の生成物が引数なしの init と同じかを確かめる（同じなら何も書かずに終了コード 0）。**0 でなければ、止めずに終わる**（手で別の `--org`・`--path-prefix` を付けて init した場合など。出力を伝え、`docs/launchd.md` の手作業の手順で版を上げてもらう）。
   0 なら、次の定型文で尋ね、**はっきり「はい」のときだけ** `"$HOME/.touryou/current/bin/touryou" launchd stop` を実行する（plist は残る）。それ以外（「いいえ」・あいまい・質問）は、何もせずに、版を上げずに終わる。
   定型文: 「常駐している daemon を、いったん止めて、新しい版に入れ替えます。入れ替えたあと、常駐の設定のまま（ログイン時に自動で動くまま）起動し直します。動いている子のセッションは止まります。よいですか（はい／いいえ）」
2. **起動し直す**: 手順 7 の後に、`"$HOME/.touryou/current/bin/touryou" launchd apply --yes`（1 の「はい」で、常駐のまま起動し直す同意は取れている。新しい版の `apply` は、plist が新しい版の雛形と違えば、何も変えずに止まる。起動スクリプトの中身は比べない）。終了コードが 0 でなければ、出力を伝えて止まる。
   **つなぎ直す**: 版上げの前から動いている統合セッションの `touryou-mcp --stdio` は、古い版のまま動き続ける（`current` の付け替えは、実行中のプロセスに効かない。手順 6）。2 のあと、`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面なら、Claude Code を起動し直す）。ほかに開いている統合セッションがあれば、そちらも同じ。そのあと `/touryou:start` で、接続を確かめる。
   **途中で止まったとき**（1 の stop のあと、手順 1〜7 か、この 2 で止まった）: 常駐は止まったままで、plist は LaunchAgents に残る。原因を直したら、この 2 をやり直す（`apply --yes` が読み込み直す。`/touryou:service restart` は、読み込まれていないので使えない）。plist が新しい版の雛形と違って止まったときは、`touryou launchd uninstall --yes` で生成物を外し、**前回と同じ引数で** `touryou launchd init` をやり直してから、`apply --yes`。何もしなくても、次のログインで、`current` が指す版のまま動き出す。

## 起動に失敗したとき

| 症状 | 原因の見立て | 直し方 |
|:--|:--|:--|
| `touryou-daemon --help` は通るが、daemon が起動して約 1 分後に終了する。標準エラーに `library load disallowed by system policy` | 配布物に quarantine が付いている（ブラウザなどで取得した） | **この setup の `curl` で取り直す**（この setup を、もう一度）。手順 7 の確認が `0` になること。それでも付くときは、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談する |
| `Killed: 9`、「開けません」 | 原因は未確認 | まず、手順 4・7 の確認をする。変わらなければ、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談する |
| `Bad CPU type in executable` | 機種と配布物が違う（対象は arm64） | `uname -sm` が `Darwin arm64` か確かめる |
| 手順 4 で、照合に失敗する | 取得の失敗、または配布物の差し替え | 展開しない。取り直す。それでも合わなければ、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談する |

取得した tar.gz（目安として約 150MB）は、`$HOME/.touryou/work` に残る。インストールの確認のあとは、**利用者が、自分で消してよい**（消さなくても動く。このコマンドは、`rm` を実行しない）。

置いた配布物を、新しい版にするときは、plugin を新しい版にして、daemon を止めてから、この `setup` を、もう一度実行します（版ごとのディレクトリに展開し、`current` を向け直す）。
