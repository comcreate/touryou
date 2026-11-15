# 新しい /setup の実機の確かめ

`/touryou:setup`（`plugin/scripts/install-runtime.sh`・`plugin/commands/setup.md`・`plugin/hooks/`）を、Mac（Apple Silicon）の実機で通して確かめる手順。確かめの項目は `docs/manual-verification-checklist.md` の S10〜S13・Q8。

- **A. tag の前**: 手元の clone の `plugin/` の写しに、**直前の Release** の配布物の `checksums.json` を置き、`claude --plugin-dir <写し>` で `/touryou:setup` を通す（`docs/release.md` の「リリースの手順」の 2-a）。
- **A'. tag の前（フォークの rc）**: 直前の Release が v0.1.0 のとき（#56）は、A は通らない。フォークの試しのリリース（rc）の zip を写しにし、手元の写しだけ取得先をフォークに書き換えて、同じ確かめを行う。
- **C. tag の後**: Release の zip の `checksums.json` を確かめてから marketplace の PR をマージし、前の版を入れた Mac で update する（`docs/release.md` の 6）。

決まり:

- **取得先は本番（`https://github.com/comcreate/touryou`）に固定のまま**。script には手を入れず、試しのための差し替えの道（引数・環境変数）も使わない。写しが取るのは、直前の Release の本物の tar.gz。
- 本番に pre-release を出して確かめる案は採らない（`docs/release.md` の「採用しない案」）。
- 版や sha256 の値は、この文書に書かない。その場で取った `.sha256` から使い、手順の中で確かめる。
- コマンドは、zsh（noclobber が有効）に 1 行ずつ貼れる形にしている。上書きは `>|`、変数は `${V}` の形。`gh` は使わない（curl だけで取れる。A' のフォークのアカウント名を取る 1 か所だけ例外）。

## A. tag の前

### 0. main を最新にする・作業の場所

確かめる変更が入った main で行う（#47〔bash 3.2 の全角の読み違いの直し〕が直った main で行う。直る前の main では、script が途中で止まることがある）。

```sh
cd <touryou の clone>
git switch main
git pull --ff-only
git log -1 --oneline
W="${HOME}/touryou-verify"
mkdir -p "${W}/dl"
```

確かめる: `git status` がきれい。`${W}` は作業の場所（終わったら消す）。

marketplace から touryou の plugin を入れていても、`--plugin-dir` の写しが、そのセッションの間だけ同じ名前の plugin を置き換える（公式の文書の plugins/loading）。無効にするのは任意。`/plugin` で無効にしたときは、8 の後片付けで必ず有効に戻す（戻し忘れると、ふだんのセッションで touryou が動かない）。

### 1. いまの ~/.touryou と常駐を退避する

いまの状態を記録する。

```sh
ls -ld "${HOME}/.touryou" "${HOME}/.touryou/current"
readlink "${HOME}/.touryou/current"
ls -l "${HOME}/Library/LaunchAgents/" | grep touryou
```

常駐（plist がある）なら、自分の引数を確かめる。plist の名前が `touryou.daemon.plist` なら `--org` なし、`<逆ドメイン>.touryou.daemon.plist` なら `--org <逆ドメイン>`。`PATH` の先頭が `/usr/bin:/bin:/usr/sbin:/sbin` より前に足されていれば、その部分が `--path-prefix`。

```sh
plutil -extract EnvironmentVariables.PATH raw "${HOME}/Library/LaunchAgents/touryou.daemon.plist"
```

（`--org` 付きのときは、ファイル名をその名前にする。）下の 1 行は、常駐していなければ何もしない（そのまま貼ってよい。plist がないとき、`cp` の `*touryou.daemon.plist` は zsh で `no matches found` になるため、`if` で守っている）。plist を写しておき、外す（起動の script〔`bin/run-daemon.sh`〕・`logs`・`state` は、次の `mv` で `~/.touryou` ごと退避される）。`--org` 付きのときは、`uninstall` にも同じ `--org` を付ける。

