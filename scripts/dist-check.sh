#!/usr/bin/env bash
# 配布物（tar.gz）に、plugin/scripts/install-runtime.sh（/touryou:setup）と同じ中身の検査を当てる（#56）。
# 検査の関数（check_list・check_types・check_kinds・check_links）は、install-runtime.sh を source して、そのまま使う（写しを作らない）。
# 使い方: bash scripts/dist-check.sh <tar.gz の絶対パス>。通れば 0、どれかに当たれば、当たった検査の名前を出して 1。
set -euo pipefail
tgz="${1:?tar.gz の絶対パス}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$work"' EXIT
tar -tzf "$tgz" > "$work/list.txt"
tar -tvzf "$tgz" > "$work/list-v.txt"
mkdir "$work/x"
tar -xzf "$tgz" -C "$work/x"
top="$(ls "$work/x")"
# 関数の定義だけを読む（install-runtime.sh は source されたとき main を走らせない）。PATH などを書き換えるので、サブシェルで行う
(
  # shellcheck source=/dev/null
  . "${here}/../plugin/scripts/install-runtime.sh"
  DIST_DIR="${top}" # install-runtime.sh は darwin-arm64 だけを扱う。ほかの OS・CPU の配布物でも、同じ形を確かめる
  rc=0
  check_list "$work/list.txt" || { echo "検査に当たった: check_list（${DIST_DIR}/ の外・絶対パス・.. がある）" >&2; rc=1; }
  check_types "$work/list-v.txt" || { echo "検査に当たった: check_types（特殊なファイルがある）" >&2; rc=1; }
  check_kinds "$work/x" || { echo "検査に当たった: check_kinds（特殊なファイル・ハードリンク・名前に制御文字）" >&2; rc=1; }
  if ! check_links "$work/x"; then
    echo "検査に当たった: check_links（外を指す・行き先のないシンボリックリンクがある）" >&2
    rc=1
  fi
  # install-runtime.sh の check_links は、外を指すリンクを断るが、中の行き先のないリンクは断らない。配布物では、それも残さない（足しの検査）
  dangling="$(find -L "$work/x" -type l -print 2>/dev/null | head -n 5)"
  if [ -n "${dangling}" ]; then
    echo "検査に当たった: 行き先のないシンボリックリンクがある:" >&2
    printf '%s\n' "${dangling}" | sed "s#^$work/x/#  #" >&2
    rc=1
  fi
  exit "$rc"
) || exit 1
echo "配布物の中身の検査（install-runtime.sh と同じ check_list・check_types・check_kinds・check_links）: 通った"
