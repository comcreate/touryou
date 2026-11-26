---
description: ビルド済みの配布物（macOS の arm64）を、plugin の中の script で、GitHub Release から取得し、sha256 を照合して、決まった場所に置く（daemon・touryou-mcp・touryou を使えるようにする）
allowed-tools: Read
---

TouRyou の配布物（Node 同梱。daemon・`touryou-mcp`・`touryou`）を、この Mac に置きます。**利用者が、自分で実行するコマンド**です。置く場所は `$HOME` の下の `.touryou` です（実際のパスは、この文書に書きません）。

最初に、利用者に伝える（定型文）: 「これから、約 3 回、コマンドの承認の確認が出ます（本体の導入・設定・常駐の登録で 1 回ずつ。常駐にしないときは 2 回。前の置き場から移すときは、導入と移行の 2 回。版を上げるときは 1〜2 回。常駐の版上げで、ほかのリポジトリ用に分けた daemon の件数を数えるときは、もう 1 回）。1 回ごとに、画面のコマンドを読んで、問題なければ「1. Yes」で承認してください。これより多く出たときは、その画面のコマンドを控えて、COMCREATE に知らせてください。」

Claude Code の auto モード（権限の自動判定）で実行しているときは、承認の確認はほとんど出ない見込み（推測）。自動判定で止められたときは、出た文面をそのまま利用者に伝え、利用者に手で許可してもらう（書き換えて実行し直さない）。**チャットでの「はい」（常駐の同意など。`--yes`・`--restart-daemon` を付ける前の定型文）は、auto モードでも必ず取る**（権限の自動判定とは別のもの）。

## 進め方の決まり

**適用範囲: 以下の決まり（承認の回数・Bash の数と形・コマンドの制約・定型文）は、`/touryou:setup` を実行している間だけのもの。** setup が終わったあと、または setup の外の会話（統合の作業・子の起動・ほかのコマンドや質問）では、これらを根拠に「Bash は何回まで」「確認は何回出る」「このコマンドは実行できない」などと案内しない。その場の決まりは、その場のコマンド・文書に従う。

