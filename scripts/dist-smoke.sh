#!/usr/bin/env bash
# 実験: dist-build.sh の tar.gz を、空の場所に展開し、PATH に node がない環境で daemon を起動して、窓口に届くことを確かめる。
# 使い方: bash scripts/dist-smoke.sh <tar.gz の絶対パス>
set -euo pipefail
tgz="${1:?tar.gz の絶対パス}"
work="$(cd "$(mktemp -d)" && pwd -P)"   # macOS の /var は /private/var へのリンク。設定は実パスで書く
# pid が空のとき kill 0 にしない（kill 0 は、自分のプロセスのグループ全体（runner の段のシェルも）に SIGTERM を送り、143 で落ちる）
trap 'if [ -n "${pid:-}" ]; then kill "$pid" 2>/dev/null || true; fi; rm -rf "$work"' EXIT
echo "== 配布物の中身を、/touryou:setup（install-runtime.sh）と同じ検査で確かめる（#56）"
bash "$(dirname "$0")/dist-check.sh" "$tgz"
tar -C "$work" -xzf "$tgz"
dir="$(ls -d "$work"/touryou-*)"
# repo と設定（stateDir は 0700、設定は 0600）
repo="$work/repo"; mkdir -p "$repo" && git -C "$repo" init -q && git -C "$repo" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m init
mkdir -m 700 "$work/state" "$work/wt"
cat > "$work/config.json" <<JSON
{
  "stateDir": "$work/state",
  "repoRoot": "$repo",
  "worktreeRoot": "$work/wt",
  "rootCwd": "$repo",
  "rootScope": { "writableLocations": ["src"], "forbiddenLocations": [".git"], "allowedCommands": ["git status"] }
}
JSON
chmod 600 "$work/config.json"
echo "== node が PATH にないことを確かめる"
if env -i PATH=/usr/bin:/bin sh -c 'command -v node' >/dev/null 2>&1; then
  echo "この端末の /usr/bin か /bin に node がある。Node なしの確認にならないので失敗とする" >&2
  exit 1
fi
echo "（この確認は、runner 上の展開先に quarantine が付かないため、Gatekeeper の影響は確かめられない。macOS の手元で確認する）"
echo "== --help（同梱の node だけで）"
env -i PATH=/usr/bin:/bin HOME="$work" "$dir/bin/touryou-daemon" --help | head -2
"$dir/bin/node" -v
echo "== touryou・touryou-mcp の起動口（同梱の node だけで）"
env -i PATH=/usr/bin:/bin HOME="$work" "$dir/bin/touryou" --help | head -1
env -i PATH=/usr/bin:/bin HOME="$work" "$dir/bin/touryou-mcp" --help >/dev/null 2>"$work/mcp-help.err" || true
if grep -q 'ERR_MODULE_NOT_FOUND' "$work/mcp-help.err"; then echo "touryou-mcp: 依存が解決できない"; cat "$work/mcp-help.err"; exit 1; fi
echo "== touryou hook（Node なし）: 環境変数がなければ何も出さずに 0、daemon に届かなければ拒否（終了コード 2）"
bash "$(dirname "$0")/dist-smoke-hook.sh" "$dir/bin/touryou"
echo "== daemon を起動する"
env -i PATH=/usr/bin:/bin HOME="$work" "$dir/bin/touryou-daemon" --config "$work/config.json" >"$work/out.log" 2>"$work/err.log" &
pid=$!
for _ in $(seq 1 30); do
  if grep -q '"started"' "$work/err.log" "$work/out.log" 2>/dev/null; then break; fi
  kill -0 "$pid" 2>/dev/null || { echo "daemon が終了した"; cat "$work/err.log"; exit 1; }
  sleep 1
done
grep -q '"started"' "$work/err.log" "$work/out.log" || { echo "started が出ない"; cat "$work/err.log"; exit 1; }
port="$(cat "$work/state/port")"
echo "== 窓口に届くか（認証なしの whoami は 401 が返れば、daemon がいる）"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/v1/whoami")"
echo "HTTP ${code}"
[ "$code" = "401" ] || { echo "期待は 401"; exit 1; }
echo "== 同梱の node で better-sqlite3 を読み込み、SQLite を開く"
( cd "$dir/lib" && env -i PATH=/usr/bin:/bin HOME="$work" "$dir/bin/node" -e "const D=require('better-sqlite3'); const r=new D(':memory:').prepare('select 1 as x').get(); if (r.x!==1) process.exit(1); console.log('better-sqlite3 OK')" )
echo "OK"
