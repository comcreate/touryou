# #159 技術調査: CLI の子と Desktop の子を同じ木で混ぜ、あとから紐付ける

- 種別: 技術調査（AI-SDD の task のみ。実装コードは変更しない）
- 対象: Issue #159
- 版: touryou 0.1.5 の作業ツリー（main 1df72e7）を読んだ結果

## 0. 読み方

- 【確認】: 実装・docs を読んで確かめた事実。
- 【推測】: 読んでいない部分、または読んだ事実からの判断。
- #145・#150・#11・#136 の中身は読んでいない。Issue 本文にある関係（番号）だけを根拠にし、その方針との整合は【推測】で書く。
- ノードの型 `NodeRecord`（core の `node.created` の中身）と、`cli-adapter.ts`・`hook-policy.ts`・`children-dir.ts` は読んでいない。該当の記述は【推測】。

## (a) 何を実現したいか

- 同じ木で、子ごとに CLI の子か Desktop の子かを選んで追加できる。
- 既存のセッション（Desktop で始めたもの、`claude --bg` で始めたもの）を、あとから親の子として紐付けられる。逆の向きも含む。
- どちらの子も、画面と受信箱で同じように見え、開き方（Desktop で開く・`claude attach`）が分かる。
- Desktop の子の安全面の違い（FR_014 が効かない・トークンを読める）が、子ごとに画面で分かる。

## (b) いまなぜできないか

### 確認した事実

1. 子の種類は daemon 全体の設定 `childRuntime`（`packages/daemon/src/config.ts`）の 1 値で決まる。ノード単位の混在は扱わない、と config.ts と docs/desktop-runtime.md の両方に書いてある。
2. compose.ts が、その 1 値で次を切り替えている。どれもノードではなく木全体に効く。
   - アダプタ: `adapter = desktopAdapter ?? cliAdapter`。`adapterFor: () => adapter`、`managed: (id) => adapter.has(id)`。
   - 起動時の整合の `isExternal`（desktop なら全ノードが真）。
   - `isCliChildOf`、引き出し（`<stateDir>/children.noindex/…`）の作成・削除、フック専用トークンの発行・失効。
   - フックの受け口（`decideCliHook` か `decideDesktopHook`）。
   - 取り消せない操作の確認ゲート `confirmGate`（desktop のときだけ作る）。
   - bind のハンドラ: `createBindHandlers` は `{ cli: true }` か `{ desktop }` の二者択一。
3. `node_spawn` の入力に runtime の指定はない（`packages/mcp/src/tools.ts` の説明。引数は parentId・role・objective・acceptanceCriteria・scope・dependsOn）。`spawn-handlers.ts` は `adapterFor(nodeId)` で親のアダプタを使う（「新しい子のランタイム。親のものを使う」）。
4. `RuntimeAdapter` の契約（`sdk/runtime.ts`）はアダプタ単位で、`has(nodeId)`・`capabilities(nodeId)` の形はあるが、ノードごとに別のアダプタを選ぶ仕組みはない。
5. あとからの紐付け: `node.bindCode` は、spawn で作ったノードに対してだけ働く（running・waiting のみ。docs/desktop-runtime.md）。CLI の木では「紐付けの出し直し」、Desktop の木では「`spawn_task` に渡す文面」を返す。既存の別セッションを、既存のノードに結ぶ道はない。逆もない。
6. Desktop の子の制約（docs/desktop-runtime.md）: 子が human-token・root-token を読める、FR_014 が効かない、`touryouCommand` とフックの確認のゲート（`desktopRequireVerifiedHooks`）が要る、取り消せない操作の確認は /dev/tty なので launchd 経由では通らない（`confirmationUnavailable`）。
7. Desktop の子は daemon が直接操作できない（能力表: send は unsupported、stopDelegated は true、sessionId は false）。停止は受信箱で親に代行を頼む。
8. 再起動後、Desktop の子の整合は `external` で、プロセスで照合しない。根の受信箱に stopIncomplete の帯を 1 件まとめて出す。CLI の子は `lsof` でプロセスを調べて照合する。

### 推測

- ノード単位の runtime を持つ属性は、イベントの `node.created` にはまだないはず（`TreeNode` は id・role・parentId だけ。`NodeRecord` は未確認）。
- 「あとから紐付け」を既存ノードにするには、いまは spawn が先に作業ツリー・トークン・ブリーフを用意する前提なので、紐付け先を「新しいノード」にするか「既存のノードの runtime を変える」かの決定が要る。

## (c) 設計の選択肢

決めること 3 点（Issue 本文）に、各案がどう答えるかを併記する。

### 案 A: runtime をノードの属性にする（`node.created` に `runtime` を持つ）

