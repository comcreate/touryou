# ビルド済み配布物の実機確認（人が行う）

目的: Node 同梱の配布物（`touryou-darwin-arm64.tar.gz`。**対象は macOS の arm64 のみ**。x64〔Intel〕は対象外）が、**Node のない Mac** で、取得して展開するだけで動くかを確かめる。確かめるのは、(1) Node なしで daemon が起動する (2) Gatekeeper・署名の影響 (3) フック（`touryou hook`）が Node なしで動く (4) `touryou-mcp --stdio` が動く。

- 配布物は、Release の asset か、Actions（`CI (macOS)`）の artifact から取る。
- 配布物の中身（tar の一覧・特殊なファイル・シンボリックリンクが展開先の外や行き先のない所を指さないこと）は、CI の `scripts/dist-smoke.sh` が、利用者の `/setup` と同じ検査（`scripts/dist-check.sh`。`install-runtime.sh` の関数をそのまま使う）で確かめる。手元で確かめるなら `bash scripts/dist-check.sh <tar.gz の絶対パス>`（#56）。
- **トークン・パスの値は、どこにも書き写さない**。
- 作業用のディレクトリは、各自の一時の場所の下を使う。
- 各手順の「CI の確認」欄: **CI で確認できる** = CI の macOS runner（arm64）で同じ操作を通している。**実機だけ** = 実機でしか確かめられない。

## 0. 準備

| 項目 | 操作 | 期待 |
|:--|:--|:--|
| 機種の確認 | `uname -m` | `arm64`（Apple Silicon）。`x86_64`（Intel）は対象外 |
| Node がない | `command -v node` | 何も出ない。出る機種は、手順の `env -i PATH=/usr/bin:/bin` で外した状態で行う |
| 作業場所 | `work="$(cd "$(mktemp -d)" && pwd -P)"; echo "$work"; cd "$work"` | 値を**控える**（`pwd -P`: macOS の `/var` はリンクで、設定のパスは実パスで書く）。手順 4 の 2 つ目の端末で使う |
| 取得 | 下の「artifact の取り方」か、手順 3 の curl の経路で取る（tar.gz と `.sha256`）。ブラウザでの取得は、quarantine の比較のためだけに使う | 2 ファイルが得られる |

### artifact の取り方

main への push では、配布物は作られない（`CI (macOS)` の配布物の確かめは、手動実行と、関連ファイルを変える PR だけで動き、artifact を上げるのは手動実行のときだけ）。**検証の直前に、手動で実行する**。

1. リポジトリの Actions → 左の一覧の `CI (macOS)` → `Run workflow`（ブランチは `main`）。
2. 実行が終わる（`check (macos-latest, node 24)` が緑）のを待ち、その実行のページの下の Artifacts から、`touryou-dist-macos-latest`（arm64）をダウンロードする。
3. artifact は **1 日で消える**。消えたら、1. からやり直す。ダウンロードには、GitHub にログインしている必要がある。

> **x64（Intel）は対象外**（決定。Apple が Intel Mac を OS のサポート対象外としている。将来の課題）。この手順書は、arm64 の Mac で、arm64 の配布物（名前に `darwin-arm64`）を使う。

## 1. 検証（sha256）

```sh
shasum -a 256 -c touryou-*.tar.gz.sha256
```

期待: `OK`。NG は、ダウンロードの破損。取り直す。CI の確認: **CI で確認できる**（同じ値が作られる）。

## 2. 展開と起動（Node なし）

```sh
tar -xzf touryou-*.tar.gz
dir="$(ls -d "$PWD"/touryou-darwin-*)"
env -i PATH=/usr/bin:/bin HOME="$work" "$dir/bin/node" -v
env -i PATH=/usr/bin:/bin HOME="$work" "$dir/bin/touryou-daemon" --help | head -3
```

