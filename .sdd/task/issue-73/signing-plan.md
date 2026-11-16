# #73 署名の案：Apple の開発者の署名と公証（D）

- 区分：調べ（実装しない）。お金・設定は、まだ動かさない。
- 書いた日：2026-11-16
- もと：[research.md](research.md) の D と、11-16 の実機の試し（A は効かず、B は名前だけ・「開発元を識別できない」）。
- 「見込み」は資料からの推測で、macOS の表示は実機で確かめていない。確かでないことは、そう書く。

## 0. 要点

- 費用は年 99 USD（現地の通貨で請求）。組織（COMCREATE）で登録するなら D-U-N-S 番号が要り、番号の発行に最大 5 営業日、そのあと Apple の審査は日数が決まっておらず、数週かかった報告もある。
- 勧める形は **「D ＋ B」**：TouRyou.app の入れ物の `Contents/MacOS/` に node を置き、入れ物ごと自分のチームで署名・公証する。plist に `AssociatedBundleIdentifiers` も付ける（A も重ねる）。名前とアイコンが開発元の名前つきで出る見込みは「中〜高」。ただし確かめは実機の試し（署名したあと）でしか出来ない。
- 作業量の見積もり：登録を除いて、実装と試しで **3〜5 日**ほど（不確か）。登録（組織）は暦で **1〜4 週**。
- 秘密は 5 つ（.p12・そのパスワード・API の鍵 .p8・鍵の ID・Issuer ID）。GitHub の environment（`release`）に置き、タグの push だけが使えるよう保護する。
- #64 の「署名しない」方針は変える（ADR に新しい決めを足す）。「quarantine を外さない」方針は、そのまま保てる。

## 1. 費用と登録

### 1.1 費用

