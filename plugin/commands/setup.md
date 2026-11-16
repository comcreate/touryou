---
description: ビルド済みの配布物（macOS の arm64）を、plugin の中の script で、GitHub Release から取得し、sha256 を照合して、決まった場所に置く（daemon・touryou-mcp・touryou を使えるようにする）
allowed-tools: Read
---

TouRyou の配布物（Node 同梱。daemon・`touryou-mcp`・`touryou`）を、この Mac に置きます。**利用者が、自分で実行するコマンド**です。置く場所は `$HOME` の下の `.touryou` です（実際のパスは、この文書に書きません）。

最初に、利用者に伝える（定型文）: 「これから、約 3 回、コマンドの承認の確認が出ます（本体の導入・設定・常駐の登録で 1 回ずつ。常駐にしないときは 2 回）。1 回ごとに、画面のコマンドを読んで、問題なければ「1. Yes」で承認してください。これより多く出たときは、その画面のコマンドを控えて、COMCREATE に知らせてください。」

Claude Code の auto モード（権限の自動判定）で実行しているときは、承認の確認はほとんど出ない見込み（推測）。自動判定で止められたときは、出た文面をそのまま利用者に伝え、利用者に手で許可してもらう（書き換えて実行し直さない）。**チャットでの「はい」（常駐の同意など。`--yes`・`--restart-daemon` を付ける前の定型文）は、auto モードでも必ず取る**（権限の自動判定とは別のもの）。

## 進め方の決まり