| 出たもの | 意味 |
|:--|:--|
| Node のバージョンと使い方が出る | OK |
| 「開けません」「検証できません」と出る、または `Killed: 9` | Gatekeeper・署名の問題（quarantine が原因のことが多い）。手順 3 へ |
| `Bad CPU type in executable` | 機種と配布物が違う |
| `No such file` | 展開の失敗、または実行権がない（`ls -l "$dir/bin"`） |

CI の確認: 展開と起動は **CI で確認できる**（runner で `env -i PATH=/usr/bin:/bin` の起動が通る）。Gatekeeper の影響は **実機だけ**（runner の展開先には quarantine が付かない）。

## 3. Gatekeeper・quarantine

### 前提となる振る舞い

- ブラウザで取った tar.gz を Terminal の `tar -xzf` や Finder で展開すると、展開後のファイルに quarantine が付く（tar がアーカイブの quarantine を引き継ぐ）。
- quarantine が付いたままでも `node -v`・`touryou-daemon --help` は通るが、daemon は約 1 分後に `storeError` で終わる（`better-sqlite3` の adhoc 署名の `.node` を、システムのポリシーが読み込ませない: `library load disallowed by system policy`）。
- そのため、配布物は、ブラウザ・メール・AirDrop などでは取らない。`/setup` は **`curl`（認証なし）で取得する**。curl は quarantine を付けない（下の根拠）。
- 取得・展開のあとに、**quarantine が付いていないこと**を確かめる。付いていれば、「配布物を、ブラウザでなく `/setup` の curl で取り直す」と案内して**止まる**。**`/setup` が quarantine を自動で外すことはしない**（macOS の安全装置を、利用者の知らないうちに外すことになるため。外すかどうかは、人が判断する）。

### 根拠（出典と確度）

