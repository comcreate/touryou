# 人間用コマンド `touryou`

`touryou` は、人間が daemon の窓口（`POST /v1/request`）を呼ぶコマンド（`packages/cli`。`pnpm build` のあと `packages/cli/dist/bin.js`、
workspace では `pnpm --filter @touryou/cli exec touryou …`）。使い方は `touryou --help`。

## 窓口と人間のトークンの渡し方

**窓口・トークン・設定は、環境変数だけで渡す**（コマンドの引数には置かない。`ps` のプロセス一覧・シェルの履歴に出さない）。`--token` のような引数はない。

| 環境変数 | 内容 |
|:--|:--|
| `TOURYOU_DAEMON_URL` | daemon の窓口（例: `http://127.0.0.1:7777`。ループバックだけ）。なければ、daemon の設定の `stateDir` の `port` から作る |
| `TOURYOU_HUMAN_TOKEN` | 人間のトークン（`<stateDir>/human-token` の中身）。なければ、そのファイルを自分で読む |
| `TOURYOU_DAEMON_CONFIG` | daemon の設定ファイル。`stateDir` の `daemon-identity` で、トークンつきの要求の直前に毎回、daemon の身元を確かめる（`touryou-mcp` と同じ。`docs/daemon-identity.md`） |
| `TOURYOU_CLI_ALLOW_UNVERIFIED` | **ちょうど `1`** のときだけ、`TOURYOU_DAEMON_CONFIG` なしで、身元の確認なしで動く（**開発用**。手元の開発のビルド〔`pnpm build`〕だけで効き、**配布物〔Release の tar.gz〕では効かない**。`scripts/dist-build.sh` が `packages/cli/src/dev-build.ts` の `DEV_BUILD` を `false` にする） |

```sh
export TOURYOU_DAEMON_URL=http://127.0.0.1:7777
export TOURYOU_DAEMON_CONFIG=/path/to/daemon-config.json
export TOURYOU_HUMAN_TOKEN="$(cat /path/to/state/human-token)"   # トークンを、コマンドの行に直接書かない
touryou reclaim <nodeId>
```

- CLI が出す案内（「再実行する」など）のコマンドは、本体の場所 `"$HOME/.touryou/current/bin/touryou"` で始まる（PATH に `touryou` がなくても、そのまま貼って動く。#115）。
- **環境変数は、なくてよい**（#115）。`touryou reclaim` などの人のコマンドは、`touryou ui` と同じく、`$HOME/.touryou/config.json`（`TOURYOU_DAEMON_CONFIG` があればそれ）の `stateDir` から、窓口（`port`）・人間のトークン（`human-token`。自分だけが読める・リンクでないファイルだけ）・身元の確認の秘密を自分で読む。環境変数があれば、それを先に使う。トークンは、引数・標準出力・標準エラー・履歴に出さない。
- 窓口・人間のトークンが、環境変数にも設定にもない、または `TOURYOU_DAEMON_CONFIG` がない（開発のビルドで `TOURYOU_CLI_ALLOW_UNVERIFIED=1` でない）ときは、何も送らずに終了コード 2。
- daemon の身元を確かめられないとき（`daemon_identity_failed`）は、トークンを送らずに終了コード 1（操作は実行されていない）。
- 出力・エラーを出す直前に、文字列の中の `TOURYOU_HUMAN_TOKEN` の値を `***` に置き換える（daemon や偽の窓口が、応答にトークンを入れても出さない）。中継（relay）も、トークンと本文を、失敗の文面・記録に入れない。
- 置き換えるのは、トークンの値と完全に一致する部分だけ（一部だけを含む文字列は、そのまま出る）。

## 中継の振る舞い（mcp の relay と同じ）

窓口の呼び出しは、`touryou-mcp` の中継（`@touryou/mcp/relay`）をそのまま使う。ループバックだけの URL、身元の確認、本文・応答の上限 1 MiB、
操作ごとのタイムアウト、429・409 `inProgress` の再送（`Retry-After`〔上限 10 秒〕＋ジッターだけ待って 1 度。同じ `requestId`）、
接続の失敗の再送（1 度。同じ `requestId`）。

