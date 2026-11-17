# 手動確認のチェックリスト（人が実施する項目）

自動試験では確かめられず、人が実機（Mac の Claude Code・デスクトップアプリなど）で確かめる項目をまとめる。各項目に、準備・操作・期待する結果を書く。

- 秘密（トークン・紐付けコード）・パス・ユーザー名・セッションの ID は、会話・ログ・Issue などに書き写さない（NFR_012）。パスは `<作業ツリー>`・`<plugin のディレクトリ>`・`<H>`（ホーム）のように置き換える。
- 判定は「可」「不可」「条件付き」のいずれか。**条件付き**は、期待の一部だけを確かめられた、または確かめ方に制約があったときに使う。何が確かめられ、何が残ったかを分けて書く。
- トークンを使うコマンドは、人が自分の端末で打つ。シェルの履歴に残さない（行の先頭に空白を入れ、zsh は `setopt HIST_IGNORE_SPACE`、bash は `HISTCONTROL=ignorespace`）。
- 今の形: TouRyou はセッションを起動しない。親（統合セッション）が `claude --bg` で子を起動し、子が `child_bind` で紐付け、`inbox_fetch` でブリーフと指示を読む。停止は親が `claude stop`、削除は `claude rm`（[`docs/plugin.md`](plugin.md) の「親から子を起動する流れ」）。

## 実施の順序（おすすめ）

| 順 | 区分 | 項目 | 必要なもの |
|:--|:--|:--|:--|
| 1 | 統合セッションの MCP | N | `/setup` 済みの Mac・Claude Code（CLI とデスクトップ版） |
| 2 | 中継とまとめて外す | Q | N と同じ |
| 3 | 常駐 | S | N と同じ |
| 4 | 親が起動する子 | A1〜A4 | N と同じ。試しのリポジトリ |
| 5 | 手動の CLI セッションのフック | H | A1 の子 |
| 6 | 受信箱の一覧 | I | 未解決の項目がある受信箱 |
| 7 | デスクトップアプリの拡張機能 | P | Claude のデスクトップアプリ |
| 8 | Desktop の子 | D1〜D3 | 設定 `childRuntime: "desktop"` の daemon と、Claude のデスクトップアプリ |
| 9 | 状態画面を開く | U | N と同じ。既定のブラウザ |
| 10 | 状態画面の組み立て | V | U と同じ。子が 2 つ以上ある木（A1） |
| 11 | 関係図の束 | G | U と同じ |

---

## N. 統合セッションの MCP（stdio 型）

**ねらい**: plugin の `.mcp.json`（stdio 型。中継 `scripts/touryou-mcp-shim.sh` が `$HOME/.touryou/current/bin/touryou-mcp --stdio` を `exec`）が、CLI とデスクトップ版の両方で、統合セッションの MCP として動くこと。

- 前提: daemon を起動済み（launchd か手で）。統合セッションを起動する端末に、`TOURYOU_ROOT_TOKEN`・`TOURYOU_DAEMON_URL` を設定しない（`env | grep -c '^TOURYOU_'` が `0`）。
- プロセスの探し方: 配布物の `touryou-mcp` は、同梱の node に置き換わって動く（`scripts/dist-build.sh`）ので、コマンド行に `touryou-mcp` の文字は出ない。`@touryou/mcp/dist/bin.js --stdio` で探す。コマンド行は `current` を経由したパス（`<H>/.touryou/current/bin/node …`）で出るので、版のフォルダの名前では見つからない。

| # | 確かめること | 手順 | 期待 |
|:--|:--|:--|:--|
| N1 | CLI で接続できる | `claude` を起動し、`/mcp` を開く。続けて `/touryou:start` | `plugin:touryou:node` が connected。whoami が integrator・root |
| N2 | デスクトップ版で接続できる | デスクトップ版を ⌘Q で終了し、ふつうに起動して、同じ plugin の入った設定で、統合セッションを開く。`/touryou:status` | N1 と同じ要約が出る（デスクトップ版の `/mcp` はコネクタの画面を開き、plugin の MCP は表示されないので、接続の確認は `/touryou:status` で行う）。動かなければ、表示（Errors の文面など）を記録する |
| N3 | daemon が動いていないときの見え方 | daemon を止めてから、新しい統合セッションを開く。`/mcp` と `/plugin` の Errors を見る。道具を呼ぶ | 道具が `daemon が動いていません。launchd か touryou-daemon で起動してください` の趣旨で失敗する（見える場所を記録）。daemon を起動すると、Reconnect なしで通る（Q の中継の待ち） |
| N4 | /setup の前の見え方 | `$HOME/.touryou/current` がない状態（別のユーザーか、退避して）で、統合セッションを開く | node は落ちずに道具 0 個で待つ（Q1）。退避を戻すと通る |
| N5 | 統合セッションを 2 つ同時に開く | 2 つの端末で、それぞれ統合セッションを開き、両方で `/touryou:start` | どちらも connected・integrator。`ps -axo command \| grep "@touryou/mcp/dist/bin.js --stdio" \| grep -vc grep` が 2（終了したセッションの分は消える） |
| N6 | トークンが見えないこと | N1 のセッションで、`/mcp` の画面と、`ps -axo pid,command \| grep "@touryou/mcp/dist/bin.js --stdio" \| grep -v grep`、統合セッションの環境（`env \| grep -c TOURYOU_ROOT_TOKEN` が 0） | 引数は `--stdio` だけ。トークンの値が、どこにも出ない |
| N7 | セッションを閉じたら止まる | N1 のセッションを `/exit` し、`ps -axo command \| grep "@touryou/mcp/dist/bin.js --stdio" \| grep -vc grep` | `0`（daemon は動いたまま）。デスクトップ版では、アプリを ⌘Q で終了すると消える |
| N8 | daemon の再起動に追従する | N1 のセッションを開いたまま、daemon を止めて、起動し直す（launchd なら `launchctl kickstart -k`、手で起動したなら、その端末で Ctrl+C のあと起動し直す。手で起動したものに `kickstart` を使うと `Could not find service`）。そのあと、統合セッションで `mcp__…node__whoami` を呼ぶ | Reconnect なしで、integrator・root が返る（`touryou-mcp --stdio` が置き場を読み直して、1 回だけ送り直す）。戻らなければ、失敗の文面を記録する |

## Q. 落ちない中継（`scripts/touryou-mcp-shim.sh`）と、まとめて外す

前提: 確かめる版の plugin を入れる。`$HOME/.touryou` がない状態（Q1〜Q4）と、ある状態（Q5）で行う。

