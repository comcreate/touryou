// plugin/.mcp.json の stdio 型のサーバー（node）の、起動の正本（落ちない中継）。
// plugin-check.mjs が完全一致で検査し、試験（mcp-stdio-command.test.mjs）が、中継（plugin/scripts/touryou-mcp-shim.sh）を実際に走らせる。
// - Claude Code は、統合セッションごとに `/bin/bash ${CLAUDE_PLUGIN_ROOT}/scripts/touryou-mcp-shim.sh` を起動し、標準入出力で MCP を話す。
//   `${CLAUDE_PLUGIN_ROOT}` は、Claude Code が plugin の場所に置き換える（公式の文書。commands でも置き換わる）。
// - 中継を `bash <file>` で起動するので、zip の展開で実行権が落ちても動く。
// - 配布物があれば、中継は `touryou-mcp --stdio` を exec する。なければ、配布物が置かれるまで待ち、置かれたら引き継ぐ
//   （/setup のあとに Reconnect が要らない）。詳しくは中継の先頭のコメント。

export const MCP_STDIO_COMMAND = "/bin/bash";
export const MCP_STDIO_ARGS = ["${CLAUDE_PLUGIN_ROOT}/scripts/touryou-mcp-shim.sh"];