```sh
if ls "${HOME}/Library/LaunchAgents/" | grep -q 'touryou\.daemon\.plist$'; then mkdir -p "${HOME}/touryou-verify-launchd" && find "${HOME}/Library/LaunchAgents" -maxdepth 1 -name '*touryou.daemon.plist' -exec cp -fp {} "${HOME}/touryou-verify-launchd/" \; && "${HOME}/.touryou/current/bin/touryou" launchd uninstall --yes; else echo "常駐なし。飛ばします"; fi
```

`~/.touryou` を退避する。

```sh
command mv -f "${HOME}/.touryou" "${HOME}/.touryou.before-verify"
ls -ld "${HOME}/.touryou"
```

確かめる: 最後の `ls` が「No such file or directory」。`ls "${HOME}/Library/LaunchAgents/" | grep touryou` が何も出さない。`--org` 付きで常駐させていたときは、`docs/launchd.md` の手作業の手順で外す。

### 2. plugin の写しと checksums.json

> **注意（#56）**: 直前の Release が **v0.1.0** のときは、その配布物に、ビルドしたマシンを指す壊れたシンボリックリンク（`lib/node_modules/.pnpm/node_modules/@touryou/daemon`）があるため、`install-runtime.sh` の検査（外を指すシンボリックリンク）で止まり、この手順 2 の先（手順 3 の導入）へ進めない。v0.1.0 の配布物は変えられないので、**A' を使う**。v0.1.1 からの配布物は、`scripts/dist-build.sh` がこのリンクを取り除き、`scripts/dist-smoke.sh` が同じ検査を当ててから Release に付ける。

直前の Release の版を取る（`V` に入る。例: `0.1.0`）。

```sh
V="$(curl -fsSL https://api.github.com/repos/comcreate/touryou/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')"
echo "${V}"
```

直前の Release の `.sha256` を 2 つ取る（tar.gz と `.mcpb`。`scripts/make-checksums.mjs` は両方を読む）。

```sh
curl -fsSL -o "${W}/dl/touryou-${V}-darwin-arm64.tar.gz.sha256" "https://github.com/comcreate/touryou/releases/download/v${V}/touryou-${V}-darwin-arm64.tar.gz.sha256"
curl -fsSL -o "${W}/dl/touryou-mcp-${V}.mcpb.sha256" "https://github.com/comcreate/touryou/releases/download/v${V}/touryou-mcp-${V}.mcpb.sha256"
cat "${W}/dl/"*.sha256
```

plugin の写しを作り、`checksums.json` を作って置き、写しの `plugin.json` の版を直前の Release の版にそろえる（script は、両方の版が同じことを確かめる）。

```sh
rm -rf "${W}/plugin"
command cp -R plugin "${W}/plugin"
node scripts/make-checksums.mjs "${W}/dl" "${V}" "${W}/plugin/checksums.json"
node -e 'const f=process.argv[1];const fs=require("fs");const j=JSON.parse(fs.readFileSync(f,"utf8"));j.version=process.argv[2];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "${W}/plugin/.claude-plugin/plugin.json" "${V}"
```

作った `checksums.json` が、直前の Release の zip の中のものと同じことを確かめる（値を手で書き写さない）。

```sh
curl -fsSL -o "${W}/dl/touryou-${V}.zip" "https://github.com/comcreate/touryou/releases/download/v${V}/touryou-${V}.zip"
unzip -p "${W}/dl/touryou-${V}.zip" checksums.json | diff - "${W}/plugin/checksums.json" && echo same
grep '"version"' "${W}/plugin/.claude-plugin/plugin.json" "${W}/plugin/checksums.json"
ls "${W}/plugin/scripts/"
```

確かめる: `same` が出る。2 つの `"version"` が `${V}`。`scripts/` に `install-runtime.sh` と `runtime-version-notice.sh` がある（直前の Release の zip には、まだ入っていないことがある。写しは手元の main のもの）。

### 3. S10・S11 初めての導入

写しを plugin にしてセッションを開く（`--plugin-dir` の plugin は、その場所から読まれる）。

```sh
claude --plugin-dir "${W}/plugin"
```

セッションの中で `/touryou:setup` を最後まで（手順 3 で「常駐」を選び、同意に「はい」）。