- Apple の説明では、`LSFileQuarantineEnabled`（Info.plist）が真のアプリは、**そのアプリのプロセスが作るファイルすべてが quarantine される**。このキーを設定しない（未サンドボックスの）アプリが作るファイルには、既定では quarantine が付かない。[Launch Services Framework Release Notes](https://developer.apple.com/library/archive/releasenotes/Carbon/RN-LaunchServices/)、[Launch Services Keys](https://developer.apple.com/library/watchos/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html)、[Eclectic Light: Who decides to quarantine files?](https://eclecticlight.co/2025/12/08/who-decides-to-quarantine-files/)。確度: 中〜高（文書による。macOS の版による変更は未確認）。
- `curl` は Info.plist を持たないコマンドラインの実行ファイルなので、quarantine を付けない。確度: 中〜高。
- 親プロセス（Claude Code のアプリ）が `LSFileQuarantineEnabled` を持ち、その設定が子プロセス（`curl`）に引き継がれて quarantine が付くかは、文書では裏づけられない。**実機で確かめる**（次の手順）。

### 確かめる手順（curl の経路。`/setup` の経路）

ブラウザを使わず、curl で Release の asset を取得する（`<asset の URL>` は置き換える）。期待: `xattr -l` が `com.apple.quarantine` を出さない、最後の `grep -c` が `0`。

```sh
curl -fSL -o "$work/dist.tar.gz" "<asset の URL>"
xattr -l "$work/dist.tar.gz"
tar -xzf "$work/dist.tar.gz" -C "$work"
xattr -lr "$work"/touryou-darwin-* | grep -c quarantine
```

- **ターミナル（Terminal.app など）から**実行した場合と、**Claude Code のアプリの中（`/setup` と同じく、モデルが Bash で実行）から**実行した場合の、両方で確かめる。後者で quarantine が付いたら、親プロセスの影響（上の根拠の 3 つ目）の証拠になる。
- 取得後の起動（手順 2・4）が通ること。

### 比較の手順（ブラウザでの取得）

ブラウザでの取得（A・B）は、**利用者の経路ではない**（比較・再現のため）。1 行目は取得した tar.gz 本体の quarantine、2 行目は展開後の node の quarantine。

```sh
xattr -l touryou-*.tar.gz
xattr -l "$dir/bin/node"
codesign -dv "$dir/bin/node" 2>&1 | head -5
spctl -a -vv "$dir/bin/node" 2>&1 | head -3
```

- **A. ブラウザ取得 → Terminal の `tar -xzf`**: 期待: 展開後のファイルに quarantine が付く。手順 2 の `--help` までは通り、手順 4 の daemon が約 1 分後に失敗する。
- **B. ブラウザ取得 → Finder で展開**: 期待: A と同じ。
- **C. quarantine を外した場合**（A・B の後に `xattr -dr com.apple.quarantine "$dir"`）: 期待: daemon が起動し、窓口が 401。比較のためだけで、利用者に求めない。
- 署名の期待（#73 から）: `TouRyou.app`（中の `Contents/MacOS/TouRyou` が node）は ad-hoc（`Signature=adhoc`・hardened runtime なし）。`bin/node` は、それへのリンク。`touryou`・`touryou-daemon`・`touryou-mcp`（起動スクリプト）は署名なし。`better-sqlite3` の `.node` は adhoc（linker-signed）。

### 起動に失敗したときの症状

| 症状 | 原因の見立て | 直し方 |
|:--|:--|:--|
| `node -v`・`--help` は通るが、daemon が約 1 分後に `storeError` で終了。標準エラーに `library load disallowed by system policy` | 配布物に quarantine が付いている（ブラウザ・Finder・AirDrop などで取得した） | **`/setup` の curl で取り直す**。`xattr -lr <展開先> \| grep -c quarantine` が 0 になること。外す操作は、人が判断する |
| `Killed: 9`、「開けません」 | 署名・Gatekeeper | 上と同じ原因の可能性。`xattr -l` を確かめる |
| `Bad CPU type in executable` | 機種と配布物が違う | `uname -m` と配布物の名前を合わせる |

## 4. daemon の起動と窓口

設定は、`docs/config.md` の必須の項目だけ。`stateDir` は 0700、設定ファイルは 0600。

```sh
mkdir -m 700 "$work/state" "$work/wt"; mkdir "$work/repo"
git -C "$work/repo" init -q && git -C "$work/repo" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m init
cat > "$work/config.json" <<JSON
{ "stateDir": "$work/state", "repoRoot": "$work/repo", "worktreeRoot": "$work/wt", "rootCwd": "$work/repo",
  "rootScope": { "writableLocations": ["src"], "forbiddenLocations": [".git"], "allowedCommands": ["git status"] } }
JSON
chmod 600 "$work/config.json"
env -i PATH=/usr/bin:/bin HOME="$work" "$dir/bin/touryou-daemon" --config "$work/config.json"
```

最後の行の daemon は動き続ける。この端末は開いたままにする。

**2 つ目の端末**を開き、手順 0 で控えた値を設定してから確かめる（`work` は別の端末のシェルに引き継がれない）。

```sh
work=<手順 0 で控えた値>
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$(cat "$work/state/port")/v1/whoami"
```

| 期待 | 失敗の見分け |
|:--|:--|
| 起動の記録に `started` が出る。上の curl が `401` | `better-sqlite3` の読み込み失敗 → 標準エラーの JSON の `error`。ポートの使用中 → 別の daemon が動いている |

CI の確認: **CI で確認できる**（runner で daemon が起動し、窓口が 401 を返す。同梱の node で `better-sqlite3` を開く確認も通る）。

## 5. フック（Node なし。`touryou hook`）

フックは、`hooks.json` の POSIX シェルの 1 行（`scripts/hook-commands.mjs` が正本）が、`$HOME` 基準の `.touryou/current/bin/touryou`（`/setup` が置く）を `exec` して、`touryou hook` を呼ぶ。**Node は要らない**。**絞った PATH で、実際に実行して確かめる**（`<plugin のディレクトリ>` は、インストールした plugin の場所に置き換える）。

**`HOME` について**: フックは `$HOME/.touryou/current/bin/touryou` を探す。(a) は、`/setup` で `$HOME/.touryou/current` に置いた状態で、`HOME="$HOME"`（自分のホーム）で行う。手順 2 の `$work` に展開しただけでは、フックからは見えない（(b) と同じ「未配置」になる）。(b) は、`HOME` を空の場所にして、未配置の状態を作る。

(a) の 2 行: 環境変数なし → 0。URL とトークンあり（daemon には届かない）→ 2。

```sh
cmd="$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "<plugin のディレクトリ>/hooks/hooks.json")"
in='{"hook_event_name":"PreToolUse","session_id":"s","tool_name":"Write","tool_input":{}}'
echo "$in" | env -i PATH=/usr/bin:/bin HOME="$HOME" sh -c "$cmd"; echo "exit=$?"
echo "$in" | env -i PATH=/usr/bin:/bin HOME="$HOME" TOURYOU_DAEMON_URL=http://127.0.0.1:1 TOURYOU_NODE_TOKEN=x sh -c "$cmd"; echo "exit=$?"
```

(b): URL とトークンあり → 2（「/setup を実行する」）。

```sh
empty="$(mktemp -d)"
echo "$in" | env -i PATH=/usr/bin:/bin HOME="$empty" TOURYOU_DAEMON_URL=http://127.0.0.1:1 TOURYOU_NODE_TOKEN=x sh -c "$cmd"; echo "exit=$?"
```

期待: (a) 1 つ目は `exit=0`（何も出さない。「フックは働いていない」は、(a) でなく `touryou` が未配置のときにシェルの 1 行が出す）、2 つ目は `exit=2`（「届かない」）。(b) は `exit=2`（「touryou が見つからない」）。Stop・PostToolUse の command（`.hooks.Stop[0]…`）は、(b) でも `exit=0`（Stop が詰まらない）。CI の確認: `touryou hook` の本体は **CI で確認できる**（`dist-smoke` と、Linux の `scripts/dist-smoke-hook.test.mjs`。どちらも `scripts/dist-smoke-hook.sh` を使う）。`hooks.json` の command は、`scripts/hooks-command.test.mjs` が `sh -c` で確かめる。arm64 の Mac での実行は **実機だけ**（次の項目）。

**実機で確かめる項目**:

- Claude Code が、実際に、この command を `sh -c` で実行し、`exec` された `touryou hook` に、標準入力が渡ること（範囲外の `Write` の拒否で確かめるときは、子のセッションで行う。統合セッションは `TOURYOU_NODE_TOKEN` を持たないので、フックは素通しで、拒否されないのが正常）
- 標準入力を読まない分岐（`touryou` 未配置）で、Claude Code が、EPIPE などの警告を出さないこと
- `PostToolUse`・`Stop` で、`touryou` 未配置・子の環境変数ありのとき、Claude が止まれる（会話が続かない）こと

## 6. touryou-mcp（`--stdio`）

`touryou-mcp` の入口は、統合セッション用の `--stdio` だけ。`$HOME/.touryou/config.json` の `stateDir` から、根のトークン（`root-token`）・daemon の窓口（`port`）・daemon の身元を自分で読む。トークンは、引数・環境変数に出ない。ここでは、`/setup` で `$HOME/.touryou` に置き、その設定の daemon（常駐か手で起動）が動いている状態で、手で起動して initialize に答えることだけを確かめる（会話からの確かめは、`docs/manual-verification-checklist.md` の N）。

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
  | env -i PATH=/usr/bin:/bin HOME="$HOME" "$HOME/.touryou/current/bin/touryou-mcp" --stdio
```

期待: `"id":1` を含む JSON の 1 行が標準出力に返り、標準入力が閉じると終わる。daemon が動いていない場合の見え方は、checklist の N3。CI の確認: 起動口は **CI で確認できる**。会話からの接続は **実機だけ**。

後片付け: daemon を Ctrl-C で止め、`rm -rf "$work"`。
