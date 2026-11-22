# Feature #168 サブ統括（統合ノードの下の統合ノード）設計書（案）

> 状態: 案（親の承認前）。コードは変更しない。ADR の本体・仕様書の更新は、承認後に別の作業で行う。
> 決めたことごとの ADR 案は `adr-draft-*.md`。利用者の判断が要る点は「9. 利用者に確認が要る点」にまとめる。

## 1. 目的と範囲

統合ノード（root）の下に統合ノード（サブ統括）を置き、サブ統括が自分の下に孫の作業ノードを作って、受け取り・差し戻し・回収まで行えるようにする。

- 含む: サブ統括の紐付け・資格、道具の許可、範囲の階層、孫の起動／停止の依頼の経路、受信箱と状態画面の階層、サブ統括停止時の孫の扱い、深さの上限。
- 含まない: 複数の root・複数の daemon（#161）、CLI と Desktop の混在（#159）。ただし両者の決定（#159 案 A: runtime をノード属性にする。#161 案 B: daemon を root ごとに分ける）と矛盾しないようにする。

## 2. 現状の事実（コードで確かめたもの）

Issue の記述は主張であり、以下は実装を読んで確かめた。

### 2.1 すでにできていること

| 事項 | 根拠 |
| --- | --- |
| 統合ノードの子として、統合ノードを spawn で作れる。木の不変条件は「親は統合ノード」だけで、深さの制限はない | `packages/daemon/src/api/handlers/spawn-handlers.ts` の `create`、`packages/core/src/tree.ts` の `validateTree`（`parentNotIntegrator`・`rootNotIntegrator`）。`depthOf` はあるが上限の検査はない |
| 子の範囲は、親の有効な範囲（ブリーフ＋承認済みの拡張）の部分集合に限られる。親にブリーフがない（root）ときは設定の `rootScope` と比べる | `child-scope-check.ts` の `childScopeProblem`（`effectiveScope(state, parentId) ?? rootScope`、`isScopeSubset`）。したがって「孫の範囲はサブ統括の範囲の内側」は spawn の時点で既に検査される（試験は未整備） |
| 部分木の認可は任意の深さに効く | `packages/core/src/contract.ts` の `SUBTREE_RULES`（strictDescendant／directChild／selfOrDescendant）と `tree.ts` の `isInSubtree`・`isStrictDescendant`・`isDirectChild` |
| 受信箱・一覧は、呼び出し側の部分木に絞られる | `packages/core/src/visible.ts` の `visibleState`（`isInSubtree` で絞る） |
| 中間統合ノード向けの要約（digest）が実装済み | `packages/core/src/digest.ts` の `digestTargets`（根でない動作中の統合ノード）・`digestOf`、`packages/daemon/src/digest-issuer.ts`（30 秒周期。文面は件数・状態名・ID のみで、子の自由文字列を含めない）。`docs/digest.md` |
| 起動・停止・削除の依頼は、CLI ランタイムでは直接の親が受ける | `packages/daemon/src/sdk/cli-adapter.ts` の `ParentRequestCliAdapter`（daemon はセッションを起動・停止しない。親に `parent_request` で依頼し `parent_report` で報告させる）。`parent.request`／`parent.report` は `directChild` の規則。アダプタは `adapterFor(parentId)` で親のものを使う |
| 停止の認可・確認 | `runtime-handlers.ts` の `node.stop`・`node.confirmStopped`（strictDescendant）。回収は後順（配下から先）で、統合ノードは「配下がすべて reclaimable／archived」が条件 |

### 2.2 できないこと（#168 の原因）

