#!/usr/bin/env bash
# コミットの author・committer のメールと、本文の Co-authored-by の行のメールが、許す形だけかを確かめる。
# 使い方: bash scripts/ci-commit-emails.sh <git log に渡す範囲や引数…>（例: "<base>..<head>"、"-1 <sha>"）
# 許す形: *@users.noreply.github.com・noreply@github.com・noreply@anthropic.com（大文字・小文字は問わない）。
# 外れたら exit 1。どのコミットの、どの欄（author・committer・Co-authored-by）かを出す。アドレスそのものは出さない。
set -euo pipefail

allowed() {
  printf '%s' "$1" | grep -Eiq '^([^@[:space:]]+@users\.noreply\.github\.com|noreply@github\.com|noreply@anthropic\.com)$'
}

[ "$#" -gt 0 ] || { echo "::error::ci-commit-emails.sh: 確かめる範囲がありません" >&2; exit 2; }
shas="$(git rev-list "$@")"
bad=0
count=0
for sha in ${shas}; do
  count=$((count + 1))
  short="$(git rev-parse --short "${sha}")"
  ae="$(git show -s --format='%ae' "${sha}")"
  ce="$(git show -s --format='%ce' "${sha}")"
  allowed "${ae}" || { echo "::error::コミット ${short}: author のメールが許す形ではありません"; bad=1; }
  allowed "${ce}" || { echo "::error::コミット ${short}: committer のメールが許す形ではありません"; bad=1; }
  while IFS= read -r line; do
    email="$(printf '%s' "${line}" | sed -nE 's/^[[:space:]]*co-authored-by:.*<([^>]*)>.*$/\1/Ip')"
    if [ -z "${email}" ] || ! allowed "${email}"; then
      echo "::error::コミット ${short}: 本文の Co-authored-by のメールが許す形ではありません"
      bad=1
    fi
  done < <(git show -s --format='%B' "${sha}" | grep -Ei '^[[:space:]]*co-authored-by:' || true)
done

if [ "${bad}" -ne 0 ]; then
  cat <<'MSG'
許す形: <名前>@users.noreply.github.com・noreply@github.com・noreply@anthropic.com
直し方:
  - GitHub の Settings → Emails で「Keep my email addresses private」を有効にし、表示される noreply のアドレス（<番号>+<名前>@users.noreply.github.com）を確かめる
  - git config user.email "<番号>+<名前>@users.noreply.github.com" を設定する
  - 外れたコミットを直す（git commit --amend --reset-author、または git rebase -i で、author と Co-authored-by の行を直す）してから push し直す
MSG
  exit 1
fi
echo "コミットのメールを確かめました（${count} 件）"
