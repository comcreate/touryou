# RC なしで #168・#255 を実機で確かめられるか（調査）

> 調べた日: 2026-11-24。main の 66bba70 を基にした作業ツリー。コードは変えていない。
> 言葉の約束: **確認できた**＝この調査でリポジトリのファイルを読んで確かめた。**未確認**＝読んでいない・実機で試していない（推測は、推測と書く）。
> 統括の指示（受信箱 6206）に従い、`~/.touryou` の実際の中身（置き場・常駐の状態）は見ていない。置き場の中身を見ないと分からないことは「未確認」に入れた。

## 0. 危険な点（先に読む）

1. **既定の HOME のまま、ブランチのものを `~/.touryou/current` に置かない。** 常駐の daemon（launchd）と、ほかの統合セッション・子のフック・MCP が、すべて `$HOME/.touryou/current/bin` を通る（`plugin/hooks/hooks.json:10`・`plugin/scripts/touryou-mcp-shim.sh:17`）。付け替えると、動いている全部の木が、ブランチのコードに切り替わる。
2. **別の HOME で `touryou launchd init`・`apply` を実行しない。** launchd の登録は、HOME ではなくログインの利用者（gui の領域）ごと。既定の Label は `touryou.daemon`（`packages/cli/src/commands.ts:158`）で、いまの常駐と同じ名前になり得る（衝突の実際の動きは**未確認**）。別の HOME の daemon は、手で起動する（`plugin/commands/setup.md:68` の 3-B の形）。
3. **既存の `~/.touryou/config.json` と `state` を指さない。** 別の設定・別の `stateDir`・別の `repoRoot`・別の `worktreeRoot` にする（同じ `stateDir` を 2 つの daemon が使ったときの動きは**未確認**。`docs/config.md:15`、`plugin/commands/setup.md:74` は「設定ファイル・stateDir・ポートは、1 つ目と別にする」）。
4. **`/touryou:setup` を別の HOME で走らせても、ブランチのコードは入らない。** `install-runtime.sh` は、plugin の中の `checksums.json`・`plugin.json` の版で GitHub Release から取得して照合する（`plugin/commands/setup.md:21`・`:36`）。手元の tar.gz は渡せない（引数は `--restart-daemon` だけ）。置き場は手で作る（3 節）。
5. **別の HOME では、git・gh・Claude の設定の一部が変わる。** `~/.gitconfig`（コミットの名前・メール）・`gh` の認証・`~/.claude`（`CLAUDE_CONFIG_DIR` を使っていないとき）は HOME の下にある。Claude Code の認証が HOME を変えても通るかは**未確認**（この Mac は `CLAUDE_CONFIG_DIR` を使っているので、その環境変数を残せば設定の置き場は変わらない見込み。推測）。

## 1. どの部品の新しいコードが要るか

### 1.1 部品の通り道（確認できた）

| 部品 | 子・統合のセッションからの呼ばれ方 | 根拠 |
| --- | --- | --- |
| フック（PreToolUse など） | plugin の `hooks.json` が `${HOME}/.touryou/current/bin/touryou hook` を呼ぶ。**HOME が決める**。plugin の場所では変わらない | `plugin/hooks/hooks.json:10`・`:22`・`:33`・`:45` |
| MCP（`node`。統合も子も） | plugin の `.mcp.json` → `touryou-mcp-shim.sh` → `${HOME}/.touryou/current/bin/touryou-mcp --stdio`。**HOME が決める** | `plugin/.mcp.json:5-8`、`plugin/scripts/touryou-mcp-shim.sh:17-22` |
| MCP がつなぐ daemon | `--config` → `TOURYOU_DAEMON_CONFIG` → `$HOME/.touryou/config.json` の `stateDir` | `packages/mcp/src/stdio.ts:5`・`:202-203`、`docs/config.md:184` |
| `touryou` CLI（フック・`reclaim` など）がつなぐ daemon | `TOURYOU_DAEMON_CONFIG`、なければ `$HOME/.touryou/config.json` | `packages/cli/src/bin.ts:125-134` |
| 紐付けのコード | 作業ツリーの git のディレクトリの `touryou-bind-code`（起動の文には入れない） | `packages/mcp/src/bind-code-file.ts:4-5`、`packages/daemon/src/sdk/launch-command.ts:9-10` |
| 子の plugin | 親の mcp が `CLAUDE_PLUGIN_ROOT` を添え、daemon が起動の文に `--plugin-dir '<場所>'` を足す。場所は `repoRoot`・`worktreeRoot`・`stateDir`・`$HOME/.touryou` の中だと付けない | `packages/daemon/src/sdk/launch-command.ts:4-5`・`:77`、`packages/daemon/src/sdk/plugin-dir.ts:4-12`、`packages/daemon/src/compose.ts:181` |
| skill の文（integrator・child） | plugin の場所（`--plugin-dir` か、marketplace のキャッシュ） | `plugin/skills/integrator/SKILL.md` |
| daemon の身元の確かめ | `stateDir` の秘密のファイルによるチャレンジ応答。置き場のパスには依らない | `docs/daemon-identity.md:8`・`:16` |
| 版の表示 | `TOURYOU_DIST_VERSION` → `lib/dist-version` → 隣の package.json。開発のビルドでも動く | `packages/core/src/version.ts:7-22`、`packages/daemon/src/bin.ts:28-31` |