1. **紐付けの拒否**: `packages/daemon/src/api/handlers/bind-handlers.ts` の `node.bindCode` が、統合ノードに `integratorNotSupported`（193〜199 行付近。「仮置き」）を返す。`hook-handlers.ts` の `node.hookToken`（116〜122 行付近）も統合ノードに同じ失敗を返す。
2. **資格のロール固定**: `packages/daemon/src/api/server.ts` の `bind.redeem` は `checkPrincipal({ role: "child" })` を検査し、`credentials.ts` の `issueNodeToken(nodeId, "child", "bind")` を発行する。`authorize.ts` の `checkPrincipal` は「トークンのロール＝ノードのロール」を要求するので、統合ノードには子トークンが通らない（401）。`rebindNodeToken` も子固定。
3. **mcp のロール固定**: `packages/mcp/src/server.ts` の `child_bind` は成功時に `deps.role = "child"` へ切り替え、`toolsFor(role)` で子の道具だけを出す。
4. **許可の一覧に統合の道具がない**: `packages/daemon/src/sdk/child-permissions.ts` の `childAllowList(scope, toolNames)` に渡るのは `CHILD_MCP_TOOL_NAMES`（core の `contract.ts`）で、`node_spawn`・`node_review`・`parent_request` などを含まない。
5. **深さの上限がない**: `validateTree` は深さを見ない。
6. **サブ統括停止時の孫の連動はない**（確認した範囲）: `node.stop` は対象 1 ノードの遷移とアダプタ停止のみ。回収の条件は配下の状態を見るが、停止そのものは連動しない。

## 3. 期待 1: サブ統括を作って紐付ける（資格・紐付け）

### 設計

- **資格は「ノードのロールで決まる 1 本の経路」にする**（案 A。ADR: `adr-draft-credential.md`）。
  - bind コードの引き換え（`bind.redeem`）は、コードに結びつくノードの `role` を読み、`integrator` なら `issueNodeToken(nodeId, "integrator", "bind")`、`child` なら従来どおり子トークンを発行する。ロールを呼び出し側（引数）から受け取らない（昇格の経路を作らない）。
  - `checkPrincipal` の「トークンのロールとノードのロールの一致」は維持する。これが「子トークンで統合の操作ができない」ことの保証であり、変えない。
  - `rebindNodeToken`（再紐付け）も、ノードのロールに従う。
  - 統合トークンの失効状態は、子と同じ（stopIncomplete・stopped・reclaimable・archived で失効）。
- **bind コードの発行は、直接の親の統合ノードだけ**（`node.bindCode` の既存規則 `isStrictDescendant` を、直接の親に狭めるか現状のまま strictDescendant にするかは、実装 PR で確定。提案は現状維持＝ root も代行できる。再紐付けの救済のため）。人（human）の発行は現状どおり。
- **root トークンとの違い**:
  - root の統合トークンは、人が `/touryou:start` で用意した常駐のもの（根はブリーフを持たず、`rootScope` が範囲）。
  - サブ統括の統合トークンは、ノードに結びつき、**ブリーフ（範囲）を持つ**。操作の認可はロールの規則（`ROLE_OPERATIONS`）が同じでも、**部分木の起点が自分**なので、自分の部分木の外には効かない。さらに、サブ統括は `human` 専用の操作（`node.hookToken`、根の `scope.decide` の対象外）を持たない。
  - 範囲は、起動時に親が決めた（親の内側の）範囲で絞られる。root の `rootScope` より広くならない（`childScopeProblem`）。
- **mcp**: `child_bind`（引数なし）は、紐付け成功時に返ってきたトークンのロールで `deps.role` を決める。統合ロールなら `toolsFor("integrator")` を出す。道具名の名前空間（`mcp__node__*`／`mcp__plugin_touryou_node__*`）は変えない。
- **CLI の紐付けの検査**（`cli-bind-check.ts`: cwd が作業ツリーの実パスと一致し `.git` がファイル）は、サブ統括にも同じに適用する。
- **起動**: サブ統括の起動は、孫と同じく親の `parent_request`（launch）で行う。起動の指示文は、`integrator` の skill を使うよう書き分ける（`child` ではなく）。

### 許可の一覧（`--settings` の `permissions.allow`）

- サブ統括の起動時の許可は、`childAllowList(scope, toolNames)` に**統合の道具の一覧**を渡す。新しく `INTEGRATOR_MCP_TOOL_NAMES`（core の `contract.ts`。`ROLE_OPERATIONS.integrator` から導く。子の一覧と同じ置き場）を定義し、起動時にロールで切り替える。
- 範囲の許可（`Bash(...)`・`Edit(...)`）の検査規則（1 語コマンド・任意コード実行の拒否）はそのまま使う。
- `human` 専用の操作と、サブ統括が使うべきでない道具（例: 根の設定変更）は入れない。

