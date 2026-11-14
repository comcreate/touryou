<p align="center">
  <img src="assets/icon/icon.svg" width="112" alt="touryou">
</p>

# touryou

複数の Claude セッションを「統合セッション 1 対 作業セッション n」の木構造（Composite パターン）で束ね、
人間が最上位の統合セッションとだけ対話すれば、並列に進む実装・レビュー・調査を依頼・把握・判断できるようにするシステム。

版は 0.1.0（最初の公開）。対象: macOS（Apple Silicon）のみ（[`docs/release.md`](docs/release.md) の「対象の OS・CPU」）。変更は [`CHANGELOG.md`](CHANGELOG.md)。要求は [`.sdd/requirement/touryou.md`](.sdd/requirement/touryou.md) を参照。

## はじめかた

このプロジェクトは、Claude Code と連携して動きます。Anthropic の公式の製品ではなく、Anthropic とは関係がありません。

前提: macOS（Apple Silicon）、Claude Code、`git`（Xcode の Command Line Tools。なければ Terminal で `xcode-select --install`）。GitHub のアカウントは要りません。

Claude Code で、次の 3 つを順に実行します。

```text
claude plugin marketplace add comcreate/touryou
/plugin install touryou@touryou
/touryou:setup
```

1. **marketplace を足す**: このリポジトリの `.claude-plugin/marketplace.json` を、marketplace として足します（Terminal で `claude plugin marketplace add comcreate/touryou`。Claude Code の中なら `/plugin marketplace add comcreate/touryou`）。
2. **plugin を入れる**: `/plugin install touryou@touryou`（Terminal なら `claude plugin install touryou@touryou`）。
3. **本体を入れる**: `/touryou:setup` が、daemon・`touryou-mcp`・`touryou` の配布物（Node を同梱した tar.gz）を GitHub Release から取り、plugin に入っている sha256 と照合してから `$HOME/.touryou` に入れ、設定を作ります。最後に、ログイン時に自動で動かす（常駐。`docs/launchd.md`）かを聞きます。

そのあと、統合セッションで `/touryou:start` を実行して、接続を確かめます。くわしくは [`docs/plugin.md`](docs/plugin.md)。

新しい版が出たら、`claude plugin marketplace update touryou` と `claude plugin update touryou@touryou` のあとに、もう一度 `/touryou:setup` を実行します。

## 手元でビルドして使う（開発する人向け）

daemon・`touryou-mcp`・`touryou` は、plugin とは**別に**入れます（plugin には入っていません。上の `/setup` が Release から取得して入れるか、ここのとおり手元でビルドします）。

### 1. daemon・touryou-mcp・touryou を入れる

`git`（Xcode の Command Line Tools）が要ります（daemon が、子の作業ツリーを `git worktree` で作るため。Xcode か Command Line Tools のどちらかがあればよい）。入っていなければ、Terminal で `xcode-select --install` を実行します（`/setup` は、最初に `xcode-select -p` で確かめ、なければ止まります）。

Node 22 以上と pnpm 10.28.0 が要ります。

```sh
corepack enable    # pnpm 10.28.0（packageManager で固定）を使う
pnpm setup         # pnpm link --global の置き場を PATH に入れる（初回だけ。シェルを開き直す）
```

リポジトリは、認証なしで `git clone` できます。

```sh
git clone https://github.com/comcreate/touryou.git
cd touryou
pnpm install --frozen-lockfile
pnpm build
for p in daemon mcp cli; do (cd packages/$p && pnpm link --global); done
```

`touryou-daemon`・`touryou-mcp`・`touryou` が PATH に入ります。`touryou-daemon --help` が使い方を出せば、入っています。版を上げたら、`git pull` → `pnpm install --frozen-lockfile` → `pnpm build` をやり直します（daemon と `touryou-mcp` は同じ版にそろえます）。

### 2. 設定を書く

