# リリースと marketplace への載せ方

plugin は、このリポジトリの marketplace（`.claude-plugin/marketplace.json`）から配ります。配り方は、Release に付けた `plugin/` の zip を、marketplace.json の `source`（`"source": "archive"`）で指す形です。利用者は、だれでも次の 3 つで入れられます（認証は要りません。`/setup` の配布物の取得も、認証なしの `curl` です）。

```text
claude plugin marketplace add comcreate/touryou
/plugin install touryou@touryou
/touryou:setup
```

## 版の決まり

- 版は semver。`plugin/.claude-plugin/plugin.json`・ルートと `packages/*` の `package.json` の `version` を、すべて同じ版にそろえる（`release.yml` の `version` のジョブが、タグと plugin.json・ルートと `packages/*` の package.json が同じでなければ失敗する）。
- `CHANGELOG.md` に、同じ版の節を作る（`release.yml` は CHANGELOG を見ないので、準備の PR のレビューで確かめる）。節は `## <版>（<tag の日 YYYY-MM-DD>）` とし、中を「利用者に見える変更」「内部の変更」「上げ方」に分ける。項は `- **題**（#N）: 説明`。`## 未公開` の項は、この節に移す（`## 未公開` の見出しは残す）。準備の PR では日付を `YYYY-MM-DD` のままにし、tag を付ける日に直す（直す PR を tag の前にマージする。tag は、直したコミットに付ける）。
- 準備の PR では、前の版の tag からマージされた PR に、項の抜けがないかを `git log v<前の版>..origin/main --oneline` で確かめる。
- 版に `-` があれば（例: `0.2.0-rc.0`）、Release は pre-release になる。
- 最初の公開は `0.1.0`（決定）。

## リリースの手順

1. 版をそろえる（上の「版の決まり」）。準備の PR（`release: <版> の準備`）を出し、マージする。
2. `bash scripts/check.sh` と `claude plugin validate plugin` が通ることを確かめる。
   - **2-a 新しい /setup の実機の確かめ**（tag の前。導入の script・`setup.md`・hooks を変えたときは必ず行う）: `docs/setup-verification.md` の A。手元の `plugin/` の写しに、直前の Release の `.sha256` から作った `checksums.json` を置き、`claude --plugin-dir <写し>` で `/touryou:setup` を通す（S10〜S13）。取得先は本番のまま、script には手を入れない。直前の Release に #56 の壊れたリンクがあるとき（v0.1.0）は、フォークの rc で A' を行う（下の「本番の前の検証」で rc の Release を作り、その zip を写しにして、手元の写しだけ取得先をフォークに書き換える）。
3. main にマージしたあと、タグを付けて push する（タグは `v` + plugin.json の `version`。違うと失敗する）。書き込みの権限のあるアカウントで、clone のディレクトリで実行する（`gh api repos/comcreate/touryou --jq .permissions.push` が `true` であること）。zsh の対話に貼れるように、コメント行（`#`）は入れていない。

   ```sh
   (
   set -eu
   git switch main && git pull --ff-only origin main
   v="$(jq -r .version plugin/.claude-plugin/plugin.json)"
   git fetch origin main --tags
   if git ls-remote --exit-code --tags origin "refs/tags/v${v}" >/dev/null; then echo "上流に v${v} があります。止めます"; exit 1; fi
   if git rev-parse -q --verify "refs/tags/v${v}" >/dev/null; then
     if [ "$(git rev-parse "v${v}^{commit}")" != "$(git rev-parse origin/main)" ]; then echo "手元の v${v} が origin/main を指していません。git tag -d v${v} で消してから、やり直してください"; exit 1; fi
   else
     git tag "v${v}" origin/main
   fi
   git --no-pager log -1 --oneline "v${v}"
   git push origin "v${v}"
   )
   ```

   push が拒否されても、手元にタグが残る。やり直しは、権限を直してから、もう一度実行する（手元のタグが origin/main を指していれば、そのまま push に進む。`-f` は使わない）。

