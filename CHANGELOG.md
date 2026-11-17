# 変更履歴

## 未公開

### 利用者に見える変更

- **状態画面の小さな点を直した**（#115）: 受信箱の知らせの文に出ていた長いノード ID を、子の題にした（ID はカードで見られる）。「墓標」「範囲の拡張要求（command）」などの内部の言葉を、「消した跡」「コマンドを足す頼み」などにした。一覧の「詳しく」が狭い窓で 2 行に折れないようにした（題は省略して 1 行）。人から子への線の札が、範囲の頼みの判定でも「→ 指示」になっていたのを、「許可」「却下」「切り出し」にした（判断の答えは「答え」の 1 本だけ）。

- **状態画面を何度も開き直しても、今見ているタブが「すぐ更新」のままになり、コンソールが 429 で埋まらないようにした**: 画面の購読（`/v1/events`）は daemon 全体で 4 本までで、`/touryou:ui`・`touryou ui` は開くたびに新しいタブを開くため、古いタブが枠を占め、新しいタブは 429 を受けて 2 秒ごとの確かめに落ち、再試行を続けていた。枠が埋まったら、いちばん古いタブが譲る（`event: replaced`。譲ったタブは「別のタブで開いています」と出し、自分からは張り直さず、選んだときに張り直す）。裏に回って 30 秒たったタブは購読を閉じ、確かめを 30 秒ごとにする（見えたら張り直す）。429 が 3 回続いたら再試行をやめ、見えたとき・フォーカスで試す。張り直しの間隔の上限を 5 分にした。子・統合の購読の枠は変えていない。
- **CLI の子でも、作業ツリーの中を探すコマンド（`ls`・`find`・`grep`・`git ls-files`・`git grep`）が通るようにした**（#92）: CLI の子は dontAsk で、起動のときの許可の一覧はブリーフの範囲だけのため、フックが探すコマンドを「何も言わずに」許しても、範囲の許可のコマンドにない形は通らなかった。daemon がこれらを探すコマンドとして許したときは、フックが明示の許可を返すようにした（外のパス・禁じる場所・許さない旗は今までどおり断る）。あわせて、実機の Claude Code が送りがちな形も通るようにした: 先頭の 1 つだけの作業ツリーの中への `cd <dir> &&`（`;`・`||`・`|` でつなぐ形・2 つ目の `cd`・行き先に `..` を含む `cd`・リンクを通る行き先の字句が作業ツリーの外のものは今までどおり断る。それまでは `cd` が範囲にないとして `commandNotAllowed` で断っていた）、エラー出力を捨てるだけの `2>/dev/null`・`2>&1`、`|` の直後の `head`・`tail`・`wc`・`sort`・`uniq`（旗だけ。位置の引数は取らない）。パスは実パスで比べるようにし（まだないパスは、今ある一番深い祖先を実パスにして残りを足す）、macOS の `/var` → `/private/var` のようなリンクを通る作業ツリーへの絶対パスも通す。CLI の子の道（`POST /v1/hook`）を、本物の daemon と git の作業ツリーで通す試験を足した。

## 0.1.3（2026-11-17）

### 利用者に見える変更

