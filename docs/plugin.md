# plugin の使い方（CLI の分）

`plugin/` は、Claude Code の plugin です。統合セッションと子のセッションに、役割の手順（skill）と、起動の案内（コマンド）を渡します。**リポジトリの場所は、plugin に埋め込みません**（NFR_012）。必要な値は、環境変数か、人間への質問で受けます。

## 中身

| 種類 | 名前 | 内容 |
|:--|:--|:--|
| skill | `integrator` | 統合ノードの手順。子の作成・追加指示・受理と差し戻し・範囲拡張の判定・回収。使うツールは `mcp__node__*`（統合ロールの全ツールを説明している） |
| skill | `child` | 子ノードの手順。進捗・判断・範囲外の申告・完了の報告・範囲拡張の要求（子ロールの全ツールを説明している） |
| skill | `adopt` | すでにある作業ツリーと、そこで動くセッションを、子として採用する手順（`node_adopt` → セッションで `/mcp` の Reconnect → `child_bind`）。下の「既存の作業ツリーを子として採用する」 |
| コマンド | `start` | 接続の確認（`mcp__node__whoami`）と、daemon の起動の案内。接続（統合セッションの MCP）は plugin の `.mcp.json` が stdio で済ませる（環境変数は要らない）。失敗の理由（`[touryou mcp] …`）ごとの直し方を示す |
| コマンド | `setup` | 配布物（macOS の arm64）を、plugin の中の script（`scripts/install-runtime.sh`。1 回の承認）で、GitHub Release から `curl`（認証なし）で取得し、sha256 が一致したときだけ、`$HOME` の下の `.touryou` に展開して `current` を付け替える。続けて設定（1 回）と常駐の登録（1 回）。承認の確認は約 3 回。auto モード（権限の自動判定）では、ほとんど出ない見込み（推測。checklist の Q7）。自動判定で止められたら、出た文面を伝えて手で許可する。チャットでの「はい」（常駐の同意・`--yes` の前）は、auto モードでも必ず取る。詳細は `plugin/commands/setup.md` |
| コマンド | `status` | 木と受信箱の読み取りだけの要約 |
| コマンド | `service` | 常駐（launchd）の daemon の確認・起動し直し・止める・外す（`status`・`restart`・`stop`・`uninstall`。`touryou launchd` のサブコマンドを呼ぶ。止める・外すは定型文で同意を取ってから）。常駐にするのは `/setup` の手順 3 |
| コマンド | `desktop` | Claude デスクトップアプリの拡張機能（`touryou-mcp-<版>.mcpb`）を、Release から curl（認証なし）で取り、`checksums.json` の `extensions.mcpb` と照合し、quarantine を確かめてから、チャットの「はい」のあとに `open` で導入の画面を出す（`install`・`update`。`docs/desktop-extension.md`） |
| MCP | `node`（`.mcp.json`） | 統合セッションの MCP サーバー（**種類 stdio**）。Claude Code が、統合セッションごとに `/bin/bash ${CLAUDE_PLUGIN_ROOT}/scripts/touryou-mcp-shim.sh`（plugin の中の中継）を起動する（正本は `scripts/mcp-stdio-command.mjs`。`pnpm validate:plugin` が完全一致を検査）。配布物があれば、中継は、標準入力を閉じた試しの起動で daemon につながるかを確かめ、つながれば `$HOME/.touryou/current/bin/touryou-mcp --stdio` を `exec` する（いつもの場合。試しの起動のぶん、起動が少し遅れる）。つながらなければ（daemon より先に会話を始めた・ログインの直後で launchd がまだ daemon を起動していない）、下と同じく待つ。まだなければ落ちずに待ち（initialize・ping・空の tools/list に応え、ほかは -32601）、配布物が現れたら、daemon が動くまで 10 秒ごとに試しに `touryou-mcp --stdio` を起動して確かめ（手で起動する人が daemon を起動しないまま会話を続けると、Node の起動が会話の終わりまで 10 秒ごとに続く。CPU・電池への影響は checklist の Q4 で測る）、daemon につながる（0 で終わる）と `notifications/tools/list_changed` を出して本物に引き継ぐ（Claude Code が道具の一覧を取り直すので、Reconnect は要らない。`claude -p` では確認済み。対話の CLI・デスクトップ版は `docs/manual-verification-checklist.md` の確認待ち）。中継は macOS の `/bin/bash`（3.2）と `sed -E` だけを使う。`touryou-mcp --stdio` は、`$HOME/.touryou/config.json` の `stateDir` から、根のトークン（`root-token` だけ。環境変数 `TOURYOU_ROOT_TOKEN` は使わない。リンクでない・自分の・権限が `-rw-------` のファイルだけ。ACL つきは不可）と、daemon の窓口（`port` のファイル）と、daemon の身元（`daemon-identity`）を自分で読む。トークンは、引数・環境変数・`.mcp.json`・ログに出ない。daemon を再起動しても、要求の失敗のときに置き場を読み直して、新しい窓口・トークンで 1 回だけ送り直す（追従する）。daemon は自動では起動しない（動いていなければ「daemon が動いていません。launchd か touryou-daemon で起動してください」で失敗し、`/mcp` に failed と出る）。標準出力は MCP の通信に使い、ログは標準エラーだけ。 |
  - **`touryou-mcp --stdio` の確認と、限界**（`packages/mcp/src/stdio.ts`）: `root-token` は、リンクを開かずに（`O_NOFOLLOW`）開き、開いたものが通常のファイル・自分の・権限の文字列が `-rw-------`（`@` は可、ACL の `+` は不可）であることを確かめてから読む（開いたものを確かめるので、確認と読む処理の間に差し替えられても、確かめたものを読む）。`$HOME/.touryou`・`stateDir`・その親は、リンクでない・自分の・権限の文字列が `drwx------` か `drwxr-xr-x`（`@` は可）であること。`config.json`・`port` も、リンクを開かず、自分の・他の人が書けない・ACL のないファイルだけを読む。ACL の確かめは共通の `@touryou/core/fs`（`packages/core/src/fs.ts`。`/bin/ls` を時間切れ 2 秒で呼ぶ。macOS は `ls -ldei` の ACL の行、Linux は `ls -ldi` の `+`。`ls` が失敗した・時間切れ・出力が想定外なら拒む。開いた fd があれば inode を照らし、通ったものは (dev, ino, ctime, mode, uid) で覚える）で、daemon の身元の秘密・紐付けのコードのファイル・`touryou child` の引き出しとその中のファイル・daemon が起動時に読む置き場・設定・`port`・トークン・引き出しの鍵・`touryou hook`／`touryou launchd`／`touryou` が読む `config.json` と `port` も、同じ確かめを使う。限界（前から）: Linux の NFSv4 ACL は `ls` に `+` が出ないので見落とす。Windows（win32）は対象外で、この確かめは全部拒む。置き場（ディレクトリ）は fd を開かないので、確かめてから使うまでの間に、置き場そのものを差し替えられる余地が残る（親のディレクトリを書き換えられることが要るので、許容する）。ctime の粒度が粗いファイルシステム（HFS+ は 1 秒）では、同じ秒のうちの ACL の付け替えを、覚えたもの（キャッシュ）が見逃しうる（付け替えには、持ち主か root が要る）。同じユーザーの別のプロセスは、`root-token` を読めるので、これは他のユーザーと、取り違えの防止で、同じユーザーからの防御ではない。
  - Claude Code は、ツールを `mcp__plugin_touryou_node__*` の名前で出す（`--plugin-dir` と marketplace から入れた場合の両方。確かめ方は `node scripts/plugin-mcp-name-check.mjs [--installed]`）。skill・コマンドは、この名前と `mcp__node__*` のどちらでも動くように書く（`allowed-tools` は両方を対にする。`pnpm validate:plugin` が検査する） |

