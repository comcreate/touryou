---
name: section-launcher
description: touryou の開発の統括（root）のセッションが、手元の Mac で常駐の手伝いのセッション 4 つ（見回り係・ボード係・UI レビュー係・UX レビュー係）を、Claude Code の背景のセッション（claude --bg）として立てる・様子を見る・起こす・止めるとき、作業のセッションを作業ツリーを分けて立てるときに使う。「常駐を立てて」「手伝いのセッションを起動して」「ボード係がいない」「レビュー係を立て直して」「常駐の様子は？」と言われたとき、統括を始めたとき、レビュー係に頼む前に生きているかを見るとき、統括の定期の様子見の予定が来たときに使う。touryou の子（node_spawn）を作るときには使わない。
---

# section-launcher（常駐の手伝いのセッションを立てる）

統括（root）のセッションで使う。統括は、利用者と話し、作業を任せ、レビューのあとにマージする役。日々の見回り・ボードの更新・UI と UX のレビューは、常駐の手伝いのセッションに任せる。この skill は、その 4 つを立てて、生きているかを見守る。

手伝いは、Claude Code の背景のセッション（`claude --bg`）として動く。統括とは、名前を宛先にした知らせ（SendMessage）でやり取りする。決まった時刻の仕事は、それぞれが自分の中の予定（CronCreate）で動かす。

**背景のセッションは、手が空くと約 1 時間で止まる**（Claude Code の決まり。予定〔CronCreate〕を持っているもの・attach しているものは止まらない）。なので、4 つとも、何かしらの予定を持たせてある。止まったら、4 の「起こす」で起こす。

## 設定

名前・置き場・権限のモードなどは、設定から決める。この skill のフォルダ（読み込んだときに示される「Base directory」）の `scripts/orch_config.py` が、次の順で読む（上のほうが勝つ）。

1. 環境変数: `TOURYOU_ORCH_REPO`・`TOURYOU_ORCH_GH_USER`・`TOURYOU_ORCH_BOARD_URL`・`TOURYOU_ORCH_NAME_PREFIX`・`TOURYOU_ORCH_PERMISSION_MODE`・`TOURYOU_ORCH_TRIAGE_CRON`・`TOURYOU_ORCH_BOARD_CRON`
2. 設定のファイル: `${TOURYOU_ORCH_CONFIG:-${TOURYOU_ORCH_DIR:-$HOME/touryou-orch}/config.json}`（見本は `assets/config.example.json`）
3. 既定: リポジトリ `comcreate/touryou`・名前の頭 `orch-`・権限のモード `auto`・置き場 `$HOME/touryou-orch`

| 鍵 | 中身 | 既定 |
|---|---|---|
| `repo` | GitHub のリポジトリ（`持ち主/名前`） | `comcreate/touryou` |
| `ghUser` | gh の認証を切り替えるアカウント。空なら、いまの認証のまま | 空 |
| `boardUrl` | 統括ボード（claude.ai の Artifact）の URL。空なら、ボード係が作るかを聞く | 空 |
| `namePrefix` | 統括と手伝いの名前の頭 | `orch-` |
| `permissionMode` | 手伝いの権限のモード（統括と同じにする） | `auto` |
| `triageCron`・`boardCron` | 見回り・ボードの確かめの予定 | `41 * * * *`・`15 * * * *` |

個人の値（`ghUser`・`boardUrl`・置き場のパス）は、手元の設定にだけ置き、リポジトリ・ボード・GitHub・知らせに書かない。値は、形を確かめてから使う（形が違えば既定に戻し、`problems` に出る）。

この文書では、既定の名前（`orch-root`・`orch-triage`・`orch-board`・`orch-review-ui`・`orch-review-ux`・作業の頭 `orch-work-`）で書く。`namePrefix` を変えたときは、読み替える。

## 4 つの手伝い

| 役目の鍵 | 名前（既定） | 役目 | 使う skill | 予定 |
|---|---|---|---|---|
| `triage` | `orch-triage` | 見回り係。統括が終了の印を付けた作業のセッションを止めて片付け、印のない古いものを候補として知らせる | `triage-section` | 毎時（`triageCron`） |
| `board` | `orch-board` | ボード係。統括ボードを最新に保つ | `board-updator` | 毎時（`boardCron`） |
| `review-ui` | `orch-review-ui` | UI レビュー係。状態画面の見た目と操作の面から PR をレビューする | `review-ui` | 毎日 1 回（止められないための、予定の作り直しだけ） |
| `review-ux` | `orch-review-ux` | UX レビュー係。利用者の流れと言葉の面から PR をレビューする | `review-ux` | 毎日 1 回（同じ） |