4. `.github/workflows/release.yml` が、`plugin/` の中身を根にした zip（`touryou-<版>.zip`）と、その `.sha256` を Release に付ける。sha256 と URL は、実行の Summary に出る。Release は不変に扱う（付け直し〔`--clobber`〕はしない。Release がすでにあれば、ワークフローは失敗する。やり直し方は、下の「やり直す」）。
   同じ実行で、macOS（**arm64 のみ**）の配布物（Node 同梱の `touryou-<版>-darwin-arm64.tar.gz` と `.sha256`）を作り、展開して daemon が起動する確認（smoke。`scripts/dist-smoke.sh`）を通したものだけを、同じ Release に付ける（失敗すると、Release は作られない）。smoke は、はじめに、利用者の `/setup` と同じ中身の検査（`scripts/dist-check.sh`。`plugin/scripts/install-runtime.sh` を source して `check_list`・`check_types`・`check_kinds`・`check_links` を使い、行き先のないリンクも断る）を tar.gz に当てる。`scripts/dist-build.sh` は、lib の外を指す・行き先のないシンボリックリンク（pnpm deploy が残す `.pnpm/node_modules/@touryou/daemon`）を取り除き、取り除いたものをビルドの出力に出す（#56）。あわせて、Claude デスクトップアプリの拡張機能 `touryou-mcp-<版>.mcpb` と `.sha256` も作る（`scripts/mcpb-build.sh`。JS だけ・未署名。`docs/desktop-extension.md`）。Release の asset は、zip・tar.gz・.mcpb と、それぞれの `.sha256` の 6 ファイル。配布物の sha256 は `checksums.json`（`scripts/make-checksums.mjs` が、リリースの実行の中で `plugin/` に書く。リポジトリにはない）に入れ、zip に入れる。利用者の `/setup` が、plugin の中の `scripts/install-runtime.sh` で、これと照合する（script も zip に入り、許可リストで `scripts/install-runtime.sh`・`scripts/runtime-version-notice.sh` だけを通す）。
5. `marketplace-self` のジョブが、`.claude-plugin/marketplace.json` を新しい版に書き換える PR を出す。中身（3 つの値）を確かめてマージする。PR が出なければ、Summary の値で手で直して PR を出す（Release はそのままでよい）。
6. **tag の後の確かめ**（marketplace の PR のマージの前と後）: マージの前に、Release の zip の `checksums.json` を確かめる（`unzip -p touryou-<版>.zip checksums.json`）。マージのあとに、前の版を入れた Mac で update → `/touryou:setup`（S12）→ Q8。手順は `docs/setup-verification.md` の C。不具合が出たら、版を上げて直す（Release は付け直さない）。

## 配布物では効かない、開発用の抜け道

`TOURYOU_CLI_ALLOW_UNVERIFIED=1`（`touryou` が daemon の身元を確かめずに動く。試験用）は、**手元の開発のビルド（`pnpm build`）だけで効き、配布物では効かない**。`scripts/dist-build.sh` が、配布物の中の `@touryou/cli/dist/dev-build.js` の `DEV_BUILD` を `false` に書き換え、書き換えられなければ配布物を作らない（`docs/cli.md`）。`touryou-mcp --stdio` には、検証なしで動く道はない（`docs/daemon-identity.md`）。

## 対象の OS・CPU

配布物の対象は、**macOS の arm64（Apple Silicon）のみ**（決定）。`dist` の matrix は `macos-15` だけ。**macOS の Intel（x64）と Windows（x64）は、将来の課題**（Linux も対象外）。`scripts/dist-build.sh` は、x64 の分岐を残している（手元の確認のため）が、リリースには使わない。

**macOS の Intel（x64）を足すとき**: `dist` の matrix に runner を足し、`make-checksums.mjs` の `TARGETS`、`release.yml` のファイル数・取り直しの照合の対象を広げ、実機（Intel の Mac）で確かめる。

**Windows（x64）を扱うときに、作り直す範囲**（実装はしていない。見積もりの手がかり）:

- 配布物: Windows 用のビルド（Node の公式の Windows 版、`better-sqlite3` の Windows 用バイナリ。zip 形式が自然）、`dist-build.sh` の置き換え（bash 前提）、署名（SmartScreen への影響）
- `/setup`: 導入の script（`plugin/scripts/install-runtime.sh`）と `shasum`・`chmod`・`tar` は、macOS・POSIX 前提。PowerShell などへの置き換え
- hook・起動スクリプト: POSIX シェル（`#!/bin/sh`）前提の起動スクリプトと、hook の呼び出し（`hooks.json` の command）の Windows 対応
- 常駐化: launchd の代わり（タスクスケジューラ・Windows サービス）
- パスの扱い（`realpath` の検査・作業ツリー）・シェル・プロセスの終了処理・`git worktree` の検証

