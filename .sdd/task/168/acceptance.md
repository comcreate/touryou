# Issue #168 受け入れ基準の確認（サブ統括・孫）

> 確認の日: 2026-11-23（main の 25b3b4f を基にした作業ツリーで確認）。コードは変更していない。
> 言葉の約束: **確認できた**＝このセッションでファイルを読んだ、または試験を走らせて確かめた。**推測**＝読んでいない、または確かめていない。
> 受け入れ基準の元は `design.md`（案。PR1〜7 の実装前に書かれた）。設計と実装の食い違いは、各項目と「7. 食い違い・試験の抜け」に書く。

## 0. 試験の実行結果（全項目で共通）

作業ツリーに `node_modules` がなかったので、親の承認（scope_extend）を得て `pnpm install --offline` から始めた。1 コマンドずつ実行した。

| 順 | コマンド | 結果 |
| --- | --- | --- |
| 1 | `pnpm install --offline` | 成功（198 パッケージ）。`dist/bin.js` がないという WARN が出たが、ビルド前のため。あとの build で解消 |
| 2 | `pnpm build` | 成功（core・mcp・cli・daemon） |
| 3 | `pnpm test`（そのまま） | core 808 件・mcp 444 件が通った。**cli の 1 件が落ちた**（`packages/cli/test/ui.test.ts:185`「port・human-token・設定がないときは、原因と次の操作を出して止まる」が 5000ms の既定のタイムアウト）。`pnpm -r` が cli の失敗で止まり、この回の daemon の結果は出なかった |
| 4 | `pnpm test --passWithNoTests stop-cascade spawn-handlers parent-request hook-handlers cli-bind-handlers authorize credentials child-permissions hook-policy graph-below` | daemon の 12 ファイル・320 件が通った（core・mcp・cli は該当ファイルなしで空振り） |
| 5 | `pnpm test --testTimeout=60000` | **全部通った**: core 808 件（37 ファイル）、mcp 444 件（25 ファイル）、cli 480 件（18 ファイル）、daemon 2141 件通過・43 件スキップ（118 ファイル通過・3 ファイルスキップ） |

- cli の失敗は #168 と関係しない部分（`touryou ui` の設定がないときの文面）。再試行の待ちが入る試験で、既定の 5 秒に収まらなかった。タイムアウトを延ばすと通る（**確認できた**）。原因が「この Mac の負荷・環境」か「試験自体が 5 秒に収まらない作り」かは、**推測**（調べていない）。CI で落ちる場合は別の Issue。
- daemon のスキップ 43 件は、`describe.skipIf` の条件による。Playwright が使えないとき `packages/daemon/test/ui/browser.test.ts:19`・`real-ui.test.ts:40`・`sse-tabs.test.ts:85` が飛ぶ。`lsof` がないと `sdk/lsof-probe.test.ts:181` が飛ぶ。3 ファイルがスキップなので、**本物の /ui を CSP の下で描く試験は、この環境では走っていない**（どのファイルが実際に飛んだかの内訳は、実行ログに出ていない。条件から見た**推測**）。項目 (3) の実機の確認が要る理由の 1 つ。

## 1. 受け入れ基準 (1) サブ統括を作って紐付けでき、孫を 2 つ以上立てられる

### (a) 根拠のコード・試験

