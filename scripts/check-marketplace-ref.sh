#!/usr/bin/env bash
# project の .claude/settings.json の marketplace の参照（ref）が、marketplace.json の版の tag を指すかを照らす（#90。docs/release.md の 5-a）。
#   name: ref が "marketplace-v<marketplace.json の版>" であること（tag の有無は見ない。PR の CI 用）
#   tag:  name に加えて、上流（origin）にその tag があり、tag の中の marketplace.json の版が同じであること（main への push・定期用）。
#   pushed <tag>: push された marketplace-v<版> の tag の中の marketplace.json の版が、tag 名の版と同じであること（tag の push 用。main の settings は見ない）
# 使い方: bash scripts/check-marketplace-ref.sh name|tag|pushed <tag>
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-}"
case "${mode}" in name | tag | pushed) ;; *) echo "使い方: $0 name|tag|pushed <tag>" >&2; exit 2 ;; esac

settings=.claude/settings.json
market=.claude-plugin/marketplace.json
name="$(jq -r .name plugin/.claude-plugin/plugin.json)"

if [ "${mode}" = pushed ]; then
  tag="${2:-}"
  case "${tag}" in marketplace-v?*) ;; *) echo "::error::tag の名前「${tag}」が marketplace-v<版> の形ではありません"; exit 1 ;; esac
  inside="$(git show "refs/tags/${tag}:${market}" | jq -r --arg n "${name}" '.plugins[] | select(.name == $n) | .version')"
  if [ "${inside}" != "${tag#marketplace-v}" ]; then
    echo "::error::tag ${tag} の中の ${market} の版が「${inside}」です（${tag#marketplace-v} であるべき）。tag を付ける先を間違えた恐れ（docs/release.md の 5-a）"
    exit 1
  fi
  echo "tag ${tag} の中の marketplace.json の版は ${inside}"
  exit 0
fi
version="$(jq -r --arg n "${name}" '.plugins[] | select(.name == $n) | .version' "${market}")"
ref="$(jq -r '.extraKnownMarketplaces.touryou.source.ref // empty' "${settings}")"
want="marketplace-v${version}"

if [ -z "${version}" ]; then
  echo "::error::${market} に ${name} の項目がありません"
  exit 1
fi
if [ "${ref}" != "${want}" ]; then
  echo "::error::${settings} の extraKnownMarketplaces.touryou.source.ref が「${ref}」です。「${want}」にしてください（docs/release.md の 5-a）"
  exit 1
fi
echo "ref は ${want}（marketplace.json の版 ${version}）"
[ "${mode}" = name ] && exit 0

if ! git ls-remote --exit-code --tags origin "refs/tags/${want}" >/dev/null; then
  echo "::error::上流に tag ${want} がありません。管理者が付けてください（docs/release.md の 5-a）"
  exit 1
fi
git fetch -q --depth=1 origin "+refs/tags/${want}:refs/tags/${want}"
inside="$(git show "${want}:${market}" | jq -r --arg n "${name}" '.plugins[] | select(.name == $n) | .version')"
if [ "${inside}" != "${version}" ]; then
  echo "::error::tag ${want} の中の ${market} の版が「${inside}」です（${version} であるべき）"
  exit 1
fi
echo "tag ${want} があり、中の marketplace.json の版も ${version}"