## marketplace.json の項目

| marketplace | 置き場所 | 更新 |
|:--|:--|:--|
| このリポジトリの marketplace（名前 `touryou`） | `.claude-plugin/marketplace.json` | `release.yml` の `marketplace-self` が、同じリポジトリへの PR を出す（`GITHUB_TOKEN`。App・secrets は要らない） |

項目の形（認証なしで取れる Release の zip を指す）:

```json
{
  "name": "<plugin.json の name>",
  "description": "<plugin.json の description>",
  "version": "<版>",
  "source": {
    "source": "archive",
    "url": "https://github.com/<owner>/<リポジトリ>/releases/download/v<版>/<zip の名前>",
    "sha256": "<zip の sha256>"
  }
}
```

- `url` は Release の `browser_download_url`（認証なしで取れる）。`headersHelper`・`strict: false` は付けない（ジョブは、書き換えのときに、残っていれば外す）。
- `marketplace-self` は、項目がなければ足し、あれば `source`・`version` だけを書き換える。`name`・`description` は `plugin/.claude-plugin/plugin.json` から取る。最初の Release のあとに出る PR が、最初の項目を足す（手の作業は要らない）。
- `GITHUB_TOKEN` で出した PR では、CI（`pull_request`）が動かない（GitHub の仕様）。そのため `marketplace-self` は、PR を出したあとに、そのブランチを ref にして `ci.yml` を `workflow_dispatch` で起こす（`GITHUB_TOKEN` からでも `workflow_dispatch` は新しい run を起こせる。ジョブの権限に `actions: write` を足している）。その run の check（`check (ubuntu-latest, node 22)`・`check (ubuntu-latest, node 24)`）が PR の head のコミットに付くので、CI が通れば、管理者の権限なしでマージできる。
- check が PR に付かないとき（dispatch が失敗した・run が見えない）は、Actions の画面で `CI` を `release/marketplace-<版>` のブランチで手で実行する（Run workflow）。それでも付かないときだけ、中身（3 つの値）を手で確かめ、管理者の権限でマージする。
- 項目の `sha256` は、zip（中に `checksums.json` を含む）のもの。

## 公開のリポジトリの設定（新しいリポジトリを作ったときに、管理者が行う）

`release.yml`・CI を動かすのに要る設定です。

| 設定の場所 | 設定 | 理由 |
|:--|:--|:--|
| Settings → Actions → General → Actions permissions | Actions を有効にする（「Allow all actions and reusable workflows」か、使っている action〔`actions/checkout`・`actions/setup-node`・`actions/upload-artifact`・`actions/download-artifact`・`pnpm/action-setup` など。ワークフローは SHA で固定〕を許す） | ワークフローが動くため |
| Settings → Actions → General → Workflow permissions | 「Read repository contents and packages permissions」（既定）か「Read and write permissions」のどちらでもよい（ジョブは要る権限〔`contents: write`・`pull-requests: write`・`actions: write`（`cleanup` と、`marketplace-self` の `ci.yml` の dispatch）〕を `permissions:` で明示している。明示が組織の制限で効かないときは「Read and write permissions」にする）。**「Allow GitHub Actions to create and approve pull requests」を有効にする** | `marketplace-self` が `GITHUB_TOKEN` で PR を作るため（無効だと、ブランチの push までは成功し、`gh pr create` が失敗する）。ジョブは必要な権限（`contents: write` など）を自分で明示している。組織の設定で禁じられていると、リポジトリでは有効にできないので、先に組織の Settings → Actions → General で許す |
| Settings → Actions → General → Fork pull request workflows | 「Require approval for first-time contributors」以上にする | 外の人の PR で、ワークフローが黙って動かないように |
| Settings → Branches（または Rules → Rulesets）で `main` | PR を必須にする（直接の push を禁じる）・force push と削除を禁じる・必須の check に `ci.yml` の check を入れる（下の注） | 壊れた main からタグを付けないため |
| Settings → Rules → Rulesets（タグ） | `v*` のタグの作成・更新・削除を、管理者（リリースする人）だけにする | タグの push が Release を作るため。だれでも `v*` を push できると、Release が作られる |
| Settings → Code security | Private vulnerability reporting を有効にする。Dependabot alerts・Secret scanning・Push protection を有効にする | `SECURITY.md` の窓口のため |
| Settings → General | Issues を有効にする。Wiki・Projects は任意 | |
| Settings → General → Pull Requests | **「Allow auto-merge」を有効にする** | `dependabot-auto-merge.yml` が Dependabot の PR に auto-merge を付けるため（無効だと `gh pr merge --auto` が失敗し、PR は人のマージを待つ） |