| 事項 | 場所 | 状態 |
| --- | --- | --- |
| サブ統括の生成（`role: integrator`、親は動作中の統合ノード） | `packages/daemon/src/api/handlers/spawn-handlers.ts:442`（親が動作中の統合ノードか）、`:283`（トークンは役割で `integrator`／`child` を発行） | 確認できた |
| bind コードの発行: 直接の親の統合ノードか人間だけ。根（親なし）は拒否。Desktop の木は `integratorNotSupported` | `packages/daemon/src/api/handlers/bind-handlers.ts:199-223` | 確認できた |
| bind コード → 統合ロールのトークン | 試験 `packages/daemon/test/api/server.test.ts:637`（統合ノードのコードは統合ロールのトークンを返す。木にないノードのコードは使えない） | 試験の存在を確認できた（`server.ts` の実装本体は読んでいない） |
| 再紐付けはロールを引き継ぐ | `packages/daemon/test/api/credentials.test.ts:42` | 試験の存在を確認できた |
| 発行の規則の試験（直接の親と人間は可。親でない者・根・Desktop は不可） | `packages/daemon/test/api/handlers/cli-bind-handlers.test.ts:100`・`:109` | 確認できた |
| `child_bind` が戻りのロールで道具を切り替える | `packages/mcp/test/child-bind.test.ts:65`、`packages/mcp/test/server.test.ts:231`、`packages/mcp/test/tools.test.ts:31` | 試験の存在を確認できた |
| 起動の許可（サブ統括は統合の道具＋`child_bind`。人間専用は入らない）と、起動の指示の文の書き分け | `packages/daemon/test/sdk/child-permissions.test.ts:158`・`:184`・`:190`、`packages/daemon/test/api/parent-request.test.ts:202`・`:235`、`packages/daemon/test/sdk/hook-policy.test.ts:732`・`:752` | 確認できた |
| サブ統括が自分の親へ子の操作を使える（根は拒否） | `packages/daemon/test/api/authorize.test.ts:299`、`packages/core/test/contract.test.ts:122`、`packages/core/test/mcp-tool-names.test.ts:26` | 確認できた |
| 深さ: 既定 3、サブ統括（深さ 1）の下の孫は深さ 2 で作れる | `spawn-handlers.test.ts:515`（上限 2 で深さ 2 を断る）・`:529`（上限 3・深さ 2 は作れる）・`:540`（既定 3 で深さ 3 を断る）、実装は `spawn-handlers.ts:466-473` と `depth-check.ts`、`config.ts:250`、`docs/config.md:47` | 確認できた |
| 同時の起動の上限（親ごと 4・全体 4）。孫 2 つは範囲内 | `spawn-handlers.ts:130`（`DEFAULT_START_LIMITS`） | 確認できた |

### (b) 試験の実行結果

上の試験は、0 の手順 5 で**すべて通った**。手順 4 の 12 ファイルにも、`cli-bind-handlers`・`spawn-handlers`・`parent-request`・`credentials`・`child-permissions`・`hook-policy`・`authorize` が入っており、通った。

### (c) 実機でしか確かめられない部分

- 本物の `claude --bg` で、サブ統括のセッションが起動し、`child_bind` を引数なしで呼んで紐付き、統合の道具が出ること（daemon の試験は、アダプタを作り物にしている）。
- サブ統括のセッションが、`mcp__node__node_spawn` で孫を 2 つ立て、孫の起動の依頼（`parent_request`）が**サブ統括のセッション**に届き、サブ統括が `claude --bg` を実行できること。
- 手順は「6. 実機（RC）での確認の手順」の A〜C。

### 設計と実装の違い・抜け

- **試験の抜け（確認できた）**: 「孫を 2 つ以上立てる」を直接の題にした試験は、`git grep`（サブ統括・孫・`2 つ`）で見つからなかった。`spawn-handlers.test.ts` の試験は、サブ統括 `m1` の下に 1 つずつ作る形。同じ親の下に複数作る一般の試験（スケジューラの上限）はあるかもしれないが、サブ統括の下で複数を確かめる試験は**確認できていない**。
- `design.md` §3 は `bind.redeem` が `server.ts` でロールに従うと書く。このセッションでは `server.ts` を読んでいない。試験（`server.test.ts:637`・`credentials.test.ts:42`）が通ることだけが根拠。実装本体の確認は**推測**の段階。

## 2. 受け入れ基準 (2) 孫の範囲がサブ統括の範囲の外に出ない（試験あり）

### (a) 根拠のコード・試験

