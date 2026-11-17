---
id: "design-issue-89"
title: "状態画面を「いま何が起きていて、何をすればよいか」が分かる作りにする"
type: "design"
status: "draft"
sdd-phase: "plan"
sdd-version: "5.1.0"
impl-status: "not-implemented"
created: "2026-11-17"
updated: "2026-11-17"
depends-on: ["spec-touryou", "design-touryou"]
tags: ["ui", "status-screen", "rete"]
category: "developer-tooling"
---

# 状態画面を「いま何が起きていて、何をすればよいか」が分かる作りにする

Issue #89 の技術設計の下書き（一時的。実装が終わったら、大事な決めを [touryou.md](../../adr/touryou.md) に移して消す）。
調べと決めは [research.md](research.md)（7 節「決まったこと」）、見た目は [mock.html](mock.html)（8 回目の版）。
要求は [touryou.md](../../requirement/touryou.md) の IR_003・FR_021、仕様は [touryou_spec.md](../../specification/touryou_spec.md) の 5.6 節。

# 1. 実装ステータス

| 段 | 中身 | 状態 |
|:--|:--|:--|
| PR-1 仕様 | 要求・仕様・設計・ADR・`docs/ui.md` に、この下書きの決めを書く | 🟡 この PR |
| PR-2 表示モデル | `packages/core/src/ui-view.ts` に値を足す（5 節） | 🟡 |
| PR-3 試作 | `/ui/graph.js` の束ね・自前の描き手（R0）・配置を、`ui-assets.ts` に触れずに試す | 🔴 |
| PR-4 画面の作り直し | `ui-assets.ts`・`ui-assets.test.ts`（「いまあなたがすること」・カード・言葉・管理のたたみ・一覧） | 🟡 |
| PR-5 関係図 | `/ui/graph.js` を配り、図と一覧の切り替え・動き・試験・画面写し | 🔴 |

# 2. 設計目標

- 画面を開いた人が、**いま自分がすること**を最初に見て、その場で答えられる。
- 作業（子）ごとに、題・役割・状態・最後の動き・受信箱の項目がまとまって読める。
- 親子の関係と、やり取り（上り＝子 → 親、下り＝親・人 → 子）の**進み具合**が、図で分かる。
- いまの安全の決まり（`textContent`・`createElement`・タグの許可リスト・CSP `'self'`・走査の試験・取り消せない操作の打ち込みの確認・トークンはメモリだけ）を保つ。変えるのは 6 節の表の所だけ。

# 3. 技術スタック

| 部分 | 使うもの | 版 | 理由 |
|:--|:--|:--|:--|
| 画面（いまの `app.js`） | 素の JavaScript（TS の文字列で埋め込む） | — | いまのまま |
| 関係図（`/ui/graph.js`） | `rete`・`rete-area-plugin`・`rete-readonly-plugin` | 2.0.6・2.3.2・2.0.2（完全に固定） | 利用者の決め（D2）。描画のプラグイン（React・Vue・Lit）は使わない（E1 の R0。CSP に当たらず、依存が最も少ない） |
| 束ね | esbuild（開発の依存に既にある） | いまの固定の版 | `graph.js` を 1 つの文字列にして埋め込む |
| 自動の配置 | 自前の純粋な関数 `layoutOf` | — | elkjs（EPL/GPL・8.2 MB）を使わない |

- R0 が公式の作りで通らない（area のプラグインの描く合図で、自前の要素を描けない）と PR-3 で分かったら、Lit（`rete-lit-plugin`）に替える（E1）。そのときは `adoptedStyleSheets` が CSP に当たらないかを、PR-3 の Playwright で確かめる。**替えるときは、6 節の表（依存・走査・SVG の作り方）を見直し、その PR で利用者に確かめる**。

# 4. アーキテクチャ

## 4.1. システム構成図

```mermaid
flowchart LR
  subgraph daemon
    V[uiViewOf<br/>core/ui-view.ts] --> S["GET /v1/ui/state"]
    A["GET /ui · /ui/app.js · /ui/app.css"]
    G["GET /ui/graph.js（新）"]
  end
  subgraph ブラウザ
    APP[app.js<br/>いまの描き手 el()] -->|fetch| S
    APP -->|touryouGraph.draw(host, view) だけを呼ぶ| GR[graph.js<br/>自前の描き手 + rete]
  end
  A --> APP
  G --> GR
```

## 4.2. モジュール分割

