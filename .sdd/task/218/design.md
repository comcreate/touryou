# #218 stateDir・worktreeRoot を repoRoot の内側に置けるか — 調査と設計

> 調べ方: コードと docs・`.sdd` を読んだ。git の履歴は引けない（検査が入った経緯・コミットメッセージは未確認）。
> 【事実】= 読んだ箇所の根拠あり。【推測】= 根拠が間接的。コードは変えていない。lint・typecheck・テストは **未実行**（コード変更なしのため）。

## 1. 現在の検査【事実】

| 場所 | 内容 |
|:--|:--|
| `packages/daemon/src/config.ts` 318〜324 行 | `stateDir`・`worktreeRoot`・`repoRoot` のどの 2 つも、一方が他方の中か同じ場所なら `invalidConfig`（書かれたパスで比べる） |
| `packages/daemon/src/compose.ts` 343〜370 行（`realOverlap`）、465〜468 行 | 起動時に、リンクを解決した実パス（大文字小文字・NFC をそろえる）で同じ検査。まだないパスは、あるいちばん深い祖先を解決して足す |
| `config.ts` 325 行 | `rootCwd` は `repoRoot` 自身かその配下（これは別の規則で、内側を許している） |

gitignore かどうかは、どちらの検査も見ない。

## 2. 検査の意図（コード・docs からの裏づけ）

検査の理由を書いた文書・コメントは **見つからなかった**（`git grep` で `重なり`・`overlap`・`gitignore` を docs・`.sdd/specification`・`packages/*/src` に当てた。`.sdd/task/161/investigation.md:45` が検査の存在に触れるだけ）。以下は、周辺の実装から読み取れる範囲。**意図そのものは推測**。

### 2-1. トークン・状態の置き場として（stateDir）【事実＋推測】
- 【事実】`stateDir` には SQLite（`state.db`）・`root-token`・ポートのファイル・`children.key` を置く。0700 で、他者の権限を許さない（`compose.ts` `prepareStateDir`、`docs/config.md:15`）。
- 【事実】子のフックは `stateDir` を保護対象（`protectedRoots`、`compose.ts:492-502`）にして、子の読み書きを拒む。plugin の場所の確かめも `repoRoot`・`worktreeRoot`・`stateDir` を「断る根」にしている（`compose.ts:173`）。
- 【推測】`stateDir` が `repoRoot` の中だと、`git add -A`・`git status` に state が巻き込まれ、トークン・SQLite の誤コミットが起きうる。また、子の範囲の `writableLocations` に `.`（作業ツリー全体）を書くと、書き込める場所に `stateDir` が入りうる（フックの保護で二重に守ってはいる）。

### 2-2. 子の作業ツリーとの関係（worktreeRoot）【事実＋推測】
- 【事実】子の作業ツリーは `<worktreeRoot>/<名前>` に `git worktree add --track -b` で作る（`git-ports.ts:5-8`）。`worktreeRoot` は `rootScope` の外の、子ごとの場所。子の範囲は各子の作業ツリーが基準（`validateScope`）。
- 【推測】`worktreeRoot` が `repoRoot` の中だと、根の作業ツリー（`rootCwd`＝`repoRoot` の場合）から見て、子の作業ツリーが未追跡のディレクトリ（入れ子の git）に見える。`git add -A` で gitlink（壊れた埋め込みリポジトリ）として誤って追加されうる。根のきれいか判定（`git status --porcelain --untracked-files=all`、`git-ports.ts:14`）も汚れる。
- 【事実】子の作業ツリーのきれいか判定は、gitignore の対象を「再生成できる許可リスト」以外は汚れ扱いにする（`config.ts:50`）。gitignore 済みの置き場は、この判定自体とは干渉しない（各作業ツリーの中だけを見るため）。ただし、入れ子の作業ツリーが、根の作業ツリーの判定にどう出るかは **読んでいない**（要実験）。

### 2-3. 実パスで比べる理由【事実】
`realOverlap` はリンク・APFS の大文字小文字違いを吸収する。リンク経由で重なりを作れてしまうと、保護が外れるため（コメント `compose.ts:344,363`）。

## 3. 内側に置く場合のリスクと対策案