| 事項 | 場所 | 状態 |
| --- | --- | --- |
| 子の範囲を、親の有効な範囲と比べる（作業ツリーを作る前） | `spawn-handlers.ts:511-519`（`childScopeProblem`。根は `rootScope` と比べる）、`spawn-handlers.ts:9-11` の説明 | 確認できた |
| 範囲の包含の判定（コマンド・書き込む場所・禁止の場所。絶対パスは不可。親子の作業ツリーが別のときの比べ方） | 試験 `packages/core/test/scope.test.ts:397-455`（`isScopeSubset`）、`packages/core/test/permissions.test.ts:206-220`（mcp の道具） | 確認できた |
| サブ統括の下に、範囲を超える子を作ると `scopeNotSubset`。何も記録せず、作業ツリーも作らない | `packages/daemon/test/api/handlers/spawn-handlers.test.ts:368-385`。親は `m1`（根の子の統合ノード＝サブ統括）で、`allowedCommands: ["rm -rf"]` を渡して断られる。`provisioned`・`issued`・`started` が空 | 確認できた |
| 採用（adopt）も同じ検査 | `packages/daemon/test/api/handlers/adopt-handlers.test.ts:231`（`scopeNotSubset`） | 確認できた |
| 孫のフックの判定は、孫自身の範囲 | `packages/daemon/test/sdk/hook-policy.test.ts:670-720`（孫がサブ統括の範囲の内でも、孫自身の範囲の外なら拒否。孫の範囲の内なら許可。範囲の包含は spawn の検査の仕事と明記） | 確認できた |
| 範囲の拡張の承認は、親の範囲を超える分は承認しない | `packages/daemon/test/api/handlers/scope-handlers.test.ts:293` | 確認できた |

### (b) 試験の実行結果

上の試験は、0 の手順 5 で**すべて通った**。

### (c) 実機でしか確かめられない部分

- 孫のセッションが、サブ統括の範囲の外（例: サブ統括は `docs` だけ、孫は `src`）に書こうとして、フックに拒否されること。
- 孫の `scope_extend` が、**サブ統括の受信箱**に届き、サブ統括が判定できること。サブ統括の範囲を超える分は、サブ統括が自分の親（根）へ出し直すこと。手順は 6 の D。

### 設計と実装の違い・抜け

- **試験の抜け（確認できた）**: `spawn-handlers.test.ts:368` が見るのは `allowedCommands` の超過だけ。`writableLocations`・`forbiddenLocations` の超過は、core の `isScopeSubset` の試験（`scope.test.ts`）で確かめているが、**サブ統括の下の spawn を通した試験としては見つからなかった**。コマンド以外の超過は、判定関数の単体の試験で代える形。
- **試験の抜け（確認できた）**: 「孫の範囲 ⊆ サブ統括の**拡張を承認したあとの**範囲」を通した試験は、`git grep`（`effectiveScope` 系の語は未検索）では**確認できていない**。`design.md` §4 の「有効な範囲は実行時に変わる」の部分。**推測**: `childScopeProblem` が `effectiveScope(state, parentId)` を使うので動く（design.md の記述。コードの該当行は読んでいない）。
- 設計どおり、判定コード（`compose.ts` の `decideCliHook`）は変えていない（試験だけ追加）。`compose.ts` は読んでいない。試験の題から**推測**。

## 3. 受け入れ基準 (3) 状態画面と受信箱で、階層と孫の状態が分かる

### (a) 根拠のコード・試験

| 事項 | 場所 | 状態 |
| --- | --- | --- |
| 表示モデル `UiNode.below`（配下の件数・配下の「あなたの答え」の件数。サブ統括だけ） | 試験 `packages/core/test/ui-view-hierarchy.test.ts:52-85`、実装は `packages/core/src/ui-view.ts`（グレップで該当を確認。中身は読んでいない） | 試験の存在を確認できた |
| 関係図のサブ統括の表示（「統合（配下 3 件・あなたの答え 1 件）」、英語あり、根・作業ノードには付けない） | `packages/daemon/test/ui/graph-below.test.ts:19-60`、`docs/ui.md:187` | 確認できた |
| 「止めた・済んだ子を隠す」がサブ統括ごとに効く | `graph-below.test.ts:88`・`:95`、`docs/ui.md:187` | 確認できた |
| 受信箱の要約（digest）の種類の名前「サブ統括の要約」 | `graph-below.test.ts:128`、`docs/ui.md:188` | 確認できた |
| 根の受信箱にサブ統括の要約が見え、孫の自由な文字列が入らない | `ui-view-hierarchy.test.ts:87-135`（`:109`・`:118`・`:124`）、`docs/digest.md:35` | 確認できた |
| 受信箱・一覧は呼び出し側の部分木に絞られる（サブ統括は自分の孫だけ） | `design.md` §2.1 が `visible.ts` の `visibleState` を挙げる。**このセッションでは読んでいない**。試験は `ui-view-hierarchy.test.ts:109-117`（サブ統括自身にも見える・別の作業ノードには見えない） | 試験の存在を確認できた。実装は推測 |
| 本物の /ui（CSP の下で関係図）の試験 | `packages/daemon/test/ui/real-ui.test.ts:40`・`browser.test.ts:19`。ただし、サブ統括の階層を描く題は**見つからなかった**（`real-ui.test.ts:434-437` は列の見出しを出さない確認、`browser.test.ts:463-476` は孫まで 3 段の高い木を測る） | 確認できた |