設定ファイル（JSON、権限 0600）を 1 つ書きます。daemon と `touryou-mcp` が同じものを読みます。項目と既定値は [`docs/config.md`](docs/config.md)。

```json
{
  "stateDir": "<状態の置き場（0700）>",
  "repoRoot": "<作業するリポジトリ>",
  "worktreeRoot": "<作業ツリーの置き場>",
  "rootCwd": "<作業するリポジトリ>",
  "rootScope": { "writableLocations": ["src"], "forbiddenLocations": [".git"], "allowedCommands": ["git status"] }
}
```

### 3. 起動する

```sh
touryou-daemon --config <設定ファイル>   # 窓口の URL が出る
```

**touryou は、セッションを起動しません。Anthropic の認証も扱いません**。CLI の子は、親のセッション（Claude Code）が、受信箱に書かれたコマンドを Bash で実行して起動します。

流れ: **起動**（親が `cd <作業ツリー> && claude --bg '<指示>' --name <名前> --settings '{"crossSessionInbound":"accept"}'` を実行。`--model`・`--effort`・フォークの `--resume <id> --fork-session` が入ることがある）→ **紐付け**（子が `child_bind` を引数なしで呼ぶ）→ **知らせ**（受信箱を読めという 1 行が届き、`inbox_fetch` で読む）→ **停止**（子へ知らせ → 猶予 → 親が `claude stop`）→ **削除**（親が `claude rm`）。詳しくは [`docs/plugin.md`](docs/plugin.md) の「親から子を起動する流れ」と「注意（CLI の子）」。Desktop の子（`childRuntime: "desktop"`）は、これまでどおりです。

ログイン時に自動で動かすときは、`/touryou:setup` の手順 9 で「常駐にする」を選びます（同意の問いに「はい」と答えたときだけ登録します。以後の確認・止める・外すは `/touryou:service`）。手作業の手順は [`docs/launchd.md`](docs/launchd.md)（`touryou launchd init`）。読み込むと、macOS の「ログイン項目」に `run-daemon.sh` が「開発元を識別できない項目」として出ます（起動スクリプトと配布物には署名をしない方針で、想定どおりです）。

### 4. plugin を付ける

このリポジトリの marketplace（`.claude-plugin/marketplace.json`）を足して、plugin を入れます（手元の plugin を試すときは `claude --plugin-dir plugin`）。

```sh
claude plugin marketplace add comcreate/touryou
claude plugin install touryou@touryou
```

plugin の `.mcp.json` が、統合セッションの MCP サーバー `node`（種類 stdio）を足します。Claude Code が統合セッションごとに `$HOME/.touryou/current/bin/touryou-mcp --stdio` を起動し、`touryou-mcp` が `/setup` の標準の置き場（`$HOME/.touryou`）から、根のトークンと daemon の窓口を自分で読みます（環境変数は要りません。値をファイルに書かない）。daemon は、別に起動しておきます（launchd か手で）。

```sh
claude
```

統合セッションで `/touryou:start` を実行して、接続を確かめます。daemon が動いていない・`/setup` をしていないと、`/mcp` で `plugin:touryou:node` が failed と出て、`mcp__…node__*` のツールが見えません（理由は標準エラーの `[touryou mcp] …`）。このとき `/touryou:start` は、起動の手順を案内します。以降は skill `integrator` に沿って進めます。くわしくは [`docs/plugin.md`](docs/plugin.md)。

- plugin から足した MCP のツールは、`mcp__plugin_touryou_node__*` という名前で出ます。skill・コマンドは、この名前と `mcp__node__*`（daemon が起動する子・手で足した MCP）のどちらでも動くように書いてあります。Claude Code の版を上げたら `node scripts/plugin-mcp-name-check.mjs` で名前を確かめます。

## 既知の問題

