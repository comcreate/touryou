---
description: 常駐（launchd の supervisor）と、その見張りの daemon を、確かめる・起動し直す・止める・外す（引数 status・restart・stop・unregister・uninstall・uninstall-all。対象は --config・--all）
allowed-tools: Read
---

`/touryou:setup` で常駐にした supervisor（launchd の項目は 1 つだけ）と、supervisor が見張る daemon を操作します。引数（`$ARGUMENTS`）は `status`・`restart`・`stop`・`unregister`・`uninstall`・`uninstall-all` のどれか 1 つ。なければ `status`。それ以外なら、使い方を伝えて終わる。

## 進め方の決まり

- **この文書に書かれたコマンドを、書かれたとおりに実行する**。使うのは `"$HOME/.touryou/current/bin/touryou" supervisor` の決まったサブコマンドだけ。`launchctl` を直接は実行しない。ファイルを消すのは、`uninstall` のサブコマンドだけ（自分で消すコマンドは実行しない。`uninstall-all` の plugin・`$HOME/.touryou` の削除も、会話の中では実行せず、ターミナルのブロックとして出すだけ）。コマンドが失敗したら、書き換えて実行し直さずに止まり、出力をそのまま人に伝える（`uninstall` の終了コード 1 の「残した」は、下のとおり失敗ではない）。
- このコマンドは、`Read` 以外を、事前に許可していない。コマンドごとに、承認の確認が出る（正常）。
- **`--yes` は、利用者が定型文の問いにチャットで「はい」と答えたあとにだけ付ける。承認ダイアログの許可だけでは付けない**。`restart`・`stop`・`unregister` も、チャットの「はい」のあとだけ実行する。
- `root-token` の中身は、読まない・出さない。
- **構造**: 常駐の項目は supervisor の 1 つ（Label `touryou.supervisor`）。supervisor は、登録簿（`$HOME/.touryou/registry.json`）の設定ごとに、daemon を別のプロセスで起こして見張る。daemon の設定・state・ログは、各リポジトリの `.touryou/` にある。supervisor を止めても、起こした daemon は止まらない。
- **対象の決め方**: 既定の対象は、**このセッションを開いているリポジトリの設定**（実行した場所から上へ探した `<repoRoot>/.touryou/config.json`）。引数は付けない。ほかのリポジトリは、コマンドの最後に `--config <設定ファイルの絶対パス>`、登録されたものすべては `--all` を付ける（同時には指定できない）。見つからないとき、または別のリポジトリのつもりのときは、`"$HOME/.touryou/current/bin/touryou" ui --list` で設定の一覧を出して、利用者に選んでもらう。**聞かずに、`--all` を使わない**。定型文は、対象の設定（または全部）を添えて尋ねる。

## 引数ごとの手順

- **status**: `"$HOME/.touryou/current/bin/touryou" supervisor status`（対象を変えるときは最後に `--config <設定>` か `--all`）。出力（supervisor の読み込みの状態と、対象の設定ごとの daemon の有無）を、そのまま要約して伝える。終了コードが 0 以外のときは、出力の理由もそのまま伝える。読み込まれていないときは、**出力のその行の括弧の中で分ける**（`supervisor status` が、LaunchAgents の plist の有無で、どちらか 1 つだけを出す。両方を並べて利用者に尋ねない）。**読み込まれていないときは、`restart` を案内しない**（supervisor が動いていないと、daemon は起こし直されない）。
  - 「（常駐にしていない）」: 常駐の登録は `/setup` の役目なので、そう伝えて終わる（ここで `apply` を尋ねない）。
  - 「（stop で止めた後）」: 次のログインでまた動く、と伝え、**続けて、その場で**次の定型文（再開）で尋ね、**はっきり「はい」のときだけ** `"$HOME/.touryou/current/bin/touryou" supervisor apply --yes`。それ以外は、何もせずに終わる。
  定型文（再開）: 「止めている supervisor を、いま読み込み直して動かします（常駐の設定はそのまま）。登録された設定の daemon を、起こして見張ります。よいですか（はい／いいえ）」