- 必須の check の注: 必須にするのは `ci.yml` の `check (ubuntu-latest, node 22)`・`check (ubuntu-latest, node 24)`（名前を変えると必須の check が「待ち」のままになるので、変えるときは ruleset も合わせる）。`ci.yml` は `paths`・`paths-ignore` を使わず、どの PR でも動く（docs などだけの変更では、ジョブの中で重い段を飛ばして成功で終える）。`ci-macos.yml` はコードが変わったときだけ動く（`paths`）ので、必須にしない（動かなかった check を必須にすると「待ち」のままになる）。
- secrets・variables は、どれも要らない（`GITHUB_TOKEN` だけを使う）。

## Actions の artifact の容量

`dist` の配布物は 1 回あたり約 150MB。Actions の artifact の保存容量を使い切らないように、次のようにしている。

- `dist-smoke.yml` は、PR では artifact を上げない（手で実行したときだけ、1 日の保存）。
- `release.yml` の `dist` の artifact は 1 日の保存で、`release` が成功したときだけ、`cleanup` のジョブ（権限は `actions: write` だけ）が、その run の artifact を消す。`release` が失敗・skipped・cancelled のときは消さない（1 日の保存期限まで残るので、その間は `release` だけを再実行できる）。
- 容量が尽きて `Artifact storage quota has been hit` で失敗したときは、容量が戻るのを待ってから、タグを付け直す（下の「やり直す」）。

## CI のワークフロー

| ワークフロー | runner | 動くとき |
|:--|:--|:--|
| `ci.yml` | ubuntu（node 22・24） | push（main）・PR・`workflow_dispatch`（`release.yml` の `marketplace-self` が起こす。手でも起こせる）。いつも動く（必須の check のため）。`docs/**`・`.sdd/**`・`CHANGELOG.md`・`README.md`・`LICENSE` だけの変更では、checkout と変更の判定（`scripts/ci-code-changed.sh`）のあとの段を飛ばし、すぐ成功で終える。`workflow_dispatch` と、差分を取れないときは、すべて走らせる |
| （同じ `ci.yml` の check の中） | | `check (ubuntu-latest, node 22)` の job で（node 24 の job では飛ばす）、どの変更でも（docs だけでも）、コミットのメールを確かめる（`scripts/ci-commit-emails.sh`）。author・committer・本文の `Co-authored-by` のメールが、GitHub の noreply（`<番号>+<名前>@users.noreply.github.com`。github-actions のボットも含む）・GitHub の `noreply` のアドレス・Anthropic の `noreply` のアドレス（正確な一覧は `scripts/ci-commit-emails.sh`）のどれかでなければ失敗する。範囲は、PR では base と head の間、push では before と after の間（新しいブランチ・force push で before が取れないときは、ほかのブランチにない after のコミット）。失敗の文には、コミットの短い番号と欄だけを出し、アドレスは出さない |
| `ci-macos.yml` | macos-15（node 24） | push（main）・PR で、`packages/**`・`scripts/**`・`plugin/**`・`package.json`・`pnpm-lock.yaml`・`pnpm-workspace.yaml`・`biome.json`・`tsconfig*.json`・自分の yml が変わったときだけ（`paths`）。必須の check ではないので、`paths` のまま（毎回は動かさない） |
| `dist-smoke.yml` | macos-15 | PR で、配布物に関わるファイルが変わったときだけ |
| `release.yml` | macos-15（dist）・ubuntu | タグの push のとき |
| `dependabot-auto-merge.yml` | ubuntu | Dependabot の PR（`pull_request`）のとき。下の「Dependabot の actions の更新と自動マージ」 |
| `dependabot-main-ci.yml` | ubuntu | Dependabot の PR の `ci.yml` が成功で終わったとき（`workflow_run`）。マージを待って、main で `ci.yml` を起こす |

