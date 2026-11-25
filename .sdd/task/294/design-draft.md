# #294 作業ツリーに写すファイルの一覧を、Claude Code と同じ `.worktreeinclude` にする — 設計の下書き

> 状態: **下書き**。利用者の決定は 2 つ: (1) `.worktreeinclude` に一本化する（JSON が残っていたら、移行の手順を出して、作業ツリーを作らずに止める。黙って無視しない）。(2) v0.1.7 に入れる（PR は小さく分ける）。それ以外は「未決」として並べ、決めていない。
> 調べ方: コードを `git grep` と読み取りで確かめた（行番号つき）。**【事実】**＝この作業ツリーのコードで確かめたもの。**【知識】**＝git のドキュメントの記憶に基づくもの（手元で git を動かしていない）。**【未確認】**＝実測が要る。コード・テストは変えていない・動かしていない。
> 公式（Claude Code の `.worktreeinclude`）の記述は、ブリーフにある要約（「リポジトリのルート・gitignore と同じ構文・パターンに一致し、かつ gitignore 済みのファイルだけコピーする」）を引いた。**公式のページの本文は、取得していない**（【未確認】）。
> 置き換えるもの: `.sdd/task/250/design.md` の「既存の `touryou-worktree-files.json` で足りる」（5・12・52 行）。
> ファイル名は AI-SDD v5.1 の `design-draft.md`。

## 1. 背景と目的

- #250 で、gitignore の対象で、チェックアウトでは来ないファイル（`.envrc`・ダウンロードしたバイナリなど）を、`<repoRoot>/.claude/touryou-worktree-files.json` の `files`（50 件まで・完全なパスの一覧）に書くと、daemon が作業ツリーを作るときにコピーする形にした。
- Claude Code には、同じ目的の `.worktreeinclude` がある。ただし、Claude Code 自身が作る作業ツリーにだけ効き、**daemon が `git worktree add` で作る子の作業ツリーには効かない**。利用者は、同じ意図を 2 つの形式で書くことになる。
- 目的: 一覧の形式を `.worktreeinclude`（gitignore の構文）に一本化し、利用者が 1 つのファイルで両方に効かせられるようにする。daemon 側の実装は、daemon に持つ。

## 2. (a) 現状【事実】