要点: **フックと MCP は、plugin の版ではなく `$HOME/.touryou/current/bin` の中身で動く。** plugin（`--plugin-dir`）をブランチにしても、HOME の下の配布物が古ければ、フック・`child_bind`・自動の結び直しは古いコードのまま。

### 1.2 #255（自動の結び直し）の場所（確認できた）

- 子の MCP（`touryou-mcp`）の中: `packages/mcp/src/auto-bind.ts:1-15`（60 秒から倍々・最大 10 分。コードのファイルがなければコードなしの結び直し）、`packages/mcp/src/child-bind.ts`・`node-credential.ts`。
- daemon の側: `packages/daemon/src/api/handlers/bind-handlers.ts`・`credentials.ts`・`bind-notices.ts`・`cli-watch.ts`（ファイル名を `git grep` で確認。中身は読んでいない）。
- 説明: `CHANGELOG.md:27-28`。

→ **touryou-mcp（HOME の配布物）と daemon の両方の新しいコードが要る。**

### 1.3 A〜I の分け方

「ブランチのコード」＝ `pnpm build` の成果物を直に動かせば足りる。「置き場が要る」＝ 別の HOME の `.touryou/current/bin` にブランチのものを置く必要がある（3 節。RC は要らない）。「RC が要る」＝ 配布の仕組みそのもの。

| 項目（`.sdd/task/168/acceptance.md` 6 節） | 要る部品 | 分類 | 根拠 |
| --- | --- | --- | --- |
| A 立てて紐付ける（A-4: `role: integrator`） | daemon（spawn・bind）、touryou-mcp（`child_bind` の道具の切り替え）、plugin（integrator の起動の文・skill） | 置き場が要る | 1.1 の MCP の行。A-4 は子の MCP の `child_bind`（`packages/mcp/src/child-bind.ts`） |
| B 孫を 2 つ | daemon、touryou-mcp、フック | 置き場が要る | 同上 |
| C 深さの上限 | daemon（`spawn-handlers.ts:466-473`）。呼ぶのはサブ統括の MCP | 置き場が要る（サブ統括のセッションが要る） | acceptance.md の 1 節 |
| D 範囲（フックの拒否・`scope_extend`） | フック（`touryou hook` → daemon の `hook-policy`）、touryou-mcp | 置き場が要る | `plugin/hooks/hooks.json:10`、`compose.ts:1664-1667` |
| E 状態画面 | daemon の `/ui` だけ | ブランチのコードで足りる（`node packages/daemon/dist/bin.js --config <別設定>`）。ただし中身の木は A・B で作る | ブリーフの背景、`docs/config.md:3` |
| F 要約に自由文が入らない | daemon（digest）、孫の MCP（`report_progress`） | 置き場が要る（孫を動かすため） | acceptance.md の 3 節 |
| G 連動停止 | daemon（`stop-cascade`）、サブ統括の MCP（`parent_request` を受けて `claude stop`） | 置き場が要る | acceptance.md の 4 節 |
| H 応答しないとき | daemon、根の MCP（`node_confirmStopped`） | 置き場が要る | 同上 |
| I 回収 | `touryou reclaim`（CLI）と daemon | ブランチのコードで足りる（`TOURYOU_DAEMON_CONFIG` を付けて `node packages/cli/dist/bin.js reclaim …`）。ただし `runtime-handlers.ts:75` などの案内の文は `"$HOME/.touryou/current/bin/touryou"` を指す | `packages/cli/src/bin.ts:125-134`、`packages/daemon/src/api/handlers/runtime-handlers.ts:75` |
| #255 自動の結び直し | 子の touryou-mcp（`auto-bind.ts`）、daemon | 置き場が要る | 1.2 |

