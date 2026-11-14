---
description: Claude デスクトップアプリの拡張機能（touryou-mcp の .mcpb）を、Release から取得・照合して、導入の画面を出す（引数 install・update）
allowed-tools: Read
---

Claude デスクトップアプリの拡張機能（`touryou-mcp-<版>.mcpb`。統合セッション用の touryou-mcp）を、`/setup` と同じく Release から curl（認証なし）で取得し、この plugin の `checksums.json` の sha256 と照合し、quarantine がないことを確かめてから、デスクトップアプリの導入の画面を出します。利用者は、導入の画面で「インストール」を押します。引数（`$ARGUMENTS`）は `install`・`update` のどちらか。なければ `install`。それ以外なら、使い方を伝えて終わる。`update` も同じ手順（新しい版を入れ直す）。

## 進め方の決まり

- **この文書に書かれたコマンドを、書かれたとおりに実行する**。`<版>`・`<name>`・`<P>` だけを、手順 2 で決めた値に置き換える。コマンドが失敗したら、書き換えて実行し直さずに止まり、出力をそのまま人に伝える。
- このコマンドは、`Read` 以外を、事前に許可していない。コマンドごとに、承認の確認が出る（正常）。
- **sha256 は、シェルが計算して照合する**（人も、モデルも、書き写さない）。quarantine は**外さない**（あれば止まる）。
- **`open` は、利用者が定型文の問いにチャットで「はい」と答えたあとにだけ実行する。承認ダイアログの許可だけでは実行しない**。
- 拡張機能の中身（`.mcpb`）・`$HOME/.touryou` の中のトークンは、読まない・出さない。daemon は起動しない・止めない。
- デスクトップアプリの設定・拡張機能の一覧は、このコマンドからは変えない（入れる・消すのは、利用者がアプリの画面で行う）。

## 手順

1. **対象と daemon の版の確認（1 コマンド）**: `uname -sm; osascript -e 'id of app "Claude"' || echo NOAPP; readlink "$HOME/.touryou/current"`。
   - `uname -sm` が `Darwin arm64` でなければ、止まる（対象は Apple Silicon の Mac だけ）。
   - 2 行目は、デスクトップアプリの識別子（`com.` で始まる 1 行）か、`NOAPP`（と、その前の osascript の失敗の文）。`NOAPP` が出たら（デスクトップアプリがない。macOS にアプリの名前 Claude で問い合わせる。置き場所〔アプリケーションのフォルダ・ホームの下〕は問わない）、何もせずに終わる。`readlink` は、`$HOME/.touryou/current` がなければ、何も出さずに終了コード 1 で終わる（それでよい。下の「daemon がない」）。
     定型文（アプリがない）: 「この Mac には、Claude デスクトップアプリが見つかりませんでした（アプリケーションのフォルダに Claude がない）。デスクトップアプリを入れてから、もう一度実行してください。デスクトップアプリを使わないなら、このコマンドは要りません。」
   - `readlink` の出力は、手順 2 の版と比べる（手順 2 のあとで）。**違っても、ない（`/setup` をまだしていない）ときも、止めない**。手順 6 の前に、次の定型文で伝える。
     定型文（daemon の版が違う）: 「拡張機能は <版> ですが、この Mac の daemon（`$HOME/.touryou/current`）は別の版です。daemon も同じ版にしてください（Claude Code で /touryou:setup）。拡張機能は、このまま入れられます。」
     定型文（daemon がない）: 「この Mac には、まだ daemon が置かれていません。拡張機能を入れても、daemon がないと道具は動きません。Claude Code で /touryou:setup を先に実行してください。拡張機能は、このまま入れられます。」
2. **拡張機能の情報を読む**: `Read` で、`${CLAUDE_PLUGIN_ROOT}/checksums.json` と `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` を読む。`${CLAUDE_PLUGIN_ROOT}` が展開されず、読めないときは、plugin のディレクトリ（絶対パス）を、人に尋ねる（以降 `<P>`）。次を**すべて**確かめ、一つでも違えば止まる:
   - `checksums.json` の `version` と、`plugin.json` の `version` が同じで、`<数字>.<数字>.<数字>`（あれば、`-` と英数字・`.`）の形であること（以降 `<版>`）
   - `plugin.json` の `repository` が、`https://github.com/comcreate/touryou` であること（これ以外の取得元は、使わない）
   - `checksums.json` の `extensions` の `mcpb` の `name` が、`touryou-mcp-<版>.mcpb`（`/`・`..`・空白を含まない）であること（以降 `<name>`）。`sha256` が、16 進の 64 文字であること
   `extensions` の `mcpb` がなければ、止まる（拡張機能の情報のない plugin の版）。
   定型文（拡張機能の情報がない）: 「この plugin の版には、デスクトップアプリの拡張機能の情報が入っていません。plugin を新しい版にしてから（`claude plugin marketplace update` と `claude plugin update`）、もう一度実行してください。」