- **この文書に書かれたコマンドを、書かれたとおりに実行する**。引数・取得先・書き込み先を、変えない。ほかのコマンドは、実行しない。**コマンドが失敗したら、書き換えて実行し直さずに止まり**、出力をそのまま人に伝える（書き換えが安全に見えても、文書の外の動きになる）。
- **途中で中断したときは、そのまま `/setup` を最初からやり直してよい**（導入の script は、照合が通った取得済みのファイルを使い直し、途中の展開は片付けてから置き直す）。
- このコマンドは、`Read` 以外を、事前に許可していない。**コマンドごとに、承認の確認が出る**（正常）。
- **この `/setup` の中で走らせる Bash は、手順 1・手順 2・手順 3-A の 2 の 3 つだけ**（版が変わり常駐しているときは、手順 1 の代わりに `--restart-daemon` つきの 1 つ）。それぞれを、**書かれた 1 行のまま、1 回の Bash で**走らせる（`&&` の前後を別の Bash に分けない・つなぎ足さない）。承認の確認の回数は、Bash の数と同じにする。
- **確かめのための別のコマンドは、走らせない**。`ls`・`cat`・`test`・`stat`・`readlink`・`which`・`git -C … rev-parse`・`launchctl`・`uname`・`echo` などで、置き場・パス・リポジトリ・常駐を前もって・あとから確かめない。確かめは、**script とコマンドの出力（`RESULT:`・`CONFIG:`・`LAUNCHD:`・`OK`・`launchd apply` の状態の表示）と、`Read`**（事前に許可されていて、確認が出ない）で行う。出力が長くて切れたときも、読み直すためのコマンドは走らせない（出力の最後の行で分ける）。
- 手順 2 のパス（ホームの下か・git のリポジトリか・`config.json` がないか）は、手順 2 のコマンドの中で確かめる。**前もって別のコマンドで確かめない**（`OK` が出なければ止まる）。
- **この `/setup` の中で、node の道具（`whoami`・`tree_list` など）・`/touryou:service`・`/touryou:start` の中身を、代わりに実行しない**（それぞれに承認の確認が出る）。接続の確かめは、最後に、利用者に `/touryou:start` を打ってもらう。
- **本体の取得・照合・展開・付け替えは、plugin の中の 1 本の script（`scripts/install-runtime.sh`）が行う**。script は、plugin の zip の一部で、Claude Code が、marketplace の sha256 で zip ごと確かめてから置いたもの。取得元・版・sha256 は、script が plugin の中の `checksums.json`・`plugin.json` から読む（引数・環境変数では変えられない。受け付ける引数は `--restart-daemon` だけ）。
- **安全は、「承認のときに、人が、画面のコマンドが手順 1 のとおりであることを確かめること」と「script の中の sha256 の照合」に依る。**承認の画面に出るのは、実際のコマンドの文字列で、この文書の説明とは別。モデルが、この文書と違うコマンドを出しても、止められるのは、人の目と、sha256 の照合だけ。**文書どおりに動くことは、試験では保証できない**（試験は、この文書の内容と、script の動きを検査するだけ）。
- 取得は **手順 1 の script の中の `curl` だけ**（認証なし。配布物のリポジトリは public。https だけ・リダイレクトの先も https だけ）。ブラウザ・メール・AirDrop での取得は、案内しない（quarantine が付いて、daemon が動かないため。下の症状表）。`curl` で取得したファイルには、quarantine が付かない（`curl` は quarantine の属性を付けない）。macOS の版で変わりうるので、**それでも script が、取得したファイルと展開したファイルで、必ず確かめる**。
- **GitHub のトークンを、出さない・読まない・貼らせない**（取得に認証は要らない）。`gh auth token`・`gh auth status --show-token`・`GH_TOKEN` などの環境変数の設定・`Authorization` のヘッダーを使うコマンドは、実行しない。
- **quarantine を、外さない**（`xattr` の書き換え〔`-d`・`-c`・`-w`〕・`sudo`・`rm` は、実行しない）。付いていたら、script が止まる。macOS が、出所の確かでないコードを実行する前に検査する安全装置なので、黙って外さない。
- `root-token` などのトークンのファイルは、読まない・出さない。トークンの値は、チャットに貼らせない。
- **常駐（launchd）の登録は、利用者が定型文の問いに、はっきり「はい」と答えたときだけ**行う（手順 3）。承認の画面で許可されただけでは、登録しない。**`--yes`・`--restart-daemon` は、利用者が定型文の問いにチャットで「はい」と答えたあとにだけ付ける。承認ダイアログの許可だけでは付けない**。登録・止める・起動し直すのは `touryou launchd` の決まったサブコマンド（と、それを呼ぶ導入の script）だけで、`launchctl` を直接は実行しない。
- **子の認証は扱わない**（TouRyou は Anthropic の認証を扱わない。CLI の子は、親のセッションが `claude --bg` で起動する）。
- **「止まる」とは**: 次の手順に進まず、原因（出力）をそのまま利用者に伝え、定型文があれば、それを添える。
- 人が入力するパスは、引用符で囲んで使う。**改行・引用符（`"`・`'`・`` ` ``）・`$`・`;`・`\` を含むときは、止まる**。

## 手順

1. **本体の導入（script。1 コマンド）**: `env -u BASH_ENV -u ENV bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-runtime.sh"`。`${CLAUDE_PLUGIN_ROOT}` は、この文書の中で、plugin のディレクトリの絶対パスに置き換わっている（Bash の環境変数には入らないので、置き換わった文字列のまま実行する）。置き換わっていない（`${CLAUDE_PLUGIN_ROOT}` の文字のまま）ときは、止まる。**このコマンドは、タイムアウトを長め（最大 10 分）にして実行する**（約 150MB の取得を含む）。
   `env -u BASH_ENV -u ENV` は、非対話の bash が script の前に読むファイル（環境変数 `BASH_ENV`・`ENV` が指すもの）を読ませないため（script の頭では、環境から取り込まれた関数を消し、`PATH` を OS の既定にする）。承認の画面では、`env -u BASH_ENV -u ENV bash` と、plugin の中の `scripts/install-runtime.sh` だけで、引数がない（`--restart-daemon` は、下の「版が変わり、常駐しているとき」だけ）ことを確かめてもらう。
   script がすること（順に。どこで失敗しても、`current` は古いまま。理由と次にすることを出して、0 以外で終わる）: 対象の確認（`Darwin arm64`・`git`〔Xcode の Command Line Tools〕）→ plugin の中の `checksums.json`・`plugin.json` から版・名前・sha256 を読み、版の一致・`repository` の固定値・形を確かめる → 同じ版が入って動くなら、何もせずに終わる → `curl`（https だけ）で `$HOME/.touryou/work` に取得 → sha256 を `checksums.json` と照合（**通るまで、展開も実行もしない**。合わなければ、取得したものを消す）→ quarantine の確かめ → `tar -t` の検査（先頭が `touryou-darwin-arm64/` だけ・絶対パス・`..` を断る）→ 一時ディレクトリに展開し、外を指すシンボリックリンク・quarantine を断る → `$HOME/.touryou/v<版>` に移す → 新しい版の `touryou-daemon --help` が動くことを確かめる → `current` を付け替える（新しいリンクを作ってから入れ替える）。
   出力の最後の行（`RESULT: …`）で分ける。その前の `CONFIG:`・`LAUNCHD:` の行は、設定・常駐の有無（成功のときだけ出る）:
   - `RESULT: installed`（初めて）: 手順 2 へ。
   - `RESULT: already`（同じ版がすでに入っている）・`RESULT: upgraded`（版を上げた。常駐なし）・`RESULT: upgraded-restarted`（版を上げ、常駐の daemon を起動し直した）: `CONFIG: present` なら、手順 2 を飛ばす。`LAUNCHD: present` なら、手順 3 も飛ばして、下の「版を上げたあと」へ。`upgraded` で daemon を手で動かしているなら、止めてから起動し直すよう伝える。
   - `RESULT: need-restart-consent`（終了コード 3。版が変わり、常駐している）: 何も変わっていない。下の「版が変わり、常駐しているとき」の問いを出す。
   - `RESULT: failed`（終了コード 1・2）: 止まる。出力の「止めました」「次にすること」を、そのまま伝える。
   定型文: 「配布物を取得します（目安として約 150MB です。回線によっては、数分かかります）。」
   定型文（Command Line Tools がない）: 「この Mac には、git（Xcode の Command Line Tools）が入っていません。Terminal で `xcode-select --install` を実行して、インストールが終わってから、もう一度 /setup を実行してください（ダウンロードに、ネットワークと時間が要ります。Xcode だけを入れているときは、Xcode を一度開いて、ライセンスに同意してください）。」
   定型文（`checksums.json` がない・版が違う）: 「この plugin の版には、配布物の情報が入っていません。この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に、確かめてください。」
   定型文（取得の失敗）: 「配布物を取得できませんでした。ネットワークの接続を確かめて、もう一度 /setup を実行してください。`404` と出たときは、plugin の版の配布物が公開されていません。plugin を新しい版にしてから（`claude plugin marketplace update touryou` と `claude plugin update touryou@touryou`）、もう一度実行してください。分からなければ、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談してください。」
   定型文（照合の失敗）: 「配布物の検証に失敗しました（改ざん・取得の失敗の可能性）。インストールを止めました。この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に知らせてください。」
   定型文（quarantine）: 「配布物に、macOS の安全確認の印が付いています（ブラウザなどで取得すると付きます）。この setup を、もう一度実行して、取り直してください。それでも付くときは、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談してください。」
   定型文: 「配布物の中身が、想定と違います。インストールを止めました。この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に知らせてください。」
   定型文（成功）: 「インストールできました。次は、設定です。」