## 4. 期待 2: 範囲（scope）の階層

- **サブ統括の範囲 ⊆ 親の範囲、孫の範囲 ⊆ サブ統括の範囲**。spawn 時の `childScopeProblem` が既にこの検査をしているので、規則の追加は不要。**試験の追加**が仕事。
- **有効な範囲は実行時に変わる**（拡張の承認）。孫の範囲は spawn 時点の部分集合だが、サブ統括の範囲が後から縮むことは今はない（拡張のみ）ので、不変条件は「孫の範囲 ⊆ サブ統括の（その時点の）有効な範囲」で保たれる。サブ統括の拡張は孫の許可を広げない（孫の許可は孫自身の `effectiveScope`）。
- **孫のフック（守り）の判定は、孫自身の `effectiveScope`**（案 A。ADR: `adr-draft-scope-hierarchy.md`）。`compose.ts` の `decideCliHook` は `effectiveScope(state, nodeId)` と `cwdOf` を使うので、**判定コード自体は変更不要**。孫の範囲がサブ統括の内側であることは spawn 時に保証されるため、結果として root の範囲も超えない。root の範囲で判定する案は、孫がサブ統括の範囲の外で動けてしまう（期待 2 に反する）ので採らない。
- **cwd**: `cwdOf` は根のとき `config.rootCwd`、それ以外はノードの作業ツリー。サブ統括も作業ツリーを持つ（孫の作業ツリーの親ではなく、独立した git worktree。#159 の整理に従う）。

## 5. 期待 3: 孫の起動・停止・削除の依頼の経路

- **依頼の宛先は直接の親（サブ統括）**（案 A。ADR: `adr-draft-request-routing.md`）。理由: `parent.request`／`parent.report` が `directChild` の規則であり、CLI のアダプタは親のセッションに依頼する作りで、サブ統括は実セッションを持つ統合ノードだから。root が代行する案は、root が孫の数だけ詰まり、規則も変えることになる。
- 依頼の記録は `state.parentRequests`（`nodeId` は孫）に出る。サブ統括の受信箱に出て、`parentSession`（`node.parentSessionSet`）に記録された**サブ統括のセッション**へ知らせる。
- **サブ統括が止まっている・応答しないとき**: 孫の依頼は滞る。root は `visibleState` で全体が見えるので、既存の `node.stop`（strictDescendant）で孫を直接止められる。ただし、CLI の停止は親のセッションへの依頼のため、サブ統括が死んでいる場合は **root が依頼を代行する逃げ道**（`parent.request` の directChild 規則の例外ではなく、`node.confirmStopped` を human／root が宣言する既存の経路）を使う。実装 PR で、「親が不在のときの停止の確認」の既存の仕組み（`stopIncomplete`＋`stopDelegated`）が使えるか確かめる（未確認。設計上の宿題として §10 に記す）。
- 孫の削除（回収→archive）は、サブ統括が自分の孫を回収する。サブ統括自身の回収は、root が後順で行う（孫が先）。

## 6. 期待 4: 受信箱と状態画面の階層

- **孫の完了・失敗は、まずサブ統括の受信箱に出る**: `inbox.fetch` は `visibleState` で自分の部分木に絞られ、孫の報告は孫の `nodeId` で記録され、サブ統括から見える。**現状の仕組みのまま満たす**。
- **root には要約が上がる**: `digest`（FR_013）が既に実装済み。サブ統括（根でない動作中の統合ノード）を対象に、配下の未解決項目の要約が受信箱へ出る。root の受信箱には、サブ統括の `digest` と、サブ統括自身の報告（`report_done` など）が出る。孫の自由文字列は上がらない（件数・状態名・ID のみ）。
  - 確認が要る点: `digestTargets` が出す要約の宛先（`nodeId` はサブ統括）が、root の受信箱に「サブ統括の要約」として見えること。`visibleState(root)` で見える（root は全体の部分木）ので、満たす。表示の文面は実装 PR で試験する。