設定の問い（`repoRoot`・`worktreeRoot`）には、絶対パスを答える。`$HOME/...` と答えると、`setup.md` の決まり（入力のパスに `$` を含むと止まる）で止まる。先にターミナルで出した値を入れる。

```sh
echo "${HOME}/touryou-verify/worktrees"
```

作業ツリーの置き場を `${W}`（`~/touryou-verify`）の下にすると、8 の後片付けの `rm -rf "${W}"` でいっしょに消える。

確かめる:

- **S10**: 承認の確認の回数（約 3 回: 導入・設定・常駐の登録）。導入の承認の画面のコマンドが `env -u BASH_ENV -u ENV bash "<写しの場所>/scripts/install-runtime.sh"`（引数なし）。取得先が `https://github.com/comcreate/touryou/releases/download/v<版>/…`（script の出力）。
- **S11**: セッションを出てから、

```sh
ls -l@ "${HOME}/.touryou/work"
ls -lR@ "${HOME}/.touryou/current/" | grep -c com.apple.quarantine
readlink "${HOME}/.touryou/current"
```

  quarantine が 0。`current` が `…/v${V}/touryou-darwin-arm64`。

### 4. S13 同じ版

もう一度 `claude --plugin-dir "${W}/plugin"` で開き、`/touryou:setup`。

確かめる: 取得せずに `RESULT: already`。SessionStart の版の知らせが出ない（版が同じ）。

### 5. S12 の準備: 版の違いを模造する

本物のバイナリ・script は直さない。入れた版を `v0.0.0-verify` の名前で複製し、`current` と常駐をそちらに向けて、「古い版が常駐している」状態を作る。セッションは閉じておく。

```sh
"${HOME}/.touryou/current/bin/touryou" launchd stop
command cp -Rp "${HOME}/.touryou/v${V}" "${HOME}/.touryou/v0.0.0-verify"
ln -sfn "${HOME}/.touryou/v0.0.0-verify/touryou-darwin-arm64" "${HOME}/.touryou/current"
readlink "${HOME}/.touryou/current"
"${HOME}/.touryou/current/bin/touryou" launchd init
"${HOME}/.touryou/current/bin/touryou" launchd apply --yes
"${HOME}/.touryou/current/bin/touryou" launchd status
```

確かめる: `current` が `…/v0.0.0-verify/touryou-darwin-arm64`。status が running。

### 6. S12 版上げ（常駐あり）

```sh
claude --plugin-dir "${W}/plugin"
```

確かめる:

- セッションの始まりに、版の違いの知らせ（本体 v0.0.0-verify と plugin v`${V}`）が、画面に `SessionStart:startup says: touryou の本体（v0.0.0-verify）と plugin（v<版>）の版が違います。…` の形で出る（SessionStart の systemMessage。v0.1.1 の前の A' で確かめた）。出なければ、出なかったことと、`/touryou:setup` の中で Claude が知らせを読んでいるか（additionalContext）を記録する。
- `/touryou:setup` で、script が終了コード 3（`RESULT: need-restart-consent`）で何も変えずに止まり、定型文で起動し直しの同意を聞かれる。
- 「はい」のあと、`--restart-daemon` 付きで、止める → 付け替え → `apply --yes`。承認は 2 回（引数なしと `--restart-daemon`）。取得済みの tar.gz は照合だけで取り直さない（`~/.touryou/work` に残っているため）。
- `/touryou:service status` が running。セッションを出てから、

```sh
readlink "${HOME}/.touryou/current"
"${HOME}/.touryou/current/bin/touryou" launchd status
```

  `current` が `…/v${V}/touryou-darwin-arm64` に戻っている。

### 7. 任意: 常駐なしの版上げ

常駐を外し、5 と同じに古い版を模造してから `/touryou:setup`。

```sh
"${HOME}/.touryou/current/bin/touryou" launchd uninstall --yes
ln -sfn "${HOME}/.touryou/v0.0.0-verify/touryou-darwin-arm64" "${HOME}/.touryou/current"
claude --plugin-dir "${W}/plugin"
```