| モジュール | 場所 | 役割 |
|:--|:--|:--|
| 表示モデル | `packages/core/src/ui-view.ts` | 5 節の値を足す。`flowsOf`（やり取りの段の決め）と `humanCounts`（人の要対応の数え）を純粋な関数で |
| 状態の畳み | `packages/core/src/events.ts` | `DecisionRecord.answeredSeq`・`answeredAt`、`ExtensionRecord.decidedAt` を足す（新しいイベントは要らない） |
| 画面 | `packages/daemon/src/api/ui-assets.ts` | 「いまあなたがすること」・作業のカード・一覧・管理のたたみ。図は `graph.js` に任せる |
| 図の入口 | `packages/daemon/src/ui/graph-entry.ts`（新・案） | `window.touryouGraph.draw(host, view)`・`destroy()`。表示モデルから、整えた文字・確かめた ID・数だけを作り直して描く |
| 図の配置 | `packages/daemon/src/ui/graph-layout.ts`（新・案） | `layoutOf(nodes, size)`。純粋な関数 |
| 図の線 | `packages/daemon/src/ui/graph-path.ts`（新・案） | 枝の道（角丸の折れ線）の `d` を数だけで組む。矢印の三角も |
| SVG の要素 | `packages/daemon/src/ui/svg-el.ts`（新・案） | `svgEl(tag, attrs)`。SVG を作るのはここ 1 か所だけ |
| 束ね | `scripts/`（新・案） | esbuild で `graph-entry.ts` と rete を 1 つにし、TS の文字列（`UI_GRAPH_JS`）として出す。ビルドで作り直し、試験で中身を確かめる |

# 5. データモデル（表示モデルに足すもの）

```ts
export interface UiNode {
  // いまの欄に足す
  /** 目的（objective）の先頭を整えて切ったもの（80 コードポイント。uiText と同じ整えに加え、改行・タブ・続く空白を空白 1 つにまとめ、前後の空白を除いて 1 行にする）。なければ欄なし。 */
  readonly title?: string;
  /** そのノードの最後の動き（報告・受信箱の項目・指示と受け取り・判断と拡張の要求）の時刻。状態の変化は時刻の記録がないので含めない。 */
  readonly lastActivityAt?: string;
  /** 人の操作が要る数（判断待ち・範囲の頼み・止まっているかも・停止の代行依頼）。openItems とは別（research.md 1.4）。 */
  readonly needsHuman: number;
  /** 作業の状態の 3 段（F5）。 */
  readonly band: "turn" | "running" | "finished";
}

export interface UiInboxItem {
  // いまの欄に足す
  /** 全文の参照（report.get で読む）。違反なら拡張要求の ID。 */
  readonly ref?: string;
  /** 「止まっているかも」（cli-watch.ts の知らせ）の印。いまは文の先頭でしか見分けられないため。 */
  readonly stall?: true;
}

export interface UiExtension {
  // いまの欄に足す
  /** 要求の時刻。古い記録にはないので省ける。 */
  readonly at?: string;
}

export const UI_FLOW_STAGES = ["sent", "delivered", "done"] as const;
export interface UiFlow {
  readonly id: string;
  readonly kind: "instruction" | "report" | "done" | "decision" | "extension" | "answer";
  readonly dir: "up" | "down";
  readonly from: string; // ノード ID か "human"
  readonly to: string;
  readonly stage: (typeof UI_FLOW_STAGES)[number];
  readonly sentAt: string;
  readonly deliveredAt?: string;
  readonly doneAt?: string;
  readonly deliveryUnknown?: true;
  readonly doneInferred?: true;
}
// UiView に readonly flows: readonly UiFlow[] を足す。新しい順に UI_LIMITS.flows（200）件まで。
// 本文は載せない（種類・時刻・ID だけ）。表示モデルは時計を持たない純粋な関数なので、「24 時間たったものを外す」はしない（件数の上限だけ）。
// 親への依頼（parentRequest）は、画面のやり取りに要らないので載せない。
// 完了の報告の doneAt は、受理・差し戻しの時刻（NodeRecord.reviewedAt。最後の 1 回だけ記録する。それより前の完了の報告には doneAt を付けない）。
```

- 段の決め方（`flowsOf`）は research.md 9.3 のとおり。ただし、9.3 の `kind` の `parentRequest` と「24 時間たったものを外す」は、ここ（5 節）で外した（上のコードの注記）。子 → 親は `deliveryUnknown`（「届いた」の記録は #102 で足す）。
- 作業の状態の 3 段（`band`）：`turn`＝人の出番（`needsHuman > 0`、または `stopIncomplete`・失敗）、`finished`＝`verified`・`reclaimable`・`archived`・`stopped`（人の決めが残らないもの）、ほかは `running`。
- `sessionId` は足さない。止まっている子を開くコマンドは `claude attach <ノード ID>`（CLI の子は `--name <ノード ID>` で起動している）。Desktop の子（`stopDelegated`）には、コマンドでなく開き方の文を出す。