**RC が要る項目は、A〜I と #255 の中には見つからなかった**（下の 4 節の未確認が崩れたときを除く）。RC でないと確かめられないのは、配布の仕組みのほう（4 節）。

## 2. 別の HOME に置き場を作れるか

### 2.1 配置の形（確認できた）

`scripts/dist-build.sh` が作る tar.gz の中身（`touryou-darwin-arm64/`）:

- `bin/touryou`・`bin/touryou-mcp`・`bin/touryou-daemon`: `#!/bin/sh` の起動スクリプト。`$here/bin/node $here/lib/<JS>` を exec し、`TOURYOU_DIST_VERSION` を設定（`scripts/dist-build.sh:144-157`）。
- `bin/node` → `TouRyou.app/Contents/MacOS/TouRyou`（macOS。ad-hoc 署名）（`:33-38`・`:162-200`）。
- `lib/`: `pnpm deploy` した daemon と、`node_modules/@touryou/{mcp,cli}`（`:50-56`）。`lib/dist-version`（`:154`）。
- 配布物では `DEV_BUILD` を `false` にする（試験用の抜け道 `TOURYOU_CLI_ALLOW_UNVERIFIED` が効かない）（`:57-62`、`docs/release.md:104-106`）。

`/setup` が置く形: `$HOME/.touryou/v<版>` に展開し、`$HOME/.touryou/current` をそこへのリンクにする。設定は `$HOME/.touryou/config.json`、状態は `$HOME/.touryou/state`（0700）（`plugin/commands/setup.md:36`・`:56`）。

フック・shim が見るのは `${HOME}/.touryou/current/bin/touryou`・`touryou-mcp` が**実行できること**（`-x`）だけ（`plugin/hooks/hooks.json:10`、`touryou-mcp-shim.sh:18`）。版の照合・署名の検査は、フック・shim・daemon の側では見つからなかった（`git grep` で `current/bin`・`dist-version` を daemon・mcp・core の src に当てた結果。確認できた範囲）。

### 2.2 作り方（2 案）

- **案 X（推奨: 配布物と同じ形）**: `bash scripts/dist-build.sh <出力>` で tar.gz を作り、別の HOME の `.touryou/v-local` に展開し、`current` をリンクにする。前提: `pnpm install --frozen-lockfile` と `pnpm build` が済んでいる（`dist-build.sh:3`）。nodejs.org から Node を取得する（ネットワークが要る。`:22-29`）。macOS では `codesign`・`sips`・`iconutil` を使う（`:182-195`）。
- **案 Y（簡易: 開発のビルドを直に指す）**: 別の HOME の `.touryou/current/bin/` に、`node <リポジトリ>/packages/<pkg>/dist/bin.js "$@"` を exec する起動スクリプト 3 本を手で置く。`DEV_BUILD` が `true` のまま（配布物と違う）。node は絶対パスで書く（フックが動く子の環境の PATH に、開発の node があるかは**未確認**）。リポジトリの作業ツリーを書き換えると、動いている子のコードも変わる。

### 2.3 daemon の設定と、分けるもの

- 設定は必須の 5 項目（`stateDir`・`repoRoot`・`worktreeRoot`・`rootCwd`・`rootScope`）（`plugin/commands/setup.md:58`、`docs/config.md`）。トークンは daemon が `stateDir` に作る（`docs/config.md:8`）。
- ポート: `port` が 0（既定）なら、`--port` がなければ `stateDir` に保存したもの（`packages/daemon/src/config.ts:280`）。`stateDir` を分ければ、既存の daemon と別のポートになる見込み（新しく選ぶ規則の本体は読んでいない。**未確認**）。
- `stateDir`・`repoRoot`・`worktreeRoot` は互いに重ねない（`docs/config.md:23-33`）。
- **`repoRoot` は、確かめ用の別の git リポジトリにする。** 子の `--plugin-dir` は `repoRoot`・`worktreeRoot`・`stateDir`・`$HOME/.touryou` の中だと付かない（`compose.ts:181`、`plugin-dir.ts:8-9`）。touryou のリポジトリ自身を `repoRoot` にし、同じリポジトリの `plugin/` を `--plugin-dir` に渡すと、子に plugin が付かない。
- 分けるもの: HOME・設定ファイル・`stateDir`・`repoRoot`・`worktreeRoot`・plugin の場所。launchd は使わない（0 節の 2）。