plugin の名前空間のため、コマンドは `/touryou:start` のように呼ぶ。

## 入れ方

だれでも、次の 3 つで入れられます（plugin の取得に認証は要りません）。

```text
claude plugin marketplace add comcreate/touryou
/plugin install touryou@touryou
/touryou:setup
```

1. **marketplace を足す**: Terminal で `claude plugin marketplace add comcreate/touryou`（Claude Code の中なら `/plugin marketplace add comcreate/touryou`）。marketplace の名前は `touryou`（このリポジトリの `.claude-plugin/marketplace.json`）。
2. **plugin を入れる**: `/plugin install touryou@touryou`。plugin は、Claude Code の設定の場所（`CLAUDE_CONFIG_DIR`。既定は `$HOME/.claude`）ごとに入る。分けているときは、同じ値で install・update・起動する。
3. **本体を入れる**: `/touryou:setup`。plugin の中の `scripts/install-runtime.sh` が、配布物を GitHub Release から取り、plugin に入っている sha256 と照合してから `$HOME/.touryou` に展開する（照合が通るまで、展開も実行もしない）。

touryou のリポジトリで開発する人へ: このリポジトリの中で Claude Code を開くと、project の設定（`.claude/settings.json`）が marketplace を `marketplace-v<版>` の tag に固定しようとします。ただし、上のとおりに `claude plugin marketplace add comcreate/touryou` で入れた人は、自分の設定の項目が勝つので固定されず、`main` に追従します。README のとおりに入れた人は、みなこの固定なしの状態で、それがふつうの状態です（そのまま使えます）。固定したいときの手順は [`docs/release.md`](release.md) の「手で marketplace を足した人には、project の固定が効かない」。`claude plugin marketplace remove` は plugin とそのデータを消すので、使いません。

## 取得について

`/setup`・`/touryou:desktop` は、配布物を **`curl`**（認証なし）で、`https://github.com/comcreate/touryou/releases/download/v<版>/<名前>` から取ります。GitHub のアカウント・GitHub CLI（`gh`）は要りません。ブラウザで取ると quarantine が付き、daemon が動かないので、ブラウザでは取りません（`curl` は quarantine を付けない）。取ったファイルは、plugin に入っている `checksums.json` の sha256 と照合してから使います。

**導入の script（`plugin/scripts/install-runtime.sh`）**: `/setup` は、取得・照合・quarantine の確かめ・`tar -t` の検査・展開・外を指すシンボリックリンクの検査・`--help` の確かめ・`current` の付け替えを、この 1 本にまとめて、1 回の承認で走らせる（前は、コマンドを 1 つずつ人が承認していた〔約 12 回〕）。守りの変化: script は plugin の zip の一部で、Claude Code が marketplace の sha256 で zip ごと確かめてから置く。取得元・版・sha256 は plugin の中の `checksums.json`・`plugin.json` からだけ読み、引数・環境変数では変えられない（受け付ける引数は、常駐の daemon の起動し直しへの同意の `--restart-daemon` だけ）。人が目で見るのは、1 つ 1 つのコマンドではなく、「plugin の中の script を、引数なしで走らせる」ことになる。呼び出しは `env -u BASH_ENV -u ENV bash <script>`（非対話の bash が script の前に読むファイルを読ませない）で、script の頭で、環境から取り込まれた関数を消し、`PATH` を OS の既定にする。tar の中身は、通常のファイル・ディレクトリ・中を指すシンボリックリンクだけを通す（特殊なファイル・ハードリンク・名前の制御文字を断る）。`current` を付け替える前に失敗したら、`current` は古いまま。常駐（launchd の plist がある）で版が変わるときは、同意がなければ何も変えずに終わり（終了コード 3）、同意のあとは、止める → 付け替え → 新しい版で `apply --yes`（stop のあとのどこで失敗しても、`current` を前の版に戻して前の版で `apply --yes` し、そのときの本当の状態を出して止まる。NFR_015）。設計は `.sdd/specification/touryou_design.md` の「配布・導入」、決定は `.sdd/adr/touryou.md`。

**版の食い違いの知らせ（SessionStart）**: `hooks.json` の SessionStart は、`plugin/scripts/runtime-version-notice.sh` を呼び、本体（`current` の指す版）と plugin の版が違えば「`/touryou:setup` で本体を上げる」と知らせるだけ（取得・daemon の起動し直しはしない）。本体がない・読めないときは何も出さず、どの場合もセッションを止めない。

- 取得に失敗したとき: ネットワークの接続を確かめる。`404` は、その版の Release がない（plugin と Release の版の食い違い）。plugin を新しい版にしてからやり直す。
- 新しい版: `claude plugin marketplace update touryou` と `claude plugin update touryou@touryou --scope user` のあとに、`/touryou:setup` をもう一度実行して、配布物も同じ版にする（`--scope user` を付ける。付け忘れて clone の中で update すると、その clone の中だけが新しくなる）。plugin が本体より古いときは、`/touryou:setup` は本体を入れ替えず、`RESULT: plugin-older`（終了コード 4）で止まって、plugin の更新を案内する。

## 使う順序

前提: `git`（Xcode の Command Line Tools）が要ります（daemon が、子の作業ツリーを `git worktree` で作るため。Xcode か Command Line Tools のどちらかがあればよい）。入っていなければ、Terminal で `xcode-select --install` を実行します（`/setup` は、最初に `xcode-select -p` で確かめ、なければ止まります）。

