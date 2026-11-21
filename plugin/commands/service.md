---
description: 常駐（launchd）の daemon を、確かめる・起動し直す・止める・外す（引数 status・restart・stop・uninstall・uninstall-all）
allowed-tools: Read
---

`/touryou:setup` の手順 3-A で常駐にした daemon を操作します。引数（`$ARGUMENTS`）は `status`・`restart`・`stop`・`uninstall`・`uninstall-all` のどれか 1 つ。なければ `status`。それ以外なら、使い方を伝えて終わる。

## 進め方の決まり

- **この文書に書かれたコマンドを、書かれたとおりに実行する**。使うのは `"$HOME/.touryou/current/bin/touryou" launchd` の決まったサブコマンドだけ。`launchctl` を直接は実行しない。ファイルを消すのは、`uninstall` のサブコマンドだけ（自分で消すコマンドは実行しない。`uninstall-all` の plugin・`$HOME/.touryou` の削除も、会話の中では実行せず、ターミナルのブロックとして出すだけ）。コマンドが失敗したら、書き換えて実行し直さずに止まり、出力をそのまま人に伝える（`uninstall` の終了コード 1 の「残した」は、下のとおり失敗ではない）。
- このコマンドは、`Read` 以外を、事前に許可していない。コマンドごとに、承認の確認が出る（正常）。
- **`--yes` は、利用者が定型文の問いにチャットで「はい」と答えたあとにだけ付ける。承認ダイアログの許可だけでは付けない**。`restart`・`stop` も、チャットの「はい」のあとだけ実行する。
- `root-token` の中身は、読まない・出さない。
- `--org` を、`/setup` のときと変えていなければ、付けない（省略すると Label は `touryou.daemon`）。
- **複数の daemon（設定ごと。#165）**: root ごとに daemon を分けているとき（`touryou launchd init --config <設定>` で作った別名の daemon。Label は `touryou.daemon-<8 文字>`）は、**どの daemon を対象にするかを、実行の前に利用者に聞く**。選び方は 3 つ: 既定の設定（`$HOME/.touryou/config.json`。引数を付けない）／ある設定（コマンドの最後に `--config <設定ファイルの絶対パス>` を付ける）／別名の daemon すべて（`--others` を付ける）。どれかが分からなければ、`"$HOME/.touryou/current/bin/touryou" ui --list` で設定の一覧（既定と別名の設定。repoRoot つき）を出して、利用者に選んでもらう。**聞かずに、すべてを対象にしない**。選んだ `--config <設定>`・`--others` は、`status`・`restart`・`stop`・`uninstall`・`apply` のコマンドの最後にそのまま付ける。定型文（再開・起動し直し・止める・外す）は、対象の daemon の設定（またはすべて）を添えて尋ねる。`uninstall-all` は、既定の設定に加えて、別名の daemon も外す（既定の設定の分を 1 回、別名があるときだけ `--others` 付きで続けて 1 回。合計で最大 2 回）。

## 引数ごとの手順

- **status**: `"$HOME/.touryou/current/bin/touryou" launchd status`。出力（読み込みの状態・終了コード・窓口の応答）を、そのまま要約して伝える。終了コードが 0 以外のときは、出力の「最後の失敗」の行（`daemon.log` の最後の `失敗 [code]: …`。値は伏せてある）もそのまま伝える。それが `invalidConfig`（`repoRoot` などが、ない・実パスでない・git のリポジトリでない）なら、起動のたびに落ち続けているので、`stop` で止めてから、設定を直す（または `/touryou:setup` をやり直す）よう案内する（自分で `config.json` を書き換えない）。読み込まれていないときは、**出力のその行の括弧の中で分ける**（`touryou launchd status` が、LaunchAgents の plist の有無で、どちらか 1 つだけを出す。両方を並べて利用者に尋ねない）。**読み込まれていないときは、`restart` を案内しない**（読み込まれていないと使えない）。
  - 「（常駐にしていない）」: 常駐の登録は `/setup` の手順 3-A の役目なので、そう伝えて終わる（ここで `apply` を尋ねない）。
  - 「（stop で止めた後）」: 次のログインでまた動く、と伝え、**続けて、その場で**次の定型文（再開）で尋ね、**はっきり「はい」のときだけ** `"$HOME/.touryou/current/bin/touryou" launchd apply --yes`。それ以外は、何もせずに終わる。
  定型文（再開）: 「止めている daemon を、いま読み込み直して動かします（常駐の設定はそのまま）。よいですか（はい／いいえ）」