### (b) 試験の実行結果

core・daemon の表示モデルと関係図の試験は、0 の手順 5 で**通った**。ただし Playwright を使う `browser.test.ts`・`real-ui.test.ts`・`sse-tabs.test.ts` は、**この環境ではスキップされた可能性が高い**（0 を参照）。本物のブラウザの描画は、走らせた試験では確かめられていない。

### (c) 実機でしか確かめられない部分

- 本物の `/ui` に、根・サブ統括・孫 2 つが関係図で見え、サブ統括の箱に「配下 2 件」と出ること。孫の状態（動いている・答え待ちなど）が、孫の箱と一覧で分かること。手順は 6 の E。
- 根の受信箱に、サブ統括の要約（`digest`、30 秒周期）が出ること。孫の自由な文字列が出ないこと（6 の E・F）。
- 明るい・暗い、スマホの幅、日本語・英語の見た目は、UI レビューの範囲。ここでは階層が読み取れるかだけを見る。

### 設計と実装の違い・抜け

- `design.md` §6 は「`ui-view.ts` の変更が要るか、実装 PR で確かめる（未読のため推測しない）」としていた。実装では `UiNode.below` を足している（試験とドキュメントから**確認できた**。`ui-view.ts` の中身は読んでいない）。
- **試験の抜け（確認できた）**: `design.md` §11 の e2e「実際の `/ui` を開いて、サブ統括と孫 2 つの階層を確かめる」に当たる試験は、見つからなかった。`scripts/ui-preview.mjs` と `docs/ui.md:254`・`docs/manual-verification-checklist.md:292` は「統合 1・子 5・孫 5」の作り物を出すが、これは**統合ノードが根だけ**の木で、サブ統括の形ではない（`docs/ui.md:254` の記述から**推測**。スクリプトは読んでいない）。
- `docs/manual-verification-checklist.md` に、サブ統括・孫の手順は**ない**（`git grep` で `サブ統括`・`#168` が 0 件）。

## 4. 受け入れ基準 (4) サブ統括を止めたときの孫の扱いが決まっていて、試験がある

### (a) 根拠のコード・試験

| 事項 | 場所 | 状態 |
| --- | --- | --- |
| 決め: 連動停止（配下の動作中を先に停止、確認後にサブ統括の停止。`done` は対象外。確認できなければ `stopIncomplete`） | `.sdd/adr/touryou-168-stop-cascade.md`、`plugin/skills/integrator/SKILL.md:78`、`docs/plugin.md:93`、`docs/cli.md:180` | 確認できた（ADR の中身は読んでいない。skill と docs の記述を読んだ） |
| 孫が先に停止の依頼に載り、確認されるまでサブ統括は `stopping` に留まる。確認後に自分のセッションの停止が始まる | `packages/daemon/test/api/handlers/stop-cascade.test.ts:123-143` | 確認できた |
| 確認できないと、サブ統括も `stopIncomplete`。理由（孫の ID と状態）が受信箱に出る | `stop-cascade.test.ts:145-160` | 確認できた |
| 確認できなかったあと、親が孫の停止を宣言（`node.confirmStopped`）してから、サブ統括を止め直せる | `stop-cascade.test.ts:162-175`。`design.md` §5・§12 の宿題（親が不在のときの停止の確認の経路）に当たる | 確認できた |
| `done` の孫は止めない。`verified` の孫は状態を変えず、停止の依頼を出し直す | `stop-cascade.test.ts:177-192` | 確認できた |
| 同じ requestId の再送で、孫の依頼を重ねない | `stop-cascade.test.ts:194-202` | 確認できた |
| 別のサブ統括 `m2` の配下には影響しない。`m2` も同じ順 | `stop-cascade.test.ts:140`・`:204-` | 確認できた |
| 回収は後順（孫が先） | `design.md` §2.1 が `runtime-handlers.ts`・`reclaim-handlers.ts` を挙げる。試験は `packages/daemon/test/api/handlers/runtime-handlers.test.ts` に「サブ統括・孫」の題があるが、題を読んだだけ。**後順の回収を直接確かめる題は、この調査では確認できていない** | 一部確認 |
| 配下が停止中の間に `done` の統合ノードを人が止める経路 | `docs/cli.md:180`（配下の動作中の子が先に止まる） | 確認できた |