# 6. 安全の決まりの変更（前と後）

| 決まり | いま | あと | 守りの保ち方 |
|:--|:--|:--|:--|
| 依存 | 画面は依存なし | daemon に `rete`・`rete-area-plugin`・`rete-readonly-plugin` を足す | 版は完全に固定（`^`・`~` なし）。`minimumReleaseAge` 14 日の内。npm は Dependabot の外なので手で上げ、確かめの手順（ライセンス・`innerHTML`・`eval`・`<style>` の差し込みの有無）を `docs/release.md` に書く（E4） |
| 図の入口 | — | `graph.js` が外に出すのは、`window` の 1 つの名前 `touryouGraph`（`{ draw(host, view), destroy() }`）だけ。`app.js` はこの名前だけを見る（なければ一覧だけ） | 試験で、`graph.js` が `window` に足す名前が `touryouGraph` 1 つだけであること、`app.js` が呼ぶのが `touryouGraph.draw`・`touryouGraph.destroy` だけであることを確かめる |
| 資産 | `/ui`・`/ui/app.js`・`/ui/app.css` | `/ui/graph.js` を足す | 認証なし・回数の制限なし・状態を含まない（いまの資産と同じ）。HTML の `<script src>` は 2 つ（`app.js` のあとに `graph.js`）。`app.js` は `graph.js` がなくても動く（一覧だけ出す） |
| 走査の試験 | `app.js` の文字列を走査 | `app.js` と、図の**自前のコード**（束ねる前の `graph-*.ts`・`svg-el.ts` の出力）を、同じ走査にかける。束ねたあとの `graph.js` 全体には、別の試験で次を確かめる：(1) `innerHTML`・`outerHTML` への代入は、`= ""`（空の文字列の定数）の形だけを許し、ほかの形はすべて落とす。(2) 次がない：`eval`・`Function(`（`new` の有無によらず）・`document.write`・`<style>` の差し込み（`createElement("style")`）・`insertAdjacentHTML`・`setAttribute("style"`・`setAttribute("on`・`srcdoc`・文字列を渡す `setTimeout`・`setInterval`・`import(`・`fetch`・`XMLHttpRequest`・`WebSocket`・`EventSource`・`postMessage`・`window.open`・storage・cookie。(3) ライブラリ側に `createElementNS` がない（SVG は `svgEl` の 1 か所だけ、をライブラリにも効かせる）。(4) 埋め込んだ文字列（`UI_GRAPH_JS`）が、固定の版と lockfile から束ね直したものと一致する（`scripts/check.sh` で束ね直して比べる。手で書き換えた束を入れない） | ライブラリは走査の SAFE の外。そのかわり禁止の API の不在を、版を上げるたびに試験で確かめる（E3） |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self'; …` | **変えない** | `<style>`・`style` 属性を差し込まない。`element.style.x = …`（プロパティ）は CSP に当たらない |
| タグの許可リスト | `div`・`span`・`p`・`button`・`textarea` | `details`・`summary`・`code` を足す（D4） | 属性は付けない。試験の「`el` に渡すタグ」の許可リストを合わせる |
| SVG | 作らない（生成を禁止） | `svgEl(tag, attrs)` だけが作る。タグ：`svg`・`g`・`path`・`rect`・`text`・`title`。属性：`class`・`d`・`x`・`y`・`width`・`height`・`rx`・`viewBox`。`class` は、決まった名前の一覧（`SVG_CLASSES`。例：`flow-up`・`flow-down`・`stage-sent`・`stage-delivered`・`stage-done`・`await`・`branch-idle`・`band-turn` など）の中からだけ（空白で区切った複数も、どれも一覧にあるときだけ）。ほかの属性の値は数か、数で組んだ `d`・`viewBox`（`d` の命令は `M`・`L`・`C`・`Q`・`A`・`Z`）。それ以外の値は拒む | 試験で、`createElementNS`・`setAttributeNS` が `svg-el.ts` の 1 か所だけにあることを数える。`href`・`on*`・`style` 属性・`foreignObject`・`use`・`a`・`marker`・`image` は入れない。文字は `text` 要素の `textContent` だけ |
| 動く玉（D8） | — | CSS の `offset-path` を、`graph-path.ts` の 1 か所だけで `element.style.offsetPath = "path('…')"` として設定する（中身は `d` と同じ検査を通した文字列） | 走査の SAFE に `offsetPath` を足し、使う所が 1 か所だけであることを試験で数える |
| 図に渡す値 | — | `touryouGraph.draw(host, view)` の中で、表示モデルから作り直す：文字は `uiText` を通したもの（題・状態の名前・種類の名前・時刻）、ID は `ID_PATTERN` を通したもの、数 | 表示モデルをそのまま rete に渡さない。rete のノードのデータは ID と数だけ |
| プロパティの許可リスト | 走査の `SAFE` | `classList`・`dataset`・`offsetPath`・`clipboard`・`writeText` などを足す | 足すものを PR-4・PR-5 の本文に表で出す |
| 動き | 少し | CSS の `@keyframes` とクラスの付け外しだけ。`prefers-reduced-motion` で止める。画面に「動きを止める」 | 動きは意味を足すだけ。止めても色・印・文字で読める（F5） |