- **この文書に書かれたコマンドを、書かれたとおりに実行する**。引数・取得先・書き込み先を、変えない。ほかのコマンドは、実行しない。**コマンドが失敗したら、書き換えて実行し直さずに止まり**、出力をそのまま人に伝える（書き換えが安全に見えても、文書の外の動きになる）。
- **途中で中断したときは、そのまま `/setup` を最初からやり直してよい**（導入の script は、照合が通った取得済みのファイルを使い直し、途中の展開は片付けてから置き直す）。
- このコマンドは、`Read` 以外を、事前に許可していない。**コマンドごとに、承認の確認が出る**（正常）。
- **この `/setup` の中で走らせる Bash は、手順 1・手順 2・手順 3-A の 2 の 3 つだけ**（前の置き場から移すときは、手順 1 と、手順 2 の移行の 1 コマンドの 2 つで、手順 3 は要らない。版が変わり常駐しているときは、手順 1 を引数なしで 1 回〔`RESULT: need-restart-consent`・終了コード 3〕、チャットで「はい」のあとに `--restart-daemon` つきで 1 回、の 2 回。手順 2・3 は飛ばす。同意を、終了コード 3 の前に先回りして取らない。**例外として、終了コード 3 のあと・問いの前に、読み取りだけの `"$HOME/.touryou/current/bin/touryou" launchd status --others` を 1 回だけ走らせてよい**〔ほかのリポジトリ用に分けた daemon の件数 N を、出力から数えるため。承認の確認が 1 回増える。コマンドが失敗した・数えられないときは、N を分からないものとして扱い、書き換えて実行し直さない〕）。それぞれを、**書かれた 1 行のまま、1 回の Bash で**走らせる（`&&` の前後を別の Bash に分けない・つなぎ足さない）。承認の確認の回数は、Bash の数と同じにする。
- **確かめのための別のコマンドは、走らせない**。`ls`・`cat`・`test`・`stat`・`readlink`・`which`・`git -C … rev-parse`・`launchctl`・`uname`・`echo` などで、置き場・パス・リポジトリ・常駐を前もって・あとから確かめない。確かめは、**script とコマンドの出力（`RESULT:`・`CONFIG:`・`LEGACY_CONFIG:`・`LAUNCHD:`・`SUPERVISOR:`・`OK`・`supervisor apply` の状態の表示）と、`Read`**（事前に許可されていて、確認が出ない）で行う。ただし、`root-token` などのトークンのファイルは、Read でも読まない（下の決まり）。出力が長くて切れたときも、読み直すためのコマンドは走らせない（出力の最後の行で分ける）。
- 手順 2 のパス（ホームの下か・git のリポジトリか・`.touryou/` が ignore 済みか・`config.json` がないか）は、手順 2 のコマンドの中で確かめる。**前もって別のコマンドで確かめない**（`OK` が出なければ止まる）。
- **この `/setup` の中で、node の道具（`whoami`・`tree_list` など）・`/touryou:service`・`/touryou:start` の中身を、代わりに実行しない**（それぞれに承認の確認が出る）。接続の確かめは、最後に、利用者に `/touryou:start` を打ってもらう。
- **本体の取得・照合・展開・付け替えは、plugin の中の 1 本の script（`scripts/install-runtime.sh`）が行う**。script は、plugin の zip の一部で、Claude Code が、marketplace の sha256 で zip ごと確かめてから置いたもの。取得元・版・sha256 は、script が plugin の中の `checksums.json`・`plugin.json` から読む（引数・環境変数では変えられない。受け付ける引数は `--restart-daemon` だけ）。
- **安全は、「承認のときに、人が、画面のコマンドが手順 1 のとおりであることを確かめること」と「script の中の sha256 の照合」に依る。**承認の画面に出るのは、実際のコマンドの文字列で、この文書の説明とは別。モデルが、この文書と違うコマンドを出しても、止められるのは、人の目と、sha256 の照合だけ。**文書どおりに動くことは、試験では保証できない**（試験は、この文書の内容と、script の動きを検査するだけ）。
- 取得は **手順 1 の script の中の `curl` だけ**（認証なし。配布物のリポジトリは public。https だけ・リダイレクトの先も https だけ）。ブラウザ・メール・AirDrop での取得は、案内しない（quarantine が付いて、daemon が動かないため。下の症状表）。`curl` で取得したファイルには、quarantine が付かない（`curl` は quarantine の属性を付けない）。macOS の版で変わりうるので、**それでも script が、取得したファイルと展開したファイルで、必ず確かめる**。
- **GitHub のトークンを、出さない・読まない・貼らせない**（取得に認証は要らない）。`gh auth token`・`gh auth status --show-token`・`GH_TOKEN` などの環境変数の設定・`Authorization` のヘッダーを使うコマンドは、実行しない。
- **quarantine を、外さない**（`xattr` の書き換え〔`-d`・`-c`・`-w`〕・`sudo`・`rm` は、実行しない）。付いていたら、script が止まる。macOS が、出所の確かでないコードを実行する前に検査する安全装置なので、黙って外さない。
- `root-token` などのトークンのファイルは、読まない・出さない。トークンの値は、チャットに貼らせない。
- **常駐（launchd）の登録は、利用者が定型文の問いに、はっきり「はい」と答えたときだけ**行う（手順 3）。承認の画面で許可されただけでは、登録しない。**`--yes`・`--restart-daemon` は、利用者が定型文の問いにチャットで「はい」と答えたあとにだけ付ける。承認ダイアログの許可だけでは付けない**。登録・止める・起動し直すのは `touryou supervisor`・`touryou migrate`・`touryou launchd` の決まったサブコマンド（と、それを呼ぶ導入の script）だけで、`launchctl` を直接は実行しない。
- **子の認証は扱わない**（TouRyou は Anthropic の認証を扱わない。CLI の子は、親のセッションが `claude --bg` で起動する）。
- **「止まる」とは**: 次の手順に進まず、原因（出力）をそのまま利用者に伝え、定型文があれば、それを添える。
- 人が入力するパスは、引用符で囲んで使う。**改行・引用符（`"`・`'`・`` ` ``）・`$`・`;`・`\` を含むときは、止まる**。

## 手順

1. **本体の導入（script。1 コマンド）**: `env -u BASH_ENV -u ENV bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-runtime.sh"`。`${CLAUDE_PLUGIN_ROOT}` は、この文書の中で、plugin のディレクトリの絶対パスに置き換わっている（Bash の環境変数には入らないので、置き換わった文字列のまま実行する）。置き換わっていない（`${CLAUDE_PLUGIN_ROOT}` の文字のまま）ときは、止まる。**このコマンドは、タイムアウトを長め（最大 10 分）にして実行する**（初めて・版が変わったときは、約 41MB の取得〔展開後は約 130MB〕を含む）。
   `env -u BASH_ENV -u ENV` は、非対話の bash が script の前に読むファイル（環境変数 `BASH_ENV`・`ENV` が指すもの）を読ませないため（script の頭では、環境から取り込まれた関数を消し、`PATH` を OS の既定にする）。承認の画面では、`env -u BASH_ENV -u ENV bash` と、plugin の中の `scripts/install-runtime.sh` だけで、引数がない（`--restart-daemon` は、下の「版が変わり、常駐しているとき」だけ）ことを確かめてもらう。
   script がすること（順に。どこで失敗しても、`current` は古いまま。理由と次にすることを出して、0 以外で終わる）: 対象の確認（`Darwin arm64`・`git`〔Xcode の Command Line Tools〕）→ plugin の中の `checksums.json`・`plugin.json` から版・名前・sha256 を読み、版の一致・`repository` の固定値・形を確かめる → 同じ版が入って動くなら、何もせずに終わる → plugin の版が、いまの本体より古ければ、何も変えずに止まる（古い版に入れ替えない。常駐の有無で変えない。版の大小が比べられない形は、止めずに先へ進む）→ `curl`（https だけ）で `$HOME/.touryou/work` に取得 → sha256 を `checksums.json` と照合（**通るまで、展開も実行もしない**。合わなければ、取得したものを消す）→ quarantine の確かめ → `tar -t` の検査（先頭が `touryou-darwin-arm64/` だけ・絶対パス・`..` を断る）→ 一時ディレクトリに展開し、外を指すシンボリックリンク・quarantine を断る → `$HOME/.touryou/v<版>` に移す → 新しい版の `touryou-daemon --help` が動くことを確かめる → `current` を付け替える（新しいリンクを作ってから入れ替える）。
   出力の最後の行（`RESULT: …`）で分ける。その前の `CONFIG:`・`LEGACY_CONFIG:`・`LAUNCHD:`・`SUPERVISOR:` の行は、設定・常駐の有無（成功のときだけ出る。`CONFIG:` は、実行した場所から上へ探した `<repoRoot>/.touryou/config.json` の有無。`LEGACY_CONFIG:` は、前の置き場 `$HOME/.touryou/config.json` が、移行されずに残っているか（移行済みの印 `legacy-migrated.json` があれば `absent`）。`SUPERVISOR:` は、supervisor の plist の有無。`LAUNCHD:` は、前の置き場の常駐〔`touryou.daemon`〕の有無。ほかのリポジトリ用に分けた daemon（2 つ目以降）があるときだけ、`LAUNCHD_OTHERS: present` も出る）:
   - `RESULT: installed`（初めて）: 手順 2 へ。
   - `RESULT: already`（同じ版がすでに入っている）・`RESULT: upgraded`（版を上げた。常駐なし）・`RESULT: upgraded-restarted`（版を上げ、常駐の daemon を起動し直した）: `CONFIG: present` なら、手順 2 を飛ばす（`CONFIG: absent` で `LEGACY_CONFIG: present` なら、手順 2 の移行へ）。`SUPERVISOR: present`（または前の置き場の常駐の `LAUNCHD: present`）で、`CONFIG: present` なら、手順 3 も飛ばして、下の「版を上げたあと」へ。**`LAUNCHD: absent` でも `LAUNCHD_OTHERS: present`（ほかのリポジトリ用に分けた daemon だけが常駐している）なら、手順 3 も飛ばす**（手順 3 は 2 つ目の既定の daemon を作ってしまう）。分けた daemon の確認・起動し直し・止める・外すは `/touryou:service` と伝え、下の「版を上げたあと」へ。`upgraded` で daemon を手で動かしているなら、止めてから起動し直すよう伝える。
   - `RESULT: need-restart-consent`（終了コード 3。版が変わり、常駐している）: 何も変わっていない。下の「版が変わり、常駐しているとき」の問いを出す。
   - `RESULT: plugin-older`（終了コード 4。plugin が、いまの本体より古い）: 何も変わっていない。本体を古い版に入れ替えず、手順 2 以降にも進まず、止まる。下の定型文（plugin が古い）を伝える。常駐しているときも同じで、同意は聞かない。
   - `RESULT: failed`（終了コード 1・2）: 止まる。出力の「止めました」「次にすること」を、そのまま伝える。
   定型文（script を実行する前）: 「導入の script を実行します。初めてのときと、版が変わったときは、配布物を取得します（目安として約 41MB です。回線によっては、数分かかります）。同じ版がすでに入っているときは、取得しません。」実際に取得したか（取得した・取得済みのものを使い直した・何もしなかった）は、script の出力の行が知らせるので、終わったあとに、この定型文を繰り返さない（取得の大きさ・時間を、もう一度言わない）。
   定型文（Command Line Tools がない）: 「この Mac には、git（Xcode の Command Line Tools）が入っていません。Terminal で `xcode-select --install` を実行して、インストールが終わってから、もう一度 /setup を実行してください（ダウンロードに、ネットワークと時間が要ります。Xcode だけを入れているときは、Xcode を一度開いて、ライセンスに同意してください）。」
   定型文（`checksums.json` がない・版が違う）: 「この plugin の版には、配布物の情報が入っていません。この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に、確かめてください。」
   定型文（取得の失敗）: 「配布物を取得できませんでした。ネットワークの接続を確かめて、もう一度 /setup を実行してください。`404` と出たときは、plugin の版の配布物が公開されていません。plugin を新しい版にしてから（`claude plugin marketplace update touryou` と `claude plugin update touryou@touryou --scope user`）、Claude Code を開き直してから、もう一度実行してください。分からなければ、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談してください。」
   定型文（plugin が古い）: 「plugin（v<plugin の版>）が、いまの本体（v<本体の版>）より古いので、本体を古い版に入れ替えずに止めました（何も変えていません）。先に plugin を新しくしてください。`claude plugin marketplace update touryou` のあと、`claude plugin update touryou@touryou --scope user` を実行し、Claude Code を開き直してから、もう一度 /setup を実行してください。`--scope user` を付け忘れて clone の中で update すると、その clone の中だけが新しくなり、自分のアカウント全体の plugin は古いままです。本体を古い版へ戻すことには対応していません。」
   定型文（照合の失敗）: 「配布物の検証に失敗しました（改ざん・取得の失敗の可能性）。インストールを止めました。この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に知らせてください。」
   定型文（quarantine）: 「配布物に、macOS の安全確認の印が付いています（ブラウザなどで取得すると付きます）。この setup を、もう一度実行して、取り直してください。それでも付くときは、この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に相談してください。」
   定型文: 「配布物の中身が、想定と違います。インストールを止めました。この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）に知らせてください。」
   定型文（成功）: 「インストールできました。次は、設定です。」