## 3. 手順（コマンドを 1 つずつ。人が別のターミナルで実行する）

`<ALT>` は、ホームの下の新しいディレクトリの絶対パス（例: `/Users/<名前>/touryou-alt`）。`<REPO>` は touryou のブランチの作業ツリー。`<VREPO>` は確かめ用の別の git リポジトリ。値は引用符で囲む。

### 3.1 ビルド（既存に触れない）

1. `cd "<REPO>"`
2. `pnpm install --frozen-lockfile`
3. `pnpm build`
4. （案 X）`bash scripts/dist-build.sh "<ALT>/dist"` — `<ALT>/dist/touryou-darwin-arm64.tar.gz` ができる。

### 3.2 別の HOME の置き場（案 X）

5. `mkdir -p "<ALT>/home/.touryou/v-local"`
6. `tar -C "<ALT>/home/.touryou/v-local" --strip-components 1 -xzf "<ALT>/dist/touryou-darwin-arm64.tar.gz"`
7. `ln -s v-local "<ALT>/home/.touryou/current"`
8. `env HOME="<ALT>/home" "<ALT>/home/.touryou/current/bin/touryou-daemon" --help` — 動くことの確かめ（`/setup` の `--help` の確かめと同じ。`setup.md:36`）。

### 3.3 確かめ用のリポジトリと設定

9. `mkdir -p "<VREPO>"`
10. `git -C "<VREPO>" init`
11. `git -C "<VREPO>" commit --allow-empty -m init`
12. `mkdir -p "<ALT>/home/.touryou/state" "<ALT>/worktrees"`
13. `chmod 700 "<ALT>/home/.touryou/state"`
14. `<ALT>/home/.touryou/config.json` を、エディタで作る（`chmod 600`）。中身は `plugin/commands/setup.md:56` の形で、`stateDir` は `<ALT>/home/.touryou/state`、`repoRoot`・`rootCwd` は `<VREPO>`、`worktreeRoot` は `<ALT>/worktrees`。`rootScope` は A〜D の例が入る広さ（`writableLocations: ["docs", "src"]`、`allowedCommands: ["git status", "git add", "git commit"]`）。

### 3.4 daemon を手で起動（ターミナル 1）

15. `env HOME="<ALT>/home" "<ALT>/home/.touryou/current/bin/touryou-daemon" --config "<ALT>/home/.touryou/config.json"` — 窓口の URL が出る。既存の常駐とは、`stateDir` とポートが別。

### 3.5 根の統合セッション（ターミナル 2）

16. `cd "<VREPO>"`
17. `env HOME="<ALT>/home" CLAUDE_CONFIG_DIR="<いまの CLAUDE_CONFIG_DIR>" claude --plugin-dir "<REPO>/plugin"` — `CLAUDE_CONFIG_DIR` は、いまのものを残す（0 節の 5）。`TOURYOU_DAEMON_URL` は環境に置かない（`plugin/commands/start.md:13`）。
18. セッションで `/touryou:start`。`whoami` が `integrator`・根を返し、`tree_list` の根の `repoRoot` が `<VREPO>` なら、別の daemon につながっている（`setup.md:74` の「`daemon.repoRoot`・`daemonId` で確かめる」）。
19. 以後、`.sdd/task/168/acceptance.md` の 6 節を、A-4 と G を先に行う。起動の依頼の `command` に `--plugin-dir '<REPO>/plugin'` が入っていることを、承認の画面で見る（`launch-command.ts:77`）。
20. I は、ターミナル 3 で `env HOME="<ALT>/home" "<ALT>/home/.touryou/current/bin/touryou" reclaim <nodeId>`。

### 3.6 #255 の確かめ