| 項目 | 場所 | 内容 |
|:--|:--|:--|
| 一覧の置き場 | `packages/daemon/src/worktree-seed.ts:23` | `SEED_LIST_FILE = join(".claude", "touryou-worktree-files.json")`。`{ "files": [...] }` |
| 件数の上限 | `worktree-seed.ts:24`・`68` | `SEED_MAX_FILES = 50`。超えると `seedListInvalid` |
| 一覧の検査 | `worktree-seed.ts:41-82`（`readSeedList`） | ファイルがなければ空。JSON でない・`files` が配列でない・空でない文字列でない・絶対パス・`..`・`.`・`.git` の中・重複は、すべて `seedListInvalid` |
| 元のファイルの検査 | `worktree-seed.ts:85-114`（`planSeed`） | `lstat`＋`realpath`。ない→`missing` に記録して続ける。`repoRoot` の外（リンク経由）→`seedOutsideRepo`。通常のファイルでない→`seedNotFile`（どちらも失敗） |
| コピー | `worktree-seed.ts:117-148`（`copySeed`）・`141` | 作業ツリー側にすでにある→スキップ。作業ツリーの外に出る→スキップ。失敗→スキップ。`COPYFILE_FICLONE` で、権限も写る |
| 呼び出し（作る前の検査） | `packages/daemon/src/git-ports.ts:1006-1010` | `git worktree add` の**前**に `readSeedList`→`planSeed`。失敗なら、作業ツリーを作らずに返す |
| 呼び出し（コピー） | `git-ports.ts:1056-1063` | 印のファイルを置いた**後**に `copySeed`。`copy` か `missing` があれば `onSeed` で通知（標準エラーに `worktreeSeeded`。`git-ports.ts:133-136`・`326-331`） |
| コピー元 | `git-ports.ts:1057` | 常に `repoRoot`（子の子でも、親の作業ツリーではなく `repoRoot` から写す） |
| 回収の判定での扱い | `git-ports.ts:332-336`（`seededPaths`）・`475-487`（`isClean`）・`533-547`（`lossOf`） | 一覧を**判定のたびに**読み直し、`!!`・`??` の行のパスが一覧にあれば、未保存・未追跡に数えない。一覧を読めなければ空（＝数える。安全側） |
| 丸ごと ignore のディレクトリの開き方 | `git-ports.ts:446-472`（`statusLines`） | `--ignored=matching` が `!! dir/` にまとめた行のうち、一覧のファイルを含むものだけ、`--ignored=traditional` で開く |
| 一覧にない ignore の扱い | `git-ports.ts:483`・`543`、`packages/daemon/src/config.ts:100-101` | 再生成できるもの（既定 `node_modules`・`dist`・`.turbo`）以外は、回収を拒否する |
| git の実行の限界 | `git-ports.ts:90-92` | 1 回 60 秒・出力 16 MiB で、超えると `code: null`（失敗）。環境変数の `GIT_*` は外し、システムの設定は読まない（`gitEnv`。`54-58`）。グローバルの設定・`.git/info/exclude` は効く（【知識】） |
| 「gitignore を自前で解釈しない」の先例 | `packages/daemon/src/state-dir-ignore.ts:5-6`・`89`・`97` | 判定は git（`ls-files`・`check-ignore`）に任せる。使えない・失敗したら拒否（安全側） |
| 依存 | `package.json`・`packages/{core,daemon,cli,mcp}/package.json` | `picomatch`・`minimatch`・`micromatch`・`globby`・`ignore` は、**どれもない**（`git grep` で 0 件） |
| 子の書き込み範囲 | `packages/core/src/scope.ts:165-170`（`validateScope`）・`191-203`（`checkWrite`） | 書き込める場所は、子の `cwd`（子の作業ツリー）の内側だけ（`writableOutsideCwd`）。`repoRoot` は、子の `cwd` の外 |
| 子から守る場所 | `packages/daemon/src/compose.ts:498-509`（`protectedRoots`）、`packages/daemon/src/sdk/hook-policy.ts:94` | `protectedRoots` は `stateDir`・daemon の設定・`~/.touryou`。`repoRoot` は入っていない。`hook-policy.ts:94` の「書き込みだけを禁じる場所」は、Desktop の子の作業ツリーの `.claude/` |
| Bash の守りの限界 | `docs/plugin.md:307` | 「Bash は書かれたパスに見える語だけを見る歯止めで、確実ではない」 |
| 試験 | `packages/daemon/test/worktree-seed.test.ts:32-71`（準備）・`74-96`・`98-104`・`106-118`・`120-128`・`130-150`・`152-160`・`162-176`・`178-188` | 実際の git で、コピー・一覧なし・不正な一覧・外を指すリンク・丸ごと ignore のディレクトリ・元がない・コピー失敗・追跡済みは上書きしない |
| 文書 | `docs/plugin.md:277-299`・`docs/worktree-seed-files.md:1-16`・`CHANGELOG.md:25`（0.1.7 の節） | JSON の手順。`plugin/` の中には、`seed`・`worktree-files` の語はない（`git grep` で 0 件）ので、`/touryou:setup` は、この一覧に触れていない |
| 版 | `package.json:4`・`plugin/.claude-plugin/plugin.json:4`・`CHANGELOG.md:3-5` | 版は `0.1.7`。「未公開」の節は空で、**`0.1.7（2026-11-25）` の節がすでにある**（直近のコミット `[update] release: 0.1.7 の準備`）。タグ・Release の有無は【未確認】（`git tag` を許されていない） |

挙動の変化に関わる事実（2 点）:

- 今の JSON の一覧は、**gitignore の対象でないファイル**（未追跡・追跡済み）も指せる（`seededPaths` が `??` の行も数える: `git-ports.ts:482`・`538`。追跡済みは「上書きしない」でスキップ: 試験 `178-188`）。`.worktreeinclude` は「gitignore 済み」だけなので、この 2 つは、できなくなる。
- 今の一覧は完全なパス 1 件＝1 ファイル。`.worktreeinclude` の `foo` は、任意の深さの `foo` に一致しうる（gitignore の構文。【知識】）。

## 3. (b) パターンの照合の実装の選択肢

### 要件

`.worktreeinclude` のパターンに一致し、かつ gitignore 済み（`.gitignore`・`.git/info/exclude`・グローバルの除外）で、未追跡のファイルを、`repoRoot` の作業ツリーから列挙する。構文は gitignore と同じ（否定 `!`・`**`・末尾 `/`・先頭 `/` の固定）。

### 案 A: git だけで列挙と照合をする（推奨）

2 段にする（`cwd = repoRoot`、出力は `-z`）。

1. 候補: `git ls-files -z --others --ignored --exclude-from=.worktreeinclude`
   - 【知識】`--ignored`（`-i`）は、「除外パターンに一致する」ものだけを出す。`--others` と組むと、未追跡のうち、パターンに一致するものを出す。標準の除外規則は自動では効かないので、`--exclude*` が 1 つ以上要る（ドキュメントの記述）。したがって、これで「`.worktreeinclude` に一致する未追跡のファイル」が得られる。
   - パターンの解釈（否定・`**`・先頭の `/`・末尾の `/`・後勝ち）は、**git の `.gitignore` と同じ実装**になる。
