---
id: "design-159-v017"
title: "子ごとの runtime（CLI / Desktop）の混在と、既存セッションのあとからの紐付け（v0.1.7 設計）"
type: "design"
status: "draft"
sdd-phase: "plan"
impl-status: "not-implemented"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: []
tags: ["runtime", "desktop", "adopt", "bind"]
category: "developer-tooling"
priority: "medium"
risk: "high"
---

# #159 子ごとの runtime の混在と、あとからの紐付け（v0.1.7 設計）

**関連決定ログ:** [touryou.md](../../adr/touryou.md)（2026-11-14「Desktop の子は起動時の整合でプロセスと照合しない」・2026-11-20「attach で mcp が入れ替わった CLI の子は、コードなしでつなぎ直せる」）
**前の調査:** [investigation.md](investigation.md)（0.1.5 時点。この設計書は、0.1.6 の main〔8d4bc25〕を読み直した結果で、そこに書かれた事実を更新する）
**ADR の案:** [adr-draft-runtime-ownership.md](adr-draft-runtime-ownership.md)・[adr-draft-adopt-approval.md](adr-draft-adopt-approval.md)・[adr-draft-desktop-reconcile.md](adr-draft-desktop-reconcile.md)

本書は設計だけで、コードは変えない。事実は「【確認】コードの場所」を付けて書く。読んでいない所は「【未確認】」と書く。

---

# 1. 実装ステータス

🔴 未実装（設計の案。利用者の判断が 3 点残る。§9）

## 1.1. 先に言うこと（前の調査から変わった点）

前の調査（0.1.5）の「0.1.6 では土台だけ」が、0.1.6 で入っている。

- 【確認】`node.created` の `runtime`（`packages/core/src/events.ts` 73・463〜476 行）。spawn が、daemon の `childRuntime` と同じ値を記録する（`packages/daemon/src/compose.ts` 1902 行、`spawn-handlers.ts` 80・364 行）。**記録だけで、振り分けには使っていない**（コメントにも、そう書いてある）。
- 【確認】`ui-view.ts` 390 行: 画面のノードは `runtime = n.runtime ?? (CLI の子と分かるなら "cli")`。`app-text.ts` 654〜671 行に、runtime ごとの「開き方」「安全面」の文がある。
- 【確認】`node_adopt`（#163。`adopt-handlers.ts`、`plugin/skills/adopt/SKILL.md`）が、すでにある作業ツリーとセッションを CLI の子として採用できる。

だから #159 の残りは、次の 4 つに絞れる。

1. **振り分け**: `childRuntime`（木に 1 つ）で決まっている分岐を、子ごとの `runtime` で決める。
2. **spawn の入力**: `node_spawn` に runtime の指定がない。
3. **採用の穴**: `node_adopt` は、CLI の木だけ・`node.created` に `runtime` を記録しない・止まり検知と画面の「開き方」の対象から外れる（§3.3）。
4. **Desktop のセッションの採用**: 手順も承認もない。

---

# 2. 設計目標

- 同じ木で、子ごとに CLI か Desktop かを選べる（daemon の再起動も、設定の全体の切り替えも要らない）。
- 既存のセッションを、あとから、どちらの runtime の子としても結べる。
- どちらの子も、画面と受信箱から同じに見え、開き方が分かる。
- Desktop の子の弱い所（FR_014 が効かない・トークンを読める・取り消せない操作の確認）が、子ごとに画面で分かる。
- **安全面は下げない**。混在を許す条件は、利用者が明示的に受け入れた時だけ働く。
- 設計は、実装量でなく設計の正しさで決める（グローバルの決まり）。

---

# 3. 現状の事実（コードで確かめたもの）

## 3.1. runtime を決めている所（`childRuntime` に依存する分岐の一覧）

【確認】`packages/daemon/src/compose.ts`、ほか。どれも木全体で 1 つの値。