- macOS の runner は、ubuntu より実行の費用が大きい（public のリポジトリの標準の runner は、無料の枠の扱いが違う。GitHub の公式の記載を確かめる）。そのため、macOS は必要なときだけ動かす。
- コミットのメールの確かめで落ちたら: GitHub の Settings → Emails で「Keep my email addresses private」を有効にし、`git config user.email "<番号>+<名前>@users.noreply.github.com"` を設定して、外れたコミットを直してから push し直す（squash のマージでは、PR のコミットの author が本文の `Co-authored-by` に入るため）。
- どれも `concurrency` で、同じ ref（PR）の前の実行を止める。
- 形は `scripts/ci-workflow.test.mjs`・`scripts/release-workflow.test.mjs` で確かめる。
- runner は `macos-15`（arm64）に固定している（`macos-latest` は使わない）。`macos-15` の runner image の廃止が告知されたら（GitHub の changelog）、3 つのワークフローの runner を、まとめて次の版に移す。配布物の中身（公式の Node・npm の prebuild）は、runner の版に依存しない見込み。

## Dependabot の actions の更新と自動マージ

workflow の actions（SHA で固定し、`# vX.Y.Z` の注釈を付けている）の版の上げは、Dependabot が行う（`.github/dependabot.yml`）。npm の依存は対象にしない（pnpm の `minimumReleaseAge` で守る）。

- **Dependabot がすること**: 週に 1 回（月曜の JST 05:23。日本の朝の作業の前で、毎時 0 分の混む時刻を避ける）、`.github/workflows/` の actions を調べ、patch・minor の上げを 1 本の PR にまとめる（`groups` の `update-types: [minor, patch]`）。メジャーの上げは group に入れず、actions ごとの別の PR になる（メジャーが 1 つ混じるだけで、patch・minor の自動マージが止まらないように）。公開から 14 日たった版だけを使う（`cooldown` の `default-days: 14`。github-actions では semver ごとの日数は効かない。security updates には cooldown は効かない）。SHA と `# vX.Y.Z` の注釈を、いっしょに上げる。コミットの文は `[update] ` で始め、ラベルは `chore`。
- **自動でマージするもの**（`dependabot-auto-merge.yml`）: PR を出したのが `dependabot[bot]` で、このリポジトリで、`dependabot/fetch-metadata` の package-ecosystem が `github_actions`、update-type が semver-patch か semver-minor（まとめた PR では、いちばん大きい上げ。group はメジャーを含まない）、変わったファイルが `.github/workflows/` の yml だけのとき、auto-merge（squash）を付ける。マージは GitHub が、ruleset の必須の check（`check (ubuntu-latest, node 22)`・`(node 24)`）が通ってから行う（承認は要らない）。
- **人がレビューするもの**: メジャーの上げの PR（actions ごとに別）・`.github/workflows/` の外を変える PR・Dependabot でない PR。auto-merge は付けない（push し直しで対象から外れたら、付いていた auto-merge を外す）。統括がレビューしてマージする。
- **守り**: `pull_request_target` を使わない。checkout しない（PR のコードを動かさない）。権限は `contents: write`・`pull-requests: write` だけ。actions は SHA で固定する。Dependabot が起こした `pull_request` の `GITHUB_TOKEN` は既定で読み取りだけなので、`permissions:` で明示する。
- **main の CI**: `GITHUB_TOKEN` で付けた auto-merge のマージは、main への push の workflow を起こさない。そのため `dependabot-main-ci.yml` が、Dependabot の PR の `ci.yml` が成功で終わったら（`workflow_run`）、その PR のマージを最大 10 分待ち、マージされたら main で `ci.yml` を `workflow_dispatch` で起こす（`release.yml` の `marketplace-self` と同じ形。権限は `actions: write`・`pull-requests: read`）。10 分のうちにマージされなければ、run を失敗にする（要約にも書く）ので、マージのあとに手で main の `ci.yml` を起こす。人が Dependabot のブランチに足したコミット・人が起こし直した run では、auto-merge も main の CI の起こし直しもしない（`github.actor`・`triggering_actor` が `dependabot[bot]` のときだけ）。`ci-macos.yml` は main で起こさない（workflow だけの変更では、`ci-macos.yml` の `paths` に当たらないため）。
- **workflow のファイルのマージが拒まれることがある（まだ確かめていない）**: `GITHUB_TOKEN` は `workflows` の権限を持てないため、`.github/workflows/` を変える PR の auto-merge によるマージが拒まれることがある。最初の Dependabot の PR で確かめる。確かめ方: PR の画面の auto-merge の状態（付いたまま必須の check が通ってもマージされない・外された、のどれか）と、Actions の `Dependabot auto-merge`・`Dependabot main CI` の run の記録（`gh pr merge --auto` の結果、マージを待つ段の結果）。拒まれたら、統括（人の流れ）がレビューしてマージする。
- **要る設定**: Settings → General → Pull Requests の「Allow auto-merge」（上の「公開のリポジトリの設定」）。
- コミットのメール: Dependabot のコミット（author は `dependabot[bot]` の `users.noreply.github.com`、committer は GitHub の `noreply`）と squash のコミットは、`scripts/ci-commit-emails.sh` の許す形に入る（`scripts/ci-workflow.test.mjs`）。
- 形は `scripts/dependabot-workflow.test.mjs` で確かめる。

