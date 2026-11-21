# #161・#162 調査（読み取りのみ）

調べた範囲: 作業ツリー（main の 1df72e7 相当）のコードと docs。配布物 `$HOME/.touryou/current` は、`bin`・`lib`・`TouRyou.app` があることだけ確かめた（v0.1.5 の `dist` の中身は、ソースと同じとみなし、読んでいない）。
【事実】= 読んで確かめた。【推測】= 読んでいない・動かしていない。

## 1. #162（MCP が TOURYOU_DAEMON_CONFIG を読まない）

### 1-1. 接続先の決め方の比較【事実】

| 部品 | 場所 | 決め方 |
|:--|:--|:--|
| MCP | `packages/mcp/src/stdio.ts` の `resolveDaemonEndpoint`（149 行〜） | 引数 `--config` → 無ければ `$HOME/.touryou/config.json`。**環境変数は見ない**。env は `HOME` だけ使う（168 行） |
| CLI | `packages/cli/src/bin.ts` `localDaemonOf`（106 行〜）・273 行 | `TOURYOU_DAEMON_CONFIG` → `$HOME/.touryou/config.json` |
| hook | `packages/cli/src/hook.ts` 188 行〜 | 同上 |
| ui | `packages/cli/src/ui.ts` 54 行〜 | 同上 |
| plugin `.mcp.json` | `plugin/.mcp.json` | `/bin/bash <plugin>/scripts/touryou-mcp-shim.sh`。引数なし・`env` 指定なし |
| シム | `plugin/scripts/touryou-mcp-shim.sh` | 試し起動（24 行）・exec（25 行）・待機中の試し起動（62 行）・handoff（47 行）の 4 か所すべて `touryou-mcp --stdio` を引数なしで起動。`target` は `$HOME/.touryou/current/bin/touryou-mcp` 固定 |
| launchd / service | `packages/cli/src/launchd.ts` 68〜 / `launchd-service.ts` 657 行〜 | `$HOME/.touryou/config.json` 固定（`TOURYOU_DAEMON_CONFIG` を見ない。`--config` の引数もない） |
| `/touryou:start`・`status` | `plugin/commands/*.md` | 文面が `$HOME/.touryou/config.json`・`$HOME/.touryou/state` 固定 |

食い違いは、MCP と、launchd 系のサブコマンドの 2 系統。Issue は MCP だけを挙げているが、launchd 系も同じ型の食い違い（後述 2）。

### 1-2. 直す箇所【事実から導く】

1. `packages/mcp/src/stdio.ts` `resolveDaemonEndpoint`: 優先順位を `--config` → `env.TOURYOU_DAEMON_CONFIG`（空は無視）→ `$HOME/.touryou/config.json` にする（`bin.ts` の `nonEmpty` と同じ流儀）。CLI・hook・ui と同じ。
   - `touryouProblem = dirProblem(touryou)`（`$HOME/.touryou` の権限検査）は、設定が `$HOME/.touryou` の外のとき意味がずれる。**外の設定を使うとき、検査の対象を「設定ファイルの親ディレクトリ」に替えるかの判断が要る**（Issue の例の `~/.touryou-renga/config.json` は、これで通る必要がある）。
2. シム（`touryou-mcp-shim.sh`）: シムは環境変数を明示して渡さなくても、子の `touryou-mcp` は親の環境を引き継ぐ（bash の `exec`・パイプ）ので、**1 を直せば、4 か所とも自動で同じ設定を見る**【bash の仕様からの推測。コードは env を差し替えていない】。引数での受け渡しは不要。ただし、`target`（配布物の場所）は `$HOME/.touryou/current` 固定のままで、別の配布物を使う運用は対象外。
3. テスト: `packages/mcp/test/secret-acl.test.ts` が `resolveDaemonEndpoint` を使う。受け入れ基準の「引数が環境変数より優先」のテストを足す。
4. docs: `docs/config.md` の環境変数の表は、`TOURYOU_DAEMON_CONFIG` の使う側が「`touryou`」だけ（MCP・hook・ui も足す）。`docs/cli.md`・`docs/ui.md` も確かめる。
5. 【推測・要確認】Claude Code が、`.claude/settings.local.json` の `env` を、plugin の stdio MCP サーバーの環境に渡すか。Issue は「MCP だけ効かない」と書くが、原因は `stdio.ts` が env を読まないこと（コードで確認済み）。一方、env が MCP の子に届くかは、動かして確かめていない。届かない場合は、`.mcp.json` の `env`（`"TOURYOU_DAEMON_CONFIG": "${TOURYOU_DAEMON_CONFIG}"` のような展開）が要る可能性がある。**これは Claude Code 側の挙動で、動かして確かめるまで、直す箇所に確定できない**。