- **状態画面（/ui）**: `docs/ui.md` の関係図は、根・子・孫の形を既に描く。サブ統括を、**統合ノードのしるし（ロール表示）＋配下の件数・要判断の件数**で表す。サブ統括の下の孫の折りたたみ（#206 の「止めた・済んだ子を隠す」と同じ）を、サブ統括ごとにも効かせる。`packages/core/src/ui-view.ts` の変更が要るか、実装 PR で確かめる（未読のため推測しない）。
- **呼び出し側の絞り込み**: サブ統括の `tree.list`・`inbox.fetch` は自分の部分木のみ（他のサブ統括の孫は見えない）。root は全体。

## 7. 期待 5: サブ統括停止時の孫の扱い

- **連動停止（案 A。ADR: `adr-draft-stop-cascade.md`）**: サブ統括を `node.stop` するとき、配下の動作中の孫を**先に**停止の依頼に載せる（後順。回収と同じ向き）。サブ統括の停止は、配下の孫がすべて停止の確認（`confirmStopped`）済みか、人が強制の宣言をするまで `stopping` に留まる。
  - 理由: 孫を残したまま親だけが消えると、孫の依頼・報告の宛先がなくなり、孤立する。「root が引き取る」案は、親の付け替え・範囲の再検査・ログの事象が増え、v0.1.7 には重い。
  - 孫の成果（作業ツリー・コミット）は残る。root が `reclaim` で後始末をする。
- 孫が `done` の場合は人だけが止められる（#115）ので、連動停止の対象にしない（`done` のまま残す）。`verified` は状態を変えず、停止の依頼を出し直す（#115 の既存の規則に従う）。
- 失敗: 孫の停止が確認できない（`stopIncomplete`）ときは、サブ統括も `stopIncomplete` を理由付きで返し、root の受信箱に出す。

## 8. 深さの上限

- **設定値 `maxTreeDepth`、既定 3**（root=深さ 0、サブ統括=1、孫=2 までを許す。深さ 3 のノードの spawn は `depthExceeded`）。孫がさらに統合ノードになる（サブサブ統括）ことは v0.1.7 では許さない。
- 検査は spawn（`create`）と adopt の 2 箇所。`validateTree` にも不変条件として入れる（ログの再生で壊れた木を作らない）。`depthOf` は既にある。
- 理由: 起動の同時数（親ごと 4・全体 4）と、digest・UI・連動停止の検証範囲が、深さに比例して増えるため。設定で引き上げられるが、既定は 3。
- 孫（深さ 2）は **作業ノード（child）のみ**にする（実装は「深さの上限」で自然に決まる。サブ統括の下の統合ノードは、深さ 2 になるので、上限 3 の既定では作れる。作らせたくないなら既定を 2 にする。提案: 既定 3 のまま、v0.1.7 の試験の対象は 2 段まで）。

## 9. 利用者に確認が要る点と各推奨

> 親が利用者に確認して返す。`report_decision` は 1 ノードにつき同時に 1 件しか出せない（`waiting` 中は新しい要求を受け付けない）ので、判断 1 を出し、2〜4 は回答後に順に出す。回答が来るまでは、各推奨で設計を書いている。

| # | 点 | 推奨 | 他の案 |
| --- | --- | --- | --- |
| 1 | 紐付けの資格 | **A** bind コードをノードのロールに従わせ、統合トークンを発行（難易度★3・有効度★5） | B 別の bind 経路（★4・★4）／C root が代行発行（★2・★2）／D 見送り（★1・★1） |
| 2 | 孫のフックの範囲と scope_extend の承認 | **A** 判定は孫自身の範囲。承認は直接の親、超える分は親へ連鎖（★3・★5） | B 常に root（★2・★3）／C root の範囲で判定（★2・★1）／D 連鎖なしで拒否のみ（★2・★3） |
| 3 | 依頼の宛先と深さの上限 | **A** 宛先は直接の親、深さ既定 3（★3・★5） | B root が代行（★4・★2）／C 上限なし（★2・★2）／D 2 段に固定（★2・★4） |
| 4 | サブ統括停止時の孫 | **A** 連動停止（後順）（★4・★5） | B root が引き取る（★5・★3）／C 孫がいる間は拒否（★2・★3）／D v0.1.7 は連動せず digest で知らせるだけ（★1・★2） |