| # | 確かめること | 手順 | 期待（可） |
|:--|:--|:--|:--|
| Q1 | 対話の CLI で、`/setup` のあと自動でつながる | `$HOME/.touryou` がない状態で `claude` を起動し、`/mcp` で node の状態を見る。続けて同じ会話で `/touryou:setup`（3-A）。終わって 10〜20 秒待ち、`/touryou:start` | 起動直後の node は connected（failed にならない）・道具 0 個。Reconnect なしで `/start` の whoami が通る |
| Q2 | デスクトップ版で、`/setup` のあと自動でつながる | Q1 と同じことを、デスクトップ版の Claude Code で行う（確認は `/touryou:status`。plugin は marketplace から入れる） | Reconnect も起動し直しもなしで `/status` が通る。通らなければ、起動し直しで通るかを記録する |
| Q3 | macOS の `/bin/bash`（3.2）と BSD sed で動く | `/bin/bash --version` の 1 行目を見る。`$HOME/.touryou` がない状態で `/bin/bash <plugin のディレクトリ>/scripts/touryou-mcp-shim.sh` を実行し、`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}` を貼って Enter、Ctrl-D | 3.2 の版で、`"id":1` と `"listChanged":true` を含む 1 行が返り、Ctrl-D で終わる |
| Q4 | 待ちのあいだの CPU | Q1 の起動直後（`/setup` の前）に、別のターミナルで `top -l 2 -stats pid,cpu,command \| grep -i bash` | 中継の bash の CPU がほぼ 0%。続けて、配布物を置いて daemon を起動しないまま 1 分おき、同じコマンドと `top -l 2 -stats pid,cpu,command \| grep -i node` で、10 秒ごとの試しの起動（Node）の CPU を見る（電池への影響の目安） |
| Q5 | daemon が動く前に配布物だけあるとき | 3-B（手で起動）を選び、daemon を起動する前に会話を始めて `/start` を試す。そのあと daemon を起動して 10〜20 秒待ち、もう一度 `/start` | 1 回目は node の道具がない（failed にはならない。中継の bash だけが動く）。2 回目は Reconnect なしで通る。中継の子として `@touryou/mcp/dist/bin.js --stdio` が 1 つ |
| Q6 | `/touryou:service uninstall-all` | 常駐にした状態で実行し、定型文に「はい」。出たターミナルのブロックを `/exit` のあとに貼る | 常駐が外れ、`pgrep -fl '\.touryou/'` が何も出さず、plugin・marketplace・`$HOME/.touryou` が消える。その会話の `touryou-mcp --stdio` は `/exit` で終わる |
| Q7 | auto モードでの承認 | Claude Code の auto モード（権限の自動判定）で `/touryou:setup`・`/touryou:service`・`/touryou:desktop` を実行する | 止められた・確認が出たコマンドと、その文面を記録する。チャットの「はい」の定型文は、auto モードでも尋ねられる |
| Q8 | plugin を update した直後のセッション | tag の後（`docs/release.md` の 6）。`claude plugin update touryou@touryou` のあと、`/reload-plugins` をせずに統合セッションを開き（または続け）、`/touryou:start` | node の MCP が動く（古い版の置き場の中継が残っていて、つながる）。動かなければ、表示を記録する |

## S. /setup からの常駐（launchd）

**ねらい**: `/setup` の手順 3-A と `/touryou:service` が、Claude Code の承認のもとで `touryou launchd` を実行し、ログイン時に自動で動く常駐（daemon）を入れ・確かめ・外せること（[`docs/launchd.md`](launchd.md)）。

- 前提: 確かめる版の plugin と配布物。手で起動した daemon は止めておく。

| # | 確かめること | 手順 | 期待 |
|:--|:--|:--|:--|
| S1 | 同意がないと登録しない | `/setup` の手順 3 で「常駐」を選び、同意の問いに「いいえ」 | 登録せずに、手で起動する案内（3-B）になる。`<H>/Library/LaunchAgents` に TouRyou の plist がない |
| S3 | Claude Code の承認で `launchctl bootstrap` が通る | 同意に「はい」。`touryou launchd apply --yes` を承認する | 終了コード 0。未認証の whoami が 401 の行。sandbox などで拒否されたら、その文面を記録 |
| S4 | ログイン項目の通知の見え方 | S3 の直後 | macOS の通知と、システム設定の「一般」→「ログイン項目と機能拡張」→「バックグラウンドでの実行を許可」に、**TouRyou**（1 項目）が出る。「開発元を識別できない項目」と出るのは、ad-hoc の署名のためで正常（#73）。名前・アイコン（TouRyou のアイコンか、汎用の絵か）を記録 |
| S5 | ログインし直しても動く | ログアウト → ログイン（または再起動）のあと、`/touryou:service status` | 読み込み済み・running、窓口が 401。`/touryou:status` が通る |
| S6 | 起動し直す・止める | `/touryou:service restart`、続けて `stop` | restart は終了コード 0。stop のあとは「読み込まれていない」で、戻し方（次のログイン、または同意のあとの `apply --yes`）が案内される（restart は案内しない） |
| S7 | 外す | `/touryou:service uninstall`（同意に「はい」） | plist（LaunchAgents と `<H>/.touryou/launchd`）と `<H>/.touryou/bin` の起動スクリプトが消え、`logs`・`state` は残る。ログイン項目からも消える |
| S8 | 版を上げる | 常駐中に、新しい版の plugin で `/setup`（「版が変わり、常駐しているとき」） | 同意のあと script が stop → 入れ替え → `apply --yes` で、新しい版で動く（`ps -axo command \| grep "/.touryou/" \| grep -v grep` のパスが `current` 経由） |
| S10 | 導入の script の承認の回数 | tag の前は `docs/setup-verification.md` の写しで行う。`$HOME/.touryou` がない状態で `/touryou:setup` を最後まで（3-A）。承認の確認の回数を数える | 約 3 回（導入・設定・常駐の登録）。導入の承認の画面は `env -u BASH_ENV -u ENV bash "<plugin の場所>/scripts/install-runtime.sh"`（引数なし） |
| S11 | 導入の script と quarantine | tag の前は `docs/setup-verification.md` の写しで行う。S10 の直後に `ls -l@ "$HOME/.touryou/work"` と `ls -lR@ "$HOME/.touryou/current/" \| grep -c com.apple.quarantine` | quarantine が付かない（0）。付いたときは、script が止まる（外さない）ことを記録する |
| S12 | 版が変わり、常駐しているとき | tag の前は `docs/setup-verification.md` の写しで行う。常駐中に、plugin を新しい版にして新しいセッションを開き、`/touryou:setup` | 始まりに版の違いの知らせが出る（知らせだけ）。script は終了コード 3 で何も変えず、「はい」のあと `--restart-daemon` で、止める → 付け替え → `apply --yes`。`/touryou:service status` が新しい版で running。承認は 2 回 |
| S13 | 同じ版の再実行 | tag の前は `docs/setup-verification.md` の写しで行う。S10 のあとに、もう一度 `/touryou:setup` | 取得せずに `RESULT: already` |
| S9 | 常駐にしていないときの status | 常駐にしていない状態で `/touryou:service status` | 「（常駐にしていない）」で `/setup` の手順 3-A だけを案内し、止めた後の案内を並べず、再開も尋ねない |