2. **設定ファイル（1 コマンド）**: **`repoRoot` は、git のリポジトリであること**（前提。git でないフォルダは使えない）。人に、daemon が作業するリポジトリ（`repoRoot`・`rootCwd`）と、作業ツリーの置き場（`worktreeRoot`）を、**ホームの下の絶対パス**で尋ねる（勝手に決めない。上の「人が入力するパス」の決まりに従う。ホームの下でなければ、下のコマンドが止まる）。一時ディレクトリ（macOS の `tmp`・`var` の下）は、リンクのため、使わない。
   **書く前に、次の定型文で、子に commit させるかを尋ねる**。「はい」なら、`<allowedCommands>` を `"git status", "git add", "git commit"` にする。「いいえ」・あいまいなら、`"git status"` にする。ほかに子に使わせたいコマンド（`pnpm test` など）を言われたら、2 語以上の形で足す（下の「子の範囲のコマンド」の決まり）。
   定型文（commit）: 「子（作業のセッション）に、自分の作業ツリーで git add・git commit をさせますか（はい／いいえ）。いいえにすると、子の範囲に git add・git commit を入れて起動したときに、子の起動が scopeNotSubset で失敗します。あとで変えるときは、config.json の rootScope を直して、daemon を起動し直します。」
   定型文: 「daemon が作業するフォルダを、教えてください（ホームの下の、フォルダの場所を、最初から最後まで書いてください）。」
   コマンド（`<repoRoot>`・`<worktreeRoot>`・`<allowedCommands>` だけを置き換える）: `R="<repoRoot>" W="<worktreeRoot>" C="$HOME/.touryou/config.json" && [ "${R#"$HOME/"}" != "$R" ] && [ "${W#"$HOME/"}" != "$W" ] && [ "$(git -C "$R" rev-parse --is-inside-work-tree)" = true ] && [ ! -e "$C" ] && mkdir -p "$HOME/.touryou/state" "$W" && chmod 700 "$HOME/.touryou/state" && (umask 077 && printf '{\n  "stateDir": "%s/.touryou/state",\n  "repoRoot": "%s",\n  "worktreeRoot": "%s",\n  "rootCwd": "%s",\n  "rootScope": { "writableLocations": ["src"], "forbiddenLocations": [".git"], "allowedCommands": [%s] }\n}\n' "$HOME" "$R" "$W" "$R" '<allowedCommands>' >"$C") && chmod 600 "$C" && echo OK`
   `OK` が出なければ、止まる（ホームの下でない・git のリポジトリでない・`config.json` がすでにある、のどれか。すでにあるときは、上書きしない。中身を直すなら、利用者が自分で直す）。
   書く中身は、必須の 5 項目（`stateDir`・`repoRoot`・`worktreeRoot`・`rootCwd`・`rootScope`。`docs/config.md` と同じ）だけで、パスは絶対パス（`$HOME` は、シェルが展開する）。`rootScope` は、子の権限の上限（根〔統合〕のセッション自身は TouRyou のフックで絞らない。根の操作は、利用者の Claude Code の許可の設定のとおり）。この例は最小で、人に確かめる（既定を、勝手に広げない）。**トークンの値は、設定ファイルに書かない**（daemon が `state` の下に作る）。
