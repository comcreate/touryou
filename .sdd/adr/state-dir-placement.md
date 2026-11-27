---
id: "adr-state-dir-placement"
title: "stateDir の置き場 決定ログ"
type: "adr"
sdd-phase: "implement"
status: "approved"
created: "2026-11-22"
updated: "2026-11-22"
depends-on: []
tags: ["touryou", "218"]
category: ""
---

# stateDir の置き場 決定ログ

## 2026-11-22 stateDir は repoRoot の内側に置けるが、gitignore 済みで未追跡のときだけにし、判定は git に任せる（#218）

- **Decision**: `repoRoot ⊃ stateDir` の向きだけを許す。daemon の起動のとき（`--check-config` も同じ）に、`git ls-files` で追跡済みなら拒否し、`git check-ignore -q --no-index` で ignore 済みでなければ拒否する。git が使えない場合や確かめに失敗した場合も拒否する。`rootCwd` との位置は問わない。同じ場所、`repoRoot` を囲む向き、`stateDir` と `worktreeRoot` の重なりは、従来どおり拒否する。
- **Rationale**: `stateDir` にトークンと SQLite が入るので、`git add -A` による誤コミットを防ぐ必要がある。ignore の判定は、否定・ネスト・`.git/info/exclude`・グローバルの ignore を含めて git に任せるのが正しい。`rootCwd` の内側を拒否すると、通常の配置（`rootCwd` = `repoRoot`）で内側の置き場がすべて拒否され、緩和の意味がなくなる。
- **Rejected alternatives**: `.gitignore` を自前で解釈する案 — git とずれる。内側を許さず意図を docs に書くだけの案 — 利用者が許す答えを選んだ。daemon が `stateDir` 直下に `.gitignore` を書く案 — 設定読み込みの副作用が増えて説明が複雑になる。
