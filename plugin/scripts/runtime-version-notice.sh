# touryou: SessionStart のフックが `sh <この file>` で呼ぶ。本体（${HOME}/.touryou/current が指す v<版>）と、この plugin の版が
# 食い違えば、向きに合わせて知らせるだけ（取得・展開・daemon の起動し直しはしない）。
# - 本体が古い（plugin が新しい）: 「/touryou:setup で本体を上げる」。
# - 本体が新しい（plugin が古い）: 「先に plugin を新しくする」（/touryou:setup は、本体を古い版に入れ替えない）。
# - 版の大小が比べられない（rc.N 以外の形）: 向きを言わずに「版が違います」と /touryou:setup を案内する。同じ版は、何も出さない。
# - 本体がない・読めない・版の形が分からないときは、何も出さない。どの場合も終了コード 0（セッションの始まりを止めない）。
# - 標準出力には、Claude Code の SessionStart の JSON（systemMessage・additionalContext）だけを出す。個人のパスは出さない。
# - POSIX sh と sed だけを使う（macOS の sh〔bash の POSIX モード〕と dash で同じに動く）。
# vercmp は、plugin/scripts/install-runtime.sh にも同じものがある（同じ表で試験している）。
# 共通の file に分けないのは、このフックが POSIX sh で走り、bash 用の install-runtime.sh を source できないため。
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
p="$(dirname "$0")/../.claude-plugin/plugin.json"
c="${HOME:-}/.touryou/current"
[ -n "${HOME:-}" ] && [ -L "${c}" ] && [ -f "${p}" ] || exit 0
a="$(readlink "${c}" 2>/dev/null | sed -n 's#^.*/v\([0-9][0-9A-Za-z.+-]*\)/touryou-darwin-arm64/*$#\1#p')"
b="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([0-9][0-9A-Za-z.+-]*\)".*/\1/p' "${p}" 2>/dev/null | head -n 1)"
[ -n "${a}" ] && [ -n "${b}" ] || exit 0
vercmp "${a}" "${b}"
r=$?
case "${r}" in
  0) exit 0 ;;
  1) m="touryou の本体（v${a}）と plugin（v${b}）の版が違います。/touryou:setup を実行して、本体を上げてください（常駐の daemon は、その中で、はいと答えたときだけ起動し直します）。" ;;
  3) m="touryou の plugin（v${b}）が本体（v${a}）より古いです。/touryou:setup は本体を古い版に入れ替えないので、先に plugin を新しくしてください。claude plugin marketplace update touryou のあと claude plugin update touryou@touryou --scope user を実行し、Claude Code を開き直してください。" ;;
  *)
    [ "${a}" != "${b}" ] || exit 0
    m="touryou の本体（v${a}）と plugin（v${b}）の版が違います（本体と plugin のどちらが新しいかは分かりません）。/touryou:setup を実行してください。"
    ;;
esac
printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "${m}" "${m}"
exit 0
