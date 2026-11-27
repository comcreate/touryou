---
id: "adr-touryou-288-repo-local-touryou"
title: "リポジトリ単位の置き場（<repoRoot>/.touryou/）と常駐の 1 項目化 決定ログ（#288）"
type: "adr"
status: "approved"
sdd-phase: "implement"
sdd-version: "5.3.3"
created: "2026-11-26"
updated: "2026-11-26"
depends-on: []
ticket: "288"
tags: ["touryou", "288"]
category: ""
---

# リポジトリ単位の置き場（<repoRoot>/.touryou/）と常駐の 1 項目化 決定ログ

#288 の壁打ちで決まったことを残す。未決は、決まるまでここに書かない（決まったら、新しいエントリで残す）。

## 2026-11-26 リポジトリ固有の設定・state・作業ツリー・ログは `<repoRoot>/.touryou/` に置き、既定の daemon（ホームの設定）をなくす（#288 決定 3・4）

- **Decision**: 設定（`config.json`）・state・作業ツリー（`worktrees/`）・ログを `<repoRoot>/.touryou/` にまとめ、`.touryou/` 全体を `.gitignore` に入れる。既定の daemon（`$HOME/.touryou/config.json`）はなくし、すべての daemon をリポジトリ単位にする。
- **Rationale**: 0.1.7-rc.0 の実機確認で、`worktreeRoot` が `repoRoot` の兄弟だと、子の起動（`claude --bg`）が Workspace not trusted で失敗した（信頼は親フォルダから引き継がれるという仮説は、未測定）。リポジトリ固有のものをリポジトリの中にまとめると、ホームの既定の daemon と、リポジトリごとのログイン項目の増加を、同時になくせる。
- **Rejected alternatives**: `worktreeRoot` を `repoRoot` の兄弟に置く（信頼の確認で子が止まる。#218 で拒否のまま残していた形）。`.touryou/` の中に自分の `.gitignore` を置く（自己 ignore。決定 2 の設計で「自己 ignore は置かない」とした）。

## 2026-11-26 作業ツリーの置き場も、ignore 済みのときだけ `repoRoot` の内側に許す（#288 決定 2）

- **Decision**: 起動時に「ignore 済み」を確かめ、なければ拒否する。`worktreeRoot` にも、`stateDir`（#220）と同じ検査を適用する（`checkStateDirIgnored` を `worktreeRoot` にも使えるようにする）。`stateDir` と `worktreeRoot` の重なり、`repoRoot` を囲む向きは、今のとおり拒否する。
- **Rationale**: 置き場を `repoRoot` の内側にすると、Workspace の信頼の確認が要らない見込み（未測定）。ignore 済みの確認は、ignore がないと `git add -A` が壊れた埋め込みリポジトリを載せる事故を防ぐため（R4 の実測: git 2.50.1 で、ignore 済みの入れ子の作業ツリーは、`worktree add`・`status`・`add -A`・子での commit・`worktree remove` がすべて期待どおり）。
- **Rejected alternatives**: `worktreeRoot` は拒否のまま、別の issue で扱う（#218 の決め。内側に置けず、子の起動の失敗が残る）。

## 2026-11-26 設定の探し方は、`--config`・`TOURYOU_DAEMON_CONFIG`・cwd から上への探索の順にし、見つからなければ止まる（#288 決定 6・7）

- **Decision**: mcp・hook・CLI・launchd・ui の全入口で、同じ小さな関数を共有する。順は `--config` → `TOURYOU_DAEMON_CONFIG` → cwd から上へ `<dir>/.touryou/config.json`。見つからないときは、理由と直し方（`/touryou:setup` を実行する、または `--config` を指定する）を出して止まり、旧パス（`$HOME/.touryou/config.json`）へは黙って戻らない。上へ探す範囲は、#312 の決定（git のリポジトリの根で止める）に従う。
- **Rationale**: 既定の daemon をなくすため。黙って旧パスへ戻ると、別のリポジトリの daemon に届く。
- **Rejected alternatives**: 既定の設定（`$HOME/.touryou/config.json`）へ戻す（決定 4 に反する）。

## 2026-11-26 子の作業ツリーからは、`<repoRoot>/.touryou/` のうち自分の作業ツリー以外をすべて拒否する（#288 決定 9）

- **Decision**: 子の保護（`protectedRoots`）を、「`<repoRoot>/.touryou/` 全体。ただし、その子自身の作業ツリーを除く」にする。既定は拒否で、読みも書きも止める。
- **Rationale**: 子が `state`・`config.json`・`logs`・`launchd`、ほかの子の作業ツリーに届かないようにする。`.touryou/` に今後増えるものも、自動で守られる形にするため（個別の列挙をしない）。置き場が `repoRoot` の内側に入るので、`repoRoot` の外にあった従来の守り（子の `cwd` の外）だけでは足りない。
- **Rejected alternatives**: None considered.

## 2026-11-26 常駐は launchd の項目を supervisor 1 つにし、リポジトリごとの daemon は supervisor が起動・監視する（#288 決定 11・12・13）