- **restart**: 読み込み済みのときだけ使える（`stop` の後・常駐にしていないときは、`launchd restart` が「先に apply --yes」で終わる。先に `status` で読み込み済みかを見て、読み込まれていなければ、status の行の案内に従う）。次の定型文で尋ね、**はっきり「はい」のときだけ** `"$HOME/.touryou/current/bin/touryou" launchd restart`（daemon を起動し直し、窓口の応答を待つ）。それ以外（「いいえ」・あいまい・質問）は、何もせずに終わる。
  定型文: 「daemon を起動し直します。動いている子のセッションは止まりません（daemon が戻るまでの間は、子の道具が届かないことがあります）。よいですか（はい／いいえ）」
- **stop**: 次の定型文で尋ね、**はっきり「はい」のときだけ** `"$HOME/.touryou/current/bin/touryou" launchd stop`（daemon を止める）。それ以外は、何もせずに終わる。
  定型文: 「daemon を止めます。動いている子のセッションは止まりませんが、daemon を動かし直すまで、子の道具は届きません。常駐の設定は残るので、次にログインしたときに、また自動で動きます。よいですか（はい／いいえ）」
- **uninstall**: **実行の前に、次の定型文で尋ねる**。はっきり「はい」でなければ、何もせずに終わる。
  定型文（外す）: 「常駐をやめます。daemon を止め、TouRyou が作った plist（前の版の起動スクリプトがあれば、それも）を消します（ログと daemon の状態は残します）。ログイン項目の項目も、動かなくなります。よいですか（はい／いいえ）」
  「はい」のあと、**1 回だけ**実行する: `"$HOME/.touryou/current/bin/touryou" launchd uninstall --yes`。
  結果の伝え方: 終了コード 0 なら、消したものを伝える。**終了コード 1 で、出力に「残した」の行があるときは、失敗ではない**（TouRyou が生成したものと判定できない〔手で直した・リンクなど〕ので残した）。残したものと理由を伝えて終える（やり直さない。消すかは、利用者が自分で決める）。終了コード 1 で「何も消していない」のとき（止めるのに失敗）・終了コード 2 は、出力を伝えて止まる。
  外したあと、手で起動するときは、`/setup` の手順 3-B。
- **uninstall-all**: TouRyou をまとめて外す（常駐・plugin・marketplace・`$HOME/.touryou`）。**実行の前に、次の定型文で尋ねる**。はっきり「はい」でなければ、何もせずに終わる。
  定型文（まとめて外す）: 「TouRyou をまとめて外します。いま、常駐（daemon）を止めて外します。plugin・marketplace・$HOME/.touryou（ログと daemon の状態を含む）は、この会話を終えたあとに、ターミナルで消すコマンドを出します。動いている子のセッション（claude）は止まりませんが、daemon がなくなるので、子の道具は届かなくなります。よいですか（はい／いいえ）」
  「はい」のあと、実行するのは**合計で最大 2 回**: まず `"$HOME/.touryou/current/bin/touryou" launchd uninstall --yes`（1 回）。別名の daemon があるときだけ、続けて `"$HOME/.touryou/current/bin/touryou" launchd uninstall --yes --others`（もう 1 回）。同じコマンドを繰り返さない。常駐にしていなかったときも、同じものを実行する（消すものがなければ、何も消さずに終わる）。
  結果: 終了コード 0、または終了コード 1 で「残した」の行があるときは、消したもの・残したもの（理由）を伝えて、次へ進む。終了コード 1 で「何も消していない」（止めるのに失敗）・終了コード 2 は、出力を伝えて止まる（次のブロックは出さない）。
  続けて、次のことを伝え、ブロックを出す（**会話の中では実行しない**）。
  - 手で起動した daemon（`/setup` の手順 3-B）があれば、先にそのターミナルで Ctrl-C で止める。
  - この会話を `/exit` で終える（Claude Code のほかの会話・デスクトップ版も閉じる）。
  - `CLAUDE_CONFIG_DIR` を分けて使っているなら、ブロックの前に、同じターミナルで `export CLAUDE_CONFIG_DIR=<plugin を入れたときの値>` を実行する（`<…>` は自分の値に置き換える）。分けていなければ、要らない。
  - 1 行目が何かを出したら（TouRyou のプロセスがまだ動いている）、そこで止める。止めてから、やり直す。

  ターミナル（Claude Code を終えたあと。Mac の「ターミナル」）:

  ```
  pgrep -fl '\.touryou/'
  claude plugin uninstall touryou@touryou
  claude plugin marketplace remove touryou
  rm -rf "$HOME/.touryou"
  ```

  1 行ずつ貼って Enter する（1 行目が何も出さないことを確かめてから、2 行目へ）。