`/setup` を実行した会話では、会話の始まり（`$HOME/.touryou` がまだない）の node が道具 0 個のままのことがある。手順 3-A・3-B の最後の案内（つなぎ直し）のとおりに `/start` で通ることを確かめる。

---

## A. 親が起動する子（`claude --bg`）

前提: 確かめる版の plugin と配布物を `/setup` で入れ、daemon を起動する。試しのリポジトリと根の範囲は、書き込み `src`・禁止 `.git`・コマンド `git status`・`git add`・`git commit`。親は、ふつうのモード（auto でない）と auto の両方で試す。値・ID・パスは書き写さない。

### A1. 起動と紐付け

| # | 確かめること | 手順 | 期待（可） |
|:--|:--|:--|:--|
| A1-1 | 親が起動の文を受け取り、実行できる | 統合セッションで子を 1 つ作る（`node_spawn`）。親が `inbox_fetch` で起動の依頼の項目を読み、`parent_request` で文を受け取り、Bash で実行する | 文は `cd <作業ツリー> && claude --bg '<指示>' --name <名前> … --permission-mode dontAsk --settings '…'` の形。変数を含まず、ふつうのモードでも「A variable in this command can't be checked」の確認が出ない。`claude agents --json` に子が出る |
| A1-2 | 子の mcp の作業ディレクトリ | A1-1 の子の、plugin の stdio の mcp の作業ディレクトリ（`process.cwd()`）が、その作業ツリーか | 作業ツリーの一番上。違えば紐付けが断られる |
| A1-3 | 子が `child_bind` を呼べる | 子の最初の番で、skill が `child_bind` を引数なしで呼び、続けて `inbox_fetch` を呼ぶ | 紐付けが通り、道具の一覧が子のものに変わる（`tools/list_changed` を Claude Code が読み直す） |
| A1-4 | 紐付けのコードが漏れない | A1-1〜A1-3 のあと、起動の文・会話の出力・daemon の記録・状態の置き場を、コードの形で探す | 作業ツリーの git のディレクトリの `touryou-bind-code` は 0600 の通常のファイルで、その中身は、ほかのどこにも見つからない |
| A1-5 | `CLAUDE_CODE_SESSION_ID` | 子の plugin の stdio の mcp に、環境変数 `CLAUDE_CODE_SESSION_ID` が渡るか。フックの入力の `session_id`（SessionStart・Stop）と同じ値か（値そのものは書き写さない） | 渡り、同じ値。渡らない場合は、紐付けで session_id を結ばず、その子のフックは none になり、印のある作業ツリーでは PreToolUse が拒否される |
| A1-6 | skill の名前 | 子が skill を、plugin の接頭辞なしの名前（例 `child`）で呼ぶことがあるか | あれば、紐付けの前の Skill が拒まれて詰まらないかを記録する |
| A1-7 | mcp のサーバー名を変えたとき | mcp のサーバー名を変えて入れた場合（`mcp__node__` でも `mcp__plugin_touryou_node__` でもない）に、紐付けの前の道具（`child_bind`）が拒まれるか | 結果を記録する |
| A1-8 | 知らせが届く | 子から報告を出させ、親に「受信箱を読め」の 1 行の知らせが届くか。番の最中に送った知らせが、いつ届くか | 待っている間の知らせは、すぐ新しい番で届く。番の最中の知らせは、番が終わったあとに届く（消えない） |
| A1-9 | `--model`・`--effort` | `parent_request` に model・effort を渡して起動する | 子がそのモデルで動く。組織の管理の設定（managed settings）がある環境で、モデルの切り替えで失敗が出たら、その文面を `parent_report` の `reason` で返す |

### A2. 停止・削除

| # | 確かめること | 手順 | 期待（可） |
|:--|:--|:--|:--|
| A2-1 | 休んでいる子のプロセス | 番を終えて休んでいる `claude --bg` の子のプロセスが、`lsof +D <作業ツリー>` で作業ツリーを使うプロセスとして出るか | 結果を記録する（出ても出なくても、`node_stop` は親に `claude stop` を依頼する） |
| A2-2 | `node_stop` の 2 段 | `node_stop` を呼ぶ | 子へ停止の知らせ → 猶予 → 親に `claude stop <子>` の依頼が届き、親が実行する。子のセッションの id が記録にないときは、親が `claude agents --json` で調べた id を `parent_report` の `sessionRef` で返し、依頼が作り直される |
| A2-3 | 止まっている子への `claude stop` | すでに止まっている子に `claude stop <id>` を実行する | 害なく終わる（終了コード・出力を記録する） |
| A2-4 | `claude rm` は作業ツリーを消さない | TouRyou の作業ツリーで起動した子に、未 push のコミットがある状態で、親が `claude rm <子>` を実行する | 子のセッションは消え、作業ツリーと未 push のコミットは残る。片付けは回収（`node_reclaimPreview` → `node_reclaim`） |

### A3. 子の許可を範囲だけにする