1. daemon を起動する（`touryou-daemon --config <設定ファイル> [--port <1〜65535>]`）。窓口のポートは、`--port` → 設定の `port`（0 以外）→ stateDir の `port` のファイル（前回のポート。0600）→ 空いているポート（そのファイルに保存する）の順で決まり、再起動しても変わらない。保存したポートが使われていれば、別のポートには移らず、起動しない（理由と直し方を出す）。起動の記録（`started`）の `portSource` に、どこから決まったか（`option`・`config`・`saved`・`new`）が出る。OS が選ぶポートは一時的なポートの範囲なので、まれにほかの接続が使う。止まったら `--port` で範囲外の番号を指定する。ファイルが壊れている・権限が緩い・リンクのときは `portFileInvalid` で起動しない（権限を 0600 にするか、ファイルを消す）。新規のポートを保存できないとき、Desktop の子（`childRuntime: "desktop"`）では `portSaveFailed` で起動しない。同じ stateDir で、2 つの daemon を動かさない。
2. 統合セッションを、この plugin つきで起動する（marketplace から入れるか、`claude --plugin-dir <plugin のパス>`）。MCP サーバー `node` は、plugin の `.mcp.json` が stdio で起動し、根のトークンは `touryou-mcp --stdio` が `$HOME/.touryou/config.json` の `stateDir` の `root-token` から読む（環境変数は使わない・要らない）。`stateDir` を標準の置き場以外にしたときは、`$HOME/.touryou/config.json` の `stateDir` をその場所にする。設定ファイル自体を別の場所に置くときは、環境変数 `TOURYOU_DAEMON_CONFIG` にそのパスを入れて統合セッションを起動する（`docs/config.md`）。**トークンの値は、設定ファイルに書かない・チャットに貼らない**。
3. `/touryou:start` で接続を確かめ、`integrator` の skill に沿って作業する。
4. 状態画面は `/touryou:ui` で開く（`touryou ui` を 1 回実行し、使い捨てのチケットで既定のブラウザに開く。トークンの貼り付けは要らない。モデルはトークンのファイルを読まず、チケットも見ない。再読み込みしたら、もう一度 `/touryou:ui`。Claude Code がクラウドで動いているなど、ブラウザを開けないときは、Mac のターミナルで `touryou ui` を実行する。`docs/ui.md`）。

daemon は、CLI の子を起動しない。親のセッションが起動する（下の「親から子を起動する流れ」）。

## 既存の作業ツリーを子として採用する

手で作った作業ツリー（`git worktree add`）と、そこで動いているセッションを、あとから木の子にできる（#163。CLI の木だけ。統合ノードの MCP の `node_adopt`。人間の CLI には足していない）。手順書は `plugin/skills/adopt/SKILL.md`（`/touryou:adopt`）。

1. 統合ノードが `node_adopt` を呼ぶ（`parentId`・`role`・`worktree`〔絶対パス〕・`branch`・`objective`・`acceptanceCriteria`・`scope`）。daemon は、作業ツリーを調べ（登録済み・主や親の作業ツリーでない・ブランチが付いている〔指定の `branch` と同じ・親と別・上流が親のブランチ〕・すでに別の子の作業ツリーでない）、範囲が親の範囲に収まることを確かめる。満たさなければ、何も変えずに、原因（`cause`）と次の操作（`nextActions`）を返す。
2. 成功すると、`nodeId` と `instruction` が返る。作業ツリーに、子であることの印（git のディレクトリのファイル）と紐付けのコードが書かれる。
3. 動いていたセッションで、`/mcp` から touryou を Reconnect し（これでこのセッションが子として動ける。印は MCP の起動のときにしか見ないため）、`child_bind` を引数なしで 1 回呼ぶ。
4. 採用した子には、起動の知らせの自動の流れがないので、子が `inbox_fetch` を自分で読む。受理・統合は、普通の子と同じ。

記録は、`node.created`（範囲）・`node.stateChanged`・`node.adopted`（作業ツリー・ブランチ）を 1 回で追記する。回収は、採用した作業ツリーとブランチを消さない（子の印と紐付けのコードを外すだけ）。`node.adopted` を含むログは、古い daemon では読み直せない。

## 親から子を起動する流れ

TouRyou は、**セッションを起動しません**。**Anthropic の認証も扱いません**（子は、親と同じ Claude Code のログインで動きます）。CLI の子は、親のセッション（Claude Code）が Bash で起動します。

1. **起動**: 統合が `node_spawn` を呼ぶと、TouRyou は作業ツリーを作り、親のセッションに「受信箱を読んで…（番号）」の知らせを届ける。親は `parent_request` で受け取ったコマンド `cd <作業ツリー> && claude --bg '<指示>' --name <名前> [--plugin-dir <plugin の場所>] --permission-mode dontAsk --settings '{"crossSessionInbound":"accept","permissions":{"allow":[...],"deny":[...]}}'`（`--plugin-dir` は、親の mcp の plugin の場所〔例: `<H>/.claude/plugins/…`〕が確かめを通ったときだけ入る。`--permission-mode` の前に `--model`・`--effort`、フォークのときは後ろに `--resume <id> --fork-session` が入ることがある）を、そのまま Bash で実行し、`parent_report` で報告する。
2. **紐付け**: 子は最初の番で `child_bind` を引数なしで呼ぶ（コードは、mcp が作業ツリーの git のディレクトリのファイルから読む）。続けて `inbox_fetch` でブリーフと指示を読む。
3. **知らせ**: 以後、親から子・子から親への連絡は、受信箱と 1 行の知らせ（受信箱を読め）で届く。
4. **停止**: `node_stop` は 2 段。子へ停止の知らせ → 猶予 → 親に `claude stop <子>` を依頼。子のセッションの id が記録にないとき（起動の報告に `sessionRef` がなかった）は、親はコマンドを組まず、`claude agents --json` で調べた id を `parent_report` の `sessionRef` で返す。TouRyou がその id で依頼を作り直す。
5. **削除**: 止まったあと、親に `claude rm <子>` を依頼。`claude rm` は子のセッションだけを消す。TouRyou の作業ツリーとコミット（未 push を含む）は残る（`claude rm` が未 push を守るのは Claude Code 自身が作った作業ツリーのときだけ）。作業ツリーの片付けは回収（人が破棄を決める → `node_reclaimPreview` で失われるものを見る → `node_reclaim`）。念のため、`claude rm` が拒んだら消さない。`--discard-unpushed` は、人間が破棄を決めたときだけ。

手順の本文は、skill の `integrator`（親）と `child`（子）にある。

## 注意（CLI の子）