## やり直す

tar.gz は、ビルドし直すと sha256 が変わり得ます。zip の中の `checksums.json` も連動して変わるので、**同じタグで Release の asset だけを付け直すと、marketplace.json の sha256 と食い違い、install が失敗します**。そのため、ワークフローは、Release がすでにあれば失敗します。やり直すときは次の順にします。

1. `marketplace-self` が出した PR があれば、閉じる。
2. Release を削除する（`gh release delete <タグ> --cleanup-tag` または、画面から Release とタグを削除）。
3. 原因を直したうえで、タグを付け直して push する（版を上げるほうが安全）。

marketplace への PR だけが出なかった（Release は正しく作られた）場合は、Release を消さず、手で PR を出します。`dist` の artifact だけが消えた（保存は 1 日）場合は、`release` だけの再実行ではなく、全体をやり直します。

## 本番の前の検証（フォークで行う）

この検証は release.yml のためのもの。本番の取得先に固定された /setup は、そのままでは通せない。/setup の確かめは 2-a で行う（`docs/setup-verification.md`。直前の Release が v0.1.0 のときは、ここで作った rc の Release で A' を行う）。

目的: release.yml を、本番のリポジトリに触れずに、タグの push から Release の作成・照合まで通して確かめる。フォークの名前・アカウント名は、`<自分のアカウント>` と書く（値を文書に残さない）。

| 確かめる | 確かめない |
|:--|:--|
| `version` の照合・semver の検査 | 本番の marketplace.json への反映 |
| `dist`（macos-15）が、ビルド・smoke・artifact まで通る | 上流のリポジトリの設定（権限・保護） |
| `release` の、配布物の検査・`checksums.json` の生成・zip の許可リスト・Release の作成・asset 6 ファイルの取り直しと sha256 の照合 | |
| `marketplace-self` が、fork の中に PR を出す（fork で「Allow GitHub Actions to create and approve pull requests」を有効にしたとき） | |
| 2 回目の実行が「Release がすでにある」で失敗すること | |

準備: fork を作り、fork の Actions を有効にする（fork では既定で無効）。手元で fork を clone し、`origin` が fork であることを確かめる（**上流に push しない**。`git push --tags` は使わない）。

フォークで分かっていること（v0.1.1 の前に試したとき）:

- **作った直後のフォークには、ワークフローが 1 つも登録されていない**（`gh api "repos/<自分のアカウント>/touryou/actions/workflows" --jq .total_count` が `0`）。このままタグを push しても、何も起きない。先に、フォークの main を本番の main に追いつかせる push をすると、登録される（下のコマンド。`origin` は fork）。

  ```sh
  git fetch https://github.com/comcreate/touryou main && git push origin FETCH_HEAD:main
  ```

