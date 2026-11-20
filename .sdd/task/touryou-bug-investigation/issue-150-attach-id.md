# #150 状態画面の「止まっているかも」の attach コマンドが、止まった子を開けない件の調査

調査のみ。コード・docs・CHANGELOG は変更していない。GitHub へは書き込んでいない。

## 結論（原因）

画面が出すコマンドは `claude attach <ノード ID>` だが、`claude attach` が受け取るのは `claude agents --json` の id（8 桁）であり、`--name` に付けた名前（ノード ID）ではない。
画面（表示モデル）は、ノード ID しか持たない。親が報告した子のセッション参照（`sessionRef`）は、記録（`OrchState`）にはあるが、表示モデル（`UiNode`）に載っていない。そのため画面は、開けるコマンドを組めない。

## 根拠（コードの実態）

| 場所 | 実態 |
| --- | --- |
| `packages/daemon/src/api/ui-assets.ts:422-432` | `attachCommand(n)` は `'claude attach ' + n.id` を組む。`n.id` はノード ID（`ID_RE` に合うもの）。`n.cli === true` の子だけ。コメントは「CLI の子は --name <ノード ID> で起動しているので、claude attach で開ける」と前提を置いている（これが誤り）。`attachDir` があれば `cd '<dir>' && ` を前に付ける（#136）。 |
| `packages/daemon/src/api/ui-assets.ts:833, 987` | 呼び出しは 2 か所（受信箱の「止まっているかも」のカード、ノードのカード）。どちらも `attachCommand(node)` で、セッション参照を渡していない。 |
| `packages/daemon/src/api/ui-assets.ts:1762` | `attachDir` は `view.attachDir`（daemon が足す）から取る。`UiView` の型には無い。 |
| `packages/core/src/ui-view.ts:43-74` | `UiNode` に、セッション参照の欄がない。`cli?: true` だけがある。 |
| `packages/core/src/ui-view.ts:298-303, 317` | `cliChildren` は、`launch` を `done` で報告した子の集合。`cli: true` を付けるだけで、報告の `sessionRef` は読まない。 |
| `packages/core/src/events.ts:279-293, 612-630` | `node.parentReported` の `payload.sessionRef`（`claude --bg` の出力・`claude agents --json` の id）は、`ParentRequestRecord.report.sessionRef` として状態に残る。形は `isSessionRef`（`events.ts:407-408`）。 |
| `packages/daemon/src/api/handlers/parent-request-handlers.ts:85-95` | `sessionRefOf(state, nodeId)` が、停止・削除の依頼のコマンド（`claude stop <ref>`・`claude rm <ref>`。同 `:270-284`）に使う正しい参照を引く。launch の成功報告、または、親が調べ直した id の報告だけを読む（別 id にしないため）。画面は、これを使っていない。 |
| `packages/daemon/src/api/handlers/parent-request-handlers.ts:250-258` | 起動は `name: nodeId` で `claude --bg --name <ノード ID>` を組む。名前はノード ID だが、attach が引くのは id。同 `:108` の `NEXT_SIMPLE` も「名前が <ノード ID> のセッションの id」を `claude agents --json` で引くと言っており、名前と id が別物という前提がコード内にすでにある。 |

停止・削除は `sessionRefOf` の id を使うのに、attach だけがノード ID を使っている、という食い違い。

## 直し方の候補

方針の原則: データの構造化はデータソースに近い層（core の表示モデル）で行う。画面は渡された値を使うだけにする。

### A. `UiNode` に `sessionRef` を足し、画面はそれで組む（推奨）

- `ui-view.ts`: `uiViewOf` で、`sessionRefOf` と同じ規則で参照を引き、`isSessionRef` を通ったものだけ `sessionRef?: string` として `UiNode` に載せる。`cli` の判定と同じ場所（`cliChildren`）で、参照も一緒に引く。
- `sessionRefOf` は daemon の handler にあるので、core に移す（または、同じ規則を core に置いて daemon から使う）。同じ規則が 2 か所にならないようにする。
- `ui-assets.ts`: `attachCommand` は `n.sessionRef` を使い、参照がなければ `''`（コマンドを出さず、`stall.cli` の文に落とす）。`ID_RE` の検査は、`isSessionRef` 相当の検査に替える（シェルに貼るので、形の検査は必須。英数字と `._-`、先頭は英数字）。
- 利点: 表示モデルは、読み取りだけで構造化される。ほかの画面（将来の CLI 表示など）でも使える。
- 難点: `UiNode` の型と、スナップショット試験が変わる。