# 7. 図の形（F1・F3・F4・F6）

- **横向きの木**：根が左、深さが右へ。親は子の並びの真ん中の高さ。兄弟は生まれた順（記録の `seq`）で固定する。
- 親の箱は高さ 80px のまま。**親の箱の右に縦の幹**を置き、そこから**子ごとに枝分かれ**する（子ごとの端子）。外側の子ほど親の近くで曲げて、線を交わらせない。線は**角丸の折れ線**。
- やり取りのまだない子は、薄い点線の枝だけ。灰色のつながりの線は出さない。
- 1 本の枝に、上りと下りの道を並べる。**上の道が上り（子 → 親。矢印は左向き ←）、下の道が下り（親・人 → 子。矢印は右向き →）**（D1）。どの枝でも同じ。矢印の先は、端の向きから三角を数で計算して `path` で描く（`marker` を使わない）。
- 線の色は、落ち着いた藍 1 色で、新しいほど濃い。すべて破線。**柿色は答え待ちだけ**。
- 動きはやり取りの段に結びつける：`sent`＝速く流れ、玉が繰り返し走る／`delivered`＝ゆっくり流れる／`done`＝止まる。終わった作業の線は動かさない。
- 箱は作業の状態の 3 段（出番／進んでいる／終わった）。印と文字を必ず添える。活動中の点・役割の印・左の縁の段の色・列の見出し。
- 子の数に上限は設けない。拡大・移動・全体を見るで扱う。済んだ・止めた子は薄く出す。
- 一覧（木の字下げ＋最後の上り・下り）と、図を切り替えられる（F2）。
- 段を飛ばすやり取り（人の答えなど）は、木の外の「人」の箱からの通り道の折れ線（research.md 6.1）。

# 8. テスト戦略

| 対象 | 試験 |
|:--|:--|
| `flowsOf`・`humanCounts`・`band`・`title`・`lastActivityAt` | core の単体の試験（記録の列から期待の値。上限・統合の見える範囲） |
| `layoutOf` | vm／単体：根だけ・鎖・横に広い・深さの不揃い・子 50・同じ入力で同じ出力・重ならない・親が子の真ん中の高さ |
| `graph-path` | `d` が許した命令と数だけ・上りと下りが交わらない・矢印の向き |
| `svgEl` | 許していないタグ・属性・値を拒む。一覧にない `class`（空白で区切ったうちの 1 つでも）を拒む。`createElementNS` が 1 か所だけ |
| 走査 | いまの `ui-assets.test.ts` を `graph-*` の自前のコードにも。束ねた `graph.js` の 6 節の (1)〜(3)。束ね直しの一致（(4)。check で） |
| CSP の下で動く | Playwright（PR-3・PR-5）：CSP のヘッダーつきで `/ui` を開き、コンソールに CSP の違反がないこと・図が描かれること・`prefers-reduced-motion` で動きが止まること |
| 画面写し | `docs/images` の明暗を撮り直す（PR-5） |

# 9. 設計判断

## 9.1. 決定事項

- research.md 7 節の D1〜D8・E1〜E5・F1〜F7。
- 横向きの木（8 節の案 B）を図の形にする。research.md 6.1 の「深さで段に分けた縦の木」は、8 節の調べのあと、横向き（根が左）に置き換えた。

## 9.2. 未解決の課題

範囲の外（#89 では作らない）：受信箱の項目を人が片付ける操作（#99）、統合が子からのやり取りを受け取ったことの記録（#102）。「止まっているかも」は、daemon の CLI の見張りの知らせ（`isStallSummary`）があるときだけ出し、画面で推し量らない。

| 課題 | 影響 | 扱い |
|:--|:--|:--|
| R0（描画のプラグインなし）が rete の作りで通るか | 中 | PR-3 で確かめる。通らなければ Lit（E1） |
| `rete-readonly-plugin` で、つなぐ・動かす・消すが止まるか | 低 | PR-3 で確かめる。足りなければ area の合図を受けて止める |
| 子 → 親の「届いた」 | 低 | #102。それまでは `deliveryUnknown` |
| 束ねた `graph.js` の大きさ | 低 | 見込み 17 KB（gzip）。PR-3 で測る |
