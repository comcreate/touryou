# #288 リポジトリ単位の置き場（`<repoRoot>/.touryou/`）と、常駐の 1 項目化 — 設計の下書き

> 状態: **下書き**。壁打ち（決定 1〜13）は #288 に記録済み。決まっていないことは「未決」として並べ、決めていない。
> 調べ方: コードを `git grep` で確かめた（行番号つき）。確かめていないものは「未確認」と書く。コード・テストは変えていない・動かしていない。
> 置き換えるもの: `.sdd/task/218/design.md` の「`worktreeRoot` は拒否のまま」（87・108 行）。#218 の `stateDir` の扱い（`repoRoot ⊃ stateDir` を ignore 済みのときだけ許す）は、そのまま残す。
> ファイル名は AI-SDD v5.1 の `design-draft.md`（#218 の `design.md` は旧形）。

## 1. 背景と目的

- 0.1.7-rc.0 の実機確認で、`worktreeRoot` が `repoRoot` の兄弟だと、子の起動（`claude --bg`）が **Workspace not trusted** で失敗した（仮説: 信頼は親フォルダから引き継がれるので、内側なら要らない。**未測定**）。
- #218 は `stateDir` だけを緩め、`worktreeRoot` を別 issue に回したが、その issue が作られなかった（#288 で追跡）。
- 壁打ちで、目的が広がった: リポジトリ固有の設定・状態・作業ツリー・ログを `<repoRoot>/.touryou/` にまとめ、既定の daemon（ホームの設定）をなくし、ログイン項目が増えない形にする。

## 2. 現状【事実】

| 項目 | 場所 | 内容 |
|:--|:--|:--|
| 設定の探し方（MCP） | `packages/mcp/src/stdio.ts:202-203` | `--config` → `TOURYOU_DAEMON_CONFIG` → `$HOME/.touryou/config.json` |
| 設定の探し方（hook） | `packages/cli/src/hook.ts:215-219` | `TOURYOU_DAEMON_CONFIG` → `$HOME/.touryou/config.json` |
| 設定の探し方（CLI） | `packages/cli/src/bin.ts:133-134` | 同上 |
| 設定の探し方（ui） | `packages/cli/src/ui.ts:195` | `--config` ＞ `TOURYOU_DAEMON_CONFIG` ＞ cwd が `repoRoot`・`worktreeRoot` の中にある候補（いちばん深い） ＞ 既定の設定 |
| 設定の探し方（launchd） | `packages/cli/src/launchd.ts:127` | `--config` なしは `$HOME/.touryou/config.json` |
| 常駐の判定（導入 script） | `plugin/scripts/install-runtime.sh:62` | `$HOME/.touryou/config.json` の有無で `CONFIG: present/absent` |
| plist・ログの置き場 | `packages/cli/src/launchd.ts:143`、`launchd-service.ts:818-819` | plist は `<HOME>/.touryou/launchd`、ログは `<HOME>/.touryou/logs`、置き先は `~/Library/LaunchAgents` |
| Label | `packages/cli/src/launchd.ts:128`、`launchd-plists.ts:20` | 既定は `touryou.daemon`、`--config` のときは `touryou.daemon-<8 文字>` |
| 重なりの検査（構文） | `packages/daemon/src/config.ts:399` 付近 | `overlaps(worktreeRoot, repoRoot)` を拒否（`stateDir ⊂ repoRoot` だけ許す） |
| 重なりの検査（実パス） | `packages/daemon/src/compose.ts:355`（`realOverlap`）・`465` | 同じ検査をリンク解決後の実パスで行う |
| 子から守る場所 | `packages/daemon/src/compose.ts:493-500`（`protectedRoots`）、`181`（`forbiddenRoots`） | `stateDir` と daemon の設定ファイルを保護。`forbiddenRoots` に `repoRoot`・`worktreeRoot`・`stateDir`・`$HOME/.touryou` |
| /setup の置き場 | `plugin/commands/setup.md:56`・`68` | `config.json` は `$HOME/.touryou/config.json`、`stateDir` は `$HOME/.touryou/state` 固定。`worktreeRoot` は推奨なしで尋ねる |
| 複数 daemon の候補 | `packages/cli/src/launchd.ts:409` のコメント | `ui` は、LaunchAgents と元の plist から候補を作る（`ui.ts` 本体の候補の作り方は **未確認**） |

実測済み（R4。git 2.50.1）: ignore 済みの入れ子の worktree は、`worktree add`・`status`・`add -A`・子での commit・`worktree remove` がすべて期待どおり。ignore がないと `add -A` が壊れた埋め込みリポジトリを載せる。