- `--request-id <id>` を付けると、その識別子で要求する（前回の結果が確認できなかったときの再実行。daemon が重複を防ぐ）。付けなければ、新しく作る。
- 応答を受け取れなかった・不正な応答のときは「結果が確認できない」として、同じ `requestId` で再実行するコマンドを出す（終了コード 1）。

## 状態画面を開く `touryou ui`

`touryou ui`（引数なし）: 状態画面を、既定のブラウザ（macOS の `open`）で開く。**環境変数の `TOURYOU_HUMAN_TOKEN`・`TOURYOU_DAEMON_URL` は使わない**。`$HOME/.touryou/config.json`（`TOURYOU_DAEMON_CONFIG` があればそれ）の `stateDir` から、`port`・`human-token`・`daemon-identity` を自分で読み、daemon の身元を確かめてから、使い捨てのチケット（60 秒・1 回だけ）をもらって `http://127.0.0.1:<port>/ui#ticket=<チケット>` を開く（くわしくは `docs/ui.md` の「認証」）。

- トークン・チケット・URL は、標準出力・標準エラーに出さない。`open` の引数（`ps` に出る）は、使い捨てのチケットだけ。
- 失敗（設定・`port`・`human-token` が読めない、daemon に届かない、身元が合わない、チケットをもらえない、ブラウザを開けない）は、原因と次の操作を出して終了コード 1。ブラウザを開けない（macOS でない・`open` が失敗した）ときは、「Mac のターミナルで `touryou ui` を実行してください」と出す。引数を付けたら終了コード 2。
- plugin の `/touryou:ui` は、これを 1 回実行するだけ。

## 版の確認 `touryou --version`

`touryou --version`（`-v` も同じ）は、入っている配布物の版を 1 行で出す（窓口・トークンは使わない。daemon の起動も不要）。`touryou-daemon --version`・`touryou-mcp --version` も同じ。daemon・mcp・cli の版の食い違いの切り分けに使う。

- 版の出どころの優先順: 拡張機能（`.mcpb`）の埋め込み → tar.gz の起動スクリプトが渡す環境変数 `TOURYOU_DIST_VERSION` → tar.gz の版の印 `lib/dist-version`（daemon だけが読む。launchd が同梱の node で直に起こすとき。#64） → 隣の `package.json`。
- 開発のビルド（source から動かしているとき）は、`package.json` の版に「（開発ビルド）」を付けて出す（配布物と区別するため）。

## 木・状態の確認 `touryou tree` / `touryou state`（読み取りだけ）

人が、子の状態（木）を見るためのコマンド（統合ノードの `tree.list` の人間版。人間のトークンで読む）。読み取りだけ。

```sh
touryou tree                 # 全ノードを表で: ID・役割・状態・親・依存・未解決の受信箱の数
touryou tree --json          # 同じ内容を JSON で（機械可読）
touryou tree <nodeId>        # 1 つのノードの詳しい状態
touryou state <nodeId>       # touryou tree <nodeId> と同じ
touryou state <nodeId> --json
```

- 人間は全ノードを見られる（統合ノードは自分の部分木だけ）。トークン・秘密・作業ツリーの絶対パス・最終コミットは含めない。
- 止まった子の未回答の判断は、表の `pendingDecision` 列（「N（届かない）」: 破棄を決めて閉じた判断。「N（止まった子）」: 動いていない子の open の判断）に出る。`--json` と `touryou tree <nodeId>` では、各ノードの `pendingDecisions`（`{ undeliverable, stopped }`）として出る。古い daemon はこの欄を返さないので、そのときは 1 ノードの表示に行が出ない。

## 判断要求の確認と回答 `touryou decisions` / `touryou answer`

子が出した判断要求（decision）に、人が答えるためのコマンド（`decision.answer` の人間版。画面〔`/ui`〕と同じことを CLI でできる）。