確かめる: 同意を聞かれずに（終了コード 3 にならずに）、`current` が `v${V}` に付け替わる。

### 8. 後片付け

**2〜7 のどこで失敗・中断しても、ここを上から通せば元に戻る**（試しのものは消し、1 で退避したものを戻すだけ）。最初の `uninstall` は、試しの常駐がない・`~/.touryou` がないなどで失敗してもよい。失敗しても、次の行に進む。

試しの `~/.touryou` と常駐を外し、1 で退避したものを戻す。

```sh
"${HOME}/.touryou/current/bin/touryou" launchd uninstall --yes
rm -rf "${HOME}/.touryou"
command mv -f "${HOME}/.touryou.before-verify" "${HOME}/.touryou"
readlink "${HOME}/.touryou/current"
```

1 で常駐だったときは、1 で確かめた引数と同じ引数で init し直して、戻す（`--org` を付けていたら、`init`・`apply`・`status` の全部に同じものを付ける。`--path-prefix` は `init` にだけ付ける〔`PATH` は `init` が plist に書く。`apply`・`status` は受けず、付けると失敗する〕。付けないと元の常駐にならない）。

```sh
"${HOME}/.touryou/current/bin/touryou" launchd init
"${HOME}/.touryou/current/bin/touryou" launchd apply --yes
"${HOME}/.touryou/current/bin/touryou" launchd status
```

作業の場所を消す。0 で marketplace の touryou を無効にしていたら、`/plugin` で有効に戻す。

```sh
rm -rf "${W}"
```

確かめる: `current` が 1 で記録したものと同じ。常駐だったときは `"${HOME}/Library/LaunchAgents/"` の plist と `"${HOME}/touryou-verify-launchd/"` の写しを `diff` で比べ、同じなら写しを消す（`rm -rf "${HOME}/touryou-verify-launchd"`）。常駐だったときは status が running。結果（S10〜S13 の可・不可と、出た表示）を、リリースの準備の PR か Issue に書く。

## A'. tag の前（フォークの rc で行う）

直前の Release が v0.1.0 のとき（#56 のため A が手順 3 で止まる）は、こちらで行う。フォークで試しのリリース（rc。例: `0.1.1-rc.0`。rc の番号は出し直しで増える）を作り、その Release の zip をそのまま写しにして `/touryou:setup` を通す。

- **前提**: フォークの試しのリリース（`v<rc の版>`）が、`docs/release.md` の「本番の前の検証（フォークで行う）」の手順で通っていること（Release に asset が 6 ファイルある）。
- **手元の写しだけ**、取得先をフォークに書き換える（`scripts/install-runtime.sh` の `REPO_URL` の 1 行と、`.claude-plugin/plugin.json` の `repository`）。script は取得先を本番に固定し、`plugin.json` の `repository` も照合するため。リポジトリの script・`plugin.json` は変えない（守りを緩めない。試しの抜け道を本番の道筋に作らない）。
- 手元の main の `plugin/` ではなく、フォークの Release の zip を使う: `release.yml` が作ったもの（zip の中の `checksums.json`・script・`plugin.json` の版）そのものを確かめるため。書き換えるのは上の 2 か所だけ。
- フォークのアカウント名は、文書に書かない（`gh api user` で変数 `ACCT` に入れる）。`gh` はアカウント名を取る 1 か所だけで使い、ほかは curl で取る（フォークは公開なので、curl で取れる）。
- `mv`・`cp` は `command mv`・`command cp` の形にしている（zsh の `mv -i` などの alias で、上書きのたびに聞かれないように）。
- コマンドは zsh（noclobber）に 1 行ずつ貼れる形。上書きは `>|`、変数は `${V}` の形、`!` は使わない。変数が空のときは `STOP` を出して何もしない。

### 0'. main を最新にする・作業の場所

A の 0 と同じに、main を最新にする。`gh auth status` で、フォークの持ち主のアカウントとして入っていることを確かめる（違えば `gh auth switch` で切り替える）。そのうえで、作業の場所・フォークのアカウント名・rc の版を変数に入れる。