- **restart**: 読み込み済みのときだけ使える（先に `status` で、読み込み済みかを見る）。次の定型文で尋ね、**はっきり「はい」のときだけ** `"$HOME/.touryou/current/bin/touryou" supervisor restart`（対象の daemon に終了を送る。supervisor が、次の周〔30 秒以内〕で起こし直す。supervisor が起こしたものだけ。手で起こした daemon には送らない）。それ以外（「いいえ」・あいまい・質問）は、何もせずに終わる。
  定型文: 「{対象} の daemon を起動し直します。動いている子のセッションは止まりません（daemon が戻るまでの間は、子の道具が届かないことがあります）。よいですか（はい／いいえ）」
- **stop**: 次の定型文で尋ね、**はっきり「はい」のときだけ** `"$HOME/.touryou/current/bin/touryou" supervisor stop`（supervisor の見張りを止める。起こした daemon は止まらない）。それ以外は、何もせずに終わる。
  定型文: 「supervisor の見張りを止めます。動いている daemon と子のセッションは止まりません。ただし、daemon が落ちても起こし直されません。常駐の設定は残るので、次にログインしたときに、また自動で動きます。よいですか（はい／いいえ）」
- **unregister**: このリポジトリ（または `--config`・`--all` の対象）を、見張りの対象（登録簿）から外す。次の定型文で尋ね、**はっきり「はい」のときだけ** `"$HOME/.touryou/current/bin/touryou" supervisor unregister`（対象の指定は上の決まり）。登録簿の 1 行だけを外す。daemon・設定・state には触れない。それ以外は、何もせずに終わる。
  定型文: 「{対象} を、supervisor の見張りの対象から外します（動いている daemon は、そのまま動きます。落ちても起こし直されなくなります）。よいですか（はい／いいえ）」
- **uninstall**: **実行の前に、次の定型文で尋ねる**。はっきり「はい」でなければ、何もせずに終わる。
  定型文（外す）: 「常駐をやめます。supervisor を止め、TouRyou が作った plist を消します（ログ・登録簿・各リポジトリの設定と daemon の状態は残します。動いている daemon は止まりません）。ログイン項目の項目も、動かなくなります。よいですか（はい／いいえ）」
  「はい」のあと、**1 回だけ**実行する: `"$HOME/.touryou/current/bin/touryou" supervisor uninstall --yes`。
  結果の伝え方: 終了コード 0 なら、消したものを伝える。**終了コード 1 で、出力に「残した」の行があるときは、失敗ではない**（TouRyou が生成したものと判定できない〔手で直した・リンクなど〕ので残した）。残したものと理由を伝えて終える（やり直さない。消すかは、利用者が自分で決める）。終了コード 1 で「何も消していない」のとき（止めるのに失敗）・終了コード 2 は、出力を伝えて止まる。
  外したあと、手で起動するときは、`/setup` の手順 3-B。
- **uninstall-all**: TouRyou をまとめて外す（常駐・plugin・marketplace・`$HOME/.touryou`）。**実行の前に、次の定型文で尋ねる**。はっきり「はい」でなければ、何もせずに終わる。
  定型文（まとめて外す）: 「TouRyou をまとめて外します。いま、常駐（supervisor）を止めて外します。plugin・marketplace・$HOME/.touryou（ログと登録簿を含む）は、この会話を終えたあとに、ターミナルで消すコマンドを出します。起こした daemon は、supervisor を外しても止まらないので、手で止めてもらいます。動いている子のセッション（claude）は止まりませんが、daemon がなくなると、子の道具は届かなくなります。よいですか（はい／いいえ）」
  「はい」のあと、**1 回だけ**実行する: `"$HOME/.touryou/current/bin/touryou" supervisor uninstall --yes`。
  結果: 終了コード 0、または終了コード 1 で「残した」の行があるときは、消したもの・残したもの（理由）を伝えて、次へ進む。終了コード 1 で「何も消していない」（止めるのに失敗）・終了コード 2 は、出力を伝えて止まる（次のブロックは出さない）。
  続けて、次のことを伝え、ブロックを出す（**会話の中では実行しない**）。
  - 起こした daemon（supervisor が起こしたもの・手で起こしたもの）は、supervisor を外しても止まらない。下のブロックの 1 行目（`pgrep`）が出すプロセスを、利用者が確かめて、自分で止める（手で起こしたものは、そのターミナルで Ctrl-C）。
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