### 1-3. whoami に「どの daemon か」を出す【事実から導く】

- いまの `whoami`: MCP の `whoamiTool`（`packages/mcp/src/server.ts` 143 行〜）が `relay.whoami()`（`relay.ts` 287 行〜、`GET /v1/whoami`）を呼び、`{ role, nodeId? }` を返す。型は `relay.ts` 27 行 `whoami(): Promise<Result<{ role: string; nodeId?: string }>>`。
- daemon 側は `packages/daemon/src/api/server.ts` `handleWhoami`（931 行〜）。
- 出す案（設計上は、データの源に近い daemon が答えるのが正しい。MCP が自分の設定のパスを足すだけだと、「MCP が見ている設定」しか分からず、実際に答えた daemon を証明しない）:
  - A. daemon の `/v1/whoami` に `daemon: { rootCwd, repoRoot, rootNodeId, daemonId }` を足す（中身は `config` にあり、`compose.ts` から渡せる）。MCP の `relay.ts` の型・`server.ts` の `whoamiTool` の戻り・`tools.ts` の説明文・`ui` を足す。パス（`rootCwd`・`repoRoot`）は秘密ではないが、**子にも見える `whoami` に、親のパスを出してよいか**は決める（子の `whoami` には出さず、統合ノードだけに出す選択もある）。
  - B. MCP 側だけで、読んだ設定のパスを `whoami` の戻りに足す（daemon 無変更）。安いが、証明力は弱い。
- 推奨は A（統合ノードだけに `rootCwd`・`repoRoot`。`daemonId` は `docs/daemon-identity.md` の既存の識別子を使う）。

## 2. #161 案 B（root ごとに daemon を分ける）が、いまの実装で成立するか

### 2-1. 成立する部分【事実】

- daemon 本体は、`--config <絶対パス>` で、任意の設定で起動できる（`packages/daemon/src/main.ts`）。複数の daemon を並べる前提の検査がある: `config.ts` 314〜318 行は、1 つの設定の中で `stateDir`・`repoRoot`・`worktreeRoot` の重なりを拒む。**別の設定どうしの重なりは検査しない**（設計上、同じ stateDir で 2 つの daemon を動かさないと `port-file.ts` 13 行に書いてあるだけ。強制する仕組みは読んでいない）。
- port: 設定の `port` が 0 なら、保存した前回のポート → 空いているポート（`port-file.ts`）。**stateDir が別なら、保存先も別**なので、2 つ目は別のポートになる（Issue の実測とも合う）。
- CLI・hook・ui は `TOURYOU_DAEMON_CONFIG` で、別の daemon に向く（1-1）。
- daemon の身元確認（`daemon-identity`）は stateDir ごと。別の daemon へトークンを誤送しない仕組みは、複数インスタンスでも働く【推測。コードは stateDir 単位だが、2 つ動かしては確かめていない】。

### 2-2. 成立しない（または手作業になる）部分【事実】