| 分岐 | 場所 | 今の振る舞い | 子ごとにするときの直し |
|:--|:--|:--|:--|
| アダプタ | compose 1045〜1061・1888 | `adapter = desktopAdapter ?? cliAdapter`、`adapterFor: () => adapter` | `adapterFor(nodeId)` を、そのノードの `runtime` で選ぶ |
| 起動時の整合の外部判定 | compose 1035〜1044・2294、`reconcile.ts` 66・86〜89、`external-check.ts` | `isExternal = childRuntime が desktop なら全ノード真` | `node.runtime === "desktop"` |
| CLI の子か | compose 436〜441・1882 | `isCliChildOf(childRuntime, state, id)` | `node.runtime === "cli"` |
| 引き出し・フック専用トークン | compose 775〜805 | `desktopTree` のとき全子に作る・失効 | `node.runtime === "desktop"` の子だけ |
| 取り消せない操作の確認 | compose（`confirmGate`） | desktop の木のときだけ作る | Desktop の子が 1 つでもありうる（opt-in が有効な）木で作る（§5.5） |
| bind のハンドラ | compose 1881 付近、`bind-handlers.ts` 29・46 | `{ cli: true }` か `{ desktop }` の二者択一 | ノードの runtime で、紐付けの文面と経路を選ぶ |
| 紐付けの出し直しの知らせ | compose 2204 | Desktop のアダプタがあるとき `onBindInvalid` を渡さない | ノード単位 |
| ポートの保存失敗 | compose 2353 | Desktop の木だけ起動を止める | Desktop の子が 1 つでもありうる木 |
| フック専用トークンの発行（`node.hookToken`） | `hook-handlers.ts` 41・109 | `childRuntime: "cli"` のときだけ | ノードの runtime で判定 |

`NodeRecord`（core）の `runtime` は、すでにある（`events.ts` 476 行）。属性を足す変更は要らない。

## 3.2. spawn

【確認】`packages/mcp/src/tools.ts` の `node.spawn` の入力に runtime はない（parentId・role・objective・acceptanceCriteria・scope・dependsOn）。`spawn-handlers.ts` の `create` は `deps.adapterFor(parentId)` で、**親のアダプタ**を使い、`deps.runtime`（daemon の設定の値）を `node.created` に記録する（439・364 行）。再試行（記録済みの再送）も、同じ親のアダプタを使う（383 行）。

## 3.3. node_adopt（#163）がどこまで満たすか — 切り分け

【確認】`adopt-handlers.ts`、`contract.ts` 572〜597 行、`plugin/skills/adopt/SKILL.md`。

| Issue の望み | node_adopt で満たすか | 根拠・不足 |
|:--|:--|:--|
| 既存のセッションを、あとから親の子にする（CLI） | **一部を満たす** | 作業ツリーとブランチを検査し（`inspectAdoption`）、`node.created`・`start`・`node.adopted` を 1 トランザクションで記録し、紐付けのコードを作業ツリーの git のディレクトリに書く。子は `/mcp` の Reconnect → `child_bind`（引数なし）で結ぶ |
| 同じことを Desktop のセッションで | **満たさない** | SKILL.md に「CLI の木（設定 `childRuntime` が `cli`）だけ」とある。Desktop の引き出し・フック設定（`prepareDesktopWorktree`）・紐付けの文面を準備する道がない |
| 採用した子の runtime を記録する | **満たさない（穴）** | 記録する `node.created`（adopt-handlers 242〜254 行）に `runtime` がない。画面は `runtime = n.runtime ?? (起動の報告がある CLI の子なら "cli")` なので、採用した子は `runtime` も `cli` の印も付かず、画面の「開き方」「安全面」が出ない |
| 採用した子も、止まり検知（stall）などの対象にする | **満たさない（穴）** | `cli-watch.ts` の `watchFindings` は、`parentRequests` に起動（`launch`）が done で報告された子だけを対象にする（129 行）。採用した子は起動の報告がないので、止まっているかも・紐付けていない・紐付けが外れているかも、のどれも出ない |
| 開き方（`claude attach <id>`） | **満たさない（穴）** | `sessionRefs` は起動の報告の `sessionRef` だけを見る（`ui-view.ts` 356〜362 行）。`node.adopted.sessionRef` は読まない |
| 承認 | 親の統合ノードが、人の同意（会話）を得て呼ぶ（SKILL.md の手順 3）。daemon の側の承認はない | #145 の「守りの考え」との整合は §5.4 |

