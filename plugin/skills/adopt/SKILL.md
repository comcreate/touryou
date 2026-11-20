---
name: adopt
description: touryou の統合ノードとして、すでにある git の作業ツリーと、そこで動いているセッションを、子ノードとして採用する手順（node_adopt → セッションで /mcp の Reconnect → child_bind）。手で作った作業ツリーや、始めてしまったセッションを、あとから木に入れたいときに使う。
---

# 既存の作業ツリーを子として採用する手順

あなたは、統合ノードです。`node_spawn` は、作業ツリーとセッションを新しく作ります。この手順は、**すでにある**作業ツリーと、その中で動いているセッションを、木の子にします（Issue #163）。CLI の木（設定 `childRuntime` が `cli`）だけで使えます。

**ツールの名前**: この手順では、ツールを `mcp__node__<名前>` と書きます。plugin から入れたセッションでは、同じツールが `mcp__plugin_touryou_node__<名前>` として見えます（同じツール）。見えているほうの名前で呼んでください。

## 先に確かめること（採用できる作業ツリーの条件）

採用する作業ツリーは、次をすべて満たす必要があります。満たさないと、`node_adopt` は何も変えずに、原因と次の操作を返します。

- `git worktree add` などで、このリポジトリに登録されている作業ツリー（`adoptWorktreeNotFound`・`adoptNotRegistered`）。
- 主の作業ツリー・根・親の作業ツリーではない（`adoptMainWorktree`・`adoptParentWorktree`）。
- ブランチが付いている（`adoptDetachedHead`）。指定する `branch` と同じ（`adoptBranchMismatch`）。親のブランチとは別（`adoptSameBranch`）。
- ブランチの上流が、親のブランチ（`adoptUpstreamMismatch`。`git branch --set-upstream-to=<親のブランチ> <branch>` で直す）。
- すでに別の子の作業ツリーではない（`adoptAlreadyChild`）。

未コミットの変更があっても採用できます（結果の `dirty` が真になる）。変更が子の範囲に収まるかは、子が作業の前に確かめます。

## 手順

1. 採用する作業ツリーの絶対パス（`git worktree list` で確かめる）と、ブランチ名を決める。
2. 子の目的・受け入れ基準・範囲を決める。**範囲は、親（根なら `config.json` の `rootScope`）の範囲に収まること**（`node_spawn` と同じ。収まらないと `scopeNotSubset`）。`forbiddenLocations` には、親の禁止をすべて含める。場所は、採用する作業ツリーの中の相対パス。
3. `mcp__node__node_adopt` を呼ぶ（`parentId`・`role`・`worktree`・`branch`・`objective`・`acceptanceCriteria`・`scope`）。
   - 失敗したら、`cause` と `nextActions` に従って直し、同じ内容でもう一度呼ぶ（作業ツリーとブランチは変わっていない）。
   - 成功すると、`nodeId` と `instruction` が返る。同じ `requestId` の再送は、同じ結果（`duplicate: true`）を返す。
4. 返った `instruction` を、そのセッションの人に伝える。セッションの中で、次の順に進めてもらう:
   1. `/mcp` を開き、touryou の接続を **Reconnect** する（動いていたセッションの MCP は、採用の前に始まっているので、子の印を見ていない）。
   2. 子のツール `child_bind` を、**引数なし**で 1 回だけ呼ぶ。
   3. 紐付けのあと、`inbox_fetch` でブリーフを読み、`/touryou:child` の手順で報告する。
5. 紐付けに失敗する（コードの期限切れなど）ときは、`mcp__node__node_bindCode` で、コードを作業ツリーに書き直し、もう一度 `child_bind` を呼んでもらう。
6. 採用した子は、普通の子と同じに扱う（`node_review` で受理・`node_integrate` で統合）。採用した子のセッションは、起動の知らせの自動の流れ（`crossSessionInbound`）がないので、子が `inbox_fetch` を自分で読む。停止は `node_stop`（子の停止の依頼は、普通の CLI の子と同じ）。

## 守ること

- 採用した作業ツリーとブランチは、回収（`node_reclaim`）でも**消えない**。回収は、子の印と紐付けのコードを外すだけ。作業ツリーとブランチの扱いは、人間が決める。
- 採用の記録（誰が・どの作業ツリーを・どの範囲で採用したか）は、イベントログに残る。
- 範囲を、黙って広げない。親の範囲を超える権限の子は、作れない。
- 失敗の応答には、原因（`cause`）と次の操作（`nextActions`）が付く。同じ操作を繰り返す前に、それを読む。
