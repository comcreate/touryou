# 変更履歴

## 未公開
- **daemon が使っていない `@modelcontextprotocol/sdk` への依存を外す**（#60。#53）: `packages/daemon` の依存から外した（daemon のコードは SDK を使っていない）。配布物から daemon の直下の SDK へのリンクがなくなる。SDK の本体は mcp が使うので配布物に残る。
- **出す前の /setup の確かめを、フォークの rc の配布物で行う**（#58。#48・#56）: v0.1.0 の配布物は #56 の壊れたリンクで `/setup` の検査に止められ、`docs/setup-verification.md` の A が通らない。新しい A' は、フォークの試しのリリース（例 `0.1.1-rc.0`）の zip をそのまま写しにし、手元の写しだけ `install-runtime.sh` の `REPO_URL` と `plugin.json` の `repository` をフォークに書き換えて（1 か所ずつを確かめる）、S10〜S13 を通す。配る script・`plugin.json` は変えていない。`docs/release.md` の 2-a・フォークの検証の例の版（`0.1.1-rc.0`）・後始末の時期を直した。`check_links` の注を実際の動き（行き先の親が中にあれば、行き先のないリンクは通す）に合わせた。
- **配布物から、ビルドの場所を指す壊れたシンボリックリンクを除く**（#56）: v0.1.0 の tar.gz には、pnpm deploy が残した `lib/node_modules/.pnpm/node_modules/@touryou/daemon`（CI のマシンの元のソースを指す）が入り、新しい `/touryou:setup` が「外を指すシンボリックリンクがある」で止まった。v0.1.1 の配布物から、`scripts/dist-build.sh` が展開先の外を指す・行き先のないリンクを取り除き（取り除いたものをビルドの出力に出す）、`scripts/dist-smoke.sh` が `/setup` と同じ検査（`install-runtime.sh` の関数）を tar.gz に当ててから Release に付ける。`/setup` の検査は緩めていない。
- **macOS の bash 3.2 で、日本語の表示の直前の変数で導入の script が止まるのを直す**（#47）: `plugin/scripts/` の shell script の変数を、すべて `${名前}` の形にした（UTF-8 のロケールの bash 3.2 は、`$ver）` の全角の文字を名前の一部として読む）。`pnpm validate:plugin` が、`plugin/scripts` の `$名前` と、`$名前` のすぐあとの ASCII でない文字（`scripts/*.sh` も）を拒む。試験を UTF-8 のロケールでも走らせる。
- **新しい /setup の実機の確かめの手順**（#48）: `docs/setup-verification.md` を足した。tag の前は、手元の plugin の写しに直前の Release の `checksums.json` を置いて `claude --plugin-dir` で `/touryou:setup` を通し（S10〜S13。版上げは複製した版で模造する）、tag の後は zip の `checksums.json` を確かめてから marketplace の PR をマージし、update → `/setup` → Q8 を行う。取得先は本番のまま、script には手を入れていない。`docs/release.md` の手順に 2-a と 6 を足した。
- **Dependabot で actions の版を上げ、patch・minor を自動でマージする**: `.github/dependabot.yml` で、workflow の actions の上げを週に 1 回、patch・minor は 1 本の PR に、メジャーは actions ごとの別の PR にする（公開から 14 日たった版だけ）。`dependabot-auto-merge.yml` が、github-actions の patch・minor で `.github/workflows/` の中だけを変える PR に auto-merge を付け、必須の check が通ってからマージされる。メジャーの上げは人がレビューする。マージのあとは `dependabot-main-ci.yml` が main で `ci.yml` を起こす。リポジトリの設定の「Allow auto-merge」が要る（`docs/release.md`）。
- **文書の地の文の製品名を TouRyou にそろえる**（#42）: docs・README・SECURITY・.sdd・plugin の commands と skills の地の文で、製品として読まれる touryou を TouRyou にした。コマンドを指す素の touryou はバッククォートで囲んだ。バッククォートの中・コードが出す文字列（受信箱の知らせ・フックの文）・ファイル名・URL・ADR の過去の項は変えていない。