- **状態画面の関係図を、見本（mock.html）の形にそろえた**（#89）: 箱に、状態の言葉と印（動いています・● あなたの答え待ち・‖ 止まっているかも・✕ 失敗・済んだ・■ 止めた）、役割の印と「何分前」、動いている点、あなたの答えの数を出す。左の縁は、進んでいる＝藍・答え待ち＝柿・止まっているかも＝くすんだ黄・失敗＝朱・終わった＝薄い灰。列の見出し（いちばん上の統合・子・孫）を出す。線は親の幹から子ごとに分かれ、上りの矢印が 1 点に重ならない。線の札に「何分前」と段の言葉を添える。図は枠の幅に合わせて描き、枠の高さを図に合わせる。止まっているかもの子のカードも、くすんだ黄にした。画面の頭の帯が、狭い窓で切れないようにした。線は新しいほど濃くし、箱を押す（Enter・Space でも）とその子のカードへ移り、箱に指を置くとその子の線だけ浮かぶ。図の下に凡例を出す。
- **状態画面を「いま何が起きていて、何をすればよいか」が分かる作りにし、やり取りの関係図を足した**（#89）: いちばん上に「いまあなたがすること」（判断の頼み・範囲を広げる頼み・daemon が止まっているかもしれないと知らせた子・停止の代行依頼）を、数と一覧で出す。止まっているかもしれない CLI の子には、`claude attach <ノード ID>` と写すボタンを出す。子ごとのカード（題・役割・状態・最後の動き・あなたの答えの数・受信箱の項目・この子への操作）にした。「要対応」の数は、人の操作が要るものだけを数える（進み具合・済んだ・知らせを数えていたため、「判断待ちはありません」と食い違っていた）。「やり取り」は、親子の木（根が左）と上り（子 → 親）・下り（親・人 → 子）の線・やり取りの段（送った・届いた・済んだ）の図と、木の一覧を「図」「一覧」で切り替えられる。人とのやり取りは「人」の箱へ線を引き、答えを待つものだけ柿色にする。図の箱は動かせない（拡大・移動はできる）。最終削除・保留・保管は、たたんだ「管理」の欄に移した。内部の言葉（SSE・seq・墓標など）を、利用者の言葉に置き換えた。動きは、変わったときだけ付け、OS の「視差効果を減らす」と画面の「動きを止める」で止まる。CSP は変えていない。
- **状態画面を `/touryou:ui`・`touryou ui` で、トークンの貼り付けなしに開けるようにした**（#88）: `touryou ui` が `human-token` を自分で読み、daemon の身元を確かめてから、使い捨てのチケット（60 秒・1 回だけ）をもらって、既定のブラウザで開く。画面はチケットを、画面のセッション（使わないと 1 時間・最長 12 時間・画面のメモリだけ。daemon を起動し直すと切れる）に交換する。`ps`・ブラウザの履歴に残るのは、使い捨てのチケットだけ。**`/ui#token=…` の受け口は外した**（貼り付けは予備に残す）。再読み込みしたら、`/touryou:ui` で開き直す。ブラウザを開けないときは、URL を出さずに、Mac のターミナルで `touryou ui` を実行するよう案内する。
- **範囲の拡張を承認したら、子の同じコマンド・書き込みがすぐ通るようにした**（#91）: CLI の子のフックが、承認を足した範囲ではなくブリーフの範囲で判定していたのを、有効な範囲で判定するようにした。起動のときの許可の一覧にない承認済みのコマンドは、承認した形そのもの（語の数まで同じ）で、任意のコードが動く形でないときだけ、フックが明示の許可を返す（dontAsk で断られない）。承認した書き込みの場所への書き込みにも、明示の許可を返す。引用符を含む許可（`git grep -E "A|B"` など）が、子の打つ同じ形に当たらなかったのも直した（許可の項目も、命令と同じく引用符を外して比べる）。子の受信箱のブリーフにも、承認済みの拡張を足した範囲を出す。
- **調べ役などの子が、作業ツリーの中を Bash の `ls`・`find`・`grep`・`git ls-files`・`git grep` で探せるようにした**（#92）: Claude Code の native 版は Glob・Grep の道具を出さず、Bash の find・grep で探させるが、子のフックが範囲の許可のコマンドにないとして止めていたため、子が何も探せなかった。これらは範囲によらず許す（作業ツリーの中だけ。オプションは許す表にあるものだけを通し、リンクをたどる旗・コマンドを動かす旗・ファイルを取る旗、引用符の外のパターン、外のパス、禁じる場所は断る）。統合と子の skill の案内も、道具が見えないときは Bash で探すと書きそろえた。
- **常駐を外すとき、TouRyou.app がなければ LaunchServices の登録の解除を飛ばしたと知らせる**（#79）: `touryou launchd uninstall` で、current の中に TouRyou.app がないのに「登録を解いた」と出ていたのを、`apply` にそろえて「飛ばした」と出すようにした。

### 内部の変更