- **CLI の子と plugin**: `--plugin-dir` で開いたのは、そのセッションだけ。`--plugin-dir` だけで開いた親の子（`claude --bg`）には plugin が付かず、子は `child_bind` を見つけられないまま止まり、TouRyou のフック（守り）も効かない。そこで TouRyou は、親の mcp の plugin の場所（`CLAUDE_PLUGIN_ROOT`）が確かめを通れば、子の起動の文に `--plugin-dir` を足す（marketplace から入れた plugin と重なっても 1 つにまとまる）。付けられなかったときは、受信箱に理由が出る。そのときは plugin を設定の置き場に入れる（marketplace から入れる）。daemon は、起動の報告のあと所定の時間（`cliWatch.unboundMinutes`。既定 3 分）紐付けのない子を、受信箱に 1 回だけ出す。
- **agent view の入力欄に貼った文は、新しい裏のセッションになる**。子に答えるつもりで agent view の入力欄に書くと、別の子が増える。子に入力するときは `claude attach <名前>` でつなぐ。
- **組織の管理の設定（managed settings）がある環境では、モデルの切り替えで失敗が出ることがある**（`--model` で、許されていないモデルを指定したときなど）。そのときは、出た文面を `parent_report` の `reason` に入れて報告する。
- **auto でないモード（ふつうのモード）では、`claude` のコマンドごとに許可の確認が出る**。変数を含むコマンドは「A variable in this command can't be checked before it runs」の確認が出るので、TouRyou の依頼のコマンドは、変数のない形にしている（値は単一引用符で 1 語にする）。親の skill も、コマンドを書き換えない・変数を足さない・つなげない。確認を減らすには、`/touryou:setup` の「許可の一覧」を見る。
- **子は `--settings '{"crossSessionInbound":"accept",…}'` で起動する**。bypassPermissions の受け手は、ほかのセッションからの知らせを保留するため（知らせが届かないと、子が受信箱を読まない）。
- **子は `--permission-mode dontAsk` で動き、範囲（書き込みの場所・許可のコマンド）と TouRyou の道具・作業ツリーの中の読み取りだけを確認なしで使う。範囲の外の操作は、確認を出さずに断られる。要るときは、子が受信箱で範囲の拡張（`scope_extend`）を頼む**。コマンドの拡張の承認は、引数までその形にだけ効く（形が違うと、dontAsk で断られる）。`git add`・`git status`・`git ls-files` だけは、承認した形のうしろに、コマンドごとに許す旗（許す表にない旗、たとえば `git add` の `-e`・`-p`・`-i`・`-f`・`--pathspec-from-file` は断る）と、作業ツリーの中の相対パス（`..`・絶対パス・`~`・glob・空白・展開・リダイレクトは除く）を足しても通る（#130）。これらは、旗で任意のコードを動かす道を持たず、作業ツリーのファイルを変えないため。`mkdir`・`touch`・`cp`・`git rm`・`git mv` は、作業ツリーのファイルを変えるので、うしろの引数のパスがすべて、書き込める場所（承認した `write` の場所を含む）の実パス（リンクをたどる。まだない道は、あるいちばん深い親をたどる）の中にあるときだけ通る（#135）。リンクで外へ出る形・外のパス・旗の並びが不正な形には許可を付けない。`cp`・`git mv` の宛先が既存のディレクトリなら、その中の名前も調べる。1 語の承認（`mkdir` など）は、親の範囲（根なら `rootScope`）の `allowedCommands` にその語があるときだけ承認できる。残る穴は、調べたあとの差し替え（TOCTOU）・ハードリンク・`cp` が作業ツリーの外から読むこと。glob・空白を含むパス・`cp -r`・`mv`・`ln` は対象外。許しの一覧（`permissions.allow`）は、TouRyou が子の範囲から作って `--settings` に入れる。書き込みの場所は `Edit(...)` の形で入れる（新しいファイルを作る Write も、`Edit(...)` の規則で照合される）。禁止の場所と `.git` は `permissions.deny` に `Edit(...)`・`Read(...)` で入れる。範囲の判定（フック）も別に効く。
- 子の範囲のコマンド（`allowedCommands`）は、2 語以上で書く（`git status`・`git add`・`git commit`・`pnpm test` など）。`git`・`node` のような 1 語だけのものや、`;`・`>`・引用符などを含むものがあると、子の起動の依頼が `invalidScope` で失敗する（前方一致で何でも通ってしまうため）。`bash`・`node`・`npx`・`npm exec`・`pnpm dlx`・`git config`・`find -exec` など任意のコードを動かせる形と、スクリプトの名前のない `pnpm run` も同じく失敗する（`pnpm run build` のように書く）。`yarn <スクリプト>` は `run` がなくてもスクリプトを動かすので、`yarn` で 2 語のコマンドを許すときは、それがスクリプトの名前でないことを確かめる。子に `git add`・`git commit` をさせたいときは、根の範囲（`rootScope`）か子の範囲に入れておく（入れないと、子は確認なしで断られる）。
- **根（統合）のセッションは、TouRyou のフックで絞らない（フックが働くのは、子の印のある作業ツリーだけ**。`cli/src/hook.ts`）。根の Bash・書き込みは、利用者の Claude Code の許可の設定のとおりに動く。`rootScope` は、子に渡す範囲の上限で、根自身の操作の制限ではない。
- **親（統合）の、読むだけの道具の許可（任意）**: `whoami`・`inbox_fetch`・`tree_list`・`node_capabilities`・`decision_get`・`report_get`・`node_reclaimPreview` の 7 つだけは、確認なしにしてよい（記録を書かない。試験で確かめている）。例は `/touryou:setup` の「許可の一覧」（名前は `mcp__plugin_touryou_node__<道具>`。`/permissions` で実際の形を確かめる）。ものを変える道具と `parent_request`（起動のコマンドを返す入口）は足さない。一覧は core の `PARENT_READONLY_TOOL_NAMES`。
- 利用者や作業するリポジトリの settings にある許可（`permissions.allow`）は、子も受け継ぐと見ている（推測）。広い許可を置いていると、子もそれを使える。


## フック

`plugin/hooks/hooks.json` は、PreToolUse・PostToolUse・Stop・Notification で（SessionStart は上の「版の食い違いの知らせ」）、POSIX シェルの 1 行（`scripts/hook-commands.mjs` が正本。Claude Code は、macOS・Linux では `sh -c` で実行する）を呼ぶ。この 1 行は、`$HOME` 基準の固定の 1 か所（`.touryou/current/bin/touryou`。`/setup` が置く）が実行可能なら、`exec` で `touryou hook` を起動する（**Node は要らない**）。`touryou hook` は、フック入力（標準入力の JSON）を、daemon の受け口 `POST /v1/hook` にそのまま送り、判定を返す。

手動の CLI セッション（daemon が SDK で起動する子とは別に、人が起動する `claude`）では、人間が `eval "$(touryou hook-env <nodeId>)"` で、その子の**フック専用のトークン**を発行して環境変数に入れる。このトークンは `POST /v1/hook` だけで使え（ほかの入口は 401）、ノードのトークン（SDK の子の MCP の接続）は変わらない。発行し直すと、古いものは無効になり、フックの結び付けも外れる。daemon を再起動すると無効（発行し直す）。`touryou hook-env` は、標準出力が端末なら、トークンを出さずに失敗する（`eval` で使うときだけ）。

**フック専用のトークンが無効になるとき**: ノードのトークンが発行し直される・失効すると、フック専用のトークンも一緒に無効になる。発行し直されるのは、**子が止められて再開したとき**（判断要求の `pauseNodeIds` で止め、回答で再開）・子の作り直し・bind のとき（CLI の子（`childRuntime: "cli"`）で実際に起こるのは、このうち**再開だけ**（作り直しは新しいノードになり、bind は Desktop の子だけ）。）。**子を止めない判断（`pauseNodeIds` なし、子が自分で出した判断など）に回答しても、子は動いたまま（回答は指示として届く）で、トークンは変わらない。手動のセッションは、そのまま使える**。手動のセッションのフックは拒否されるようになるので、`eval "$(touryou hook-env <nodeId>)"` から起動し直す。daemon の再起動でも無効になる。**`touryou hook-env` の出力を、パイプやファイルに出さない**（`eval` 以外に渡すと、トークンがそこに残る）。**互換**: 記録のイベント `node.hookTokenIssued` を書いたあとは、古い版の daemon に戻せない（ダウングレード不可）。