## 3. 決まったこと（決定 1〜17）

| # | 決定 | 設計への落とし方 |
|:--|:--|:--|
| 1 | 実測を先に | R4 は済み。信頼の実測は未（7 章） |
| 2 | 起動時に「ignore 済み」を確かめ、なければ拒否 | `worktreeRoot` にも、`stateDir`（#220）と同じ検査を適用。自己 ignore は置かない |
| 3 | 設定・state・作業ツリーは `<repoRoot>/.touryou/` | 4-1 の配置 |
| 4 | 既定の daemon をなくし、全部リポジトリ単位 | 4-2 の探し方、4-5 の移行 |
| 5 | v0.1.7 に入れ、`0.1.7-rc.1` から実機確認をやり直す | 8 章 |
| 6 | cwd から上へ `<dir>/.touryou/config.json` を探す。順は `--config` → `TOURYOU_DAEMON_CONFIG` → cwd。全入口で同じ小さな関数を共有 | 4-2 |
| 7 | 見つからないときは、理由と直し方を出して止まる。旧パスへは黙って戻らない | 4-2 |
| 8 | ログ・plist は `<repoRoot>/.touryou/logs`・`launchd`。Label は全部 `touryou.daemon-<8 文字>` | 決定 14 で維持。決定 11 との衝突は 5-1 |
| 9 | 子には、自分の作業ツリー以外の `<repoRoot>/.touryou/` をすべて拒否（既定拒否） | 4-3 |
| 10 | 移行は「コピー → 検査 → 切り替え」。失敗したら元のまま | 4-5 |
| 11 | launchd の項目は 1 つ（supervisor）。中でリポジトリごとの daemon を起動 | 4-4 |
| 12 | 登録簿は `~/.touryou/` に、設定ファイルの絶対パスの一覧だけ | 4-4 |
| 13 | supervisor が落ちても daemon は残す。起動し直した supervisor が引き継ぐ | 4-4 |
| 14 | Label・plist・ログの置き場は**リポジトリ単位**（決定 8 を維持） | **決定 11 との衝突が残る**（5-1） |
| 15 | 登録されたパスが消えたときは、実態（ディスクの状態）を正とする | 5-2 |
| 16 | 二重起動はしない。引き継ぎは**後勝ち**（読み: 後から起動したほうが残る）【読みは要確認】 | 5-3 |
| 17 | `/touryou:service` の対象は、実行したセッションのリポジトリ（cwd から探した設定）を基本に、引数で指定もできる | 5-4 |

実測で裏づいたこと: daemon が 2 つの状態で、ログイン項目に TouRyou が **2 項目**出る（決定 11 の前提）。

## 4. 設計

### 4-1. `<repoRoot>/.touryou/` の配置

```
<repoRoot>/.touryou/
  config.json      daemon の設定（リポジトリ 1 つぶん）
  state/           SQLite・トークン・ポート・children.key（0700）
  worktrees/       子の作業ツリー（worktreeRoot の推奨値）
  logs/            daemon のログ（未決 5-1）
```

- `.touryou/` 全体を `.gitignore` に入れる（`/touryou:setup` が追記を案内する）。
- 検査の緩和（config.ts・compose.ts）: `worktreeRoot` も、`repoRoot` の内側かつ ignore 済み・未追跡のときだけ許す（`state-dir-ignore.ts` の `checkStateDirIgnored` を、`worktreeRoot` にも使えるようにする）。`stateDir`⇔`worktreeRoot` の重なり、`repoRoot` を囲む向きは、今のまま拒否。`--check-config` も同じ検査を通す。
- 回収・削除（`worktree remove`）が内側の置き場で動くことを、テストで確かめる（R4 は git の実測のみ。touryou 側の `reclaim.ts` は **未確認**）。

### 4-2. 設定の探し方（共有関数）

- 1 つの小さな関数を、mcp・hook・CLI・launchd・ui で共有する。順は `--config` → `TOURYOU_DAEMON_CONFIG` → cwd から上へ `<dir>/.touryou/config.json`。
- 子の cwd（`<repoRoot>/.touryou/worktrees/<子>`）からも届く。兄弟の置き場の作業ツリーは届かないので、親が環境変数で渡す。
- 見つからないとき: 理由と直し方（`/touryou:setup` を実行する、または `--config` を指定する）を出して止まる。旧パスへ戻らない。hook は、touryou を使っていないフォルダでは何もしない（守りを外さない範囲で）。
- 置き場所: 共有の小さな関数をどのパッケージに置くか（`@touryou/core` か）は **未決（5-6）**。
- `ui` の「いちばん深い root」の選び方（`ui.ts:195`）は、内側の `worktreeRoot` でも正しいか、テストで確かめる。

