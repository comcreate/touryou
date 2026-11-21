# 検索: 止まります|止まる|sessions? (will )?stop|not_bound|まだ touryou に紐付いていない|紐付けが外れ|MCP の接続|Reconnect|unauthenticated
docs/auto-purge.md:56:    - 期限は、自動の削除と同じ時計（時計の異常の検知を通ったもの）で判定する。時計が飛んだ回は、実行そのものが止まる。時刻を読めないときは、保留のままにする（迷ったら保留）。
docs/cli.md:126:- daemon の失敗の文面は、コード・トークンを伏せ、制御文字を除き、長さを切ってから出す。`unauthenticated`（コードが使用済み・期限切れなど）のときも、会話で人（親）に `node.bindCode` での出し直しを頼むよう案内する。
docs/cli.md:135:  - **フック専用のトークンは、発行から 24 時間で切れ**、そのあと子の道具はすべて止まる。親か人が `node.bindCode` を出し直すと、フック専用のトークンと、ノードのトークン（結び直しのあと）の両方が新しくなる。起動したときに stopped だった子の引き出しの `hook-toke
docs/cli.md:146:- 既存のファイルは、黙って上書きしない。生成先がシンボリックリンクなら、辿らずに止まる。ただし、古い形（v0.1.0 まで。`bin/run-daemon.sh` を起こす plist）の生成物が、同じ `--org`・`--path-prefix` の古い `init` の生成物とバイト単位で同じなら、
docs/daemon-identity.md:82:1. **いつ**: **トークンつきの要求（`whoami`・`request`）を送るたびに、その直前に**。**キャッシュはしない**（検証した結果を、次の要求に使い回さない。ポートが奪われても、**次の要求からは**、その直前の検証で止まる。
docs/daemon-identity.md:155:    `StartLimitIntervalSec`・`StartLimitBurst` で、1 を繰り返し続けても、5 分に 5 回で止まる。`Requires=` により、daemon が止まれば touryou-mcp も止まる。
docs/daemon-identity.md:167:  - **子 → mcp の方向**（子が `mcpUrl` の偽物へトークンを送る）: 子の MCP クライアント（SDK）の外なので、この仕組みでは扱えない。**子の経路からポートをなくす**: 子の MCP を、子の `claude` が起動する stdio の中継 `tou
docs/daemon-identity.md:170:  次の要求からは、毎回の検証（その直前）で止まる。
docs/desktop-extension.md:48:- 拡張機能の touryou-mcp は、デスクトップアプリの中の Node（utility process）で動く。`ps` のコマンド行に拡張機能の名前は出ない。アプリを ⌘Q で終了すると止まる。
docs/desktop-runtime.md:167:| Desktop のアプリの再起動（作業中に終了して起動し直す） | 子のプロセスは止まる。約 30 秒後、アプリが自動で再開のメッセージを送り、新しいプロセス（`claude --resume`）で続きから走る。完了の知らせは、閉じた親に届かない。再開のメッセージは、フックでは人
docs/desktop-runtime.md:189:3. **止めたいとき**: まず、**アーカイブで止める**（作業を消さない。`stop_session` は今のターンだけを止める）。作業中の子は、親・子とも auto では、アーカイブで止まる（ほかの権限モードは確かめていない）。宣言の前には、フックのログ（`PreToolUs
docs/dev-orchestration.md:13:統括と手伝いは、名前を宛先にした知らせ（SendMessage）でやり取りします。決まった時刻の仕事は、それぞれが自分の中の予定（CronCreate）で動かします。背景のセッションは、手が空くと約 1 時間で止まるので（予定を持つものは止まらない）、4 つとも予定を持ちます。
docs/digest.md:102:  1 時間の追加の費用の目安は「**1 ターンの費用 × 起こした回数**」で、上限は「1 ターンの費用 × `min(maxPerHour, ノード数 × ⌊3600 / minIntervalSec⌋)`」。さらに、**子ごとの `maxBudgetUsd`（既定 5 USD）が、そのノードの合
docs/discarded-work.md:40:- `drop`: 保管を 1 件消す（取り消せない）。`--yes` がなければ、対象を表示して止まる（終了コード 2）。daemon の `node.discardedDrop` は、**`expectTip`（表示した先端）が必須**で、今の先端と一致したときだけ消す（違えば `t
docs/dist-manual-verification.md:63:- 取得・展開のあとに、**quarantine が付いていないこと**を確かめる。付いていれば、「配布物を、ブラウザでなく `/setup` の curl で取り直す」と案内して**止まる**。**`/setup` が quarantine を自動で外すことはしない
docs/launchd.md:32:- 前提: `/setup` を実行済み。`launchctl` は実行しない。既存と違う内容のファイルがあれば、黙って上書きせず、何も書かずに止まる。生成先がシンボリックリンクなら、辿らずに止まる。
docs/launchd.md:41:- **古い形からの引っ越し**: v0.1.0 までの `init` は、`bin/run-daemon.sh`（`#!/bin/sh`）を作り、plist はそれを起こしていました。新しい `init` は、`launchd/<Label>.plist` と `bin/run-daemon.sh`
docs/launchd.md:50:- 検査そのものを実行できない（daemon が置かれていない・`--check-config` を知らない古い版・時間切れ）ときは、設定の誤りと分けて「設定を検査できない」と出し、`/touryou:setup` での入れ直しを案内して止まります。
docs/launchd.md:52:- 通らなければ、**何も生成せず・plist を置かず・`launchctl` を呼ばずに**、終了コード 1 で止まります。理由（daemon の `失敗 [code]: …` と「次の操作」）と直し方を出します。**値（パス）は `<パス>` に伏せます**。
docs/launchd.md:101:| 子の作成・回収が、git の失敗で止まる（ログに「git（Xcode Command Line Tools）が使えません」、または Xcode のライセンスの文面） | Command Line Tools がない（仮の git）、または Xcode のライセンスに未同意 | `xcode-se
docs/manual-verification-checklist.md:39:| N3 | daemon が動いていないときの見え方 | daemon を止めてから、新しい統合セッションを開く。`/mcp` と `/plugin` の Errors を見る。道具を呼ぶ | 道具が `daemon が動いていません。launchd か 
docs/manual-verification-checklist.md:43:| N7 | セッションを閉じたら止まる | N1 のセッションを `/exit` し、`ps -axo command \| grep "@touryou/mcp/dist/bin.js --stdio" \| grep -vc grep` | `0`（d
docs/manual-verification-checklist.md:44:| N8 | daemon の再起動に追従する | N1 のセッションを開いたまま、daemon を止めて、起動し直す（launchd なら `launchctl kickstart -k`、手で起動したなら、その端末で Ctrl+C のあと起動し直す。手で
docs/manual-verification-checklist.md:52:| Q1 | 対話の CLI で、`/setup` のあと自動でつながる | `$HOME/.touryou` がない状態で `claude` を起動し、`/mcp` で node の状態を見る。続けて同じ会話で `/touryou:setup`（3-A）。
docs/manual-verification-checklist.md:53:| Q2 | デスクトップ版で、`/setup` のあと自動でつながる | Q1 と同じことを、デスクトップ版の Claude Code で行う（確認は `/touryou:status`。plugin は marketplace から入れる） | Reco
docs/manual-verification-checklist.md:56:| Q5 | daemon が動く前に配布物だけあるとき | 3-B（手で起動）を選び、daemon を起動する前に会話を始めて `/start` を試す。そのあと daemon を起動して 10〜20 秒待ち、もう一度 `/start` | 1 回目は n
docs/manual-verification-checklist.md:77:| S11 | 導入の script と quarantine | tag の前は `docs/setup-verification.md` の写しで行う。S10 の直後に `ls -l@ "$HOME/.touryou/work"` と `ls -lR@ 
docs/manual-verification-checklist.md:209:| D2-4 | チップから始めた子は `hooksNotActive` | 同じ `instruction` を spawn_task のチップから始めた子（「ワークツリー」「ローカル」どちらでも）に貼り、`touryou child bind` と `
docs/manual-verification-checklist.md:285:  3. 「やり取り」の欄で、図と一覧を「図」「一覧」で切り替えられること、図の箱を引っぱっても動かないこと、拡大・移動ができること、図の右上の「＋」「−」で拡大・縮小し、初めの形は読める大きさ（高い木でも 0.5 倍まで。収まらない分は図を動かして見る）
docs/plugin.md:11:| skill | `adopt` | すでにある作業ツリーと、そこで動くセッションを、子として採用する手順（`node_adopt` → セッションで `/mcp` の Reconnect → `child_bind`）。下の「既存の作業ツリーを子として採用する」 |
docs/plugin.md:17:| MCP | `node`（`.mcp.json`） | 統合セッションの MCP サーバー（**種類 stdio**）。Claude Code が、統合セッションごとに `/bin/bash ${CLAUDE_PLUGIN_ROOT}/scripts/touryou-mcp-shim.sh`（plu
docs/plugin.md:43:**導入の script（`plugin/scripts/install-runtime.sh`）**: `/setup` は、取得・照合・quarantine の確かめ・`tar -t` の検査・展開・外を指すシンボリックリンクの検査・`--help` の確かめ・`current` の付け替えを、この
docs/plugin.md:52:前提: `git`（Xcode の Command Line Tools）が要ります（daemon が、子の作業ツリーを `git worktree` で作るため。Xcode か Command Line Tools のどちらかがあればよい）。入っていなければ、Terminal で `xcode-sel
docs/plugin.md:67:3. 動いていたセッションで、`/mcp` から touryou を Reconnect し（これでこのセッションが子として動ける。印は MCP の起動のときにしか見ないため）、`child_bind` を引数なしで 1 回呼ぶ。
docs/plugin.md:102:手動の CLI セッション（daemon が SDK で起動する子とは別に、人が起動する `claude`）では、人間が `eval "$(touryou hook-env <nodeId>)"` で、その子の**フック専用のトークン**を発行して環境変数に入れる。このトークンは `POST /v1/
docs/plugin.md:128:**PostToolUse・Stop が「止めない版」である理由**: シェルは入力（JSON）を読まないので、イベントを区別できない。イベントごとに、別の command を登録する。Claude Code の公式のドキュメントでは、終了コード 2 は、PreToolUse ではツールの呼び出しを止
docs/plugin.md:130:**未確認・留意**: Claude Code の公式のドキュメントでは、hook の command が見つからない・終了コード 127 などは「ブロックしないエラー」（操作は進む）。`onFailure: "block"` を付ければ、失敗を拒否にできるが、この plugin は、TouRyou 
docs/plugin.md:152:**統合セッションには `TOURYOU_DAEMON_URL` を設定しない**（`touryou-mcp` の起動の端末だけで使う）。設定すると、「片方だけ」の拒否で、ToolSearch や Bash も止まる。そのときは、起動した端末で `unset TOURYOU_DAEMON_URL` し
docs/plugin.md:160:| `node` の道具がない。標準エラーに `[touryou mcp] 配布物の touryou-mcp がまだない…` | `/setup` をしていない（`$HOME/.touryou/current/bin/touryou-mcp` がない）。中継が待っている | `/touryou:set
docs/plugin.md:161:| failed。`[touryou mcp] 失敗 [daemon_unreachable]: daemon が動いていません…` | daemon が起動していない（`state/port` がない、または応答がない） | launchd（`docs/launchd.md`）か `touryou-
docs/plugin.md:162:| failed。`[touryou mcp] 失敗 [unauthenticated]: 根のトークン…` | `root-token` がない・リンク・自分のでない・権限が 0600 でない・ACL つき | daemon を起動して `root-token` を作らせる。権限は `chmod 6
docs/plugin.md:164:| `/mcp` の Reconnect で `Failed to reconnect to plugin:touryou:node: CONNECTION_CLOSED` だけが出る | `touryou-mcp --stdio` が起動時の確認で終わった（daemon が止まっている、または `/
docs/plugin.md:165:| 統合セッションの途中で daemon を止めると、ツールが `daemon_unreachable`（`daemon に届かない（止まっているか、起動し直している途中。トークンは送っていない）`） | daemon が止まっている | daemon を起動する。起動し直せば Reconnect な
docs/plugin.md:168:`/mcp` の失敗の理由は、Claude Code の debug ログ（`claude --debug`）か、`/plugin` の Errors に出る（公式のドキュメントによる）。`/mcp` の Reconnect の失敗は `CONNECTION_CLOSED` だけで、理由の文は出ない。
docs/plugin.md:187:- **再開の途中で daemon が再起動したとき**: 再開は、止まったまま新しいトークンを発行し、起動を待ってから running を記録する。その途中で daemon が止まると、子は stopped のまま残り、起動を待っていたトークンも残る。daemon は起動時に、止まっている子のトーク
docs/plugin.md:188:- 期限切れのトークンでの呼び出しは 401 で、失敗の記号は `tokenExpired`（ほかの不正なトークンは `unauthenticated`）。対処: Desktop の子は、親か人が `node.bindCode` でコードを出し直し、子が結び直す。CLI の子は、親か人が子を再開するか
docs/plugin.md:212:- **統合セッションが、誤って紐付け待ちで開いたとき**（印が残った作業ツリーで、統合セッションを始めたなど）: 人が、その作業ツリーで次を実行して印を外し、Claude Code の `/mcp` で Reconnect する。道具の呼び方で根に切り替える道はない。
docs/rate-limit.md:101:`POST /v1/bind` の失敗（コードが無効・拒否・本文の誤り）は、全体のスロットル（1 秒に 10 回）に加えて、**接続元ごとの bind 専用の bucket**（キー `bind:<接続元>`。`authFailures` と同じ容量・補充。**トークンの認証の失敗の buck
docs/reclaim-loss.md:9:touryou reclaim <nodeId>          # 失われるものを表示して止まる（終了コード 2）
docs/reclaim-loss.md:49:- ブランチがあるうちに破棄を決め、そのあとブランチが消えた場合は、先端の照合で止まる（`tipMismatch`）。もう一度 `touryou reclaim` で確かめ直して、決め直す。
docs/release.md:94:   順番を間違えたとき：tag を付けずに次の作業に進むと、project の設定での marketplace の取得が `Remote branch marketplace-v<版> not found` で失敗し、日に 1 回の `marketplace ref` も落ちる。差し戻しは要らない。
docs/release.md:336:**やり直す（2 回目から）**: 上の箱は `git switch -c verify-release` で始まるので、2 回目は止まる。新しい rc の番号で、次のようにする（`acct`・`v` は上の箱と同じ変数。`v` を新しい番号にする）。0 で見つかった不具合を main で直したあと
docs/setup-verification.md:21:確かめる変更が入った main で行う（#47〔bash 3.2 の全角の読み違いの直し〕が直った main で行う。直る前の main では、script が途中で止まることがある）。
docs/setup-verification.md:116:設定の問い（`repoRoot`・`worktreeRoot`）には、絶対パスを答える。`$HOME/...` と答えると、`setup.md` の決まり（入力のパスに `$` を含むと止まる）で止まる。先にターミナルで出した値を入れる。
docs/setup-verification.md:235:リリースのたびに、タグの前に行う（`docs/release.md` の「リリースの手順」の 0）。`release.yml` が作った配布物そのものを確かめられるため（直前の Release が v0.1.0 のとき〔#56〕は A が手順 3 で止まる、という理由で始めたが
docs/ui.md:41:  2. daemon の身元を確かめる（`docs/daemon-identity.md`。今の `touryou` コマンドと同じ）。合わなければ、トークンを送らずに止まる。チケットの応答の `x-touryou-daemon-id` も、確かめた daemon と照らす。
docs/ui.md:48:- **ブラウザを開けないとき**（Claude Code がクラウドで動いている・macOS でない など）: `touryou ui` は、URL を出さずに「Mac のターミナルで `touryou ui` を実行してください」と出して止まる。
docs/ui.md:142:- **いまあなたがすること**: 人の操作が要るものの数（大きな数字）と一覧。判断の頼み（選択肢のボタン・自由入力）、範囲を広げる頼み（承認・却下・切り出し。押すとどうなるかの説明つき）、**daemon が止まっているかもしれないと知らせた子**（受信箱の `stall` があるときだけ。時刻の経過などか
docs/ui.md:148:- **動き**: CSS の `@keyframes` とクラスの付け外しだけ。新しく来た項目が入ってくる動き・数が変わったときの動き・動いている印の点滅・カードへ移ったときの光り。最初の描画と、変わらない項目には動きを付けない。OS の「視差効果を減らす」（`prefers-reduced-motion`
docs/ui.md:210:- **周期でまとめる。** daemon は、1 つの周期（既定 250ms）で、全ての接続を見て、`lastSeq` が変わっていれば通知する（短い間の連続した変化は、最新の 1 件）。接続がなければ、周期は止まる。変化から画面が変わるまでは、手元で約 0.2 秒（目標 2 秒以内）。
packages/cli/src/child.ts:618:  return out.stdout === "unauthenticated\n"
packages/cli/src/child.ts:793:  const tail = r.error.code === "unauthenticated" ? `${ASK_HUMAN}\n` : `${rerun}\n`;
packages/cli/src/commands.ts:61:      --yes      対象を表示したうえで削除を実行する（なければ対象の表示だけで止まる）。--expect が要る
packages/cli/src/commands.ts:68:      --yes      破棄を指示する（なければ、表示だけで止まる）。--expect が要る
packages/cli/src/commands.ts:109:      --yes     表示を確認したうえで答える（なければ、表示だけで止まる）。--expect が要る
packages/cli/src/commands.ts:129:      保管を 1 件消す（取り消せない）。--yes がなければ、対象の表示だけで止まる
packages/cli/src/hook.ts:336:  return "touryou の子の作業ツリーで、まだ紐付けが済んでいない（または、紐付けが外れた・daemon がこのセッションを子と認めない）。先に child_bind を引数なしで呼ぶ。それでも通らないときは、自分で原因を探したり別の手を試したりせず、画面を見ている人
packages/cli/src/launchd.ts:9: * - 既存のファイルを黙って上書きしない（同じ内容なら何もしない。違えば、何も書かずに止まる。古い形の生成物と同じものだけは、置き換える）。
packages/cli/src/ui.ts:5: * 2. daemon の身元を確かめる（`docs/daemon-identity.md`。今の `touryou` コマンドと同じ）。合わなければ、トークンを送らずに止まる。
packages/cli/src/ui.ts:10: * （`open` の引数にだけ渡す。`ps` に出るのは、使い捨てのチケットだけ）。ブラウザを開けないときは、URL を出さずに止まる。
packages/daemon/src/ui/app-text.ts:627:    ja: "新しい項目の入る動き・線を流れる彗星・光る縁などを止めます。OS の「視差効果を減らす」を入れているときは、ここを切っていても止まります。",
packages/daemon/src/ui/app-text.ts:653:    ja: "開くと、子の紐付けが外れることがあります。子が「紐付けをやり直して」と言ったら、統合の会話で、この子の紐付けのコードの出し直し（node_bindCode）を頼んでください。",
packages/daemon/src/ui/graph-entry.ts:89:/** いまの図を消す（描いていなければ何もしない）。描いている途中の `draw` も、そこで止まる。 */
packages/mcp/src/node-subscriber.ts:9: * - daemon がトークンを拒んだら（whoami・購読の 401。`unauthenticated`）、張り直しをやめる（記録は 1 回だけ。`onAuthFailed` を呼ぶ）。
packages/mcp/src/node-subscriber.ts:196:        if (n.error.code === "unauthenticated") return "auth";
packages/mcp/src/server.ts:45:  /** 紐付け待ち。真なら、紐付けが済むまで `child_bind` と `whoami` だけを出し、ほかの道具は `not_bound` で断る。 */
packages/mcp/src/server.ts:282:            "not_bound",
packages/mcp/src/server.ts:283:            "このセッションは、まだ touryou に紐付いていない。紐付けが済むまで、この道具は使えない",
packages/mcp/src/stdio.ts:15: * - daemon の再起動への追従: 要求が `daemon_unreachable`・`unauthenticated`・身元の失敗で終わったら、置き場を読み直し、
packages/mcp/src/stdio.ts:56:const RELOAD_CODES = new Set(["daemon_unreachable", "unauthenticated", "daemon_identity_failed"]);
packages/mcp/src/stdio.ts:237:      "unauthenticated",
packages/mcp/src/stdio.ts:246:      "unauthenticated",
packages/mcp/src/stdio.ts:253:      "unauthenticated",
packages/mcp/src/stdio.ts:375:      "launchd（docs/launchd.md）か、touryou-daemon --config で起動してから、/mcp で Reconnect する",
packages/mcp/src/stdio.ts:388:    "not_bound",
packages/mcp/src/stdio.ts:389:    "このセッションは、まだ touryou に紐付いていない（子の作業ツリーのセッション）",
packages/mcp/src/stdio.ts:440:          "人が claude attach で子の画面を開いたあとにこうなったなら、MCP がつなぎ直されて紐付けが外れている（#136）。自動のつなぎ直し（#145）は、セッションの ID・作業ツリーが記録と合わない・紐付けの期限が切れた・止められたなどで通らなかっ
packages/mcp/src/stdio.ts:476:      if (!r.ok && r.error.code === "unauthenticated") store.clear();
packages/mcp/src/stdio.ts:633:        return fail("unauthenticated", "自分のノードを引けない", "資格情報を確かめる");
packages/mcp/src/stdio.ts:710:        if (now === undefined) return fail("unauthenticated", "紐付けの前", "紐付けを済ませる");
packages/mcp/src/tools.ts:40:    "すでにある作業ツリーと、そこで動いているセッションを、子として採用する（起動しない。CLI の木だけ）。引数: parentId（自分の ID か子孫の ID）・role・worktree（実在する作業ツリーの絶対パス）・branch（そのブランチ名。上流は親のブランチに
plugin/commands/desktop.md:12:- **sha256 は、シェルが計算して照合する**（人も、モデルも、書き写さない）。quarantine は**外さない**（あれば止まる）。
plugin/commands/desktop.md:20:   - `uname -sm` が `Darwin arm64` でなければ、止まる（対象は Apple Silicon の Mac だけ）。
plugin/commands/desktop.md:26:2. **拡張機能の情報を読む**: `Read` で、`${CLAUDE_PLUGIN_ROOT}/checksums.json` と `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` を読む。`${CLAUDE_PLUGIN
plugin/commands/desktop.md:30:   `extensions` の `mcpb` がなければ、止まる（拡張機能の情報のない plugin の版）。
plugin/commands/desktop.md:32:3. **取得（curl。1 コマンド）**: `mkdir -p "$HOME/.touryou/work" && curl -fL --proto '=https' --proto-redir '=https' -o "$HOME/.touryou/work/<name>" 
plugin/commands/desktop.md:33:4. **照合と quarantine（1 コマンド）**: `grep -A3 '"mcpb"' "<P>/checksums.json" | grep -c -F "\"sha256\": \"$(shasum -a 256 "$HOME/.touryou/work/<nam
plugin/commands/desktop.md:34:   `ls -l@` の出力に `com.apple.quarantine` が**ないこと**。あれば、**外さずに**止まる。`com.apple.provenance` は、macOS が付ける別の属性で、止めない。
plugin/commands/service.md:23:  定型文: 「daemon を起動し直します。動いている子のセッションは止まります。よいですか（はい／いいえ）」
plugin/commands/service.md:25:  定型文: 「daemon を止めます。動いている子のセッションは止まります。常駐の設定は残るので、次にログインしたときに、また自動で動きます。よいですか（はい／いいえ）」
plugin/commands/service.md:29:  結果の伝え方: 終了コード 0 なら、消したものを伝える。**終了コード 1 で、出力に「残した」の行があるときは、失敗ではない**（TouRyou が生成したものと判定できない〔手で直した・リンクなど〕ので残した）。残したものと理由を伝えて終える（やり直さない。消すかは、利
plugin/commands/service.md:32:  定型文（まとめて外す）: 「TouRyou をまとめて外します。いま、常駐（daemon）を止めて外します。plugin・marketplace・$HOME/.touryou（ログと daemon の状態を含む）は、この会話を終えたあとに、ターミナルで消すコマンドを出します。
plugin/commands/service.md:34:  結果: 終了コード 0、または終了コード 1 で「残した」の行があるときは、消したもの・残したもの（理由）を伝えて、次へ進む。終了コード 1 で「何も消していない」（止めるのに失敗）・終了コード 2 は、出力を伝えて止まる（次のブロックは出さない）。
plugin/commands/setup.md:19:- 手順 2 のパス（ホームの下か・git のリポジトリか・`config.json` がないか）は、手順 2 のコマンドの中で確かめる。**前もって別のコマンドで確かめない**（`OK` が出なければ止まる）。
plugin/commands/setup.md:25:- **quarantine を、外さない**（`xattr` の書き換え〔`-d`・`-c`・`-w`〕・`sudo`・`rm` は、実行しない）。付いていたら、script が止まる。macOS が、出所の確かでないコードを実行する前に検査する安全装置なので、黙って外さない。
plugin/commands/setup.md:29:- **「止まる」とは**: 次の手順に進まず、原因（出力）をそのまま利用者に伝え、定型文があれば、それを添える。
plugin/commands/setup.md:30:- 人が入力するパスは、引用符で囲んで使う。**改行・引用符（`"`・`'`・`` ` ``）・`$`・`;`・`\` を含むときは、止まる**。
plugin/commands/setup.md:34:1. **本体の導入（script。1 コマンド）**: `env -u BASH_ENV -u ENV bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-runtime.sh"`。`${CLAUDE_PLUGIN_ROOT}` は、この文書の中
plugin/commands/setup.md:36:   script がすること（順に。どこで失敗しても、`current` は古いまま。理由と次にすることを出して、0 以外で終わる）: 対象の確認（`Darwin arm64`・`git`〔Xcode の Command Line Tools〕）→ plugin の中の `chec
plugin/commands/setup.md:41:   - `RESULT: plugin-older`（終了コード 4。plugin が、いまの本体より古い）: 何も変わっていない。本体を古い版に入れ替えず、手順 2 以降にも進まず、止まる。下の定型文（plugin が古い）を伝える。常駐しているときも同じで、同意は聞かない。
plugin/commands/setup.md:42:   - `RESULT: failed`（終了コード 1・2）: 止まる。出力の「止めました」「次にすること」を、そのまま伝える。
plugin/commands/setup.md:52:2. **設定ファイル（1 コマンド）**: **`repoRoot` は、git のリポジトリであること**（前提。git でないフォルダは使えない）。人に、daemon が作業するリポジトリ（`repoRoot`・`rootCwd`）と、作業ツリーの置き場（`worktreeRo
plugin/commands/setup.md:57:   `OK` が出なければ、止まる（ホームの下でない・git のリポジトリでない・`config.json` がすでにある、のどれか。すでにあるときは、上書きしない。中身を直すなら、利用者が自分で直す）。出力をそのまま伝え、ホームの下でない・git のリポジトリでないときに、利用者
plugin/commands/setup.md:64:   2. **生成と登録・起動**: `"$HOME/.touryou/current/bin/touryou" launchd init && "$HOME/.touryou/current/bin/touryou" launchd apply --yes`（**1 の「はい」の
plugin/commands/setup.md:66:   3. **つながるのを待つ**: この会話の node は、配布物と daemon を見つけると、10 秒ほどで自動でつながる（Reconnect は要らない。plugin の中継〔`scripts/touryou-mcp-shim.sh`〕が、道具の一覧が変わったことを Cl
plugin/commands/setup.md:70:   - 続けて、**つながるのを待つ**: daemon を起動したあと、この会話の node は、配布物と daemon を見つけると、10 秒ほどで自動でつながる（Reconnect は要らない。plugin の中継〔`scripts/touryou-mcp-shim.sh`〕
plugin/commands/setup.md:72:   定型文（つながるのを待つ。3-A・3-B のどちらでも）: 「この会話の node は、10 秒ほどで自動でつながります。つながらなければ、/mcp で node を選んで Reconnect してください（または Claude Code を起動し直してください）。」
plugin/commands/setup.md:140:plugin を新しい版にしたあと（`claude plugin marketplace update touryou` のあと `claude plugin update touryou@touryou --scope user`。セッションの始まりに「本体と plugin の版
plugin/commands/setup.md:142:定型文: 「常駐している daemon を、いったん止めて、新しい版に入れ替えます。入れ替えたあと、常駐の設定のまま（ログイン時に自動で動くまま）起動し直します。動いている子のセッションは止まります。よいですか（はい／いいえ）」
plugin/commands/setup.md:146:script は、新しい版を置いて `--help` を確かめたあとで、今の版の `touryou launchd init`（今の生成物が、引数なしの init と同じかの確かめ。違えば、止めずに終わる）→ `touryou launchd stop` → `current` の
plugin/commands/setup.md:150:版上げの前から動いている統合セッションの `touryou-mcp --stdio` は、古い版のまま動き続ける（`current` の付け替えは、実行中のプロセスに効かない）。`/mcp` で `plugin:touryou:node` を選んで Reconnect する（Rec
plugin/commands/start.md:12:   - `/setup` を同じ会話で実行した直後なら、node は配布物と daemon を見つけてから 10 秒ほどで自動でつながる（plugin の中継が待っている）。少し待って手順 1 からやり直す。それでも node の道具がなければ、`/mcp` で `plugin:t
plugin/commands/start.md:17:   - 統合セッションの接続は、plugin の `.mcp.json` が済ませる（サーバー名 `node`・**種類 stdio**。Claude Code が `touryou-mcp --stdio` を起動し、`touryou-mcp` が `$HOME/.touryou
plugin/commands/start.md:22:- `/mcp` の Reconnect で `CONNECTION_CLOSED` だけが出る: 理由の文は `/mcp` に出ない。まず daemon が動いているか、`$HOME/.touryou/current` があるかを確かめ、直してから Reconnect する。
plugin/commands/start.md:23:- `/mcp` で `node` が failed: 標準エラーの `[touryou mcp] …` の理由に従う（`配布物の touryou-mcp がない` → `/setup`。`daemon_unreachable`（daemon が動いていません）→ daemon を起
plugin/commands/start.md:24:- `401`（`AUTH_HEADER_REJECTED`）: 根のトークンが、古い・別の daemon のもの。`touryou-mcp --stdio` は、要求の失敗のときに `root-token` を読み直して 1 回送り直すので、ふつうは自動で戻る。戻らなければ `/m
plugin/scripts/install-runtime.sh:8:#   3'. plugin の版が、いまの本体より古いなら、何も変えずに止まる（古い版に入れ替えない。終了コード 4・RESULT: plugin-older。
plugin/scripts/install-runtime.sh:129:# --- JSON の読み取り（make-checksums.mjs・plugin.json の、1 行 1 キーの形を前提。形が違えば、値が取れずに止まる） ---
plugin/scripts/install-runtime.sh:152:  # 常駐の daemon を止めたあと（または止めようとしたあと）の失敗。current を前の版（prev）に戻し、前の版で apply --yes してから止まる。
plugin/scripts/install-runtime.sh:347:    say "常駐（launchd）の daemon が設定されています（v${old}）。v${ver} に入れ替えるには、daemon を止めて起動し直します（動いている子のセッションは止まります）"
plugin/scripts/install-runtime.sh:427:    # ここから先は、daemon が止まっている。どこで失敗しても、current を前の版に戻して起動し直してから止まる（NFR_015）
plugin/scripts/install-runtime.sh:442:    say "常駐の daemon を v${ver} で起動し直しました。開いている統合セッションは、/mcp で plugin:touryou:node を Reconnect してください"
plugin/scripts/touryou-mcp-shim.sh:9:#   Claude Code は list_changed を受けると、道具の一覧を取り直す（公式の文書の「Dynamic tool updates」）。Reconnect は要らない。
plugin/skills/adopt/SKILL.md:3:description: touryou の統合ノードとして、すでにある git の作業ツリーと、そこで動いているセッションを、子ノードとして採用する手順（node_adopt → セッションで /mcp の Reconnect → child_bind）。手で作った作業ツリー
plugin/skills/adopt/SKILL.md:33:   1. `/mcp` を開き、touryou の接続を **Reconnect** する（動いていたセッションの MCP は、採用の前に始まっているので、つなぎ直すまでは子として動けない）。
plugin/skills/child/SKILL.md:16:  - 人が `claude attach` で画面を開いたあとに紐付けが外れたときも、まず `child_bind` を引数なしで 1 回呼ぶ。コードがなくても、セッションと作業ツリーが記録と合えば、自動でつなぎ直される（人の手間はいらない）。
plugin/skills/child/SKILL.md:18:  - 採用された子（すでに動いていたセッションを、親が `node_adopt` で子にした場合。手順は `/touryou:adopt`）は、先に `/mcp` を開いて touryou の接続を Reconnect してから呼ぶ（道具は、MCP の起動のときに決まるため
plugin/skills/child/SKILL.md:42:- フックや道具に拒まれても、`/touryou:setup`・`/touryou:start` などの setup・start のコマンドは、勧めない・使わない（手元の版を置き換えてしまう。daemon の起動は人と親の仕事）。拒否の理由の文は、そのまま親に知らせる（範囲の
plugin/skills/child/SKILL.md:43:- 道具（`SendMessage` など）が「このノードでは使えない」と拒否されたり、紐付けが外れて touryou の道具が使えなかったりしたときは、**自分で原因を探さず、別の手も試さない**（`launchd status` などの範囲外のコマンドを試すと、範囲違反に