- **表示名を TouRyou にする**（#40）: README の見出し・ロゴの代替テキスト・アイコンの `<title>`・marketplace の説明・デスクトップアプリの拡張機能の表示名と説明を TouRyou にした。パッケージ・コマンド・環境変数などの識別子は touryou のまま（変更はない）。
- **使わない .gitkeep を消し、actions の版をそろえる**（#18）: `packages/core/test/.gitkeep` と `plugin/agents/.gitkeep` を消した（`plugin/agents/` は任意にした）。workflow の `actions/checkout`・`actions/setup-node`・`pnpm/action-setup` を、それぞれ v7.0.1・v7.0.0・v6.0.10 にそろえた。
- **plugin の一番上の bin/ をなくす**（#36）: 中継を `plugin/bin/touryou-mcp-shim.sh` から `plugin/scripts/touryou-mcp-shim.sh` に移し、claude.ai・Cowork・組織の設定からも plugin を入れられるようにした（一番上に `bin/` がある plugin は、そこから入れられない）。`pnpm validate:plugin` が、`plugin/bin/` があれば（空でも）拒む。update の直後のセッションは、`/reload-plugins` までは古い版の置き場の中継を使い続ける（古い置き場は残るので動く）。
- **本体の導入を plugin の中の script にまとめた**（#12）: `/touryou:setup` の取得・照合・展開・付け替え・動作の確かめと、版が変わったときの常駐の daemon の起動し直し（「はい」のあとだけ）を、plugin の中の `scripts/install-runtime.sh` が 1 回で行う。承認の確認は約 12 回から約 3 回になった。本体と plugin の版が違うと、セッションの始まりに知らせる（知らせるだけ）。
- **退役を SSE で知らせ、mcp が張り直さずに止まる**（#32）: 子のトークンが役目の終わり（受理など）で失効したら、daemon はノードの購読に `event: retired` を 1 件送ってから閉じる（heartbeat を待たない）。子の mcp はこれを受けたら張り直さず、資格情報を空にして止まる。退役のあとの 401（`apiAuthFailed` の `retiredExpired`）が出なくなる。古い daemon・古い mcp との組み合わせは、今までどおり。
- **退役したトークンでのくり返しの認証の失敗を知らせる**（#31）: 退役した紐付けのトークンでの呼び出し（`retiredExpired`）が、1 つの窓（1 分）で閾値（既定 3。`rateLimit.alert.retiredThreshold` で 2〜100000）以上になったら、根の受信箱に `info` を 1 件出す。ほかの認証の失敗の警告とは、閾値・間隔・解決を別に見る。
- **止まった子の未回答の判断を tree に出す**（#8）: `touryou tree --json`・`touryou tree <nodeId>` に、止まった子の未回答の判断（`pendingDecisions`）が出る。
- **回答を子に届けたかを answer に出す**（#9）: `touryou answer` が、回答を子に届けたか（daemon の `decision.answer` の結果の `delivery`）を出す。
- **依存の脆弱性の修正**（#15）: 配布物に入る依存を、既知の脆弱性を直した版に上げた（zod 4.6.7〔high〕・body-parser 2.4.0〔high〕・qs 6.16.2・fast-uri 3.1.9・ip-address 10.7.5）。
- **setup で子に commit させるかを尋ねる**（#5）: `/touryou:setup` の設定の手順で、子に commit させるか（`git add`・`git commit` を根の範囲に入れるか）を尋ねるようにした。根の範囲に収まらない子の起動の失敗（`scopeNotSubset`）は、直す場所（`config.json` の `rootScope`）と、daemon の起動し直しが要ることを言う。
- **範囲違反は「フックが拒んだ」と明示**（#6）: 範囲違反の受信箱の項目は、「フックが拒んだ」ことをはっきり言う。統合の skill は、その言葉のまま人に伝える。
- **画面の使い勝手の直し**（#13）: 確認を開くと、確認の欄まで動いてフォーカスが移る。Desktop・CLI の子の停止未完了と、根に出る Desktop の子を確かめる依頼は、赤の「失敗」でなく「停止の代行依頼」として出す。受理・回収可・アーカイブのノードに「要対応」の数を出さない。打ち込ませる ID は 1 回のクリックで選べる。接続できないときに理由と確かめることを出す。入力欄に id・name を付ける。
- **受理した子のセッションの片付け**（#3）: 受理（`node_review` の accept）した CLI の子の裏のセッションは、親への依頼（`claude stop` → `claude rm`）で片付くようになった。状態は verified のまま。依頼の出し直しは `node_stop`。
- **統合の道具 `node_integrate`**（#4）: 受理した子のブランチを親のブランチへ fast-forward だけで統合する。できなければ何も変えずに理由（`notFastForward`・`targetDirty`）を返す。

## 0.1.0（最初の公開）

最初の公開の版です（公開より前の開発の履歴は、このリポジトリには含めていません）。

- **統合セッション 1 対 作業セッション n の木**: 統合セッション（人が対話する根）から、子のセッションへの依頼・進捗・判断・完了の報告・受理と差し戻し・回収を、daemon（`touryou-daemon`）が木として記録し、受信箱で知らせる。
- **子は親が起動する**: touryou はセッションを起動せず、Anthropic の認証も扱わない。親のセッションが受信箱のコマンド（`claude --bg …`）を実行して子を起動し、子が `child_bind` で紐付き、`inbox_fetch` で知らせを読む。停止は `claude stop`、削除は `claude rm`（`docs/plugin.md`）。
- **Claude Code plugin**: skill `integrator`・`child`、コマンド `/touryou:setup`・`start`・`status`・`service`・`desktop`、フック、統合セッションの MCP（`touryou-mcp --stdio`。落ちない中継つき）。入れ方は `claude plugin marketplace add comcreate/touryou` → `/plugin install touryou@touryou` → `/touryou:setup`。
- **配布物**: macOS（Apple Silicon）用の Node 同梱の tar.gz を GitHub Release に付け、`/setup` が plugin の `checksums.json` の sha256 と照合してから入れる。Claude デスクトップアプリの拡張機能（`.mcpb`）も付ける。
- **常駐**: `touryou launchd init|apply|status|restart|stop|uninstall`。plist の Label の既定は `touryou.daemon`（`--org com.example` で `com.example.touryou.daemon`）。
- **安全**: daemon の身元の確かめ（トークンを送る前に毎回）、作業の範囲のフック、状態の置き場の権限・ACL の確かめ。試験用の `TOURYOU_CLI_ALLOW_UNVERIFIED` は開発のビルドだけで効き、配布物では効かない。
- 人間用コマンド `touryou`・HTML の画面・Desktop の子（実験的）。