### 4-3. 子からの保護（決定 9）

- `protectedRoots`（`compose.ts:493-500`）を、「`<repoRoot>/.touryou/` 全体。ただし、その子自身の作業ツリーを除く」に変える（既定拒否・読みも書きも）。
- 対象は、`state`・`config.json`・`logs`・`launchd`・ほかの子の作業ツリー。今後 `.touryou/` に足したものも、自動で守られる形にする。
- 注意（要検討）: 子の作業ツリー自体が `.touryou/worktrees/<子>` の中にあるので、「その子自身の作業ツリー」を、実パスで厳密に除く必要がある。リンク経由で他の子へ届かないことを、テストで確かめる。

### 4-4. 常駐の 1 項目化（supervisor・登録簿）

- 動機: ログイン項目がリポジトリごとに増える（実測 2 項目）。root のセッションが全部消えても daemon が残ること。
- 形: launchd に登録するのは supervisor 1 つだけ。supervisor が、登録簿にある設定ファイルごとに daemon（別プロセス）を起動・監視する。root・stateDir・トークン・rootScope の分離は、OS のプロセス単位のまま（#161 の案B の利点）。
- 登録簿（決定 12）: `~/.touryou/` に、設定ファイルの絶対パスの一覧だけ。追加・削除は `/touryou:setup` と `/touryou:service` が行う。壊れても、各リポジトリの状態は無傷で、再登録で戻せる。
- 引き継ぎ（決定 13）: supervisor が落ちても daemon は止めない。launchd が supervisor を起動し直し、supervisor は、動いている daemon を検出して、足りないものだけを起動する。検出の方法は **未決（5-3）**。
- root のタブを閉じても、`claude --resume` で戻せる（root の身元は `root-token` と `rootNodeId`。`stdio.ts:344`）。ただし `--resume` でセッション ID が変わるかは **未測定**（`docs/manual-verification-checklist.md` の A4-1）。

### 4-5. 移行（決定 10）

- 対象: 既存の `~/.touryou/config.json`・`state`・常駐（`touryou.daemon`）→ `<repoRoot>/.touryou/`。
- 手順: 同意を取る → 新しい置き場へコピー → 検査（daemon と同じ設定の検査・stateDir の中身が読める） → 切り替え（常駐の付け替え） → 元は消さずに残す。失敗したら、元のまま動く状態に戻る。
- 実行するのは `/touryou:setup`。承認の回数（定型文の「約 3 回」）が増えるので、文面を直す。
- 詳細（複数リポジトリがある場合・やり直し）は **未決（5-5）**。

## 5. 未決（選択肢と、私の推奨）

### 5-1. Label・plist・ログの置き場（決定 14 と決定 11 の衝突）【最優先・未解消】

決定 14 は「リポジトリ単位」（私の推奨 A〔supervisor はホーム側〕は採られなかった）。一方、決定 11 は launchd の項目が supervisor の 1 つだけ。**両立の形が未確定**:

| 読み | 内容 | 帰結 |
|:--|:--|:--|
| ① daemon のログ・状態だけリポジトリ単位 | supervisor の plist は 1 つで、置き場は `~/.touryou/`（A と同じ） | 決定 11 は保てる。plist がリポジトリ単位でない点は、決定 14 の「plist」の文言と合わない |
| ② plist もリポジトリ単位 | リポジトリごとに plist（`touryou.daemon-<8 文字>`）。supervisor を置かない | 決定 11 を取り下げることになる（ログイン項目が増える。実測で 2 項目） |
| ③ supervisor の plist を、ある 1 つのリポジトリに置く | どのリポジトリか決まらない | 非推奨 |

どれを意図したかを、次に確かめる。確かめるまで、4-4 の supervisor の置き場は未確定のまま。

### 5-2. 登録されたパスが消えたとき・登録簿が壊れたとき（決定 15）
- 決定: 実態を正とする。起動時に、パスの存在と `config.json` の検査を行い、通らないものは起動せず、`/touryou:service status` に理由つきで出す（登録簿を正として、消えたパスを作り直したり、状態を復元したりしない）。
- 残り（未決）: 消えたパスを登録簿から**自動で外すか、人が外すか**。誤って消えるのを避けるため、人が外すのを推奨。登録簿そのものが壊れたときは、全体を「壊れ」として止め、再登録の手順を出す。