**結論**: 「CLI のセッションを、あとから CLI の子にする」は、node_adopt でほぼ満たしている。足りないのは、(a) runtime の記録、(b) 見張り・画面を、起動の報告でなく runtime の属性で判定すること、(c) `sessionRef` を画面の開き方に使うこと、(d) Desktop のセッションの採用。

「Desktop で作った調査用のセッションを CLI の子として扱う」は、そのセッションの作業ツリーで touryou の plugin（mcp・フック）が使えるなら、node_adopt（runtime:"cli"）で足りる可能性がある。ただし、Desktop のセッションが plugin の MCP とフックを継承するかは、docs/desktop-runtime.md の「まだ確かめていないこと」の項目 4 のとおり**未確認**。実機で確かめるまで、設計の前提にしない（§8.3）。

## 3.4. #145（つなぎ直し）

【確認】`.sdd/adr/touryou.md` 237〜243 行。CLI の木だけ、`child_bind` を引数なしで呼ぶと、コードがないときに限り、`CLAUDE_CODE_SESSION_ID`・cwd・ノード ID で子のトークンを出し直す。5 つの条件（作業ツリーの確認・記録の session_id・他ノードへの結び付きなし・有効な bind トークン・子ロールの状態）がそろったときだけ。**Desktop の木はコードなしの bind を必ず断る**（`rebindOk` を渡さない）。

→ 採用した子（CLI）にも、そのまま効く（採用の紐付けが `node.sessionBound` を記録するため）。Desktop の子は、#145 の対象外のまま（本設計でも変えない）。

## 3.5. Desktop の子の整合・見張り

【確認】`reconcile.ts` 66・86〜116 行: `external` と判定された子は、プロセスで照合せず、根の受信箱に stopIncomplete の帯を 1 件だけ出す（ADR 2026-11-14）。`isExternal` は、いまは木全体（compose 1035〜1036）。`cli-watch.ts` の見張りは起動の報告がある子だけなので、**Desktop の子は止まり検知の対象外**（もともと起動の報告がない）。

## 3.6. 画面

【確認】`app-text.ts` 654〜671 行に `runtime.cli`・`runtime.desktop`・`runtime.openCli`（`claude attach {id}`）・`runtime.openDesktop`・`runtime.safetyCli`・`runtime.safetyDesktop` がある。#159 の「どちらの子も、画面から同じように見え、開き方が分かる」「安全面の違いが子ごとに画面で分かる」は、**`runtime` が付けば画面は出す形がすでにある**。足りないのは、`runtime` が付かないノード（採用した子・古い記録）の扱いと、Desktop の子の `openDesktop` の文が「この題の子のタスクを開く」だけで、採用した Desktop の子には合わないこと。

【未確認】画面（`packages/daemon/src/ui/` のクライアント側）が `runtime` を出す場所の細部。この設計は、`ui-view.ts` の `runtime` 欄が正、とする。

---

# 4. 「決めること」3 点への答え（要約）