**TouRyou の子は、必ず `TOURYOU_DAEMON_URL`（窓口の URL）と `TOURYOU_NODE_TOKEN`（その子のノードのトークン）の両方を設定して起動する。どちらもない場合、フックは働かない**（TouRyou の子ではないセッションを壊さないため、素通しして、標準エラーに一言出す）。片方だけのときは、設定の誤りとして、拒否する。

**`touryou`（`touryou hook`）が配置されているときの判定**:

| 場面 | PreToolUse | PostToolUse・Stop |
|:--|:--|:--|
| 環境変数が両方ない | 素通し（標準エラーに一言） | 素通し |
| 片方だけ | 拒否（終了コード 2。拒否文に対処を示す。判定は変えない） | 止めない（標準エラーに出す） |
| daemon に届かない・時間切れ（5 秒）・200 以外・応答の形が違う・入力が切れた（2MiB 超） | **拒否**（フェイルクローズ） | 止めない（拒否すると、作業を止められなくなる） |
| 判定が許可・拒否 | 許可は終了コード 0、拒否は終了コード 2（理由がモデルに伝わる） | 判定しない（allow） |

**`touryou` が未配置、または壊れているとき**（`/setup` の前・`$HOME` が未設定・実行権がない・中身が壊れている・アーキテクチャ違い・shebang が壊れている・同梱の Node が動かない・シグナルで終了〔終了コード 0・2 以外〕を含む）は、`hooks.json` の 1 行が判定する（`exec` を使わず、`touryou hook` を普通に実行して、終了コードで分岐する。壊れた `touryou` を `exec` すると、シェルごと終了コード 126・127 で終わり、Claude Code では「ブロックしないエラー」なので、子の PreToolUse が素通しになるため）:

| 場面 | PreToolUse（拒否版） | PostToolUse・Stop（止めない版） |
|:--|:--|:--|
| 環境変数が両方ない（片方だけ・空文字を含む） | 素通し（終了コード 0。標準エラーに一言） | 素通し |
| **`TOURYOU_NODE_TOKEN` と `TOURYOU_DAEMON_URL` の両方がある**（TouRyou の子なのに、`touryou` がない・動かない） | **拒否**（終了コード 2。`/setup` を実行する、と理由を示す） | 止めない（終了コード 0。標準エラーに一言） |

`touryou hook` が配置されて動いているときは、その終了コード（0・2）が、そのまま返る（止めない版は、どの終了コードでも 0）。**壊れた `touryou` の扱い**（子の環境変数が両方あれば PreToolUse は拒否、なければ素通し＋一言）は、`onFailure: "block"` を付けない代わりに、この 1 行が担う。

**未配置のとき「片方だけ」を拒否しない理由**（決定）: `/setup` の前の統合セッションに `TOURYOU_DAEMON_URL` が残っているだけで、全ツール（ToolSearch・Bash を含む）が止まり、原因を調べられなくなるため。TouRyou の子は daemon が作るので、その時点で `touryou` は配置済みで、「片方だけ」の拒否は、`touryou hook` が行う。

**PostToolUse・Stop が「止めない版」である理由**: シェルは入力（JSON）を読まないので、イベントを区別できない。イベントごとに、別の command を登録する。Claude Code の公式のドキュメントでは、終了コード 2 は、PreToolUse ではツールの呼び出しを止め、**Stop では Claude が止まるのを妨げる**（会話が続く）。`touryou` 未配置・子の環境変数ありで、Stop が 2 を返すと、Claude が止まれなくなるので、止めない版は、どの場合も 0 を返す。

**未確認・留意**: Claude Code の公式のドキュメントでは、hook の command が見つからない・終了コード 127 などは「ブロックしないエラー」（操作は進む）。`onFailure: "block"` を付ければ、失敗を拒否にできるが、この plugin は、TouRyou の子でないセッションにも入る（`touryou` が壊れていると、全セッションのツールが止まる）ので、付けていない。

### `touryou hook`（Node がない Mac のため）

`touryou hook` は、従来の `touryou-hook.mjs` と**同じ判定・同じ終了コード**を、同梱の Node で動く実行ファイル（`packages/cli/src/hook.ts`）にしたものです（利用者の Mac に Node がなくても動く。`touryou-hook.mjs` は、削除しました）。標準入力のフック入力と、環境変数 `TOURYOU_DAEMON_URL`・`TOURYOU_NODE_TOKEN` だけを使い、人間のトークンは使いません（上の表のとおり）。試験: `packages/cli/test/hook.test.ts`（判定）、`scripts/hooks-command.test.mjs`（`hooks.json` の command を、実際に `sh -c` で走らせる）。配布物の smoke（`scripts/dist-smoke.sh`）でも、Node なしの環境で、`touryou hook` が、環境変数なしなら終了コード 0、daemon に届かなければ 2 を返すことを確かめます。

### 受け口 `POST /v1/hook`

- **認証**: 子のノードのトークン（`Authorization: Bearer`）。人間・統合ノードのトークンは 403（範囲を持たない）。認証・主体の検査（失効・止まったノードは 401）・同時数・主体ごとの回数の制限は、`/v1/request` と同じ（`docs/rate-limit.md`。同じ bucket を使う。**重みは 0.5**〔ほかの要求は 1〕。フックはツール呼び出しのたびに来るので、子のほかの要求を締め出しにくくする）。要求の重複の扱い（`requestId`）はない（判定は冪等）。
- **判定**: PreToolUse だけを、SDK のコールバックと同じ判定（`packages/daemon/src/sdk/hook-policy.ts`）に流す。基準は、daemon が持つノードの範囲と作業ツリーで、入力の `cwd` は使わない。**記録も同じ**（範囲違反は `scope.violation` と受信箱〔同じ違反は 1 度だけ〕、未知のツールは `node.toolDenied`。数え上げも SDK と共有する）。daemon が作業ツリーを知らないノード（daemon が起動していないノード）は、拒否する。
- **`session_id` とノード**: ノードはトークンで決める。最初に来た `session_id` をノードに結び、別の値は 403 で拒否する（記録は `hookSessionMismatch`。ID は書かない）。**結び付けはメモリだけなので、daemon を再起動すると、結び直しになる**（再起動のあと、最初に来たセッションに結ぶ）。**同じノードで `session_id` が変わる操作（`/clear`・`--resume` など）をすると、結び付けを外すまで、そのノードのフックは拒否される**。外す手段:
  - `node.hookUnbind`（人間は `touryou hook-unbind <nodeId>`、祖先の統合ノードは `mcp__node__node_hookUnbind`）。外したあと、最初に来たセッションに結び直す。**本人の子は外せない**（盗まれたトークンで外して、別のセッションで結び直させない）。外した者は、記録 `node.hookUnbound`（`nodeId`・`hadBinding`・actor。session_id は書かない）に残る。同じ requestId の再送では、もう一度は外さない。
  - トークンの発行し直し・失効（bind など）でも、自動で外れる（daemon の記録 `hookUnbound`、`reason: tokenReissued`）。古いトークンを無効にしてから外すので、古いトークンのセッションが、間に結び直すことはない。
  - daemon の再起動でも外れる（メモリだけのため）。
  - Desktop の子では、`node.bindCode` の出し直しでも外れる（記録 `hookUnbound`、`reason: bindCodeReissued`）。次の新しいセッションが結ばれ、前のセッションは 403（次の操作は「node.bindCode を出し直し、新しいセッションで始める」）。
  - 結ぶのは、判定で許可した最初の PreToolUse のときだけ。拒否した呼び出し（cwd が作業ツリーの外など）と、PostToolUse・Stop では結ばない（まだ結ばれていないセッションの PostToolUse・Stop は、受け取るだけ）。
  - トークンが漏れた疑いがあるときは、外さずに、子を止めてトークンを失効させる。
  - 受け口は、本文を読み終えたあと、結ぶ直前に、もう一度トークンを確かめる。本文を読んでいるあいだに発行し直されたら、その要求は 401 で、結び付けも作らない。
  - **互換**: 記録のイベント `node.hookUnbound` を書いたあとは、古い版の daemon に戻せない（ダウングレード不可。古い版は、未知のイベントとしてログを開けない）。状態の形は変えていないので、`STATE_VERSION` は上げていない。
