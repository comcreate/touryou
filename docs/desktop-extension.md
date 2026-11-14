# Claude デスクトップアプリの拡張機能（touryou-mcp の .mcpb）

統合セッション用の `touryou-mcp --stdio` を、Claude デスクトップアプリの拡張機能（`.mcpb`）としても配る。デスクトップアプリの普通のチャットと、Cowork（**このコンピュータで実行するとき**）から、TouRyou の道具を使える。

- 中身は touryou-mcp の JS だけ（1 ファイル。ネイティブなし）。**daemon は入っていない**。daemon は、これまでどおり `/setup` で `$HOME/.touryou` に置き、手か launchd で起動する（`docs/plugin.md`・`docs/launchd.md`）。
- Node は、デスクトップアプリが内蔵するものを使う（manifest の要件は `>=22`）。
- 設定・トークンは拡張機能に入れない。touryou-mcp が `$HOME/.touryou/config.json` の `stateDir` から、根のトークン・daemon の窓口・身元を自分で読む（plugin の stdio と同じ。`docs/plugin.md`）。
- 対象は macOS（arm64）だけ。

## 入れ方（コマンドで。おすすめ）

1. `/setup` を済ませ、daemon を起動しておく（`docs/plugin.md` の「利用者の準備」）。
2. Claude Code で `/touryou:desktop` を実行する。`/setup` と同じく Release から curl（認証なし）で `.mcpb` を取り、この plugin の `checksums.json`（`extensions.mcpb`）の sha256 と照合し、quarantine がないことを確かめてから、チャットの「はい」のあとに `open` でデスクトップアプリの導入の画面を出す。画面で「インストール」を押す。daemon の版が違う・まだないときは、止めずに伝える。新しい版にするときは `/touryou:desktop update`（同じ流れ）。
   承認: Claude Code を auto モードで動かしていれば、コマンドごとの承認の確認はほとんど出ない。止められたら、その文面を伝えて手で許可する。**`open` の前の、チャットでの「はい」（同意）は、auto モードでも必ず取る**。
3. 導入の画面が出ないときは、Finder で `ホーム > .touryou > work` の `.mcpb` をダブルクリックするか、デスクトップアプリの 設定 > 拡張機能 > 詳細設定 > 拡張機能をインストール から選ぶ。

## 入れ方（手作業。予備）

1. `/setup` を済ませ、daemon を起動しておく。
2. Release から `.mcpb` と `.sha256` を取り、照合する（認証は要らない）。`<版>` は置き換える。

```sh
mkdir -p "$HOME/Downloads/touryou-mcp" && cd "$HOME/Downloads/touryou-mcp" && for f in "touryou-mcp-<版>.mcpb" "touryou-mcp-<版>.mcpb.sha256"; do curl -fL --proto '=https' -o "$f" "https://github.com/comcreate/touryou/releases/download/v<版>/$f"; done
```

```sh
cd "$HOME/Downloads/touryou-mcp" && shasum -a 256 -c "touryou-mcp-<版>.mcpb.sha256"
```

3. `.mcpb` をダブルクリックする（または、デスクトップアプリの 設定 > 拡張機能 > 詳細設定 > 拡張機能をインストール で選ぶ）。導入の画面で、次の警告が出る（未署名のため）。

> インストールすると、この拡張機能にコンピュータ上のすべてのデータへのアクセス権が付与されます。表示されている開発者情報はAnthropicによって検証されていません。インストール前に、この拡張機能の提供元が信頼できることを必ず確認してください。

   **提供元が comcreate であること**（上の手順 2 で、comcreate/touryou の Release から取り、sha256 が `OK` だったこと）を確かめてから入れる。違う経路で受け取ったファイルは入れない。

4. 有効にして、新しいチャットで「touryou-mcp の whoami を呼んで」と頼む。`{"nodeId":"root","role":"integrator"}` が返れば使える。

## 使える場所

| 場所 | 使えるか |
|:--|:--|
| デスクトップアプリの普通のチャット | 使える |
| Cowork・スケジュール済みタスク（「このコンピュータのみ」をオン、作業フォルダを指定） | 使える |
| Cowork・スケジュール済みタスク（クラウド環境） | **使えない**（道具が渡らない。対象外） |
| Claude Code（CLI・デスクトップ版の Claude Code） | 拡張機能ではなく plugin の `.mcp.json` を使う（`docs/plugin.md`） |

- デスクトップアプリのチャットでは、plugin の skill は読まれない。使い方の要点は、`whoami` の道具の説明文の先頭に書いてある。
- 拡張機能の touryou-mcp は、デスクトップアプリの中の Node（utility process）で動く。`ps` のコマンド行に拡張機能の名前は出ない。アプリを ⌘Q で終了すると止まる。

## 更新のしかた

新しい版の Release から、同じ手順で `.mcpb` を取って入れ直す（拡張機能の name は `touryou-mcp` で変わらない）。同じ name の新しい版を開くと、導入の画面に「更新」と出て、押すと古い版が置き換わる（拡張機能は 1 つだけになる。`docs/manual-verification-checklist.md` の P1）。`/touryou:desktop update` も同じ。daemon（tar.gz）も同じ版にする（`/setup`）。版がずれたときの表示は P3 で確かめる。

## 消し方

デスクトップアプリの 設定 > 拡張機能 で削除する。daemon・`$HOME/.touryou` は残る（消すときは `docs/plugin.md` の手順で）。