3. **取得（curl。1 コマンド）**: `mkdir -p "$HOME/.touryou/work" && curl -fL --proto '=https' --proto-redir '=https' -o "$HOME/.touryou/work/<name>" "https://github.com/comcreate/touryou/releases/download/v<版>/<name>"`（`/setup` の手順 3 と同じ形。認証なし。URL の `https://github.com/comcreate/touryou` は、手順 2 で確かめた `repository`）。書き込み先は、`$HOME/.touryou/work/` の下だけ。**失敗したら（終了コードが 0 でない）、止まる**（`/setup` の手順 3 の定型文〔取得の失敗〕で伝える）。
4. **照合と quarantine（1 コマンド）**: `grep -A3 '"mcpb"' "<P>/checksums.json" | grep -c -F "\"sha256\": \"$(shasum -a 256 "$HOME/.touryou/work/<name>" | cut -d' ' -f1)\"" && ls -l@ "$HOME/.touryou/work/<name>"`。`checksums.json` の `extensions.mcpb` の項目だけと照合する（tar.gz の sha256 とは一致させない）。`grep -c` が終了コード 0（`1`）で終わったときだけ、`ls -l@` が動く。**`0` なら（`shasum` の失敗を含む）、開かずに止まる**（取得したファイルは、削除しない）。
   `ls -l@` の出力に `com.apple.quarantine` が**ないこと**。あれば、**外さずに**止まる。`com.apple.provenance` は、macOS が付ける別の属性で、止めない。
   定型文（一致しない）: 「取得した拡張機能のファイルが、この plugin の記録（sha256）と一致しませんでした。開かずに止めます。plugin と Release の版がそろっているか、COMCREATE（連絡先: contact@comcreate-info.com）に確かめてください。」
   定型文（quarantine）: 「取得した拡張機能のファイルに、macOS の隔離の印（quarantine）が付いています。外さずに止めます。取得の経路を確かめてください（この手順の `curl` で取ったファイルには、ふつう付きません）。」
5. **入れる前に伝える**: 手順 1 の daemon の版の定型文（あれば）を伝えてから、次の定型文で尋ねる。**はっきり「はい」のときだけ**手順 6 へ進む。それ以外（「いいえ」・あいまい・質問）は、何もせずに終わる（取得したファイルは残す）。
   定型文（入れる）: 「デスクトップアプリの拡張機能（<name>）を開きます。デスクトップアプリに導入の画面が出るので、「インストール」を押してください。未署名のため、『インストールすると、この拡張機能にコンピュータ上のすべてのデータへのアクセス権が付与されます。表示されている開発者情報はAnthropicによって検証されていません。…』という警告が出ます。このファイルは、comcreate/touryou の Release から取り、sha256 の照合が通ったものです。開いてよいですか（はい／いいえ）」
   `update` のときは、続けて伝える: 「導入の画面に『更新』と出ます。押すと古い版が置き換わります（同じ名前の拡張機能は 1 つだけになります）。」
6. **開く（1 コマンド。5 の「はい」のあとだけ）**: `open "$HOME/.touryou/work/<name>"`。続けて、次の定型文で伝える。
   定型文（開いた）: 「デスクトップアプリで「インストール」を押し、有効にしてください。導入の画面が出ないときは、Finder で `ホーム > .touryou > work` の <name> をダブルクリックするか（`.touryou` は隠しフォルダです。Finder で ⌘⇧. を押すと見えます）、デスクトップアプリの 設定 > 拡張機能 > 詳細設定 > 拡張機能をインストール から、同じファイルを選んでください。入れたら、デスクトップアプリの新しいチャットで「touryou-mcp の whoami を呼んで」と頼み、`{"nodeId":"root","role":"integrator"}` が返るかを確かめてください。Cowork では「このコンピュータのみ」をオンにしたときだけ使えます。」

## 失敗したとき

- `open` が失敗した（終了コードが 0 でない）・導入の画面が出ない: 手順 6 の定型文の予備（Finder・設定の画面から選ぶ）を案内する。`open` を繰り返さない。
- デスクトップアプリで道具が失敗する（`daemon_unreachable` など）: daemon が動いていない。Claude Code で `/touryou:setup` の手順 3（常駐か手で起動）か、`/touryou:service status`。
- 詳しくは `docs/desktop-extension.md`。