2. **設定ファイル（1 コマンド）**: **`CONFIG: absent` で `LEGACY_CONFIG: present`（前の置き場 `$HOME/.touryou/config.json` がある）ときは、設定を新しく書かず、この手順の最後の「移行」を行う**（手順 3 は要らない）。前の置き場がない（`LEGACY_CONFIG: absent`）ときは、次のとおり、新しく書く。設定・state・作業ツリー・ログの置き場は、リポジトリの `<repoRoot>/.touryou/`（`config.json`・`state/`・`worktrees/`・`logs/`）。**`.touryou/` は、`<repoRoot>/.gitignore` に入れる**（daemon が、設定の検査で、ignore 済みかを確かめる。TouRyou は `.gitignore` を書き換えない）。
   **`repoRoot` は、git のリポジトリであること**（前提。git でないフォルダは使えない）。人に、daemon が作業するリポジトリ（`repoRoot`・`rootCwd`）を、**ホームの下の絶対パス**で尋ねる（勝手に決めない。上の「人が入力するパス」の決まりに従う。ホームの下でなければ、下のコマンドが止まる）。**作業ツリーの置き場（`worktreeRoot`）の推奨は `<repoRoot>/.touryou/worktrees`**（`.touryou/` の ignore に入るので、`.gitignore` の追加が 1 行で済む。リポジトリごとに分かれ、ほかのリポジトリの作業ツリーと混ざらない）。別の場所にしたいと言われたら、そのとおりにしてよい（ホームの下の絶対パス。`repoRoot` の中に置くなら、そこも ignore に入れる）。一時ディレクトリ（macOS の `tmp`・`var` の下）は、リンクのため、使わない。
   **先に、`Read` で `<repoRoot>/.gitignore` を読み**、`.touryou/` の行がなければ、次の定型文で、利用者に足してもらう（自分では書き換えない。足してもらってから、手順 2 のコマンドを走らせる）。
   定型文（.gitignore）: 「`<repoRoot>/.gitignore` に、`.touryou/` を 1 行足して、**コミットしてください**（設定・state・作業ツリー・ログを置くフォルダです。足しただけでコミットしないと、`<repoRoot>` の作業ツリーに未保存の変更が残り、最初の統合（`node_integrate`）が `targetDirty` で止まります。ファイルを変えたくないときは、コミットの代わりに `<repoRoot>/.git/info/exclude` に足しても、daemon の検査は通ります。足して、コミットしてから、続けます）。」
   なお、コミットは利用者が行う（自分では `git add`・`git commit` を実行しない。この `/setup` の Bash は、下の決まりの数だけ）。すでに `.touryou/` の行が入っていて、未保存の変更がなければ、何も頼まない。
   **書く前に、次の定型文で、子に commit させるかを尋ねる**。「はい」なら、`<allowedCommands>` を `"git status", "git add", "git commit"` にする。「いいえ」・あいまいなら、`"git status"` にする。ほかに子に使わせたいコマンド（`pnpm test` など）を言われたら、2 語以上の形で足す（下の「子の範囲のコマンド」の決まり）。
   定型文（commit）: 「子（作業のセッション）に、自分の作業ツリーで git add・git commit をさせますか（はい／いいえ）。いいえにすると、子の範囲に git add・git commit を入れて起動したときに、子の起動が scopeNotSubset で失敗します。あとで変えるときは、config.json の rootScope を直して、daemon を起動し直します。」
   定型文: 「daemon が作業するリポジトリを、教えてください（ホームの下の、フォルダの場所を、最初から最後まで書いてください）。作業ツリーの置き場は、推奨の `<repoRoot>/.touryou/worktrees` でよいですか（よければ、そのままにします。別の場所にするなら、場所を書いてください）。」
   コマンド（`<repoRoot>`・`<worktreeRoot>`・`<allowedCommands>` だけを置き換える）: `R="<repoRoot>" W="<worktreeRoot>" C="$R/.touryou/config.json" && [ "${R#"$HOME/"}" != "$R" ] && [ "${W#"$HOME/"}" != "$W" ] && [ "$(git -C "$R" rev-parse --is-inside-work-tree)" = true ] && git -C "$R" check-ignore -q --no-index .touryou/config.json && [ ! -e "$C" ] && mkdir -p "$R/.touryou/state" "$W" && chmod 700 "$R/.touryou" "$R/.touryou/state" && (umask 077 && printf '{\n  "stateDir": "%s/.touryou/state",\n  "repoRoot": "%s",\n  "worktreeRoot": "%s",\n  "rootCwd": "%s",\n  "rootScope": { "writableLocations": ["src"], "forbiddenLocations": [".git", ".touryou"], "allowedCommands": [%s] }\n}\n' "$R" "$R" "$W" "$R" '<allowedCommands>' >"$C") && chmod 600 "$C" && echo OK`
   `OK` が出なければ、止まる（ホームの下でない・git のリポジトリでない・`.touryou/` が `.gitignore` に入っていない・`config.json` がすでにある、のどれか。すでにあるときは、上書きしない。中身を直すなら、利用者が自分で直す）。出力をそのまま伝え、ホームの下でない・git のリポジトリでないときに、利用者がパスを言い直したら、**手順 2 のコマンドを、置き換える値だけ変えて、もう 1 回走らせてよい**（確認が 1 回増える。`/setup` を最初からやり直さない・パスを別のコマンドで確かめない）。`.gitignore` に入っていないときは、上の定型文（.gitignore）を伝え、足してもらってから、同じコマンドをもう 1 回走らせてよい。`config.json` がすでにあるときは、やり直さない。
   書く中身は、必須の 5 項目（`stateDir`・`repoRoot`・`worktreeRoot`・`rootCwd`・`rootScope`。`docs/config.md` と同じ）だけで、パスは絶対パス（`$HOME` は、シェルが展開する）。`rootScope` は、子の権限の上限（根〔統合〕のセッション自身は TouRyou のフックで絞らない。根の操作は、利用者の Claude Code の許可の設定のとおり）。この例は最小で、人に確かめる（既定を、勝手に広げない）。**トークンの値は、設定ファイルに書かない**（daemon が `state` の下に作る）。
   **移行（`CONFIG: absent` かつ `LEGACY_CONFIG: present` のとき。1 コマンド）**: 前の置き場（`$HOME/.touryou/config.json`・`$HOME/.touryou/state`・常駐 `touryou.daemon`）を、リポジトリの `<repoRoot>/.touryou/` に移す。「コピー → 検査 → 切り替え」で、**元は消さない**（途中で失敗したら、作ったものだけを消し、止めた前の常駐を起動し直して、元のまま動く状態に戻す）。コピー・検査・登録・supervisor の入れ替え・前の常駐の取り外しは、すべて `touryou migrate` の中で行う（文書の手順で組み立てない。手順 3 は要らない）。
   1. **前もって**、`Read` で前の設定（`$HOME/.touryou/config.json`。トークンは入っていない）を読み、`repoRoot` を確かめる。移すのは、**前の設定が指すリポジトリ 1 つだけ**（ほかのリポジトリは、そのリポジトリで `/setup` をやり直す）。続けて `Read` で `<repoRoot>/.gitignore` を読み、`.touryou/` の行がなければ、上の定型文（.gitignore）で足してもらってから進む。
   2. **同意**: 次の定型文で尋ね、**はっきり「はい」のときだけ**進む。それ以外（「いいえ」・あいまい・質問）は、何も変えず、移行せずに終わる（前の置き場のまま動き続ける。新しく書くなら、前の置き場を残したまま手順 2 の新規の設定に進んでよいが、前の常駐と別の daemon になる、と伝える）。
      定型文（移行）: 「前の置き場（`$HOME/.touryou` の設定・state・常駐）を、リポジトリの `.touryou/`（`<repoRoot>/.touryou/`）に移します。前の daemon をいったん止め、state をコピーし、新しい設定を検査し、通ったら supervisor（ログイン項目の `TouRyou` の 1 項目）で動かして、前の常駐を外します。元の設定と state は消しません（動作を確かめてから、ご自分で消してください）。途中で失敗したら、作ったものを消して、前の daemon を起動し直します。動いている子のセッションは止まりません（daemon が戻るまでの間は、子の道具が届かないことがあります）。worktreeRoot は、いまの値のままです。よいですか（はい／いいえ）」
   3. **実行**（**2 の「はい」のあとだけ**。`--yes` は同意を取ったことの印）: `"$HOME/.touryou/current/bin/touryou" migrate --yes`。終了コード 0 なら成功（出力の「前の置き場の設定と state は、消していない」の行まで、そのまま伝える）。0 でなければ、出力（戻したもの・戻せなかったもの）をそのまま伝えて止まる（書き換えて実行し直さない。「検査を通らない」のときは、出力の直し方〔`.gitignore` への `.touryou/` の追記など〕を伝え、直してもらってから、もう 1 回走らせてよい）。**終了コード 1 で、出力に「後始末が残っている」とあるとき**は、新しい daemon は動いている。前の常駐を外す手順（出力にある `launchd uninstall --yes`）だけを伝える。
      定型文（成功）: 「移行できました。前の置き場の設定と state は、消していません。動作を確かめてから、ご自分で消してください。以後の確認・起動し直し・止める・外すは `/touryou:service`（常駐の項目は supervisor の 1 つです）。」
   4. このあと、手順 3 の「つながるのを待つ」（3-A の 3）に進む。
