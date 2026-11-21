# キーワード検索の結果: stall|lastActivity|deliveredAt|cliWatch
docs/cli.md:47:- **`touryou launchd`（#165）**: `--config <絶対パス>`（実パスにそろえて名前を決める）と `--others`（`init`・`apply`・`status`・`restart`・`stop`・`uninstall`。`--org` を付ければ、その組織の Label
docs/cli.md:152:- 読み込むと、システム設定の「一般」→「ログイン項目と機能拡張」→「バックグラウンドでの実行を許可」に、**TouRyou**（1 項目）が出る。「開発元を識別できない項目」と出るのは、TouRyou に同梱した node を TouRyou の名前で手元の署名（ad-hoc）にしたためで、正常（appl
docs/cli.md:155:## 常駐の操作 `touryou launchd apply|status|restart|stop|uninstall`
docs/cli.md:165:| `uninstall --yes` | 止めてから、TouRyou が生成したと判定できる plist（LaunchAgents と `.touryou/launchd`）・古い形の起動スクリプト（`.touryou/bin/run-daemon.sh`）だけを消す。判定できないものは残して終了コード 
docs/cli.md:167:- `apply`・`uninstall` は、**`--yes` がないと何もしない**（終了コード 2）。永続化・削除なので、利用者の同意を取ってから付ける（`/setup`・`/touryou:service` が定型文で聞く）。
docs/cli.md:169:- `uninstall` は、`init` が作るのと同じ内容（`--path-prefix` の違いを含む。PATH の値はファイルから取って作り直して比べる）とバイト単位で同じもの（LaunchAgents の plist は `.touryou/launchd` の plist と同じもの）だけを消
docs/cli.md:171:- **複数の daemon（設定ごと。#165）**: `init`・`apply`・`status`・`restart`・`stop`・`uninstall` は、`--config <絶対パス>` で、その設定の daemon を対象にする（省略は `$HOME/.touryou/config.jso
docs/config.md:9:- 前提: `git`（Xcode の Command Line Tools）が要ります（daemon が、子の作業ツリーを `git worktree` で作るため。Xcode か Command Line Tools のどちらかがあればよい）。入っていなければ、Terminal で `xcode-se
docs/config.md:46:| `cliWatch` | `{ "stallMinutes": 30, "unreadMinutes": 30, "unboundMinutes": 3, "intervalSec": 60 }` | CLI の子の見張り。`unboundMinutes` 分、親の起動の報告（done）のあとも紐付
docs/dist-manual-verification.md:6:- 配布物の中身（tar の一覧・特殊なファイル・シンボリックリンクが展開先の外や行き先のない所を指さないこと）は、CI の `scripts/dist-smoke.sh` が、利用者の `/setup` と同じ検査（`scripts/dist-check.sh`。`i
docs/launchd.md:5:- **plist は、`touryou launchd init` が生成します**（起動スクリプトは作りません。plist から、同梱の node で daemon を直に起こします。#64）。読み込み・止める・外すは、`touryou launchd apply|status|restart|st
docs/launchd.md:33:- **Label**: `--org` を省略すると、組織のドメインを含まない **`touryou.daemon`**（決定）。自分のドメインにしたいときは `--org com.example` のように付けると **`com.example.touryou.daemon`** になる（小文字の
docs/launchd.md:41:- **古い形からの引っ越し**: v0.1.0 までの `init` は、`bin/run-daemon.sh`（`#!/bin/sh`）を作り、plist はそれを起こしていました。新しい `init` は、`launchd/<Label>.plist` と `bin/run-daemon.sh`
docs/launchd.md:72:| 外す | `touryou launchd uninstall --yes` | 止めてから、TouRyou が生成したと判定できる plist（古い形の `run-daemon.sh` も）だけを消す（`logs`・`state` は残す） |
docs/launchd.md:74:- `apply`・`uninstall` は、`--yes` がないと何もしない（永続化・削除なので、利用者の同意を取ってから付ける。`/setup`・`/touryou:service` は定型文で聞く）。
docs/launchd.md:75:- 読み込むと、システム設定の「一般」→「ログイン項目と機能拡張」→「バックグラウンドでの実行を許可」に、**TouRyou**（1 項目）が出ます（#73）。「開発元を識別できない項目」と出るのは、TouRyou に同梱した node を TouRyou の名前で手元の署名（ad-hoc）にしたため
docs/launchd.md:88:**止める → `/setup` → 起動し直す**の順です（`/setup` の「版を上げる」が、この順で案内します）。`/setup` の `--restart-daemon` の道は、古い版の `launchd init`（生成物が同じかの確かめ。別名の daemon があれば `init --
docs/launchd.md:99:- `init`・`apply`・`status`・`restart`・`stop`・`uninstall` は、`--config <絶対パス>` を受け取ります（絶対パスでなければ終了コード 2）。名前は、既定の設定なら `daemon`、それ以外は **`daemon-<設定パスの sha256
docs/launchd.md:102:- **`--others`**: 別名の plist（`[<org>.]touryou.daemon-<8 文字>.plist`）すべてを対象にします（`init`・`apply`・`status`・`restart`・`stop`・`uninstall`。対象の集合は下の 3 つ目の項目）。pl
docs/launchd.md:105:  - `apply`・`status`・`restart`・`stop` は、`<H>/Library/LaunchAgents` に置いた（`apply --config` で常駐にした）ものだけを対象にします。`init` しただけの plist を、`--others` で常駐にしません。`
docs/launchd.md:106:  - 版上げ（`/setup` の `--restart-daemon`。`plugin/scripts/install-runtime.sh`）は、`<H>/Library/LaunchAgents` に別名の plist があるとき（`--others` の対象と同じ場所）に、既定の daem
docs/launchd.md:108:- 古い形の起動スクリプト `bin/run-daemon.sh` は、既定の daemon の `apply`・`uninstall` だけが消します（別名の daemon は、既定と共有するこのファイルに触りません）。
docs/launchd.md:110:- `uninstall` で、`<H>/Library/LaunchAgents` にほかの daemon の plist が残っているときは、TouRyou.app の LaunchServices の登録（`lsregister -u`）を解きません（残った daemon のログイン項目を保つ
docs/launchd.md:123:- 設定のパスを変えると、別の daemon になる（古い名前の plist は、`uninstall --others` で外す）。
docs/launchd.md:138:| `git` が見つからない | plist の `PATH` に、`git` の場所がない | `uninstall --yes` → `init --path-prefix …` → `apply --yes` |
docs/launchd.md:139:| 子の作成・回収が、git の失敗で止まる（ログに「git（Xcode Command Line Tools）が使えません」、または Xcode のライセンスの文面） | Command Line Tools がない（仮の git）、または Xcode のライセンスに未同意 | `xcode-se
docs/manual-verification-checklist.md:57:| Q6 | `/touryou:service uninstall-all` | 常駐にした状態で実行し、定型文に「はい」。出たターミナルのブロックを `/exit` のあとに貼る | 常駐が外れ、`pgrep -fl '\.touryou/'` が何も出
docs/manual-verification-checklist.md:74:| S7 | 外す | `/touryou:service uninstall`（同意に「はい」） | plist（LaunchAgents と `<H>/.touryou/launchd`）と `<H>/.touryou/bin` の起動スクリプトが消え、
docs/manual-verification-checklist.md:76:| S10 | 導入の script の承認の回数 | tag の前は `docs/setup-verification.md` の写しで行う。`$HOME/.touryou` がない状態で `/touryou:setup` を最後まで（3-A）。承認の確認
docs/manual-verification-checklist.md:239:  6. `/touryou:service` の uninstall のあと、3 を見て、`sudo sfltool dumpbtm >| "${HOME}/btm-uninstalled.txt"; grep -i -c -E 'touryou|run
docs/manual-verification-checklist.md:241:- **後始末**: `rm -f "${HOME}/btm-before.txt" "${HOME}/btm-after.txt" "${HOME}/btm-uninstalled.txt"`（ユーザー名の入ったパスなどが入っているので、残さない）
docs/manual-verification-checklist.md:281:- **作り物のデータで見るとき**: 本物の記録がなくても、`pnpm install && pnpm build` のあと `node scripts/ui-preview.mjs`（流れる線と彗星も見るなら `--live`）で、一時の場所と空いたポ
docs/plugin.md:13:| コマンド | `setup` | 配布物（macOS の arm64）を、plugin の中の script（`scripts/install-runtime.sh`。1 回の承認）で、GitHub Release から `curl`（認証なし）で取得し、sha256 が一致したときだけ、`$HOM
docs/plugin.md:15:| コマンド | `service` | 常駐（launchd）の daemon の確認・起動し直し・止める・外す（`status`・`restart`・`stop`・`uninstall`。`touryou launchd` のサブコマンドを呼ぶ。止める・外すは定型文で同意を取ってから）。常駐にするの
docs/plugin.md:16:| コマンド | `desktop` | Claude デスクトップアプリの拡張機能（`touryou-mcp-<版>.mcpb`）を、Release から curl（認証なし）で取り、`checksums.json` の `extensions.mcpb` と照合し、quarantine を確かめてか
docs/plugin.md:19:  - Claude Code は、ツールを `mcp__plugin_touryou_node__*` の名前で出す（`--plugin-dir` と marketplace から入れた場合の両方。確かめ方は `node scripts/plugin-mcp-name-check.mjs [--ins
docs/plugin.md:29:/plugin install touryou@touryou
docs/plugin.md:34:2. **plugin を入れる**: `/plugin install touryou@touryou`。plugin は、Claude Code の設定の場所（`CLAUDE_CONFIG_DIR`。既定は `$HOME/.claude`）ごとに入る。分けているときは、同じ値で install・up
docs/plugin.md:35:3. **本体を入れる**: `/touryou:setup`。plugin の中の `scripts/install-runtime.sh` が、配布物を GitHub Release から取り、plugin に入っている sha256 と照合してから `$HOME/.touryou` に展開する（照
docs/plugin.md:43:**導入の script（`plugin/scripts/install-runtime.sh`）**: `/setup` は、取得・照合・quarantine の確かめ・`tar -t` の検査・展開・外を指すシンボリックリンクの検査・`--help` の確かめ・`current` の付け替えを、この
docs/plugin.md:52:前提: `git`（Xcode の Command Line Tools）が要ります（daemon が、子の作業ツリーを `git worktree` で作るため。Xcode か Command Line Tools のどちらかがあればよい）。入っていなければ、Terminal で `xcode-sel
docs/plugin.md:86:- **CLI の子と plugin**: `--plugin-dir` で開いたのは、そのセッションだけ。`--plugin-dir` だけで開いた親の子（`claude --bg`）には plugin が付かず、子は `child_bind` を見つけられないまま止まり、TouRyou のフック（守
docs/plugin.md:87:- **紐付けが外れた子は、`child_bind` を引数なしで呼べば、親に知らせられる**（#186）: 紐付けの前（`/mcp` の再接続・`claude attach`・daemon の再起動・トークンの期限切れのあと）の子が使えるのは `child_bind`（`mcp__plugin_tou
docs/release.md:7:/plugin install touryou@touryou
docs/release.md:61:   同じ実行で、macOS（**arm64 のみ**）の配布物（Node 同梱の `touryou-<版>-darwin-arm64.tar.gz` と `.sha256`）を作り、展開して daemon が起動する確認（smoke。`scripts/dist-smoke.sh`）を通したものだけを
docs/release.md:114:- `/setup`: 導入の script（`plugin/scripts/install-runtime.sh`）と `shasum`・`chmod`・`tar` は、macOS・POSIX 前提。PowerShell などへの置き換え
docs/release.md:261:tar.gz は、ビルドし直すと sha256 が変わり得ます。zip の中の `checksums.json` も連動して変わるので、**同じタグで Release の asset だけを付け直すと、marketplace.json の sha256 と食い違い、install が失敗します**。
docs/setup-verification.md:3:`/touryou:setup`（`plugin/scripts/install-runtime.sh`・`plugin/commands/setup.md`・`plugin/hooks/`）を、Mac（Apple Silicon）の実機で通して確かめる手順。確かめの項目は `do
docs/setup-verification.md:52:（`--org` 付きのときは、ファイル名をその名前にする。）下の 1 行は、常駐していなければ何もしない（そのまま貼ってよい。plist がないとき、`cp` の `*touryou.daemon.plist` は zsh で `no matches found` になるため、
docs/setup-verification.md:55:if ls "${HOME}/Library/LaunchAgents/" | grep -q 'touryou\.daemon\.plist$'; then mkdir -p "${HOME}/touryou-verify-launchd" && find "${HOME}/L
docs/setup-verification.md:69:> **注意（#56）**: 直前の Release が **v0.1.0** のときは、その配布物に、ビルドしたマシンを指す壊れたシンボリックリンク（`lib/node_modules/.pnpm/node_modules/@touryou/daemon`）があるため、`ins
docs/setup-verification.md:104:確かめる: `same` が出る。2 つの `"version"` が `${V}`。`scripts/` に `install-runtime.sh` と `runtime-version-notice.sh` がある（直前の Release の zip には、まだ入っていな
docs/setup-verification.md:126:- **S10**: 承認の確認の回数（約 3 回: 導入・設定・常駐の登録）。導入の承認の画面のコマンドが `env -u BASH_ENV -u ENV bash "<写しの場所>/scripts/install-runtime.sh"`（引数なし）。取得先が `https
docs/setup-verification.md:184:"${HOME}/.touryou/current/bin/touryou" launchd uninstall --yes
docs/setup-verification.md:195:試しの `~/.touryou` と常駐を外し、1 で退避したものを戻す。下の 1 行は、1 で退避した `~/.touryou.before-verify` があるときだけ、外す・消す・戻すを行う。ないときは「退避がない（もう戻っているかもしれない）。止めます」と出して、何も
docs/setup-verification.md:198:if [ -d "${HOME}/.touryou.before-verify" ]; then "${HOME}/.touryou/current/bin/touryou" launchd uninstall --yes; rm -rf "${HOME}/.touryou" 
docs/setup-verification.md:207:"${HOME}/.touryou/current/bin/touryou" launchd uninstall --yes
docs/setup-verification.md:238:- **手元の写しだけ**、取得先をフォークに書き換える（`scripts/install-runtime.sh` の `REPO_URL` の 1 行と、`.claude-plugin/plugin.json` の `repository`）。script は取得先を本番に固
docs/setup-verification.md:286:確かめる: 2 つの `"version"` が `${R}`。`same:` が 2 行（tar.gz と `.mcpb`）で、`DIFF:` が出ない。`scripts/` に `install-runtime.sh` と `runtime-version-notice.s
docs/setup-verification.md:291:grep -n '^REPO_URL=' "${W}/plugin/scripts/install-runtime.sh"
docs/setup-verification.md:293:if [ -n "${W}" ] && [ -n "${ACCT}" ]; then sed "s|^REPO_URL=\"https://github.com/comcreate/touryou\"\$|REPO_URL=\"https://github.com/${ACCT
docs/setup-verification.md:294:diff "${W}/plugin/scripts/install-runtime.sh" "${W}/install-runtime.sh.new" | grep -c '^[<>]'
docs/setup-verification.md:301:if [ -s "${W}/install-runtime.sh.new" ] && [ -s "${W}/plugin.json.new" ]; then cat "${W}/install-runtime.sh.new" >| "${W}/plugin/scripts/in
docs/setup-verification.md:302:grep -n '^REPO_URL=' "${W}/plugin/scripts/install-runtime.sh"
docs/setup-verification.md:355:確かめる: `checksums.json` の `version` が `${V}`、`darwin-arm64` の `sha256` が `.sha256` の値と同じ。zip に `scripts/install-runtime.sh` と `scripts/runti
docs/setup-verification.md:378:grep -n '^REPO_URL=' "${W}/plugin/scripts/install-runtime.sh"
docs/ui.md:56:- #89 で足した値（画面の「やり取り」「作業ごとのようす」・関係図が使う）: ノードの `title`（目的の改行・タブ・続く空白を空白 1 つにまとめて 1 行にし、先頭を `UI_TITLE_MAX`＝80 コードポイントで整えて切る）・`lastActivityAt`（報告・受信箱・指示と受け取り・判
docs/ui.md:145:- **いまあなたがすること**: 人の操作が要るものの数（大きな数字）と一覧。判断の頼み（選択肢のボタン・自由入力）、範囲を広げる頼み（承認・却下・切り出し。押すとどうなるかの説明つき）、**daemon が止まっているかもしれないと知らせた子**（受信箱の `stall` があるときだけ。時刻の経過などか
docs/ui.md:157:- 表示モデルの値（`title`・`lastActivityAt`・`needsHuman`・`band`・`flows` など）は、上の「表示モデル」のとおり、画面が使っている。
docs/ui.md:168:  - **CI**：`ci.yml` の **ubuntu・node 22 のジョブ 1 つだけ**で流す。版を固定した Playwright（いまは `1.64.1`。公開から 14 日以上）を、`npm install --prefix "${RUNNER_TEMP}/playwright" --ign
docs/ui.md:171:  - **Playwright の版上げ**：`ci.yml` の版を、公開から 14 日以上たった版に上げる（ライセンスは Apache-2.0 のままかを確かめる）。`npm install` は lockfile も完全性の値（integrity）も見ないので、`playwright` が固定する `
docs/ui.md:237:`pnpm install && pnpm build` のあと、`node scripts/ui-preview.mjs` で、`packages/daemon/dist` の本物の API サーバーを、一時の stateDir と 127.0.0.1 の空いたポートで立て、作り物の記録（統合 1・子 5・
packages/cli/src/bin.ts:192:    // 常駐の操作。launchctl を実行する。apply・uninstall は --yes が必須
packages/cli/src/commands.ts:133:  touryou launchd apply --yes | status | restart | stop | uninstall --yes  [--org …] [--config <絶対パス> | --others]
packages/cli/src/commands.ts:134:      launchd の常駐の操作（launchctl を実行する。apply・uninstall は、利用者の同意を取ってから --yes）。
packages/cli/src/launchd-service.ts:2: * `touryou launchd apply|status|restart|stop|uninstall`。`touryou launchd init` が生成した plist・起動スクリプトを使い、
packages/cli/src/launchd-service.ts:6: * - 永続化（apply）と削除（uninstall）は、`--yes` がないと何もしない（利用者の同意を取ったことの明示。/setup・/service の定型文で聞く）。
packages/cli/src/launchd-service.ts:77:export const SERVICE_SUBCOMMANDS = ["apply", "status", "restart", "stop", "uninstall"] as const;
packages/cli/src/launchd-service.ts:133:  /** daemon の設定ファイルと、その stateDir（daemon ごとに別）。stateDir は、設定を読めないとき undefined（uninstall だけが、この unit を扱う）。 */
packages/cli/src/launchd-service.ts:139:  /** 古い形（v0.1.0 まで）の起動スクリプト。いまは生成しない。古い形と同じなら、uninstall で消す。 */
packages/cli/src/launchd-service.ts:477:        `${u.plistDest} が、生成した plist と違う（または通常のファイルでない）。何も変えずに止めた。中身を確かめ、要らなければ "$HOME/.touryou/current/bin/touryou" launchd unins
packages/cli/src/launchd-service.ts:630:    `plist は LaunchAgents に残っているので、次のログインで、また動く。すぐ動かすなら ${cmd(ctx, "apply", " --yes")}。常駐をやめるなら ${cmd(ctx, "uninstall", " --yes")}
packages/cli/src/launchd-service.ts:649:function uninstall(ctx: Ctx): CommandResult {
packages/cli/src/launchd-service.ts:719:      `LaunchAgents に daemon の plist が残っているので、TouRyou.app の LaunchServices の登録は解かなかった（残っているもの: ${remaining.join("・")}）。全部外すなら、残りの 
packages/cli/src/launchd-service.ts:757:    } else if (a === "--yes" && (sub === "apply" || sub === "uninstall")) {
packages/cli/src/launchd-service.ts:765:  if ((sub === "apply" || sub === "uninstall") && !yes) {
packages/cli/src/launchd-service.ts:769:        : '"$HOME/.touryou/current/bin/touryou" launchd uninstall は、常駐を止めて生成物を消す。利用者の同意を取ってから --yes を付けて実行する。何もしていない',
packages/cli/src/launchd-service.ts:810:  // 飛ばした unit があるのに成功と言わない: uninstall 以外は非 0 で終わる（版上げの script が成功と見なさない）。
packages/cli/src/launchd-service.ts:811:  // uninstall は後始末なので、終了コードは変えず、飛ばしたものを出力（標準出力）にも明示する
packages/cli/src/launchd-service.ts:821:    if (sub === "uninstall") {
packages/cli/src/launchd-service.ts:832:    // 対象は、LaunchAgents に置いた（常駐にした）ものと、uninstall では init しただけのもの。元の plist（.touryou/launchd）が
packages/cli/src/launchd-service.ts:833:    // 消えていても、LaunchAgents に残っていれば、そちらを読んで対象にする（stop・uninstall できるように）
packages/cli/src/launchd-service.ts:834:    const installed = otherPlistNames(agentsDir);
packages/cli/src/launchd-service.ts:836:      ...new Set([...installed, ...(sub === "uninstall" ? otherPlistNames(plistDir) : [])]),
packages/cli/src/launchd-service.ts:864:      // stateDir を読めなくても、uninstall は plist・ログを後始末でき、stop は Label だけで止められる。ほかは、窓口を確かめられないので飛ばす
packages/cli/src/launchd-service.ts:865:      if (stateDir === undefined && sub !== "uninstall" && sub !== "stop") {
packages/cli/src/launchd-service.ts:867:          `${file} の設定（${cfg}）の stateDir を読めないので、この daemon は飛ばした（設定がない・他の人が書ける・stateDir が絶対パスでない）。設定を直すか、${TOURYOU} launchd uninst
packages/cli/src/launchd-service.ts:878:    // uninstall のほかは、LaunchAgents に置いた（常駐にした）ものだけ。init しただけの plist を、apply・restart で常駐にしない
packages/cli/src/launchd-service.ts:879:    if (sub !== "uninstall") units = units.filter((u) => lstatOr(u.plistDest) !== undefined);
packages/cli/src/launchd-service.ts:896:    // 設定を消した・壊したあとでも、uninstall は plist を後始末できるようにする（stateDir は、窓口を見る操作だけが要る）
packages/cli/src/launchd-service.ts:897:    if (stateDir === undefined && sub !== "uninstall") {
packages/cli/src/launchd-service.ts:941:    case "uninstall":
packages/cli/src/launchd-service.ts:942:      return withWarnings(uninstall(ctx));
packages/cli/src/launchd.ts:135:  touryou launchd uninstall --yes [--org …] [--config …]
packages/cli/src/launchd.ts:137:  --config の代わりに --others を付けると、init が生成した別名の daemon（--config で作ったもの）が対象（apply・status・restart・stop・uninstall。版上げが使う）。
packages/cli/src/launchd.ts:138:  apply・status・restart・stop では、LaunchAgents に置いた（常駐にした）ものだけ。uninstall では、init しただけのものも含む。--org を付けると、その組織の Label のものだけ
packages/cli/src/launchd.ts:156: * 新しい形へ引っ越す（init）・外す（uninstall）ときだけに使う（#64）。
packages/cli/src/launchd.ts:534:      `touryou launchd には、init・apply・status・restart・stop・uninstall のどれかを指定する\n\n${HELP}`,
packages/cli/src/launchd.ts:655:      `stateDir が、別の設定（${describeSharing(sharing)}）の daemon と同じ。同じ state を 2 つの daemon が使うと壊れるので、何も書かずに止めた。設定ごとに、別の stateDir にする（同じ設定を別の -
packages/cli/src/launchd.ts:814:    // LaunchAgents に古い形が残っているうちは、次のログインで起こされうるので、消さない（apply が置き換えたあと・uninstall で消す）
packages/cli/test/install-runtime-multi.test.ts:1:// plugin/scripts/install-runtime.sh の、別名の daemon（touryou launchd init --config。#165）の扱いを、実際に script を走らせて確かめる。
packages/cli/test/install-runtime-multi.test.ts:2:// 形は scripts/install-runtime.test.mjs と同じ: script を source して platform・has_git・fetch だけを差し替え、main を呼ぶ。
packages/cli/test/install-runtime-multi.test.ts:26:  new URL("../../../plugin/scripts/install-runtime.sh", import.meta.url),
packages/cli/test/install-runtime-multi.test.ts:91:  copyFileSync(SCRIPT, join(P, "scripts", "install-runtime.sh"));
packages/cli/test/install-runtime-multi.test.ts:120:  return spawnSync("bash", ["-c", body, "_", join(P, "scripts", "install-runtime.sh"), ...args], {
packages/cli/test/install-runtime-multi.test.ts:440:  it("巻き戻しで、前の版の init --others が止まる（作り直せない plist など）: uninstall を挟まず、別名の daemon は止まっていると出す", () => {
packages/cli/test/install-runtime-multi.test.ts:459:    // 前の版の init --others・apply --others は LaunchAgents の plist を対象にするので、別名では uninstall を挟まない
packages/cli/test/install-runtime-multi.test.ts:460:    expect(calls.some((c) => c.includes("uninstall"))).toBe(false);
packages/cli/test/launchd-multi.test.ts:184:    const u = await bin(w, ["uninstall", "--yes", "--config", w.otherConfig]);
packages/cli/test/launchd-multi.test.ts:194:    expect((await bin(w, ["uninstall", "--yes"])).exitCode).toBe(0);
packages/cli/test/launchd-multi.test.ts:317:  it("別名の daemon の apply・uninstall は、既定と共有する古い形の起動スクリプトを消さない", async () => {
packages/cli/test/launchd-multi.test.ts:326:    expect((await bin(w, ["uninstall", "--yes", "--config", w.otherConfig])).exitCode).toBe(0);
packages/cli/test/launchd-multi.test.ts:330:    expect((await bin(w, ["uninstall", "--yes"])).exitCode).toBe(0);
packages/cli/test/launchd-multi.test.ts:344:    // uninstall は、置いていない plist（init の出力）も片づける
packages/cli/test/launchd-multi.test.ts:345:    expect((await bin(w, ["uninstall", "--yes", "--others"])).exitCode).toBe(0);
packages/cli/test/launchd-multi.test.ts:485:  // 版上げの巻き戻し（restore_old）は、別名では uninstall を挟まない。止めたあとの init --others → apply --yes --others で、
packages/cli/test/launchd-multi.test.ts:514:  // 先に uninstall --others で LaunchAgents の plist を外すと、前の版の init・apply は、何もせずに成功して、別名の daemon が戻らない
packages/cli/test/launchd-multi.test.ts:515:  it("uninstall --others のあとの init --others・apply --yes --others は、何もせず成功し、別名の daemon を戻さない", async () => {
packages/cli/test/launchd-multi.test.ts:519:    expect((await bin(w, ["uninstall", "--yes", "--others"])).exitCode).toBe(0);
packages/cli/test/launchd-multi.test.ts:529:  it("--others の uninstall は、読めない daemon を飛ばしても後始末を続け（終了コード 0）、飛ばしたものを標準出力に明示する", async () => {
packages/cli/test/launchd-multi.test.ts:535:    const u = await bin(w, ["uninstall", "--yes", "--others"]);
packages/cli/test/launchd-multi.test.ts:558:  it("LaunchAgents に plist が残り、元の plist が消えていても、--others で stop・uninstall できる", async () => {
packages/cli/test/launchd-multi.test.ts:567:    const u = await bin(w, ["uninstall", "--yes", "--others"]);
packages/cli/test/launchd-multi.test.ts:572:  it("設定の親ディレクトリがリンク経由でも、設定を消したあとの uninstall --config は、init と同じ Label を指す", async () => {
packages/cli/test/launchd-multi.test.ts:584:    const u = await bin(w, ["uninstall", "--yes", "--config", viaLink]);
packages/cli/test/launchd-multi.test.ts:602:  it("uninstall は、設定（stateDir）を読めなくても、plist を後始末できる", async () => {
packages/cli/test/launchd-multi.test.ts:608:    const u = await bin(w, ["uninstall", "--yes", "--config", w.otherConfig]);
packages/cli/test/launchd-multi.test.ts:616:  it("uninstall --others も、設定がなくなった daemon を外せる", async () => {
packages/cli/test/launchd-multi.test.ts:621:    const u = await bin(w, ["uninstall", "--yes", "--others"]);
packages/cli/test/launchd-multi.test.ts:701:  it("uninstall は、init しただけの別名の plist があっても、LaunchAgents に残らなければ登録を解く", async () => {
packages/cli/test/launchd-multi.test.ts:713:    const u = await bin(w, ["uninstall", "--yes"]);
packages/cli/test/launchd-multi.test.ts:721:  it("uninstall は、LaunchAgents に別の daemon の plist が残るなら、登録を解かず、残るものと外し方を案内する", async () => {
packages/cli/test/launchd-multi.test.ts:734:    const u = await bin(w, ["uninstall", "--yes"]);
packages/cli/test/launchd-multi.test.ts:856:  it("uninstall --others は、止められなかった daemon の plist は残し、止められた daemon の plist と後始末は進める", async () => {
packages/cli/test/launchd-multi.test.ts:862:    const r = await through(["uninstall", "--yes", "--others"]);
packages/cli/test/launchd-multi.test.ts:884:    const again = await through(["uninstall", "--yes", "--others"]);
packages/cli/test/launchd-service.test.ts:20:// `touryou launchd apply|status|restart|stop|uninstall`。launchctl と窓口は偽物に差し替える（実際の launchctl は呼ばない）。
packages/cli/test/launchd-service.test.ts:313:  it("--yes は apply・uninstall だけ。ほかのサブコマンドに付けると引数の誤り", async () => {
packages/cli/test/launchd-service.test.ts:319:describe("uninstall", () => {
packages/cli/test/launchd-service.test.ts:324:    const r = await bin(home, f, ["uninstall", "--org", ORG]);
