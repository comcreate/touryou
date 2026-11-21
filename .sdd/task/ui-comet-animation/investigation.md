# 関係図の玉を「彗星のグラデーション」にする調査

状態画面の関係図で、線の上を走る「丸い玉」を、「彗星のような光のグラデーション」に変えるための調査。実装はしていない。対象は touryou 0.1.5・main。

- **事実**: 作業ツリーのファイルを読んで確かめたもの（`ファイル:行`つき）。
- **推測**: 読んだ事実から考えたもの。実機では確かめていない。
- このセッションでは、ブラウザの実行・grep・ls が使えなかった。そのため、見た目の確認は実機でしていない。ファイルは名前を当てて読んだので、読めていない箇所は「未確認」と書く。

## 結論

1. **推奨は候補 C（`.pip` を残し、見た目だけを彗星にする。CSS だけの変更）**。
   - 玉は、HTML の `span` に `offset-path` を付けて走らせている。向きの合わせ（`offset-rotate: auto`）と、グラデーションの背景を足すだけで彗星になる。
   - 線の形（破線・点線）・SVG・関係図の束（`graph.js`）・CSP には触らない。
   - 動きを減らす設定と「動きを止める」は、今の規則（`.pip{display:none}`）のまま効く。
2. **利用者の参考の SVG（`objectBoundingBox` で `x1`/`x2` を動かす形）は、そのままでは使えない（候補 A）。**
   - 関係図の線は、**すべて水平か垂直の直線**（斜め・曲線は 1 本もない）。
   - SVG の仕様では、`objectBoundingBox` の単位は、図形の外接箱の幅か高さが 0 のとき**描かれない**。水平線は高さ 0、垂直線は幅 0 なので、グラデーションが出ない。
   - この退化は、実機では確かめていない（コードの形と仕様からの判断）。
3. 利用者の言う「実線・破線・点線」と、実装は食い違う（「線の種類ごとの描画」を参照）。
   - 線の上り・下りには、**実線がない**（すべて破線か点線）。
   - 玉が出るのは、段が `sent` の線だけ。
   - この 2 点は、統括の判断が要る。

## 1. 玉の実装（事実）

| 何 | 場所 |
| --- | --- |
| 玉を作る（`span.pip`）。線が `g-sent` で終わるときだけ | `packages/daemon/src/ui/graph-entry.ts:512-516` |
| 玉に道（`offset-path`）を設定する。設定するのはここだけ | `packages/daemon/src/ui/graph-path.ts:138-142`（`setRunnerPath`。`d` は `PATH_PATTERN` を通したものだけ） |
| 玉の見た目と動き | `packages/daemon/src/api/ui-assets.ts:232`（`.pip`）・`:234`（`@keyframes gtravel`） |
| 止める規則 | `ui-assets.ts:236`（`.still .pip{display:none}`）・`:237`（`@media (prefers-reduced-motion: reduce)` で `*,*::before{animation:none!important;transition:none!important}` と `.pip{display:none}`）・`:235`（`.still *`） |

- 玉の見た目: `position:absolute;left:0;top:0;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--ai);offset-rotate:0deg;animation:gtravel 1.6s linear infinite`（`ui-assets.ts:232`）。
- 動き: `@keyframes gtravel{from{offset-distance:0%}to{offset-distance:100%}}`（`ui-assets.ts:234`）。
- 玉は、線の SVG と同じ「つながりの器」の中に置かれる（`graph-entry.ts:511-516` の `element.append(svg)` のあとに `element.append(dot)`）。SVG は `left:0;top:0` で全体の大きさ（`viewBox` は `0 0 w h`）なので、`offset-path` の座標と線の `d` の座標は同じ。
- 玉が走るのは**段が `sent` の線だけ**。`unknown`（届いたか分からない）・`delivered`・`done` には玉がない（`graph-entry.ts:512`）。ブラウザ試験も「sent だけに玉が走る」と確かめている（`packages/daemon/test/ui/browser.test.ts:103-118`）。
- 玉の色は `var(--ai)`。明るい画面は `#2a4f8f`、暗い画面は `#8fb0ea`（`ui-assets.ts:75-77`）。

## 2. 線の種類ごとの描画（事実）

