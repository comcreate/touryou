/**
 * 親への起動の依頼の文（設計 6.2）。親の skill が、そのまま Bash で実行できる、変数のないコマンドの文を作る。
 *
 * - 形: `(cd <作業ツリー> && claude --bg <指示> --name <名前> [--model <モデル>] [--effort <深さ>] --permission-mode dontAsk --settings '<JSON>')`
 *   全体を `( )` で囲む（サブシェル）。囲まないと、`cd` が親（統合）のセッションの Bash の cwd に残る（Claude Code は、作業ディレクトリの中への
 *   `cd` を次の呼び出しへ引き継ぐ）。作業ツリーが親のリポジトリの中（`<repoRoot>/.touryou/worktrees`）にあると、親が子の作業ツリーの中にいる扱いになり、
 *   フックが、紐付けのない親の道具（`parent_report`・`inbox_fetch`・Bash）を拒否してしまう。
 *   plugin の場所が分かれば、`--permission-mode` の前に `--plugin-dir '<場所>'` を足す。
 *   JSON は `{"crossSessionInbound":"accept","permissions":{"allow":[...],"deny":[...]}}`。allow・deny は `childAllowList`が範囲から作る。
 *   フォークのときは、後ろに `--resume <親の id> --fork-session` を足す。
 * - 値は、どれもシェルの 1 語に引用する（`shellWord`）。変数・置換は使わない（`$` などは単一引用符の中に閉じる）。
 * - **紐付けのコードは入れない**（`ps`・シェルの履歴・会話の記録に出さないため）。子の mcp が、作業ツリーの git のディレクトリの
 *   `touryou-bind-code` から読む。指示の文は、`child_bind` を引数なしで呼ぶことと、受信箱の手順に従うことだけ。
 */

import { shellWord } from "../api/handlers/bind-handlers.js";

/** 子の最初の番の指示（これだけ。コード・ID・ブリーフは入れない。ブリーフは受信箱で読む）。 */
export const CHILD_LAUNCH_INSTRUCTION =
  "最初に touryou の child_bind を引数なしで呼んで、受信箱の手順に従って";

/** サブ統括（role が integrator）の最初の番の指示。integrator の skill に従うよう指す（設計 .sdd/task/168/design.md §3）。 */
export const INTEGRATOR_LAUNCH_INSTRUCTION =
  "touryou の integrator の skill に従って、最初に child_bind を引数なしで呼んで";

/** ノードのロールに合う起動の指示。integrator だけ書き分け、それ以外（implement・investigate など）は子の文のまま。 */
export const launchInstructionOf = (role: string | undefined): string =>
  role === "integrator" ? INTEGRATOR_LAUNCH_INSTRUCTION : CHILD_LAUNCH_INSTRUCTION;

/** 子の設定（知らせを止めない）と、許可の一覧。 */
export const childLaunchSettings = (p: {
  allow: readonly string[];
  deny: readonly string[];
}): string =>
  JSON.stringify({
    crossSessionInbound: "accept",
    permissions: { allow: [...p.allow], deny: [...p.deny] },
  });

/** `--effort` に渡せる値。 */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** モデルの名前（`claude-opus-5-5`・`opus`・`claude-opus-5[1m]` など）。英数字で始まり、英数字と `.` `_` `-` `[` `]` だけ、64 文字以下。 */
export const isModelName = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/.test(x);

export const isEffort = (x: unknown): x is Effort =>
  typeof x === "string" && (EFFORTS as readonly string[]).includes(x);

export interface LaunchCommandInput {
  /** 作業ツリー（実パス・絶対）。 */
  readonly worktree: string;
  /** 子のセッションの名前（ノードの ID）。 */
  readonly name: string;
  /** ノードのロール。integrator なら指示の文が integrator の skill を指す。省くと子の文。 */
  readonly role?: string | undefined;
  readonly model?: string;
  readonly effort?: string;
  /** フォークするときの親のセッションの参照。 */
  readonly forkSessionRef?: string;
  /** 子に付ける plugin の場所（`checkPluginDir` を通ったもの）。あれば `--plugin-dir` を足す。 */
  readonly pluginDir?: string;
  /** 子の permissions の allow・deny（`childAllowList` の結果）。 */
  readonly permissions: { readonly allow: readonly string[]; readonly deny: readonly string[] };
}

export function buildLaunchCommand(input: LaunchCommandInput): string {
  const parts = [
    "(cd",
    shellWord(input.worktree),
    "&&",
    "claude",
    "--bg",
    shellWord(launchInstructionOf(input.role)),
    "--name",
    shellWord(input.name),
    ...(input.model === undefined ? [] : ["--model", shellWord(input.model)]),
    ...(input.effort === undefined ? [] : ["--effort", shellWord(input.effort)]),
    ...(input.pluginDir === undefined ? [] : ["--plugin-dir", shellWord(input.pluginDir)]),
    "--permission-mode",
    "dontAsk",
    "--settings",
    shellWord(childLaunchSettings(input.permissions)),
    ...(input.forkSessionRef === undefined
      ? []
      : ["--resume", shellWord(input.forkSessionRef), "--fork-session"]),
  ];
  return `${parts.join(" ")})`;
}