回答の状況: **判断 1 は利用者が A を選択**（コードは直接の親の統合ノードが `node_bindCode` で発行。§3 の「現状維持＝root も代行」の提案は、この回答で「直接の親」に確定）。**判断 2〜4 は未回答**（ノードが `waiting` 状態のため、判断の提出が `invalidTransition` で断られた。上記の推奨で ADR 案を書いてあり、親がこの表を使って利用者に確認する）。

## 10. 段階的な実装計画（PR の分けと順）

| 順 | PR | 内容 | v0.1.7 |
| --- | --- | --- | --- |
| 1 | core: 型と認可 | `INTEGRATOR_MCP_TOOL_NAMES`、`maxTreeDepth` と `validateTree` の深さ検査、ロール別の道具の一覧 | 入れる |
| 2 | daemon: 紐付けと資格 | `bind.redeem` のロール分岐、`integratorNotSupported` の解除（`bindCode`・`hookToken`）、`rebindNodeToken` | 入れる |
| 3 | daemon・mcp: 許可とフック | 統合の許可の一覧、`child_bind` の戻りのロール切り替え、フックの試験（判定コードは変えない） | 入れる |
| 4 | daemon: 深さの上限 | spawn・adopt の `depthExceeded`、設定 `maxTreeDepth` | 入れる |
| 5 | daemon: 連動停止 | 後順の停止の連動、`stopIncomplete` の伝播 | 入れる |
| 6 | ui・docs: 階層の表示 | 状態画面のサブ統括の表示、digest の文面の試験 | 入れる（最小） |
| 7 | docs・skill・CHANGELOG | integrator／child の skill、`docs/desktop-runtime.md`・`docs/digest.md`・`docs/ui.md`・`docs/config.md`・`.sdd` 仕様の更新 | 入れる |
| 後 | サブ統括が不在のときの孫の依頼の代行（root）、孫の付け替え（root が引き取る）、深さ 3 以上の運用、Desktop のサブ統括 | 後に回す（#159・#161 と合わせる） |

順 1〜4 は小さく、順 5 が最も重い。順 2 の前に、判断 1 の回答が要る。順 5 の前に判断 4 が要る。

### Desktop ランタイム

Desktop の中間の統合ノードの紐付けは、`docs/desktop-runtime.md`・skill に「できない（仮置き）」とある。v0.1.7 の範囲は **CLI ランタイムのサブ統括**とし、Desktop は後に回す（#159 の runtime のノード属性化の後）。skill・docs の仮置きの記述は、「CLI は可・Desktop は未対応」と書き直す。

## 11. 試験の計画

| 層 | 試験 |
| --- | --- |
| core（単体） | `validateTree` の深さ検査（上限ちょうど・超過）、`INTEGRATOR_MCP_TOOL_NAMES` が `ROLE_OPERATIONS.integrator` と一致 |
| daemon（結合） | サブ統括の `node_bindCode`→`bind.redeem`→統合トークン、子トークンでは統合の操作が 401、再紐付け、孫を 2 つ以上 spawn、孫の範囲がサブ統括の外だと `childScopeProblem`（**受け入れ基準**）、サブ統括の `inbox.fetch`・`tree.list` が自分の部分木のみ、親の `scope_extend` の連鎖 |
| フック | 孫の操作がサブ統括の範囲の外だと拒否、孫自身の範囲の内だと許可 |
| 停止 | サブ統括の停止で孫が先に止まる、孫の停止が確認できないとサブ統括が `stopIncomplete`、`done` の孫は止めない（**受け入れ基準**）、回収が後順 |
| digest・UI | root の受信箱にサブ統括の digest、孫の自由文字列が含まれない、状態画面の関係図でサブ統括と孫が見える |
| e2e | 実際の `/ui` を開いて、サブ統括と孫 2 つの階層を確かめる（0.1.6 の e2e と同じ枠） |

## 12. 未確認・宿題

- `parent-request-handlers.ts`・`pause-handlers.ts`・`ui-view.ts`・`hook-policy.ts`・`packages/mcp/src/tools.ts` の `toolsFor`・`handlers/index.ts` は、この設計の時点で通読していない。該当 PR の着手時に確かめる。
- 親が不在のとき（サブ統括が死んでいる）の孫の停止の確認の経路（§5）。
- 判断 2〜4 の回答。回答が推奨と異なる場合は、該当の ADR 案と §3〜§8 を直す。