| 線 | 種類 | 描画 |
| --- | --- | --- |
| 上り・下りの線（`.line`） | **破線** | `stroke:var(--ai);stroke-width:2.5;stroke-dasharray:6 8`（`ui-assets.ts:218`）。下りは `stroke:var(--ai-2)`（`:219`） |
| `g-sent` | 破線 6 8 | `animation:gflow .8s linear infinite`（`:220`）。`@keyframes gflow{to{stroke-dashoffset:-14}}`（`:234`）。さらに玉が走る |
| `g-delivered` | 破線 6 8 | `animation:gflow 2.4s`（`:220`）。玉はない |
| `g-unknown` | **点線に近い** `3 6` | `animation:gflow 3s`・`stroke-dasharray:3 6`（`:220`）。玉はない |
| `g-done`（終わった） | 破線 6 8 | 動きなし・`opacity:.45`（`:223`） |
| 枝（`.twig`。やり取りのない子） | **点線** `2 5` | `stroke-width:1.5;opacity:.6`（`:217`）。動きなし |
| 幹（`.trunk`） | **実線** | `stroke-width:4;opacity:.5`（`:216`）。動きなし。玉の道ではない |

- 実線は、幹だけ。**上り・下りの線に実線はない**。利用者の「実線・破線・点線のどれにも」は、実装では「破線（sent・delivered・done）・点線に近い破線（unknown）・点線（twig）」のこと。
- 上り・下りの線は、水平の直線が 1 本（道の形は `M x y L x2 y`。`graph-path.ts:75-96`）。長さは 206px（列の間 `COL_GAP` 240 − 幹の長さ `TRUNK` 26 − `ARROW` 8。`graph-layout.ts:9`・`graph-path.ts:9,46`）。
- 上りは、子の箱の左から幹へ向かう（左向き）。下りは、幹から子の箱の左へ向かう（右向き）。
- 幹（`trunkOf`）は垂直の線（`graph-path.ts:55-68`）。
- 玉は、線の `d` をそのまま `offset-path` にしている。線の破線の模様は、玉に関係しない。

## 3. 候補の比較

「線のスタイルを変えない」「動きを減らす設定・明暗・スマホ幅の見え方を保つ」を満たすかで比べる。

### A. 利用者の参考の SVG をそのまま使う（`objectBoundingBox` ＋ `<animate>` で `x1`/`x2`）

- 難易度 ★★☆☆☆ ／ 有効度 ★☆☆☆☆
- **水平線・垂直線で退化する**（事実: 線が水平・垂直だけ。推測: 仕様どおりに描かれない）。
  - 仕様（SVG 1.1 §13.2.2 と SVG 2 に同趣旨）: 図形の外接箱の幅か高さが 0 のとき、`objectBoundingBox` のグラデーションは描かれない。
  - 関係図の線は、すべて `y` が同じ水平線なので、高さ 0 で描かれない。
  - 幹は垂直（幅 0）で同じ。斜めの線は、今の図には出ない。出るようになったときだけ動く。
- 参考の SVG は、利用者の例では斜めか曲線の線を想定していたと思われる（推測）。
- 採用しない。

### B. `userSpaceOnUse` のグラデーションを、線ごとに SVG で重ねる（破線と同じ破線の重ね線）

- 難易度 ★★★★☆ ／ 有効度 ★★★★☆
- 破線の模様を保ったまま、グラデーションを重ねられる。水平線で退化しない（座標を線ごとに決めるため）。
- 費用が大きい。
  - 新しい SVG の部品（`linearGradient`・`stop`・`defs`・`animate`）が要る。許可リスト（`svg-el.ts:7,8`）と、`scan.test.ts:58-59,92` の固定の文字列を直す。
  - `stroke="url(#…)"` は、CSS の固定のクラスでは書けない（線ごとに別の `id` が要る）。属性の許可を足し、`id` の一意性を保つ必要がある。
  - SMIL（`<animate>`）は、CSS の `animation:none` で止まらない。動きを減らす設定・「動きを止める」の既存の規則が効かない。止めるには、スクリプトで `pauseAnimations()` を呼ぶか、玉と同じく描かない処理が別に要る（動きを保つ条件が崩れやすい）。
  - 重ねた破線と、元の破線の `stroke-dashoffset` の動き（`gflow`）を合わせる必要がある（合わないと模様がずれる）。
- 条件を満たすには手間が大きく、利用者の要件（見た目だけ変える）に対して重い。

### C. `.pip` を残し、見た目だけ彗星にする（CSS だけ）【推奨】

- 難易度 ★☆☆☆☆（〜★★） ／ 有効度 ★★★★☆
- やること（`ui-assets.ts` の `.pip` と `@keyframes gtravel`）:
  - `width` を 8px から彗星の長さ（案 56px）に、`height` を 4px 前後にする。
  - `border-radius:999px` にする。
  - `background` を、グラデーション（案は下）にする。
  - `offset-rotate:auto`（道の接線に合わせて回る）にする。
  - `offset-anchor:100% 50%`（頭が道の位置に来る）にする。
  - `margin` は、中央合わせの `-4px 0 0 -4px` をやめる。