### (b) 試験の実行結果

`stop-cascade.test.ts` は、0 の手順 4 と 5 の両方で**通った**。

### (c) 実機でしか確かめられない部分

- 本物の `claude --bg` のセッション 3 つ（サブ統括・孫 2 つ）を、`node_stop` で止める。孫が先に止まり、サブ統括が最後に止まること（`claude agents --json` に出る名前と状態で確かめる）。手順は 6 の G。
- サブ統括のセッションが応答しないとき、根が孫ごとに `claude stop` を実行し `node_confirmStopped` で宣言して、サブ統括を止め直せること（6 の H）。
- 止めたあと、孫の作業ツリーとコミットが残ること、`touryou reclaim` が孫から先に進むこと（6 の I）。

### 設計と実装の違い・抜け

- **設計と実装の違い（確認できた）**: `design.md` §7 の「孫の停止が確認できない（`stopIncomplete`）ときは、サブ統括も `stopIncomplete`」は、試験どおり実装されている。`design.md` は待ちの上限を決めていなかったが、`SKILL.md:78` は「上限（10 分）」と書く。**10 分は、このセッションではコードで確かめていない**（skill の記述のみ。**推測**）。
- **試験の抜け（確認できた）**: 孫の停止の確認のために、アダプタ（`ParentRequestCliAdapter`）が親へ `parent_request` を出し、親のセッションが `claude stop` を実行する、という本物の流れの試験は、作り物のアダプタの試験だけ。実機の確認が必要。
- **試験の抜け**: サブ統括が `pending`（まだ起動していない孫）を持つとき、`design.md` §7 の対象から外れるか。`stop-cascade.test.ts:59` の木に `gp(pending)` があり、`:145-160` の「確認できた孫（gp）は理由に出ない」で扱っている（**確認できた**）。`SKILL.md:78` の「動作中（`pending`・`running`・`waiting`）」と合っている。

## 5. 受け入れ基準 (5) docs・skill（integrator・child）・CHANGELOG が直っている

### (a) 根拠

| 対象 | 状態 | 場所 |
| --- | --- | --- |
| integrator の skill | **直っている（確認できた）** | `plugin/skills/integrator/SKILL.md:31`（範囲は親の禁止を含める）、`:38`（Desktop は不可・CLI のサブ統括は可）、`:51`（サブ統括だけが使う報告の道具）、`:68-79`（サブ統括の節: 立てる・起動と紐付け・深さの上限・報告・孫の依頼・連動停止・要約）、`:116`（digest） |
| child の skill | **サブ統括の記述は、ない（確認できた）** | `plugin/skills/child/SKILL.md` に `サブ統括`・`integrator`・`#168` は 1 件もない（`git grep` で、統合・親の語だけが 8 行ヒット。どれも一般の「統合ノードから任された子」の記述）。`design.md` §10 の PR7 は「integrator／child の skill」の更新を挙げていた |
| docs | **直っている（確認できた）** | `docs/plugin.md:88-94`（サブ統括の節）、`docs/desktop-runtime.md:130`（Desktop は不可・CLI は可）、`docs/digest.md:35`、`docs/ui.md:187-188`、`docs/config.md:47`（`maxTreeDepth`）、`docs/cli.md:180`（連動停止） |
| `docs/manual-verification-checklist.md` | **サブ統括の手順は、ない（確認できた）** | `git grep` で 0 件（`integrator` は N1・N5 の根の統合セッションのみ） |
| `.sdd` の仕様・ADR | ADR は 4 件ある | `.sdd/adr/touryou-168-approval-route.md`・`-integrator-child-operations.md`・`-scope-hierarchy.md`・`-stop-cascade.md`（ファイルの存在のみ確認。中身は読んでいない）。`.sdd/specification/touryou_spec.md` と `.sdd/adr/touryou.md` にも `サブ統括`・`孫` の語がある（**語があることだけ確認**） |
| CHANGELOG.md | **確認できなかった** | このタスクの範囲で `CHANGELOG.md` は禁止の場所。`git grep ... CHANGELOG.md` はフックに拒否された。**直っているかは、この文書では判定しない**（親か人が確かめる） |