- **本文の上限**: 1 MiB（窓口と同じ）。超えたら 413（「本文が大きすぎる」）で、フックは拒否として扱う。
- 応答: `{ ok: true, value: { decision: "allow" } }` か `{ ok: true, value: { decision: "deny", reason } }`。

**統合セッションには `TOURYOU_DAEMON_URL` を設定しない**（`touryou-mcp` の起動の端末だけで使う）。設定すると、「片方だけ」の拒否で、ToolSearch や Bash も止まる。そのときは、起動した端末で `unset TOURYOU_DAEMON_URL` して起動し直す。「片方だけ」の拒否は、TouRyou の子に付け忘れがあっても気づけるようにするためで、統合ノードでも緩めない（緩めると、根の権限を持つ端末〔以前の `TOURYOU_ROOT_TOKEN` のように、環境に根のトークンを置いた端末〕で起動した子が、無防備に素通しになりうる）。

## デスクトップ版の起動の方法と、接続の失敗

統合セッションの MCP は stdio 型で、標準の置き場のファイルから根のトークンを読むので、**環境変数は要らない**（`TOURYOU_ROOT_TOKEN` は使わない）。デスクトップ版も、ふつうに起動してよい。デスクトップ版の `/mcp` は、アプリの「設定 → コネクタ」の画面を開き、plugin の MCP（`plugin:touryou:node`）は出ない。**デスクトップ版での接続の確認は `/touryou:status` で行う**。plugin は、デスクトップ版が読む設定の場所（`CLAUDE_CONFIG_DIR` を分けていなければ `$HOME/.claude`）に入れる。

| 症状 | 原因 | 直し方 |
|:--|:--|:--|
| `node` の道具がない。標準エラーに `[touryou mcp] 配布物の touryou-mcp がまだない…` | `/setup` をしていない（`$HOME/.touryou/current/bin/touryou-mcp` がない）。中継が待っている | `/touryou:setup` を実行して daemon を起動すれば、10 秒ほどで自動でつながる。つながらなければ `/mcp` で Reconnect |
| failed。`[touryou mcp] 失敗 [daemon_unreachable]: daemon が動いていません…` | daemon が起動していない（`state/port` がない、または応答がない） | launchd（`docs/launchd.md`）か `touryou-daemon --config …` で起動してから、`/mcp` で Reconnect |
| failed。`[touryou mcp] 失敗 [unauthenticated]: 根のトークン…` | `root-token` がない・リンク・自分のでない・権限が 0600 でない・ACL つき | daemon を起動して `root-token` を作らせる。権限は `chmod 600`、ACL は `chmod -N` で外す |
| failed。`[touryou mcp] 失敗 [invalid_config]: …` | 設定ファイル（`$HOME/.touryou/config.json`。`TOURYOU_DAEMON_CONFIG` で別の場所を指しているときは、そのファイル）がない・リンク・他の人が書ける、`stateDir` が絶対パスでない、置き場（`$HOME/.touryou`・`stateDir`・その親）がリンク・自分のでない・権限が `drwx------`／`drwxr-xr-x` でない・ACL つき | `/setup` をやり直す。置き場は `chmod 700` |
| `/mcp` の Reconnect で `Failed to reconnect to plugin:touryou:node: CONNECTION_CLOSED` だけが出る | `touryou-mcp --stdio` が起動時の確認で終わった（daemon が止まっている、または `/setup` の前）。理由の文（`[touryou mcp] …`）は `/mcp` には出ない | まず daemon が動いているか（launchd か手で起動したもの）と `$HOME/.touryou/current` があるかを確かめ、直してから Reconnect。理由の文は `claude --debug` で見る |
| 統合セッションの途中で daemon を止めると、ツールが `daemon_unreachable`（`daemon に届かない（止まっているか、起動し直している途中。トークンは送っていない）`） | daemon が止まっている | daemon を起動する。起動し直せば Reconnect なしで戻る |
| 全ツールが拒否される（`[touryou hook]` の片方だけ） | 統合セッションの環境に `TOURYOU_DAEMON_URL` がある | `unset TOURYOU_DAEMON_URL` して起動し直す |

`/mcp` の失敗の理由は、Claude Code の debug ログ（`claude --debug`）か、`/plugin` の Errors に出る（公式のドキュメントによる）。`/mcp` の Reconnect の失敗は `CONNECTION_CLOSED` だけで、理由の文は出ない。

## トークンの期限

漏れたトークンが長く使われないよう、ノードのトークンとフック専用のトークンに期限を付ける。値は設定 `tokenExpiryMinutes`（分。1〜525600 の整数。どれも任意）で変えられる。

| トークン | 期限（既定） | 設定のキー | 「使った」に数えるもの |
| --- | --- | --- | --- |
| CLI の子（紐付けた子） | 使わなければ 6 時間、または発行から 7 日で切れる（daemon が止まっていた間は、使わなかった時間に数えない） | `sdkIdle`・`sdkAbsolute` | 窓口の呼び出し・道具の使用（フック） |
| Desktop の子（bind） | 発行から 24 時間、または使わなければ 1 時間 | `bindAbsolute`・`bindIdle` | 窓口の呼び出し |
| フック専用（`touryou hook-env`） | 発行から 24 時間（使っていても延びない） | `hookAbsolute` | — |
| 根（統合）・人間 | 期限なし | — | — |

| 子の状態 | ノードのトークン |
| --- | --- |
| running・stopping・stopIncomplete・pending | 期限どおりに数える |
| waiting（判断待ち）・done | 使わなければ切れる時計を止める（bind の 24 時間は進む）。done は失効させない（差し戻しで動き直す） |
| stopped・verified・reclaimable・archived（記録にないノードも） | 種類を問わず、その状態になったその場で失効させる（見回りを待たない）。再開のときは、CLI の子は daemon が発行し直し、Desktop の子は結び直す |

