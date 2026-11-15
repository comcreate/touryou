# touryou: 統合セッションの MCP（node）の起動（plugin の .mcp.json が `bash <この file>`（OS の bash） で起動する）。
#
# - 配布物（${HOME}/.touryou/current/bin/touryou-mcp）があり、試しの起動（標準入力を閉じる）が 0 で終われば、`touryou-mcp --stdio` を exec する（いつもの場合）。
#   試しの起動が 0 でなければ（daemon が動いていない）、下の「まだない」と同じく待つ。
# - まだない（/setup の前に始まった会話）ときは、落ちずに待つ。MCP の最低限（initialize・ping・tools/list〔空〕）に応え、ほかの要求には
#   JSON-RPC の error（-32601）で応える。2 秒ごとに配布物を探し、現れたら、10 秒ごとに試しに `touryou-mcp --stdio` を標準入力を閉じて起動し
#   （daemon が動いていなければ 1 で終わる。動いていれば 0）、0 で終わったら notifications/tools/list_changed を出して、本物に引き継ぐ
#   （本物の標準入力の頭に initialize・initialized を足し、その応答〔id が __touryou_resume__〕を出口で捨てる）。
#   Claude Code は list_changed を受けると、道具の一覧を取り直す（公式の文書の「Dynamic tool updates」）。Reconnect は要らない。
# - 標準入力が閉じたら（会話の終わり）、終わる。
# - macOS 付属の bash（3.2）と sed -E だけを使う（Node・awk は使わない）。標準出力には MCP のメッセージだけを出す。理由は標準エラーへ。
# - 引数は取らない。トークンは扱わない（touryou-mcp が state から自分で読む）。
if [ -z "${HOME}" ]; then
  echo "[touryou mcp] HOME が空。touryou-mcp を起動できない" >&2
  exit 1
fi
target="${HOME}/.touryou/current/bin/touryou-mcp"
if [ -x "${target}" ]; then
  # 配布物があっても daemon が動いていなければ、touryou-mcp は起動時の確認で終わる（会話の node が CONNECTION_CLOSED になる）。
  # 先に、標準入力を閉じて試しに起動し、0 で終わったとき（daemon につながった）だけ exec する。だめなら、下で待つ
  if "${target}" --stdio </dev/null >/dev/null 2>&1; then
    exec "${target}" --stdio
  fi
  echo "[touryou mcp] daemon にまだつながらない。動くまで待ち、動いたら、自動でつながる" >&2
else
  echo "[touryou mcp] 配布物の touryou-mcp がまだない（HOME の .touryou/current/bin）。/touryou:setup のあと、自動でつながる" >&2
fi

proto=""
next_probe=0
reply() { printf '%s\n' "$1"; }
field() { printf '%s' "$2" | sed -n -E "s/.*\"$1\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|-?[0-9]+).*/\\1/p"; }
handoff() {
  reply '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}'
  init="{\"jsonrpc\":\"2.0\",\"id\":\"__touryou_resume__\",\"method\":\"initialize\",\"params\":{\"protocolVersion\":${proto},\"capabilities\":{},\"clientInfo\":{\"name\":\"touryou-mcp-shim\",\"version\":\"1\"}}}"
  { printf '%s\n%s\n' "${init}" '{"jsonrpc":"2.0","method":"notifications/initialized"}'; exec cat; } |
    "${target}" --stdio |
    while IFS= read -r l; do
      case "${l}" in
        *'"id":"__touryou_resume__"'*) ;;
        *) printf '%s\n' "${l}" ;;
      esac
    done
  exit 0
}
while :; do
  if [ -n "${proto}" ] && [ -x "${target}" ] && [ "${SECONDS}" -ge "${next_probe}" ]; then
    next_probe=$((SECONDS + 10))
    if "${target}" --stdio </dev/null >/dev/null 2>&1; then
      echo "[touryou mcp] 配布物が置かれ、daemon につながったので、touryou-mcp に引き継ぐ" >&2
      handoff
    fi
  fi
  started=${SECONDS}
  if IFS= read -r -t 2 line; then
    id="$(field id "${line}")"
    [ -n "${id}" ] || continue
    method="$(field method "${line}")"
    case "${method}" in
      '"initialize"')
        proto="$(field protocolVersion "${line}")"
        [ -n "${proto}" ] || proto='"2025-06-18"'
        reply "{\"jsonrpc\":\"2.0\",\"id\":${id},\"result\":{\"protocolVersion\":${proto},\"capabilities\":{\"tools\":{\"listChanged\":true}},\"serverInfo\":{\"name\":\"touryou-mcp-shim\",\"version\":\"1\"},\"instructions\":\"touryou の配布物がまだない。/touryou:setup のあと、道具が出る\"}}"
        ;;
      '"ping"') reply "{\"jsonrpc\":\"2.0\",\"id\":${id},\"result\":{}}" ;;
      '"tools/list"') reply "{\"jsonrpc\":\"2.0\",\"id\":${id},\"result\":{\"tools\":[]}}" ;;
      *) reply "{\"jsonrpc\":\"2.0\",\"id\":${id},\"error\":{\"code\":-32601,\"message\":\"touryou の配布物がまだない（/touryou:setup の前）\"}}" ;;
    esac
  else
    rc=$?
    # 待ちの切れなら、続ける。標準入力が閉じた（会話の終わり）なら、終わる。
    # bash 4 以降は、切れの終了コードが 128 より大きい。macOS の bash 3.2 は、切れも閉じたも 1 なので、かかった秒数で分ける
    # （閉じたときは、すぐ返る。秒の境をまたいで取り違えても、次の read がすぐ返るので、1 回余分に回るだけ）
    if [ "${rc}" -le 128 ] && [ $((SECONDS - started)) -lt 1 ]; then
      exit 0
    fi
  fi
done