| # | リスク | 内容 | 対策案 |
|:--|:--|:--|:--|
| R1 | トークン・state の誤コミット | `stateDir` が `repoRoot` の中で、gitignore されていなければ、`git add` に載る | 許す条件に「gitignore 済み」を必須にする。`stateDir` 直下に `.gitignore`（`*`）を daemon が作る案もある |
| R2 | 子の範囲（rootScope・子の writableLocations）が state を含む | `.` を許すと、子が書ける場所に `stateDir` が入る | 既存のフックの保護（`protectedRoots`）に任せる。加えて、設定読み込みで `rootScope.writableLocations` が `stateDir` を含むなら拒否する |
| R3 | worktree の入れ子 | `worktreeRoot` が `repoRoot` の中だと、根の `git status`・`git add -A` で子の作業ツリーが見える／誤って追加される | gitignore 済みを必須にする（ignore された入れ子は `git add -A` に載らない）。ignore の書き方が `<名前>/` を含む必要があるので、`worktreeRoot` ごと ignore されるか確かめる |
| R4 | `git worktree add` の挙動 | `repoRoot` の中に別の作業ツリーを作ること自体は git が許す【推測。要実験】。ただし `repoRoot` の中の別の作業ツリーが、自分自身（`.git` ファイル）を持つため、gitignore のパターン次第で見え方が変わる | 設計の実装前に、実際の git で、ignore 済みの入れ子の `worktree add`・`status`・`worktree remove` を試す |
| R5 | 回収・削除 | `git worktree remove` は gitignore の対象を黙って消す（`git-ports.ts:1131`）。`stateDir` が作業ツリーの下に来ると、巻き込まれる | `stateDir` は `worktreeRoot` の外に保つ（`stateDir`⇔`worktreeRoot` の重なりは今のまま拒否する） |
| R6 | 検査の抜け | ignore が後から消える・ずれる（`.gitignore` の編集） | 起動時だけの検査では足りない。毎回の起動で検査し、daemon 稼働中の変更は未検出であることを docs に書く |

## 4. 許す場合の設計案

前提: 許すのは「`repoRoot` の内側かつ、`git check-ignore` 相当で ignore 済み」の `stateDir` と `worktreeRoot` だけ。`stateDir`⇔`worktreeRoot`、および `repoRoot` を他方が囲む向き（外側に置く）は、今のまま拒否する。

### 案 A: 検査は daemon の起動時（compose）で、`git check-ignore` を呼ぶ（推奨）
- 設定の読み込み（`config.ts`）は純粋な関数のまま、構文の検査だけ。重なりのうち「内側かつ向きが `repoRoot ⊃ X`」だけは設定の層では通し、起動時の `realOverlap` で、実パスにしたうえで `git -C <repoRoot> check-ignore -q --no-index <相対パス>/`（ディレクトリは末尾に `/`）を呼ぶ。ignore 済みでなければ `invalidConfig`。
- 長所: 実パス・リンクを解決した後に判定できる（`config.ts` は文字列だけ）。副作用（git の呼び出し）を `compose` に閉じられる（既存の `git-ports.ts` と同じ層）。
- 短所: `--check-config`（launchd の検査）も同じ検査を通す配線が要る。git が使えないときの扱いを決める必要がある（拒否＝安全側）。
- 難易度 ★★★☆☆（3）／有効度 ★★★★☆（4）／**推奨**

### 案 B: `config.ts` で、`repoRoot/.gitignore` を読んで文字列で判定する
- git を呼ばず、`.gitignore` のパターンを自前で解釈する。
- 長所: 設定の層で完結し、純粋。
- 短所: gitignore の規則（否定・ネスト・`.git/info/exclude`・グローバルの ignore）の再実装になり、ずれる。設計原則（正しいものを使う）に反する。
- 難易度 ★★★★☆（4）／有効度 ★★☆☆☆（2）／非推奨

### 案 C: 許さない。意図を docs/config.md に書く
- 今の拒否を維持し、理由と、代わりの置き場（`$HOME/.touryou` など）を docs に書く。
- 長所: リスクがない。変更が最小。
- 短所: #218 の要望（repoRoot の中に置きたい）を満たさない。
- 難易度 ★☆☆☆☆（1）／有効度 ★★☆☆☆（2）