- **再開の途中で daemon が再起動したとき**: 再開は、止まったまま新しいトークンを発行し、起動を待ってから running を記録する。その途中で daemon が止まると、子は stopped のまま残り、起動を待っていたトークンも残る。daemon は起動時に、止まっている子のトークンを失効させるので、このトークンも使えなくなる（子のプロセスは、daemon と一緒に終わっている）。再開をやり直すには、同じ回答をもう一度送る（新しいトークンを発行して起動する）。動いているあいだの再開（daemon が止まらない場合）では、起動を待つあいだに、ほかのコミットや見回りがあっても、新しいトークンは消えない（stopped は、その状態に移ったときにだけ見るため）。
- 期限切れのトークンでの呼び出しは 401 で、失敗の記号は `tokenExpired`（ほかの不正なトークンは `unauthenticated`）。対処: Desktop の子は、親か人が `node.bindCode` でコードを出し直し、子が結び直す。CLI の子は、親か人が子を再開するか、作り直す。フック専用のトークンは、`eval "$(touryou hook-env <nodeId>)"` で出し直す。
- 期限で切れたとき、その子が running なら、受信箱に知らせを 1 件出す（同じトークンについては 1 回だけ）。止まった・役目の終わった子には出さない。daemon は 5 分ごとに見回り、使われていないトークンも失効させる。期限切れでの失敗は、窓口の警告（認証の失敗の件数）の閾値に数えない。
- 動いているあいだの経過は、単調時計で数える（壁時計を巻き戻しても、期限は延びない）。再起動をまたぐときだけ、保存した時刻と壁時計で比べる。
- **ノート PC を閉じてスリープさせると、そのあいだも時間がたったものとして数える**（壁時計はスリープのあいだも進む）。閉じていた時間が長いと、開いたときに、Desktop の子のトークンが切れている（結び直す）。
- 最後に使った時刻は、トークンのファイル（`node-tokens.json`、版 2）に、ノードごとに 1 分に 1 回まで書く。daemon を再起動しても、期限は続く。記録には、ノード ID・理由・種類だけを書く（トークン・ハッシュは書かない）。
- 失効させたトークンの印は、`revoked-tokens.json`（0600）に、そのトークンの最長の期限まで残す。daemon を起動し直しても、失効済みのトークンは expired と返る。このファイルが壊れていたら、警告（`revokedStoreCorrupt`）を 1 回出して空で始める（印は消しても安全側で、失効済みのトークンが invalid に戻るだけ）。
- **版 1 のファイル**（種類・最後に使った時刻がない）を読んだときは、厳しい側の bind とみなす（発行から 24 時間。使わなければ切れる時計は、読んだ時から数える）。どの子のトークンかが分からないため、長い側（CLI の子）には倒さない。CLI の子は、切れても再開のときに発行し直されるので、困らない。

## CLI の子の紐付けと「紐付け待ち」

- plugin の mcp（`touryou-mcp --stdio`）は、起動したときの作業ディレクトリで開き方を決める。
  - 作業ディレクトリの git のディレクトリ（`git rev-parse --absolute-git-dir`）に、印のファイル `touryou-child` があれば、「紐付け待ち」で開く。印は、daemon が子の作業ツリーを作るときに置く（中身はノードの ID だけ）。
  - 紐付け待ちの mcp は、根のトークン（`root-token`）を読まない。出す道具は `child_bind` と `whoami` だけで、紐付けが済むと子の道具に替わる。
  - 印がなければ、いまのとおり根（統合）で開く。印があるのに読めないときや、`.git` のファイルが読めないときも、紐付け待ちに倒す。git は呼ばない（ファイルだけで決める）。
  - 印は childRuntime を問わず置く。**Desktop の子の作業ツリーでも、plugin の mcp は紐付け待ちで開く**。
  - 子のセッションは、作業ツリーの一番上（作業ツリーのフォルダそのもの）で起動する。下の階層で起動すると、紐付けが断られる。
  - 紐付けのあとで daemon が資格情報を拒んだ（401 `unauthenticated`）ときは、まず mcp が、下の #145 と同じ「コードなしの結び直し」を自分で 1 回試す（道具の呼び出し・知らせの購読のどちらの 401 でも。同時には 1 回だけ。失敗したら 60 秒は試さない）。通れば、新しいトークンに替えて、拒まれた呼び出しを 1 回だけやり直す（401 は処理の前に断られるので、二重にならない）。通らなければ紐付け待ちに戻り、道具は `binding_lost`（「紐付けが外れた。MCP の接続は切れていない」）を返す。出し直した紐付けの文面のコードで、もう一度 `child_bind` を呼べる。期限切れ（`tokenExpired`）は対象にしない。
  - **daemon の再起動（#185・#187）**: 再起動しても、CLI の子のセッション（`claude --bg` のプロセス）は止まらない（daemon の子プロセスではないため。Desktop の子も同じ）。daemon 側のトークンは永続され、session_id の結び付けも記録から引けるので、再起動のあとも紐付けは有効なまま。再起動の途中は、mcp が待ってかけ直す。ただし、起動の依頼の記録がない・起動の失敗を報告した子で、動作中だったものは、起動時の整合で停止済み・停止未完了になり、トークンが失効する。
  - **コードのファイルと接続先（#167）**: `touryou-bind-code` は、1 行目がコード、2 行目が書いた daemon の公開 ID（`daemon=<daemonId>`。`daemon-identity.md` の識別子）。`child_bind` を引数なしで呼ぶと、mcp は身元を確かめた接続先の daemon の ID とこの ID を突き合わせ、食い違えば**コードを送らず**に `bind_daemon_mismatch`（別の daemon のコード）で失敗する。直し方は、plugin の接続先（`--config`・`TOURYOU_DAEMON_CONFIG`・`$HOME/.touryou/config.json`）を、子を作った daemon に合わせて `/mcp` で Reconnect する。2 行目のない古い形（コードだけ）は、突き合わせずに送る。
  - **bind の失敗の理由（#167）**: `POST /v1/bind` の失敗は 401 のまま、`bindCodeExpired`（期限切れ）・`bindCodeUsed`（使用済み）・`bindWorktreeMismatch`（作業ツリー違い）を区別する。期限切れ・使用済みは、そのコードを持つノードの名前で呼んだときだけ区別し、未知のコード・別のノードのコードは `unauthenticated` のまま（コードの当たりを探れない）。mcp の失敗は `bind_code_expired`・`bind_code_used`・`bind_worktree_mismatch`・`bind_failed`。
  - **`claude attach` のあと（#145）**: 子の画面を `claude attach` で開くと、Claude Code が mcp をつなぎ直し、メモリのトークンが消える（紐付け待ちに戻る）。このとき `child_bind` を引数なしで呼ぶと、コードのファイルがなくても（使用済み）、mcp が「ノードの ID（印）・`CLAUDE_CODE_SESSION_ID`・作業ディレクトリ」を daemon に送り、daemon が次のすべてに合うときだけ、トークンを出し直す。人が `node_bindCode` を頼む手間はいらない。
    - 合う条件: 作業ディレクトリがそのノードの作業ツリーの一番上（実パス）／最初に**コードで**紐付けたときに記録した session_id と同じ／そのノードが終わっていない／今も有効な紐付けのトークンを持つ／子ロールでトークンを持てる状態。
    - 通らないとき（どれか 1 つでも外れた）は、これまでの案内（親に `node_bindCode` で出し直してもらう）に落ちる。外れた理由は外に出さない（コードが無効なときと同じ 401）。
    - **期限は延ばさない**: 紐付けのトークンの「使わなければ 1 時間・発行から 24 時間」の期限が、つなぎ直しの上限になる。切れた・失効した・止められたあとは、人がコードを出し直す。
    - Desktop の子では使えない（コードなしの bind は必ず断る）。
    - **守りが弱くなる所**: session_id は秘密ではない。同じ OS のユーザーの別のプロセスが、ノード ID・session_id・作業ツリーの 3 つを知っていれば、コードなしでその子のトークンを取れる（フックの `sessionIdOnly` と同じ程度の信頼）。取られた本物の子は前のトークンが無効になり、401 で紐付け待ちに戻るので気づける。失敗は、コードの場合と同じ全体のスロットルと接続元ごとの上限で数える。
    - **未確認の前提**: attach のあとも `CLAUDE_CODE_SESSION_ID` が元のセッションと同じであること（[`manual-verification-checklist.md`](manual-verification-checklist.md) の A4-3）。違えば、つなぎ直しは通らず、案内に落ちる。コードでの紐付けのときに session_id がなかった子は、記録がないのでつなぎ直せない。