2. gitignore 済みの確認: 候補を `git check-ignore -z --stdin` に渡し、出力に残ったものだけを使う。
   - 【知識】`check-ignore` は、除外パターンに一致するパスを出す（追跡済みのパスは、`--no-index` を付けない限り出さない）。ignore 済みのディレクトリの中のパスも、一致として出る見込み（【未確認】）。

長所: 依存を足さない。「`.worktreeinclude` の構文の解釈」と「ignore 済みの判定」を、git に任せられる（`state-dir-ignore.ts:5-6` の方針と同じ）。Claude Code の gitignore 構文との差が、最小になる（Claude Code が使うマッチャーが git と同じとは限らない点は、【未確認】）。
短所: 候補の列挙（`ls-files -o`）は、作業ツリー全体（`node_modules`・`target/` など）を歩く。大きなリポジトリでの時間は【未確認】。出力は 16 MiB・60 秒の枠（`git-ports.ts:90-92`）で切られ、切られたら失敗（安全側）になる。

### 案 B: `ignore` パッケージ（gitignore 構文の純 JS 実装）を足す

`ignore` で構文を解釈し、ファイルの列挙は自前（`fs` で歩く）か、`git ls-files -o -i --exclude-standard`（ignore 済みの全ファイル。`node_modules` を含み、非常に大きい）で行う。

長所: パターンの照合を、プロセスの外に出さずにできる。
短所: 依存が 1 つ増える（`pnpm-lock.yaml`・供給網の確認）。構文の解釈が git と二重になり、差が出うる（大文字小文字・`core.ignorecase`・否定の後勝ちなど）。ignore 済みかの判定は、結局 git に頼る。

### 案 C: `picomatch`・`minimatch` などの glob

否定・ディレクトリのみ・固定の意味が gitignore と違う。**不採用**（`.worktreeinclude` の意味が、Claude Code とずれる）。

### 推奨

**案 A**。理由: 依存が増えず、gitignore の意味を二重に持たないため。**ただし、実装 PR の最初に、次の実測を試験として置く**（10 章）: `ls-files -o -i --exclude-from` の意味・`check-ignore --stdin -z` の出力・大きなリポジトリでの時間・`**/` の規則。実測で案 A が成り立たなければ、案 B に切り替える（その場合も、列挙は `git ls-files`、ignore 済みの確認は `check-ignore` に残す）。

### 補足: `.worktreeinclude` 自体の読み込み（案 A・B 共通）

- `lstat` で通常のファイルか確かめ、リンク・通常でないものは失敗にする（`--exclude-from` に外のファイルを読ませない）。
- 大きさ（例: 64 KiB）・行数（例: 500 行）の上限を置く（5 章）。
- `repoRoot` の作業ツリーの現物を読む（ブランチの内容ではない）。

## 4. (c) 今の安全の制約を、パターンでどう保つか

| 今の制約（現状の根拠） | パターンでの保ち方 |
|:--|:--|
| `repoRoot` の外を指さない（`..`・絶対パス: `worktree-seed.ts:73-75`） | gitignore の構文では、先頭の `/` は「`repoRoot` に固定」の意味で、絶対パスにならず、`..` は一致する対象を作らない（【知識】）。列挙は `repoRoot` の作業ツリーの中のファイルだけを返すので、構文としては外を指せない。**ただし**、`..` を含む行は、混乱のもとなので、**読むときに失敗にする**（`seedListInvalid` に近い、新しい失敗の種類。現状の「`..` は失敗」を保つ）。絶対パス（先頭が `/` ）は gitignore では「固定」なので、失敗にはしない |
| リンク経由で外を指さない（`planSeed` の `realpath`: `worktree-seed.ts:92-107`） | **そのまま残す**。`ls-files` はリンクそのものを 1 件として出す（【知識】）。各候補に `planSeed` と同じ `lstat`＋`realpath`＋`isPathUnder` をかける。外を指すなら、現状どおり**失敗**（作業ツリーを作らずに止める。`seedOutsideRepo`） |
| `.git` の中を指さない（`worktree-seed.ts:76-77`） | `ls-files` は `.git` の中を出さない（【知識】。【未確認】）。念のため、候補の先頭が `.git/` のものを**捨てて失敗にする**（二重の守り）。入れ子のリポジトリ（未追跡の別の git のディレクトリ）の中身は、`ls-files -o` では `dir/` の 1 件に畳まれる（【知識】。【未確認】）ので、末尾が `/` の候補は、通常のファイルでないものとして扱う（下の行） |
| 通常のファイルだけ（`worktree-seed.ts:108`） | `planSeed` の `statSync(real).isFile()` を残す。パターンだと、ディレクトリ・特殊ファイルに当たりうるので、**扱いを決める（未決 4: 失敗／スキップして記録）**。推奨は、リンク経由で外を指すものは失敗（安全に関わる）、通常のファイルでないものは、スキップして `skipped` に記録（意図せず当たったものを、止めない） |
| 作業ツリー側にあるものは上書きしない（`copySeed`: `worktree-seed.ts:133-139`） | **そのまま残す**。「追跡済みのファイルが一覧にあった」場合は、`.worktreeinclude` では候補にならない（ignore 済み・未追跡だけ）が、`repoRoot` で ignore していて、親のブランチでは追跡しているファイルは、起こりうる（【知識】）。この場合のために、上書きしない検査を残す |
| 作る前に検査する（`git-ports.ts:1006-1010`） | 列挙・`planSeed`・上限の検査を、同じ場所（`git worktree add` の前）で行う。git が使えない・時間切れ・出力が枠を超えた→**失敗にして作業ツリーを作らない**（今の「一覧が読めない」と同じ安全側） |
| 件数の上限（`SEED_MAX_FILES`: `worktree-seed.ts:24`） | 5 章 |