3. **起動のしかたを選ぶ**: 利用者に、次の定型文で尋ねる。答えが「常駐」なら 3-A、「手で」なら 3-B へ進む。分からなければ 3-B。
   定型文: 「daemon の起動のしかたを選んでください。(1) 常駐にする（推奨。ログインしたら自動で動きます。macOS のログイン項目に 1 項目が追加されます） (2) 手で起動する（使うたびに Terminal で起動します）」
   **3-A. 常駐にする**（コマンドは 1 つ。`"$HOME/.touryou/current/bin/touryou"` の `launchd` サブコマンド）:
   1. **同意**: 次の定型文で尋ね、**はっきり「はい」のときだけ**進む。それ以外（「いいえ」・あいまい・質問）は、登録せずに 3-B へ進む。
      定型文: 「これから、ログインしたときに daemon を自動で動かす設定（macOS の launchd。`$HOME/Library/LaunchAgents` に 1 つの plist を置きます）を入れます。システム設定のログイン項目に、1 項目が「開発元を識別できない項目」として追加されます。やめるときは /touryou:service の uninstall で外せます。入れてよいですか（はい／いいえ）」
   2. **生成と登録・起動**: `"$HOME/.touryou/current/bin/touryou" launchd init && "$HOME/.touryou/current/bin/touryou" launchd apply --yes`（**1 の「はい」のあとだけ**。`--yes` は同意を取ったことの印）。`init` は、起動スクリプトと plist を `$HOME/.touryou` の下に作る（`launchctl` は実行しない。既存と違う内容のファイルがあると、何も書かずに終了コード 1 で止まる）。`apply` は、plist を LaunchAgents に置き、daemon を読み込み、窓口の応答（未認証の whoami が 401）を待って、最後に状態を出す。終了コードが 0 なら成功。0 でなければ、出力（状態・`daemon.log` の起動スクリプトの文）をそのまま伝えて止まる。
      定型文（成功）: 「常駐にしました。macOS から「ログイン項目が追加された」という通知が出て、システム設定のログイン項目に run-daemon.sh の 1 項目が「開発元を識別できない項目」として出ます。これは正常です（署名していない起動スクリプトのため）。」
   3. **つながるのを待つ**: この会話の node は、配布物と daemon を見つけると、10 秒ほどで自動でつながる（Reconnect は要らない。plugin の中継〔`scripts/touryou-mcp-shim.sh`〕が、道具の一覧が変わったことを Claude Code に知らせる）。そのあと、利用者に `/touryou:start` を打ってもらい、接続を確かめる（この `/setup` の中で、node の道具を呼ばない）。`/start` で node の道具がまだ使えなければ、`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面〔デスクトップ版など〕なら、Claude Code を起動し直す）。以後の確認・起動し直し・止める・外すは、`/touryou:service`。
   **3-B. 手で起動する**（別の端末で行う。起動の順序は daemon → 統合セッション）:
   - `"$HOME/.touryou/current/bin/touryou-daemon" --config "$HOME/.touryou/config.json"`（窓口の URL が出る）
   - 統合セッションの MCP は、plugin の `.mcp.json` が stdio で `touryou-mcp --stdio` を起動し、`touryou-mcp` が `state` の `root-token`・`port` を自分で読む（手で起動しない・環境変数は要らない）。`TOURYOU_DAEMON_URL` は、統合セッションの環境には設定しない。
   - 続けて、**つながるのを待つ**: daemon を起動したあと、この会話の node は、配布物と daemon を見つけると、10 秒ほどで自動でつながる（Reconnect は要らない。plugin の中継〔`scripts/touryou-mcp-shim.sh`〕が、道具の一覧が変わったことを Claude Code に知らせる）。そのあと、利用者に `/touryou:start` を打ってもらい、接続を確かめる（この `/setup` の中で、node の道具を呼ばない）。`/start` で node の道具がまだ使えなければ、`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面〔デスクトップ版など〕なら、Claude Code を起動し直す）。
   定型文: 「次のコマンドを、別のターミナルで実行してください。」
   定型文（つながるのを待つ。3-A・3-B のどちらでも）: 「この会話の node は、10 秒ほどで自動でつながります。つながらなければ、/mcp で node を選んで Reconnect してください（または Claude Code を起動し直してください）。」
   デスクトップアプリ（普通のチャット・Cowork〔このコンピュータ〕）でも使うなら、続けて `/touryou:desktop` で拡張機能を入れられる、と 1 行だけ伝える（このコマンドでは入れない）。