```sh
W="${HOME}/touryou-verify"
mkdir -p "${W}/dl"
ACCT="$(gh api user --jq .login)"
R=0.1.1-rc.0
echo "${ACCT} ${R} ${W}"
```

確かめる: 3 つとも空でない。`ACCT` がフォークの持ち主。`R` は、フォークに push した tag（`v${R}`）の版。

### 1'. いまの ~/.touryou と常駐を退避する

A の 1 と同じ（常駐の有無・`--org`・`--path-prefix` の扱いも同じ）。

### 2'. 写し: フォークの Release の zip

フォークの Release の zip と、tar.gz・`.mcpb` の `.sha256` を取る。

```sh
if [ -n "${W}" ] && [ -n "${ACCT}" ] && [ -n "${R}" ]; then for f in "touryou-${R}.zip" "touryou-${R}-darwin-arm64.tar.gz.sha256" "touryou-mcp-${R}.mcpb.sha256"; do curl -fsSL -o "${W}/dl/${f}" "https://github.com/${ACCT}/touryou/releases/download/v${R}/${f}" || echo "STOP: ${f}"; done; else echo STOP; fi
ls -l "${W}/dl/"
```

zip を展開して写しにする（`checksums.json` は zip の中のもの〔`release.yml` が作った本物〕をそのまま使う。作り直さない）。

```sh
if [ -n "${W}" ] && [ -n "${R}" ] && [ -s "${W}/dl/touryou-${R}.zip" ]; then rm -rf "${W:?}/plugin" && mkdir -p "${W}/plugin" && unzip -q "${W}/dl/touryou-${R}.zip" -d "${W}/plugin"; else echo STOP; fi
ls -A "${W}/plugin" "${W}/plugin/scripts"
```

zip の中の `checksums.json` の sha が、フォークの Release の `.sha256` と同じことを確かめる（値を手で書き写さない）。

```sh
grep '"version"' "${W}/plugin/.claude-plugin/plugin.json" "${W}/plugin/checksums.json"
cat "${W}/dl/touryou-${R}-darwin-arm64.tar.gz.sha256" "${W}/dl/touryou-mcp-${R}.mcpb.sha256"
for f in "${W}/dl/"*.sha256; do s="$(awk '{print $1}' "${f}")"; if [ -n "${s}" ] && grep -q "\"${s}\"" "${W}/plugin/checksums.json"; then echo "same: ${f##*/}"; else echo "DIFF: ${f##*/}"; fi; done
```

確かめる: 2 つの `"version"` が `${R}`。`same:` が 2 行（tar.gz と `.mcpb`）で、`DIFF:` が出ない。`scripts/` に `install-runtime.sh` と `runtime-version-notice.sh` がある。

写しの 2 か所を、フォークの URL に書き換える。書き換える前の 1 行を表示し、`sed` で別のファイルに書き出してから、変わった行が 1 か所だけであることを確かめて置き換える（macOS の `sed -i` は GNU と違うので使わない）。

```sh
grep -n '^REPO_URL=' "${W}/plugin/scripts/install-runtime.sh"
grep -n '"repository"' "${W}/plugin/.claude-plugin/plugin.json"
if [ -n "${W}" ] && [ -n "${ACCT}" ]; then sed "s|^REPO_URL=\"https://github.com/comcreate/touryou\"\$|REPO_URL=\"https://github.com/${ACCT}/touryou\"|" "${W}/plugin/scripts/install-runtime.sh" >| "${W}/install-runtime.sh.new" && sed "s|\"repository\": \"https://github.com/comcreate/touryou\"|\"repository\": \"https://github.com/${ACCT}/touryou\"|" "${W}/plugin/.claude-plugin/plugin.json" >| "${W}/plugin.json.new"; else echo STOP; fi
diff "${W}/plugin/scripts/install-runtime.sh" "${W}/install-runtime.sh.new" | grep -c '^[<>]'
diff "${W}/plugin/.claude-plugin/plugin.json" "${W}/plugin.json.new" | grep -c '^[<>]'
```

確かめる: 2 つの `grep -c` が、どちらも `2`（消える 1 行と足す 1 行）。`0` なら書き換わっていない（元の行が違う。止める）。`2` のときだけ、置き換えて、後の 1 行を表示する。