追加で要る守り（パターンで新しく生じる）:

- `.worktreeinclude` 自体が、リンク・通常でない・大きすぎる→失敗。
- 展開した後の合計の件数・大きさの上限（5 章）。
- 一覧にあった `.worktreeinclude` 以外のところから、パターンが入らないこと: `--exclude-from` は 1 ファイルだけ渡す。`core.excludesFile`・`.git/info/exclude` は、「ignore 済みか」の側だけに効く（候補側には効かない）。

## 5. (d) 件数・大きさの上限

意図せず大量にコピーしうる例: `*`・`**`・`.*`・`*.log`・`bin/`（`bin/` の中身が数百ファイル）。

| 案 | 内容 | 難易度 | 有効度 |
|:--|:--|:--:|:--:|
| A. 展開後の件数だけ、今の 50 のまま | 簡単。ただし `bin/` のようなディレクトリ指定が、すぐ超える | ★☆☆☆☆ | ★★☆☆☆ |
| B. 件数（展開後）と、合計の大きさ、両方の上限（推奨） | 例: 200 件・合計 512 MiB（**数値は根拠のない仮置き**。実装の PR で、Renga の `bin/`・`.claude/` などの実測をして決める）。超えたら、**作業ツリーを作らずに失敗**。文面に、一致した件数・合計の大きさ・先頭の数件の名前・直し方（パターンを狭める）を出す | ★★☆☆☆ | ★★★★☆ |
| C. 上限なし（Claude Code と同じ可能性。公式は未確認） | 実装は最も簡単。大量のコピーを、利用者が気づかず始める | ★☆☆☆☆ | ★☆☆☆☆ |

付随する未決（5）: `config.ts:100-101` の再生成できるディレクトリ（`node_modules`・`dist`・`.turbo`）の**中**に、パターンが当たったとき（例: `**/*.env` が `node_modules` の中の何かに当たる）。選択肢: 当たりを黙って捨てて通知に記録する（推奨）／そのままコピー対象にして上限で止める／失敗にする。コピーすると、回収の「きれいか」の判定で、これらは「再生成できるもの」として数えない一方、写したものとしても数えない矛盾が生じるので、**黙って捨てる**のが、判定と整合する。

`.worktreeinclude` の大きさ・行数の上限は、3 章のとおり（64 KiB・500 行は仮置き）。

## 6. (e) 子が `.worktreeinclude` を書き換えられないこと

【事実】
- 子の書き込み範囲は、子の `cwd`（子の作業ツリー）の内側だけ（`scope.ts:165-170`）。daemon が読むのは、**`repoRoot`（根の作業ツリー）の `.worktreeinclude`**（`git-ports.ts:1007` は `repoRoot` を渡す）。両方は別のパス。
- 今の `.claude/` の守り（「子は `.claude/` を書けない」: `docs/plugin.md:284`）は、`repoRoot` の `.claude/` が子の `cwd` の外にあることによる。`hook-policy.ts:94` の「書き込みだけを禁じる場所」は、Desktop の子の作業ツリーの `.claude/`（見張りの設定）の話で、`repoRoot` の守りではない。
- `protectedRoots`（`compose.ts:498-509`）に `repoRoot` は入っていない。ルートの置き場にしても、`writableLocations` の関係は変わらない（`repoRoot` 直下は、子の `cwd` の外）。
- 子の Bash は、同じユーザーのプロセスで、絶対パスを書けば `repoRoot` を書ける**余地がある**（`docs/plugin.md:307` の限界）。これは `.claude/touryou-worktree-files.json` でも同じで、今回の変更で悪くなるものではない。