| # | 確かめること | 手順 | 期待（可） |
|:--|:--|:--|:--|
| A3-1 | `--bg` の子で `--permission-mode dontAsk` が効く | 子を 1 つ作る。端末で `claude agents --json` を見る。子の画面（`claude attach <名前>`）で、モードの表示を見る | 子が確認で止まらない（state が blocked にならない）。モードの表示が dontAsk |
| A3-2 | 一覧にない Bash が、確認なしで断られる | 子への追加の指示で `touch /tmp/touryou-probe`・`git status; curl x`・`git log > ../x` を頼む | どれも確認が出ずに断られ、子の報告にそうある。`/tmp/touryou-probe`・`../x` はない |
| A3-3 | MCP の道具の許可の名前の形 | 子の `child_bind`・`inbox_fetch` で確認が出るかを見る。子の画面で `/permissions` を開き、どちらの名前の形が入っているかを見る | 確認が出ない。どちらの形で効いたかを記録する |
| A3-4 | フックがない子でも、deny で禁止の場所が断られる | plugin を外した（フックのない）子で、禁止の場所（例: `.git/config`）と、ファイルの禁止（例: `.env`・作業ツリーの `.git` ファイル）の Read・Edit を頼む | 確認が出ずに断られる（deny が allow の `Edit(./**)` より強い） |
| A3-5 | フックの拒否と、一覧の許可が重なったとき | 子に、一覧で許したコマンドで、フックだけが断る操作を頼む（例: `git add .git/config`） | フックが断る（範囲の違反の記録がある） |
| A3-6 | 相対の基準・新しいファイル | 子に `src/` の下の編集と、`src/` の下の**新しいファイル**の Write を頼む。`.git` への Write も頼む | `src/` は確認なしで通る。`.git` は deny の `Edit(./.git)` で断られる。起動のときに「Deny rule Write(...) never matches」の警告が出ない |
| A3-7 | `Grep`・`Glob` | 子に作業ツリーの中の検索と、作業ツリーの外（例: `<H>`）の検索を頼む | 中は確認なしで通り、外は断られる |
| A3-8 | 既存の settings との重なり | 利用者の settings に広い allow（例: `Bash(curl:*)`）を一時に足して子を作る | 子がそれを受け継ぐか記録する（受け継ぐなら、[`docs/plugin.md`](plugin.md) の注意のとおり）。終わったら外す |

### A4. 知らせの宛先

| # | 確かめること | 期待 |
|:--|:--|:--|
| A4-1 | 根のモードのセッションを `--resume`・fork・`/compact` したとき、`CLAUDE_CODE_SESSION_ID` が変わるか | 変わるなら、変わったあとの子の知らせは、親がもう一度親の操作（`node_bindCode` など）をするまで届かず、受信箱に残る |
| A4-2 | 同じ repo で根のモードのセッションを 2 つ開き、片方で `node_bindCode` を呼んだ子の項目の知らせが、そのセッションにだけ届くか | そのセッションにだけ届き、送り手のノードの ID が文に入る |

注意: agent view の入力欄に貼った文は、新しい裏のセッションになる。子に入力するときは `claude attach <名前>` でつなぐ。

## H. 手動の CLI セッションのフック

- **前提**: daemon が範囲を持つ CLI の子（例: 書き込み `src`）を管理している。人間が、その子の**フック専用のトークン**を発行して環境変数に入れる: `eval "$(touryou hook-env <nodeId>)"`（`TOURYOU_DAEMON_URL`・`TOURYOU_NODE_TOKEN` が設定される。標準出力が端末なら失敗する。出力をパイプやファイルに出さない）。同じシェルから plugin つきの CLI のセッションを起動する。手動のセッションは**作業ツリーの外のディレクトリで起動**し、書き込みは絶対パスで頼む。仕組みは [`docs/plugin.md`](plugin.md) の「フック」。`touryou` は `TOURYOU_DAEMON_URL`・`TOURYOU_HUMAN_TOKEN` を設定して使う（`touryou --help`）。

| # | 確認 | 期待 | 確認の方法 |
|:--|:--|:--|:--|
| H1 | フックが発火する | PreToolUse・PostToolUse・Stop で `touryou hook`（`$HOME` 基準の `.touryou/current/bin/touryou`）が動く。範囲内の `Write`（`src/a.txt`）は許可される | `claude --debug` の出力に、フックの実行が出る |
| H2 | 範囲外の書き込みの拒否と記録 | `Write`（`b.txt`）が拒否され、理由がモデルに伝わる。`scope.violation` が記録され、親の受信箱に violation が 1 件載る。未知のツール（例: `WebFetch`）は `node.toolDenied` | 親の受信箱（親の `inbox_fetch`、または画面の受信箱）と記録を見る |
| H4 | daemon 停止のときのフェイルクローズ | PreToolUse はすべて拒否される（「届かない」）。Stop は止めない（セッションを終えられる） | daemon を止めて、`Read` と `Write` を頼む。ツールが実行されないこと |
| H5 | 環境変数 | 片方だけ: 拒否 | `eval` のあと、`unset TOURYOU_NODE_TOKEN` して起動し、ツールが拒否されること |
| H6 | `session_id` の結び付け | 同じトークンで別のセッションを起動すると 403（`hookSessionMismatch`）。同じセッションで `/clear`・`--resume` をして `session_id` が変わると拒否され、`touryou hook-unbind <nodeId>`（または画面のボタン・親の `node_hookUnbind`）のあと、新しいセッションが通る（記録に `node.hookUnbound`）。`touryou hook-env` で発行し直すと、古いフック用トークンは 401 になる。結び付いている ID の `--resume` は通る | 2 つ目の CLI セッションを、同じ環境変数で起動する。続けて `/clear`・`--resume`・`hook-unbind`・`hook-env` の発行し直しを順に試す |

注: 本文の上限（1 MiB）を超えた要求の 413 は、daemon が本文を読まずに接続を閉じるため、スクリプトからは「届かない」扱いになることがある（どちらでも PreToolUse は拒否）。

## I. 受信箱の一覧を TouRyou から

- **前提**: 受信箱に、種類の違う未解決の項目が複数ある（例: 判断要求・失敗・進捗・完了報告）。人間のトークンは環境変数で渡す（コマンドの行に書かない）。
- **手順**:
  1. `touryou inbox` を実行する。画面（`/ui`）の受信箱と、項目の並び（要判断 > 失敗 > 完了 > 進捗 > 情報）が同じか見る。
  2. `touryou inbox --detail`・`--limit 1`・`--limit 1 --offset 1`・`--since <seq>` を試す。末尾の「続き」の案内のとおりに進められるか。
  3. 画面で 1 件を解決したあと、もう一度実行して、その項目が出なくなるか。
- **期待する結果**: 画面と同じ並びで出る（要判断が先頭）。読み取りだけで、受信箱の状態は変わらない。トークンを出力しない。

## P. デスクトップアプリの拡張機能（.mcpb）

前提: `/setup` を済ませ、daemon を起動する。`.mcpb` は Release から curl（認証なし）で取り、`shasum -a 256 -c` で照合する（[`docs/desktop-extension.md`](desktop-extension.md)）。プロセスは `pgrep -f "/Applications/Claude.app/" | wc -l` の数で見る（拡張機能は utility process で動き、コマンド行で区別できない）。