- daemon の再起動だけでよい（`touryou-mcp` は起動し直さなくてよい。daemon が戻るまでの間の呼び出しは、1 回の身元の確認あたり最大 8 秒（確認を始めてからの経過時間。操作の締め切りの残りが短ければ、そちら）待ってかけ直し、尽きたら `daemon_unreachable`）。`touryou-mcp` が落ちた・起動し直したときだけ、Claude Code の `/mcp` でつなぎ直す。トークンを取り消した・期限が切れたときは、設定し直して起動し直す。
- `--strict-start`（`--config` があるときの既定）で daemon より先に `touryou-mcp` を起動すると、daemon を待ったあと、終了コード 1 で終わる。待つ時間は、起動時の待ち（`STARTUP_RETRY_MS` = 1・2・4・8 秒、5 回試す。1 回の確認は最大 5 秒）から、接続を拒否されるなら約 15 秒、応答がないなら約 40 秒、届いたあと身元の確認も一時的に失敗し続けると、さらに約 40 秒（合わせて最悪約 80 秒。429 が続くと 1 回あたり最大約 10 秒延びる）。daemon → `touryou-mcp` の順に起動する。
- Desktop の子の見張りのうち、spawn_task のチップから始めた子・`cd` したあと・`CLAUDE_CONFIG_DIR` が違うときの `transcript_path` は、まだ確かめていない（[`docs/manual-verification-checklist.md`](docs/manual-verification-checklist.md) の D2）。
- Desktop の子（`childRuntime: "desktop"`）は実験的。作業範囲外の拒否が十分に効かないので、信頼できない入力（他人のリポジトリ・Issue・Web の内容など）を読ませない（[`docs/desktop-runtime.md`](docs/desktop-runtime.md)）。
- 1 人で使う機械だけで使う（同じユーザーのプロセスは、状態の置き場のトークンを読める）。
- 画面の課題が残っている（確認の欄が見えにくい、Desktop の子の停止の代行依頼が「失敗」と出る、など）。

一覧は [`CHANGELOG.md`](CHANGELOG.md) にもあります。

## 構成

| パス | 役割 |
|:--|:--|
| `packages/core` | 木構造、状態遷移、回収判定、受信箱の整列。純粋関数のみで I/O を持たない |
| `packages/daemon` | イベントログ、ランタイムアダプタ（cli / desktop）、フック受付、HTML 画面 |
| `packages/mcp` | MCP ツール定義、ロール別の公開、エラー設計 |
| `packages/cli` | 人間用コマンド（`touryou`） |
| `plugin` | Claude Code plugin（役割定義 skill、hooks、MCP 設定、起動コマンド） |
| `docs` | 設計の補足・手動確認の手順（設定は [`docs/config.md`](docs/config.md)、リリースは [`docs/release.md`](docs/release.md)） |

## 開発

Node 22 以上と pnpm 10.28.0（`packageManager` で固定）が必要です。

```bash
pnpm install --frozen-lockfile
pnpm check   # lint、typecheck、build、test、plugin 検証をまとめて実行（CI と同じ）
```

`pnpm validate:plugin` は `plugin/.claude-plugin/plugin.json` の JSON 構文、必須項目（name、version、description）、name の kebab-case、version の semver、`plugin/{agents,hooks,skills}` の存在を確認します。

`pnpm install` に「Ignored build scripts: better-sqlite3」という警告が出ますが、無害です。better-sqlite3 13 系はビルド済みのバイナリを同梱しており、ビルドスクリプトを実行しなくても動きます（許可すると、不要なコンパイルが走りうるため許可していません）。

個別に実行する場合は `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm validate:plugin` を使います。整形は `pnpm format` です。

パッケージ単体の `typecheck`・`test`（例: `pnpm --filter @touryou/daemon test`）は、`@touryou/core` を core のソースに別名解決するため、先にビルドしなくても動きます。本番の解決（core の `dist`）は、`pnpm check` の中の `scripts/check-core-resolution.mjs` が確かめます（`pnpm build` の後に実行）。

テストは Vitest と fast-check、lint と format は Biome を使います。

## ライセンス

MIT（[`LICENSE`](LICENSE)）。