- 色の案（既存のトークンだけ。明暗は `--ai` が切り替える）:
  `linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--ai) 80%, transparent) 70%, var(--ai) 95%, transparent 100%)`。
  - 頭を最も明るくしたいなら、95% の色を `color-mix(in srgb, var(--ai) 60%, white)` のように明るくする。明るい画面でも見える濃さは、実機で見て決める。
- 利点（事実と、そこからの推測）:
  - **向き・縦・斜め・曲線で退化しない**。`offset-path` は、道の接線に沿って回る。外接箱を使わない。
  - 線の描画（`.line`・`.twig`・`.trunk`）に触らない。**線の種類のスタイルは変わらない**。
  - 動きを減らす設定・「動きを止める」は、既存の `.pip{display:none}` と `animation:none!important` のまま効く（`ui-assets.ts:235-237`）。
  - SVG・`graph.js` の束・CSP・`svg-el.ts`・`scan.test.ts` に変更なし。`UI_GRAPH_JS` の作り直しも要らない（CSS は `ui-assets.ts` の `UI_CSS`）。
  - 明暗・スマホ幅は、トークンと既存の `@media` のまま。
- 注意（推測）:
  - 玉が 0% のとき、尾は道の始点の「後ろ」にはみ出る。上りは、尾が子の箱の上に出る可能性がある。箱との重なり順は未確認。`@keyframes` の先頭と終わりで `opacity` を 0 から 1 にする、`offset-distance` の範囲を尾の長さの分だけずらす、などで抑える。
  - 動きを減らす設定では、彗星そのものが隠れる。参考の SVG の「静止画でも進む向きが分かる」は、動きを止めたときは出ない（向きは矢印の三角で読める）。
  - `color-mix()` は、Chrome 111・Safari 16.2・Firefox 113 以降。使えない古いブラウザでは `background` が無効になり、彗星が見えなくなる。`background:var(--ai)` を先に書いておく（フォールバック）か、`color-mix` をやめて `rgba` の固定値にする。

### D. 重ねた SVG の線で、`stroke-dasharray` を彗星の形にする

- 難易度 ★★★☆☆ ／ 有効度 ★★★☆☆
- `pathLength` を使い、「長い 1 本の破線」を 3〜4 本重ねて、尾に向かって薄くする（階段状）。
- 連続したグラデーションにならない。重ねた線が、元の破線の隙間も塗る（線のスタイルが変わる）。`class`・`pathLength` の許可が増える。推奨しない。

### 比較のまとめ

| 候補 | 難易度 | 有効度 | 水平・垂直の線 | 線のスタイル | 動きを減らす設定 | 変更の範囲 |
| --- | --- | --- | --- | --- | --- | --- |
| A | ★★ | ★ | **描かれない** | 変わらない | 効かない | SVG・許可リスト・試験 |
| B | ★★★★ | ★★★★ | 描かれる | 変わらない | 別の処理が要る | SVG・許可リスト・試験・止め方 |
| **C（推奨）** | ★ | ★★★★ | 退化しない | 変わらない | 既存のまま効く | CSS だけ |
| D | ★★★ | ★★★ | 描かれる | 隙間を塗る | 既存のまま効く | SVG・許可リスト |

### 参考の SVG の静的なベース線（`x1=0%`〜`x2=100%` の `#1e293b`→`#3b82f6`）について

- 線の色そのものを変える（グラデーションの線にする）ことになり、「線の種類のスタイルは変えない」の要件と合わない。候補 C では採らない。
- 採るなら、候補 A と同じく、水平線では `userSpaceOnUse` が要る（B の仕組み）。統括の判断が要る。

## 4. 変更箇所と試験（推奨 C の場合）

### 実装（このあとの作業）

- `packages/daemon/src/api/ui-assets.ts:232`（`.pip`）と `:234`（`@keyframes gtravel`）。
  - 彗星の長さ・向き（`offset-rotate:auto`・`offset-anchor`）・背景・両端の薄れ。
  - 道の始点と終点の見え方（尾が箱に重なる件）。
- `ui-assets.ts:236,237` の `.pip{display:none}` は、そのまま。

### 文書の直す箇所（事実）