## CLI の子と plugin の置き場

**CLI の子と plugin**: `--plugin-dir` で開いたのは、そのセッションだけ。`--plugin-dir` だけで開いた親の子（`claude --bg`）には plugin が付かず、子は `child_bind` を見つけられないまま止まり、TouRyou のフック（守り）も効かない。そこで TouRyou は、親の mcp の plugin の場所（`CLAUDE_PLUGIN_ROOT`）が確かめを通れば、子の起動の文に `--plugin-dir` を足す（marketplace から入れた plugin と重なっても 1 つにまとまる）。付けられなかったときは、受信箱に理由が出る。そのときは plugin を設定の置き場に入れる（marketplace から入れる）。daemon は、起動の報告のあと所定の時間（`cliWatch.unboundMinutes`。既定 3 分）紐付けのない子を、受信箱に 1 回だけ出す。

## 許可の一覧（任意。CLI の子を動かすとき）

CLI の子は、親のセッション（統合）が Bash で `claude` のコマンドを実行して、起動・停止・削除します（TouRyou は起動しない）。auto でないモード（ふつうのモード）では、そのたびに許可の確認が出ます。確認を減らしたいときは、**利用者が自分で**、Claude Code の settings に許可の一覧を足します。この手順では、settings のファイルを書き換えない（案内だけ。利用者に任せる）。

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

- 親（統合）のセッションで、読むだけの TouRyou の道具も確認なしにしてよい（任意）。足すのは次の 7 つだけ（plugin から入れた親の道具の名前。`whoami`・`inbox_fetch`・`tree_list`・`node_capabilities`・`decision_get`・`report_get`・`node_reclaimPreview`）:

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
    理由は、TouRyou の依頼のコマンド（`cd <作業ツリー> && claude …`・`claude stop`・`claude rm`・`claude agents --json`）だけを、毎回、目で見て通すため。減らしたいときは、下の「`permissions.allow` に足す」の 2 つだけを足す（`cd *` などの広い許可は足さない）。
  - 変数を含むコマンドは「A variable in this command can't be checked before it runs」の確認が、許可の一覧があっても出る。TouRyou の依頼のコマンドは、変数のない形にしてある。書き換えないで実行する。
  - 足したあとは、Claude Code の `/permissions` で、入ったかを確かめられる。

- 子の許可: 子は `--permission-mode dontAsk` で動き、範囲（書き込みの場所・許可のコマンド）と TouRyou の道具・作業ツリーの中の読み取りだけを確認なしで使う。範囲の外の操作は、確認を出さずに断られる。要るときは、子が受信箱で範囲の拡張（`scope_extend`）を頼む。子の許可は、利用者の settings に足さなくてよい（TouRyou が起動の文に入れる）。
- 子の範囲のコマンド（`allowedCommands`）は、2 語以上で書く（`git status`・`git add`・`git commit`・`pnpm test` など）。`git`・`node` のような 1 語だけのものや、`;`・`>`・引用符などを含むものがあると、子の起動の依頼が `invalidScope` で失敗する（前方一致で何でも通ってしまうため）。`bash`・`node`・`npx`・`npm exec`・`pnpm dlx`・`git config`・`find -exec` など任意のコードを動かせる形と、スクリプトの名前のない `pnpm run` も同じく失敗する（`pnpm run build` のように書く）。`yarn <スクリプト>` は `run` がなくてもスクリプトを動かすので、`yarn` で 2 語のコマンドを許すときは、それがスクリプトの名前でないことを確かめる。子に `git add`・`git commit` をさせたいときは、根の範囲（`rootScope`）と子の範囲の両方に入れておく（子の範囲は根の範囲の内側でないと、子の起動が `scopeNotSubset` で失敗する。子の範囲に入れないと、子は確認なしで断られる）。根の範囲を直したら、daemon を起動し直す（`config.json` は起動のときだけ読む）。
- 利用者や作業するリポジトリの settings にある許可（`permissions.allow`）は、子も受け継ぐと見ている（推測）。広い許可を置いていると、子もそれを使える。

