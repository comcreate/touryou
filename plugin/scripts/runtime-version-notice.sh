# touryou: SessionStart のフックが `sh <この file>` で呼ぶ。本体（$HOME/.touryou/current が指す v<版>）と、この plugin の版が
# 食い違えば、「/touryou:setup で本体を上げる」と知らせるだけ（取得・展開・daemon の起動し直しはしない）。
# - 本体がない・読めない・版の形が分からないときは、何も出さない。どの場合も終了コード 0（セッションの始まりを止めない）。
# - 標準出力には、Claude Code の SessionStart の JSON（systemMessage・additionalContext）だけを出す。個人のパスは出さない。
# - POSIX sh と sed だけを使う（macOS の sh〔bash の POSIX モード〕と dash で同じに動く）。
p="$(dirname "$0")/../.claude-plugin/plugin.json"
c="${HOME:-}/.touryou/current"
[ -n "${HOME:-}" ] && [ -L "$c" ] && [ -f "$p" ] || exit 0
a="$(readlink "$c" 2>/dev/null | sed -n 's#^.*/v\([0-9][0-9A-Za-z.+-]*\)/touryou-darwin-arm64/*$#\1#p')"
b="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([0-9][0-9A-Za-z.+-]*\)".*/\1/p' "$p" 2>/dev/null | head -n 1)"
[ -n "$a" ] && [ -n "$b" ] && [ "$a" != "$b" ] || exit 0
m="touryou の本体（v$a）と plugin（v$b）の版が違います。/touryou:setup を実行して、本体を上げてください（常駐の daemon は、その中で、はいと答えたときだけ起動し直します）。"
printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$m" "$m"
exit 0
