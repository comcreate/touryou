---
id: "adr-touryou-168-stop-cascade"
title: "サブ統括停止時の孫の扱い 決定ログ（#168 サブ統括）"
type: "adr"
sdd-phase: "implement"
status: "accepted"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: []
tags: ["touryou", "168"]
category: ""
---

# サブ統括停止時の孫の扱い 決定ログ（#168 サブ統括）

> 元の案: `.sdd/task/168/adr-draft-stop-cascade.md`（判断 4 は推奨の A で確定済み）。PR5（daemon: 連動停止）で実装が決まった。元の案は親が統合時に消す。

## 2026-11-22 サブ統括の停止は、配下の孫を先に止め、確認できてから自分のセッションを止める

- **Decision**: 統合ノードを `node.stop` するとき、直接の子のうち動作中（`pending`・`running`・`waiting`）のものを、先に停止の依頼に載せる（後順。回収と同じ向き。深い統合ノードは、自分の `node.stop` が自分の配下を先に止める）。サブ統括は `stopping` に記録するが、自分のセッションの停止（アダプタの `stop`）は、孫の停止がすべて確認（`stopped`・回収可能・アーカイブ）されるまで始めない。上限（既定 10 分。`RuntimeHandlerDeps.cascade.waitMs`）までに確認できない孫がいれば、サブ統括に `stopTimeout` を記録して `stopIncomplete` にし、受信箱に孫の ID と状態を理由にした `stopIncomplete` の項目を root へ出す（既存の `stopFailed` の文面を使う）。
  - `done` の孫は対象にしない（人だけが止められる。#115）。`done` のまま残り、確認も待たない。
  - `verified` の孫は状態を変えず、裏のセッションの停止の依頼（`sessionStopBodies`）を出し直す（#115 の既存の規則）。確認は待たない。
  - すでに `stopping`・`stopIncomplete` の孫は、依頼を出し直さず、確認だけを待つ。
  - 孫の成果（作業ツリー・コミット）は残る。root が `reclaim` で後始末をする（回収は既存の後順）。
- **実装の判断（設計書との差）**:
  - 孫の停止要求は、止めるサブ統括を呼び出し元にした `node.stop` の再帰で記録する（行為者は、止めるサブ統括の `nodeId`。要求の ID は `<元の requestId>/cascade/<孫の ID>`）。人が `done` のサブ統括を止めるときも、孫の依頼は統合ノードの資格（サブ統括）で記録する（人は `done` の子しか止められない規則に、孫の連動を巻き込まない）。同じ requestId の再送は、孫の依頼を重ねて記録せず、待ちも重ねない（効果のない再送では連動しない）。
  - サブ統括を `stopping` に記録してから待つ。`stopping` の統合の資格は有効（`authorize.ts` の失効の状態は `stopIncomplete`・`stopped`・回収可能・アーカイブ）なので、サブ統括のセッションは、待つ間も孫の停止の依頼（`parent_request`・`parent_report`）を実行できる。停止の依頼を先にサブ統括へ出すと `stopIncomplete`（資格の失効）になり、孫の依頼を実行できなくなるため、順序を逆にしない。
  - 「確認できない」は、`stopIncomplete` の孫を即座に失敗とは扱わない。CLI の孫は、親への代行の依頼で `stopIncomplete` になるのが通常の途中経過だから。上限までに確認がないことを、確認できない、とする。上限は試験で差し替える。理由には ID と状態名だけを入れ、孫の自由な文字列は入れない。
  - 待ちはメモリ上の確認（`log.state()` の読み直し）で、ログの購読の仕組みを足していない。daemon が再起動すると待ちは失われるが、起動時の整合（`reconcileOnStartup`）が、`stopping` のノードを作業ツリーのプロセスの有無で `stopped` か `stopIncomplete` にするので、停止の状態は残る。
  - 孫の依頼の記録の前に、サブ統括自身の遷移・孫のランタイムの有無を検査する（動作中の孫のランタイムがなければ、何も記録せず `noRuntime`）。孫の記録の途中の失敗では、すでに記録した孫の依頼は残る（孫は止まる方向で一貫しており、`node.stop` の再実行で続きを進められる）。
  - 一時停止（`decision.present` の `pauseNodeIds`）が統合ノードを止めるときも、同じ `node.stop` を通るので、配下が先に止まる。
- **親（サブ統括）が死んでいて、孫の停止の依頼を実行できないときの逃げ道**: 既存の仕組みが使える。`node.confirmStopped`（`strictDescendant`）は、root が孫に対して呼べ、CLI のアダプタは `stopDelegated: true` なので、`stopIncomplete`（および `stopping`）の孫を宣言で `stopped` にできる（人も可）。サブ統括の停止が `stopIncomplete` になったら、root が孫ごとに `claude stop` を確かめて `node_confirmStopped` で宣言し、サブ統括を `node_stop` で止め直す（`retryStop` は孫の確認済みを見て、待たずに自分の停止へ進む）。`parent.report` は `directChild` なので、root は孫の依頼に報告できない（宣言の道だけが使える）。サブ統括自身の停止の依頼は、従来どおり root が実行する（サブ統括の親は root）。
- **Rationale**: 孫を残したまま親だけが消えると、孫の依頼・報告の宛先がなくなり孤立する。「root が引き取る」案は、親の付け替え・範囲の再検査・ログの事象が増え、v0.1.7 には重い。
- **Rejected alternatives**: root が孫を引き取る — 付け替えの設計が要る。孫がいる間は停止を拒否 — 人に手順が回る。連動せず digest で知らせるだけ — 孤立した孫が動き続ける。孫の停止の依頼と同時にサブ統括の停止を始める — サブ統括が `stopIncomplete`（資格の失効）になり、孫の依頼を実行できなくなる。
- **残る課題**: `verified` の孫の裏のセッションの停止の依頼は、確認を待たない。サブ統括のセッションが先に止まると、その依頼は未報告のまま残る（root の受信箱で確かめる）。待ちの上限（10 分）は設定にしていない。
