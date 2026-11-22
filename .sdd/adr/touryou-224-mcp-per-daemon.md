---
id: "adr-touryou-224-mcp-per-daemon"
title: "設定ごとの MCP 登録（touryou-<名前>）の入口 決定ログ（#224）"
type: "adr"
sdd-phase: "implement"
status: "accepted"
created: "2026-11-23"
updated: "2026-11-23"
depends-on: []
tags: ["touryou", "224"]
category: ""
---

# 設定ごとの MCP 登録（touryou-<名前>）の入口 決定ログ（#224）

## 2026-11-23 登録は利用者が `claude mcp add` で行い、`launchd init` はその命令を案内に出すだけにする

- **Decision**: 複数の daemon（#165）のうち、既定でない設定（`--config`）の daemon につなぐ MCP は、`claude mcp add touryou-<名前> -- "$HOME/.touryou/current/bin/touryou-mcp" --stdio --config <設定>` で、利用者が登録する。`touryou launchd init --config <設定> [--name <名前>]` は、この命令を出力の「【MCP を登録する】」に出すだけで、実行しない。既定の設定の daemon は、今までどおり plugin の `node`（`plugin:touryou:node`）につなぐ（変更なし）。
  - `<名前>` は `--name`（小文字の英数字とハイフン。32 文字まで）。なければ設定の `repoRoot` のフォルダ名を同じ形にしたもの。作れなければ daemon 名（`daemon-<8 文字>`）。
- **理由**:
  - `launchd init` は daemon の常駐（plist の生成）の道具で、Claude Code の設定（`claude` CLI・利用者の MCP の登録）は責務の外。init が `claude` を起動して利用者の設定を書き換えると、常駐にしない利用者・`claude` がない環境でも init が影響を受ける（責務の分離）。
  - `/touryou:setup` は既定の 1 つ目の daemon の導入で、別の daemon は `/setup` の中で実行しない（Bash の数を増やさない）規則がある。登録の命令は、別の daemon の案内（setup の「ほかのリポジトリ用に分けた daemon」の節）に載せる。
  - 設定のパス・名前は init が既に確かめた値（`--config` の実パス・`repoRoot`）から作れるので、命令の文字列を init が出すのが、写し間違いが少ない。
- **登録の対象は、plugin のシム（`touryou-mcp-shim.sh`）でなく `current/bin/touryou-mcp` を直に指す**: シムは plugin のインストール先（版ごとに変わるパス）にあり、`claude mcp add` に固定できない。`current/bin/touryou-mcp` は `/setup` が置く、版に依らないパス。引き換えに、シムの「daemon が動くまで待つ」動きはない（daemon が動いていないと `/mcp` に failed と出る。daemon を起こしてから Reconnect する）。このため、シムの `--config` 対応は入れない。
- **whoami の識別（#224 の (2)）**: 統合ノードの `whoami` には、daemon の `rootCwd`・`repoRoot`・`daemonId` が、コード上は出る（daemon `/v1/whoami` → mcp の relay → `whoami` ツール。試験 `packages/daemon/test/api/whoami-daemon.test.ts`）。出ないのは、(a) 子のセッション（仕様で、統合ノードにだけ付ける。#164）、(b) 古い daemon・mcp の版。別の Bug にはしない。`touryou-<名前>` の登録で、どの daemon につながったかは、この `whoami` の `repoRoot`・`daemonId` で確かめる。
- **却下した案**:
  - init が `claude mcp add` を実行する: `claude` CLI への依存と、利用者の設定の書き換えが daemon の道具に入るので採らない。
  - シムを `--config` 対応にして plugin のパスを登録する: パスが版ごとに変わり、登録が古くなる。