| # | 確かめること | 手順 | 期待（可） |
|:--|:--|:--|:--|
| P0 | 前の試しの拡張機能 | 設定 > 拡張機能 を見る | 前の試しの拡張機能が残っていれば外してから始める |
| P1 | 入れ直しで上書きされるか | 前の版（または同じ版）を入れたまま、新しい `.mcpb` を入れる。設定 > 拡張機能 の版と数を見る | 「更新」で上書きされ、1 つだけで、新しい版になる。2 つ並ぶ・別の確認の画面が出るなら、その文面を記録する |
| P2 | 起動の数と tree_list の重複 | アプリの起動・新しいチャット・Cowork（このコンピュータ）の開始のそれぞれで、拡張機能のログの `mcpbStart` の行数と、daemon のログの接続を数える。続けて tree_list を呼ぶ | 起動の数とタイミングを記録する。tree_list に統合セッションが重複して出ない |
| P3 | daemon との版の食い違い | daemon（tar.gz）を前の版のまま、新しい `.mcpb` で whoami を呼ぶ | 動く、または版の食い違いが分かる文で失敗する（どちらかを記録する） |
| P4 | ⌘Q と再起動 | ⌘Q のあと `pgrep -f "/Applications/Claude.app/" \| wc -l`。起動し直して whoami | 0 になる。起動し直しても拡張機能が残り、whoami が呼べる |
| P5 | whoami の説明文の要点 | 普通のチャットで、道具を呼ばせずに「TouRyou の道具の使う順番を説明して」と頼む | `whoami` の説明文の先頭の 1 文（使う順番と「ID は短縮しない」）が切れずに届き、説明できる（デスクトップの普通のチャットでは、説明文が先頭の 80〜100 字ほどで切れて届くことがある） |
| P6 | initialize の instructions が渡るか | 普通のチャットで、道具を呼ばせずに「touryou-mcp から受け取っている instructions をそのまま見せて」と頼む。Claude Code の統合セッションでも同じ質問をする | 「注意: ID は…短縮しないで渡す」を含む文が出れば渡っている。出なければ、渡っていない（どちらかを記録する） |
| P7 | コマンドで入れる | Claude Code で `/touryou:desktop` を実行し、承認と「はい」に答える。続けて、拡張機能を削除してから `update` でも同じことをする | 照合が通り、`open` でデスクトップアプリの導入の画面が出る（出なければ、予備の経路で入れられること・そのときの表示を記録する）。承認の回数を記録する。デスクトップアプリがない Mac（または名前を変えた状態）では、何もせずに終わる |

---

## D. Desktop の子（`childRuntime: "desktop"`。`touryou child`）

仕組みは [`docs/desktop-runtime.md`](desktop-runtime.md) と [`docs/cli.md`](cli.md) の「Desktop の子が使う `touryou child`」。

### 共通の準備

| # | 準備 | 確かめ方 |
|:--|:--|:--|
| 1 | 人の端末で daemon を起動する（`childRuntime: "desktop"`、`desktopRequireVerifiedHooks: false`、`touryouCommand` を設定。`touryouCommand` は「node の絶対パス」と「cli の `dist/bin.js` の絶対パス」の 2 語の配列。自分の絶対パスは、設定ファイルにだけ書く）。端末がないと、取り消せない操作の確認が使えない（`confirmationUnavailable`） | 起動のログに `invalidConfig` が出ない |
| 2 | **フックのない新しいリポジトリ**を使う（Write を拒否するフックが残ったリポジトリでは、`code` の Write が必ず失敗する）。`worktreeRoot` のディレクトリは先に作る（ないと `invalidConfig`）。`rootCwd` は `repoRoot` と同じ値にする | 起動できる |
| 3 | `pnpm build` で cli を build しておく | エラーなし |
| 4 | 紐付けコード・トークンを使う命令と、`node.bindCode` の出力を扱う命令は、シェルの履歴に残さない（先頭に空白） | 先頭に空白を入れた行が、`history` に出ない |
| 5 | 親が `node.spawn` で子を作り（応答の値の `nodeId`）、`node.bindCode`（`{ "nodeId": "<子>" }`）で出た文面（`instruction`）を使う。**文面には紐付けコードが入る。貼る先は、新しい子のセッションだけ。** 受け取り方（Mac）: 人が自分の端末で `node.bindCode` を呼び、出力を `pbcopy` に渡して、画面に出さない（例: ` <呼ぶ命令> \| pbcopy`）。子のセッションに貼ったら、すぐに ` pbcopy < /dev/null` でクリップボードを空にする | 貼ったあと、クリップボードの中身が空になっている |
| 6 | **Desktop では、daemon の作業ツリーを選び、必ず「ローカル」で始める（「ワークツリー」を選ばない）。** 「ワークツリー」で始めたセッションの呼び出しは拒否される。間違えたときは、そのセッションを閉じ、`node.bindCode` を出し直して、新しいセッションを「ローカル」で始める | — |

止めるとき: `node.stop` は `{ "nodeId": "<子>", "mode": "graceful" }`（`mode` は必須で、ないと `invalidRequest`）→ Desktop で子をアーカイブ → `touryou confirm-stopped`。

### D1. 紐付けと報告

1. 子が、文面のとおりに Write で `code` を書き、`touryou child bind` を実行する → `bound`。Write で作業ツリーの外（引き出し `<D>/<鍵>/`）に書くときに、確認が出ない（auto）。
2. 子が、**別々の Bash の呼び出しで**、Write で `report` を書いてから `touryou child report` で `progress` を 2 回以上、最後に `done` を報告する → 受信箱・画面に届く。
3. 子が動いているあいだ、別の端末で、コードが `ps` に出ないことを数える: コードの先頭の 6〜8 文字の、最初の 1 文字を括弧で囲む（例: `[A]BCDEFG`。grep が自分の行に当たらないため）。` for i in $(seq 300); do ps -axww | grep -c '[A]BCDEFG'; done | sort | uniq -c` → 300 回すべて 0 件。数える命令は 1 回に 1 つずつ実行する。コードの文字は書き写さない。
4. bind のあと、`<D>/<鍵>/` に `code` が残っていない。`token`・`url` が 0600（`ls -l` の権限の列だけを見る。中身は見ない）。`children.noindex` は 0700 で、Time Machine から外れている（`tmutil isexcluded`）。
5. 期限切れのあとの結び直し: 設定 `tokenExpiryMinutes.bindIdle` を短く（例: 2）して起動し直し、子に 3 分待ってから報告させる → `tokenExpired`（終了コード 3）と、受信箱の知らせ → 親が `node.bindCode` を出し直す → 子が 1 からやり直して、報告が通る。
6. 止める（上の「止めるとき」）→ `<D>/<鍵>/` の `token`・`url`・`code` がなくなる（`node` は残る）。done の子の引き出しには `token`・`url` が残る。