統括は、`orch-root` の名前で始める（例: `claude -n orch-root --permission-mode auto --settings '{"crossSessionInbound":"accept"}'`）。手伝いは、この名前に知らせを送る。統括と手伝いの権限のモードはそろえる（違うモードのあいだでは、知らせが受け手の承認待ちで止まることがある）。

作業のセッション（統括が、touryou の子ではない背景のセッションを立てるとき）は、名前を `orch-work-<題>-<番号>` にする（例: `orch-work-review-154-1`）。名前は使い回さない（見回り係が、名前で印を見るため）。touryou の子（名前が `node-` で始まる）と、ほかのセッションには、だれも触らない。

以下、`<launch>` は、この skill のフォルダの `scripts/launch.py` のこと。どれも、touryou の clone の中で打つ。

## 1. 前提を確かめる

1 回の Bash で、次をまとめて見る（パスなどの値は、会話に書き写さない）。

```sh
claude --version; claude --help | grep -c -- '--bg'; command -v jq gh python3 >/dev/null && echo tools-ok; git remote get-url origin; python3 "<この skill のフォルダ>/scripts/orch_config.py" | jq '{repo, namePrefix, permissionMode, hasGhUser: (.ghUser != ""), hasBoardUrl: (.boardUrl != ""), problems}'
```

- `--bg` が 1 以上（背景のセッションが使える版）。0 なら止まり、Claude Code を上げるよう利用者に伝える。
- `tools-ok` が出る（`jq`・`gh`・`python3`）。`python3` が開発ツールの導入の画面を出したら、利用者に入れるかを聞く。
- `origin` が設定の `repo` と同じリポジトリ。違えば止まり、その clone で統括を開き直すよう伝える（手伝いは、`<launch>` のある clone で立つ。project の設定と CLAUDE.md を読むため）。
- `problems` を利用者に伝える。`ghUser`・`boardUrl` がないときは、手元の設定のファイルに書くよう頼む（中身は、利用者が知っている値。統括が推し量って書かない）。書き方は `assets/config.example.json`。
- 統括が `--permission-mode` を `permissionMode` と違うモードで始めていたら、利用者に、どちらかに合わせるよう伝える。

## 2. いまの様子を見る

```sh
python3 "<launch>" status
```

- 「動いている」手伝いは、立てない（同じ名前が 2 つあると、知らせの宛先が決まらなくなる）。
- 「止まっている」手伝いは、4 の「起こす」で、前の会話を続けて起こす。
- 「ない」手伝いは、3 の「立てる」で新しく立てる。
- 統括の行の「動いている対話のセッション」が 1 個でなければ、利用者に伝える（手伝いが、どちらに知らせを送るか分からなくなる）。

## 3. 立てる（新しく）

1 つにつき 1 回の Bash で打つ。

```sh
python3 "<launch>" start triage
python3 "<launch>" start board
python3 "<launch>" start review-ui
python3 "<launch>" start review-ux
```

- script が、設定から名前・権限のモード・置き場を入れて、`claude --bg '<起動の文>' --name <名前> --permission-mode <モード> --add-dir <置き場> --settings '{"crossSessionInbound":"accept"}'` を、clone の中で実行する。動いている・止まっているものがあれば、立てずに断る。
- `--add-dir` は、手伝いが clone の外の置き場（印・状態・作業ツリー・レビューの本文）に書くための許し。`crossSessionInbound` は、統括からの知らせを、承認待ちにせずに受け取るための設定（touryou の子の起動と同じ）。
- モデルや深さを変えたいと利用者が言ったときだけ、`start <役目> --model <モデル> --effort <深さ>` にする。黙って変えない。
- 立てたあと、それぞれから「起動しました」の知らせが届く（数十秒〜数分）。届くまで、同じ手伝いを立て直さない。5 分たっても届かなければ、`claude logs orch-board` のように、その名前で最後の出力を見て、利用者に伝える。許可の確認で止まっているときは、利用者に `claude attach orch-board` のように開いて答えてもらう（「1. Yes」だけを選ぶ）。