### B. daemon が表示モデルに付ける（`attachDir` と同じ扱い）

- `attachDir` のように、daemon が `view` に `sessionRefs: { [nodeId]: ref }` を足す。core の `uiViewOf` は変えない。
- 利点: core の変更が小さい。
- 難点: 構造化が、データソースから離れた層（daemon の組み立て）に散る。`UiView` の型に出ない値が増える（`attachDir` もすでにそう）。方針に反するので推奨しない。

### C. 画面が `claude agents --json` を打つ形のコマンドにする

- 例: `claude attach $(claude agents --json | …)`。
- 難点: コピーして貼る文が長く壊れやすい。jq などの前提が増える。シェルの展開を含む文を画面が出すのは、これまでの方針（変数なし・値は引用済み）と合わない。推奨しない。

### D. 参照がなければ、手順の文だけを出す

- `sessionRef` が記録にないとき（古い記録・親が参照を報告しなかった）の落ち先。A の補助として必要。
- 文の案: 「`claude agents --json` で、名前が <ノード ID> のセッションの id を調べ、`claude attach <id>` で開く」。`stall.cli` の文（`ui-assets.ts:842`）を、この手順に差し替える。

### 記録に残さない扱いについて

- 参照は、すでに `node.parentReported` として記録に残っている（`events.ts:289`）。画面のために、新しい記録（イベント）を足す必要はない。表示モデルに写すだけ（A）。
- 画面側に、参照を持たせる・保存する（ブラウザの保存領域など）のは不要。毎回の表示モデルで足りる。
- 参照は秘密ではない（`events.ts:406` の通り、形だけ検査する値）。ただし、画面に出す前に `isSessionRef` を通し、通らなければ載せない（シェルに貼るため）。

### 試験・docs で直す場所

- 試験: `ui-view` の試験（`UiNode.sessionRef` が、launch の done 報告の参照から付くこと。停止・削除の報告の参照を読まないこと。不正な形は載せないこと）。`ui-assets` の試験（`attachCommand` が id を使うこと。参照がないとき `''` になること。`attachDir` の `cd` の前置きが保たれること）。
- 既存の試験で、`claude attach <ノード ID>` を期待しているものがあれば、更新が要る（場所は未確認。着手時に、`attach` を試験の中で探す）。
- docs: `attach` を説明する利用者向けの文と、`.sdd/` の仕様・設計（#136 の記述）に、「ノード ID ではなく id」を直す。`stall.cli`・`stall.rebind` の画面の文（日本語・英語、#140 の言語切り替え）も、参照がない場合の手順に合わせる。場所は着手時に確認する。
- CHANGELOG: 利用者に見える修正なので、1 行足す。

## 確認していないこと（着手時に確かめる）

- `claude attach` が、名前（`--name`）を受け付けない、という点は、#150 の報告にある実測を前提にしている。この調査では、`claude` を実行していない（範囲外）。
- `view.attachDir` を daemon がどこで足しているか、画面の文言（`stall.*`）の定義位置、既存の試験の場所は、範囲の都合で探していない（コマンド実行の許可が `git status` だけで、検索ができなかったため）。

## #150 に足す追記の下書き

> ### 調査結果（原因）
>
> 画面の `attachCommand`（`packages/daemon/src/api/ui-assets.ts:427-432`）は `claude attach <ノード ID>` を組む。しかし `claude attach` が引くのは、`claude agents --json` の id（8 桁）で、`--name` の名前ではない。
> 画面に渡る表示モデル `UiNode`（`packages/core/src/ui-view.ts:43-74`）には、子のセッション参照がない。`cli: true` だけがあり（`:298-303, 317`）、親の起動の報告の `sessionRef`（`events.ts:289`・`ParentRequestRecord.report.sessionRef`）は載らない。
> 停止・削除の依頼は、`sessionRefOf`（`parent-request-handlers.ts:85-95`）の id を使っているので、attach だけが食い違っている。
>
> ### 直し方（提案）
>
> 1. `sessionRefOf` の規則を core に置き、`uiViewOf` が `UiNode.sessionRef?` に載せる（`isSessionRef` を通ったものだけ）。
> 2. `attachCommand` は `n.sessionRef` を使う。なければ、コマンドを出さず、`claude agents --json` で id を調べる手順の文を出す。
> 3. 試験（`ui-view`・`ui-assets`）と、`stall.*` の文・docs・CHANGELOG を直す。
>
> 新しい記録（イベント）は足さない。参照は、すでに記録にある。

## ほかの不具合

この調査の範囲では、起票に足る別の不具合は見つけていない。