- **統合セッションが、誤って紐付け待ちで開いたとき**（印が残った作業ツリーで、統合セッションを始めたなど）: 人が、その作業ツリーで次を実行して印を外し、Claude Code の `/mcp` で Reconnect する。道具の呼び方で根に切り替える道はない。

  ```sh
  rm "$(git rev-parse --absolute-git-dir)/touryou-child"
  ```

  TouRyou の子として動いている作業ツリーでは、外さない（外すと、その子の mcp が根で開いてしまう）。
- **印がないのに紐付け待ちになったとき**: mcp の記録（標準エラー）に `stdioPendingBind` が出ていて、上の `rm` で消す印がない（`No such file`）なら、`.git` が読めないか、形が変なことが原因（安全のため紐付け待ちに倒している）。次で見分ける。
  - `ls -la .git` と `cat .git`（ファイルなら `gitdir: <path>` の 1 行のはず）。権限が足りない・中身が壊れているなら直す（`git worktree repair` など）。
  - 作業ディレクトリの上のフォルダに、読めない `.git` がないかも確かめる。
- 既知の残り: 子の Bash は同じユーザーなので、`<stateDir>/root-token` をファイルとして読めてしまう。フックの範囲の判定で、state のディレクトリを禁止の場所に入れて防ぐ。

## Desktop

Desktop の子へのフックの継承と、接続設定の引き継ぎは、`docs/desktop-runtime.md` を見る。この節は、CLI の分だけ。

**注意（未解決）**: Desktop の子には、TouRyou の作業範囲外の拒否（FR_014）が、まだ効かない（フックの受け口は Desktop の子に許可を返さず、プロジェクトのフックは確認用の deny だけ）。子は同じユーザーとして、stateDir の人間のトークン・根のトークンのファイルを読める（stateDir のパスは、`ps` に出る daemon の `--config` から分かる）。人間のトークンを使えば、`node.purge` など取り消せない操作もできる。**今は、Desktop の子を、信頼できない文章（他人のリポジトリ・Issue・Web の内容など）を読む作業に使わない。** 直し方は未決定（計画）。詳しくは [`docs/desktop-runtime.md`](desktop-runtime.md) の冒頭の注意。

**stateDir の守り**: FR_014 のフックは読み込みを制限しないので、そのままでは CLI の子も Read の道具で stateDir のトークンを読める。そこで、stateDir と daemon の設定ファイルを、読み取りも範囲外にしている（自分の HOME と skill の写しは除く。拒否の文面には場所の種類だけを出す）。Bash は書かれたパスに見える語だけを見る歯止めで、確実ではない。詳しくは [`docs/desktop-runtime.md`](desktop-runtime.md) の冒頭の注意。

## 検証（`pnpm check` に入っている）

`node scripts/validate-plugin.mjs`（`pnpm validate:plugin`。先に `pnpm build` が要る）が、次を検査する。検査の中身は `scripts/plugin-check.mjs`、試験は `scripts/plugin-check.test.mjs`（`node --test scripts/*.test.mjs`）。

- plugin.json の必須項目・name（kebab-case）・version（semver）。`hooks/`・`skills/` がある（`agents/` は任意。中身ができたら置く）。
- skill（`SKILL.md`）と command の frontmatter（`name` は、skill ではディレクトリ名と同じ。`description` は必須）。`hooks/hooks.json` があれば、JSON として正しく、形が正しい（イベントは PreToolUse・PostToolUse・Stop だけ、Stop に matcher を書かない、`type: "command"`、command は、`scripts/hook-commands.mjs` の定数と**完全一致**〔PreToolUse＝拒否版、PostToolUse・Stop＝止めない版〕、timeout は 1〜60 秒）。command の試験は `scripts/hooks-command.test.mjs`（`sh -c` と `bash --posix -c` で、実際に走らせる）。
- skill・command に書いた `mcp__node__<ツール名>` が、実際に公開されているツール（`packages/mcp` の `toolsFor`・`whoami`）にある。skill は、そのロールのツールだけを書き、**そのロールの全ツールを説明している**（ツールが増えたのに skill が古い、を防ぐ）。「説明している」とみなすのは、**行頭の箇条書きで、ツール名のあとに `:` と 10 文字以上の説明が続く行**（`- ` `` `mcp__node__<名前>` `` `: 説明…`）がある場合だけ。「使わない」と書いただけの言及は、説明にならない。
- NFR_012: plugin/ の中に、絶対パスがない。行頭・空白・引用符・`(`・`=` の直後の `/<英数字>/…` は、すべて拒否する（`/home/`・`/workspace/`・`/app/`・`/Volumes/`・`/c/Users/` など。`~/`・Windows のパス・`file://`・このリポジトリの絶対パスも）。**例外は、URL のパス（`://host` の後。例: `http://127.0.0.1:7777/v1/whoami`）と `${CLAUDE_PLUGIN_ROOT}`（とそれに続く plugin の中のパス）だけ**。
- frontmatter は、1 行の `key: value` だけ。複数行の値（`>`・`|`）は、検出できないので、エラーにする。
- `packages/mcp/dist/tools.js` が `src/tools.ts` より古ければ、「先に `pnpm build`」と表示して失敗する。