21. 子を 1 つ立てて紐付けたあと、daemon（ターミナル 1）を Ctrl-C で止め、同じコマンド（15）で起動し直す、などで紐付けを外す（どの操作で「外れる」に当たるかは `cli-rebind-server.test.ts`・`auto-bind-stdio.test.ts` を読んで決める。この調査では読んでいない。**未確認**）。
22. 見るもの: 子の受信箱に固定の 1 行が出て、子が `child_bind` を打たずに道具を使える（`CHANGELOG.md:27`）。最大 10 分かかることがある。

### 3.7 後片付け

23. ターミナル 1 の daemon を Ctrl-C。ターミナル 2 の Claude を閉じる。子は `claude agents --json` で確かめ、`claude stop <名前>`。
24. `<ALT>`・`<VREPO>` を消す（人が判断する）。既存の `~/.touryou` と launchd には、手順のどこでも触れていない。

## 4. 未確認（統括か人が確かめる）

1. **`claude --bg` の子が、起動した Bash の HOME（と環境変数）を受け継ぐか。** 子は、親のセッションが Bash で起動する（`setup.md:82`、`launch-command.ts:4`）。`--bg` のセッションを動かす裏の仕組みが、すでに既定の HOME で動いていて、その環境で子を起こすなら、子のフック・MCP は既存の `~/.touryou/current` と既存の daemon を見る。その場合、子の `child_bind` が断られ、「この子を作った daemon と、plugin（mcp）の接続先が同じかを確かめて」の文が出るはず（`packages/mcp/src/child-bind.ts:55`、`stdio.ts:522`）。**これが崩れると、別の HOME の方法では A〜D・F〜H・#255 を確かめられない**（その場合、RC か、既定の HOME への配置が要る）。最初に、A-1〜A-4 の 1 回で確かめる。
2. 別の HOME で、Claude Code の認証（macOS のキーチェーン）が通るか。
3. 別の HOME で起動した Claude に、marketplace から入れた touryou の plugin も読まれるか（`CLAUDE_CONFIG_DIR` を残すと読まれる見込み）。読まれたとき、`--plugin-dir` のものとどちらの skill・hooks が効くか（`setup.md:78` は「重なっても 1 つにまとまる」とだけ書く）。フック・MCP は、どちらの plugin でも `$HOME/.touryou/current` を呼ぶので、置き場が同じなら動きは同じ（1.1）。skill の文だけが違い得る。
4. 同じ Label（`touryou.daemon`）の launchd の衝突の実際の動き（0 節の 2。この手順では launchd を使わないので、確かめなくてよい）。
5. 新しい `stateDir` のときのポートの選び方の本体（`config.ts:280` のコメントだけ読んだ）。
6. 案 Y で、子のフックの環境に node があるか。
7. 既存の `~/.touryou` の中身（版・常駐の有無・`config.json`）。統括の指示どおり見ていない。

## 5. RC でないと確かめられないもの

A〜I・#255 ではなく、配布の仕組みそのもの:

- `/touryou:setup` の取得・照合（`install-runtime.sh` は Release の URL と `checksums.json` に固定。`setup.md:21-23`）。
- marketplace の plugin のキャッシュの更新（`claude plugin update`）と、`SessionStart` の版の食い違いの知らせ（`hooks.json:57`。plugin の版と配置の版の両方が要る）。
- launchd の常駐の版上げ（`--restart-daemon`。`setup.md:139-147`）、ログイン項目の TouRyou の表示。
- Release の asset（zip・tar.gz・.mcpb）と sha256。

これらは `docs/release.md:21-26` の手順 0（rc を作って A'・B）の範囲で、この調査の手順では置き換えられない。

## 6. 結論

- **RC なしで確かめられる**: A〜I と #255（4 節の 1 が成り立つとき）。E と I はブランチのビルドを直に動かすだけでも足りる。ほかは、別の HOME に `.touryou/current/bin` をブランチから作る（3 節）。
- **RC が必要**: A〜I・#255 には、ない。`/setup`・marketplace・launchd・版の知らせは RC が要る（5 節）。
- 最初にすること: 3 節の 1〜18 のあと、A-1〜A-4 で、子が別の HOME の daemon に紐付くか（4 節の 1）を確かめる。紐付かなければ、この方法は使えず、RC（または既定の HOME への配置）に戻る。