```sh
if [ -s "${W}/install-runtime.sh.new" ] && [ -s "${W}/plugin.json.new" ]; then cat "${W}/install-runtime.sh.new" >| "${W}/plugin/scripts/install-runtime.sh" && cat "${W}/plugin.json.new" >| "${W}/plugin/.claude-plugin/plugin.json" && rm -f "${W:?}/install-runtime.sh.new" "${W:?}/plugin.json.new"; else echo STOP; fi
grep -n '^REPO_URL=' "${W}/plugin/scripts/install-runtime.sh"
grep -n '"repository"' "${W}/plugin/.claude-plugin/plugin.json"
grep -rn 'comcreate/touryou' "${W}/plugin/scripts" "${W}/plugin/.claude-plugin"
```

確かめる: `REPO_URL` と `repository` が `https://github.com/${ACCT}/touryou`。最後の `grep` が何も出さない（`cat >|` で置き換えるので、ファイルの実行の権限は zip のまま）。

### 3'〜8'. A の 3〜8 と同じ

A の 3〜8（S10・S11・S13・S12 の模造・後片付け）を、`V` を `${R}` にして行う（`V="${R}"` としてから、A のコマンドをそのまま貼ってよい）。違う所だけ:

- **3（S10）**: 取得先は `https://github.com/${ACCT}/touryou/releases/download/v${R}/…`（script の出力）。本番（`comcreate`）を指していたら、2' の書き換えが効いていない。止めて A の 8（=8'）に進む。
- **3（S11）**: `current` が `…/v${R}/touryou-darwin-arm64`。
- **6（S12）**: 版の違いの知らせは、本体 v0.0.0-verify と plugin v`${R}`。
- **8（後片付け）**: A の 8 と同じ。`rm -rf "${W}"` で、書き換えた写しも消える（リポジトリの `plugin/` は変えていない。`git status` がきれいなことを確かめる）。フォークの Release・tag・枝は、A' が済んでから消す（`docs/release.md` の「本番の前の検証」の後始末）。

結果は、A と同じに、リリースの準備の PR か Issue に書く（rc の版でフォークの Release を使ったこと、を添える）。

## C. tag の後

### マージの前: Release の zip の checksums.json

tag の push のあと、`release.yml` が Release を作る。marketplace の PR（`marketplace-self`）をマージする前に、zip の中の `checksums.json` を確かめる。`V` は新しい版（plugin.json の `version`）。

```sh
V=<新しい版>
d="$(mktemp -d)" && cd "${d}"
curl -fsSL -O "https://github.com/comcreate/touryou/releases/download/v${V}/touryou-${V}.zip"
curl -fsSL -O "https://github.com/comcreate/touryou/releases/download/v${V}/touryou-${V}-darwin-arm64.tar.gz.sha256"
unzip -p "touryou-${V}.zip" checksums.json
cat "touryou-${V}-darwin-arm64.tar.gz.sha256"
unzip -l "touryou-${V}.zip" | grep scripts/
```

確かめる: `checksums.json` の `version` が `${V}`、`darwin-arm64` の `sha256` が `.sha256` の値と同じ。zip に `scripts/install-runtime.sh` と `scripts/runtime-version-notice.sh` がある。違えば、マージしない（`docs/release.md` の「やり直す」）。

### マージの後: update → /setup → Q8

前の版を入れて常駐させている Mac で行う。

```sh
claude plugin marketplace update touryou
claude plugin update touryou@touryou
```

確かめる:

- **Q8**: update の直後、`/reload-plugins` をせずに統合セッションを開き（または続け）、`/touryou:start`。node の MCP が動く。動かなければ、表示を記録する。
- **S12**: 新しいセッションで、版の違いの知らせが出る（出なければ記録する）。`/touryou:setup` で、同意のあと `--restart-daemon` で起動し直し、`/touryou:service status` が新しい版で running。
- **S13**: もう一度 `/touryou:setup` で `RESULT: already`。

不具合が出たら、版を上げて直す（Release は付け直さない。`docs/release.md` の「版の決まり」と「やり直す」）。