```sh
touryou decisions                              # 未解決の判断要求の一覧（decisionId・ノード・子の状態・問い）
touryou decisions --json
touryou answer <decisionId>                    # 答える前に、判断の中身（ノード・子の状態・問い・選択肢）と照合の値を表示するだけ
touryou answer <decisionId> --text "<文>" --yes --expect <digest>        # 自由記述で答える
touryou answer <decisionId> --choice "<選択肢>" --yes --expect <digest>  # 選択肢で答える（表示に出た選択肢の文をそのまま渡す）
```

- `touryou reclaim` と同じ考え方で、**`--yes` がなければ、判断の中身を表示するだけで答えない**。表示には照合用の値（`--expect` に渡す 12 桁の 16 進）が出る。**`--yes` には `--expect` が要る**（ないと、何も答えずに終了コード 1）。表示のあとで中身が変わっていると答えない。
- `--text` と `--choice` は同時に指定できない。選択肢のある判断で `--choice` を使うときは、表示に出た選択肢の文と一致していないと受け付けない（`--text` で自由に答えることはできる）。
- 判断の status が `open` でなければ（答え済み・`closed`〔人が破棄を決めて閉じた〕・まだ知らない値）、表示だけで止めて答えない（終了コード 1。理由に status と、あれば閉じた理由を出す）。`touryou decisions` でも、open でない判断は「答えられない」と出る。
- 表示には、判断を出した子の状態が出る。子が `waiting`・`running` でなければ（止まった子など）、「この子は <状態> なので、答えは子に届かない（記録は残り、回収の片付けにはなる）」と出る。
- 答えたあとは、daemon が返す `delivery`（回答を子に届けたか）を出す。`delivered` なら「答えを子に届けた」と、`deliveredVia` で届け方（「答えを添えて、子を再開した」か「追加の指示として。子は受信箱で読む」）、`skipped` なら「答えは子に届けていない（届ける手段がないか、子が動いていない。記録は残る）」。古い daemon は `delivery` を返さないので、そのときは今までどおり子の状態から見込みを出す。

## 入れるもの

`@touryou/cli` は、中継のために `@touryou/mcp` に依存する。そのため、`@touryou/cli` を入れると、mcp の依存（MCP SDK・zod）も一緒に入る。ただし、`touryou` は
`@touryou/mcp/relay`（relay・identity だけ）しか読まないので、実行時に MCP SDK・zod は読み込まない（試験で確かめている）。

## 終了コード

0 成功 / 1 失敗・結果が確認できない / 2 引数・環境の誤り / 3 子のトークンの期限切れ（`touryou child report` だけ）

**Desktop の木（設定 `childRuntime: "desktop"`）では、`touryou purge`・`touryou discarded-drop`・回収の指示（`node.reclaimInstruct`）は、すぐには実行されない**。daemon は確認待ちにして `confirmationRequired` を返す（終了コード 1）。daemon の端末（`/dev/tty`）に出たコードを、画面（`/ui`）のいちばん上の「確認待ち」の欄に打つと、実行する。daemon が端末なしで動いているときは `confirmationUnavailable`（終了コード 1。端末から daemon を起動する）。CLI の子だけの木は、今までどおり。詳しくは [`docs/desktop-runtime.md`](desktop-runtime.md) の「取り消せない操作の確認」。

## Desktop の子が使う `touryou child`

`touryou child bind`・`touryou child report` は、Desktop の子が、daemon に紐付けて報告するためのコマンド。人間のトークン・環境変数（`TOURYOU_DAEMON_URL` など）は使わない。使うのは、子の引き出し `<D>/<鍵>/`（daemon が 0700 で作る。`docs/desktop-runtime.md` の「子の引き出し」）のファイルと、引数の窓口の URL だけ。手順の文面は、`node.bindCode` が出す。