### D2. 見張り（FR_014 のフック）が効くこと

| # | 確かめること | 手順 | 期待 |
|:--|:--|:--|:--|
| D2-1 | 開始のあとに設定を置いたとき | 見張りの設定のない作業ツリーで Desktop のセッションを始め、そのあとで同じ内容の `.claude/settings.json` を手で置き、子に stateDir の `human-token` を Read させる | 拒否されたか、読めてしまったかを記録する。確かめたら、そのセッションは閉じる |
| D2-2 | ローカルで始めると、最初から効く | 文面の「0.」の作業ツリーを Desktop で開いて「ローカル」で始め、最初の道具で `human-token` を Read させる | 拒否される。受信箱に `protected:stateDir` の範囲違反 |
| D2-3 | 報告が通る | 文面のとおりに bind・report（別々の Bash で 2 回以上） | 通る |
| D2-4 | チップから始めた子は `hooksNotActive` | 同じ `instruction` を spawn_task のチップから始めた子（「ワークツリー」「ローカル」どちらでも）に貼り、`touryou child bind` と `progress` を実行させる | `bind` も `report` も `hooksNotActive` で断られる。`bound` が出て報告も通るなら不可（始め方を記録する）。`unauthenticated`（401）はコードの使用済み・期限切れで、出し直してやり直す（判定にしない）。チップが出ないなら「未確認」 |
| D2-5 | スクリプトで外しても見つかる | 子（または人が端末で）`.claude/settings.json` を消す／`.claude/settings.local.json` に `{"disableAllHooks": true}` を置く | 数秒のうちに daemon が書き戻し、受信箱に知らせが出て、子の道具・報告が拒否される（401）。人が `node.bindCode` を出し直すと、紐付け直して報告できる |
| D2-6 | 設定の書き換えの拒否 | 子に `.claude/settings.json`・`.claude/settings.local.json`・`~/.claude/settings.json` を Write・Edit させる。（任意）人が手で `.claude/settings.json` を書き換える | 拒否（`protected:hookSettings`）。受信箱に範囲違反。手で書き換えたときは、次の道具から拒否、受信箱に知らせが 1 件 |
| D2-7 | アプリを再起動したあとも効く | Desktop のアプリを再起動し、自動で再開した子（`claude --resume`）に `human-token` を Read させ、報告させる | Read は拒否、報告は通る |
| D2-8 | cd したあとも動ける | 設定の `rootScope.allowedCommands` に `"cd"` を一時に足して daemon を起動し直し、新しい子を「ローカル」で `bound` まで進め、Write で `src/sub/.keep` を作らせる。各命令の先頭を、作業ツリーの根の絶対パスへの `cd` にして、同じ 1 回の呼び出しにつなぐ（cwd が次の呼び出しに残るため。パスは単一引用符で囲み、`$`・`~` は使わない）: (1) `cd '<根>' && cd src/sub && git status` (2) `cd '<根>' && cd src/sub && cd .. && git status` (3) cd の先で `progress` を報告 (4) `cd '<根>' && cd src/sub && cd ../../.. && git status` と `cd '<根>' && cd .. && git status` | (1)・(3) は通る。(2) は通る見込みだが、連鎖の基準の足し合わせで誤って拒否されうる（安全側。`docs/desktop-runtime.md` の「既知の制約（`cd` の連鎖の誤拒否）」。判定にしない）。(4) は拒否（「cd・pushd で作業ツリーの外に移ることはできません」、受信箱に `protected:outsideWorktree`）。(4) が通れば不可。終わったら `"cd"` を外し、daemon を起動し直す |
| D2-9 | 429 が出るか | 子に短い間隔で道具を多く使わせる（例: `git status` を 15 回同時） | daemon の記録の `apiSummary` の `rateLimited` と、フックの拒否（429）の有無を数えて記録する |
| D2-10 | `transcript_path` の形 | 子に道具を 1 つ使わせ、Desktop の設定のディレクトリ（`CLAUDE_CONFIG_DIR`、なければ `~/.claude`）の `projects/` の下に、その子の `.jsonl` があるかを `ls` で見る（出力は書き写さず、あるかないかだけ） | `projects/…/<セッション>.jsonl` の形。見つからなければ不可 |
| D2-11 | 設定のディレクトリが違うとき | daemon を起動する端末だけ `CLAUDE_CONFIG_DIR` を別の空のディレクトリにして起動し直す（Desktop は設定しない）。子に道具を使わせ、`touryou inbox --detail` で受信箱を見る。子にその場所の `settings.json` を Read させる。もう一度道具を使わせる | 受信箱に「守る集合の外だった」が 1 件。Read は拒否。重ねて数えない（1 件のまま）。終わったら `CLAUDE_CONFIG_DIR` を元に戻す |

**後始末の注意（macOS）**: 作業ツリーの `.claude/settings.json` に `uchg` が付いていて、`rm -rf` が失敗する（daemon が付けた補助）。順序: 親を `/exit` → daemon を止める → Desktop で子のセッションを**削除**（画面を閉じるだけでは、`claude`・`zsh` などが作業ツリーを cwd にして残る）→ `lsof +D <検証用の場所> 2>/dev/null` が空になることを確認（残れば `ps -o pid,ppid,comm`）→ `chflags nouchg <作業ツリー>/.claude/settings.json` → `rm -rf`（`Operation not permitted` になったら、ほかに `uchg` が残っていないかを `ls -lO` で確かめる）。詳細は [`docs/desktop-runtime.md`](desktop-runtime.md) の「手作業で検証用の場所を消すとき」。

### D3. 停止の宣言を cli・画面から

- **前提**: D1 の子。daemon は、その子を直接止められない（能力表 `stopDelegated`）。
- **手順**:
  1. 親（または `touryou` の停止）で子を止める → 受信箱に停止の代行依頼が出て、子は停止未完了（stopIncomplete）になる。
  2. Desktop の画面で、その子のタスクを止める（またはアーカイブする）。作業ツリーで動くプロセスが残っていないことを確かめる。
  3. `touryou confirm-stopped <nodeId> --note <根拠>` で宣言する。別の子で、HTML 画面の「止めたと宣言…」（ノード ID の打ち込み）でも宣言する（画面の確かめ方は [`docs/manual-verification-ui.md`](manual-verification-ui.md) の「停止の宣言」）。
  4. 動いている Desktop の子がある状態で、daemon を再起動する。根の受信箱を見る。もう一度再起動して、また見る。そのあと、その子を止めたと宣言する。