| 決めること | 答え | ADR の案 |
|:--|:--|:--|
| 子ごとの runtime を、木のどこに持つか | **ノードの属性（`node.created.runtime`。すでにある）が正**。spawn の引数は「入力」で、検証して属性に写す。daemon の `childRuntime` は、引数がないときの既定値に格下げする | [adr-draft-runtime-ownership.md](adr-draft-runtime-ownership.md) |
| 後からの紐付けの手順と承認 | `node_adopt` を土台に、`runtime` を引数にし、記録する。CLI の子の採用は今の手順（親の統合ノードが人の同意を得て呼ぶ）。**Desktop の子の採用は、人の承認（受信箱＋画面）を挟む**（推奨。利用者の判断 §9-2） | [adr-draft-adopt-approval.md](adr-draft-adopt-approval.md) |
| Desktop の子の整合・stall | **ノードの `runtime` で分ける**。Desktop の子だけ外部扱い（プロセスで照合しない・帯を 1 件）。止まり検知は CLI の子（採用した子を含む）だけ。Desktop の子は、フックの最終時刻の表示だけにとどめ、判定はしない（#11 の方針のまま） | [adr-draft-desktop-reconcile.md](adr-draft-desktop-reconcile.md) |

---

# 5. 望む形ごとの設計

## 5.1. runtime の持ち場所（属性）

- 記録（イベントログ）が正。`node.created.runtime`（`"cli" | "desktop"`）。**根は持たない**（今のとおり）。
- **導出の規則（古い記録との互換）**: 1 つの関数 `runtimeOf(state, nodeId)` を core に置く（画面・見張り・整合・compose が、同じものを使う）。
  1. `node.runtime` があればそれ。
  2. なければ、起動の報告（`launch` が done）がある子は `cli`。
  3. なければ `undefined`（不明）。
  - 不明のノードの扱いは、**今の挙動を変えない**（`childRuntime` が desktop の木で作られた古い記録は、`childRuntime` を見て desktop 扱いのまま）。ただし、これは移行期の規則で、`childRuntime` の意味が「既定値」に変わった後（§5.2）は、記録のない子を **`childRuntime` の現在値で推測しない**。推測は、次の 1 点だけ: 木に 1 つも `runtime` の記録がなく、かつ設定が desktop のとき、古い Desktop の木とみなす（再起動の整合が、今と同じ結果になるように）。
- 状態の版: `node.created.runtime` は 0.1.6 の時点で任意の欄として入っている。**イベントの型は変えない**ので、`STATE_VERSION` は変えず、古い版へ戻せなくなる記録を増やさない。

## 5.2. spawn の引数

- `node_spawn` に任意の `runtime?: "cli" | "desktop"` を足す（契約は core の `contract.ts`、道具の定義は `packages/mcp/src/tools.ts`、検証は daemon の `validate.ts`）。
- 省略したときの既定: 設定の `childRuntime`（今のとおり。なければ `cli`）。**既定値の意味に格下げする**（docs/config.md の書き直し）。
- Desktop を指定できる条件（opt-in）は、利用者の判断（§9-1）。推奨は、設定に明示の許可（仮の名前 `allowDesktopChildren`、既定 `false`）を足し、`true` のときだけ `runtime:"desktop"` を受ける。`childRuntime: "desktop"` の設定は、これを暗に許可したものとみなす（互換）。
- 失敗の形: 許可がないとき `desktopChildNotAllowed`（原因・次の操作つき。次の操作は「設定の確認」）。`touryouCommand` がない・フックのゲートが閉じているときは、**今と同じ失敗**（`touryouCommandMissing`・`hooksUnverified`）。
- アダプタの選び方: `adapterFor(nodeId)` を、spawn の時点では「これから作るノードの runtime」、それ以外では「そのノードの `runtime`」で選ぶ。親のアダプタを使う今の `adapterFor(parentId)`（`spawn-handlers.ts` 383・439・598 行）は、**子の runtime のアダプタ**に直す。
- 再試行（記録済みの再送）: 記録した `runtime` と、引数が食い違えば `requestIdConflict`（冪等性は内容まで比べる。ADR 2026-11-14）。

## 5.3. 子ごとの配線（compose の分岐の直し方）

§3.1 の表のとおり、分岐は `runtimeOf(state, nodeId)` を見る形にする。守ること:

1. **フックの受け口の取り違えの防止**: `POST /v1/hook` は、呼ばれたノードの `runtime` で、`decideCliHook` か `decideDesktopHook` を選ぶ。トークンの種類（フック専用か、引き出しの見張りか）と、ノードの `runtime` が食い違えば、**拒否**し、`scope.violation` に残す。
2. **引き出し・フック専用トークン**: Desktop の子の状態遷移（`drawerActionFor`）は、そのノードが Desktop のときだけ働く。CLI の子の引き出しを作らない（今も作らない）。
3. **起動時の掃除**（`childrenDirSwept`）: Desktop の子の鍵だけを「要る引き出し」とする（今の規則のまま。対象が子ごとになるだけ）。
4. **アダプタの `has(nodeId)`**: 子ごとのアダプタが、自分の子だけを `has` で答える。`managed` は、いずれかのアダプタが `has` を返すか、で決める。
5. **起動時の初期化の順**: Desktop のアダプタは、opt-in が有効なときだけ作る（作らなければ、`desktop` の子を作る道は閉じたまま。今の CLI の木と同じ）。

## 5.4. あとからの紐付け（採用）

土台: `node_adopt`（#163）。変えること:

1. **`runtime` を記録する**（PR1）: `node.created` に `runtime` を入れる（採用の runtime）。CLI の採用は `"cli"`。
2. **画面・見張りを属性で判定する**（PR1）: 見張り（`watchFindings`）の対象を「起動の報告がある子」から「`runtimeOf` が `cli` の子」にする（起動の報告がなくても、採用した子は対象）。`ui-view.ts` の `cliChildren`・`sessionRefs` も、`node.adopted.sessionRef`（#163 で記録している）を読む。
   - 注意: 採用した子の「紐付けていない子」（`unbound`）判定は、起動の報告の時刻を基準にしている（129〜139 行）。採用では、`node.adopted` の記録の時刻を基準にする。
3. **Desktop の採用**（PR3）: `node_adopt` に `runtime?: "cli" | "desktop"`（省略は `cli`）を足す。`desktop` のとき:
   1. 承認を要る（§9-2。推奨は、人の承認を受信箱に出し、画面で人が承認してから daemon が結ぶ）。
   2. 作業ツリーの検査は、CLI の採用と同じ（登録済み・主でない・ブランチ・上流など）。
   3. daemon が、採用した作業ツリーに、見張りの設定（`.claude/settings.json`）を置く（`prepareDesktopWorktree`）。**違う中身の設定がすでにあれば、置かずに失敗**（`hookSettingsExists`。今の spawn と同じ。利用者の設定を黙って書き換えない）。
   4. 引き出しを作り、紐付けのコードを出し、`instruction`（`bindInstruction`）を返す。親は会話に写さず、そのセッションの人に渡す。
   5. 子は、Desktop で採用した作業ツリーを「ローカル」で開き直し（または、フックは途中でも読み直されるので、そのまま続けて）、`touryou child bind` で結ぶ。
4. **承認の置き場**（§9-2 の推奨）: 受信箱に「採用の承認待ち」の項目を出し、人が画面で承認（人間のトークン）するまで、`node.created`・`node.adopted` を**記録しない**。承認は一度きり・期限つき・子や根のトークンでは押せない（取り消せない操作の確認〔`confirm.approve`〕と同じ型）。**CLI の採用には、この承認を挟まない**（今の手順を保つ。既存の守りの考えに合わせて、権限が増えないため）。
5. **逆向き（Desktop で作ったセッションを CLI の子にする）**: `node_adopt(runtime:"cli")` を使う。そのセッションで touryou の plugin が動く前提は【未確認】（§8.3）。確認が取れるまで、docs には「試験的」と書く。

## 5.5. 取り消せない操作の確認ゲート

