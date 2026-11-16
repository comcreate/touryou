# #73 調べ：常駐のログイン項目を「TouRyou」の名前とアイコンで出す

- 区分：調べ（実装しない）。macOS の表示は、Linux のコンテナでは確かめていない。「見込み」は資料からの推測。
- 調べた日：2026-11-16

## 1. いまの形（事実。コードで確認）

- plist の `ProgramArguments` は `<H>/.touryou/current/bin/node`・`.../lib/dist/bin.js`・`--config`・`config.json`（`packages/cli/src/launchd.ts` の `daemonProgramArguments`）。
- node は nodejs.org の公式（`scripts/dist-build.sh`。配布元の Developer ID 署名つき）。
- 表示は「Node.js Foundation（1 項目）」・汎用のアイコン（11-16 の実機）。macOS は、責任のあるコードが分からないとき、実行ファイルの署名の開発元の名前でまとめて出す（[Apple フォーラム 721441](https://developer.apple.com/forums/thread/721441)）。

## 2. 比べの表

| 道 | 名前とアイコンが出る見込み | 外したとき消えるか | quarantine・Gatekeeper | 引っ越し・戻し | 手間 |
|:--|:--|:--|:--|:--|:--|
| A. `AssociatedBundleIdentifiers` ＋ 中身のない `TouRyou.app`（ad-hoc 署名） | **確かでない**（中〜低）。Apple は「plist を直に扱うならこの鍵を足す」と言う（[713493](https://developer.apple.com/forums/thread/713493)、[721441](https://developer.apple.com/forums/thread/721441)、[Updating helper executables](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)）。ただし、効かなかった報告・アイコンだけ変わった報告がある（[732805](https://developer.apple.com/forums/thread/732805)、[712335](https://developer.apple.com/forums/thread/712335)）。署名のチームの一致が要るかを、Apple ははっきり書いていない。node（Node.js Foundation のチーム）と、ad-hoc の .app（チームなし）は一致しないので、効かない恐れがある | plist を外せば消える見込み。古い項目が残る報告あり（システム設定を開き直すと消える。[713493](https://developer.apple.com/forums/thread/713493)） | .app は自分で作る（取得しない）ので quarantine は付かない。node の署名はそのまま | plist に鍵を 1 つ足すだけ。node 直の形のまま。戻すのは鍵を消すだけ | 小 |
| B. 起こすものを `TouRyou.app/Contents/MacOS/` の下に置く（node を写して ad-hoc 署名し直す） | 中。.app の中の実行ファイルは、その .app に結び付くとされる（[Updating helper executables](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)）。ただし ad-hoc に署名し直すと、開発元の名前（Node.js Foundation）は失われ、名前が出なければ「開発元を識別できない」に戻る恐れ（[755904](https://developer.apple.com/forums/thread/755904)）。**確かでない** | 外せば消える見込み | 署名し直すのは手元（導入のとき）か配布物の作るとき。手元で作れば quarantine は付かない。ad-hoc 署名は Gatekeeper の評価を通らないが、quarantine がなければ起動は止められない（今と同じ前提） | 配布物の形が変わる（`current/TouRyou.app/...`）。plist の `ProgramArguments` が変わる。戻しは今の plist を作り直す | 中 |
| C. `SMAppService.agent`（macOS 13+） | 高（**正式な署名があれば**）。Apple の勧める道（[SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)）。ad-hoc では `Operation not permitted`・BTM に断られた報告があり、Apple の人も「ad-hoc では問題が出る」と言う（[722932](https://developer.apple.com/forums/thread/722932)、[743395](https://developer.apple.com/forums/thread/743395)、[799910](https://developer.apple.com/forums/thread/799910)）。署名なしでは実質使えない見込み | `unregister()` で消える（登録した .app から呼ぶ要あり。[853715](https://developer.apple.com/forums/thread/853715)） | 署名・公証が前提 | Swift の小さな .app を作る・登録を呼ぶ仕組みが要る。`launchctl` の道（CLI の apply 等）を作り直す。今の plist は bootout して消す | 大 |
| D. Developer ID 署名＋公証（A〜C と組み合わせ） | 高（A・B・C どれでもチームが一致する） | 道による | 公証済みなら Gatekeeper を通る。quarantine の確かめ（外さない）の方針は保てる | 道による | 年 99 USD の Apple Developer Program（[Apple](https://developer.apple.com/support/compare-memberships/)）。CI に証明書（.p12）とパスワード、`notarytool` 用の App Store Connect API の鍵を秘密として置く（[Notarizing](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)）。node と .node（better-sqlite3）も自分の名前で署名し直し、hardened runtime と JIT の entitlements が要る |

## 3. 勧める道

1. **まず A を実機で試す**（いちばん安く、今の node 直の形と「署名しない」方針を変えない）。下の試し A。
2. A が効かなければ、**B を試す**（試し B）。B で「TouRyou」が出れば、署名なしで叶う。出なければ「識別できない」に戻るので採らない。
3. A・B とも駄目なら、**名前とアイコンを出すには署名（D）が要る**、と利用者に示して決めてもらう。そのときは D ＋ A（plist の形は変えない）が手間が少ない。C は D のあとでも、`launchctl` の道を作り直すほどの得は小さい。

理由：Apple の資料は、名前の決まり方を「責任のあるコード」の特定としか書いておらず、署名のチームの一致の要否が書かれていない。実機で見るのが最も早い。

## 4. 利用者に決めてほしいこと

- A・B が効かなかったとき、署名（Developer ID・年 99 USD・CI の秘密）に方針を変えるか、今の「Node.js Foundation」のまま案内で補う（#74）か。
- B を採るとき、配布物に `TouRyou.app` の形を入れてよいか（配布物の形が変わる）。
- アイコンの絵（.icns）を誰が用意するか。

## 5. 実機の試し（いまの daemon に触れない）

- label は `touryou.test73`、アプリは `${HOME}/Applications/TouRyouTest73.app`（bundle ID `touryou.test73.app`）。今の `touryou.daemon` には触れない。
- 起こすのは、同梱の node で何もしない JS（`setInterval`）。daemon の JS は起こさない。sudo は要らない。
- アイコンは試しなので、システムの既存の `.icns` を写して使う（汎用と見分けがつくもの）。

### 試し A（AssociatedBundleIdentifiers）

```zsh
T="${HOME}/Applications/TouRyouTest73.app"
mkdir -p "${T}/Contents/MacOS" "${T}/Contents/Resources" "${HOME}/Library/LaunchAgents"
command cp /System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/ToolbarInfo.icns "${T}/Contents/Resources/AppIcon.icns"
printf '#%s\nexit 0\n' '!/bin/sh' >| "${T}/Contents/MacOS/TouRyouTest73"
chmod 755 "${T}/Contents/MacOS/TouRyouTest73"
cat >| "${T}/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>touryou.test73.app</string>
<key>CFBundleName</key><string>TouRyouTest73</string>
<key>CFBundleDisplayName</key><string>TouRyouTest73</string>
<key>CFBundleExecutable</key><string>TouRyouTest73</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.1</string>
<key>LSUIElement</key><true/>
</dict></plist>
EOF
codesign --force --sign - "${T}"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "${T}"
cat >| "${HOME}/Library/LaunchAgents/touryou.test73.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>touryou.test73</string>
<key>ProgramArguments</key><array>
<string>${HOME}/.touryou/current/bin/node</string>
<string>-e</string>
<string>setInterval(()=>{},1e9)</string>
</array>
<key>AssociatedBundleIdentifiers</key><array><string>touryou.test73.app</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
EOF
launchctl bootstrap "gui/${UID}" "${HOME}/Library/LaunchAgents/touryou.test73.plist"
launchctl print "gui/${UID}/touryou.test73" | head -20
```

- 見るところ：システム設定 →「一般」→「ログイン項目と機能拡張」（開いていたら一度閉じて開き直す）。「TouRyouTest73」が出るか、「Node.js Foundation」が 2 項目になるか、アイコンは何か。
- 注：最初の `printf` は `#!/bin/sh` を `!` を打たずに作るため。`ToolbarInfo.icns` が無い版の macOS なら、`ls /System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/*.icns` から別のものを選ぶ。

### 試し B（node を .app の中に写して ad-hoc 署名し直す）

試し A の後片付けのあとで行う。

```zsh
T="${HOME}/Applications/TouRyouTest73.app"
command cp "${HOME}/.touryou/current/bin/node" "${T}/Contents/MacOS/TouRyouTest73"
codesign --force --sign - "${T}"
codesign -dv "${T}" 2>&1 | head -10
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "${T}"
/usr/bin/sed -i '' "s#${HOME}/.touryou/current/bin/node#${T}/Contents/MacOS/TouRyouTest73#" "${HOME}/Library/LaunchAgents/touryou.test73.plist"
grep -A3 ProgramArguments "${HOME}/Library/LaunchAgents/touryou.test73.plist"
launchctl bootstrap "gui/${UID}" "${HOME}/Library/LaunchAgents/touryou.test73.plist"
launchctl print "gui/${UID}/touryou.test73" | head -20
```

- 試し A の後片付けで plist と .app を消すので、試し B の前に試し A の塊をもう一度貼ってから、この塊を貼る。
- 見るところ：名前が「TouRyouTest73」か「開発元を識別できない」か。`AssociatedBundleIdentifiers` を消した形（plist から 1 行消す）でも見るとよい。

### 後片付け（A・B 共通）

```zsh
launchctl bootout "gui/${UID}/touryou.test73"
rm -f "${HOME}/Library/LaunchAgents/touryou.test73.plist"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "${HOME}/Applications/TouRyouTest73.app"
rm -rf "${HOME}/Applications/TouRyouTest73.app"
launchctl print "gui/${UID}/touryou.test73"
```

- 最後の行は「見つからない」と出れば片付いた。システム設定を開き直し、項目が消えたかも見る（消えるかの確かめ）。
- 項目の記録を詳しく見る `sfltool dumpbtm` は、版により `sudo` が要る（記録が利用者全体のものなので）。要らなければ使わない。`sfltool resetbtm` は全部の項目を消すので使わない。

## 6. 確かでないこと

- A で、チームの一致が要るか（要るなら署名なしでは効かない）。
- B で、ad-hoc 署名の実行ファイルが .app の名前で出るか、「識別できない」になるか。
- 項目が外したあとすぐ消えるか（古い項目が残る報告あり）。

## 7. 実機の試しの結果（11-16。Apple Silicon・署名なし）

- **A**（`AssociatedBundleIdentifiers` ＋ ad-hoc の入れ物）：「Node.js Foundation」が 2 項目になった → 効かなかった。node の署名のチームと入れ物（チームなし）が一致しないためと見る（確かでない）。
- **B**（node を入れ物の `Contents/MacOS/` に写して ad-hoc 署名）：名前は「TouRyouTest73B」で出た。ただし「開発元を識別できない項目です」と出て、アイコンは汎用の exec の絵。名前は、起こしたファイルの名前の見込みが高い。
- 後片付けのあと、試しの項目はすぐ一覧から消えた。いまの daemon は試しの前後で変わらなかった。
- よって、署名なしでは名前とアイコンを開発元つきで出せない見込み。署名の案は [signing-plan.md](signing-plan.md)。