3. **起動のしかたを選ぶ**（移行したときは要らない。上の「移行」の 4 へ）: 利用者に、次の定型文で尋ねる。答えが「常駐」なら 3-A、「手で」なら 3-B へ進む。分からなければ 3-B。
   定型文: 「daemon の起動のしかたを選んでください。(1) 常駐にする（推奨。ログインしたら自動で動きます。macOS のログイン項目に 1 項目が追加されます） (2) 手で起動する（使うたびに Terminal で起動します）」
   **3-A. 常駐にする**（コマンドは 1 つ。`"$HOME/.touryou/current/bin/touryou"` の `supervisor` サブコマンド。常駐の項目は supervisor の 1 つで、daemon は、登録簿〔`$HOME/.touryou/registry.json`〕の設定ごとに、supervisor が起こして見張る）:
   1. **同意**: 次の定型文で尋ね、**はっきり「はい」のときだけ**進む。それ以外（「いいえ」・あいまい・質問）は、登録せずに 3-B へ進む。
      定型文: 「これから、ログインしたときに daemon を自動で動かす設定（macOS の launchd。`$HOME/Library/LaunchAgents` に 1 つの plist を置きます。daemon は、このリポジトリの設定を登録簿に足して、supervisor が起こします）を入れます。システム設定のログイン項目に、**TouRyou**（1 項目）が追加されます。「開発元を識別できない項目」と出るのは、TouRyou に同梱した node を TouRyou の名前で手元の署名（ad-hoc）にしたためで、正常です。やめるときは /touryou:service の uninstall で外せます（動いている daemon は止まりません）。入れてよいですか（はい／いいえ）」
   2. **生成と登録・起動**: `"$HOME/.touryou/current/bin/touryou" supervisor register --config "<repoRoot>/.touryou/config.json" && "$HOME/.touryou/current/bin/touryou" supervisor init && "$HOME/.touryou/current/bin/touryou" supervisor apply --yes`（`<repoRoot>` だけを置き換える。**1 の「はい」のあとだけ**。`--yes` は同意を取ったことの印）。`register` は、設定を daemon と同じ検査（`repoRoot`・`rootCwd`・`worktreeRoot` が今ある実パスか・`repoRoot` が git のリポジトリか・`.touryou/` が ignore 済みか）にかけ、通ったものだけを登録簿に足す。`init` は、supervisor の plist を `$HOME/.touryou` の下に作る（同じ内容なら何もしない。既存と違う内容のファイルがあると、何も書かずに終了コード 1 で止まる）。`apply` は、plist を LaunchAgents に置き、supervisor を読み込み、最後に状態を出す（`launchctl` は実行しない）。すでに supervisor が読み込まれていれば、そのまま（登録簿に足した設定は、次の周〔30 秒以内〕で daemon が起こされる）。検査が通らなければ、何もせずに終了コード 1 で止まる（理由・直し方が出る。値は伏せてある）。そのときは、その文と直し方をそのまま伝え、設定を直すか、この `/setup` の手順 2 をやり直すよう案内して止まる（自分で `config.json` を書き換えない）。終了コードが 0 なら成功。0 でなければ、出力（状態・最後の失敗の行）をそのまま伝えて止まる。
      定型文（成功）: 「常駐にしました。macOS から「ログイン項目が追加された」という通知が出て、システム設定の「一般」→「ログイン項目と機能拡張」→「バックグラウンドでの実行を許可」に、**TouRyou**（1 項目）が出ます。「開発元を識別できない項目」と出るのは、TouRyou に同梱した node を TouRyou の名前で手元の署名（ad-hoc）にしたためで、正常です。前の版から上げた場合、前の版の項目（v0.1.0 の run-daemon.sh、v0.1.1 の Node.js Foundation）は消えて、TouRyou の 1 項目になります。sh・bash の項目は TouRyou の項目ではありません。」
   3. **つながるのを待つ**: この会話の node は、配布物と daemon を見つけると、10 秒ほどで自動でつながる（Reconnect は要らない。plugin の中継〔`scripts/touryou-mcp-shim.sh`〕が、道具の一覧が変わったことを Claude Code に知らせる）。そのあと、利用者に `/touryou:start` を打ってもらい、接続を確かめる（この `/setup` の中で、node の道具を呼ばない）。`/start` で node の道具がまだ使えなければ、`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面〔デスクトップ版など〕なら、Claude Code を起動し直す）。以後の確認・起動し直し・止める・外すは、`/touryou:service`。
   **3-B. 手で起動する**（別の端末で行う。起動の順序は daemon → 統合セッション）:
   - `"$HOME/.touryou/current/bin/touryou-daemon" --config "<repoRoot>/.touryou/config.json"`（窓口の URL が出る。`<repoRoot>` を置き換える）
   - 統合セッションの MCP は、plugin の `.mcp.json` が stdio で `touryou-mcp --stdio` を起動し、`touryou-mcp` が `state` の `root-token`・`port` を自分で読む（手で起動しない・環境変数は要らない）。`TOURYOU_DAEMON_URL` は、統合セッションの環境には設定しない。
   - 続けて、**つながるのを待つ**: daemon を起動したあと、この会話の node は、配布物と daemon を見つけると、10 秒ほどで自動でつながる（Reconnect は要らない。plugin の中継〔`scripts/touryou-mcp-shim.sh`〕が、道具の一覧が変わったことを Claude Code に知らせる）。そのあと、利用者に `/touryou:start` を打ってもらい、接続を確かめる（この `/setup` の中で、node の道具を呼ばない）。`/start` で node の道具がまだ使えなければ、`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面〔デスクトップ版など〕なら、Claude Code を起動し直す）。
   定型文: 「次のコマンドを、別のターミナルで実行してください。」
   定型文（つながるのを待つ。3-A・3-B のどちらでも）: 「この会話の node は、10 秒ほどで自動でつながります。つながらなければ、/mcp で node を選んで Reconnect してください（または Claude Code を起動し直してください）。」
   デスクトップアプリ（普通のチャット・Cowork〔このコンピュータ〕）でも使うなら、続けて `/touryou:desktop` で拡張機能を入れられる、と 1 行だけ伝える（このコマンドでは入れない）。
   **別のリポジトリでも使うとき**: そのリポジトリを開いて `/setup` をもう一度実行する（手順 2 でそのリポジトリの `<repoRoot>/.touryou/` に設定を作り、手順 3-A で登録簿に足す。supervisor は 1 つのまま）。前の置き場から移すのは、前の設定が指す 1 つのリポジトリだけ。
   **ほかのリポジトリ用に分けた daemon（前の版の `launchd init --config` で作った別名のもの。#165）**: 新しくは作らない（上の supervisor の登録を使う）。すでにあるものは、そのまま動く（移行の対象にはならない。`touryou migrate` は触れない）。利用者が、別のリポジトリ用に daemon を分けたいと言ったときだけ、案内する（**この `/setup` の中では実行しない**。上の Bash の数を増やさない。設定ファイル・`stateDir`・ポートは、1 つ目と別にする）。手順: ① 2 つ目の設定ファイル（`<設定>`。絶対パスで、1 つ目と別の `stateDir`・`repoRoot`・`worktreeRoot`）を、利用者が `docs/config.md` のとおり作る（自分で書き換えない）。② 常駐にするなら、同意を取ってから、`"$HOME/.touryou/current/bin/touryou" launchd init --config <設定> && "$HOME/.touryou/current/bin/touryou" launchd apply --yes --config <設定>`（Label は `touryou.daemon-<8 文字>`。1 つ目の常駐は、そのまま）。手で起動するなら、`"$HOME/.touryou/current/bin/touryou-daemon" --config <設定>`。③ その daemon につなぐ統合セッションは、起動する端末で `export TOURYOU_DAEMON_CONFIG=<設定>` してから `claude` を起動する。または、設定ごとの MCP（`touryou-<名前>`。`--config` 固定。#224）を登録する: ②の `init --config <設定>`（`--name <名前>` を付けてもよい）の出力の「【MCP を登録する】」の `claude mcp add …` を、利用者に実行してもらう（自分では実行しない）。つながった daemon は、統合セッションの `whoami` の `daemon.repoRoot`・`daemonId` で確かめる。以後の確認・起動し直し・止める・外すは、`/touryou:service`（対象を `--config <設定>` で選ぶ）。詳しくは `docs/launchd.md` の「複数の daemon」。

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
  - 起動のコマンドは `(cd <作業ツリー> && claude --bg … [--plugin-dir <plugin の場所>] --permission-mode dontAsk --settings …)` の形（全体を `( )` で囲むので、統合のシェルの場所は変わらない）（`--plugin-dir` は、親の plugin の場所が確かめを通ったときだけ。子に plugin が付かなかったときは受信箱に出る）。`cd` の部分で確認が出るかは、Claude Code の版によって違うことがある。
  - **Bash の確認の画面では、いちばん上の「1. Yes」だけを選ぶ**。次のものは選ばない:
    - 「Yes, and don't ask again for: cd *」: 以後、`cd` で始まれば `&&` のあとに何がつながっても確認なしで通ってしまう（起動・停止・削除以外の任意のコマンドも通る）。
    - 「Yes, and switch to auto mode」: 以後の操作がすべて確認なしになる。
    - 「Yes, allow reading from … from this project」: 範囲外の読み取りまで黙って許してしまう。
    理由は、TouRyou の依頼のコマンド（`(cd <作業ツリー> && claude …)`・`claude stop`・`claude rm`・`claude agents --json`）だけを、毎回、目で見て通すため。減らしたいときは、下の「`permissions.allow` に足す」の 2 つだけを足す（`cd *` などの広い許可は足さない）。
  - 変数を含むコマンドは「A variable in this command can't be checked before it runs」の確認が、許可の一覧があっても出る。TouRyou の依頼のコマンドは、変数のない形にしてある。書き換えないで実行する。
  - 足したあとは、Claude Code の `/permissions` で、入ったかを確かめられる。