### 案 D: 案 A に加え、daemon が `stateDir` 直下に `.gitignore`（`*`）を作り、`.touryou-state` 印のあるものだけを許す
- ignore が `repoRoot/.gitignore` に頼らず、state 自身が自分を ignore する（誤コミットの防止が自己完結）。`worktreeRoot` には同じことをしない（子の作業ツリーは git の登録が正のため）。
- 長所: `stateDir` の R1・R6 を、利用者の `.gitignore` に依存せず防げる。
- 短所: 設定の読み込み時に、書き込む副作用が増える。許す範囲の説明が複雑になる。
- 難易度 ★★★★☆（4）／有効度 ★★★★☆（4）

## 5. 利用者に判断を仰ぐ点（report_decision で提出）

1. 内側を許すか（許す／許さずに意図を書くだけ）。
2. 許すなら、`stateDir`・`worktreeRoot` の両方か、`stateDir` だけか（R3・R4 の入れ子は `worktreeRoot` の側が難しい）。
3. 許す条件: 「`git check-ignore` で ignore 済み」だけか、「`.gitignore` を daemon が書く（案 D）」まで含めるか。
4. 判定の層: 起動時（案 A）／設定の読み込み時（案 B）。

## 6. 次にやること（判断のあと）
- R4 の実験（ignore 済みの入れ子で `git worktree add`・`git status`・`git add -A`・`git worktree remove` が期待どおりか）。
- 判断のとおりに、`docs/config.md` の意図の節を直し、実装の子を立てる。

## 7. 確定した判断（利用者の答え: 「stateDir だけ許す（案 A）」）

### 7-1. 採用と、捨てた案
- **採用: 案 A を `stateDir` だけに適用する。** `stateDir` が `repoRoot` の内側にあり、かつ起動時の `git check-ignore` で ignore 済みと確かめられたときだけ許す。
- **`worktreeRoot` は拒否のまま。** 理由: ignore 済みの入れ子で `git worktree add`・`status`・`add -A`・`worktree remove` がどう動くかを、まだ確かめていない（R3・R4。【未確認】）。確かめるまで、安全側に倒す。
- 捨てた案:
  - 案 B（`.gitignore` を自前で解釈）: 否定・ネスト・`.git/info/exclude`・グローバルの ignore の再実装になり、git とずれる。設計原則（正しいものを使う）に反する。
  - 案 C（許さない）: 利用者が許す答えを選んだため不採用。ただし `worktreeRoot` には、C と同じ扱いが残る。
  - 案 D（daemon が `.gitignore` を書く）: 設定の読み込みの副作用が増え、説明が複雑。利用者は選ばなかった。R1・R6 は、起動のたびの `git check-ignore` で足りるとみる。必要になったら別の issue にする。
- 許す範囲の細かい決め（実装の PR で守る）:
  - 許す向きは `repoRoot ⊃ stateDir` だけ。`stateDir` が `repoRoot` と同じ場所、`stateDir` が `repoRoot` を囲む、`stateDir`⇔`worktreeRoot` の重なり、`worktreeRoot`⇔`repoRoot` の重なりは、今のまま拒否。
  - **`rootCwd` との位置は問わない（確定: 案 3-C。利用者に確かめ直した）。** 当初は「`stateDir` が `rootCwd` の内側なら拒否」としたが、通常の配置（`rootCwd` = `repoRoot`）で内側の `stateDir` がすべて拒否され、緩和の意味がなくなるため取り下げた。根の作業ツリーに state が見える問題は、ignore 済み・未追跡の確かめ（と、子のフックの `protectedRoots`）で足りる。
  - git が使えない・`check-ignore` が失敗した・ignore されていない・**追跡済みのファイルを含む**、のどれも拒否（安全側）。