Desktop の子がいる木では、人間のトークンだけでは `node.purge`・`node.discardedDrop`・`node.reclaimInstruct` を実行しない（docs/desktop-runtime.md）。混在では、**Desktop の子が 1 つでもありうる木**（opt-in が有効、または Desktop の子の記録がある）で、このゲートを作る。launchd 経由で `/dev/tty` がないと、これらの操作が `confirmationUnavailable` で通らなくなる。→ **opt-in を true にすると、CLI の子だけの操作も、端末なしでは取り消せない操作ができなくなる**。これは混在の費用で、画面の設定の窓と docs に書く（§5.6）。ゲートを「Desktop の子の記録があるとき」だけにする案もあるが、記録の前の操作で急に変わるので、取らない（§9-1 の A の補足）。

## 5.6. 画面と受信箱の見え方・安全面の表示

- ノード単位の表示は、いまの `runtime.*` の文（`app-text.ts`）を、そのまま使う。`runtimeOf` が決まらないノードは、何も出さない（今と同じ。誤った安全面を出さない）。
- 追加する表示:
  1. **採用した子**にも、runtime・開き方・安全面を出す（PR1）。CLI の採用の開き方は `claude attach {sessionRef}`。`sessionRef` がなければ、「作業ツリー {path} の中で動くセッション」と出す。
  2. **Desktop の子の開き方**: 採用した子は、作業ツリーのパスを出す（`openDesktop` に、パスを足す）。
  3. **設定の窓**（画面の設定）: opt-in の状態と、「有効にすると、取り消せない操作は端末つきの daemon でしか通らない」の注記を出す（読み取りだけ。変更は設定ファイルで行う。今の設定の窓の方針）。
  4. **受信箱**: 採用の承認待ち（§5.4-4）の項目の文。種類は、既存の確認待ちの欄（画面の上端の固定）に合わせる。
- 日本語と英語の両方（`INBOX_MESSAGES`・`app-text.ts`）。文の鍵を足す。

## 5.7. 起動時の整合・止まり検知（#11・#136・#150 との整合）

- 整合（`reconcile.ts`）: `external` を `runtimeOf(...) === "desktop"` にする。CLI の子は、これまでどおり `lsof` で照合する。混在の木では、**根の受信箱の帯は、Desktop の子の数だけを書く**（CLI の子が混ざっても、数に入れない）。
- 止まり検知: CLI の子（採用を含む）が対象。Desktop の子は、判定しない（#11 の方針のまま。`external` の子は、daemon から止まったと決めつけない）。ただし、画面に「最後にフックを見た時刻」を出す案は、後に回す（§7）。
- #150（「止まっているかも」の attach のコマンドが、止まった子で開けない）: 本設計の範囲外。ただし、`sessionRef` を採用した子にも使うので、#150 の直し方（止まった子の attach の文）は、**採用した子にも同じ文を使う**形にしておく（別の分岐を作らない）。

---

# 6. 段階的な実装計画

| PR | 内容 | 変えるもの | 挙動の変化 | リスク |
|:--|:--|:--|:--|:--|
| **PR1** 採用を属性で扱う | adopt が `runtime:"cli"` を記録する。`runtimeOf` を core に置く。見張り・画面・`sessionRef` を、属性で判定する | core・daemon（adopt・cli-watch）・ui-view・app-text・docs | 採用した子に、止まり検知と開き方が出る（追加のみ） | 低。既存の子は、起動の報告で今まで通り |
| **PR2a** compose を子ごとにする | §3.1 の分岐を `runtimeOf` を見る形に直す。`adapterFor`・`isExternal`・`isCliChildOf`・引き出し・フック・bind を子ごとに。**spawn の引数はまだ足さない**。設定が単一 runtime の木の挙動は、一切変えない | compose・reconcile・hook-handlers・bind-handlers・試験 | なし（リファクタ。試験で同値を確かめる） | 中。分岐が多い。木が単一 runtime の間は、同値の試験が頼り |
| **PR2b** 混在の spawn | `node_spawn` に `runtime?`・opt-in の設定・失敗の形・設定の窓の表示・docs | core・mcp・daemon（spawn・config・validate）・ui・docs | opt-in を true にした木だけ、混在できる | 高（安全面）。opt-in が既定 false で、既存の木は変わらない |
| **PR3** Desktop の子の採用 | `node_adopt` の `runtime:"desktop"`・承認待ち・フック設定の配置・引き出し・文面・画面 | core・mcp・daemon・ui・plugin（skill）・docs | Desktop の子を、あとから結べる | 高。Desktop の実機の確かめが要る |