### (b) 試験の実行結果

skill・docs の文面は試験の対象ではない（`packages/core/test/failure-messages` 系や、`mcp` の `tools.test.ts` は道具の説明を見るが、skill の文は見ない。**推測**）。

### (c) 実機でしか確かめられない部分

- skill の手順どおりに、人が初めてサブ統括を立てて孫を動かせるか（言葉が通じるか）は、UX レビューの範囲。6 の手順を、skill と docs だけを見て進められるかを確かめる。

### 設計と実装の違い・抜け

- **食い違い（確認できた）**: `design.md` §10 の PR7 は child の skill も直すとしたが、`child/SKILL.md` にサブ統括の記述がない。サブ統括は integrator の skill で動く（起動の指示が integrator を指す。`parent-request.test.ts:235`）ので、child の skill に足す必要がない可能性がある。**推測**。ただし、サブ統括が自分の親へ報告するときは「`/touryou:child` の手順」を使う、と `SKILL.md:51` が書く。その `child` の skill に、サブ統括が読む前提の記述（ツール名の `mcp__node__` の名前空間が統合・子で同じことなど）がなくてよいかは、人が判断する。
- `docs/manual-verification-checklist.md` に、サブ統括の手順を足すのがよい（6 の手順が、そのまま使える）。

## 6. 実機（RC）での確認の手順

前提: RC（リリース候補）を入れた Mac。`/touryou:setup` と `/touryou:start` が済み、統合セッション（根）が `whoami` で `integrator`・`root` を返す。以下は、`plugin/skills/integrator/SKILL.md`・`docs/plugin.md`・`docs/cli.md` の手順と道具名に合わせた。**道具の引数の細かい形は、skill を見て合わせる**（ここに書いた形は、読んだ範囲からの**推測**を含む）。

### A. サブ統括を立てて紐付ける

1. 根の統合セッションで、`mcp__node__node_spawn` を呼ぶ。`role: integrator`、`parentId` は根の ID、`objective`・`acceptanceCriteria`・`scope`（例: `writableLocations: ["docs"]`、`allowedCommands: ["git status"]`）を渡す。見るもの: 返り値の `status` が `running` か `pending`（起動待ち）、`nodeId` が返る。
2. 根の受信箱（`mcp__node__inbox_fetch`）に、サブ統括の起動の依頼（`parent_request`。`command` に `claude --bg`）が出る。見るもの: 依頼の指示の文が「touryou の integrator の skill に従って、最初に child_bind を引数なしで呼んで」の形で、子の文（「最初に touryou の child_bind を引数なしで呼んで、受信箱の手順に従って」）と**書き分けられている**。
3. 依頼の `command` を、根が実行する。見るもの: `claude agents --json` に、サブ統括のセッションが出る。
4. サブ統括のセッションで、`child_bind` が成功する（`bound: true`、`role: "integrator"`）。見るもの: そのあと `mcp__node__whoami` が `integrator` を返し、`node_spawn`・`node_review`・`parent_request` が道具に出る。**`role` が `child` になっていたら失敗**。
5. 紐付けのやり直し: 一度、根の `mcp__node__node_bindCode`（引数は、サブ統括の `nodeId`）を呼ぶ。見るもの: コードを出し直した旨の文（コードそのものは文にない）。人間として `touryou` の CLI でも出し直せるか（`docs/cli.md`）。