- 子の許可: 子は `--permission-mode dontAsk` で動き、範囲（書き込みの場所・許可のコマンド）と TouRyou の道具・作業ツリーの中の読み取りだけを確認なしで使う。範囲の外の操作は、確認を出さずに断られる。要るときは、子が受信箱で範囲の拡張（`scope_extend`）を頼む。子の許可は、利用者の settings に足さなくてよい（TouRyou が起動の文に入れる）。
- 子の範囲のコマンド（`allowedCommands`）は、2 語以上で書く（`git status`・`git add`・`git commit`・`pnpm test` など）。`git`・`node` のような 1 語だけのものや、`;`・`>`・引用符などを含むものがあると、子の起動の依頼が `invalidScope` で失敗する（前方一致で何でも通ってしまうため）。`bash`・`node`・`npx`・`npm exec`・`pnpm dlx`・`git config`・`find -exec` など任意のコードを動かせる形と、スクリプトの名前のない `pnpm run` も同じく失敗する（`pnpm run build` のように書く）。`yarn <スクリプト>` は `run` がなくてもスクリプトを動かすので、`yarn` で 2 語のコマンドを許すときは、それがスクリプトの名前でないことを確かめる。子に `git add`・`git commit` をさせたいときは、根の範囲（`rootScope`）と子の範囲の両方に入れておく（子の範囲は根の範囲の内側でないと、子の起動が `scopeNotSubset` で失敗する。子の範囲に入れないと、子は確認なしで断られる）。根の範囲を直したら、daemon を起動し直す（`config.json` は起動のときだけ読む）。
- 利用者や作業するリポジトリの settings にある許可（`permissions.allow`）は、子も受け継ぐと見ている（推測）。広い許可を置いていると、子もそれを使える。