- `docs/ui.md:139`: 「図の上を動く玉（`.pip`）は、止めるときは隠す」→ 彗星に言い換える。
- `docs/ui.md:146`: 「動く玉の `offset-path` も 1 か所」→ 言い換え（仕組みは同じ）。
- `docs/ui.md:163`: 「線の流れは止まり、玉は隠れる」→ 言い換え。
- `docs/ui.md:214`: `--live` の「流れる線と玉の動きを見る」→ 言い換え。
- `packages/daemon/src/ui/graph-path.ts:3,138`・`ui-assets.ts` 内のコメントの「玉」→ 言い換え（名前 `.pip`・`setRunnerPath` を残すなら、コメントだけ）。
- `.sdd/specification/touryou-ui.md`: **この作業ツリーにはない**（main の未追跡ファイル。指示のとおり、`docs/ui.md` と実装を読んだ）。main 側で、玉に触れる記述があれば同様に直す。
- 未確認: `docs/manual-verification-ui.md`（読んでいない）。「玉」の記述があれば直す。
- `docs/images/ui-*.png`: 玉が写っていれば撮り直す（`TOURYOU_UI_SHOTS`。`docs/ui.md:164`）。玉が写っているかは未確認。

### 試験の直す箇所（事実）

- `packages/daemon/test/ui/browser.test.ts:103`: 試験名の「玉」→ 言い換え。
- `browser.test.ts:114-118`: `.pip` が 1 つだけ・`offsetPath` が `path("M ` で始まる断言。**C なら、そのまま通る**。
- `browser.test.ts:150-160`: 動きを減らす設定で、線と `.pip` の `animationName` が `none`。**C なら、そのまま通る**。
- `packages/daemon/test/ui/scan.test.ts:62-71`: `offsetPath` を設定するのは `setRunnerPath` の 1 か所だけ。**C なら、変更なし**。
- 追加案: `.pip` の `offset-rotate` が `auto`、`background` がグラデーションであることの確認（`getComputedStyle`）。
- 未確認: `packages/daemon/test/ui-assets.test.ts`・`packages/daemon/test/ui/real-ui.test.ts`（読んでいない）。`.pip` や `gtravel` の文字列を見ていれば、直す。
- 未確認: `packages/daemon/test/ui/fixture.css`（`browser.test.ts:36` で `UI_CSS` に足される）。

### 候補 B を採るときに増える変更（参考）

- `packages/daemon/src/ui/svg-el.ts:7-8,10-33,41-54`（タグ・属性・クラスの許可リスト）。
- `scan.test.ts:58-59,92`（許可リストの固定の文字列）。
- `scripts/ui-graph-bundle.mjs --write` で `ui-graph-js.ts` の作り直し。
- `docs/ui.md:194` 付近（SVG・CSP の規則の記述）。

## 5. 色（既存の配色トークン）

- 玉・彗星の色は `--ai`（明 `#2a4f8f`／暗 `#8fb0ea`）。下りの線は `--ai-2`。答え待ちの線は `--kaki`（`ui-assets.ts:222`）。
- 今の玉は、線の色にかかわらず `--ai` 固定。彗星も、まずは `--ai` で足りる。線の色に合わせるなら、玉に `.down`・`.wait` のクラスを付ける変更が要る（`SVG_CLASSES` は SVG 用。玉は HTML の `span`。`el()` の `cls` 引数で渡せる）。
- 参考の SVG の `#334155`・`#2563eb`・`#93c5fd` は、既存のトークンにない固定の色。使わず、`--ai` と `color-mix` で表す。

## 6. リスクと、統括への確認

1. **彗星を出す線の範囲**: いまは `g-sent` だけ（玉と同じ）。`delivered`・`unknown` にも出すかは、統括の決め。範囲を広げる場合は、玉を作る条件（`graph-entry.ts:512`）と、試験（`browser.test.ts:114`）が変わる。
2. **実線がない**: 「実線・破線・点線のどれにも」は、実装では破線・点線だけ。候補 C は、線の種類に関係なく効く。
3. **尾が箱に重なる**（推測。上の注意）。実機で確かめる。
4. **`color-mix()`** の対応（上の注意）。
5. **動きを減らす設定では、彗星は出ない**（要件どおり。静止画の向きは出ない）。
6. **試験の未確認**: `ui-assets.test.ts`・`real-ui.test.ts`・`manual-verification-ui.md` は、この調査では読んでいない。実装の前に、`pip`・`gtravel`・`offset` で探す。
7. 実機の見た目（水平線で B/A が描かれないこと、C の尾の重なり）は、実装の段階で、`node scripts/ui-preview.mjs --live` で確かめる。
