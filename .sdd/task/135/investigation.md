# Issue #135 調査: 承認した場所へ Bash で書く形（cp・mkdir・touch・git rm・git mv）の承認の効かせ方

touryou 0.1.5・main（1df72e7）。実装はしない。設計の調査だけ。

## 0. 読み方（事実と推測の区別）

- **【事実】** は、この調査で実際に読んだコードに基づく。`ファイル:行` を付ける。
- **【推測】** は、読んでいない所・動かして確かめていない所。実装者が着手前に確かめる。
- この調査では、読み取りに Read、書き込みに Write、git は `git status`・`git add`・`git commit` だけを使う指示だったため、ディレクトリの一覧・全文検索ができなかった。そのため、**次は読めていない**（推測の元になる）:
  - core の `effectiveScope` の本体の場所（`compose.ts:36` で `@touryou/core` から import されている。`scope.ts`・`brief.ts` にはない）
  - `scope_extend` の MCP の定義と、親の承認（`scope.extensionDecided`）を扱うハンドラ
  - `hook-policy` の既存の試験ファイルの場所（`packages/daemon/src/sdk/hook-policy.test.ts`・`packages/daemon/test(s)/hook-policy.test.ts` は存在しなかった）
  - #130・#133 の ADR・design-draft（`.sdd/task/133/design-draft.md` は存在しなかった）
  - docs の「フック」の節の全文（`docs/plugin.md` の先頭 40 行だけ読んだ）

## 1. 現状（#130・#133 の作り）

### 1.1 承認の流れ【事実】

1. 子が `scope_extend` で、`command` の形（引数まで）か `write` の場所を頼む。親が承認すると `scope.extensionDecided` が記録に載る。
2. CLI の子のフック `decideCliHook`（`packages/daemon/src/compose.ts:1589`）が、PreToolUse のたびに、`effectiveScope(log.state(), nodeId)`（ブリーフの範囲＋承認済みの拡張。`compose.ts:1600`）を導く。承認は次の呼び出しから効き、daemon の再起動でも失われない。
3. `resolveScope`（`hook-policy.ts:743`）が、`writableLocations` を実パスにする（解決できない場所は落とす）。拡張で足した場所も同じ。
4. `decideToolUse`（`hook-policy.ts:774`）が許可・拒否を決める。Bash は `evaluateScope(scope, cwd, {kind:"command"})`（core の `scope.ts:315`）で、`allowedCommands` の**語ごとの前方一致**。
5. 許可のとき、`grantedOnlyByExtension`（`hook-policy.ts:872`）が真なら、`permit: "extension"` を返す（`compose.ts:1676`）。**起動のときの許可の一覧（`--settings` の `permissions.allow`。dontAsk）にない形は、この明示の許可がないと、Claude Code の側で断られる。** つまり、permit が実質の許可。

### 1.2 「引数を足してよいコマンドの一覧」（#130・#133）【事実】