定型文: 「CLI の子の停止と状態の確かめのたびに許可の確認が出ます。減らしたいときは、ご自分の Claude Code の settings の permissions.allow に、次の 2 つを足してください。起動（`claude --bg`）と削除（`claude rm`）は、任意の旗の起動や成果を捨てる削除も通ってしまうので、足さずに、毎回の確認で目で見ることを勧めます。」


## 版が変わり、常駐しているとき

plugin を新しい版にしたあと（`claude plugin marketplace update touryou` のあと `claude plugin update touryou@touryou --scope user`。セッションの始まりに「本体と plugin の版が違います」と出たときなど）は、この `/setup` を、もう一度実行する。plugin のほうが本体より古いとき（`RESULT: plugin-older`）は、常駐していても、この問いを出さずに、手順 1 の定型文（plugin が古い）を伝えて止まる。常駐（launchd の plist がある）なら、手順 1 の script は、何も変えずに `RESULT: need-restart-consent`（終了コード 3）で終わる。そのときは、次の定型文で尋ねる。

定型文: 「常駐している daemon を、いったん止めて、新しい版に入れ替えます。常駐は、macOS のログイン項目の **TouRyou**（supervisor の 1 項目）が見張っていて、入れ替えのあと、この項目の設定のまま（ログイン時に自動で動くまま）、新しい版で daemon を起動し直します（ログイン項目が増えることはありません）。{N が 1 以上のときだけ: ほかのリポジトリ用に分けた daemon（N 件）も起動し直します。}動いている子のセッションは止まりません（daemon が戻るまでの間は、子の道具が{N が 1 以上のときだけ: 数十秒}届かないことがあります）。よいですか（はい／いいえ）」（`{…}` は文面に出さない。N は、終了コード 3 のあとに `launchd status --others` の出力から数えた、ほかのリポジトリ用に分けた daemon の件数。0 のときは、その部分を省く。数えられなかったときは、{N が 1 以上のときだけ…} の代わりに「ほかのリポジトリ用に分けた daemon があれば、それも起動し直します。」と「数十秒」を入れる）