| コマンド | すること | 標準出力 |
| --- | --- | --- |
| `touryou child bind --dir <引き出し> --url <窓口>` | 子が Write の道具で書いた `code` を確かめて読み、**送る前に消す**。`node`（daemon が書いたノード ID）と一緒に `POST /v1/bind` へ送る。受け取ったトークンを `token`、窓口を `url` に置く（一時ファイル〔O_EXCL・O_NOFOLLOW・0600〕に書いて rename） | `bound`、または失敗の記号 1 行 |
| `touryou child report --dir <引き出し> --url <窓口> <種類>` | 本文（子が Write の道具で書いた引き出しの `report`。`code` と同じ確かめ方で読み、送る前に消す。64 KiB まで）を送る。種類は `progress`・`out-of-scope`（本文は文）、`decision`・`done`・`scope-extend`（本文は操作の params の JSON）の 5 つだけ（子のロールの操作） | 成功は `{ok, requestId, value}` の JSON。失敗は記号 1 行 |

- **コード・トークンは、引数にも、標準出力・標準エラーにも出さない。** 報告の本文は、引き出しの `report` から読む（コマンドの文字列に入らない）が、daemon の記録・受信箱・親の会話に残るので、秘密を書かない。
- ファイルは、lstat で種類（通常のファイル・リンクでない）・持ち主・リンクの数（1）・権限・大きさを確かめてから O_NOFOLLOW で開き、fstat で同じものかを確かめて読む。`code` は子が Write で書くので 0644 でよい（書き込みの権限がグループ・他者にないこと）。`token`・`url`・`node` は 0600 でなければ読まない。引き出しは、実のディレクトリ・持ち主が自分・0700。
- `--url` は、ループバックの http(s) の窓口だけ（パスなし。`127.0.0.1`・`localhost`・`[::1]`。`127.1` は `127.0.0.1` と同じに扱い、`localhost.`・`[::ffff:127.0.0.1]` は拒否する）。**`bind` と `report` には、同じ URL を書く**。`report` は、`--url` が `url` のファイル（紐付けた窓口）と違えば、トークンを送らない（`urlMismatch`）。
- **daemon の身元を確かめる**: `bind` はコードを送る前に、`report` はトークンを送る前に毎回、`touryou`・`touryou-mcp` と同じ仕組み（`/v1/identity`）で、窓口の相手が引き出しを作った daemon かを確かめる。秘密のファイルは、引き出しの場所から決まる `<stateDir>/daemon-identity`（引き出しは `<stateDir>/children.noindex/<鍵>`。ほかの場所の引き出しは `dirInvalid`）。確かめられなければ送らない（`daemonIdentityFailed`）。daemon が止まっている・起動し直している途中（秘密のファイルがない・接続の拒否・503）なら、touryou-mcp と同じく最大 8 秒待ってかけ直し、尽きたら `daemonUnreachable`（daemon が戻ったら、同じコマンドをやり直す）。待ちの上限と、標準エラーの記録（`daemonRetry`・`daemonRecovered`・`daemonGaveUp`）の形は [`daemon-identity.md`](daemon-identity.md) の §3a。同じポートで別のプロセスが待ち受けていても、コード・トークンはそこへ送らない。
- `--dir` と値は、別の語にする（`--dir=値` の形は、作業範囲の判定で拒否される）。
- `bind` の順序: 引き出し → `node` を確かめる → `code` を読む（読めても読めなくても、すぐ消す）→ 身元を確かめる → 送る → `url` を置く → `token` を置く（`token` を置けなければ `url` も消す）。置いたあとに、ディレクトリを fsync する。
- daemon の失敗の文面は、コード・トークンを伏せ、制御文字を除き、長さを切ってから出す。`unauthenticated`（コードが使用済み・期限切れなど）のときも、会話で人（親）に `node.bindCode` での出し直しを頼むよう案内する。
- 期限切れ（`tokenExpired`）: 終了コード 3。`token` を消す。報告はもう通らないので、子は会話で人（親）に、`node.bindCode` で文面を出し直してもらう。届いた文面の手順（`code` を書く → `touryou child bind`）で結び直す。
- 結果が分からない失敗（窓口から応答がない）は、同じ本文で `--request-id <出した ID>` を付けて送り直す（同じ要求として扱われる）。
- 終了コード: 0 成功・1 失敗・2 使い方の誤り・3 トークンの期限切れ。

