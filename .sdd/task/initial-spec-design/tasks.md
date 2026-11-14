---
id: "tasks-initial-spec-design"
title: "touryou タスク一覧"
type: "tasks"
status: "draft"
sdd-phase: "tasks"
sdd-version: "5.1.0"
depends-on: ["design-touryou"]
---

# タスク一覧

**関連 Design:** [touryou_design.md](../../specification/touryou_design.md)
**関連 Spec:** [touryou_spec.md](../../specification/touryou_spec.md)

> テストは先に書く（憲法 D-001: Test-First）。型安全性は憲法 T-001。状態は「済み」「残り」「済み（のちに外した）」「取りやめ」のどれか。「のちに外した」「取りやめ」は、システムが子を起動しない形（ADR）に改めたことによる。

## タスクの一覧

| ID | タスク | 状態 |
|:--|:--|:--|
| T01 | core: 状態と受信箱の種類の型を仕様にそろえる | 済み |
| T02 | core: 木の構造と親子の不変条件 | 済み |
| T03 | core: 状態遷移 | 済み |
| T04 | core: 受信箱の整列（優先度・依存・時刻。決定的） | 済み |
| T05 | core: 回収可能の判定 | 済み |
| T06 | core: 範囲違反の判定 | 済み |
| T07 | core: イベント型と畳み込み、requestId の冪等性 | 済み |
| T08 | core: 窓口の契約型と Result 型 | 済み |
| T09 | daemon: イベントログ（SQLite）と復元 | 済み |
| T10 | daemon: SDK による子の起動のアダプタ | 済み（のちに外した） |
| T10b | daemon: 組み立て・起動・起動時の整合 | 済み |
| T10b-r | daemon: 回収の実ポート（git） | 済み |
| T10b-w | daemon: 根の用意のあとに待ち受けを始める | 済み |
| T10b-a | daemon: 起動の順番の直し | 済み |
| T10b-d | daemon: Desktop の子を起動時の整合から外す方針 | 済み |
| T10c | core/daemon: 記録専用のイベント | 済み |
| T10s | daemon: スケジューラ（依存がそろった子の起動） | 済み |
| T10m | mcp: MCP サーバーの起動口 | 済み |
| T10m-i | daemon・mcp: daemon の身元確認 | 済み |
| T10m-i2 | mcp: 身元確認の検証 | 済み |
| T10m-i3 | mcp: 身元の検証の失敗で起動しない | 済み |
| T10m-n | daemon: 子の環境変数の NO_PROXY | 済み |
| T10m-id | daemon・mcp: 統合ノードの親の指定の確かめ | 済み |
| T10m-wh | mcp: メタツール whoami | 済み |
| T10m-j | daemon・mcp: 子から mcp への身元確認（中継） | 取りやめ |
| T10m-j1 | mcp: 子ごとの stdio の中継 | 取りやめ |
| T10m-j2 | daemon: 子の MCP を中継に切り替える | 取りやめ |
| T10m-j3 | 中継の通しの確かめ | 取りやめ |
| T10m-rs | mcp・cli: daemon の再起動の途中の扱い | 済み |
| T10a | daemon: 認証の失敗の件数 | 済み |
| T10l | daemon: 窓口の回数の制限 | 済み |
| T10l-m | mcp: HTTP の入口の回数の制限 | 済み |
| T10l-d | daemon: requestId による重複の除去 | 済み |
| T10l-d2 | daemon: 重複の除去の試験 | 済み |
| T10l-f | daemon: 回数の制限の残りの直し | 済み |
| T10r2 | daemon: 破棄の判断のあとの回収 | 済み |
| T10v | daemon: 範囲違反の記録と停止を同じトランザクションに | 済み |
| T10e | daemon: 子の環境変数を許可リストにする | 済み（のちに外した） |
| T10w | 子の起動: サブプロセスの環境変数の除去 | 取りやめ |
| T10w-2 | 子の起動: 孫プロセスの扱い | 済み（のちに外した） |
| T10w-3 | 子の起動: 孫プロセスの扱いの通しの確かめ | 取りやめ |
| T10x | 設定: pnpm-workspace.yaml の minimumReleaseAgeExclude を消す | 残り |
| T11 | mcp: ロール別のツール定義と公開一覧の試験 | 済み |
| T12 | cli: 人間用のコマンド | 済み |
| T13 | daemon: 窓口（入口・認証・認可） | 済み |
| T13b | daemon: トークンの永続化 | 済み |
| T13c | core/mcp: 契約から node.bind を外す | 済み |
| T13d | core/mcp/daemon: ブリーフと拡張要求の契約 | 済み |
| T13e | core/mcp/daemon: 破棄の判断（node.discardDecided） | 済み |
| T13f | 最終削除（node.purge・node.purgePreview） | 済み |
| T13f-c | core/daemon: 最終コミットの記録 | 済み |
| T13f-r | daemon/cli: 強制の回収で先端を残す | 済み |
| T13f-a | daemon: 保持ポリシーによる自動の最終削除 | 済み |
| T13f-n | daemon: 自動の最終削除の予告 | 済み |
| T13f-h | core/daemon/cli: 自動の最終削除の保留 | 済み |
| T13f-p | core: 最終削除で消えたノードと判断の再開 | 済み |
| T13g | daemon: 判断待ちからの再開で、破棄したノードを飛ばす | 済み |
| T14 | daemon: 窓口のハンドラ | 済み |
| T14d | daemon: 失敗した spawn・split の後始末 | 済み |
| T20 | daemon: Desktop のランタイムのアダプタ | 済み |
| T21 | Desktop の子の紐付けの手順と配線 | 済み |
| T21r | core/daemon/cli: 強制の回収の前に失われるものを出す | 済み |
| T21r-e | core/daemon/cli: 出した先端と実行時の先端の照合 | 済み |
| T21-ec | daemon: 片付けた子への依頼が残る件 | 済み |
| T21-ec2 | daemon: 停止の要求の seq を追記の結果からとる | 残り |
| T21-port | daemon: 窓口のポートを再起動で変えない | 済み |
| T21-v | Desktop の子の引き出しの前提の確かめ | 済み |
| T21-pr | daemon: 読み取りも禁じる場所 | 済み |
| T21-ce | daemon: 子のトークンを環境変数で渡す | 済み（のちに外した） |
| T21-te | daemon: トークンの期限 | 済み |
| T21-cc | cli: touryou child bind・touryou child report | 済み |
| T21-cb | daemon: touryou child の配線 | 済み |
| T21-ch | daemon・cli: Desktop の子のフックの経路 | 済み |
| T21-cs | daemon: Desktop の子の見張りを置く・塞ぐ | 済み |
| T21-cu | daemon: フックと session_id の結び付けの直し | 済み |
| T21-cv | docs: Desktop の子の手動確認の手順 | 済み |
| T21-cw | daemon: Desktop の子の見張りの直しと能力表の hooks | 済み |
| T21-d | daemon: 子の引き出しの置き場 | 済み |
| T22 | plugin: skill と起動のコマンド | 済み |
| T22-h | plugin・daemon: ファイルで設定するフック | 済み |
| T22-hu | daemon: フックの session_id の結び付けを外す | 済み |
| T22-hub | 画面: フックの結び付けを外すボタン | 済み |
| T22-ht | daemon・cli: 手動の CLI セッション用のフック専用のトークン | 済み |
| T22-c | daemon・plugin: SDK で起動する子に skill を渡す | 済み（のちに外した） |
| T22d | cli・画面: 停止の宣言 | 済み |
| T22-cli | cli: touryou の実行ファイルと HTTP のクライアント | 済み |
| T22-auth | daemon: 子の認証の確認 | 済み（のちに外した） |
| T22-hh | plugin: .mcp.json の headersHelper で根のトークンを読む | 済み |
| T22-stdio | plugin・mcp: 統合セッション用の MCP を stdio にする | 済み |
| T22-bundle | 本体を plugin と一緒に配る | 残り |
| T22-svc | cli・plugin: /setup から launchd の常駐まで | 済み |
| T22-mcpb | mcp・CI: デスクトップアプリの拡張機能（.mcpb） | 済み |
| T22-mcpb-cmd | plugin: /touryou:desktop で拡張機能を入れる | 済み |
| T22-pub-1 | CI・plugin: 公開の配布の準備 | 済み |
| T23 | daemon: HTML の画面と SSE による反映 | 済み |
| T23-b | 画面: 拡張要求の判定 | 済み |
| T23-c | 画面: 回収の指示 | 済み |
| T23-d | 画面: 最終削除 | 済み |
| T23-d2 | cli・画面: 最終削除の確かめの強化 | 済み |
| T23-d3 | 画面: 最終削除の保留の日数 | 済み |
| T23-ux | 画面: 使い勝手の直し | 残り |
| T24 | core/daemon: 中間統合ノードの要約報告 | 済み |
| T24-d | daemon: 要約の発行器 | 済み |
| T24-a | core: アーカイブ済みの枝の要約 | 済み |
| T24-w | daemon: 要約を上位に届ける | 済み |
| T24-i | cli/daemon: 人間用の受信箱の一覧 | 済み |
| T24-m | mcp: 受信箱の表示の要約と優先度 | 済み |
| T24-m2 | mcp: 受信箱で除外した項目の理由 | 済み |
| T24-hc | daemon: 窓口の件数のまとめにフックを足す | 済み |
| T24-rs | daemon・画面: 回答で再開しなかった子を返す | 済み |
| T24-sp | core・daemon・画面: 停止を妨げるプロセスにコマンドの名前 | 済み |
| T24-cf | daemon・画面: Desktop の木の取り消せない操作の確かめ | 済み |
| T25 | mcp: MCP の境界の入力の検証 | 済み |
| T25-rel | plugin・CI: マーケットプレイスに載せる形 | 済み |
| T26 | core/daemon: 未回答の判断 | 済み |
| T27 | core/daemon: 子が入れる報告の件数 | 済み |
| T30-spike | 確かめ: 親からの claude --bg と知らせの経路 | 済み |
| T30-design | 設計: 依頼・紐付け・Pub/Sub の形に書き直す | 済み |
| T30-rm-sdk | 消す: SDK による起動と停止 | 済み |
| T30-rm-auth | 消す: 子の認証 | 済み |
| T30-rm-home | 消す: childHome | 済み |
| T30-rm-http | 消す: 子用の HTTP の MCP の常駐 | 済み |
| T30-rm-relay | 消す: 子の stdio の中継 | 済み |
| T30-bind | 作る: CLI の子の紐付け | 済み |
| T30-req | 作る: 親への依頼と結果の確かめ | 済み |
| T30-pubsub | 作り直す: 知らせを Pub/Sub にする | 済み |
| T30-pubsub-route | 作る: 知らせの宛先を session_id で決める | 済み |
| T30-hooks | 作り直す: CLI の子のフック | 済み |
| T30-docs | 直す: README・docs・CHANGELOG | 済み |
| T30-perm | 作る: 子の許可を範囲だけにする | 済み |
| T30-plug-1 | 作る: 子が plugin を読んだかの確かめ | 済み |
| T30-plug-2 | 作る: 親の plugin の場所を依頼に添える | 済み |
| T30-child-ux | 直す: 子の読み違いを減らす | 済み |
| T30-human-cli | 作る: 人の手段（版・木・判断の回答） | 済み |
| T30-reject-nosub | 作る: 差し戻しのとき子の購読を確かめる | 済み |
| T30-stopped-decision | 作る: 止まった子の未回答の判断を出す | 済み |
| T30-sub-auth | 直す: 購読の 401 で張り直す | 済み |
| T30-revoke-persist | 作る: トークンの失効の印を残す | 済み |
| T30-tree-pending | tree.list の nodes に止まった子の未回答の判断を出す | 残り |
| T30-answer-delivered | 回答を子に届けたかを結果に出す | 残り |
| T30-verified-done | verified の子に終わったことを知らせる | 残り |
| T31-rename | 全体: 名前を touryou にそろえる | 済み |

