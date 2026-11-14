# セキュリティ

## 報告の窓口

脆弱性は、公開の Issue に書かず、次のどちらかで知らせてください。受け付けたら、内容を確かめて返信します。

- メール: contact@comcreate-info.com（COMCREATE。plugin の `/setup` などの案内の連絡先と同じ）
- GitHub の **private vulnerability reporting**（このリポジトリの Security タブ → 「Report a vulnerability」。GitHub Security Advisories）

報告に、トークン・API キー・個人のパスなどの値は含めないでください（形と再現の手順だけで足ります）。

## 対象の版

| 版 | 対象 |
|:--|:--|
| 最新の版 | 対象 |
| それより古い版 | 対象外（最新に上げてください） |

## 既知の制限

公開の時点で残る制限を書きます。

### 公開の時点で残る制限（いまわかっているもの）

- **同じユーザーの別のプロセス**は、daemon の根のトークン（`state/root-token`）を読め、`ps` で daemon の環境変数を読めます。TouRyou の権限の確かめは、ほかのユーザーと設定の誤りを防ぐためのもので、同じユーザーの悪意あるプロセスは防ぎません（`docs/plugin.md`・`docs/launchd.md`）。
- **作業の範囲の拒否**（書き込み・読み取り・コマンド）は、Bash では確実ではありません（`docs/plugin.md`）。
- **Desktop の木**では、同じユーザーの子が `state` の下のファイルを読めます（`docs/desktop-runtime.md`）。信頼できない入力に使わないでください。
- 配布物（tar.gz・.mcpb）は署名していません。`/setup` は、plugin に入った `checksums.json` の sha256 と照合してから展開します。

## 子の認証

TouRyou は、Anthropic の認証を扱いません（子のセッションを起動せず、トークン・API キーを読まない・保管しない）。