**`touryou child hook --dir <引き出し> --url <窓口>`**: Desktop の子のフック（Claude Code の PreToolUse・PostToolUse・Stop）のコマンド。標準入力のフック入力を、引き出しの `hook-token`（daemon が spawn・`node.bindCode` のときに 0600 で置く。24 時間の絶対の期限）で `POST /v1/hook` へ送り、判定を返す（許可は終了コード 0、拒否は 2 で、標準エラーの文が拒否の理由としてモデルに伝わる）。送る前に、daemon の身元を確かめる。PreToolUse は、**`touryou` が走り切ったときだけ**フェイルクローズ（届かない・形が違う・身元を確かめられない・`hook-token` がない・予期しない例外のときは、終了コード 2 で拒否）。429 で `Retry-After` が 2 秒以下なら、2 回まで送り直す。PostToolUse・Stop は判定しないので、失敗しても 0。トークンは出さない。
  - **守れないもの**: Claude Code は、フックが**終了コード 2 で終わったときだけ**拒否する。終了コード 1・`touryou` が起動できない（127 など）・フックの時間切れは、**許可になる**。そのため、daemon が置く settings.jsonでは、PreToolUse のコマンドを `<touryou> child hook … || exit 2`、PostToolUse・Stop を `… || true` にし、`timeout` を、`touryou` の内側の時間の合計（身元の確認と、送る 8 秒）より十分長くする（必須の要件）。
  - Desktop の子の `/v1/hook` は、フック専用のトークンだけを受け付ける（ノードのトークンは 401）。
  - **daemon を再起動すると**、フック専用のトークンと、アダプタが持つ子の範囲（どちらもメモリだけ）が失われ、Desktop の子の道具は、すべて拒否される（拒否の文に「再起動」と出る）。人は、子を止めたと宣言して、作り直す。
  - **フック専用のトークンは、発行から 24 時間で切れ**、そのあと子の道具はすべて止まる。親か人が `node.bindCode` を出し直すと、フック専用のトークンと、ノードのトークン（結び直しのあと）の両方が新しくなる。起動したときに stopped だった子の引き出しの `hook-token` は、ほかのファイルと一緒に消す。daemon は、Desktop の子の bind・報告を、そのノードの PreToolUse のフックを直前（設定 `hookFreshSeconds`。既定 30 秒）に**許可していなければ** `hooksNotActive` で断る（拒否した呼び出しは数えない。`touryou child bind`・`report` の Bash 自体がフックを通るので、フックが効いていれば、いつも通る）。**これは、設定の誤り（チップで作った子・フックのない子）を見つける検査で、敵対的な子は止められない**（子は、引き出しの `hook-token` を読んで、自分で `/v1/hook` を呼べる）。守りの本体は、フックの設定を書き換えさせない守り（[`docs/desktop-runtime.md`](desktop-runtime.md) の「見張り（FR_014 のフック）を Desktop の子に効かせる」）。

**子の作業範囲の判定（FR_014。`hook-policy.ts`）での扱い**: そのノード自身の引き出しだけ、禁じる場所（stateDir）の中のまま、次の 2 つを許す。(1) Bash の `touryou child bind|report` の `--dir` の値（引き出しそのもの）。例外が効くのは、区切りの先頭の語が `touryouCommand`（設定。なければ `touryou` か末尾が `/touryou` の語）と一致し、続く 2 語が `child` と `bind`・`report` の命令だけ。その命令の `--dir` が自分の引き出しそのものでなければ、拒否する。外すのは `--dir` の値だけで、ほかの語はふつうに判定する。(2) Write の道具で `<引き出し>/code`・`<引き出し>/report` を書くこと。引き出しの中のファイルの語（`token` とその一時ファイル `token.tmp-…` を含む）・グロブ・`cd`・読み取りの道具（Read・Glob・Grep など）は、禁じる場所のまま拒否する。ほかのノードの引き出しも拒否する。今これが効くのは CLI の子だけで、Desktop の子には、作業範囲外の拒否のフックが効くようになってから効く（`docs/desktop-runtime.md` の (a)）。