推測・注意:
- `.worktreeinclude` を**コミットして追跡する**と、子の作業ツリーにもコピーが出て、子はそれを書き換えられる。ただし daemon は子のコピーを読まず、`repoRoot` の現物だけを読む。子の変更が `repoRoot` に届くのは、統合（マージ）の後で、そのときは、統合の確認（受理）を通る。**統合の後の `repoRoot` の `.worktreeinclude` が、次の子から効く**ので、統合のレビューでは、`.worktreeinclude` の変更を、設定の変更として見る必要がある（文書に書く: 8 章）。
- 追跡しない（コミットしない）運用だと、`.worktreeinclude` は `repoRoot` にだけあり、子の経路では変わらない（今の JSON と同じ）。どちらも許す（未決 8: 推奨は、どちらも許し、文書でマージ時の注意を書く）。
- 実装で、`repoRoot` の `.worktreeinclude` を子の `forbiddenLocations` に入れる必要があるかは、**未確認**（統合ノードの子の範囲の作り方〔`node_spawn`〕に左右される）。実装 PR で、`repoRoot` の中を `writableLocations` に含める範囲が作れるかを確かめ、作れるなら、`.worktreeinclude` を禁じる場所に足す。

## 7. (f) JSON が残っているときの止め方と、移行の手順

### 止め方

- `<repoRoot>/.claude/touryou-worktree-files.json` が**存在するとき**（中身・`.worktreeinclude` の有無は問わない）、`git worktree add` の前（`git-ports.ts:1006-1010` の位置）で失敗にする。新しい失敗の種類（例: `seedListLegacy`）。
- 読み取りの失敗（権限など）も、存在を確かめられないので失敗にする（安全側）。
- 失敗の文面（案）:
  - cause: `.claude/touryou-worktree-files.json は、使わなくなりました（.worktreeinclude に一本化）。作業ツリーは作りませんでした。`
  - nextActions: ①`repoRoot` の `.worktreeinclude` に、JSON の `files` の各行を、先頭に `/` を付けて写す（例を添える）。②JSON を消す（`rm .claude/touryou-worktree-files.json`。追跡しているなら `git rm`）。③対象が gitignore 済みか確かめる（`git check-ignore -v <path>`）。④もう一度、子を作る。
- 通知は `onSeed`（標準エラーの `worktreeSeeded`）ではなく、失敗の返り値（子の起動の失敗として、利用者に見える）。

### 変換の規則（移行の文面に載せる）

JSON の各 `files` の要素 `p` を、次で `.worktreeinclude` の 1 行にする:

1. 先頭に `/` を付ける（JSON は完全なパス。gitignore の `foo` は任意の深さに一致しうるので、`repoRoot` に固定する）。
2. `\`・`*`・`?`・`[` と、行頭に来る `#`・`!` は、`\` で退避する。末尾の空白も同様（gitignore の構文。【知識】）。
3. 例: `[".envrc", "packages/editor/src-tauri/binaries/actionlint-aarch64-apple-darwin"]` →
   ```
   /.envrc
   /packages/editor/src-tauri/binaries/actionlint-aarch64-apple-darwin
   ```

### 変わる挙動（移行の文面に載せる）

- **gitignore 済みでないファイルは写らない**（今の JSON では、未追跡・追跡済みも指せた）。写したいなら、`.gitignore` に足す。
- 元のファイルがないときの `missing` の通知は、なくなる（パターンに一致するものがなければ、何も起きない）。`onSeed` の `missing` の扱いは、未決 9（推奨: 項目は残して、常に空にする。通知を読む側の形を変えない）。
- 50 件の上限は、展開後の件数・大きさの上限に変わる（5 章）。
- 子ごとの回収の判定は、写したファイルを数えない点は変わらない（8 章の PR1 で、判定元を記録にする）。

### 文書・既存の設計の扱い

| 対象 | 扱い |
|:--|:--|
| `docs/worktree-seed-files.md` | `.worktreeinclude` の説明に書き換える（構文・上限・止め方・変換の規則）。JSON の説明は、「移行」の節に短く残す |
| `docs/plugin.md:277-299` | 見出し「再生成できる ignored のファイルを、新しい作業ツリーに置く（#250）」を、`.worktreeinclude` の手順に書き換える（Renga の例は、1 行 `/packages/editor/src-tauri/binaries/actionlint-aarch64-apple-darwin` に）。Claude Code と同じファイルであること・`repoRoot` の現物を読むこと・マージ時の注意（6 章）を足す |
| `CHANGELOG.md` | 利用者に見える変更として、**破壊的な変更（JSON を使わなくなる）**と移行の手順を書く。#250 の行（25 行）は、履歴なので変えない。入れる節は、未決 7 |
| `.sdd/task/250/design.md` | 履歴なので、**書き換えない**。冒頭に「#294 で `.worktreeinclude` に置き換えた」の 1 行だけ足す（足すか、足さずに #294 の設計側から参照するかは、実装 PR で決める） |
| `/touryou:setup`（`plugin/commands/setup.md`） | 今は、この一覧に触れていない【事実】。**必須の変更はない**。任意で、設定の確認のあとに「写すファイルがあれば `.worktreeinclude`（`docs/plugin.md`）」と案内を 1 行足せる。JSON が残っていれば、setup の確認の段階で気づけるようにするのは、未決 6（推奨: 足さない。失敗の文面で足りる） |

## 8. (g) 実装の PR の分け方・テスト・変更が及ぶファイル

### PR の分け方（小さく、各 PR は単独で `pnpm check` が通る）

| PR | 内容 | 挙動の変化 |
|:--|:--|:--|
| PR0（試験だけ） | 10 章の実測を、`packages/daemon/test/` の試験として入れる（git の挙動の確認）。案 A が成り立つか、ここで決める | なし |
| PR1（置き換えなしの整理） | 「写したファイル」の記録: 作業ツリーを作ったとき、コピーしたパスを `<gitDir>/touryou-seeded`（子の印 `CHILD_WORKTREE_MARKER` と同じ場所: `git-ports.ts:1036-1040`）に書き、`seededPaths`（`git-ports.ts:333-336`）が**記録を読む**ようにする。一覧の読み込み元は、まだ JSON | 回収の判定が、一覧の読み直しから、記録に変わる。**一覧を後から書き換えても、判定が変わらなくなる**（今は、書き換えると変わる） |
| PR2（本体） | `.worktreeinclude` の読み込み・列挙・`check-ignore`・上限・`planSeed` の拡張（`worktree-seed.ts`）、JSON が残っているときの失敗（7 章）、`git-ports.ts:1006-1010` の配線、`readSeedList` の廃止、試験の書き換え | **破壊的**: JSON が使えなくなる |
| PR3（文書） | 7 章の文書・CHANGELOG・（任意）setup の案内 | なし |

順序は PR0→PR1→PR2→PR3。PR2 と PR3 は、同じリリースに入れる（PR2 だけ出ると、文書が古い）。PR1 を挟む理由: 判定元を「再列挙」にすると、判定のたびに `ls-files -o` が走り、重く、また一覧の後の変更で判定がずれる（未決 3）。記録にすれば、PR2 は一覧の読み込みだけの変更に収まる。

AI-SDD の分類では、利用者が既存の設定を直さないと動かなくなるので、**Breaking Change**。必要な成果物（PRD の更新案・移行の記録）は、`.sdd/AI-SDD-PRINCIPLES.md` の「Workflow Management Guidelines」に従う（今回は**読んでいない**＝【未確認】。実装に入るときに確かめる）。

### テスト（`packages/daemon/test/worktree-seed.test.ts` を書き換え・追加）

- 一致・ignore 済みのファイルがコピーされる（権限も）。元は変わらない。回収の判定できれいとみなす。
- ignore 済みでない一致（未追跡・追跡済み）は、コピーされない。
- 否定 `!`・`**`・ディレクトリ `dir/`・先頭の `/`・コメント・空行。
- 一致がない→何も写さない（作業ツリーは作る）。`.worktreeinclude` がない→何も写さない。
- `.worktreeinclude` がリンク・大きすぎる・`..` を含む行→失敗（作業ツリーを作らない）。
- 外を指すリンクに一致→失敗（`seedOutsideRepo`）。通常でないものに一致→スキップして記録（未決 4 の結論に従う）。
- 上限の超過→失敗（一致件数・先頭の名前が文面に出る）。
- 再生成できるディレクトリの中の一致は捨てる（未決 5 の結論に従う）。
- 作業ツリー側にすでにあるものは上書きしない。
- JSON が残っている→失敗（`.worktreeinclude` があっても）。文面に変換の規則が出る。作業ツリーを作らない（`git worktree list` が 1 行のまま）。
- 丸ごと ignore のディレクトリの中のバイナリ（Renga の形）が、回収の判定できれいとみなされる（今の `130-150` と同じ）。一覧にない同じディレクトリのファイルは、きれいでない。
- git が使えない・時間切れ・出力が枠を超えた→失敗（作業ツリーを作らない）。
- 記録（PR1）: 記録に書かれたパスだけが、判定から外れる。一覧を後から変えても、判定は変わらない。記録がない（古い作業ツリー）→従来どおり数える（安全側）。

### 変更が及ぶファイル

- `packages/daemon/src/worktree-seed.ts`（本体）、`packages/daemon/src/git-ports.ts`（`32`・`326-336`・`1006-1010`・`1056-1063` 付近）。
- 新しい失敗の種類の登録先（`failure(code, …)` の置き場）は、実装で確かめる（未確認）。
- `packages/daemon/test/worktree-seed.test.ts`、必要なら `packages/daemon/test/git-ports.test.ts`。
- `docs/plugin.md`・`docs/worktree-seed-files.md`・`CHANGELOG.md`（・任意で `plugin/commands/setup.md`、`.sdd/task/250/design.md` の 1 行）。
- 状態画面・core・mcp・cli には、変更は及ばない見込み（`onSeed` の形を変えない限り。未決 9）。

### 危険

- R1: 大きなリポジトリで、`ls-files -o` が 60 秒・16 MiB の枠に当たる（【未確認】）。当たったら、失敗にして、直し方に「パターンを狭める」を出す。枠を超える場合は、候補を `ls-files` の対象のディレクトリ（`:(top)` の pathspec）で絞る案を、PR0 の実測で調べる。
- R2: macOS の既定は大文字小文字を区別しない（`core.ignorecase`）。git の照合は、これに従い、Claude Code は従わない可能性がある（【未確認】）。
- R3: グローバルの除外（`core.excludesFile`）・`.git/info/exclude` が、「ignore 済み」の判定に入るので、利用者のマシンごとに、写る範囲が変わりうる（Claude Code でも同じ可能性。【未確認】）。
- R4: `.worktreeinclude` がマージされて `repoRoot` で変わると、次の子から範囲が広がる（6 章）。上限（5 章）が、最後の歯止め。

## 9. (h) 未決の選択肢と推奨

難易度・有効度は ★1〜5。

| # | 課題 | 選択肢 | 推奨 | 難易度 | 有効度 |
|:--|:--|:--|:--|:--:|:--:|
| 1 | パターンの照合の実装（3 章） | A. git だけ（`ls-files -o -i --exclude-from`＋`check-ignore`） | **推奨**（実測 PR0 が通ること） | ★★★☆☆ | ★★★★★ |
| | | B. `ignore` パッケージを足す | 案 A が実測で成り立たないとき | ★★★☆☆ | ★★★☆☆ |
| | | C. `picomatch` などの glob | 不採用（意味がずれる） | ★★☆☆☆ | ★☆☆☆☆ |
| 2 | 展開後の件数・大きさの上限（5 章） | A. 50 件のまま | | ★☆☆☆☆ | ★★☆☆☆ |
| | | B. 件数＋合計の大きさ、超えたら失敗（数値は実測で決める） | **推奨** | ★★☆☆☆ | ★★★★☆ |
| | | C. 上限なし | | ★☆☆☆☆ | ★☆☆☆☆ |
| 3 | 回収の判定の「写したもの」の元（8 章 PR1） | A. 作る時にコピーしたパスを、作業ツリーの git のディレクトリに記録して、読む | **推奨**（一覧の後の変更に左右されない。判定が軽い） | ★★★☆☆ | ★★★★★ |
| | | B. 判定のたびに、パターンから列挙し直す | 判定のたびに `ls-files -o` が走る。一覧が変わると、ずれる | ★★★☆☆ | ★★☆☆☆ |
| | | C. 子が書ける `.touryou` などに記録する | 子が書き換えうるので不採用 | ★★☆☆☆ | ★☆☆☆☆ |
| 4 | パターンが、外を指すリンク・通常でないものに当たったとき（4 章） | A. 外を指すリンクは失敗、通常でないものはスキップして記録 | **推奨** | ★★☆☆☆ | ★★★★☆ |
| | | B. どちらも失敗（今の `planSeed` と同じ） | パターンの広がりで、止まりやすい | ★☆☆☆☆ | ★★★☆☆ |
| | | C. どちらもスキップ | 安全に関わる外向きのリンクを、黙って捨てる。不採用 | ★☆☆☆☆ | ★☆☆☆☆ |
| 5 | 再生成できるディレクトリの中に当たったとき（5 章） | A. 捨てて、通知に記録 | **推奨** | ★★☆☆☆ | ★★★★☆ |
| | | B. コピーして、上限で止める | 判定と整合しない | ★☆☆☆☆ | ★★☆☆☆ |
| | | C. 失敗にする | `**` 系のパターンで、毎回止まる | ★☆☆☆☆ | ★★☆☆☆ |
| 6 | 移行の案内（7 章） | A. 失敗の文面（変換の規則つき）＋文書だけ | **推奨** | ★☆☆☆☆ | ★★★★☆ |
| | | B. 上に加えて、`/touryou:setup` で JSON の残りを検出して案内 | 二重になる。効果は小さい | ★★☆☆☆ | ★★☆☆☆ |
| | | C. 上に加えて、変換を出力する CLI（`touryou …`。実行はしない）を足す | 新しい面が増える。1 回きりの移行には過剰 | ★★★★☆ | ★★★☆☆ |
| 7 | 入れる版（2 章） | A. 0.1.7 の節に足す（`0.1.7（2026-11-25）` がまだ公開前なら）。公開済みなら、タグを付け直さない | 公開前か確かめてから（決定どおり） | ★☆☆☆☆ | ★★★★☆ |
| | | B. 公開済みなら 0.1.8 | 公開済みの場合の既定 | ★☆☆☆☆ | ★★★★★ |
| | | | **事実**: `CHANGELOG.md` に `0.1.7（2026-11-25）` の節がすでにあり、版は 0.1.7（`package.json:4`）。決定は「v0.1.7 に入れる」だが、すでに準備のコミットがある。**統括の確認が要る**（タグ・Release の有無は、手元で確かめられていない） | | |
| 8 | `.worktreeinclude` を追跡するか（6 章） | A. どちらも許し、マージ時の注意を文書に書く | **推奨** | ★☆☆☆☆ | ★★★☆☆ |
| | | B. 追跡を禁じる（追跡済みなら失敗） | Claude Code と共有したい利用者を止める | ★★☆☆☆ | ★★☆☆☆ |
| 9 | `onSeed` の `missing`（`git-ports.ts:134`・7 章） | A. 項目は残して、常に空 | **推奨**（読む側の形を変えない） | ★☆☆☆☆ | ★★★☆☆ |
| | | B. 項目を消す | 形が変わる | ★★☆☆☆ | ★★☆☆☆ |
| 10 | 実測の置き場（10 章） | A. PR0 に試験として入れる | **推奨**（手元で実験できない制約と合う。以後の回帰も防ぐ） | ★★☆☆☆ | ★★★★★ |
| | | B. 実測せず、案 A で実装する | 【未確認】のまま出荷する | ★☆☆☆☆ | ★☆☆☆☆ |

## 10. 実測が要る項目（ブリーフの 7 項目＋ git の挙動）

手元で git を動かせないため、**すべて【未確認】**。PR0 の試験で確かめる。

| 項目 | 公式の記述（ブリーフ経由） | 何を確かめるか |
|:--|:--|:--|
| 件数・大きさの制限 | 記述なし | Claude Code の実際の上限。ない場合も、daemon は 5 章の上限を持つ |
| `!`（否定） | gitignore と同じ構文 | 否定が効くか。daemon は git の実装なので、`ls-files --exclude-from` で後勝ちになるか |
| ディレクトリ一括（`dir/`・`dir/**`） | 記述なし | 中のファイルが、すべて 1 件ずつ列挙されるか（`--directory` なしで） |
| 既存ファイルとの競合 | 記述なし | Claude Code は上書きするか。daemon は上書きしない（`copySeed`）。差があれば文書に書く |
| 権限 | 記述なし | Claude Code が権限を写すか。daemon は写す（`COPYFILE_FICLONE`・`copyFileSync` は権限を保つ。試験 `83`・`142`） |
| `**/` の特別な規則（v2.1.239 で変更） | 変更の内容を確かめていない | 変更後の意味。git の `**/` と同じか。違うなら、`.worktreeinclude` の例を書くとき、違いのない形（`/dir/` など）に限る |
| git: `ls-files -z -o -i --exclude-from=F` | — | F に一致する未追跡のファイルだけが出るか。標準の除外が混ざらないか |
| git: `check-ignore -z --stdin` | — | ignore 済みのディレクトリの中のパスが、出力に出るか。追跡済み・未追跡の差 |
| git: 入れ子の git・`.git` の扱い | — | `ls-files -o` が、入れ子のリポジトリを `dir/` の 1 件にするか。`.git` の中を出さないか |
| git: 時間・出力の大きさ | — | node_modules・target/ のあるリポジトリで、60 秒・16 MiB の枠に収まるか |
| git: 大文字小文字（`core.ignorecase`） | — | APFS で、`.Envrc` が `.envrc` のパターンに一致するか |
