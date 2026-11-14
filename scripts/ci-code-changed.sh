#!/usr/bin/env bash
# 変更のパスの一覧（1 行に 1 つ）を標準入力から読み、コードに関わる変更があれば true、なければ false を出す。
# docs・.sdd・CHANGELOG・README・LICENSE だけの変更なら false（ci.yml は重い段を飛ばし、成功で終える）。
# 一覧が空のとき（差分を取れなかったときなど）は、安全側に true。
set -euo pipefail
any=false
code=false
while IFS= read -r f; do
  [ -z "${f}" ] && continue
  any=true
  case "${f}" in
    docs/* | .sdd/* | CHANGELOG.md | README.md | LICENSE) ;;
    *) code=true ;;
  esac
done
if [ "${any}" = false ]; then
  echo true
else
  echo "${code}"
fi