## 常駐の生成 `touryou launchd init`

`touryou launchd init [--org <組織の逆ドメイン>] [--path-prefix <ディレクトリ>]`: daemon を launchd で常駐させるための plist を `$HOME/.touryou` の下に生成する。plist は、同梱の node（`current/bin/node`）で daemon の JS（`current/lib/dist/bin.js`）を直に起こす（起動スクリプト・shell を通さない。#64）。

- 窓口・人間のトークン・環境変数（`TOURYOU_DAEMON_URL` など）は使わない（`HOME` だけ）。
- **`init` は `launchctl` を実行しない**（読み込みは、下の `touryou launchd apply`）。起動する子プロセスは、設定の検査（`touryou-daemon --check-config`）だけ。トークンの値は、生成も表示もしない。
- **生成する前に、`config.json` を daemon と同じ検査にかける**（設定の読み込み・`repoRoot`・`rootCwd`・`worktreeRoot` が実在する実パスか・`repoRoot` が git のリポジトリか。daemon は起動しない）。通らなければ、何も生成せずに終了コード 1 で止まり、理由と直し方を出す（値〔パス〕は `<パス>` に伏せる）。検査には `HOME` と plist と同じ `PATH` だけを渡す。検査を実行できない（daemon がない・古い版・時間切れ）ときは「設定を検査できない」と分けて出す。
- 既存のファイルは、黙って上書きしない。生成先がシンボリックリンクなら、辿らずに止まる。ただし、古い形（v0.1.0 まで。`bin/run-daemon.sh` を起こす plist）の生成物が、同じ `--org`・`--path-prefix` の古い `init` の生成物とバイト単位で同じなら、plist を新しい形に置き換える（違えば止まる）。`run-daemon.sh` は、`apply` が LaunchAgents の plist を新しい形にしたあとに消す（`init` と `apply` の間で止まっても、次のログインで、ない起動スクリプトを起こさないように）。
- `--org` を省略すると、plist の Label は、組織のドメインを含まない `touryou.daemon`。自分のドメインにしたいときは `--org com.example` のように付けると `com.example.touryou.daemon` になる。不正な値（小文字の英数字とハイフンのラベルを、ドットで 2 つ以上つないだ形でない）は拒否する。
- 秘密は扱わない（子の認証を外した（CLI の子は、親のセッションが `claude --bg` で起動する））。常駐は daemon だけ（子用の HTTP の `touryou-mcp` の常駐は外した）。
- 終了コード: 0 成功 / 1 前提（`/setup`）がない・設定の検査が通らない・既存と違う・権限の確認で問題 / 2 引数の誤り。
- 読み込むと、システム設定の「一般」→「ログイン項目と機能拡張」→「バックグラウンドでの実行を許可」に、**TouRyou**（1 項目）が出る。「開発元を識別できない項目」と出るのは、TouRyou に同梱した node を TouRyou の名前で手元の署名（ad-hoc）にしたためで、正常（apply は TouRyou.app を LaunchServices に登録し、uninstall は解く）（`docs/launchd.md` の 3。ログイン項目の `sh`・`bash` は TouRyou の項目ではない）。
- 手順の全体と、限界（ACL・`ps` で環境が読める点など）は、[`docs/launchd.md`](launchd.md) の「1. 生成する」。

## 常駐の操作 `touryou launchd apply|status|restart|stop|uninstall`

`touryou launchd init` の生成物を使って、launchd の常駐を決まった操作だけで行う。**これらは `launchctl` を実行する**（`init` は実行しない）。