**v0.1.7 に入れる範囲の提案**: PR1＋PR2a＋PR2b（§9-3 の推奨 A）。PR3 は、承認の部品と実機の確かめが要るので、v0.1.8 に回す。PR1 で、Issue の「CLI のセッションをあとから紐付ける」を満たし、PR2b で「子ごとに選んで追加」を満たす。「Desktop のセッションをあとから紐付ける」は PR3。

**順序の理由**: PR1 は単独で価値があり、安全面を変えない。PR2a は、PR2b の前提で、挙動を変えないので、試験で保証してから PR2b を載せる（安全面の変更を、リファクタと同じ PR に混ぜない）。PR3 は PR2a の分岐の上に載る。

---

# 7. 後に回すこと

- Desktop の子の止まり検知（フックの最終時刻の表示・stall 判定）。#11 の方針（外部の子を daemon が決めつけない）と、フックの時刻がメモリだけ（再起動で消える）ことの整理が要る。
- `runtime` の後からの付け替え（採用済みのノードを、別の runtime に変える）。ノードの属性は不変にする（§5.1）。付け替えは、止めてから採用し直す。
- Claude Desktop の一覧に CLI の子を出すこと（Claude 側の機能。touryou では直せない。docs に「開き方」を書く）。

---

# 8. 試験の計画

## 8.1. 自動（vitest）

| 対象 | 確かめること | PR |
|:--|:--|:--|
| `runtimeOf` | 属性・起動の報告・不明の 3 通り。古い記録の互換 | PR1 |
| adopt | `node.created` に `runtime:"cli"` が入る。再送で同じ。`sessionRef` が画面に出る | PR1 |
| cli-watch | 採用した子に、止まっている・紐付けていない・紐付けが外れているかも、が出る。Desktop の子には出ない | PR1 |
| ui-view | 採用した子の `runtime`・`cli`・開き方・安全面 | PR1 |
| compose の同値 | 単一 runtime の木（cli のみ・desktop のみ）で、PR2a の前後で、アダプタ・整合・引き出し・フック・bind の結果が同じ | PR2a |
| 混在 | cli の子と desktop の子を 1 つの木に置き、整合（帯は desktop の数だけ）・フック（受け口の取り違えを拒否）・引き出し（desktop の子だけ）・bind（文面が子ごと）が正しい | PR2a・PR2b |
| spawn | `runtime` 引数の検証・opt-in なしの拒否・再送の食い違い・`touryouCommandMissing`・`hooksUnverified` が今と同じ | PR2b |
| config | opt-in の検証・互換（`childRuntime: desktop` が暗に許可） | PR2b |
| 取り消せない操作 | opt-in が有効な木で `confirmationRequired`、端末なしで `confirmationUnavailable` | PR2b |
| Desktop の採用 | 承認前は記録しない・承認後に記録・子や根のトークンで承認できない・期限切れ・`hookSettingsExists` | PR3 |

## 8.2. 手動の確認（`docs/manual-verification-checklist.md` に足す項目）

- 混在の木で、CLI の子と Desktop の子を 1 つずつ作り、画面の runtime・開き方・安全面が子ごとに正しいこと。
- daemon の再起動後、根の受信箱の帯が Desktop の子だけを書き、CLI の子は `lsof` で照合されること。
- opt-in を有効にした daemon を launchd で動かすと、取り消せない操作が通らないこと（注記どおりか）。

## 8.3. 実機の確認が要る前提（【未確認】）

