#!/bin/bash
# touryou: 本体（daemon・touryou-mcp・touryou。Node 同梱）を、この Mac に置く（/touryou:setup が `bash <この file>` で 1 回だけ走らせる）。
#
# 手順（どこで失敗しても、current は古いまま。理由と次にすることを出して、0 以外で終わる）:
#   1. 対象の確認（Darwin arm64・git〔Command Line Tools〕）
#   2. この plugin の中の checksums.json・plugin.json から、版・名前・sha256 を読む（引数・環境変数では変えられない）
#   3. 同じ版がすでに入って動くなら、何もせずに終わる
#   3'. plugin の版が、いまの本体より古いなら、何も変えずに止まる（古い版に入れ替えない。終了コード 4・RESULT: plugin-older。
#      常駐の有無・同意に関わらない。版の大小が比べられない形〔rc.N 以外〕は、止めずに先へ進む）
#   4. 取得（curl。https だけ・リダイレクトの先も https だけ）→ sha256 を checksums.json と照合（通るまで、展開も実行もしない）
#   5. 取得したファイルの quarantine を確かめる（外さない）
#   6. tar -t で中身を確かめる（先頭が touryou-darwin-arm64/ だけ・絶対パス・.. の要素を断る）
#   7. 置き場の中の一時ディレクトリに展開し、シンボリックリンクが外を指さないこと・quarantine がないことを確かめる → ${HOME}/.touryou/v<版> に移す
#   8. 新しい版の touryou-daemon --help が動くことを確かめる（current を付け替える前）
#   9. 常駐（launchd の plist がある）で、版が変わるときだけ: 同意（--restart-daemon）があれば、止める → 付け替え → 新しい版で init → 起動し直す
#      同意がなければ、付け替えずに終わる（終了コード 3）。常駐は、既定の設定の daemon と、設定ごとの別名の daemon
#      （touryou launchd init --config で作ったもの。LaunchAgents の touryou.daemon-<8 文字>.plist）。登録されたすべてを、起動し直す（#165）
#  10. current を付け替える（できるだけ原子的に）
#
# 終了コード: 0 成功、1 失敗、2 知らない引数、3 常駐の同意が要る（need-restart-consent）、4 plugin が本体より古い（plugin-older）。
#
# 引数は --restart-daemon だけ（常駐の daemon を止めて起動し直すことへの、利用者の同意の印）。ほかは断る。
# トークン・個人のパス（HOME の中身）は出さない。HOME の下のパスは「${HOME}/…」の形で出す。
# macOS 付属の bash（3.2）と BSD の道具で動く。試験は、この file を source して、取得などの関数を差し替える（本番の `bash <file>` の道筋では、差し替えられない）。
set -eu
umask 022
# 環境から取り込まれた関数（export -f。curl・tar などを上書きしうる）を消し、PATH を OS の既定にする（利用者の PATH の前の方の同名のコマンドを使わない）。
# BASH_ENV・ENV は、この file より先に読まれるので、ここでは防げない。/setup は `env -u BASH_ENV -u ENV bash <file>` で呼ぶ。
for _f in $(compgen -A function); do unset -f "${_f}"; done
unset _f
PATH="$(command -p getconf PATH)"
export PATH

REPO_URL="https://github.com/comcreate/touryou"
DIST_DIR="touryou-darwin-arm64"
TARGET="darwin-arm64"
LABEL_PLIST="touryou.daemon.plist"
# 自分の場所は、読み込んだ時点で決める（bash 3.2 は、source した file の関数の中で BASH_SOURCE[0] が自分を指さないことがある）
SELF="${BASH_SOURCE[0]:-$0}"
CONTACT="この plugin を配布した COMCREATE（連絡先: contact@comcreate-info.com）"
# 中身の一覧の一時ディレクトリ（手順 6 で作る）。環境から入った値を使わない（die と終わりの片付けが消すのは、ここで作ったものだけ）
LISTS=""