| 部品 | 問題 |
|:--|:--|
| `touryou launchd init`・`apply`・`status`・`uninstall`（`launchd.ts` 346〜、`launchd-service.ts` 657〜） | 設定は `$HOME/.touryou/config.json`、`base` は `$HOME/.touryou` 固定。`--org` は plist の **Label だけ**を変える（`labelOf`、112 行）。ProgramArguments は `join(base, "config.json")` 固定（`daemonProgramArguments`、172 行）。ログも `<base>/logs/daemon.log` で共有。つまり `--org com.example` を付けても、**同じ設定の daemon の 2 つ目の plist ができるだけ**で、別の設定の daemon にはならない。別の設定を常駐させるには、plist を手で書く必要がある（Issue の launchd ラベル `touryou.renga-daemon` は、利用者が手で作ったものと読める【推測】） |
| `touryou launchd` が `configProblem` で検査する対象 | `$HOME/.touryou/config.json` 固定（68〜71 行） |
| `install-runtime.sh`（`/setup`、版上げ） | 設定の検査は `${BASE}/config.json`（417 行）。常駐の起動し直しは `*.touryou.daemon.plist` の名前に合うものだけ（343 行）。**別名の常駐は、版上げで起動し直されない**。古い版のまま残る【事実。plist の名前の判定は読んだ。実際に起きるかは動かしていない】 |
| `/touryou:setup`（`plugin/commands/setup.md` 56 行） | `config.json` がすでにあれば何もしない。2 つ目の設定を作る道がない（`$HOME/.touryou/state` を前提に書く） |
| `/touryou:service`・`start`・`status` | 文面が `$HOME/.touryou/...` 固定。2 つ目の daemon の status・stop・uninstall は対象外 |
| `/touryou:ui` | `touryou ui` は引数なしの 1 回だけ実行と決めている（`ui.md`）。`TOURYOU_DAEMON_CONFIG` が env に入っていれば別の daemon を開く（コードは対応）が、skill の文面は、複数インスタンスを想定していない |
| MCP | #162 のとおり |
| 配布物 | 2 つの daemon は同じ `$HOME/.touryou/current` の bin を使う。版上げは両方に効くが、再起動は上記のとおり 1 つ目だけ |

結論: 案 B は、**daemon・CLI・hook・ui が `TOURYOU_DAEMON_CONFIG` で別の daemon に向くところまでは、いまの実装で成立する**。MCP（#162）、launchd 系、`/setup`・`/service` の skill、版上げ（`install-runtime.sh`）が、複数インスタンスを前提にしていない。docs 化だけでは、受け入れ基準を満たさない（MCP が別の daemon に向かない）。

### 2-3. 権限境界【事実】

- root ごとに別の daemon・stateDir・トークン・`rootScope` になるので、`rootScope`・トークン・DB・worktree の境界は、**OS のプロセスとファイル権限（0700/0600）で分かれる**。受け入れ基準の「別の root の木・受信箱・トークンに触れない」は、設計上、案 A より B のほうが堅い。
- ただし、同じユーザー（同じ Mac）で動くので、**OS の権限では、別の daemon の stateDir を読める**（root-token は 0600・自分のもの）。「セッションが別の root のトークンに触れない」は、`TOURYOU_DAEMON_CONFIG` を渡さない限り別の stateDir を読まない、という利用者側の運用に依る。Claude Code の許可の設定で、別の stateDir の Read を拒否する運用が要る【推測】。

## 3. #161 案 A（1 つの daemon に複数 root）の影響範囲

読んだ範囲（網羅ではない）。

- core のイベント・投影: `events.ts` の不変条件に、**根は 1 つの前提**がある【事実の一部のみ。1274〜1282 行の `rootNotIntegrator` の周辺を読んだ。「木が 1 つ」の厳密な検査の有無は、全部は読んでいない】。`node.purged` の payload には `rootId` があり（313・1911 行）、複数の根を表す余地はある。投影（`tree.ts`・`ui-view.ts`）が、根が複数の木を扱えるかは、読んでいない【推測】。
- daemon の compose（`compose.ts` 2263 行）: `config.rootNodeId`・`config.rootCwd`・`config.rootScope` を、起動時に 1 つだけ使う箇所が多数（595〜629・713・801・1688・1789・1871 行など）。root ごとに引く形への変更になる。`config.repoRoot`・`worktreeRoot`・git の ports（`git-ports.ts`）は、1 リポジトリ前提。
- stateDir: `state.db`・`root-token`・`human-token`・`daemon-identity`・`port`・children の置き場が 1 組。root ごとに分けるなら、トークンを root ごとに持ち、**人間のトークンで全 root を操作できる**のか、root ごとにするのかを、先に決める。
- rootScope: 設定ファイルの 1 組。root の登録・一覧・削除の CLI と、設定の保存先（いまの設定は起動時に 1 回読むだけで、動的に変えない。`docs/config.md`）が新設。
- 画面（`daemon/src/ui`・`core/src/ui-view.ts`）: root の切り替え、**root をまたいで見えない**ことの保証。
- 接続先の決め方: セッションの cwd から root を決める仕組み（新設）。MCP・hook・ui・CLI の全部に入る。
- 版上げ・launchd・skill: 1 つの daemon なので、現状の構成のまま使える（案 B より、運用の変更は少ない）。