- 表: `ARGS_OK_COMMANDS`（`hook-policy.ts:933`）。`git add`・`git status`・`git ls-files` の 3 つ。各行は `head`（先頭の語）と `flags`（許す旗の集合）。旗は**許す表にあるものだけ**（表にないものは断る）。
- `flagAllowed`（`:1027`）: 完全一致、または短い旗のまとめ書き（`-nv` を 1 字ずつ）。
- `safePositional`（`:1035`）: 位置の引数は `/^[A-Za-z0-9._/:@+,%=-]+$/` で、`/` 始まり・`..` を含む語は断る。空白・引用符・glob・`~`・展開の字は文字の表にないので断る。
- `extendsWithSafeArgs`（`:1040`）: 承認した形（`entry`）で始まり、うしろが旗と安全な位置の引数だけなら真。`--` のあとはすべて位置の引数。
- 呼び出し側の条件（`:894-918`）: ブリーフにない承認済みの項目だけを使う。区切り・裏起動を含む項目は外す。`commandEntryProblem`（`child-permissions.ts:117`）が空・`cd` 始まり・**1 語だけ**・任意のコードが動く形を断る。コマンドに `<` `>` `` ` `` `$` があれば、うしろに足した形は認めず、完全一致だけ。

**この方式の性質（重要）【事実】**: #133 の 3 つのコマンドは、`safePositional` が**パスを作業範囲と照らさない**。それで足りているのは、git がインデックスを触るだけ（作業ツリーのファイルを書かない）で、作業ツリーの外・リンクの先を自分で断るため（`hook-policy.ts:924-928` のコメントの主張。git の挙動はこの調査では動かして確かめていない【推測】）。**cp・mkdir・touch・git rm・git mv は実際にファイルを書く・消すので、この前提が成り立たない。** 現に `hook-policy.ts:929-932` のコメントが、「入れないもの」として、`git rm`・`git mv`・`cp`・`mv`・`mkdir`・`touch` を、「作業ツリーの中のリンクを通って外へ書ける」ことを理由に挙げている。#135 は、その理由（リンクを通った先で比べていない）を、実パスの照らしで解消する設計。

### 1.3 実パスの照らしに使える既存の部品【事実】

| 部品 | 場所 | 内容 |
|:--|:--|:--|
| `resolveForWrite(absPath, fs)` | `sdk/path-resolve.ts:25` | 最も深い既存の祖先を `realpath` にして、ない残りを足す。存在しない部分に `..` がある・ぶら下がりリンク・権限などの失敗は例外（フックが拒否する）。**#113 と同じ考え方の本体。** |
| `resolveHookPath` | `compose.ts:1441` | `resolveForWrite(p, nodeFsOps)`。`decideToolUse` に `resolve` として渡している。 |
| Write・Edit の判定 | `hook-policy.ts:789-827` | `target = await resolve(絶対化したパス)` → `evaluateScope(scope, cwd, {kind:"write", path: target})`。**書き込みの道具の判定と、そっくり同じ手順を Bash の位置の引数に使える。** |
| `resolveScope` | `hook-policy.ts:743` | `writableLocations`（拡張を含む）を `resolve` で実パスにする。まだない場所も、最も深い既存の祖先＋残りで解決される。 |
| `evaluateScope(…write…)` | core `scope.ts:125,315` | 禁止場所が優先。許可場所の配下か。大文字小文字・NFC の畳み込み、書式制御文字・NUL・空のパスは `invalidPath`。 |
| `checkBash` の `writeDenied` | `hook-policy.ts:497-608` | `.git` と git のディレクトリ（CLI の子）への書き込みを、**コマンドの全語**（`=` の右側も）で見る（`wordHitsWriteDenied`）。`DESTRUCTIVE`（`rm・rmdir・mv・chmod・chown・chflags・unlink・shred`。`:272`）は、禁じる場所の**祖先**を対象にしても拒否する。 |
| `checkBash` の禁じる場所 | `hook-policy.ts:610-630` | パスに見える語（`/` を含む・`~` 始まり・`.`・`..`）を実パスにし、stateDir など読み取りも禁じる場所を拒否する。 |
| `isReadOnlySearch` の `pointsOutside` | `sdk/read-only-search.ts:310` | 語を実パスにして作業ツリーの内かを見る。`hasUnquotedExpansion`（`:278`。引用符の外の `* ? [ {`・語頭の `~` を見る）は**非公開**。 |

別実装（再利用しない）【事実】: `compose.ts:327` の `real`（`realOverlap` 用）と `compose.ts:490` の `realDeep` は、同じ「今ある一番深い祖先＋残り」だが、失敗時に例外ではなくフォールバックで返す。フックの判定に使うと、ぶら下がりリンクを拒否できず緩くなる。**フックには `resolveForWrite` を使う。**

## 2. 設計

### 2.1 コマンドと旗の表（一覧に入れるもの）

既存の 3 つ（`git add`・`git status`・`git ls-files`）は変えない。次を足す。位置の引数の種別が違うので、表に `paths` の種別（`"writable"`）を持たせる（2.2）。

方針は #130 と同じ: **旗は許す表だけ。値を取る旗は、値の解釈が要るので入れない。** 旗の挙動は GNU・BSD（macOS）の一般的な知識による【推測】。実装時に、macOS の実機で `--help`・`man` を見て確かめる。

| コマンド | 許す旗 | 断る旗（根拠） | 位置の引数 |
|:--|:--|:--|:--|
| `mkdir` | `-p` `--parents`、`-v` `--verbose` | `-m` `--mode`（値付き。setuid などの権限を付けられる）、`-Z` `--context`（SELinux の値付き） | 1 つ以上。すべて書き込み先 |
| `touch` | `-a`、`-m`、`-c` `--no-create` | `-h` `--no-dereference`（リンクそのものを触る。実パスの照らしとずれる）、`-r` `--reference`・`-d` `--date`・`-t`（値付き。`-r` は別のパスを読む） | 1 つ以上。すべて書き込み先 |
| `cp`（単一ファイルの形） | `-n` `--no-clobber`、`-v` `--verbose`、`-f` `--force` | `-r` `-R` `--recursive`（木の中のリンク・禁じる場所の扱いが OS で違う【推測】。初版は入れない。2.6 の後続）、`-a` `--archive`（`-dR --preserve=all`）、`-l` `--link`（ハードリンク。元のファイルへの書き込みになる）、`-s` `--symbolic-link`（リンクを作る）、`-L` `-H` `-P`（リンクの扱いを変える）、`-t` `--target-directory`・`-T`・`-S`・`-b` `--backup`（宛先を別の形で指す・値付き）、`-i` `-I`（対話で止まる）、`-p` `--preserve`（初版は不要）、`--parents`、`--reflink`、`--attributes-only` | 2 つ以上。**最後が宛先（書き込み先）、残りは元（読み取り）** |
| `git rm` | `-n` `--dry-run`、`-q` `--quiet`、`--cached`、`-r`、`-f` `--force`、`--ignore-unmatch`、`--sparse` | `--pathspec-from-file`・`--pathspec-file-nul`（ファイルからパスを読む。`git add` でも断っている根拠と同じ） | 1 つ以上。すべて書き込み先（作業ツリーのファイルを消す。`--cached` でも、承認の範囲を単純にするため書き込み先として照らす） |
| `git mv` | `-f` `--force`、`-k`、`-n` `--dry-run`、`-v` `--verbose` | （旗の値を取るものはない。表にない旗はすべて断る） | 2 つ以上。**元も宛先も書き込み先**（元を消し、宛先を作る） |

旗を断る根拠の共通点: **任意のコードを動かす道・設定やファイルを読み込ませる道・外へ書く道・リンクを作る道・対話で止まる道**。git の大域の旗（`-c` など）は、サブコマンドの前にしか効かず、`git rm`・`git mv` で始まる承認の形（`git` の次が副コマンド）にそもそも一致しない【事実: `extendsWithSafeArgs` が `entry` の語の並びの前方一致で見る。`hook-policy.ts:1041`】。`git rm`・`git mv` は、フック・フィルター・fsmonitor を動かさない【推測。git の既知の挙動。`git commit` のフックと違う】。設定（alias・include）は子が書けない【事実: `checkBash` が `git config` の alias 書き込みと `-c alias.…` を断る。`hook-policy.ts:519-571`】。

### 2.2 位置の引数（パス）を、実パスで照らす方法

#### 手順（各位置の引数 `p` について）

1. **字の検査**: 空でない。NUL・書式制御文字（Cf）・制御文字がない（core の `hasFormatChar` と同じ考え。`evaluateScope` の write が `invalidPath` で断るので、結果として同じ）。`~` 始まりは断る。`git rm`・`git mv` では、先頭が `:` の語（pathspec の魔法。`:/x` は作業ツリーの一番上からの相対で、cwd 基準の照らしを迂回する）を断る。
2. **展開の検査**: コマンド文字列全体に `hasUnquotedExpansion`（`read-only-search.ts:278`。**export する**）が真なら、4 つのコマンドすべてで断る。これで、引用符の外の `* ? [ {` と語頭の `~` がなくなり、パーサー（core の `commandWords`）が見せる語と、シェルが実際に渡す語が一致する。
3. **絶対化**: `p` が `/` 始まりなら `p`、そうでなければ `${here}/${p}`（`here` は実パスのフック入力の cwd。`decideToolUse` の `toolCwd` と同じ）。`/` 始まりの絶対パスも、手順 4・5 で書き込みの場所の配下かを見るので、一律には断らない（`safePositional` と違い、承認した場所が作業ツリーの中なら、絶対パスで書いても同じ場所を指す）。
4. **実パス化**: `real = await resolveHookPath(abs)`（= `resolveForWrite`）。失敗したら断る（`invalidPath`。ぶら下がりリンク・存在しない部分の `..`・権限）。
5. **範囲の照らし**: `evaluateScope(resolvedScope, wt, {kind:"write", path: real})`。`resolvedScope` は `resolveScope` の結果（拡張を含む）。`allowed` でなければ、その理由（`outsideWritable`・`forbiddenLocation`・`invalidPath`）で断る。
6. **禁じる場所**: 既存の `checkBash` が、同じ語を先に見ている（`writeDenied` の全語走査、禁じる場所の `pathLike` 走査）。ここでは足さない。ただし 2.4 の祖先方向の穴を塞ぐ。

読み取り側（`cp` の元）: 書き込み先としては照らさず、手順 1〜2 と、既存の禁じる場所の走査（`checkBash`。実パスにして stateDir などを断る）だけを通す。読み取りは制限しない（FR_014）ので、作業ツリーの外のファイルを承認した場所へ**写す**ことは、Read で読んで Write で書くのと同じで、新しい穴ではない。作業ツリーの中の元だけに絞る選択肢もあるが、初版は入れない（2.6）。

#### リンクを通った先の比較

- 位置の引数 `docs/link/x`（`docs/link` が作業ツリーの外へのリンク）は、手順 4 で `link` の先の実パス＋`x` になり、手順 5 で書き込みの場所の外として断られる（Write の道具と同じ結果）。
- リンクの先がまだないとき（ぶら下がり）は、手順 4 の `resolveForWrite` が例外にして断る（書き込みでリンクの先が作られるため。`path-resolve.ts:36-41`）。
- 宛先がすでにあるリンクのファイル（`cp a docs/link`）は、`realpath` がリンクの先を返すので、先で照らす。

#### 実装の形（関数の分け方）

`grantedOnlyByExtension`（`hook-policy.ts:872`）は**同期の純粋関数**で、`resolve` を持たない。実パス化は非同期なので、次のどちらか。

| 案 | 内容 | 難易度 | 有効度 |
|:--|:--|:--|:--|
| A（推奨） | 区切りごとの判定を 2 段にする。同期の関数が、各区切りを `safe`（今までの完全一致・`extendsWithSafeArgs`）か `needsPaths`（種別 `writable` のコマンド。コマンド・書き込み先の語・元の語を返す）に分類する。非同期の関数 `grantedOnlyByExtensionAsync` が、`needsPaths` の語を 2.2 の手順で照らす。既存の同期の関数と試験はそのまま。`decideCliHook` は非同期のほうを呼ぶ | ★★★☆☆ (3) | ★★★★★ (5) |
| B | `grantedOnlyByExtension` 自体を非同期にして `resolve` を引数に足す。呼び出し・試験の書き換えが要る | ★★★☆☆ (3) | ★★★★☆ (4) |
| C | `decideToolUse` の中（Bash の枝）に、パスの照らしを入れ、permit とは独立に拒否する | ★★★★☆ (4) | ★★★☆☆ (3) 〔承認の有無によらず `cp` などを見るので、ブリーフ時代の許可の挙動が変わる。#135 の範囲を越える〕 |

加えて、**承認済みの形でパスだけが範囲外のとき**は、permit を付けずに通す（Claude Code が dontAsk で理由なく断る）のではなく、`decideCliHook` で**明示の拒否**（`outsideWritable` の `violation`）にして、子へ理由が伝わり、範囲違反として記録されるようにする（`compose.ts:1682-1684` の既存の経路）。

#### 承認の形（entry）の扱い【事実と提案】

- `cp`・`mkdir`・`touch` は**1 語**の形で承認される（引数を足す形は旗とパスなので）。いまの `commandEntryProblem`（`child-permissions.ts:120`）は 1 語を断り、`grantedOnlyByExtension` の `granted` のふるい（`hook-policy.ts:908`）もこれを使うため、**そのままでは `mkdir` `cp` `touch` の承認が届かない**。
- ただし、1 語を許す先は `grantedOnlyByExtension` だけ。**起動のときの一覧 `childAllowList`（`child-permissions.ts:144-156`）は今のまま 1 語を断る**。そうしないと、ブリーフに `cp` を書いたとき `Bash(cp:*)` が静的な許可に入り、フックの permit を経ずに任意のパスが通る。拡張専用の関数 `extensionEntryProblem(words)`（`ARGS_OK` の 1 語の先頭だけを例外にする）を `child-permissions.ts` に足し、`grantedOnlyByExtension` だけが使う。
- 親が承認する側（`scope_extend` の受け口・判定のハンドラ）が 1 語を断っていないかは**未確認【推測】**。実装者が確かめる。

### 2.3 glob（`*`）と空白を含むパスの扱い

#### 現状【事実】

`safePositional` の字の表に、空白・引用符・`*`・`?`・`[`・`{`・`~` がない。引用符で囲んだ語も、パーサーが引用符を外して空白を含む 1 語にするので、断られる。

#### glob の選択肢

| 案 | 内容 | 難易度 | 有効度 |
|:--|:--|:--|:--|
| 1 | **すべて断る**（今のまま）。引用符の中の `*` も断る | ★☆☆☆☆ (1) | ★★☆☆☆ (2) 〔子は `git rm docs/a.md docs/b.md` と、1 つずつ書けば足りる。広い一括の削除を避ける利点はある〕 |
| 2（推奨） | **`git rm`・`git mv`・`git add` だけ**、引用符で囲んだ glob を許す（git が自分で pathspec として展開する）。**固定の部分**（最初の glob の文字を含む段より前。`hook-policy.ts:343` の `fixedPrefix`）を実パスにして、それが書き込みの場所の配下のときだけ通す（`'docs/*.md'` → 固定の部分 `docs`）。`'*.md'` のように固定の部分が作業ツリーの一番上になるものは、その場所が書き込みの場所の配下でない限り断る。引用符の外の glob は、手順 2 で断る（シェルが先に展開する）。`cp`・`mkdir`・`touch` は案 1（シェルが展開するか、引用符の中ならファイル名の字になるため、どちらも照らせない） | ★★★☆☆ (3) | ★★★★☆ (4) |
| 3 | daemon 側でも glob を展開して、一致した各パスを実パスで照らす | ★★★★★ (5) | ★★★☆☆ (3) 〔展開の規則（dotglob・`**`・拡張 glob）がシェルや git と食い違うと、照らしたものと実行されるものがずれる。確認と実行の間に一致が変わる〕 |

案 2 の注意【推測】: git の pathspec の `*` は `/` をまたいで一致する（`fnmatch` の `FNM_PATHNAME` なし。`docs/*` は `docs/a/b` にも一致）。固定の部分の配下に収まるので、範囲は越えない。pathspec の魔法（`:(…)`・`:^`・`:/`）は、先頭が `:` の語として手順 1 で断る。

#### 空白を含むパスの選択肢

| 案 | 内容 | 難易度 | 有効度 |
|:--|:--|:--|:--|
| 1 | 断る（今のまま） | ★☆☆☆☆ (1) | ★★☆☆☆ (2) |
| 2（推奨） | **引用符で囲んだ空白**は許す。パーサーが外した後の語は、シェルが渡す引数と同じ（引用符の外の展開は、手順 2 の `hasUnquotedExpansion` がなくす）。空白以外は、手順 1 の検査（NUL・制御文字・Cf）のまま。旗に見える語（`-` 始まり）は、旗の表で照らす（引用符で囲んでも、シェルは旗として渡す） | ★★☆☆☆ (2) | ★★★★☆ (4) |
| 3 | `--` のうしろだけ許す | ★★☆☆☆ (2) | ★★★☆☆ (3) 〔`--` を子が書き忘れると、断られる〕 |

案 2 の前提: `commandWords` が、引用符・`\` の扱いで、シェルと同じ語に分けること。`parseCommand`（`scope.ts:148`）は `$`・`` ` ``・`!`・`<>()`・制御文字を引用符の外で拒否し、引用符の中の `$` と `` ` `` と `!`（二重引用符の中）も拒否する【事実: `:181` は引用符 `'` の外・`"` の中の両方でこの 3 字を拒否する】。ANSI-C 引用（`$'…'`）は `$` で拒否される。

**この 2 つ（glob と空白）は、パスの照らし（2.2）の上に重ねる拡張で、2.2 がなければ安全に入れられない。初版は、2.2 だけで十分（glob・空白は断る）。** 推奨は、初版では案 1（glob）・案 1（空白）で出し、続く版で案 2 を入れる（2.6）。

### 2.4 祖先方向の穴（#113 の考え方の延長）

`checkBash` の `DESTRUCTIVE`（`hook-policy.ts:272`）は、`writeDenied`（CLI の子では `.git` と git のディレクトリ）の**祖先**を対象にした `rm`・`mv` を拒否する（`:595-606`）。`git rm`・`git mv`・`cp`（宛先が祖先を上書きしうる）は、この表にない。CLI の子では、`.git` は作業ツリー内のファイルで、`git rm -r .` は `.git` を消さない【推測。git の既知の挙動】ので実害は小さいが、**Desktop の子の `.claude/`（書き込み禁止）が作業ツリーの中にある木**では、`git rm -r .` が祖先として `.claude` を含みうる。ただし、`permit: "extension"` は CLI の子（`decideCliHook`）だけで、Desktop の子の判定（`decideDesktopHook`）は permit を持たない【事実】ので、**#135 の変更が Desktop に届くことはない**。念のため、`git rm`・`git mv` を `DESTRUCTIVE` と同じ扱い（`name === "git"` かつ副コマンドが `rm`・`mv`）にする案を、実装者が検討する（難易度 ★★☆☆☆ (2)・有効度 ★★★☆☆ (3)）。

### 2.5 変更する箇所

| ファイル | 変更 |
|:--|:--|
| `packages/daemon/src/sdk/hook-policy.ts` | `ARGS_OK_COMMANDS`（`:933`）に `mkdir`・`touch`・`cp`・`git rm`・`git mv` を足し、各行に `paths` の種別（`"none"`＝今の 3 つ、`"writable"`）と、位置の引数の役割（全部が書き込み先・最後だけが書き込み先）を持たせる。`extendsWithSafeArgs`（`:1040`）が、種別で分岐する（`writable` は、旗と位置の引数に分け、位置の引数の語の並びを返す）。新しい `async` 関数（案 A の `grantedOnlyByExtensionAsync`）が、2.2 の手順 1・3〜5 を行う。`git rm`・`git mv` の先頭が `:` の語を断る。`ARGS_OK_COMMANDS` の説明のコメント（`:921-932`）の「入れないもの」を、更新する（`git rm`・`git mv`・`cp`・`mkdir`・`touch` を入れた理由と、入れない `mv`・`cp -r` など）。 |
| `packages/daemon/src/sdk/read-only-search.ts` | `hasUnquotedExpansion`（`:278`）を `export` する（2.2 の手順 2）。 |
| `packages/daemon/src/sdk/child-permissions.ts` | 拡張専用の `extensionEntryProblem(words)` を足す（1 語を、`ARGS_OK` の先頭の語に限って許す）。`commandEntryProblem` と `childAllowList` は**変えない**（2.2 の「承認の形」）。 |
| `packages/daemon/src/compose.ts`（`decideCliHook` の `:1651-1680`） | `grantedOnlyByExtension` の呼び出しを、非同期のほうに差し替える。承認済みの形で位置の引数が範囲外のときは、permit を付けずに通すのではなく、`violation` つきの拒否を返す。 |
| core（`packages/core/src/scope.ts`） | 変更しない見込み（`evaluateScope`・`isPathUnder`・`commandWords` をそのまま使う）。`effectiveScope` の本体は未確認【推測】。 |

### 2.6 後続（初版に入れないもの）

- `cp -r`・`-R`（木の中のリンクの扱いが BSD・GNU で違う【推測】。元の木にリンクがないことを `lstat` で確かめるなど、別の設計が要る）。
- glob（2.3 案 2）・空白（2.3 案 2）。
- `cp` の元を作業ツリーの中だけに絞る選択肢（2.2）。
- `ln`・`mv`（リンクを作る・動かす。`git mv` で足りる）。

## 3. 試験の置き方

既存の試験の場所は未確認【推測】（前の節の 0）。`createDaemon`（`compose.ts:433`）を本物で起動し、**実際の git の作業ツリー**を使って、`POST /v1/hook` を通す形にする。手順:

1. 一時ディレクトリに git リポジトリと作業ツリーを作り、`DaemonDeps.worktree`（`WorktreePorts`。`compose.ts:166`）の `cwdOf` が作業ツリーを返すようにする。
2. 子のノードを作り（ブリーフの `writableLocations` は空か狭く）、`scope.extensionDecided` で、`command`（`mkdir`・`cp`・`touch`・`git rm`・`git mv`）と `write` の場所を承認する（承認の記録の作り方は未確認【推測】）。
3. フックのトークンで、PreToolUse（`tool_name: "Bash"`、`tool_input.command`）を送り、`permissionDecision: "allow"`（permit）と、拒否の理由・`violation` の記録を確かめる。

**通るはずのもの**: `mkdir -p docs/new/dir`、`touch docs/a.md`、`cp src/a.ts docs/b.ts`、`git rm docs/old.md`、`git mv docs/a.md docs/b.md`（承認した場所の中）。

**断られるはずのもの**（理由つき）:

| 入力 | 理由 |
|:--|:--|
| `mkdir ../x`・`touch /tmp/x`・`cp a /etc/x` | 作業ツリーの外（`outsideWritable`） |
| 承認した場所の外の、作業ツリーの中（`touch src/x`） | 承認した書き込みの場所の外 |
| 承認した場所の中のリンク（`docs/link` → 外）を通る `touch docs/link/x`・`cp a docs/link` | 実パスが外 |
| ぶら下がりリンク、存在しない部分の `..`（`mkdir -p docs/nope/../../x`） | `resolveForWrite` が例外 |
| `touch .git/x`・`cp a .git/hooks/pre-commit` | `writeDenied`（既存） |
| 表にない旗（`mkdir -m 777`・`cp -l`・`cp -s`・`touch -r`・`git rm --pathspec-from-file=f`） | 旗の表 |
| `git rm ':/src/a.ts'`・`git mv ':(top)a' b` | pathspec の魔法 |
| 引用符の外の glob・`~`・`{a,b}`（`touch docs/*.md`・`mkdir docs/{a,b}`） | `hasUnquotedExpansion` |
| 空白・引用符で囲んだ glob（初版では断る）、`cp` の元が stateDir | 初版の方針、禁じる場所（既存） |
| `mkdir -p docs/a && touch src/b`（区切りの片方だけ範囲外） | 区切りごとにすべて照らす |
| 承認していない形（`mkdir` だけ承認して `cp`） | permit が付かない |
| `cd docs && touch a`（先頭の `cd`） | `cd` に対する承認の形がない（permit なし） |
| 承認の取り消し・ブリーフに書いた `cp`（permit は拡張だけ） | `grantedOnlyByExtension` はブリーフにない項目だけ |

`git` は実物（`git rm`・`git mv` の挙動、リンクの先への拒否）を使い、旗の OS 差は macOS で確かめる。

## 4. docs・skill・`scope_extend` の説明の直す箇所

| 場所 | 直すこと |
|:--|:--|
| `plugin/skills/child/SKILL.md:33`（`scope_extend` の行） | 「`git add`・`git status`・`git ls-files` だけは、うしろに安全な旗と作業ツリーの中のパスを足してもよい」を、足した 5 つ（`mkdir`・`touch`・`cp`・`git rm`・`git mv`）と、パスは**承認した書き込みの場所の中**でなければならないこと、断る形（外・`..`・リンク経由・glob・表にない旗）に更新する。コマンドの `target` に 1 語（`mkdir`・`cp`・`touch`）を書いてよいこと、その場合も書き込みの場所の `write` の拡張を別に頼む必要があること。 |
| `plugin/skills/integrator/`（親の判定の手順。未読【推測】） | 親が `command` の拡張を承認するときに、同時に `write` の場所の承認が要ること、1 語の承認は位置の引数が書き込みの場所の中に限られること。 |
| `scope_extend` の MCP の説明（`packages/mcp` の中。場所は未確認【推測】） | 子のツールの説明文と、受け口の検査（1 語の形を断らないか）。 |
| `docs/plugin.md` の「フック」の節（未読【推測】）と、#130 の記述 | `ARGS_OK_COMMANDS` の一覧を書いた箇所を探し、更新する。 |
| `hook-policy.ts:921-932` のコメント | 上の 2.5。 |

## 5. リスク

| リスク | 内容と対策 |
|:--|:--|
| 確認と実行の間の差し替え（TOCTOU） | 実パスを確かめてから、コマンドが走るまでの間に、リンクを差し替えられる。Write の道具も同じ限界（既存）。子は 1 つのシェルで、バックグラウンドの起動は断られる（`backgroundExecution`）ので、同じ子の中の競合は小さい。別のプロセス（同じユーザー）による差し替えは防げない。`docs` に明記する。 |
| 旗の OS 差 | GNU と BSD（macOS）で、旗の意味・既定が違う（`cp -R` のリンクの扱いなど）。表は許すものだけに絞り、実機で確かめる【推測】。 |
| ハードリンク | 承認した場所の中のファイルが、外のファイルへのハードリンクなら、`cp a docs/that`（宛先を開いて書く）は外の中身を変える。Write の道具にも同じ性質がある（既存の限界）。新しい穴ではない。 |
| 1 語の承認の広さ | `mkdir`・`cp`・`touch` の 1 語の承認は、前方一致で任意の引数に一致する。permit を出す条件（旗の表・パスの照らし）が通らない形は、permit が付かず dontAsk が断る。`childAllowList` に 1 語を入れないこと（2.2）が、この安全の前提。 |
| `cp` で元を読む | 禁じる場所以外の、作業ツリーの外のファイルを、承認した場所へ写せる。Read と Write の組み合わせと同じ（FR_014）。気になるなら、元を作業ツリーの中に絞る（2.6）。 |
| 祖先方向 | 2.4。 |
| 大文字小文字・正規化（macOS） | `evaluateScope` の `fold`（NFC・小文字化）が、書き込みの場所と禁じる場所の比較に効く（既存）。実パスの綴りは `realpath`（ディスクの綴り）なので、一致する。 |
| 範囲の設定の食い違い | `resolveScope` は、解決できない `writableLocations` を落とす（`:758-761`）。拡張で足した場所が、ぶら下がりリンクなどで解決できなければ、書き込みの場所が空になり、すべて断られる（フェイルクローズ）。 |
| 承認の取り消しがない | `effectiveScope` はイベント列から毎回導く（`compose.ts:1599`）。取り消しの扱いは未確認【推測】。 |

## 6. 受け入れ基準との対応

- コマンドと旗の表・実パスの照らし方・glob と空白の選択肢と推奨・変更箇所と試験・リスク: 2.1・2.2・2.3・2.5・3・5。
- 読んだ事実と推測の分離: 各節の【事実】【推測】と、0 の「読めていない所」。
- 実装コードの変更: なし（このファイルだけを足した）。