## 残りの課題

- **T10x**: `pnpm-workspace.yaml` の `minimumReleaseAgeExclude`（既存の開発用ツールの除外）を消し、除外なしでも `pnpm install` が通ることを確かめる（NFR_010）。
- **T21-ec2**: `pause-handlers.ts`・`spawn-handlers.ts` が、停止の要求を追記したあとの `log.state().lastSeq` を停止の要求の seq として使っている。追記の結果の seq を使う形に直す。いまは停止中のまま解決が起きないのでずれないが、停止の追記のあとに記録を足す形になったときにずれる（NFR_002）。
- **T22-bundle**: 本体（`touryou-daemon`・`touryou-mcp`・`touryou`）を plugin と一緒に配り、plugin の側で起動して、`/setup` での本体の別取得と daemon の別起動をなくすか減らす。方針は未決。制約は、配布物の大きさ・Node の同梱・quarantine・sha256 の照合・NFR_012（絶対パスなし）・daemon が統合セッションより長く動くこと（IR_002）。
- **T23-ux**: 画面の使い勝手。優先: (1) 確認の欄がページの上に出てスクロールもフォーカスもしないので、押しても何も起きないように見える、(4) Desktop の子の停止の代行依頼が「失敗」と赤く出る、(6) 停止・完了した子にも「要対応」の数が残る。後回し: (2) 長い ID を手で打ち込む、(3) 「daemon に接続できません。再試行します」が理由を言わない、(5) 入力欄に id・name がない（FR_021, IR_003, NFR_008）。
- **T30-tree-pending**: 止まった子の未回答の判断（pendingDecision）は、いまは `tree_list` の表にだけ出る。`tree.list` の `nodes`（`touryou tree` が読む）にも欄を足し、`touryou tree` でも「届かない」「止まった子」が分かるようにする（FR_005, FR_009）。
- **T30-answer-delivered**: `decision.answer` の結果に、回答を子に届けたか（delivered）・届ける手段がなくて飛ばしたか（skipped）を足し、`touryou answer` がそれを出す。いまは cli が状態（waiting・running）から「届ける手段があれば届く」と出すだけで、届いたかは分からない（daemon の `answer-delivery` は canDeliver で手段を見て skipped にしている）（FR_009）。
- **T30-verified-done**: 紐付けが退役した verified の子に「終わった」を知らせる手段がない。いまは購読が止まり、記録が 1 回残るだけ。子のモデルと人に分かる形で知らせる（FR_009）。

## 未解決の事項

- `stopping` → `stopIncomplete` の所定の時間と、再試行の方式（自動か手動か）。
- 木あたりの同時実行数と費用の上限。
- バックグラウンド起動（`&`・`nohup`・`setsid` など）の扱い（いまは既定で拒否）。
- 停止のあとに残るプロセスの確かめ（`lsof`）の OS の差。