### 5-3. 引き継ぎの検出（二重起動の防止）（決定 16）
- 決定: 二重起動はしない。引き継ぎは後勝ち。
- 読み（要確認）: 同じ設定の daemon が 2 つ起きたときは、**後から起動したほうが残り、先のものは止まる**。これだと、先の daemon が子と話している最中に切られる危険がある。「先に動いているものがあれば、後から来たほうが起動しない」（先勝ち）なら安全だが、決定は「後勝ち」と読めるので、**意図を確かめる**。
- 検出の手段（推奨は変えない）: 各 daemon が `stateDir` に pidfile／ロックを持ち（今の `storeLocked`〔単一の書き手〕と整合）、窓口の応答（未認証の whoami が 401）で「動いている」と判定する。

### 5-4. `/touryou:service` の対象の選び方（決定 17）
- 決定: 実行したセッションのリポジトリ（cwd から探した設定）を基本に、引数で指定できる。
- 細部（実装時に決める）: 引数は `--config <設定>`（今と同じ）に加え、全部を対象にする `--all`。一覧は登録簿から出す（今は plist から出している）。

### 5-5. 移行の細部
- 複数リポジトリがある場合、どれを移すか（`/touryou:setup` を実行したリポジトリ 1 つだけ移し、残りは、そのリポジトリで `/touryou:setup` を実行したときに移す、が安全）。
- 失敗のやり直し、移行中に子が動いているとき（子の道具が一時的に届かないので、動いている子がいれば止めて待つ）。

### 5-6. 共有関数の置き場
- `@touryou/core` に置く案が自然（mcp・cli・daemon が共有）。`packages/core` が、ファイル I/O を持ってよいか（`@touryou/core/fs` が既にある）を、実装前に確かめる（**未確認**）。

### 5-7. `rootCwd`・`rootScope` の既定、`config.json` の保護
- `<repoRoot>/.touryou/config.json` は、子から保護する（4-3 の既定拒否に含まれる）。`rootScope` の既定は、/setup が書く最小の形のまま（`writableLocations: ["src"]`・`forbiddenLocations: [".git"]`）。`.touryou` を `forbiddenLocations` に足すか（二重の守り）は、4-3 の実装後に判断する。

## 6. 変更が及ぶファイル（`git grep -E '\.touryou/config\.json|\.touryou/state'` を起点に、1 つずつ判断する）

- 検査: `packages/daemon/src/config.ts`・`compose.ts`・`state-dir-ignore.ts`・`main.ts`
- 探し方（共有関数に置き換え）: `packages/mcp/src/stdio.ts`・`child-bind.ts`、`packages/cli/src/{bin,hook,ui,launchd,launchd-service,launchd-plists}.ts`、`plugin/scripts/install-runtime.sh`
- supervisor・登録簿: 新規（`packages/cli` か新パッケージかは未決。配布物の構成〔`dist`・`.mcpb`〕への影響を要確認）
- plugin: `plugin/commands/{setup,start,status,service,ui}.md`
- docs: `docs/{config,launchd,plugin,cli,ui,desktop-extension,daemon-identity,dist-manual-verification,setup-verification}.md`、`.sdd/adr/touryou.md`、`README`、`CHANGELOG.md`
- テスト: 検査の緩和・探し方・移行・supervisor・保護・回収
- Desktop の拡張機能（`.mcpb`）の設定の探し方（**未確認**。別途調べる）

## 7. 実測が要る項目（実装の前後で）

1. Workspace 信頼: 内側と兄弟の作業ツリーで、信頼の確認が要るか（`~/touryou-trust-test` で利用者が測定中。結果待ち）。
2. `--resume` でセッション ID が変わるか（A4-1）。
3. supervisor 1 項目のときの、ログイン項目の見え方・メモリ。
4. supervisor 配下で、リポジトリを足す・外す・daemon が落ちる各場面。

## 8. 実装の分け方（案）

1. **PR 1（検査）**: `worktreeRoot` の内側を、ignore 済みのときだけ許す。保護（4-3）。テスト。
2. **PR 2（探し方）**: 共有関数を作り、全入口を置き換える。既定の設定への黙った戻りをなくす。
3. **PR 3（supervisor・登録簿）**: supervisor・登録簿・Label・`/touryou:service`。
4. **PR 4（移行・推奨・docs）**: `/touryou:setup` の移行と推奨、`docs`・`CHANGELOG`。
5. `0.1.7-rc.1` を作り、`docs/setup-verification.md` の A'・B を、新しい置き場に合わせて直し、手順 0 からやり直す。

PR 1〜3 は互いに依存するので、順番に入れる（探し方の置き換えが先でないと、supervisor が設定を見つけられない）。

## 9. この下書きでやっていないこと

- コード・テストの変更、lint・typecheck・テストの実行（**未実行**）。
- 7 章の実測、`reclaim.ts` と Desktop の拡張機能の確認。