- **Decision**: launchd に登録するのは supervisor 1 つだけにする。登録簿（`~/.touryou/` の中の、設定ファイルの絶対パスの一覧だけ）に載った設定ごとに、supervisor が daemon を別プロセスで起動する。supervisor が落ちても daemon は止めず、起動し直した supervisor が、動いている daemon を引き継ぐ。
- **Rationale**: リポジトリごとに plist を置くと、ログイン項目がリポジトリの数だけ増える（実測: daemon が 2 つの状態で、ログイン項目の TouRyou が 2 項目出た）。root・`stateDir`・トークン・`rootScope` の分離は、OS のプロセス単位のまま保てる（#161 の案 B の利点）。root のセッションが全部消えても、daemon が残る。
- **Rejected alternatives**: リポジトリごとの plist（ログイン項目が増える）。supervisor の plist を特定のリポジトリに置く（どのリポジトリに置くかが決まらない）。

## 2026-11-26 supervisor の plist・ログ・Label は `~/.touryou/` に置き、daemon ごとのログは `<repoRoot>/.touryou/logs` に置く（#288 決定 8 を改める・14）

- **Decision**: supervisor の plist・ログ・Label（例 `touryou.supervisor`）は `~/.touryou/` に置く。リポジトリを消しても、LaunchAgents から `uninstall` できる。daemon ごとのログだけを `<repoRoot>/.touryou/logs` に置く。決定 8（plist・ログを `<repoRoot>/.touryou/` に置き、Label を `touryou.daemon-<8 文字>` とする）は、この形に改める。
- **Rationale**: 決定 8 の「plist をリポジトリ側に置く」は、決定 11（launchd は supervisor 1 つ）と両立しない。
- **Rejected alternatives**: 決定 8 のまま（両立しない）。supervisor の plist を特定のリポジトリに置く（どれにするかが決まらない）。

## 2026-11-26 登録されたパスが消えたときは、ディスクの実態を正とし、通らないものは起動しない（#288 決定 15）

- **Decision**: 起動時に、登録されたパスの存在と `config.json` の検査を行い、通らないものは起動せず、`/touryou:service status` に理由つきで出す。登録簿を正として、消えたパスを作り直したり、状態を復元したりしない。
- **Rationale**: 登録簿の記録と、ディスクの実態がずれたときに、記録のほうを信じて誤った daemon を起こさないため。
- **Rejected alternatives**: None considered.

## 2026-11-26 二重起動はしない。先に動いている daemon を残す（#288 決定 16）

- **Decision**: 同じ設定の daemon がすでに動いていれば、後から来たもの（supervisor の起動し直し・手での起動）は起動せず、理由を出して終わる。動いている daemon は、子と話している最中でも切らない。
- **Rationale**: 同じ `stateDir` の書き手が二重になると、既存の `storeLocked`（単一の書き手）と衝突する。
- **Rejected alternatives**: None considered.

## 2026-11-26 `/touryou:service` の対象は、実行したセッションのリポジトリを基本にし、`--config` で指定できる（#288 決定 17）

- **Decision**: 対象は、実行したセッションのリポジトリ（cwd から探した設定）を基本にする。`--config <設定>` で別の設定を指定できる。
- **Rationale**: 常駐が 1 項目にまとまると、対象を選ぶ入口が要る。ふだんの作業は、cwd のリポジトリに対して行うため、cwd を既定にする。
- **Rejected alternatives**: None considered.

## 2026-11-26 移行は `touryou migrate --yes` の 1 コマンドで行い、コピー・検査・切り替えの順にして、元の設定と state は消さない（#288 決定 10・5-5）

- **Decision**: 同意を取ったあとに `touryou migrate --yes` を呼ぶ（`/touryou:setup` は同意の後にこの 1 コマンドを呼ぶだけ）。1 回の実行は 1 リポジトリ（旧設定の `repoRoot`）とする。順は、旧 daemon を止める → state をコピーする → 新しい設定を一時ファイルに書く（`stateDir` だけを置き換え、`worktreeRoot` は旧のままにする）→ `--check-config` で検査する → `config.json` に切り替える → 登録簿と supervisor を apply する → 新しい daemon の応答を待つ → 旧常駐を外す。元の設定と state は消さない。失敗したら、積んだ手順を逆順で戻す。旧常駐を外す段だけの失敗は戻さず、手での外し方を出す。成功したら `~/.touryou/legacy-migrated.json` を書く。
- **Rationale**: 承認の回数を安定させ、戻しの動きを試験で守るため（文書の手順を組み立てる形だと、承認の回数が増え、戻しを試験で守れない）。`worktreeRoot` を旧のままにするのは、動いている子と DB の中のパスを孤立させないため。
- **Rejected alternatives**: 導入の文書の手順で、コマンドを組み立てて順に実行する（承認の回数が増え、戻しを試験で守れない）。

## 2026-11-26 v0.1.7 に入れ、0.1.7-rc.1 から実機確認をやり直す（#288 決定 5）

- **Decision**: #288 の変更は v0.1.7 に入れる。0.1.7-rc.1 を作り、実機確認を新しい置き場に合わせてやり直す。
- **Rationale**: 0.1.7-rc.0 の実機確認で、置き場の問題が見つかったため（上の「リポジトリ単位の置き場」の Rationale）。
- **Rejected alternatives**: None considered.