**はっきり「はい」のときだけ** `env -u BASH_ENV -u ENV bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-runtime.sh" --restart-daemon` を実行する（タイムアウトは最大 10 分）。この実行の前に、手順 1 の定型文（script を実行する前）を、もう一度言う（1 回目の実行は、取得の前に終わっているため。取得するか・取得済みのものを使い直すかは、この 2 回目で決まる）。それ以外（「いいえ」・あいまい・質問）は、何もせずに、版を上げずに終わる（今の版のまま動き続ける）。

**supervisor（`SUPERVISOR: present`。0.1.7 の常駐）のときは、次の順に行う**: 新しい版を置いて `--help` を確かめ、登録簿（`$HOME/.touryou/registry.json`）の設定を新しい版の daemon で検査する（通らなければ、何も止めずに終わる）→ 今の版の `touryou supervisor stop`（起こした daemon は止まらない）→ `current` の付け替え → 新しい版の `touryou supervisor apply --yes` → 新しい版の `touryou supervisor restart --all`（動いている daemon に終了を送る。新しい supervisor が、30 秒以内に新しい版で起こし直す）。新しい版の `apply` が失敗したら、新しい版の `supervisor stop` で止め、`current` を前の版に戻して、前の版で `supervisor apply --yes` をやり直す。`restart --all` が失敗するのは、supervisor が起こした記録のない daemon（手で起こしたもの）があるときで、版上げは成功のまま、警告を出す（その daemon は、端末で止めてから、supervisor に起こさせる）。