### 7-2. 検査の層（案 A）
- `config.ts`（`parseConfig`）は純粋なまま。`repoRoot ⊃ stateDir` の向きだけを、構文の段では拒否しない（他の重なりは今のまま拒否）。
- **【実装での変更】** `createDaemon` は同期関数で、git の実行（`GitRunner`）は非同期なので、検査は `compose.ts` ではなく、新しい `packages/daemon/src/state-dir-ignore.ts` の async 関数 `checkStateDirIgnored` にした。`main.ts` が、`createDaemon` と `--check-config` の前に 1 回呼ぶ（起動と `--check-config` が、同じ検査を通る。`MainDeps.checkStateDir` で試験が差し替えられる）。`compose.ts` の `realOverlap` は、同じ「`repoRoot ⊃ stateDir`」だけを実パスで許す。実パスを作る関数（`realPathForWrite`）は、同じモジュールを共有する。
- `checkStateDirIgnored` は、実パスにした `stateDir` が `repoRoot` の真に内側のときだけ、`repoRoot` からの相対パスを作り、(1) `git ls-files -z -- <相対>` に出れば拒否（追跡済み）、(2) `git check-ignore -q --no-index -- <相対>/` を呼ぶ（終了 0 = ignore 済み、1 = 未 ignore、128 などは失敗）。ignore 済みでなければ `invalidConfig`（「stateDir が repoRoot の内側にあるが gitignore されていない」＋直し方: `.gitignore` に足す、または外に置く）。
- `--check-config`（launchd の検査。`docs/launchd.md:48`）も同じ検査を通す。
- 【確定】`--no-index` は、追跡済みのファイルが ignore を無視される扱いを避けるためだが、`stateDir` が追跡されていれば、ignore があっても誤コミットは起きる。そのため**追跡済み（`git ls-files -- <相対>` に出る）なら拒否する**（利用者の答え）。

### 7-3. 実装 PR の分け方
1. **PR 1（検査）**: `config.ts` の重なりの検査を `repoRoot ⊃ stateDir` だけ緩める。`compose.ts` に ignore の検査を足す。`--check-config` に同じ検査を配線する。テスト（下）を付ける。
2. **PR 2（文書）**: `docs/config.md` の節を、下の文面に直す。`docs/launchd.md` の検査の説明に 1 行足す。

PR 1 と 2 は同じ PR でもよい（変更が小さいため）。別 issue: `worktreeRoot` の内側を許すかは、R4 の実験の後に判断する。

### 7-4. 試験の観点
- 設定: `stateDir` が `repoRoot` の内側 → 構文の段では通る（`rootCwd` の内側でも通る。3-C）。`repoRoot` と同じ場所・`repoRoot` を囲む・`worktreeRoot` と重なる → 拒否のまま。`worktreeRoot` が `repoRoot` の内側 → 拒否のまま。
- 起動時: ignore 済み → 起動できる。未 ignore → `invalidConfig`。`git` が使えない → 拒否。`stateDir` がまだない（初回）→ あるいちばん深い祖先で判定できる。
- リンク: `stateDir` が `repoRoot` の外へのリンクなら、実パスで外側と判定される（許す条件に入らない）。`repoRoot` の中へのリンクなら、実パスで内側と判定される。大文字小文字・NFC の違い（APFS）。
- ignore の書き方: `.touryou/`・`/.touryou`・`*` ・グローバルの ignore（`core.excludesFile`）・`.git/info/exclude`。否定（`!`）で外れる場合。
- 追跡済みの `stateDir`（7-2 の【要確認】）。
- `--check-config`（launchd）が同じ結果を返す。
- 実行時: ignore 済みの `stateDir` の中身が、根の `git status` に出ない。子のフックの `protectedRoots`（`stateDir`）が、内側でも効く。
- 【未実行】いずれもまだ書いていない・動かしていない。

### 7-5. docs/config.md に書く文面（実装の PR で、現在の節を置き換える）

> ### 置き場の重なりの検査
>
> `stateDir`・`repoRoot`・`worktreeRoot` は、互いに重なってはいけません。ただし次の 1 つだけは許します。
>
> - **`stateDir` が `repoRoot` の内側にあり、gitignore 済みで、git に追跡されていないとき。** （`rootCwd` との位置は問いません。）daemon の起動のとき（`touryou-daemon --check-config` も同じ）に `git check-ignore`・`git ls-files` で確かめ、ignore されていない・追跡されているなら起動しません。`.gitignore` に `stateDir` を足してください。
>
> 理由: `stateDir` にはトークン（`root-token`）と SQLite が入るので、`git add -A` などで誤ってコミットされないようにするためです。`worktreeRoot` は、子の作業ツリーが入れ子の git になるため、`repoRoot` の内側には置けません（確かめが済むまで拒否します）。`stateDir` が `.gitignore` から外れる・追跡される変更は、起動のときにしか確かめません。

### 7-6. 今回やっていないこと
- コードの変更、lint・typecheck・テスト（**未実行**）。
- R4 の実験（ignore 済みの入れ子の git の挙動）。