| サブコマンド | すること |
|:--|:--|
| `apply --yes` | 前提（init の生成物。前の版の生成物が残っていないこと）と、`config.json` が daemon の検査（`init` と同じ）を通ることを確かめ（通らなければ、plist を置かず・`launchctl` を呼ばずに終了コード 1）、plist を `$HOME/Library/LaunchAgents` に置き（既存と違えば止める）、daemon を `launchctl bootstrap` し、窓口の応答（未認証の whoami が 401。約 60 秒まで）を待つ。読み込み済みなら、そのまま。`.touryou/launchd` の plist が古い形なら、`init` を案内して止める。LaunchAgents の plist が同じ PATH の古い形なら、止めてから置き換えて読み込む |
| `status` | `launchctl print` の state・pid・last exit code と、窓口の応答。last exit code が 0 以外なら、`logs/daemon.log`（plist の `StandardErrorPath`）の最後の失敗の行（`失敗 [code]: …`。値は `<パス>` に伏せ、200 字で切る）を出す。終了コード 78（前の版の起動スクリプト）なら、外し方の案内と、`logs/daemon.log` の起動スクリプトの決まった文の行だけを出す |
| `restart` | daemon を `launchctl kickstart -k` し、窓口の応答を待つ（版を上げたあと） |
| `stop` | daemon を `launchctl bootout`（前の版の touryou-mcp が読み込まれていれば、先に止める。plist は残るので、次のログインでまた動く） |
| `uninstall --yes` | 止めてから、TouRyou が生成したと判定できる plist（LaunchAgents と `.touryou/launchd`）・古い形の起動スクリプト（`.touryou/bin/run-daemon.sh`）だけを消す。判定できないものは残して終了コード 1。`logs`・`state` は残す。トークンのファイルは消さない |

- `apply`・`uninstall` は、**`--yes` がないと何もしない**（終了コード 2）。永続化・削除なので、利用者の同意を取ってから付ける（`/setup`・`/touryou:service` が定型文で聞く）。
- `apply`・`restart` が途中で止まったとき（窓口が約 60 秒で応答しない）は、**daemon は読み込み済みのまま**（KeepAlive で動き続けうる）。`touryou launchd stop` で止めるか、直してから `apply --yes` をやり直す。
- `uninstall` は、`init` が作るのと同じ内容（`--path-prefix` の違いを含む。PATH の値はファイルから取って作り直して比べる）とバイト単位で同じもの（LaunchAgents の plist は `.touryou/launchd` の plist と同じもの）だけを消す。古い形（v0.1.0 まで）も、同じ内容なら消す。LaunchAgents の plist が `.touryou/launchd` の plist と違っても、同じ PATH の古い形なら消す（`init` だけ新しい形にした場面）。LaunchAgents の plist を残したときは、古い形の起動スクリプトも残す（次のログインで、ないスクリプトを指さないように）。
- `--org` は `init` と同じ値にする（省略すると Label は `touryou.daemon`）。
- 終了コード: 0 成功 / 1 前提がない・設定の検査が通らない・既存と違う・起動の確認で問題・消せなかったものがある / 2 引数の誤り・`--yes` がない。

## 子の認証（外した）

子の認証（`childHome`・`claude setup-token`・`CLAUDE_CODE_OAUTH_TOKEN` など）は外した（CLI の子は、親のセッションが `claude --bg` で起動する）。

## 済んだと報告した子を、受理せずに片付ける（#115）

`touryou stop <nodeId> --yes`: 完了報告済み（done）の子を、受理せずに止める（猶予なしの即時停止）。止めると受理できなくなる（成果は作業ツリーに残る）。`--yes` がなければ、何も送らずに説明だけを出す。人が止められるのは done の子だけ（動いている子は親の統合が止める）。停止を確かめた（stopped）あとは、`touryou reclaim <nodeId>` の表示を見て、`--yes --expect` で破棄して回収する。作業ツリーもブランチも、もうない子も、同じ手順で破棄して回収できる（記録だけを archived にする）。daemon が作業ツリーの情報を確かめられない子は、`touryou reclaim` が破棄を指示せず、理由と次の操作を出す（終了コード 1。くわしくは [`docs/reclaim-loss.md`](reclaim-loss.md) の「作業ツリーもブランチも、もうないノード」。#137）。

