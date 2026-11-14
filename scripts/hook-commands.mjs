// plugin/hooks/hooks.json の command の、正本。plugin-check.mjs が、完全一致で検査し、試験が、実際に sh で走らせる。
// POSIX シェルの 1 行（Claude Code は、macOS・Linux では、command の文字列を `sh -c` で実行する。公式の hooks のドキュメントによる）。
// - `$HOME` 基準の固定の 1 か所（`.touryou/current/bin/touryou`）が実行可能なら、`touryou hook` を実行する（標準入力は、そのまま渡る。PATH は見ない）。
//   拒否版: 終了コードが 0・2 ならそのまま返す。それ以外（壊れた `touryou` など）と、`touryou` がない（`$HOME` が未設定・空、ファイルがない、実行権がない、を含む）ときは、
//   TOURYOU_NODE_TOKEN と TOURYOU_DAEMON_URL の**両方**があるときだけ、終了コード 2（モデルに、理由が伝わる）。なければ、素通し（0。標準エラーに一言）。
//   止めない版（PostToolUse・Stop）は、どの場合も 0（Stop の終了コード 2 は、Claude が止まるのを妨げるため）。
//   環境変数が空文字のときは、未設定と同じ扱い（`-n`）。片方だけも、素通し。
// - メッセージに、単一引用符・ドル記号・バッククォートは入れない（シェルの文字列が壊れないように）。

const H = "${HOME:-}";
const C = 'c="${HOME:-}/.touryou/current/bin/touryou"; ';
const BOTH = 'if [ -n "${TOURYOU_NODE_TOKEN:-}" ] && [ -n "${TOURYOU_DAEMON_URL:-}" ]; then ';

// `exec` は使わない: 壊れた（+x だが実行できない）`touryou` を `exec` すると、非対話の POSIX シェルは、シェルごと終了し（終了コード 126・127）、
// 後ろの分岐に届かない。終了コード 126・127 は、Claude Code では「ブロックしないエラー」なので、PreToolUse が素通し（フェイルオープン）になる。
// そこで、`"$c" hook` を普通に実行し、終了コード `r` で分岐する（標準入力は、そのまま引き継がれる）。

/**
 * PreToolUse: 拒否版。`touryou hook` の終了コードが 0 または 2 なら、それをそのまま返す。
 * それ以外（126・127・137 など。壊れた `touryou`・アーキテクチャ違い・壊れた shebang・同梱の node が動かない・シグナルで終了）は、
 * 「`touryou` がない」と同じに扱う: 子の環境変数が両方あれば 2（拒否）、なければ素通し（0。一言）。
 */
export const HOOK_COMMAND_GUARD = `${C}if [ -n "${H}" ] && [ -x "$c" ]; then "$c" hook; r=$?; case "$r" in 0|2) exit "$r";; esac; fi; ${BOTH}echo "[touryou hook] 拒否: touryou が見つからない、または動かない（/touryou:setup を実行する）" >&2; exit 2; fi; echo "[touryou hook] touryou が未配置、または動かないため、フックは働いていない（touryou の子でなければ、問題ない）" >&2; exit 0`;

/** PostToolUse・Stop: 止めない版。`touryou hook` を実行して、どの終了コードでも 0 を返す（Stop の終了コード 2 は、Claude が止まるのを妨げる）。 */
export const HOOK_COMMAND_PASSIVE = `${C}if [ -n "${H}" ] && [ -x "$c" ]; then "$c" hook; exit 0; fi; echo "[touryou hook] touryou が未配置のため、フックは働いていない（touryou の子でなければ、問題ない）" >&2; exit 0`;

/**
 * SessionStart: 本体（current の版）と plugin の版が食い違えば、知らせるだけ（plugin/scripts/runtime-version-notice.sh）。
 * 取得・daemon の起動し直しはしない。`CLAUDE_PLUGIN_ROOT` がない・script がない・失敗したときも、終了コード 0（セッションを止めない）。
 */
export const HOOK_COMMAND_SESSION_START =
  's="${CLAUDE_PLUGIN_ROOT:-}/scripts/runtime-version-notice.sh"; if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$s" ]; then sh "$s" 2>/dev/null; fi; exit 0';

/** イベントごとの command。 */
export const HOOK_COMMANDS = {
  PreToolUse: HOOK_COMMAND_GUARD,
  PostToolUse: HOOK_COMMAND_PASSIVE,
  Stop: HOOK_COMMAND_PASSIVE,
  // 入力待ちの報告。止められないフックなので、止めない版
  Notification: HOOK_COMMAND_PASSIVE,
  // 版の食い違いを知らせるだけ（仮の登録などはしない）
  SessionStart: HOOK_COMMAND_SESSION_START,
};