### B. 孫を 2 つ立てる

1. サブ統括のセッションで、`mcp__node__node_spawn` を 2 回呼ぶ（`parentId` は自分。`role` は省略か `child`。`scope` は A の範囲の内側。例: `writableLocations: ["docs/a"]` と `["docs/b"]`。`allowedCommands` は `git status` など A の範囲の内側）。見るもの: 2 つとも `running`（親ごとの同時の起動は 4 まで）。
2. サブ統括の受信箱に、孫 2 つの起動の依頼が出る（根の受信箱ではない）。サブ統括が、それぞれの `command` を実行する。見るもの: `claude agents --json` に孫 2 つが出る。
3. 孫のセッションで、`child_bind` が成功し（`role: "child"`）、`report_progress` が通る。見るもの: サブ統括の受信箱に、孫の進捗が出る。**根の受信箱には、孫の自由な文は出ない**（要約だけ。F）。

### C. 深さの上限

1. サブ統括から、さらに統合ノード（孫の位置に `role: integrator`）を立てる。見るもの: 既定の `maxTreeDepth` 3 では、深さ 2 までは作れる。孫の下に、もう 1 段（深さ 3）を作ろうとすると、`depthExceeded` で断られ、`cause`・`nextActions` に `maxTreeDepth` が出る（`docs/config.md:47`）。
2. 設計と実装の違い: `design.md` §8 は「孫（深さ 2）は作業ノードのみにする。サブ統括の下の統合ノードは、既定 3 では作れる」と書く。深さ 2 の統合ノード（サブサブ統括）が作れる**可能性がある**ことを、ここで確かめ、人が許してよいかを決める（**推測**。`depthExceeded` の試験は深さ 3 を断るだけで、深さ 2 の統合ノードを断る試験は見つからなかった）。

### D. 範囲

1. 孫に、サブ統括の範囲の外（例: サブ統括は `docs` だけなのに `src`）への書き込みを頼む。見るもの: フックが拒否する。
2. 孫から `scope_extend`（例: `docs/c` の書き込み）を出す。見るもの: サブ統括の受信箱に要求が出る。サブ統括が承認すると、孫が書ける。サブ統括の範囲の外の場所を求める要求は、サブ統括が自分の親へ `scope_extend` を出し直し、根が判定する。
3. サブ統括から、範囲の外の孫を `node_spawn` する。見るもの: `scopeNotSubset` で断られ、孫の作業ツリーが作られない（`git worktree list` に増えない）。

### E. 状態画面（/ui）

1. `touryou ui`（または `/touryou:ui`）で、既定のブラウザに開く。
2. 見るもの（関係図）: 根 → サブ統括 → 孫 2 つの木。サブ統括の箱の役割の行に「統合（配下 2 件）」（英語は「integrator (2 below)」）。孫に答え待ちがあれば「配下 2 件・あなたの答え 1 件」。孫の箱の状態の言葉が、動き（進んでいる・答え待ち・止まったなど）に合っている。箱を押す（Enter でも）と、その子のカードへ移る。
3. 孫の 1 つを完了（`report_done`）にして、「止めた・済んだ子を隠す」を使う。見るもの: 済んだ孫が隠れ、動いている孫を持つサブ統括は残る。配下の件数は変わらない。
4. 見るもの（受信箱）: 根の受信箱にサブ統括の要約（「サブ統括の要約」。30 秒ほどで出る）が出る。

### F. 要約に孫の自由文が入らないこと

1. 孫に、`report_progress` で目印の文字列（例: `SECRET-MARK-168`）を含む文を送らせる。
2. 根の `inbox_fetch` と `/ui` の受信箱で、要約の項目に `SECRET-MARK-168` が**出ない**こと。サブ統括の受信箱の孫の進捗には出ること。

### G. 連動停止