supervisor ではなく、前の置き場の常駐（`LAUNCHD: present`）のときは、script は、新しい版を置いて `--help` を確かめたあとで、今の版の `touryou launchd init`（今の生成物が、引数なしの init と同じかの確かめ。違えば、止めずに終わる）→ `touryou launchd stop` → `current` の付け替え → 新しい版の `touryou launchd apply --yes` の順に行う。新しい版の `apply` が失敗したら、`current` を前の版に戻して、前の版で `apply --yes` をやり直す。**ほかのリポジトリ用に分けた daemon（`touryou launchd init --config` で作ったもの。出力に `LAUNCHD_OTHERS: present`）があるときは、登録されたすべてを、同じ順で止めて（`launchd stop --others`）・起動し直す（`launchd apply --yes --others`）**（1 つでも起動しなければ、`current` を前の版に戻す）。同意の問い（上の定型文）は、1 回で、すべての daemon に及ぶ。組織の名前つき（`--org`）の常駐は、起動し直さずに止まる（`docs/launchd.md` の手作業の手順で上げる）。

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

`$HOME/.touryou/work` に残るのは、取得した tar.gz（目安として約 41MB）だけ（次の同じ版の実行で、照合して使い直す。中身の検査に使う一覧のファイルは、script が一時ディレクトリに作り、成功・失敗・中断〔Ctrl-C〕のどれでも消す）。インストールの確認のあとは、**利用者が、自分で消してよい**（消さなくても動く。このコマンドは、`rm` を実行しない。script は、自分の一時ディレクトリと、照合に失敗した取得だけを消す）。古い版のディレクトリ（`$HOME/.touryou/v<前の版>`）も残る（戻すときのため。消すのは利用者）。