- **コミットのメールが非公開のアドレスだと、push が `GH007` で断られる**。fork の clone の中だけ、noreply にする（値は文書に書かない）。

  ```sh
  git config user.email "$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')"
  ```

- **実行の確かめ**は、`gh run list --workflow release.yml` だと、登録の前は 404 になる。`gh api "repos/<自分のアカウント>/touryou/actions/runs" --jq '.workflow_runs[] | [.name, .event, .status, .conclusion, .head_branch] | @tsv'`（または `--workflow` なしの `gh run list --repo <自分のアカウント>/touryou`）で見る。
- **登録のあとでも、push で動きが起きないことがある**。v0.1.1 の前に試したときは、フォークへの push が出来事（events API の `PushEvent` など）として記録されず、タグの push で release.yml が起きなかった。同じタグを消して push し直しても、新しい rc のタグでも起きなかった。手で起こした実行（`workflow_dispatch`）は動いた。そのときは、次のようにする（**本番の release.yml には足さない**）。
  - 検証用の枝（`verify-release`）の `.github/workflows/release.yml` にだけ、`on:` に `workflow_dispatch:` を足してコミットする。
  - 新しい rc のタグを付けて push し、`gh workflow run release.yml --repo <自分のアカウント>/touryou --ref "v${v}"` で起こす。タグを ref にするので、`GITHUB_REF_NAME` はタグの名前になり、`version` の照合が通る。これで Release の作成・照合・`marketplace-self` まで通った。
- **同じタグの出し直しは、起きないことがある**。やり直しは、新しい rc の番号（`0.1.1-rc.1`、`0.1.1-rc.2`、…）で行う。

検証用の版は、本番で使わない pre-release にする（例: `0.1.1-rc.0`。やり直すたびに番号を上げる）。上流に同名のタグがないことを、先に確かめる。

```sh
acct=<自分のアカウント>
v=0.1.1-rc.0
(
  set -euo pipefail
  url="$(git remote get-url origin)"
  case "${url}" in
    *"comcreate/"*) echo "origin が上流です。止めます: ${url}" >&2; exit 1 ;;
    *"/${acct}/"*|*":${acct}/"*) ;;
    *) echo "origin が fork（${acct}）ではありません。止めます: ${url}" >&2; exit 1 ;;
  esac
  [ -z "$(git ls-remote --tags origin "v${v}")" ] || { echo "fork にすでに v${v} がある" >&2; exit 1; }
  [ -z "$(git ls-remote --tags https://github.com/comcreate/touryou "v${v}")" ] || { echo "上流に v${v} がある。別の版にする" >&2; exit 1; }
  git switch -c verify-release origin/main
  for f in plugin/.claude-plugin/plugin.json package.json packages/*/package.json; do
    jq --arg v "${v}" '.version = $v' "${f}" >| "${f}.new" && command mv -f "${f}.new" "${f}"
  done
  git --no-pager diff --stat
  git commit -am "verify: 検証用の版 ${v}"
  git push -u origin verify-release
  git tag "v${v}"
  git push origin "v${v}"
)
```

確かめたあと、Release の asset を利用者と同じ形で取り、照合する（`shasum -a 256 -c` が `OK`）。Mac での起動・quarantine の確かめは `docs/dist-manual-verification.md`。照合が通ったら、`docs/setup-verification.md` の A'（この rc の Release で /setup を確かめる）に進む。

```sh
d="$(mktemp -d)" && cd "${d}"
gh release download "v${v}" --repo <自分のアカウント>/touryou
shasum -a 256 -c ./*.sha256
unzip -p touryou-*.zip checksums.json | jq .
```

後始末: **A' が済んでから**、fork の Release・タグ・ブランチを消す（A' はこの Release から取るので、先に消すと通せない）（fork ごと消してもよい）。手元の clone では、`git switch main` のあとで `git tag -d "v${v}"`・`git branch -D verify-release`。

### 採用しない案

- 本番のリポジトリに pre-release のタグを push して確かめる案: Release と marketplace の PR が実際に出るので、後始末が要り、取り消しにくい。
- `workflow_dispatch` の dry-run（Release を作らず、artifact と検査までで止める）: Release の作成・取り直しの照合（release.yml の中心）を通せない。