1. 孫 2 つが `running` のまま、根から `mcp__node__node_stop`（サブ統括、`mode: graceful`）。
2. 見るもの: サブ統括が `stopping` に入り、根の受信箱に、孫の停止の依頼（`parent_request`）が出る（サブ統括が**まだ**自分のセッションの停止を始めない）。依頼の宛先は、サブ統括のセッション（孫の直接の親）。サブ統括が `claude stop` を孫に実行し、孫が `stopped` になったあとで、サブ統括自身の停止が始まり、`stopped` になる。
3. 孫の 1 つを、先に `done` にしてから、同じ手順を行う。見るもの: `done` の孫は止められず、`done` のまま残る。サブ統括の停止は、動いていた孫の確認だけを待つ。

### H. サブ統括が応答しないとき

1. サブ統括のセッションを、`claude stop` で先に止める（孫は動かしたまま）。根から `node_stop`（サブ統括）。
2. 見るもの: 上限（`SKILL.md:78` は 10 分と書く）までに孫の確認が来ないと、サブ統括が `stopIncomplete` になり、根の受信箱に、孫の ID と状態を理由にした項目が出る。
3. 根が、孫ごとに `claude agents --json` で動いていないことを確かめ（動いていれば `claude stop`）、`mcp__node__node_confirmStopped` で宣言する。続けて、サブ統括を `node_stop` で止め直す。見るもの: 孫の確認を待たずに、サブ統括が `stopped` へ進む。

### I. 回収（後順）

1. 孫の作業ツリーとコミットが残っていること（`git worktree list`、孫のブランチの `git log`）。
2. `touryou reclaim <孫の nodeId>` の表示を見て、`--yes --expect` で回収する。孫 2 つの回収が済んだあとに、サブ統括を回収する。見るもの: サブ統括の回収が、配下がすべて `reclaimable`・`archived` になるまで断られる（**後順**。`design.md` §2.1 の記述）。
3. `/ui` で、回収したノードが archived として隠れること。

## 7. 食い違い・試験の抜け（まとめ）

**確認できたこと**

1. 受け入れ基準 (2)・(4) の「試験あり」は満たす。(2) は `spawn-handlers.test.ts:368`（サブ統括 `m1` の下）・`scope.test.ts:397`・`hook-policy.test.ts:670`、(4) は `stop-cascade.test.ts`（7 題）。
2. (1)・(3)・(5) のうち、道具・docs・skill（integrator）は揃っている。`child` の skill と `CHANGELOG.md` は、上のとおり。
3. 全試験は、タイムアウトを 60 秒にして通った。既定の設定では、cli の `ui.test.ts:185` が 5 秒を超えて落ちる（#168 と無関係）。
4. 本物のブラウザの試験（Playwright）は、この環境でスキップされた可能性が高い。

**試験の抜け**

- サブ統括の下に孫を 2 つ以上作る試験（C 以外）。
- サブ統括の下の spawn で `writableLocations`・`forbiddenLocations` を超える試験（コマンドの超過だけ）。
- サブ統括の範囲を拡張したあとの、孫の spawn の包含検査。
- 回収が後順であることを、サブ統括と孫の木で確かめる試験（題が見つからなかった。読んでいない可能性がある）。
- 深さ 2 の統合ノード（サブサブ統括）を断る・許すの確認（設計は「許す。試験の対象は 2 段まで」）。
- /ui でサブ統括と孫 2 つを描く e2e（`design.md` §11）。

**推測のまま（読んでいない）**

- `server.ts` の `bind.redeem`、`runtime-handlers.ts` の停止の連動の本体、`ui-view.ts`、`visible.ts`、`compose.ts`、`ParentRequestCliAdapter`。試験とドキュメントの記述だけを根拠にした。
- 停止の待ちの上限 10 分。
- `scripts/ui-preview.mjs` の作り物の木が、サブ統括の形を含まないこと。

**設計との違い**

- `design.md` は案のまま（「状態: 案（親の承認前）」）で、実装後の更新がされていない。判断 2〜4 の回答の記録は、ADR 4 件のほうに移っているはず（中身は読んでいない）。
- `design.md` §10 の PR7 が挙げる `child` の skill は、直っていない。

**このタスクで確かめていないこと（親か人に確認が要る）**

- `CHANGELOG.md` に #168 の項目があるか。
- 実機の確認（6 の A〜I）。