- **状態画面の作り直しの調べ・仕様・表示モデル・関係図の束と試験**（#89）: 調べと画面の見本（#96）、要求・仕様・設計・ADR（#103）。表示モデル（`uiViewOf`）に、題（目的の先頭 80 コードポイント）・最後の動き・人の要対応の数（`needsHuman`）・作業の状態の 3 段（`band`）・受信箱の `ref`・`stall`・拡張要求の時刻・やり取りの段（`flows`。本文は載せない）を足した（#104）。関係図は `rete`・`rete-area-plugin`・`rete-readonly-plugin`（版は完全に固定）を esbuild で束ねた `/ui/graph.js` で、描画のプラグインを使わず自前で描く（#105・#106・#109）。SVG を作るのは `svgEl` の 1 か所、動く玉の `offset-path` も 1 か所に閉じ、自前のコードは今の走査に、束ねたライブラリは禁止の API の不在と束ね直しの一致の試験にかける。画面のタグの許可リストに `details`・`summary`・`code` を足した（#107）。画面の試験（Playwright。版 1.64.1 を一時の場所に入れる）を、CI の ubuntu・node 22 のジョブで流す。`docs/images` の画面写しを撮り直した。
- **手で marketplace を足した人には project の marketplace の固定が効かないことを、文書に書いた**（#100）: user の設定の項目が勝ち `main` に追従すること、固定したいときの手順（user の項目に `ref` を足し、固定した参照で `marketplace add` をし直す。版上げのたびに直す）、`marketplace remove` は plugin とそのデータを消すので使わないことを、`docs/release.md` に書き、`README.md`・`docs/plugin.md` からそこを指した。
- **project 設定の marketplace の参照を、変わらない tag `marketplace-v<版>` に固定した**（#90）: `.claude/settings.json` の `extraKnownMarketplaces` に `ref: marketplace-v0.1.2` を足した（これまでは `main` に追従していた）。`release.yml` の `marketplace-self` の PR が、`marketplace.json` と一緒に `ref` も新しい版に書き換え、マージのあとに管理者が手元から tag を付ける（`docs/release.md` の 5-a）。tag の決まり（ruleset `release-tags`）の対象に `refs/tags/marketplace-v*` を足し、管理者だけが作れ、付け直し・削除できないようにする。PR の CI で `ref` の名前が版と合うかを、`marketplace-ref.yml` で、tag の push のときは tag の中の版が tag 名と合うかを、日に 1 回は `main` の `ref` の tag があり中の版が合うかを照らす（`scripts/check-marketplace-ref.sh`）。
- **PR ごとの macOS のジョブを 1 つにまとめ、機械が割り当てられなかったときは 1 回だけ自動で走らせ直す**（#84・#85）: `dist-smoke.yml` を `ci-macos.yml` にまとめ、1 つのジョブで `scripts/check.sh` と配布物の確かめを続けて行うようにした（Mac の機械を 1 台だけ待つ）。`macos-capacity-rerun.yml` を足し、`CI (macOS)`・`Release` が「was not acquired by Runner」だけで落ちたとき、落ちたジョブを 1 回だけ走らせ直す（試験の失敗は走らせ直さない）。
- **手順書に、tag を付けるのは決まりを越えてよい管理者で、手元から push すると書く**（#80）: `docs/release.md` の 3 に、ruleset で tag を作れる人が限られていること、「Bypassed rule violations … creations being restricted」の行のあとに `* [new tag]` が出れば成功であること、クラウドのセッションからの push は 403 で断られるので管理者に頼むことを書き足した。
- **project の設定に、touryou の marketplace と plugin、frontend-design の plugin を登録した**（#87・#97）: このリポジトリの中で Claude Code を開く人（touryou を開発する人）向け。

### 上げ方

v0.1.2 以前を入れている Mac で、次のとおり（細部は `docs/setup-verification.md` の C と、`/touryou:setup` の手順〔`plugin/commands/setup.md`〕）。

1. plugin を上げる。

   ```sh
   claude plugin marketplace update touryou
   claude plugin update touryou@touryou
   ```

2. 新しいセッションで `/touryou:setup` を実行する（本体が v0.1.3 に入れ替わる）。セッションの始まりに、本体と plugin の版の違いの知らせが出ることもあるが、出なくても実行する。
3. 常駐（launchd）させているときは、`/touryou:setup` が daemon の起動し直しの同意を聞くので、「はい」と答える（「いいえ」なら何も変えずに止まる）。
4. 上げる前から開いている統合セッションは、古い版の `touryou-mcp` のまま動き続ける。`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面なら、Claude Code を起動し直す）。そのあと `/touryou:start` で、接続を確かめる。
5. 状態画面は、`/touryou:ui`（または Mac のターミナルで `touryou ui`）で開き直す。**`/ui#token=…` の URL（ブックマーク・履歴）では、もう接続しない**（#88）。開いていた画面は、daemon の起動し直しで切れるので、開き直す。
6. marketplace の固定（#90）について、README のとおりに入れて使っている人は、何もしなくてよい。touryou のリポジトリの中で Claude Code を開き、前に手で `claude plugin marketplace add comcreate/touryou` をした人だけ、固定したいときは `docs/release.md` の「手で marketplace を足した人には、project の固定が効かない」（#100）に従う（しなくても、plugin は `main` に追従して動く）。