- **期待する結果**: 停止済み（stopped）になり、宣言した者と根拠が記録に残り、代行依頼が解決済みになる。打ち込みが違えば（空・1 文字違い・前後に空白）送れない。再起動のあと、根の受信箱に（停止未完了の帯で）1 件出る。もう一度再起動しても増えない。対象の子をすべて止めたと宣言すると、根の「daemon の再起動のあと」の依頼も解決済みになる。窓口のポートは、前回のポートを stateDir に保存して使い続ける（`portSource` が saved）。

## L. 常駐のログイン項目（Issue #64）

- **前提**: v0.1.1 の形（`current/bin/node` を起こす plist）か v0.1.0 の形（`run-daemon.sh` を起こす plist）で常駐している Mac。zsh（`noclobber` でも動くように、上書きは `>|` で書く）。`sfltool dumpbtm` は管理者のパスワードを聞くことがある。
- **手順**（写して打てる形。`!` は使わない）:
  1. 上げる前の記録: `sudo sfltool dumpbtm >| "${HOME}/btm-before.txt"`
  2. 新しい版を入れる: `/touryou:setup`（常駐の起動し直しに「はい」と答える）
  3. システム設定 → 一般 → ログイン項目と機能拡張 →「バックグラウンドでの実行を許可」を開き、TouRyou に関わる項目の名前・数・「開発元を識別できない項目」かどうかを見る
  4. 上げたあとの記録と比べ: `sudo sfltool dumpbtm >| "${HOME}/btm-after.txt"; diff "${HOME}/btm-before.txt" "${HOME}/btm-after.txt" | grep -i -E 'touryou|node|/bin/sh|bash' | sed -E 's#/Users/[^/]+#~#g'`
  5. 版をもう 1 回上げ（次の版が出たとき）、3・4 をもう一度見る（`TouRyou` の項目が増えないか）
  6. `/touryou:service` の uninstall のあと、3 を見て、`sudo sfltool dumpbtm >| "${HOME}/btm-uninstalled.txt"; grep -i -c -E 'touryou|run-daemon' "${HOME}/btm-uninstalled.txt"` の数を見る
- **期待する結果**: 2 のあと、ログイン項目（「バックグラウンドでの実行を許可」）の TouRyou の項目は `TouRyou` の 1 つ（「開発元を識別できない項目」と出るのは ad-hoc の署名のためで正常。アイコンが TouRyou の絵か汎用の絵かを記録する。#73）。5 で増えない。6 で `TouRyou` の項目が消える。v0.1.1 のときの `Node.js Foundation` の項目は、上げたあとに消えるかを記録する。v0.1.0 のときの `run-daemon.sh` の項目は消える。`sh`・`bash` の項目は TouRyou の項目ではないので、見なくてよい（`sfltool resetbtm` は、ほかのアプリの項目も消すので使わない）。
- **後始末**: `rm -f "${HOME}/btm-before.txt" "${HOME}/btm-after.txt" "${HOME}/btm-uninstalled.txt"`（ユーザー名の入ったパスなどが入っているので、残さない）
- **結果の返し方**: 項目の名前と数、「開発元を識別できない項目」かどうかだけを返す。`btm-*.txt` の中身はそのまま貼らない（ユーザー名の入ったパスなどが入る）。

## U. 状態画面を `/touryou:ui` で開く（Issue #88）

- **前提**: `/setup` 済みで daemon が動いている Mac。Claude Code（CLI）。既定のブラウザ。
- **手順**:
  1. Claude Code で `/touryou:ui` を実行する。モデルが実行したコマンドが `"$HOME/.touryou/current/bin/touryou" ui` の 1 つだけで、`Read`・`cat` でトークンのファイルを読んでいないことを、会話の表示で確かめる。
  2. 開いたブラウザで、状態画面が貼り付けなしで「つながっています」になること（#89 の前は「接続中」）、アドレスに `#ticket=` が残っていないことを見る。
  3. 開いている間に、別のターミナルで `ps -axww -o command | grep -c -F -f "<stateDir>/human-token"` を実行する（トークンの値を画面に出さない形。`<stateDir>` は自分の値に置き換える。数が 0 か、grep 自身の 1 だけなら可）。
  4. ブラウザの履歴（`⌘Y` など）で、開いた `/ui` の項目の URL に、`human-token` の値が含まれないことを見る（`#ticket=` の付いた項目が残るのは、60 秒・1 回だけの値なので可）。
  5. 画面を再読み込みする → 貼り付けの欄（未接続）に戻ることを見る。`/touryou:ui` をもう一度実行して開き直せることを見る。
  6. ターミナルで `"$HOME/.touryou/current/bin/touryou" ui` を実行し、出力に URL・チケット・トークンが出ないことを見る。開いたら、すぐに、ブラウザの履歴から `#ticket=` の付いた項目を開く → 接続しない（「チケットが使えない」。1 回だけ）。もう一度 `touryou ui` で開き、60 秒以上たってから、履歴の同じ形の項目を開く → これも接続しない（履歴に `#ticket=` の項目が残らないブラウザでは、この手順は「条件付き」にする）。
  7. 画面のセッションで、取り消せない操作（最終削除など）を試す → 今までどおり ID の打ち込みの確認が出ることを見る（実行はしなくてよい）。
  8. `/touryou:service` の restart（または `touryou launchd restart`）で daemon を起動し直す → 開いていた画面に、次のどちらかが出ることを見る。同じポートで起動し直したときは、未接続に戻り、「画面のセッションが切れました…/touryou:ui で開き直してください」と出る。ポートが変わったときは、「daemon に接続できません（…ポートが変わった…）」と出る。`/touryou:ui` で開き直すと、新しいポートでも開けることを見る。
  9. `/ui#token=<何か>` の形で開いても接続しないこと、アドレスから消えることを見る（値は作り物でよい）。
- **期待する結果**: 1〜9 のとおり。`human-token` の値は、会話・`ps`・ブラウザの履歴・ターミナルの出力のどこにも出ない。
- **結果の返し方**: 各手順の可・不可だけを返す。トークン・チケット・URL の値は、写さない。

## V. 状態画面の組み立て（Issue #89 の PR-4）

