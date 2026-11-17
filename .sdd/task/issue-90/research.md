# #90 調べ：project 設定の marketplace の参照を固定する（リリース手順の見直し）

- 区分：調べと案。7 章の決まったことに沿って、同じ PR で実装した（リポジトリの設定の変更と tag は、管理者が行う。このセッションでは行っていない）
- 調べた日：2026-11-17
- 関連：Issue #90、PR #87（`.claude/settings.json` の `extraKnownMarketplaces`）、`docs/release.md`、`.github/workflows/release.yml`

## 1. 確かめたこと（事実）

### 1.1 リポジトリの決まり（ruleset）

公開の API（`gh api repos/comcreate/touryou/rulesets/<id>`）で読めた。

| 名前 | 対象 | 中身 | 越えてよい人 |
|:--|:--|:--|:--|
| `main` | 既定のブランチ | 削除の禁止・force push の禁止・PR 必須・必須の check | 管理者のロール（PR のときだけ） |
| `release-tags` | **`refs/tags/v*` だけ** | 作成・更新・削除を禁じる | 管理者のロール（いつでも） |

- 分かったこと：**tag の決まりは `v*` だけに効く**。`marketplace-v0.1.2` のような名前の tag は、いまの決まりの外にある。
  - そのため、案 A を「`v` で始まらない名前」で行えば、ワークフローの `GITHUB_TOKEN`（`contents: write`）で作れる**見込み**（試していない。tag を作らない約束のため）。
  - ただしその場合、その tag は**だれも守っていない**（書き込み権限のある人なら、消す・付け直すができる）。「変わらない参照」にならないので、守りとしては意味が薄い。
- `v*` の tag を作れるのは管理者だけ、は API の中身と `docs/release.md` の 3 の記述（「Bypassed rule violations … creations being restricted」のあとに `* [new tag]`）が合っている。
- クラウドのセッションからの tag の push が 403 になる件は、試していない（tag を作らない約束のため）。`docs/release.md` の 3 の記述のまま。

### 1.2 workflow

- `release.yml` は `push: tags: ["v*"]` で動く。`marketplace-self` のジョブは、Release のあと `main` から `release/marketplace-<版>` の枝を作り、`marketplace.json` の `version`・`source` を書き換えて、`GITHUB_TOKEN` で PR を出す。`GITHUB_TOKEN` の PR では CI が動かないので、`ci.yml` を `workflow_dispatch` で起こす。
- `marketplace-self` の PR のマージのあとに動くものはない（tag も settings も、いまは誰も更新しない）。
- `GITHUB_TOKEN` で push した tag では、ほかの workflow は動かない（GitHub の仕様）。`marketplace-v*` は `v*` にも当たらないので、Release は作られない。

### 1.3 `settings.json` の `ref`（隔離した設定ディレクトリで確かめた）

手順（利用者の設定・このリポジトリの `.claude/settings.json` には触れない）:

```sh
d="$(mktemp -d)"
CLAUDE_CONFIG_DIR="$d" claude plugin marketplace add "comcreate/touryou#<ref>"
CLAUDE_CONFIG_DIR="$d" claude plugin marketplace list
jq .extraKnownMarketplaces "$d/settings.json"
jq -c '.plugins[] | {version}' "$(find "$d" -name marketplace.json -path '*touryou*' | head -1)"
```

| `<ref>` | 結果 | 入った `marketplace.json` の `version` | settings に書かれた形 |
|:--|:--|:--|:--|
| `v0.1.2`（tag） | 成功（`Source: GitHub (comcreate/touryou@v0.1.2)`） | `0.1.1`（Issue の事実と同じ） | `{"source":"github","repo":"comcreate/touryou","ref":"v0.1.2"}` |
| `main`（ブランチ） | 成功（`@main`） | `0.1.2` | `{"source":"github","repo":"comcreate/touryou","ref":"main"}` |
| ない名前 | 失敗（`Remote branch … not found in upstream origin`） | — | — |

- **tag もブランチも `ref` に使える**。settings の形は `source.ref`。SHA が使えないのは Issue のとおり（`git clone --branch` と同じ扱い）。
- 確かめたのは user の設定への `marketplace add`。project の `.claude/settings.json` も同じ `source` の形を読む（PR #87 と同じ形）ので、同じに効く見込み。実装の段で、受け入れ基準の確かめとして project の形でも通す。

## 2. 案の比べ

前提：`marketplace.json` は、tag `v<版>` のあと、`marketplace-self` の PR で新しい版になる（tag `v<版>` の中は古い版）。