- Apple Developer Program は年 99 USD。現地の通貨で請求される（[Apple：What's included](https://developer.apple.com/programs/whats-included/)、[Compare memberships](https://developer.apple.com/support/compare-memberships/)）。日本円の額は Apple の日本の登録の画面で出る。為替で変わるので、ここでは書かない（確かでない）。
- 無料の Apple ID では Developer ID の証明書は作れない（上の比べの表）。
- 毎年の更新が要る。切れると新しい署名と公証は出来なくなる。すでに公証済みの配布物は動き続ける見込み（Developer ID の証明書は期限が切れても、署名の時刻〔timestamp〕があれば有効のまま。[Developer ID](https://developer.apple.com/support/developer-id/)）。

### 1.2 組織で登録するとき（COMCREATE）

要るもの（[Apple：Enrollment](https://developer.apple.com/programs/enroll/)、[D-U-N-S の案内](https://developer.apple.com/support/D-U-N-S/)）：

- 法人格（法務上の名前。屋号・支店は不可）。
- D-U-N-S 番号（Dun & Bradstreet が出す。無料）。すでに番号があるかもしれないので、まず Apple の照会で探す。
- 組織の公開のウェブサイト（組織の名前と結び付くドメイン）。
- 登録する人が、組織を Apple との契約に縛れる権限を持つこと（または権限のある人の確認）。
- 2 要素認証をした Apple Account。

日数：

- D-U-N-S の新しい発行に最大 5 営業日。そのあと Apple に届くまで最大 2 営業日（[D-U-N-S の案内](https://developer.apple.com/support/D-U-N-S/)）。
- Apple の審査（電話の確認がある場合あり）は日数が公表されていない。数週「処理中」のままの報告がある（[フォーラム 815009](https://developer.apple.com/forums/thread/815009)、[839063](https://developer.apple.com/forums/thread/839063)）。**暦で 1〜4 週を見込む**（確かでない）。

### 1.3 個人で登録するとき

- D-U-N-S は要らない。本人の確認だけで、ふつう早い。
- 署名に出る名前は**個人の法務上の名前**になる。組織の道具に個人名が出る。あとから組織へ移すことは出来る（Apple に頼む）が、チーム ID は変わらず、名前の変わり方は確かでない。
- 退職などで人が抜けると、署名の道が止まる恐れがある。

### 1.4 署名に出る名前

- 証明書の名前は「Developer ID Application: <登録の名前> (<チーム ID>)」。登録の名前は、組織なら法務上の組織名、個人なら個人名（[Developer ID](https://developer.apple.com/support/developer-id/)）。
- 「ログイン項目」で、項目がアプリに結び付かないときに出るのはこの開発元の名前（いまの「Node.js Foundation」と同じ動き。[フォーラム 721441](https://developer.apple.com/forums/thread/721441)）。結び付いたときは、アプリの名前とアイコンが出る見込み。
- 組織の法務上の名前が英字でどう登録されているか（例：「COMCREATE」か、別の綴りか）は、D-U-N-S の記録による。確かでない。

## 2. 出方の見込み

### 2.1 D ＋ A（node はそのまま。`AssociatedBundleIdentifiers` と、自分のチームで署名した TouRyou.app）

- **できない**。node は Node.js Foundation のチームの署名のまま。A が効かなかった理由が「チームの不一致」なら（11-16 の見立て）、こちらの入れ物を署名しても、node 側のチームは変わらない。Apple は「`AssociatedBundleIdentifiers` は、同じチームで署名したアプリと結び付ける」とする趣旨を述べている（[Updating helper executables](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)、[フォーラム 713493](https://developer.apple.com/forums/thread/713493)）。チームの一致の要否の文は確かめきれていない（確かでない）が、どちらにせよ node を自分で署名し直さないと一致しない。
- よって、「D ＋ A」は、**node を自分のチームで署名し直す**ことと組んで初めて意味がある（下の 2.2・2.3）。

### 2.2 D だけ（node などを自分のチームで署名し直す。入れ物なし・鍵なし）

- 項目は「<組織の名前>」（開発元の名前）で 1 つに出る見込み。アイコンは汎用。「開発元を識別できない」は消える。
- 名前が「TouRyou」になるかは確かでない（組織の名前が出る見込み）。

### 2.3 D ＋ B（勧める。入れ物の中の node を、入れ物ごと自分のチームで署名。鍵も付ける）

- 入れ物の実行ファイルとして node を置き、`TouRyou.app` ごと Developer ID で署名・公証する。plist の `ProgramArguments` の 1 つ目は入れ物の中の node。`AssociatedBundleIdentifiers` も付ける。
- 見込み：**「TouRyou」の名前とアイコン**で、開発元の名前つきで出る（中〜高）。根拠：11-16 の B で、入れ物の中の実行ファイルは名前が出た（入れ物には結び付いた見込み）。足りなかったのは「識別できる署名」で、それを D が埋める。Apple は、アプリの入れ物の中の実行ファイルを、そのアプリの責任のコードとして扱うとする（[Updating helper executables](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)）。
- ただし、B の試しで入れ物のアイコンが使われなかった理由は分かっていない。署名で直るかは**確かでない**。直らなければ、名前だけ（開発元つき）になる。
- 中の実行ファイルの名前は「TouRyou」にする（11-16 の試しで、起こしたファイルの名前が出た見込みが高いため）。

### 2.4 起こすものの勧め

| 形 | 勧め | 理由 |
|:--|:--|:--|
| node を自分で署名し直し、`bin/node` のまま起こす（D だけ） | 次点 | 作りの変化が小さい。ただしアイコンは出ず、名前は組織名の見込み |
| node を `TouRyou.app/Contents/MacOS/TouRyou` に置き、入れ物ごと署名（D ＋ B ＋ A） | **勧める** | 名前とアイコンの見込みがいちばん高い。`bin/node`（起動スクリプト用）は、入れ物の中の node へのリンクにして、node を 1 つにする |
| 小さい自前のランチャー（Swift などで書いた起こし役）を入れ物に置き、node を子として起こす | 採らない | 自前のコードが増え、子の node も署名が要る。項目は増えない見込みだが得は小さい |
| C（`SMAppService`）に移る | 今は採らない | 署名があれば最も正しい道だが、`launchctl` の道を作り直す手間が大きい。将来の候補 |

## 3. 作業

### 3.1 署名し直すもの

配布物の中の Mach-O（実行できるもの）を全部、内から外の順に署名する（[Signing a daemon with a restricted entitlement](https://developer.apple.com/documentation/xcode/signing-a-daemon-with-a-restricted-entitlement)、[Placing content in a bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle)）：

1. better-sqlite3 の `prebuilds/darwin-arm64.node`（いまは配布元の ad-hoc 署名。quarantine がついたときに読まれなかったもの。docs/dist-manual-verification.md）。
2. そのほかの `.node`（いまは better-sqlite3 だけ。dist-build.sh の検査で、`find -name '*.node'` を数えているので、それに合わせる）。
3. node（入れ物の中の `TouRyou`）。hardened runtime と entitlements を付ける。
4. `TouRyou.app`（入れ物）。
- 起動スクリプト（`bin/touryou` などの sh）は Mach-O でないので、署名しない（公証の対象外の見込み）。
- `--deep` は使わず、1 つずつ署名する（Apple の勧め。[フォーラム 129980](https://developer.apple.com/forums/thread/129980)）。
- すべて `--timestamp`（時刻の印）を付ける。公証の条件（[Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)）。

### 3.2 hardened runtime と entitlements

- 公証には hardened runtime（`codesign --options runtime`）が要る（上の Notarizing）。
- node（V8）は JIT を使うので、`com.apple.security.cs.allow-jit` が要る見込み。足りなければ `com.apple.security.cs.allow-unsigned-executable-memory`（[Apple：Allow JIT](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit)、[フォーラム 794080](https://developer.apple.com/forums/thread/794080)、[Node の PR 31459](https://github.com/nodejs/node/pull/31459)）。nodejs.org の公式の node が持つ entitlements を `codesign -d --entitlements - node` で見て、同じものに揃えるのが確か（試しで確かめる）。
- better-sqlite3 の `.node` を、**同じチームで署名し直す**なら、`disable-library-validation` は要らない見込み（library validation は、同じチームのものなら通す。[Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)）。署名し直さずに読むなら要る。署名し直すほうを勧める。
- entitlements は `packaging/macos/node.entitlements` のような 1 ファイルにして、リポジトリに入れる。

### 3.3 公証と staple（tar.gz の配布）

- `notarytool submit` は zip・dmg・pkg だけを受け、tar.gz は受けない（[notarytool の man](https://keith.github.io/xcode-man-pages/notarytool.1.html)）。
- 手順の案：`TouRyou.app` を含む展開後の木（stage）を `ditto -c -k --keepParent` で zip にして提出（`--wait`）→ 通ったら `xcrun stapler staple TouRyou.app`（.app には staple 出来る。zip・素の実行ファイル・.node には出来ない。[stapler の man](https://keith.github.io/xcode-man-pages/stapler.1.html)、[フォーラム 651808](https://developer.apple.com/forums/thread/651808)）→ staple 後の stage を、いまの通り tar.gz にする。
- 提出の zip は配らない（公証のためだけ）。配るのは、いまと同じ tar.gz（形は `TouRyou.app` が増える）。
- staple できない `.node`・起動スクリプトは、Gatekeeper が要るときに Apple の鯖から公証の記録を取りに行く（オンラインのとき。[フォーラム 116812](https://developer.apple.com/forums/thread/116812)）。ただし、Gatekeeper が見るのは quarantine のついたファイルだけ（[フォーラム 130560](https://developer.apple.com/forums/thread/130560)）。`/setup` は curl で取るので、もともと quarantine はつかない。つまり公証は、主に「ブラウザで取った人」と「BTM（ログイン項目）での開発元の表示」のための備え、とみる（後者に公証が要るかは確かでない。署名だけで足りる恐れもあるが、公証まで付けるのが安全）。
- 公証は数分〜数十分。初めてのチームの最初の提出で 24 時間以上かかった報告がある（[フォーラム 821552](https://developer.apple.com/forums/thread/821552)）。CI の時間の上限に気をつける。
- 確かめ：`codesign -vvvv -R="notarized" --check-notarization <path>`、`syspolicy_check distribution TouRyou.app`（[フォーラム 130560](https://developer.apple.com/forums/thread/130560)）。
- tar.gz の再現性：署名には時刻が入るので、ビルドし直すと sha256 が変わる。いまも「付け直しはしない」方針（release.yml）なので、扱いは変わらない。

### 3.4 `scripts/dist-build.sh` の変わり方

- 引数・環境変数で「署名する／しない」を切り替える（例：`DIST_SIGN_IDENTITY` が空なら今と同じく署名しない）。手元とフォークでは署名なしで作れるようにする。
- stage の形：`TouRyou.app/Contents/{Info.plist,MacOS/TouRyou,Resources/AppIcon.icns}` を足す。`bin/node` は `../TouRyou.app/Contents/MacOS/TouRyou` への相対リンク（#56 のリンクの検査に合う形）。
- 署名の順（3.1）・entitlements（3.2）・公証と staple（3.3）を、tar の前に足す。
- 検査を足す：`codesign --verify --strict` が全部の Mach-O で通る・チーム ID が期待と同じ・`stapler validate TouRyou.app`。
- `.icns` を作る（`iconutil`）か、リポジトリに置く。

### 3.5 `.github/workflows/release.yml` の変わり方

- `dist` のジョブに `environment: release` を付け、秘密はそこから読む。
- 署名の前に、一時のキーチェーンを作って .p12 を入れる（`security create-keychain`・`import`・`set-key-partition-list`）。ジョブの最後（`if: always()`）に消す（[GitHub：Installing an Apple certificate](https://docs.github.com/en/actions/use-cases-and-examples/deploying/installing-an-apple-certificate-on-macos-runners-for-xcode-development)）。
- API の鍵（.p8）は `RUNNER_TEMP` に書き、`notarytool --key --key-id --issuer` で使い、最後に消す。
- 外部の action は増やさず、`security`・`codesign`・`notarytool` を直に呼ぶ（いまの release.yml の作り＝SHA 留めの少数の action に合う）。
- `dist-smoke.sh` に、署名の確かめ（3.4 の検査）を足す。
- `ci.yml`（PR の CI）は署名しない形のまま。秘密を渡さない。

### 3.6 そのほかの変わり方

- `packages/cli/src/launchd.ts` の `daemonProgramArguments`：1 つ目を `<base>/current/TouRyou.app/Contents/MacOS/TouRyou` にし、`AssociatedBundleIdentifiers` を足す。古い形（`bin/node`）からの置き換えは、#64 と同じやり方（古い生成物とバイト単位で同じときだけ）。
- `install-runtime.sh`：`TouRyou.app` を含む形を受ける（許すファイルの種類の検査など）。LaunchServices への登録（`lsregister`）が要るかは確かでない（11-16 の試しでは登録した）。
- 文書：docs/release.md・docs/dist-manual-verification.md・ADR・設計書（6.5 節）。

### 3.7 作業量の見積もり（確かでない）

| 項目 | 見積もり |
|:--|:--|
| 登録（組織） | 人の手は半日。暦で 1〜4 週（待ち） |
| 証明書・API の鍵を作り、environment に置く | 半日 |
| dist-build.sh（入れ物・署名・公証・検査） | 1〜1.5 日 |
| release.yml（キーチェーン・秘密・後片付け） | 0.5〜1 日 |
| launchd.ts・install-runtime.sh・引っ越しと戻し・テスト | 1〜1.5 日 |
| 実機の試し（名前・アイコン・Gatekeeper・外したとき消えるか）と直し | 0.5〜1 日 |
| 文書・ADR | 0.5 日 |
| 計 | 人の手で **3〜5 日**＋登録の待ち |

- 最初に「手元の Mac で 1 回だけ手で署名・公証して、ログイン項目の出方を見る」試しをすると、無駄な実装を避けられる（登録が済めば出来る。CI の作業の前に行う）。

## 4. 秘密の扱い

### 4.1 置くもの

| 秘密 | 中身 |
|:--|:--|
| `MACOS_CERT_P12_BASE64` | Developer ID Application の証明書と秘密鍵（.p12 を base64） |
| `MACOS_CERT_P12_PASSWORD` | .p12 のパスワード |
| `ASC_API_KEY_P8_BASE64` | App Store Connect の API の鍵（.p8。役割は Developer のような、いちばん狭いもの） |
| `ASC_API_KEY_ID` | 鍵の ID |
| `ASC_API_ISSUER_ID` | Issuer ID |

- 一時のキーチェーンのパスワードは、ジョブの中で乱数で作る（秘密に置かない）。
- API の鍵は、Apple ID とアプリ用パスワードの道より勧める（人のアカウントに縛られない。[notarytool の man](https://keith.github.io/xcode-man-pages/notarytool.1.html)）。

### 4.2 置き場所

- リポジトリの秘密ではなく、**environment `release` の秘密**にする（[GitHub：Managing environments](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment)）。
- environment の保護：
  - 使える枝・タグを `v*` のタグだけに絞る（deployment branches and tags）。
  - 必須の承認者（required reviewers）を 1 人以上（利用者が決める。リリースのたびに承認が要る）。
  - タグの保護（ruleset で `v*` を作れる人を絞る）。
- `dist` のジョブだけが environment を使う。`release`・`marketplace-self` のジョブには秘密を渡さない。

### 4.3 public のリポジトリで気をつけること

- `pull_request_target`・`workflow_run` から、署名のジョブを呼ばない。フォークからの PR には秘密は渡らない（GitHub の仕様）が、`pull_request_target` は渡りうる（[GitHub：Security hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)）。
- 署名の前に、PR の中身（未審査のコード）を実行しない。タグは main のマージ済みのコミットに付ける（いまの docs/release.md の流れ）。
- `pnpm install` の依存の install スクリプトが、秘密のあるジョブで動く。秘密は**署名の手順の env にだけ**渡し、ジョブ全体の env に置かない。できれば、ビルドと署名のジョブを分け、ビルドの成果物を artifact で渡してから、秘密のあるジョブでは外部のコードを動かさずに署名だけする（勧める。作業が 0.5 日ほど増える）。
- ログに秘密を出さない（`set -x` を使わない。base64 を戻した中身を echo しない）。GitHub の隠しは base64 の別の形を隠せないことがある。
- action は今と同じく SHA で留める。

### 4.4 漏れたときの止め方

1. **証明書を失効**（Apple Developer の Certificates の画面で revoke）。失効すると、その証明書で署名したものが Gatekeeper で通らなくなる恐れがある（失効の日時より後の署名だけか、全部か、は Apple の扱いによる。確かでない。[Developer ID](https://developer.apple.com/support/developer-id/)）。必要なら Apple に連絡し、漏れた日時を伝える。
2. **API の鍵を失効**（App Store Connect の Users and Access → Integrations → Keys）。
3. GitHub の environment の秘密を消し、新しい証明書・鍵で入れ替える。
4. 漏れた期間に出た Release を調べ、知らない署名物がないかを見る（`codesign -dv` のチーム ID と、配った sha256 の照合）。
5. 利用者へ知らせる（新しい版への上げ）。
- 失効で既存の利用者の daemon が止まる恐れがあるので、新しい版を先に作れるよう、手順を docs/release.md に書いておく。

## 5. 方針とのつながり

- **#64「署名しない」**：変える。ADR に「Developer ID で署名・公証する。理由：ログイン項目の名前とアイコン（#73）」を足す。#64 の「実行するものを 1 つにする」は保つ（入れ物の中の node 1 つ）。
- **quarantine を外さない**：そのまま。curl で取る・付いていたら止まる、は変えない。公証は、付いた人が外さずに済む見込みを足す（ブラウザで取った人でも Gatekeeper を通る見込み。確かでない：.node は staple 出来ないので、オフラインでは通らない恐れ）。
- **.mcpb**（デスクトップアプリの拡張）：今回は対象外（JS だけ・未署名のまま）。
- **署名をやめて戻す道**：
  - dist-build.sh を「署名しない」で走らせれば、今と同じ ad-hoc の形が作れる作りにしておく（3.4）。
  - 入れ物の形は残し、署名だけをやめると、11-16 の B と同じ「TouRyou・開発元を識別できない」になる。それを避けるなら、plist を `bin/node`（公式の node をそのまま置く）に戻す版を出す（#64 と同じ置き換えの仕組み）。
  - Apple の登録は更新しなければ切れる。切れたあとも、公証済みで時刻つきの配布物は動く見込み。

## 6. 利用者に決めてほしいこと

1. 進めるか（年 99 USD と、CI に秘密を置くこと・方針の変えを受け入れるか）。進めないなら #74（案内で補う）で閉じる。
2. 組織（COMCREATE）で登録するか、個人で登録するか。組織なら、D-U-N-S の有無の確かめと、契約の権限を持つ人。
3. 誰が Apple の登録のアカウント（Account Holder）になるか。証明書と鍵を誰が作り、どこに控えを持つか。
4. environment `release` の必須の承認者を誰にするか（リリースのたびに承認が要る）。
5. 形：勧めの「D ＋ B ＋ A」（入れ物の中の node）にするか、「D だけ」（`bin/node` のまま）にするか。
6. アイコンの絵（.icns）を誰が用意するか。
7. ビルドと署名のジョブを分けるか（勧める。作業が少し増える）。
8. 署名の前に、手元の Mac で手の試し（3.7）を行うか（勧める）。

## 7. 確かでないこと

- `AssociatedBundleIdentifiers` に、チームの一致が要るか（Apple の文書で、はっきりした文を確かめきれていない）。
- D ＋ B で、入れ物のアイコンが使われるか（11-16 の B では使われなかった。理由は不明）。
- ログイン項目の開発元の表示に、公証まで要るか、署名だけで足りるか。
- node の要る entitlements（`allow-jit` だけで足りるか）。
- 証明書を失効したとき、すでに配った署名物がどう扱われるか。
- 組織の審査の日数、組織の名前の英字の綴り。
- 日本円での年会費の額。