## 4. 起こす（止まっていたもの）

```sh
python3 "<launch>" resume board
```

前の会話のまま起きる（前の起動の名前・モード・設定のまま）。同じ名前のものが複数あれば、いちばん新しいものを選ぶ。起こしたら、その手伝いに知らせを送る（予定は、セッションが止まると消えるため）:

> 起こしました。あなたの skill の「始めるとき」の手順を、もう一度行ってください（予定がなければ作り直す）。

## 5. レビュー係に頼む前

レビュー係に PR のレビューを頼む前に、2 で `orch-review-ui`・`orch-review-ux` が「動いている」かを見る。止まっていれば 4 で起こし、「起動しました」が届いてから頼む（止まっているセッションには、知らせが届かないことがある）。

頼み方: SendMessage で `orch-review-ui` に「PR #N の UI レビューをお願いします（見てほしい所: …）」。

## 6. 止める

利用者に頼まれたときだけ止める。止めても会話は残り、4 で起こせる。

```sh
python3 "<launch>" stop board
```

手伝いを消す（`claude rm`）のは、利用者がはっきり頼んだときだけ。

## 7. 作業のセッションを立てる

touryou の子でない作業（ネットにつなぐ調べ・gh を使う作業・コードの正しさのレビューなど）は、作業ツリーを分けた背景のセッションに任せる。最初の指示の文をファイルに書いてから:

```sh
python3 "<launch>" work review-154-1 "<置き場>/prompts/review-154-1.md"
```

- 名前は、作業の頭（`orch-work-`）に題を付けたもの。英小文字・数字・`-` だけ。使ったことのある名前は、script が断る（番号を上げる）。
- 指示の文には、決まり（日本語で平易に・値を書かない・承認の要る操作をしない・終わったら統括に SendMessage で知らせる）と、してほしいことを書く。レビューなら、PR に COMMENT を 1 つ、「### must」「### should」「### nit」の見出しで書かせる（承認・変更の要求・push・マージはさせない。フォークからの PR は、手元で組み立て・実行をさせない）。
- 終わったら（結果を受け取った・PR がマージされた）、統括が終了の印を付ける。見回り係が、見つけてから 1 時間あとに片付ける:

  ```sh
  printf '%s\n' 'orch-work-review-154-1' >> "<置き場>/archive-ok.txt"
  ```

## 8. 統括の様子見の予定

統括の中にも、毎日 1 回、手伝いが生きているかを見る予定を作る。CronList に同じ予定がなければ、CronCreate で作る。

- cron: `7 9 * * *`（毎朝 9 時ごろ。少し遅れて動くこともある）
- prompt: `section-launcher の skill で、常駐の手伝いの様子を見る（8 の様子見）。`
- 様子見ですること:
  1. この予定を作り直す（CronDelete のあと CronCreate。7 日で消えるため）。
  2. 2 の様子を見る。止まっているものがあれば利用者に知らせ、「起こしてよい」と言われたら 4 で起こす。
  3. 動いている 4 つに「予定はある？」と聞く（Claude Code の版上げなどで起こし直されたあと、予定が消えていることがあるため。予定がないと、手が空いて約 1 時間で止まる）。
- 統括は対話のセッションなので、利用者がターミナルを閉じると止まる。そのときは、手伝いの知らせの宛先がなくなる。開き直すときは、clone の中で `claude --resume orch-root -n orch-root`（と、始めたときと同じ旗）を打ち、「常駐の様子は？」と頼んでもらう。

Mac がスリープすると、背景のセッションも止まる。長く任せるときは、利用者に、スリープを止めるかを聞く。止めるなら、別のターミナルで `caffeinate -i` を打って開いたままにしてもらう（止めるときは Ctrl+C。ふたを閉じると、電池のときはスリープする）。

## 9. 利用者への報告

立てた・起こした・すでに動いていた手伝いを、名前と役目で表にして返す。開き方も添える（ターミナルで打つ）:

```sh
claude attach orch-board
```

名前で開けるのは動いているセッションだけ。止まっているときは、4 で起こしてから開く。
