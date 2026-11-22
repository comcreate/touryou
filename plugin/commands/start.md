---
description: daemon と touryou-mcp の起動を確かめ、統合ノードとして使えるようにする（起動の手順は、/setup が置いた $HOME/.touryou の下を使う）
allowed-tools: mcp__node__whoami, mcp__plugin_touryou_node__whoami, mcp__node__tree_list, mcp__plugin_touryou_node__tree_list
---

ツール名の `mcp__node__<名前>` は、plugin から入れたセッションでは `mcp__plugin_touryou_node__<名前>` として見える（同じツール）。見えているほうの名前で呼ぶ。

TouRyou を使えるようにします。リポジトリやファイルの場所は、この指示に埋め込まれていません。`/touryou:setup` が置いた場所（`$HOME/.touryou`）を使います。

1. まず、`mcp__node__whoami` を呼ぶ。`role` が `integrator` で返れば、すでに接続できている。手順 4 へ進む。
2. 接続できなければ（ツールが見えない、または失敗）、`/touryou:setup` を実行済みかを、人間に尋ねる（設定ファイル `$HOME/.touryou/config.json` と、`$HOME/.touryou/current/bin` の配布物を、`/setup` が置く）。未実行なら、先に `/setup` を案内する。
   - `/setup` を同じ会話で実行した直後なら、node は配布物と daemon を見つけてから 10 秒ほどで自動でつながる（plugin の中継が待っている）。少し待って手順 1 からやり直す。それでも node の道具がなければ、`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面なら、Claude Code を起動し直す）よう案内し、そのあと手順 1 からやり直す。
   - 注意: 統合セッション（`claude`）を起動する端末・環境に `TOURYOU_DAEMON_URL` があると、フックが「`TOURYOU_DAEMON_URL` と `TOURYOU_NODE_TOKEN` の片方だけ」として、ToolSearch や Bash を含む全ツールの呼び出しを拒否し、原因を調べられなくなる。あれば、`unset TOURYOU_DAEMON_URL` してから起動し直す。
3. 次の起動の手順を、人間に示す（別の端末で行う。起動の順序は daemon → 統合セッション）。トークンは、チャットに貼らせない。
   - `"$HOME/.touryou/current/bin/touryou-daemon" --config "$HOME/.touryou/config.json"`（窓口の URL が出る）
   （launchd を使っていれば、daemon は自動で動いている。子用の HTTP の `touryou-mcp` は外した。子も plugin の stdio の mcp を使う）
   - **複数の daemon（設定ごと。#165）**: root ごとに daemon を分けているときは、**どの設定の daemon を起動するかを、人間に聞く**（`"$HOME/.touryou/current/bin/touryou" ui --list` で、既定の設定と、ほかのリポジトリ用に分けた daemon の設定の一覧が出る）。選んだ設定で、`"$HOME/.touryou/current/bin/touryou-daemon" --config <設定ファイルの絶対パス>` を示す。常駐なら、`/touryou:service` で対象を選ぶ（`touryou launchd status --config <設定>`）。統合セッションが、その daemon につながるように、統合セッション（`claude`）を起動する端末で `export TOURYOU_DAEMON_CONFIG=<設定ファイルの絶対パス>` してから起動する（`touryou-mcp --stdio` が、その設定の `stateDir` の `root-token`・`port` を読む）。環境変数の代わりに、設定ごとの MCP（`touryou-<名前>`。`--config` 固定）を `claude mcp add` で登録してもよい（`touryou launchd init --config <設定>` の出力の「【MCP を登録する】」。#224。`docs/launchd.md`）。設定ごとに、stateDir・ポートは別にする。
   - 統合セッションの接続は、plugin の `.mcp.json` が済ませる（サーバー名 `node`・**種類 stdio**。Claude Code が `touryou-mcp --stdio` を起動し、`touryou-mcp` が `$HOME/.touryou/state` の `root-token`・`port` を自分で読む。MCP の設定を、手で足さない。環境変数は要らない）。**トークンの値は、設定ファイルに書かない・チャットに貼らせない**。配布物がまだない・daemon が動いていないあいだは、plugin の中継（`scripts/touryou-mcp-shim.sh`）が落ちずに待ち、整ったら自動で `touryou-mcp --stdio` に引き継ぐ。daemon が途中で止まったあとなどで node が failed なら、`/mcp` で `node` を Reconnect する（stdio のサーバーは、失敗したまま自動では起動し直さない）。
   起動を、人間が済ませたら、手順 1 をやり直す。
4. `mcp__node__tree_list` で、木を見せる。`self` が「あなた」の行が、自分。続けて、`integrator` の skill に従って作業する。

接続に失敗したとき:
- `/mcp` の Reconnect で `CONNECTION_CLOSED` だけが出る: 理由の文は `/mcp` に出ない。まず daemon が動いているか、`$HOME/.touryou/current` があるかを確かめ、直してから Reconnect する。
- `/mcp` で `node` が failed: 標準エラーの `[touryou mcp] …` の理由に従う（`配布物の touryou-mcp がない` → `/setup`。`daemon_unreachable`（daemon が動いていません）→ daemon を起動して Reconnect。`unauthenticated` → `root-token` の権限〔0600。ACL なし〕を確かめる。`invalid_config` → 設定ファイル〔`$HOME/.touryou/config.json`。`TOURYOU_DAEMON_CONFIG` があればそのファイル〕と、その親ディレクトリの権限・`stateDir`）。
- `401`（`AUTH_HEADER_REJECTED`）: 根のトークンが、古い・別の daemon のもの。`touryou-mcp --stdio` は、要求の失敗のときに `root-token` を読み直して 1 回送り直すので、ふつうは自動で戻る。戻らなければ `/mcp` で Reconnect する。

起動できないときは、原因（標準エラーの `daemon_identity_failed`・`identityCheckFailed` など）を、そのまま人間に伝える。身元の検証を回避する設定（`TOURYOU_MCP_ALLOW_UNVERIFIED`）は、勧めない。