| 案 | 中身 | 設定の変更 | 守りの強さ | 版上げのたびの手間 | 漏れたときの気づき | 実装の大きさ |
|:--|:--|:--|:--|:--|:--|:--|
| **A'（勧める）** | `marketplace-self` の PR に、`settings.json` の `ref` を `marketplace-v<版>` にする変更を同梱。マージのあと、管理者が手元から、そのマージのコミットに `marketplace-v<版>` を付ける（`v<版>` と同じ手順の形） | `release-tags` の対象に `refs/tags/marketplace-v*` を足す（越えてよい人は管理者のまま。新しい越え手は増えない） | 強い（tag は管理者しか作れず、付け直し・削除もできない） | 管理者の tag の push が 1 回増える（版ごとに 2 回） | CI：PR で「`ref` = `marketplace-v` + `marketplace.json` の版」を照らす。`main` への push と定期で「`ref` の tag があり、その中の版が一致」を照らし、なければ失敗 | 小〜中（`release.yml` の jq に 1 行、`ci.yml` に照らしの段、`docs/release.md` に 5-a） |
| A（設定の変更つき） | マージを契機に、ワークフローが `marketplace-v<版>` を付ける | 新しい ruleset（`refs/tags/marketplace-v*`）。作成は「GitHub Actions」を越えてよい人に足す。更新・削除は管理者だけ（越え手を分けるため、ruleset を 2 つにする） | やや強い（付け直し・削除は防げる。作成は、書き込み権限で動く workflow ならどれでも可能になる。`v*` は変わらず管理者だけ） | なし（自動） | ワークフローの失敗。A' と同じ CI の照らし | 中（新しい workflow かジョブ、ruleset 2 つ） |
| A（設定の変更なし） | 同上。名前が `v*` の外なので、いまの決まりのまま作れる見込み | なし | **弱い**（tag を誰も守っていない。書き込み権限で付け直せる） | なし | 同上 | 中 |
| B | zip を tag の前に再現できる形で作り、`marketplace.json` を tag に含める | なし | 強い | なし | ビルドの照合の失敗 | 大（再現できるビルド・リリースの流れの作り直し） |
| C | 固定しない。`enabledPlugins` を外し、手で入れる | なし | 弱い（自動で入る経路はなくなる） | なし | — | 小 |
| D | `ref` を保護したブランチ `marketplace` にする。`marketplace-self` の PR の行き先を `marketplace`（と `main`）にする | 新しい branch の ruleset（`marketplace`：PR 必須・必須の check・force push と削除の禁止） | 中（不変ではない。動くのは marketplace の PR のマージのときだけ。`main` の任意のコミットには追従しない） | なし（`settings.json` は変えない） | 2 つの枝の `marketplace.json` のずれを CI で照らす | 中（PR の行き先、枝の作成、2 つの枝を合わせる仕組み） |

補足：

- A' と A の違いは「tag を誰が作るか」だけ。いまの運用（`v*` は管理者が手元から）と同じ形にするのが A'。A は、手間がなくなる代わりに、tag を作れる者に「GitHub Actions」を加える（`v*` の守りには響かないが、`marketplace-v*` の作成は、書き込み権限のある人が workflow を通して行えるようになる）。
- D は手間がいちばん少なく、利用者が古い版に残る問題もない。ただ「変わらない参照（tag）に固定する」という Issue の目的には届かない。守りの強さは `main` の保護と同じ種類（書き込み権限＋PR）で、違いは「marketplace の PR だけで動く」こと。
- 固定（A'・A）にすると、`settings.json` が新しい tag を指すまで、project の利用者は前の版に残る。A' では `ref` の変更を `marketplace-self` の PR に同梱するので、`main` を取り込めば、tag が付いた時点で新しい版になる。

### 2.1 A' の順番の確かめ（鶏と卵にならないか）

1. `marketplace-self` が、`marketplace.json`（新しい版）と `settings.json`（`ref: marketplace-v<新しい版>`）を 1 つの PR にする。
2. PR の CI：名前の一致（`ref` = `marketplace-v` + `marketplace.json` の版）だけを照らす（tag はまだない）。
3. マージ。この時点の `main` は、まだない tag を指す。tag ができるまで、project の設定での marketplace の取得は失敗する（「not found」）。**この間をどれだけ短くできるか**が A' の弱み。
4. 管理者が、そのマージのコミットに `marketplace-v<版>` を付けて push（`docs/release.md` の 3 と同じ確かめつきの script）。
5. `main` への push と定期（日に 1 回など）の CI：`ref` の tag があること、その tag の `marketplace.json` の版が `ref` の版と同じこと。なければ失敗（漏れに気づく）。

3 の空白を避けたいときは、`settings.json` の `ref` を別の PR（tag のあと）にする形もある。その場合は、空白の代わりに「古い版に残る」間ができ、PR が 1 つ増える。勧めは同梱（失敗は目に見え、tag を付ければ直る。古い版に黙って残るより気づきやすい）。

## 3. 勧める案と理由

**A'** を勧める。

- 固定の参照は、それを作る側（リリースの仕組み）が責任を持つ、という原則に合う。tag は `v*` と同じく管理者が作り、ruleset で付け直し・削除を禁じるので、本当に変わらない。
- 設定の変更は、今ある `release-tags` の対象に 1 つの形を足すだけ。tag を作れる者は増えない（守りが弱くならない）。
- 管理者の手間は、版ごとに tag の push が 1 回増えるだけ。漏れは CI で失敗として見える。
- A（自動）は手間は減るが、tag を作れる者に GitHub Actions を加える。D は手間が最も少ないが、目的（不変の参照）に届かない。B は大きすぎる。C は目的を下げる。