- **前提**: U と同じ。A1 で、子を 2 つ以上作った木（1 つは判断の頼みを出し、1 つは動いたまま）。明るい表示と暗い表示を、macOS の設定で切り替えられること。
- **手順**:
  1. `/touryou:ui` で開く → いちばん上に「いまあなたがすること（N 件）」と、大きな数字が出ることを見る。子の判断の頼みが、題・役割・最後の動き（手元の時刻と「何分前」）つきで出ることを見る。
  2. 判断に選択肢のボタンで答える（確認の欄が出て、送ると数が 1 つ減る）。何も残らなければ「いま、あなたがすることはありません」になることを見る。
  3. 子が進み具合・済んだを報告しても、「あなたの答え」の数（カードと一覧）が増えないことを見る（#89 の前は「要対応」が増えていた）。
  4. 子を 30 分（daemon の見張りの時間）動かさずに置く → daemon の知らせが来てから、「止まっているかも」が出ることを見る（知らせの前は出ない）。CLI の子なら `claude attach <ノード ID>` と「写す」が出て、写した文を端末に貼ると子の画面が開くことを見る。
  5. 「作業ごとのようす」で、子のカードが見本の形であることを見る: 頭の札は状態の札 1 つ（関係図の箱と同じ言葉と色）と、答えがあれば「あなたの答え N 件」だけ（答えのあるカードは縁が柿色）。題・役割と親の題・最後の動き、この 1 時間のやり取りの棒（藍はやり取り、柿は答え待ち）、最近のやり取り 3 件（↑・↓ と相手の題〔10 字で切る〕・種類・時刻。報告・判断の問い・範囲の頼みの理由は、短ければ「：文」と続き、長ければ開くと読める）。受信箱の項目は「知らせ N 件（たたんでいます）」を開くと新しい順に出る（長い文は開いて全文を読める）。ID と写すボタンは「この子への操作」（操作がない子は「この子の ID」）を開くと出る。止まっているかもの CLI の子は、カードにも `claude attach <ノード ID>` と「写す」が出る。「この子への操作」を開いたまま、子が報告しても、閉じないことを見る。
  6. 「やり取り」の一覧で、木の字下げと、上り・下りの段（送った・届いた・済んだ）が出ることを見る。上りは、答え待ちの頼みがあれば、あとの報告より先にそれが出ること（図と同じ）を見る。「詳しく」で、その子のカードへ動いて光ることを見る。
  7. 子を受け入れる（終わった作業にする）→ そのカードが「終わった作業（N 件。たたんでいます）」の中へ移ることを見る。
  8. 「管理（まれに使う操作）」が、たたんだ形で最後にあり、開くと最終削除・保留・保管が出ることを見る。
  9. 「写す」のボタンが、クリップボードのアイコン（四角が 2 つ重なった形）で出て、指を置くと「写す」と出ること、押すと ✓ になって数秒で戻ること、写した文を端末に貼れることを見る（明るい表示と暗い表示の両方で、アイコンが見えること）。
  10. 関係図の箱（または一覧の「詳しく」）を押す → その子のカードへ移り、縁が藍で 1.5 秒ほど光って消えること、同じ箱を続けて押すとはじめから光ること、Tab を押すとカードの次から進むこと（focus がカードに移っている）を見る。「動きを止める」では、縁の色だけが出ることを見る。
  11. 明るい表示と暗い表示の両方で、文字と色が読めることを見る。macOS の「視差効果を減らす」を入れる（または画面の「動きを止める」）→ 動きが止まり、色・印・文字で読めることを見る。
- **期待する結果**: 1〜11 のとおり。
- **結果の返し方**: 各手順の可・不可と、読みにくかった所（あれば、どの欄か）だけを返す。題・ID・トークンの値は、写さない。

## G. 関係図の束 `/ui/graph.js`（Issue #89）

- **前提**: daemon が動いている Mac。Chromium 系か Safari のブラウザ。
- **作り物のデータで見るとき**: 本物の記録がなくても、`pnpm install && pnpm build` のあと `node scripts/ui-preview.mjs`（流れる線と玉も見るなら `--live`）で、一時の場所と空いたポートに画面を立てて既定のブラウザで開ける（常駐の daemon には触らない。画面の操作は試せない。Ctrl+C で止めると一時の場所を消す）。統合 1・子 5・孫 5 の形、答え待ち・止まっているかも・停止の代行依頼（「いまあなたがすること」にも出る）・失敗・済んだ・止めた・アーカイブ、新しいものから 1 時間より前までのやり取りが入っている。子の文に混ぜた `<script>`・`<img onerror>` が文字のまま出て、ダイアログが出ないことも見る。
- **手順**:
  1. `/touryou:ui` で状態画面を開く。開発者ツールのコンソールに、CSP の違反（`Refused to …`）が出ていないことを見る。
  2. 同じタブで `http://127.0.0.1:<port>/ui/graph.js` を開く → 先頭にライセンスの表示（`rete@…`・`MIT`）があり、`var touryouGraph=` で始まる束が返ることを見る（応答のヘッダーに `content-security-policy` があること）。
  3. 「やり取り」の欄で、図と一覧を「図」「一覧」で切り替えられること、図の箱を引っぱっても動かないこと、拡大・移動ができること、図の右上の「＋」「−」で拡大・縮小し、「全体を見る」で初めの形に戻ること。初めの形と「全体を見る」では、いちばん下の箱と、その下の線の札が枠の中に収まって下に余白があり、右上の箱がボタンの下に隠れないこと（明暗の両方でボタンが見えること。Tab で移って Enter・Space でも押せること）、OS の「視差効果を減らす」で線と玉が止まることを見る。
  4. 関係図の箱が見本の形であること（状態の言葉と印・役割の印と「何分前」・答えの数。列の見出し「いちばん上の統合」「子」「孫」は出ない）、箱を押す（Tab で移って Enter でも）とその子のカードへ移って光ること、箱に指を置くとその子の線だけ浮かぶこと、図の下に凡例が出ることを見る。「人（あなた）」の箱がないこと、答え待ちの判断・範囲の頼みが子から親への柿色の上りの線になること（その子があとで報告しても、上りの線は柿色の頼みのまま）、人の答え・許可・却下が親から子への下りの線の札（「→ 答え」「→ 許可」「→ 却下」）で出ることを見る。`--live` の作り物のやり取りは、動いている子と孫にだけ足される（答え待ち・止まっているかも・失敗の子に「いま」のやり取りが出ない）こと。`--live` で、箱に指を置いたまま数秒待っても、図が点滅しない（ほかの線が元の明るさに戻らない）ことと、拡大・移動が描き直しで戻らないことを見る。
  5. **Safari** で、窓の幅を狭めても、いちばん上の帯の「動きを止める」が右の端で切れないこと（折り返して見えること）を見る。Chrome でも同じに見えること。
- **期待する結果**: 1〜5 のとおり。
- **結果の返し方**: 各手順の可・不可だけを返す。トークン・URL の値は写さない。