- 内容: 親が spawn で `runtime` を指定し、`node.created` に記録する。`adapterFor(nodeId)` はノードの runtime で振り分ける。引き出し・フック・confirmGate・整合・`isCliChildOf` を、ノードの runtime を見る形に直す。
- 利点: イベントログが正になるので、再起動後も、画面・受信箱・整合が同じ答えを出す。画面の「安全面の違い」をノードごとに出せる。後付けの紐付けも、属性を使って自然に扱える。設計原則（データの構造化はデータソースに近い層で行う）に合う。
- 欠点: イベントの型と投影の変更（core・daemon・ui・docs に及ぶ）。compose.ts の分岐の総点検が要る。混在の木で受け口（フック）が 2 種類並ぶので、取り違えの防止が要る。
- 難易度: ★★★★☆（4）
- 有効度: ★★★★★（5）
- 推奨: ○（最終形としてはこれ。ただし 0.1.6 には大きい【推測】）

### 案 B: spawn の引数だけで選ぶ（属性は持たず、起動時にアダプタを選ぶ）

- 内容: `node_spawn` に `runtime?` を足し、daemon の `childRuntime` は既定値にする。選んだ結果はメモリ（アダプタの `nodes` Map）にだけ持つ。
- 利点: イベントの型を変えない。変更が spawn と compose の振り分けに寄る。
- 欠点: 再起動で「どの子がどちらか」が失われる（`DesktopRuntimeAdapter.nodes` はメモリだけ、【確認】）。起動時の整合・画面・受信箱が、何で種類を判断するかが決まらない。設計原則に反する（導出できる状態をログに持たない）。
- 難易度: ★★☆☆☆（2）
- 有効度: ★★☆☆☆（2）
- 推奨: ×（再起動で壊れる。案 A への暫定にもなりにくい）

### 案 C: 木を runtime ごとに分ける（根を 2 つに分ける）

- 内容: CLI 用の daemon と Desktop 用の daemon（別の設定・別の stateDir）を並べて運用する。
- 利点: コードを変えない。安全面が混ざらない。
- 欠点: 「同じ木」にならない。後付けの紐付けも、木をまたげない。画面・受信箱が 2 つに割れ、Issue の望む形から外れる。
- 難易度: ★☆☆☆☆（1）
- 有効度: ★☆☆☆☆（1）
- 推奨: ×

### 案 D: 後付けの紐付けだけを別の操作として足す（混在より先に）

- 内容: 「既存セッション → 既存のノード」の紐付けを、新しい操作（例: `node.adopt`）として足す。承認は #145 の守りの考え（【推測】: 取り消せない・権限が広がる操作は人の確認を挟む）に合わせ、受信箱で人が承認してから結ぶ。紐付けのとき、そのノードの runtime を属性に記録する。
- 利点: Issue の 2 つ目の望み（あとから紐付け）に直接答える。1 本ずつ進められる。
- 欠点: 属性（案 A）がないと、結んだ子がどちらかを覚えておけない。承認の扱い・トークンの発行・Desktop 側の子の引き出し／フックの準備の手順を決める必要がある。
- 難易度: ★★★☆☆（3）
- 有効度: ★★★☆☆（3）
- 推奨: △（案 A の上に載せるなら良い。単独では足りない）

### 決めることへの見解

1. 子ごとの runtime の持ち場所: ノードの属性（案 A）。spawn の引数は「入力」であり、記録は属性に残す（案 A + spawn の引数の併用）。
2. 後からの紐付けの手順と承認: 人の承認を受信箱に出し、承認後に daemon がトークンを発行して結ぶ（案 D）。承認の細部は #145 の方針を読んでから決める【推測のまま】。
3. Desktop の子の整合・stall 判定: ノードの runtime で分ける。Desktop の子だけ `external` にし、CLI の子は `lsof` の照合を残す。#11 の方針との整合は未確認【推測】。

## (d) 0.1.6 に入れられる最小の形

結論: 混在・後付けの紐付けは、0.1.6 には入れない。入れるなら、土台だけに絞る。

- 理由【確認＋推測】: compose.ts の `config.childRuntime` に依存する分岐が多く（アダプタ・整合・引き出し・フック・confirmGate・bind）、1 つずつ直す必要がある。安全面に関わるので、部分的に混ぜると、フックの受け口の取り違えが起きうる。
- 0.1.6 に入れられる最小の形（土台）:
  1. `node.created` に `runtime`（cli か desktop）を記録するだけの変更。振り分けはまだ行わず、`childRuntime` と同じ値を入れる。
  2. 画面と受信箱に、子ごとの runtime と開き方（Desktop で開く・`claude attach`）を出す。安全面の違いの注記もここで足す。
  - どちらも挙動を変えない。0.1.7 以降で案 A の振り分け・案 D の後付けを、この属性の上に足せる。
- ただし 1 は、イベントの型と既存ログの互換（属性がない古いノードの扱い）に触れるので、「小さい」と言えるかは `NodeRecord` を読んでから確かめる【推測】。読んで大きければ、2 だけ（daemon の `childRuntime` を画面に出す）が最小。

## 未確認の事項（次に読む）

- core の `NodeRecord` と `node.created` のイベント定義（属性の追加の影響）。
- `cli-adapter.ts`（`ParentRequestCliAdapter`）、`hook-policy.ts`、`children-dir.ts`。
- #145・#150・#11・#136 の内容と、`.sdd/specification/touryou_design.md`・`.sdd/adr/touryou.md` の該当の決定。