## 0.1.2（2026-11-16）

### 利用者に見える変更

- **常駐のログイン項目を「TouRyou」の名前で出す**（#76。#73）: macOS の配布物に `TouRyou.app` を置き、同梱の node を `Contents/MacOS/TouRyou` に入れて、入れ物ごと手元の署名（ad-hoc）にした（`bin/node` はそこへのリンクで、node は 1 つ）。`touryou launchd init` の plist は `current/TouRyou.app/Contents/MacOS/TouRyou` で daemon を起こし、`AssociatedBundleIdentifiers`（`com.comcreate-info.touryou`）を付ける。`apply` は TouRyou.app を LaunchServices に登録し、`uninstall` は解く。v0.1.1 の形（`current/bin/node`）・v0.1.0 の形（`run-daemon.sh`）の生成物は、バイト単位で同じときだけ置き換える。ログイン項目は「TouRyou」の 1 項目で、「開発元を識別できない項目」と出るのは ad-hoc の署名のためで正常。Developer ID の署名は、本番の正式リリースの前に見直す（ADR）。
- **/setup などの案内の、取得の大きさとログイン項目の名前を実際に合わせる**（#75。#74）: 取得の大きさを「約 150MB」から「約 41MB」（v0.1.1 の tar.gz。展開後は約 130MB）にした。常駐を入れたときのログイン項目の名前を、実際の出方に合わせた（v0.1.2 からは「TouRyou」の 1 項目。#73）。導入の script の知らせの文・`touryou launchd init` の知らせの文・`README.md`・`docs/cli.md`・`docs/launchd.md`・`docs/release.md`・手の確かめの一覧も合わせた。

### 内部の変更

- **hono の例外の後片付け**（#51）: @hono/node-server 2.1.6 が公開から 14 日を過ぎるので、#71 で足した `pnpm-workspace.yaml` の `minimumReleaseAgeExclude` の例外を消した（入る版は変わらない）。
- **ログイン項目の sh・bash の説明を直す**: ログイン項目の `sh`・`bash` は TouRyou の項目ではなかった（入れる前からある、ほかのものの項目。v0.1.0 の常駐が出していたのは `run-daemon.sh` の 1 つ）ので、`docs/launchd.md`・`docs/cli.md`・設計書・手の確かめの文書と、`/touryou:setup` の定型文を直した。0.1.1 の節は、そのときの記録として変えていない。
- **v0.1.0・v0.1.1 の形の常駐からの引っ越しの試験**（#76。#73）: `touryou launchd init`・`apply`・`uninstall` が、v0.1.0 の形（`run-daemon.sh`）と v0.1.1 の形（`current/bin/node`）の生成物を、バイト単位で同じときだけ置き換える・外すことを試験で守る。ad-hoc の署名と Developer ID の判断を ADR に書いた。

### 上げ方

v0.1.0・v0.1.1 を入れている Mac で、次のとおり（細部は `docs/setup-verification.md` の C と、`/touryou:setup` の手順〔`plugin/commands/setup.md`〕）。

1. plugin を上げる。

   ```sh
   claude plugin marketplace update touryou
   claude plugin update touryou@touryou
   ```

