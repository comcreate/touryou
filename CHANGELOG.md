# 変更履歴

## 未公開

- **止まった子の未回答の判断を tree に出す**（#8）: `touryou tree --json`・`touryou tree <nodeId>` に、止まった子の未回答の判断（`pendingDecisions`）が出る。
- **回答を子に届けたかを answer に出す**（#9）: `touryou answer` が、回答を子に届けたか（daemon の `decision.answer` の結果の `delivery`）を出す。
- **依存の脆弱性の修正**（#15）: 配布物に入る依存を、既知の脆弱性を直した版に上げた（zod 4.6.7〔high〕・body-parser 2.4.0〔high〕・qs 6.16.2・fast-uri 3.1.9・ip-address 10.7.5）。
- **setup で子に commit させるかを尋ねる**（#5）: `/touryou:setup` の設定の手順で、子に commit させるか（`git add`・`git commit` を根の範囲に入れるか）を尋ねるようにした。根の範囲に収まらない子の起動の失敗（`scopeNotSubset`）は、直す場所（`config.json` の `rootScope`）と、daemon の起動し直しが要ることを言う。
- **範囲違反は「フックが拒んだ」と明示**（#6）: 範囲違反の受信箱の項目は、「フックが拒んだ」ことをはっきり言う。統合の skill は、その言葉のまま人に伝える。
- **画面の使い勝手の直し**（#13）: 確認を開くと、確認の欄まで動いてフォーカスが移る。Desktop・CLI の子の停止未完了と、根に出る Desktop の子を確かめる依頼は、赤の「失敗」でなく「停止の代行依頼」として出す。受理・回収可・アーカイブのノードに「要対応」の数を出さない。打ち込ませる ID は 1 回のクリックで選べる。接続できないときに理由と確かめることを出す。入力欄に id・name を付ける。

## 0.1.0（最初の公開）

最初の公開の版です（公開より前の開発の履歴は、このリポジトリには含めていません）。

- **統合セッション 1 対 作業セッション n の木**: 統合セッション（人が対話する根）から、子のセッションへの依頼・進捗・判断・完了の報告・受理と差し戻し・回収を、daemon（`touryou-daemon`）が木として記録し、受信箱で知らせる。
- **子は親が起動する**: touryou はセッションを起動せず、Anthropic の認証も扱わない。親のセッションが受信箱のコマンド（`claude --bg …`）を実行して子を起動し、子が `child_bind` で紐付き、`inbox_fetch` で知らせを読む。停止は `claude stop`、削除は `claude rm`（`docs/plugin.md`）。
- **Claude Code plugin**: skill `integrator`・`child`、コマンド `/touryou:setup`・`start`・`status`・`service`・`desktop`、フック、統合セッションの MCP（`touryou-mcp --stdio`。落ちない中継つき）。入れ方は `claude plugin marketplace add comcreate/touryou` → `/plugin install touryou@touryou` → `/touryou:setup`。
- **配布物**: macOS（Apple Silicon）用の Node 同梱の tar.gz を GitHub Release に付け、`/setup` が plugin の `checksums.json` の sha256 と照合してから入れる。Claude デスクトップアプリの拡張機能（`.mcpb`）も付ける。
- **常駐**: `touryou launchd init|apply|status|restart|stop|uninstall`。plist の Label の既定は `touryou.daemon`（`--org com.example` で `com.example.touryou.daemon`）。
- **安全**: daemon の身元の確かめ（トークンを送る前に毎回）、作業の範囲のフック、状態の置き場の権限・ACL の確かめ。試験用の `TOURYOU_CLI_ALLOW_UNVERIFIED` は開発のビルドだけで効き、配布物では効かない。
- 人間用コマンド `touryou`・HTML の画面・Desktop の子（実験的）。