次点は D（固定の強さより、手間のなさ・古い版に残らないことを重んじるなら）。

## 4. 決めてほしいこと

1. 案：A'（勧める）／A（設定の変更つき、自動）／D／ほか。
2. **リポジトリの設定の変更**（どの案も、守りを効かせるには要る。管理者が行う）:
   - A'：`release-tags` の対象に `refs/tags/marketplace-v*` を足す。
   - A：新しい ruleset を 2 つ（作成：越え手に GitHub Actions、更新・削除：管理者だけ）。
   - D：`marketplace` の枝を作り、branch の ruleset（PR 必須・必須の check・force push と削除の禁止）を足す。
3. A' のとき、`ref` の変更を `marketplace-self` の PR に同梱するか（勧める。マージから tag までの間、取得が失敗する）、tag のあとの別の PR にするか（その間は古い版に残る）。
4. tag の名前：`marketplace-v<版>` でよいか（`v*` に当たらない名前にする必要がある。`v*` に当たると Release が作られる）。

## 5. 実装の段で変えるファイル（A' のとき）

- `.github/workflows/release.yml`：`marketplace-self` の jq で、`.claude/settings.json` の `extraKnownMarketplaces.touryou.source.ref` も `marketplace-v<版>` に書き換える。PR の本文に、マージのあとの tag の手順を書く。
- `.github/workflows/ci.yml`（または `scripts/check.sh`）：名前の一致の照らし（PR）。`main` への push と定期で、tag の存在と中の版の照らし。
- `.claude/settings.json`：`ref` を足す（最初は `marketplace-v0.1.2`。その tag を管理者が、`marketplace.json` が 0.1.2 になったコミットに付ける）。
- `docs/release.md`：5 のあとに「5-a marketplace の tag」（管理者の手順と script）、「公開のリポジトリの設定」の表に `marketplace-v*` を足す。
- `CHANGELOG.md`：`## 未公開` に項を足す。

## 6. 受け入れ基準の見直し（案）

- [ ] marketplace 用の tag（`marketplace-v<版>`）が、`marketplace.json` が新しい版を指すコミットに付く（版ごとに 1 つ。付け直さない。ruleset で管理者だけが作れ、更新・削除できない）
- [ ] `settings.json` の `ref` を、その tag に固定すると、plugin の最新版（0.1.2 以降）が入ることを、隔離した設定ディレクトリで確かめる（user の設定と、project の `.claude/settings.json` の形の両方）
- [ ] 版を上げたとき、`marketplace-self` の PR が `settings.json` の `ref` も更新する。名前が合わなければ PR の CI が失敗する。tag が付いていなければ `main` の CI（push・定期）が失敗する
- [ ] `release.yml`・`ci.yml`・`docs/release.md` が、新しい手順に合っている。`bash scripts/check.sh` が通る
- [ ] PR #87 の `.claude/settings.json` が、固定した参照になる（または、この Issue のあとに更新する旨を PR に書く）
- （D を採るときは、1 つ目を「`marketplace` の枝が保護され、marketplace の PR のマージでだけ進む」に、3 つ目を「2 つの枝の `marketplace.json` が一致することを CI が照らす」に置き換える）

## 7. 決まったこと（2026-11-17）

1. 案は A'（tag は管理者が手元から付ける）。
2. 設定の変更はしてよい：`release-tags` の対象に `refs/tags/marketplace-v*` を足す（管理者が手元で行う。コマンドは `docs/release.md` の「公開のリポジトリの設定」）。
3. `settings.json` の `ref` の変更は、`marketplace-self` の PR に同梱する。
4. tag の名前は `marketplace-v<版>`。

最初の切り替えの順番（`docs/release.md` の「最初の切り替え」）：ruleset の変更 → `marketplace-v0.1.2` を #78 のマージのコミットに付ける → この PR のマージ。

確かめたこと（実装の段）：

- ruleset のコマンド：作り物の `gh`（読み取りの API で取った本物の ruleset の JSON を返す）で、`y` のときだけ PUT されること、PUT の中身は `include` に 1 つ足しただけで、ほかは同じこと、2 回通しても足されるのは 1 つだけのこと、名前で 1 つに決まらないときは止まることを確かめた。bash で確かめた（このコンテナに zsh はない）。本物の PUT はしていない。
- tag のコマンド：手元の bare のリポジトリを上流にして、いまの `main` で #78 のマージのコミットに付くこと、上流にすでにあるとき・版が変わらないコミットのとき・手元の tag が別のコミットを指すときに止まることを確かめた。本物の上流には tag を付けていない。
- 照らし：`scripts/marketplace-ref.test.mjs`（作り物のリポジトリで、name・tag の通る・失敗するの組み合わせ）。