つまり、**A は、イベントソース・投影・権限・トークン・画面の全層に、複数 root の概念を入れる大きな設計変更**。しかも、`rootScope`・トークンの境界を、プロセスの境界ではなく、アプリの中の論理的な境界で守る必要がある（漏れたときの影響が、B より大きい）。

## 4. 結論

| | 利点 | 欠点 | 難易度 | 有効度 |
|:--|:--|:--|:--:|:--:|
| A. 1 daemon・複数 root | 利用者は 1 つの daemon・1 つの常駐だけ。版上げ・launchd・skill は現状のまま | core・daemon・画面・トークンの全層の変更。root 間の隔離をアプリの中で守る（漏れの影響が大きい）。単一 root の互換の維持が難しい | ★★★★★ | ★★★★☆ |
| B. root ごとに daemon（推奨） | プロセス・stateDir・トークンで、root が OS の境界で分かれる。core・daemon 本体はほぼ無変更。単一 root の利用者は無変更 | 常駐の複数化（launchd・`/service`・版上げ・`/setup`）の整備が要る。同一ユーザーなので、別の stateDir は OS では防げない（運用の注意）。2 つ以上で、メモリ・ポートが増える | ★★★☆☆ | ★★★★☆ |

- 推奨: **B**。理由: 受け入れ基準の「別の root の木・受信箱・トークンに触れない」を、プロセス・ファイルの境界で満たせる。A は、要る変更が全層で、境界もアプリの中になる。設計原則（責務の分離・権限境界）から、B が正しい。実装量は理由にしていない。
- **#162 は、B の前提として先に直すべき**。MCP が別の daemon に向かないと、B の成立条件（受け入れ基準 3 つ）が満たせない。また #162 の修正は、A・B のどちらにも害がない（接続先の決め方を、CLI・hook・ui と揃えるだけ）。

### 0.1.6 に入れる最小の形

1. #162 の本体（`stdio.ts` の優先順位 + テスト + docs の環境変数の表）。環境変数が空なら今までどおりで、単一 root の利用者に影響がない。
2. `whoami` に、統合ノードだけに `rootCwd`・`repoRoot`（と daemonId）を足す（1-3 の A）。取り違えの検知になる。#162 の受け入れ基準 5 に当たる。
3. docs: 複数 daemon の運用手順（設定・plist の手作業の作り方・環境変数の渡し方・**できないこと**: `launchd` サブコマンド・`/service`・版上げの起動し直しは 1 つ目だけ対象）を、`docs/launchd.md` か新しい文書に書く。
4. `launchd`・`/setup`・`/service`・版上げの複数対応は、0.1.6 に入れず、別の Issue に分ける。

### Issue の分け方（案）

- #162（そのまま）: 「plugin の MCP（touryou-mcp）が TOURYOU_DAEMON_CONFIG を読まない」。範囲を 1・2・3（docs は手作業の手順）に限る。
- 新: 「whoami で、どの daemon（rootCwd・repoRoot・daemonId）につながったかを確認できるようにする」（#162 から分けてもよい）。
- 新: 「複数の daemon の常駐に対応する（`touryou launchd` が設定の場所を引数で受け取る・ラベルとログ・stateDir の分離・版上げで全部を起動し直す・`/setup`・`/service` が複数インスタンスを扱う）」。#161 の案 B の本体。
- #161: 案 B を採るなら、上の 2 つと、`/ui`・`/status` の複数選択（`touryou ui` が、複数の daemon から選べる）を子の Issue として束ね、案 A は、将来の別の検討として閉じる（またはコメントで残す）。

## 5. 事実と推測の区別（まとめ）

- 【事実】: 1-1 の表、2-2 の表、`config.ts` の重なりの検査、`labelOf`・`daemonProgramArguments` が `--org` と別に config を固定していること、`install-runtime.sh` の plist の名前の判定、`handleWhoami`・`whoamiTool` の場所。
- 【推測・未確認】:
  - Claude Code が、settings の `env` を stdio MCP の子に渡すか（1-2 の 5）。
  - 2 つの daemon を実際に並べたときの、身元確認・ポート・ログの干渉。
  - 配布物 v0.1.5 の `dist` が、ソースと同じか（読んでいない）。
  - core の投影・画面が、複数の根を扱えるか（3）。
  - Claude Code の許可の設定で、別の stateDir の Read を拒否できるか（2-3）。