1. Desktop のセッションが、plugin の MCP とフックを継承するか（docs/desktop-runtime.md の「まだ確かめていないこと」の項目 4）。通れば、Desktop のセッションを CLI の子（`runtime:"cli"` の経路）として採用できる。通らなければ、`runtime:"desktop"` の経路だけを使う。
2. 採用した Desktop のセッション（`spawn_task` のチップでなく、ローカルで開いたもの）が、フック設定を途中から読み直すか。
3. attach のあとの `CLAUDE_CODE_SESSION_ID` が元と同じか（#145 の前提。A4-3）。

---

# 9. 利用者に確認が要る点と、各点の推奨

利用者の判断は、`report_decision` で親に出す（1 度に 1 件）。答えが来たら、この節と ADR の案に反映する。

| # | 判断 | 案（難易度／有効度） | 推奨 | 状態 |
|:--|:--|:--|:--|:--|
| 1 | 混在の安全弁（Desktop の子を足せる条件） | A opt-in の設定（3／5）・B spawn の引数だけ（2／3）・C 毎回の承認（4／4）・D 混在させない（1／1） | **A** | **決定済み（利用者が A を選んだ）**。opt-in の設定（仮名 `allowDesktopChildren`、既定 false）が true のときだけ `runtime:"desktop"` を許す。既存のゲート（フックの確認・`touryouCommand`・取り消せない操作の確認）もそのまま要る |
| 2 | あとからの紐付けの承認 | A CLI は今のまま・Desktop だけ人の承認（4／5）・B 両方に承認（4／4）・C 端末の確認コード（3／2）・D 承認なし（2／2） | **A** | 出した（回答待ち） |
| 3 | v0.1.7 に入れる範囲 | A PR1＋2a＋2b（4／4）・B PR1 だけ（2／2）・C すべて（5／5）・D PR1＋PR3（4／3） | **A** | 判断 2 の回答後に出す |

（`report_decision` は、waiting の間は新しい判断を受け付けないため、1 件ずつ出す。）

---

# 10. 設計判断

| 決定事項 | 選択肢 | 決定内容 | 理由 |
|:--|:--|:--|:--|
| runtime の持ち場 | ノードの属性／spawn の引数だけ／木ごと | ノードの属性（記録が正）。spawn の引数は入力 | 記録は再起動で失われない。画面・整合・見張りが同じ答えを出す。導出できる状態をメモリだけに持たない |
| 振り分けの導出 | 各所で個別に判定／1 つの関数 | `runtimeOf`（core に 1 つ） | 判定が分かれると、安全面の判断（フックの受け口）がずれる |
| 設定 `childRuntime` | 削除／既定値に格下げ | 既定値に格下げ（互換のため残す） | 既存の設定を壊さない |
| 採用の runtime | 常に cli／引数 | 引数（省略は cli） | 採用でも runtime が属性になる |
| Desktop の子の stall | 判定する／判定しない | 判定しない（表示は後に） | #11 の方針。daemon は外部の子を止まったと決めつけない |

## 10.1. 未解決の課題

| 課題 | 影響度 | 対応方針 |
|:--|:--|:--|
| opt-in を有効にすると、端末なしの daemon で取り消せない操作が通らなくなる | 高 | 注記を画面と docs に書く。ゲートを Desktop の子の有無で条件づける案は、操作の可否が急に変わるので取らない（§5.5）。利用者の判断 1 の中で確認する |
| Desktop のセッションの plugin の継承が未確認 | 中 | §8.3。確認が取れるまで docs に「試験的」と書く |
| 採用の承認を、既存の確認待ちの欄（メモリだけ・期限 5 分）に載せるか、別の欄にするか | 中 | PR3 の設計で決める（承認待ちを daemon の再起動後も残すかが論点。残すなら記録の型が増え、古い版へ戻せなくなる） |
| 古い記録で `runtime` がなく起動の報告もない子 | 低 | §5.1 の規則（不明は何も出さない） |