# --- 出力（HOME を伏せる） ---
mask() {
  # bash 3.2 でも同じに動くように、置換（${s//…}）ではなく、前後の切り出しで伏せる
  local s="$1" out=""
  if [ -n "${HOME:-}" ]; then
    while case "${s}" in *"${HOME}"*) true ;; *) false ;; esac; do
      out="${out}${s%%"${HOME}"*}\$HOME"
      s="${s#*"${HOME}"}"
    done
  fi
  printf '%s\n' "${out}${s}"
}
say() { mask "[touryou setup] $*"; }
finish() {
  # $1: 終了コード, $2: RESULT の語。成功のときは、/setup が次に進むための、設定・常駐の有無も出す（中身は出さない）
  if [ "$1" = 0 ]; then
    if [ -f "${HOME}/.touryou/config.json" ]; then echo "CONFIG: present"; else echo "CONFIG: absent"; fi
    if [ -f "${HOME}/Library/LaunchAgents/${LABEL_PLIST}" ]; then echo "LAUNCHD: present"; else echo "LAUNCHD: absent"; fi
    # 設定ごとの別名の daemon（touryou launchd init --config で作ったもの）があるときだけ出す（#165）
    if has_extra_daemons; then echo "LAUNCHD_OTHERS: present"; fi
  fi
  printf 'RESULT: %s\n' "$2"
  exit "$1"
}
has_extra_daemons() {
  # 設定ごとの別名の daemon（#165）の plist が、あるか。--others が見る場所（launchd init の出力先 $HOME/.touryou/launchd）と同じにする。
  # 名前は [<org>.]touryou.daemon-<8 文字の 16 進>.plist
  local f
  for f in "${HOME}/.touryou/launchd/"touryou.daemon-????????.plist "${HOME}/.touryou/launchd/"*.touryou.daemon-????????.plist; do
    [ -f "${f}" ] && return 0
  done
  return 1
}
cleanup_lists() {
  # 中身の一覧の一時ディレクトリを消す（work に残さない）。消すのは、置き場の中の .lists. で始まるものだけ
  case "${LISTS}" in "${BASE:-/nonexistent}"/.lists.*) rm -rf "${LISTS}" ;; esac
  LISTS=""
}
die() {
  # $1: 理由, $2: 次にすること, $3: いまの状態（省略すると「current は変えていない」）
  cleanup_lists
  say "止めました: $1"
  say "いまの状態: ${3:-current は変えていません（いま動いているものは、そのまま）}"
  [ -z "${2:-}" ] || say "次にすること: $2"
  finish 1 failed
}
run_masked() {
  # コマンドの出力（標準出力・標準エラー）を、HOME を伏せて出す。終了コードを返す。
  local out rc=0
  out="$("$@" 2>&1)" || rc=$?
  if [ -n "${out}" ]; then
    while IFS= read -r l; do mask "  | ${l}"; done <<EOF
${out}
EOF
  fi
  return "${rc}"
}

# --- 差し替えられる（試験のための）小さな関数。本番の道筋では、この定義のまま ---
platform() { uname -sm; }
has_git() {
  local d
  d="$(xcode-select -p 2>/dev/null)" || return 1
  [ -n "${d}" ] && [ -x "${d}/usr/bin/git" ]
}
fetch() {
  # $1: URL, $2: 書き込み先
  curl -fsSL --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 30 -o "$2" "$1"
}
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}
has_quarantine() {
  # $1: ファイルかディレクトリ。quarantine の属性があれば 0。macOS 以外（xattr がない）は 1。
  command -v xattr >/dev/null 2>&1 || return 1
  if [ -d "$1" ]; then
    [ "$(ls -lR@ "$1" 2>/dev/null | grep -c com.apple.quarantine || true)" != "0" ]
  else
    xattr -p com.apple.quarantine "$1" >/dev/null 2>&1
  fi
}
swap_link() {
  # $1: 行き先, $2: リンク。新しいリンクを作ってから rename(2) で入れ替える（perl がなければ ln -sfn）。
  local tmp="$2.new.$$"
  rm -f "${tmp}"
  ln -s "$1" "${tmp}"
  if command -v perl >/dev/null 2>&1 && perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "${tmp}" "$2"; then # plugin-check: allow-dollar (perl の $ARGV)
    return 0
  fi
  rm -f "${tmp}"
  ln -sfn "$1" "$2"
}