定型文: 「CLI の子の停止と状態の確かめのたびに許可の確認が出ます。減らしたいときは、ご自分の Claude Code の settings の permissions.allow に、次の 2 つを足してください。起動（`claude --bg`）と削除（`claude rm`）は、任意の旗の起動や成果を捨てる削除も通ってしまうので、足さずに、毎回の確認で目で見ることを勧めます。」


## 版が変わり、常駐しているとき

plugin を新しい版にしたあと（セッションの始まりに「本体と plugin の版が違います」と出たときなど）は、この `/setup` を、もう一度実行する。常駐（launchd の plist がある）なら、手順 1 の script は、何も変えずに `RESULT: need-restart-consent`（終了コード 3）で終わる。そのときは、次の定型文で尋ねる。

定型文: 「常駐している daemon を、いったん止めて、新しい版に入れ替えます。入れ替えたあと、常駐の設定のまま（ログイン時に自動で動くまま）起動し直します。動いている子のセッションは止まります。よいですか（はい／いいえ）」

**はっきり「はい」のときだけ** `env -u BASH_ENV -u ENV bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-runtime.sh" --restart-daemon` を実行する（タイムアウトは最大 10 分）。それ以外（「いいえ」・あいまい・質問）は、何もせずに、版を上げずに終わる（今の版のまま動き続ける）。

script は、新しい版を置いて `--help` を確かめたあとで、今の版の `touryou launchd init`（今の生成物が、引数なしの init と同じかの確かめ。違えば、止めずに終わる）→ `touryou launchd stop` → `current` の付け替え → 新しい版の `touryou launchd apply --yes` の順に行う。新しい版の `apply` が失敗したら、`current` を前の版に戻して、前の版で `apply --yes` をやり直す。組織の名前つき（`--org`）の常駐は、起動し直さずに止まる（`docs/launchd.md` の手作業の手順で上げる）。

## 版を上げたあと

版上げの前から動いている統合セッションの `touryou-mcp --stdio` は、古い版のまま動き続ける（`current` の付け替えは、実行中のプロセスに効かない）。`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面なら、Claude Code を起動し直す）。ほかに開いている統合セッションがあれば、そちらも同じ。そのあと `/touryou:start` で、接続を確かめる。

**途中で止まったとき**: script は、`current` を付け替える前に止まったなら、何も変えていない（今の版のまま）。`launchd stop` のあとに止まったときは、出力に従う（`/touryou:service` で状態を確かめる。plist は LaunchAgents に残るので、次のログインで、`current` が指す版のまま動き出す）。

## 起動に失敗したとき

| 症状 | 原因の見立て | 直し方 |
|:--|:--|:--|
| `touryou-daemon --help` は通るが、daemon が起動して約 1 分後に終了する。標準エラーに `library load disallowed by system policy` | 配布物に quarantine が付いている（ブラウザなどで取得した） | **この setup で取り直す**（この setup を、もう一度）。それでも付くときは、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談する |
| `Killed: 9`、「開けません」 | 原因は未確認 | まず、この setup をもう一度実行する（quarantine と `--help` を確かめ直す）。変わらなければ、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談する |
| `Bad CPU type in executable` | 機種と配布物が違う（対象は arm64） | `uname -sm` が `Darwin arm64` か確かめる |
| 手順 1 で、照合に失敗する | 取得の失敗、または配布物の差し替え | script は展開せず、取得したものを消している。取り直す。それでも合わなければ、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談する |

取得した tar.gz（目安として約 150MB）は、`$HOME/.touryou/work` に残る（次の同じ版の実行で、照合して使い直す）。インストールの確認のあとは、**利用者が、自分で消してよい**（消さなくても動く。このコマンドは、`rm` を実行しない。script は、自分の一時ディレクトリと、照合に失敗した取得だけを消す）。古い版のディレクトリ（`$HOME/.touryou/v<前の版>`）も残る（戻すときのため。消すのは利用者）。