2. 新しいセッションで `/touryou:setup` を実行する（本体が v0.1.2 に入れ替わる）。セッションの始まりに、本体と plugin の版の違いの知らせが出ることもあるが、出なくても実行する。
3. 常駐（launchd）させているときは、`/touryou:setup` が daemon の起動し直しの同意を聞くので、「はい」と答える（「いいえ」なら何も変えずに止まる）。「はい」のあと、常駐の plist が新しい形（TouRyou.app の中の node で daemon を起こす。#73）に置き換わり、ログイン項目が「Node.js Foundation」（v0.1.1）から「**TouRyou**」の 1 項目に変わる。「開発元を識別できない項目」と出るのは、手元の署名（ad-hoc）のためで正常。v0.1.0 から上げたときは `run-daemon.sh` の項目が消える（`sh`・`bash` の項目は TouRyou の項目ではない）。plist を手で直していたときは、置き換えずに止まるので、`docs/launchd.md` の「古い形からの引っ越し」に従う。
4. 上げる前から開いている統合セッションは、古い版の `touryou-mcp` のまま動き続ける。`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面なら、Claude Code を起動し直す）。そのあと `/touryou:start` で、接続を確かめる。

## 0.1.1（2026-11-16）

### 利用者に見える変更

- **/setup の許可の確認を、知らせた回数に合わせる**（#69。#63）: `/touryou:setup` の中で走らせる Bash を 3 つ（導入・設定・常駐の登録）だけにし、node の道具や `/touryou:start`・`/touryou:service` の中身を代わりに呼ばない（確かめは script の出力と Read で行い、接続の確かめは利用者に `/touryou:start` を打ってもらう）。知らせる回数を書き分けた（常駐あり 3 回・なし 2 回・版を上げるときは 1〜2 回）。設定の段でパスを言い直したときは、その段だけをやり直せる。回数の確かめは、次の実機で行う。
- **同じ版のときに、/setup が「配布物を取得します」と言い切らない**（#67。#62）: `/touryou:setup` が導入の script の前に言う定型文を「導入の script を実行します。初めて・版が変わったときは、配布物を取得します（約 150MB）。同じ版が入っているときは、取得しません」にした。実際に取得したかは script の出力が知らせる。
- **/setup の検査の一覧のファイルを ~/.touryou/work に残さない**（#66。#61）: `install-runtime.sh` が中身の検査で作る一覧（`list.txt`・`list-v.txt`、約 0.9MB）を、置き場の中の一時ディレクトリに作り、成功でも失敗でも、中断（Ctrl-C・SIGTERM）でも消す。`~/.touryou/work` に残るのは、取得した tar.gz だけ。
- **常駐の plist から、shell を通さず同梱の node で daemon を直に起こす**（#70。#64）: ログイン項目に `run-daemon.sh`・`sh`・`bash` の 3 つが「開発元を識別できない項目」として出ていた。`touryou launchd init` の plist は、`current/bin/node` で `current/lib/dist/bin.js` を直に起こし、`run-daemon.sh` を作らない（ログイン項目は `node` の 1 項目の見込み）。版は plist に書かず、配布物の版の印（`lib/dist-version`）を daemon が読む。v0.1.0 の形の生成物は、同じ `--org`・`--path-prefix` の古い `init` の生成物とバイト単位で同じときだけ置き換え（手で直していれば止まる）、`uninstall` は古い形も外す。上げたあとも `sh`・`bash` の項目が残ることがあるが、害はない（`docs/launchd.md`）。
- **常駐の登録の前に、設定を daemon と同じ検査にかける**（#70。#65）: `touryou-daemon --check-config`（起動せず、設定の読み込み・実パス・`repoRoot` が git のリポジトリかを確かめる）を足した。`launchd init`・`apply` と、`/setup` の版上げ（常駐の daemon を止める前）がこれを実行し、通らなければ何も変えずに止まる（値は伏せる）。`launchd status` は、last exit code が 0 以外なら `daemon.log` の最後の失敗の行を出す。
- **配布物から、ビルドの場所を指す壊れたシンボリックリンクを除く**（#56）: v0.1.0 の tar.gz には、pnpm deploy が残した `lib/node_modules/.pnpm/node_modules/@touryou/daemon`（CI のマシンの元のソースを指す）が入り、新しい `/touryou:setup` が「外を指すシンボリックリンクがある」で止まった。v0.1.1 の配布物から、`scripts/dist-build.sh` が展開先の外を指す・行き先のないリンクを取り除き（取り除いたものをビルドの出力に出す）、`scripts/dist-smoke.sh` が `/setup` と同じ検査（`install-runtime.sh` の関数）を tar.gz に当ててから Release に付ける。`/setup` の検査は緩めていない。
- **macOS の bash 3.2 で、日本語の表示の直前の変数で導入の script が止まるのを直す**（#47）: `plugin/scripts/` の shell script の変数を、すべて `${名前}` の形にした（UTF-8 のロケールの bash 3.2 は、`$ver）` の全角の文字を名前の一部として読む）。`pnpm validate:plugin` が、`plugin/scripts` の `$名前` と、`$名前` のすぐあとの ASCII でない文字（`scripts/*.sh` も）を拒む。試験を UTF-8 のロケールでも走らせる。
- **本体の導入を plugin の中の script にまとめた**（#12）: `/touryou:setup` の取得・照合・展開・付け替え・動作の確かめと、版が変わったときの常駐の daemon の起動し直し（「はい」のあとだけ）を、plugin の中の `scripts/install-runtime.sh` が 1 回で行う。承認の確認は約 12 回から約 3 回になった。本体と plugin の版が違うと、セッションの始まりに知らせる（知らせるだけ）。
- **plugin の一番上の bin/ をなくす**（#36）: 中継を `plugin/bin/touryou-mcp-shim.sh` から `plugin/scripts/touryou-mcp-shim.sh` に移し、claude.ai・Cowork・組織の設定からも plugin を入れられるようにした（一番上に `bin/` がある plugin は、そこから入れられない）。`pnpm validate:plugin` が、`plugin/bin/` があれば（空でも）拒む。update の直後のセッションは、`/reload-plugins` までは古い版の置き場の中継を使い続ける（古い置き場は残るので動く）。
- **退役を SSE で知らせ、mcp が張り直さずに止まる**（#32）: 子のトークンが役目の終わり（受理など）で失効したら、daemon はノードの購読に `event: retired` を 1 件送ってから閉じる（heartbeat を待たない）。子の mcp はこれを受けたら張り直さず、資格情報を空にして止まる。退役のあとの 401（`apiAuthFailed` の `retiredExpired`）が出なくなる。古い daemon・古い mcp との組み合わせは、今までどおり。
- **退役したトークンでのくり返しの認証の失敗を知らせる**（#31）: 退役した紐付けのトークンでの呼び出し（`retiredExpired`）が、1 つの窓（1 分）で閾値（既定 3。`rateLimit.alert.retiredThreshold` で 2〜100000）以上になったら、根の受信箱に `info` を 1 件出す。ほかの認証の失敗の警告とは、閾値・間隔・解決を別に見る。
- **退役したトークンでの認証の失敗を retiredExpired と記録する**（#7）: 退役（受理など）で失効させた紐付けのトークンでの認証の失敗を、`apiAuthFailed` の理由 `retiredExpired` として記録し、期限切れ（`expired`）と見分けられるようにした。子の mcp は、退役で購読を切られたあとの 401 で張り直しをやめる。
- **停止の要求の seq を、追記の結果からとる**（#27。#10）: daemon の `node.stop` が、停止の要求の `stopSeq` を、追記のあとの状態ではなく追記の結果の seq からとる（停止の追記のあとに別の記録が入っても、違う seq を返さない）。seq が取れないときは `internal` で失敗する。
- **止まった子の未回答の判断を tree に出す**（#8）: `touryou tree --json`・`touryou tree <nodeId>` に、止まった子の未回答の判断（`pendingDecisions`）が出る。
- **回答を子に届けたかを answer に出す**（#9）: `touryou answer` が、回答を子に届けたか（daemon の `decision.answer` の結果の `delivery`）を出す。
- **依存の脆弱性の修正**（#15）: 配布物に入る依存を、既知の脆弱性を直した版に上げた（zod 4.6.7〔high〕・body-parser 2.4.0〔high〕・qs 6.16.2・fast-uri 3.1.9・ip-address 10.7.5）。
- **setup で子に commit させるかを尋ねる**（#5）: `/touryou:setup` の設定の手順で、子に commit させるか（`git add`・`git commit` を根の範囲に入れるか）を尋ねるようにした。根の範囲に収まらない子の起動の失敗（`scopeNotSubset`）は、直す場所（`config.json` の `rootScope`）と、daemon の起動し直しが要ることを言う。
- **範囲違反は「フックが拒んだ」と明示**（#6）: 範囲違反の受信箱の項目は、「フックが拒んだ」ことをはっきり言う。統合の skill は、その言葉のまま人に伝える。
- **画面の使い勝手の直し**（#13）: 確認を開くと、確認の欄まで動いてフォーカスが移る。Desktop・CLI の子の停止未完了と、根に出る Desktop の子を確かめる依頼は、赤の「失敗」でなく「停止の代行依頼」として出す。受理・回収可・アーカイブのノードに「要対応」の数を出さない。打ち込ませる ID は 1 回のクリックで選べる。接続できないときに理由と確かめることを出す。入力欄に id・name を付ける。
- **受理した子のセッションの片付け**（#3）: 受理（`node_review` の accept）した CLI の子の裏のセッションは、親への依頼（`claude stop` → `claude rm`）で片付くようになった。状態は verified のまま。依頼の出し直しは `node_stop`。
- **統合の道具 `node_integrate`**（#4）: 受理した子のブランチを親のブランチへ fast-forward だけで統合する。できなければ何も変えずに理由（`notFastForward`・`targetDirty`）を返す。
- **表示名を TouRyou にする**（#40）: README の見出し・ロゴの代替テキスト・アイコンの `<title>`・marketplace の説明・デスクトップアプリの拡張機能の表示名と説明を TouRyou にした。パッケージ・コマンド・環境変数などの識別子は touryou のまま（変更はない）。
- **marketplace.json に説明を足す**（#23。#17）: `.claude-plugin/marketplace.json` に `metadata.description` を足した（marketplace の一覧に説明が出る）。`release.yml` の `marketplace-self` の書き換えが、これを保つことを試験で守る。
- **正式なアイコンとロゴ**（#19・#38）: 仮のアイコン（`assets/icon/`）を正式なものに置き換え、README の先頭にロゴを足した。

### 内部の変更

- **hono・@hono/node-server を、弱点を直した版に上げる**（#71。#51）: MCP SDK の推移的な依存の hono を 4.13.13 から 4.13.16 に、@hono/node-server を 2.1.3 から 2.1.6 に上げた（`pnpm-workspace.yaml` の overrides）。hono の 5 件（moderate 4・low 1）と @hono/node-server の 3 件（moderate。GHSA-7v5p-43qr-wch5 を含む）が直る。@hono/node-server 2.1.6 は公開から 14 日に届かないため、利用者の許可を得て、中身を確かめたうえで `minimumReleaseAgeExclude` にこの 1 版だけを足した（14 日を過ぎたら消す）。どちらも SDK の HTTP の道筋（streamableHttp）だけが使い、TouRyou の mcp（`Server` と `StdioServerTransport`）と daemon（自前の HTTP）からは届かない。tar.gz には入るが読み込まれず、.mcpb（esbuild で 1 ファイル）には入らない。
- **daemon が使っていない MCP の SDK への依存を外す**（#60。#53）: `packages/daemon/package.json` から `@modelcontextprotocol/sdk` を外し、lockfile を作り直した（削除だけ。新しい版は入れていない）。mcp・cli は、引き続き SDK を使う。`scripts/dist-build.sh` のコメントを、SDK の解決の道筋に合わせた。
- **出す前の /setup の確かめを、フォークの rc の配布物で行う**（#58。#48・#56）: v0.1.0 の配布物は #56 の壊れたリンクで `/setup` の検査に止められ、`docs/setup-verification.md` の A が通らない。新しい A' は、フォークの試しのリリース（例 `0.1.1-rc.0`）の zip をそのまま写しにし、手元の写しだけ `install-runtime.sh` の `REPO_URL` と `plugin.json` の `repository` をフォークに書き換えて（1 か所ずつを確かめる）、S10〜S13 を通す。配る script・`plugin.json` は変えていない。`docs/release.md` の 2-a・フォークの検証の例の版（`0.1.1-rc.0`）・後始末の時期を直した。`check_links` の注を実際の動き（行き先の親が中にあれば、行き先のないリンクは通す）に合わせた。
- **新しい /setup の実機の確かめの手順**（#48）: `docs/setup-verification.md` を足した。tag の前は、手元の plugin の写しに直前の Release の `checksums.json` を置いて `claude --plugin-dir` で `/touryou:setup` を通し（S10〜S13。版上げは複製した版で模造する）、tag の後は zip の `checksums.json` を確かめてから marketplace の PR をマージし、update → `/setup` → Q8 を行う。取得先は本番のまま、script には手を入れていない。`docs/release.md` の手順に 2-a と 6 を足した。
- **Dependabot で actions の版を上げ、patch・minor を自動でマージする**（#44）: `.github/dependabot.yml` で、workflow の actions の上げを週に 1 回、patch・minor は 1 本の PR に、メジャーは actions ごとの別の PR にする（公開から 14 日たった版だけ）。`dependabot-auto-merge.yml` が、github-actions の patch・minor で `.github/workflows/` の中だけを変える PR に auto-merge を付け、必須の check が通ってからマージされる。メジャーの上げは人がレビューする。マージのあとは `dependabot-main-ci.yml` が main で `ci.yml` を起こす。リポジトリの設定の「Allow auto-merge」が要る（`docs/release.md`）。
- **Dependabot による actions の上げ**（#45・#46）: `pnpm/action-setup` 6.1.0・`actions/setup-node` 7.1.0・`actions/upload-artifact` 7.0.2（#45。patch・minor の自動マージ）と、`actions/download-artifact` 8.0.2（#46。メジャー。人がレビューしてマージ）。
- **必須の check を docs だけの PR・marketplace-self の PR でも出し、コミットのメールを確かめる**（#21。#14）: `ci.yml` は `paths-ignore` を使わず、docs などだけの変更ではジョブの中で重い段を飛ばして成功で終える。`marketplace-self` が出した PR のブランチで `ci.yml` を `workflow_dispatch` で起こす。author・committer・`Co-authored-by` のメールが noreply の形でなければ失敗する（`scripts/ci-commit-emails.sh`）。
- **Desktop の子を起動時の整合でプロセスと照合しない方針**（#24。#11）: 方針を設計書に書き、試験を足した（動きは変えていない）。
- **文書の地の文の製品名を TouRyou にそろえる**（#42）: docs・README・SECURITY・.sdd・plugin の commands と skills の地の文で、製品として読まれる touryou を TouRyou にした。コマンドを指す素の touryou はバッククォートで囲んだ。バッククォートの中・コードが出す文字列（受信箱の知らせ・フックの文）・ファイル名・URL・ADR の過去の項は変えていない。
- **使わない .gitkeep を消し、actions の版をそろえる**（#18）: `packages/core/test/.gitkeep` と `plugin/agents/.gitkeep` を消した（`plugin/agents/` は任意にした）。workflow の `actions/checkout`・`actions/setup-node`・`pnpm/action-setup` を、それぞれ v7.0.1・v7.0.0・v6.0.10 にそろえた。

### 上げ方

v0.1.0 を入れている Mac で、次のとおり（細部は `docs/setup-verification.md` の C と、`/touryou:setup` の手順〔`plugin/commands/setup.md`〕）。

1. plugin を上げる。

   ```sh
   claude plugin marketplace update touryou
   claude plugin update touryou@touryou
   ```

2. 新しいセッションで `/touryou:setup` を実行する（本体が v0.1.1 に入れ替わる）。セッションの始まりに、本体と plugin の版の違いの知らせが出ることもあるが、出なくても実行する。
3. 常駐（launchd）させているときは、`/touryou:setup` が daemon の起動し直しの同意を聞くので、「はい」と答える（「いいえ」なら何も変えずに止まる）。「はい」のあと、常駐の plist が新しい形（同梱の node で直に起こす。#64）に置き換わり、ログイン項目の出方が変わる（`run-daemon.sh` が消え、`node` の項目になる見込み。`sh`・`bash` の項目は残ることがあるが、害はない）。plist を手で直していたときは、置き換えずに止まるので、`docs/launchd.md` の「古い形からの引っ越し」に従う。
4. 上げる前から開いている統合セッションは、古い版の `touryou-mcp` のまま動き続ける。`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Reconnect がない画面なら、Claude Code を起動し直す）。そのあと `/touryou:start` で、接続を確かめる。

## 0.1.0（最初の公開）

最初の公開の版です（公開より前の開発の履歴は、このリポジトリには含めていません）。

- **統合セッション 1 対 作業セッション n の木**: 統合セッション（人が対話する根）から、子のセッションへの依頼・進捗・判断・完了の報告・受理と差し戻し・回収を、daemon（`touryou-daemon`）が木として記録し、受信箱で知らせる。
- **子は親が起動する**: touryou はセッションを起動せず、Anthropic の認証も扱わない。親のセッションが受信箱のコマンド（`claude --bg …`）を実行して子を起動し、子が `child_bind` で紐付き、`inbox_fetch` で知らせを読む。停止は `claude stop`、削除は `claude rm`（`docs/plugin.md`）。
- **Claude Code plugin**: skill `integrator`・`child`、コマンド `/touryou:setup`・`start`・`status`・`service`・`desktop`、フック、統合セッションの MCP（`touryou-mcp --stdio`。落ちない中継つき）。入れ方は `claude plugin marketplace add comcreate/touryou` → `/plugin install touryou@touryou` → `/touryou:setup`。
- **配布物**: macOS（Apple Silicon）用の Node 同梱の tar.gz を GitHub Release に付け、`/setup` が plugin の `checksums.json` の sha256 と照合してから入れる。Claude デスクトップアプリの拡張機能（`.mcpb`）も付ける。
- **常駐**: `touryou launchd init|apply|status|restart|stop|uninstall`。plist の Label の既定は `touryou.daemon`（`--org com.example` で `com.example.touryou.daemon`）。
- **安全**: daemon の身元の確かめ（トークンを送る前に毎回）、作業の範囲のフック、状態の置き場の権限・ACL の確かめ。試験用の `TOURYOU_CLI_ALLOW_UNVERIFIED` は開発のビルドだけで効き、配布物では効かない。
- 人間用コマンド `touryou`・HTML の画面・Desktop の子（実験的）。