# --- JSON の読み取り（make-checksums.mjs・plugin.json の、1 行 1 キーの形を前提。形が違えば、値が取れずに止まる） ---
json_first() {
  # $1: キー, $2: ファイル。最初に出る "キー": "値" の値
  sed -n "s/^[[:space:]]*\"$1\":[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$2" | head -n 1
}
json_in_block() {
  # $1: ブロックのキー, $2: キー, $3: ファイル。"ブロック": { の後の、最初の } までの中の値
  awk -v blk="\"$1\"" -v key="\"$2\"" '
    index($0, blk) && /\{/ { inb = 1; next }
    inb && /\}/ { exit }
    inb && index($0, key) {
      s = $0; sub(/^[^:]*:[[:space:]]*"/, "", s); sub(/".*$/, "", s); print s; exit
    }' "$3"
}

# --- 中身の検査 ---
check_list() {
  # $1: tar -t の一覧のファイル。先頭が DIST_DIR/ だけ・.. の要素がない
  grep -q -v -E "^${DIST_DIR}(/|\$)" "$1" && return 1
  grep -q -E '(^|/)\.\.(/|$)' "$1" && return 1
  [ -s "$1" ]
}
restore_old() {
  # 常駐の daemon を止めたあと（または止めようとしたあと）の失敗。current を前の版（prev）に戻し、前の版で apply --yes してから止まる。
  # main の local（prev・old・ver・BASE・CONTACT）を、bash の動的スコープで読む。
  # 新しい版の launchd init のあと（migrated=1）は、生成物が新しい形。前の版の apply では扱えないので、新しい版の uninstall で外し、
  # 前の版の init で前の形を作り直してから、前の版で apply する（#64）
  local why="$1" state
  if [ "${migrated:-0}" = 1 ] && [ "${hasdef:-0}" = 1 ] && ! run_masked "${VDIR}/${DIST_DIR}/bin/touryou" launchd uninstall --yes; then
    die "${why}（v${ver} の生成物を外せず、v${old} に戻せなかった）" "/touryou:service status で確かめ、docs/launchd.md の手作業の手順で戻す。${CONTACT} に相談する" "current は v${ver} のまま、常駐の daemon は止まっている"
  fi
  if [ -n "${prev}" ] && { [ "$(readlink "${BASE}/current" 2>/dev/null)" = "${prev}" ] || swap_link "${prev}" "${BASE}/current"; }; then
    say "${why}。current を v${old} に戻して、v${old} で起動し直します"
    if { [ "${hasdef:-0}" != 1 ] || [ "${migrated:-0}" != 1 ] || run_masked "${BASE}/current/bin/touryou" launchd init; } &&
      { [ "${hasdef:-0}" != 1 ] || run_masked "${BASE}/current/bin/touryou" launchd apply --yes; } &&
      { [ "${hasext:-0}" != 1 ] || run_masked "${BASE}/current/bin/touryou" launchd apply --yes --others; }; then
      state="current は v${old} に戻し、常駐の daemon は v${old} で動いている。v${ver} は \$HOME/.touryou/v${ver} に置いたまま"
      die "${why}（v${old} に戻した）" "出力を確かめ、${CONTACT} に相談する" "${state}"
    fi
    state="current は v${old} に戻したが、常駐の daemon は止まっている（v${old} での起動にも失敗した）"
    die "${why}（v${old} での起動し直しにも失敗した）" "/touryou:service status で確かめる。直したら touryou launchd apply --yes で起動し直す（次のログインでも、v${old} で動き出す）" "${state}"
  fi
  die "${why}（current を v${old} に戻せなかった）" "/touryou:service status と \$HOME/.touryou/current を確かめ、${CONTACT} に相談する" "current が v${old} を指しているか分からない。常駐の daemon は止まっている"
}
check_kinds() {
  # $1: 展開した一時ディレクトリ。通常のファイル・ディレクトリ・シンボリックリンクだけで、ハードリンク（リンク数 2 以上のファイル）と、
  # 名前に制御文字（改行・タブなど）を含むものがないこと
  [ -z "$(find "$1" ! -type f ! -type d ! -type l -print 2>/dev/null | head -n 1)" ] || return 1
  [ -z "$(find "$1" -type f -links +1 -print 2>/dev/null | head -n 1)" ] || return 1
  [ -z "$(LC_ALL=C find "$1" -name '*[[:cntrl:]]*' -print 2>/dev/null | head -n 1)" ] || return 1
  return 0
}
check_types() {
  # $1: tar -tv の一覧のファイル。種類が、通常のファイル（-）・ディレクトリ（d）・シンボリックリンク（l）だけであること
  ! LC_ALL=C grep -q -v -E '^[-dl]' "$1"
}
check_links() {
  # $1: 展開した一時ディレクトリ。中のシンボリックリンクの行き先（の親）が $1 の中にあること。絶対パス・外を指すもの・行き先の親のないものを断る。
  # 行き先の親が中にあれば、行き先そのものがないリンクは通す（配布物の検査〔scripts/dist-check.sh の find -L〕が断る）
  local root l t d real
  root="$(cd -P "$1" && pwd -P)"
  while IFS= read -r l; do
    [ -n "${l}" ] || continue
    t="$(readlink "${l}")"
    case "${t}" in /*) return 1 ;; esac
    d="$(dirname "${l}")"
    case "$(basename "${t}")" in
      . | ..) real="$(cd "${d}" 2>/dev/null && cd -P "${t}" 2>/dev/null && pwd -P)" || return 1 ;;
      *) real="$(cd "${d}" 2>/dev/null && cd -P "$(dirname "${t}")" 2>/dev/null && pwd -P)" || return 1 ;;
    esac
    case "${real}/" in "${root}"/*) ;; *) return 1 ;; esac
  done <<EOF
$(find "$1" -type l)
EOF
  return 0
}

current_version() {
  # current が指す v<版> の版（なければ空）
  local t
  [ -L "${BASE}/current" ] || return 0
  t="$(readlink "${BASE}/current")"
  printf '%s' "${t}" | sed -n "s#^.*/v\([0-9][0-9A-Za-z.+-]*\)/${DIST_DIR}/*\$#\1#p"
}

# plugin/scripts/runtime-version-notice.sh にも、同じ vercmp がある（同じ表で試験している）
# 共通の file に分けないのは、SessionStart のフックが POSIX sh で走り、bash 用のこの file を source できないため
vercmp_split() {
  # $1: N.N.N の形の版の本体。vc_s1・vc_s2・vc_s3 に 3 つの数を入れる。形が違えば 2
  case "$1" in "" | *[!0-9.]* | .* | *. | *..*) return 2 ;; esac
  vc_o="${IFS}"
  IFS=.
  set -- $1
  IFS="${vc_o}"
  [ "$#" = 3 ] || return 2
  [ "${#1}" -le 9 ] && [ "${#2}" -le 9 ] && [ "${#3}" -le 9 ] || return 2
  vc_s1="$1"
  vc_s2="$2"
  vc_s3="$3"
}
vercmp_pre() {
  # $1: 空、または -rc.N。vc_n に N を入れる（空なら pre なし）。それ以外の形は 2
  case "$1" in
    "") vc_n="" ;;
    -rc.*)
      vc_n="${1#-rc.}"
      case "${vc_n}" in "" | *[!0-9]*) return 2 ;; esac
      [ "${#vc_n}" -le 9 ] || return 2
      ;;
    *) return 2 ;;
  esac
}
vercmp() {
  # 版 $1 と $2 を semver どおりに比べる（+ 以降は無視。pre は rc.N だけ）。0: 同じ、1: $1 が古い、3: $1 が新しい、2: 比べられない
  vc_a="${1%%+*}"
  vc_b="${2%%+*}"
  vc_ca="${vc_a%%-*}"
  vc_cb="${vc_b%%-*}"
  vc_pa=""
  vc_pb=""
  [ "${vc_a}" = "${vc_ca}" ] || vc_pa="-${vc_a#*-}"
  [ "${vc_b}" = "${vc_cb}" ] || vc_pb="-${vc_b#*-}"
  vercmp_split "${vc_ca}" || return 2
  vc_a1="${vc_s1}"
  vc_a2="${vc_s2}"
  vc_a3="${vc_s3}"
  vercmp_split "${vc_cb}" || return 2
  vercmp_pre "${vc_pa}" || return 2
  vc_na="${vc_n}"
  vercmp_pre "${vc_pb}" || return 2
  vc_nb="${vc_n}"
  [ "${vc_a1}" -lt "${vc_s1}" ] && return 1
  [ "${vc_a1}" -gt "${vc_s1}" ] && return 3
  [ "${vc_a2}" -lt "${vc_s2}" ] && return 1
  [ "${vc_a2}" -gt "${vc_s2}" ] && return 3
  [ "${vc_a3}" -lt "${vc_s3}" ] && return 1
  [ "${vc_a3}" -gt "${vc_s3}" ] && return 3
  [ -n "${vc_pa}" ] || [ -n "${vc_pb}" ] || return 0
  [ -n "${vc_pa}" ] || return 3
  [ -n "${vc_pb}" ] || return 1
  [ "${vc_na}" -lt "${vc_nb}" ] && return 1
  [ "${vc_na}" -gt "${vc_nb}" ] && return 3
  return 0
}

main() {
  local consent=0 a
  for a in "$@"; do
    case "${a}" in
      --restart-daemon) consent=1 ;;
      *) say "知らない引数です（受け付けるのは --restart-daemon だけ）"; finish 2 failed ;;
    esac
  done

  # 1. 対象
  if [ -z "${HOME:-}" ] || [ "${HOME#/}" = "${HOME}" ]; then die "HOME が空、または絶対パスでない" "Terminal の設定を確かめる"; fi
  case "${HOME}" in *[!A-Za-z0-9._/@+-]*) die "HOME に、英数字と . _ / @ + - 以外の文字が含まれる（この setup は扱わない）" "${CONTACT} に相談する" ;; esac
  if [ "$(platform)" != "Darwin arm64" ]; then
    die "この配布物は、Apple Silicon（M シリーズ）の Mac だけに対応しています" "対応する Mac で使う"
  fi
  if ! has_git; then
    die "git（Xcode の Command Line Tools）が見つからない" "Terminal で xcode-select --install を実行し、終わってから、もう一度 /touryou:setup"
  fi

  # 2. 配布物の情報（この plugin の中だけ）
  local P CK PJ ver pver repo name sha
  P="$(cd -P "$(dirname "${SELF}")/.." && pwd -P)"
  CK="${P}/checksums.json"
  PJ="${P}/.claude-plugin/plugin.json"
  [ -f "${CK}" ] || die "この plugin の版には、配布物の情報（checksums.json）が入っていない" "${CONTACT} に確かめる"
  [ -f "${PJ}" ] || die "plugin.json がない" "plugin を入れ直す"
  ver="$(json_first version "${CK}")"
  pver="$(json_first version "${PJ}")"
  repo="$(json_first repository "${PJ}")"
  name="$(json_in_block "${TARGET}" name "${CK}")"
  sha="$(json_in_block "${TARGET}" sha256 "${CK}")"
  printf '%s' "${ver}" | grep -q -E '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "checksums.json の版の形が正しくない" "${CONTACT} に確かめる"
  [ "${ver}" = "${pver}" ] || die "checksums.json の版（${ver}）と plugin の版（${pver}）が違う" "${CONTACT} に確かめる"
  [ "${repo}" = "${REPO_URL}" ] || die "plugin.json の repository が、決まった取得元でない" "${CONTACT} に確かめる"
  [ "${name}" = "touryou-${ver}-${TARGET}.tar.gz" ] || die "checksums.json の配布物の名前が正しくない" "${CONTACT} に確かめる"
  printf '%s' "${sha}" | grep -q -E '^[0-9a-f]{64}$' || die "checksums.json の sha256 の形が正しくない" "${CONTACT} に確かめる"

  BASE="${HOME}/.touryou"
  local VDIR="${BASE}/v${ver}" WORK="${BASE}/work" old
  if [ -e "${BASE}/current" ] && [ ! -L "${BASE}/current" ]; then
    die "\$HOME/.touryou/current が、リンクでない（上書きしない）" "中身を確かめ、要らなければ自分で名前を変える"
  fi
  old="$(current_version)"

  # 3. 同じ版
  if [ "${old}" = "${ver}" ] && [ -x "${BASE}/current/bin/touryou-daemon" ] &&
    "${BASE}/current/bin/touryou-daemon" --help >/dev/null 2>&1; then
    say "v${ver} は、すでに入っていて動きます。何もしませんでした"
    finish 0 already
  fi

  # plugin が、いまの本体より古いなら、古い版に入れ替えずに止める（取得も展開もしない。常駐の有無・同意より前）。
  # 版の大小が比べられない形（rc.N 以外）は、止めずに、今までの動きにする
  local vrc=0
  if [ -n "${old}" ]; then
    vercmp "${ver}" "${old}" || vrc=$?
    if [ "${vrc}" = 1 ]; then
      say "止めました: plugin（v${ver}）が、いまの本体（v${old}）より古い。古い版に入れ替えません。"
      if ! { [ -x "${BASE}/current/bin/touryou-daemon" ] && "${BASE}/current/bin/touryou-daemon" --help >/dev/null 2>&1; }; then
        say "いまの本体が動かない場合も、先に plugin を新しくしてください。"
      fi
      say "いまの状態: 何も変えていません"
      say "次にすること: claude plugin marketplace update touryou のあと、claude plugin update touryou@touryou --scope user を実行し、Claude Code を開き直してから、もう一度 /touryou:setup。"
      finish 4 plugin-older
    fi
  fi

  # 常駐の有無（plist があるか）。版を変える前に決める
  # 常駐の daemon は、既定の設定の 1 つ（hasdef）と、設定ごとの別名の daemon（hasext。touryou launchd init --config。#165）。
  # どちらかがあれば managed。登録されたすべてを、止める → 付け替え → 起動し直す
  local managed=0 hasdef=0 hasext=0 agents="${HOME}/Library/LaunchAgents"
  if [ -n "${old}" ] && [ -f "${agents}/${LABEL_PLIST}" ]; then hasdef=1; fi
  if [ -n "${old}" ] && has_extra_daemons; then hasext=1; fi
  if [ "${hasdef}" = 1 ] || [ "${hasext}" = 1 ]; then managed=1; fi
  if [ -n "${old}" ] && [ "${hasdef}" = 0 ] && ls "${agents}"/*.touryou.daemon.plist >/dev/null 2>&1; then
    die "常駐（launchd）が、組織の名前つき（--org）で設定されている。この script は、それを起動し直さない" "docs/launchd.md の手作業の手順で版を上げる"
  fi
  if [ "${managed}" = 1 ] && [ "${consent}" = 0 ]; then
    say "常駐（launchd）の daemon が設定されています（v${old}）。v${ver} に入れ替えるには、daemon を止めて起動し直します（動いている子のセッションは止まります）"
    say "何も変えていません。利用者の「はい」を取ってから、--restart-daemon を付けて、もう一度実行してください"
    finish 3 need-restart-consent
  fi

  mkdir -p "${WORK}"

  # 4. 取得と照合（照合が通るまで、展開も実行もしない）
  local file="${WORK}/${name}" part="${WORK}/${name}.part"
  if [ -f "${file}" ] && [ "$(sha256_of "${file}")" = "${sha}" ]; then
    say "取得済みの配布物が、checksums.json と一致しました（取り直しません）"
  else
    say "配布物を取得します（v${ver}。目安として約 41MB。数分かかることがあります）"
    rm -f "${part}"
    if ! fetch "${REPO_URL}/releases/download/v${ver}/${name}" "${part}"; then
      rm -f "${part}"
      die "配布物を取得できなかった（404 なら、この版の配布物が公開されていない）" "ネットワークを確かめて、もう一度 /touryou:setup。404 なら plugin を新しい版にしてから（claude plugin marketplace update touryou と claude plugin update touryou@touryou --scope user）"
    fi
    if [ "$(sha256_of "${part}")" != "${sha}" ]; then
      rm -f "${part}"
      die "配布物の検証（sha256 の照合）に失敗した（改ざん・取得の失敗の可能性）。展開していない" "もう一度 /touryou:setup。それでも合わなければ、${CONTACT} に知らせる"
    fi
    mv -f "${part}" "${file}"
    say "sha256 を、plugin の checksums.json と照合しました（一致）"
  fi

  # 5. quarantine（外さない）
  if has_quarantine "${file}"; then
    die "配布物に macOS の安全確認の印（quarantine）が付いている。外していない" "もう一度 /touryou:setup で取り直す。それでも付くなら ${CONTACT} に相談する"
  fi

  # 6. 中身の一覧
  # 一覧は、置き場の中の一時ディレクトリに作り、検査のあとに消す（失敗のときは die が消す。work に残さない）
  # 中断（Ctrl-C・SIGTERM）でも消す。exit の道（die・finish・set -e）は EXIT で消す
  trap 'cleanup_lists' EXIT
  trap 'exit 130' INT TERM
  LISTS="$(mktemp -d "${BASE}/.lists.XXXXXX")" || die "一時ディレクトリを作れない" "空き容量を確かめて、もう一度 /touryou:setup"
  local list="${LISTS}/list.txt"
  if ! tar -tzf "${file}" >"${list}" 2>/dev/null; then die "配布物を読めない（壊れている）" "もう一度 /touryou:setup"; fi
  check_list "${list}" || die "配布物の中身が、想定と違う（${DIST_DIR}/ の外・絶対パス・.. がある）" "${CONTACT} に知らせる"
  if LC_ALL=C grep -q '[[:cntrl:]]' "${list}"; then die "配布物の中身が、想定と違う（名前に制御文字がある）" "${CONTACT} に知らせる"; fi
  local vlist="${LISTS}/list-v.txt"
  if ! tar -tvzf "${file}" >"${vlist}" 2>/dev/null; then die "配布物を読めない（壊れている）" "もう一度 /touryou:setup"; fi
  check_types "${vlist}" || die "配布物の中身が、想定と違う（デバイス・FIFO・ハードリンクなど、特殊なファイルがある）" "${CONTACT} に知らせる"
  cleanup_lists

  # 7. 一時ディレクトリに展開して確かめ、v<版> に移す
  local stage="${BASE}/.stage-v${ver}.$$"
  rm -rf "${stage}"
  mkdir -p "${stage}"
  if ! tar -xzf "${file}" -C "${stage}" 2>/dev/null; then rm -rf "${stage}"; die "配布物を展開できない" "もう一度 /touryou:setup"; fi
  if ! check_kinds "${stage}"; then rm -rf "${stage}"; die "配布物の中に、特殊なファイル（デバイス・FIFO・ハードリンクなど）か、名前に制御文字を含むものがある" "${CONTACT} に知らせる"; fi
  if ! check_links "${stage}"; then rm -rf "${stage}"; die "配布物の中に、外を指すシンボリックリンクがある" "${CONTACT} に知らせる"; fi
  if has_quarantine "${stage}"; then rm -rf "${stage}"; die "展開したファイルに quarantine が付いている。外していない" "${CONTACT} に相談する"; fi
  if ! [ -x "${stage}/${DIST_DIR}/bin/touryou-daemon" ] || ! "${stage}/${DIST_DIR}/bin/touryou-daemon" --help >/dev/null 2>&1; then
    rm -rf "${stage}"
    die "新しい版の touryou-daemon --help が動かない" "uname -sm が Darwin arm64 か確かめ、${CONTACT} に相談する"
  fi
  if [ -e "${VDIR}" ]; then
    # 前回の途中の展開など（current が指していない）。指していたら（壊れた同じ版）、付け替えの後で片付ける
    mv "${VDIR}" "${BASE}/.old-v${ver}.$$"
  fi
  mv "${stage}" "${VDIR}"
  say "v${ver} を \$HOME/.touryou/v${ver} に置きました（touryou-daemon --help が動くことを確かめました）"

  # 9・10. 付け替え（常駐なら、止めて → 付け替え → 起動し直す）
  local prev="" migrated=0
  [ -L "${BASE}/current" ] && prev="$(readlink "${BASE}/current")"
  if [ "${managed}" = 1 ]; then
    # 止める前に、新しい版の daemon で設定を検査する（通らない設定で起動し直すと、起動のたびに落ち続ける。Issue #65）。
    # 別名の daemon（--config）の設定は、起動し直す apply が、同じ検査をする（通らなければ、restore_old で前の版に戻す）
    if [ "${hasdef}" = 1 ] && ! run_masked "${VDIR}/${DIST_DIR}/bin/touryou-daemon" --check-config --config "${BASE}/config.json"; then
      die "config.json が、v${ver} の daemon の設定の検査を通らない（repoRoot・rootCwd・worktreeRoot が、ない・実パスでない・git のリポジトリでない、など。上の「失敗」の行）" "config.json の値を、今ある git のリポジトリ・フォルダの実パスに直してから（または設定をやり直してから）、もう一度 /touryou:setup" "daemon は止めていない（v${old} のまま）。v${ver} は \$HOME/.touryou/v${ver} に置いたが、current は v${old} のまま"
    fi
    say "常駐の daemon（v${old}）を止めます"
    if [ "${hasdef}" = 1 ] && ! run_masked "${BASE}/current/bin/touryou" launchd init; then
      die "v${old} の launchd init が通らない（上の出力。生成物が、引数なしの launchd init と違う〔--org・--path-prefix を手で付けた、など〕か、v${old} の設定の検査が通らない）" "docs/launchd.md の手作業の手順で版を上げる" "daemon は止めていない（v${old} のまま動いている）。v${ver} は \$HOME/.touryou/v${ver} に置いたが、current は v${old} のまま"
    fi
    if [ "${hasdef}" = 1 ] && ! run_masked "${BASE}/current/bin/touryou" launchd stop; then
      restore_old "常駐の daemon を止められなかった"
    fi
    if [ "${hasext}" = 1 ] && ! run_masked "${BASE}/current/bin/touryou" launchd stop --others; then
      restore_old "設定ごとの別名の常駐の daemon を止められなかった"
    fi
    # ここから先は、daemon が止まっている。どこで失敗しても、current を前の版に戻して起動し直してから止まる（NFR_015）
    if ! swap_link "${VDIR}/${DIST_DIR}" "${BASE}/current"; then
      restore_old "current を v${ver} に付け替えられなかった"
    fi
    say "current を v${ver} に付け替えました（前は v${old}）"
    rm -rf "${BASE}/.old-v${ver}.$$" || true
    # 新しい版の init で、生成物を新しい版の形にする（古い形〔run-daemon.sh を起こす plist〕なら、置き換える。#64）
    migrated=1
    if [ "${hasdef}" = 1 ] && ! run_masked "${BASE}/current/bin/touryou" launchd init; then
      restore_old "v${ver} の launchd init が通らなかった"
    fi
    # 別名の daemon の plist も、新しい版で作り直す（各 plist の設定・組織・PATH のまま）。置いていないものは、apply --others が常駐にしない
    if [ "${hasext}" = 1 ] && ! run_masked "${BASE}/current/bin/touryou" launchd init --others; then
      restore_old "v${ver} の、設定ごとの別名の daemon の launchd init --others が通らなかった"
    fi
    say "常駐の daemon を、v${ver} で起動し直します"
    if [ "${hasdef}" = 1 ] && ! run_masked "${BASE}/current/bin/touryou" launchd apply --yes; then
      restore_old "v${ver} の daemon が起動しなかった"
    fi
    if [ "${hasext}" = 1 ] && ! run_masked "${BASE}/current/bin/touryou" launchd apply --yes --others; then
      restore_old "v${ver} の、設定ごとの別名の daemon が起動しなかった"
    fi
    say "常駐の daemon を v${ver} で起動し直しました。開いている統合セッションは、/mcp で plugin:touryou:node を Reconnect してください"
    finish 0 upgraded-restarted
  fi
  if ! swap_link "${VDIR}/${DIST_DIR}" "${BASE}/current"; then
    die "current を v${ver} に付け替えられなかった" "もう一度 /touryou:setup" "current は ${old:+v${old} のまま}${old:-まだない}。v${ver} は \$HOME/.touryou/v${ver} に置いた"
  fi
  say "current を v${ver} に付け替えました${old:+（前は v${old}）}"
  rm -rf "${BASE}/.old-v${ver}.$$" || true
  if [ -n "${old}" ]; then
    say "v${old} から v${ver} に上げました。daemon を手で動かしているなら、止めてから起動し直してください"
    finish 0 upgraded
  fi
  say "インストールできました（v${ver}）。次は、設定です"
  finish 0 installed
}

if [ "${SELF}" = "$0" ]; then
  main "$@"
fi
