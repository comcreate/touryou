/**
 * daemon が書く受信箱の知らせの文（#140）。種類（鍵）と値で記録し、画面が言語（日本語・英語）を選んで文にする。
 *
 * - 文は `{名前}` の差し込みだけを持つ（関数・HTML は持たない）。画面は、差し込んだ文を `textContent` で入れる。
 * - daemon は `inboxMessage(key, args)` で書く。日本語の `summary`（統合・子・MCP・CLI が読む。これまでと同じ文）と、
 *   画面のための `msg`（鍵と値）を、両方作る。`summary` は残す（文の形で見分ける所〔`isStallSummary`〕も、そのまま効く）。
 * - `msg` のない項目（古い記録・子や統合が書いた文）は、画面が `summary` をそのまま出す（利用者の決め）。
 * - 値に入るのは、ノード ID・数・短い符号・daemon のほかの文（失敗の文など。利用者の決めで、今回は日本語のまま）。
 *   値の名前が `node` のものは、画面がノードの題に置き換えてよい。
 */

/** 言語。 */
export const LANGS = ["ja", "en"] as const;
export type Lang = (typeof LANGS)[number];

/** 知らせの文の表。鍵は小文字で始まる英数字。ja は、これまでの summary と同じ文にする。 */
export const INBOX_MESSAGES = {
  stall: {
    ja: "子 {node} は止まっているかもしれない（{minutes} 分、報告も道具の使用の記録もない）。親は claude agents --json で状態を確かめて parent_report の agentState で報告するか、人に attach を頼む",
    en: "Child {node} may be stuck ({minutes} min with no report and no tool use). The parent checks with claude agents --json and reports agentState with parent_report, or asks a person to attach",
  },
  stopConfirmed: {
    ja: "停止を確認した（{outcome}）",
    en: "Stop confirmed ({outcome})",
  },
  stopDeclaredHuman: {
    ja: "停止の宣言を記録した（宣言者: 人間）",
    en: "Recorded the stop declaration (by: a person)",
  },
  stopDeclaredHumanNote: {
    ja: "停止の宣言を記録した（宣言者: 人間。根拠: {note}）",
    en: "Recorded the stop declaration (by: a person. Reason: {note})",
  },
  stopDeclaredNode: {
    ja: "停止の宣言を記録した（宣言者: 統合ノード {by}）",
    en: "Recorded the stop declaration (by: integrator {by})",
  },
  stopDeclaredNodeNote: {
    ja: "停止の宣言を記録した（宣言者: 統合ノード {by}。根拠: {note}）",
    en: "Recorded the stop declaration (by: integrator {by}. Reason: {note})",
  },
  stopIncomplete: {
    ja: "停止未完了: 残っているプロセス {processes}",
    en: "Stop not complete: processes still running {processes}",
  },
  stopIncompletePids: {
    ja: "停止未完了: 残っているプロセス pid {pids}",
    en: "Stop not complete: processes still running pid {pids}",
  },
  stopFailed: {
    ja: "停止に失敗: {cause}",
    en: "Stop failed: {cause}",
  },
  stopDelegated: {
    ja: "親に claude stop を依頼した: parent_request で文を受け取り、Bash で実行して parent_report で報告する（daemon が作業ツリーのプロセスを確かめてから stopped にする）。対象ノード: {node}",
    en: "Asked the parent to run claude stop: get the command with parent_request, run it in Bash, and report with parent_report (the daemon marks it stopped after checking the worktree's processes). Target node: {node}",
  },
  rejectNoSubscription: {
    ja: "子 {node} は差し戻したが、いま購読がないので、指示がすぐには届かない。子のセッションが動いているか確かめる",
    en: "Child {node} was sent back, but it has no subscription right now, so the instruction will not arrive soon. Check that the child's session is running",
  },
  doneReport: {
    ja: "完了報告（根拠 {count} 件）",
    en: "Done report ({count} pieces of evidence)",
  },
  extensionRequested: {
    ja: "範囲の拡張要求（{kind}）: {value}",
    en: "Scope request ({kind}): {value}",
  },
  extensionUpdateFailed: {
    ja: "範囲の拡張 {extension} を承認したが、アダプタの範囲を更新できなかった",
    en: "Scope request {extension} was approved, but the adapter's scope could not be updated",
  },
  integrated: {
    ja: "子 {node} のブランチを、親のブランチ {target} へ fast-forward で統合した（先端 {tip}）",
    en: "Fast-forwarded child {node}'s branch into the parent branch {target} (tip {tip})",
  },
  confirmRequired: {
    ja: "取り消せない操作（{op}）の確認待ちがある。画面のいちばん上の欄で、daemon を起動した端末に出たコードを打つ（5 分で消える。daemon を再起動しても消える）",
    en: "An irreversible operation ({op}) is waiting for confirmation. Type the code shown in the terminal that started the daemon into the top box on this screen (it expires in 5 minutes, or when the daemon restarts)",
  },
  watchCapped: {
    ja: "子 {node} の見張りの知らせが多すぎる（24 時間に {cap} 件）ので、しばらく出すのを止めた。子の状態を確かめる",
    en: "Too many watch notices for child {node} ({cap} in 24 hours), so they are paused for a while. Check the child's state",
  },
  unreadInstruction: {
    ja: "子 {node} が、指示（番号 {seq}）を {minutes} 分たっても受け取っていない。子が動いているか確かめる",
    en: "Child {node} has not picked up instruction #{seq} after {minutes} min. Check that the child is running",
  },
  unbound: {
    ja: "子 {node} が紐付けていない（起動の報告から {minutes} 分）。touryou の plugin が、子の設定の置き場に入っていない見込み。--plugin-dir で開いた親の子には plugin が付かない。plugin を設定の置き場に入れて（/touryou:setup）、子を起動し直す",
    en: "Child {node} has not bound itself ({minutes} min since the launch report). The touryou plugin is probably missing from the child's settings. Children of a parent opened with --plugin-dir do not get the plugin. Install the plugin into the settings (/touryou:setup) and restart the child",
  },
  rebind: {
    ja: "子 {node} の紐付けをやり直して（コードが無効。daemon の再起動・期限切れなど）。node_bindCode でコードを出し直し、子に child_bind を引数なしでもう一度呼ばせる",
    en: "Redo the binding for child {node} (the code is no longer valid, for example after a daemon restart or expiry). Issue a new code with node_bindCode and have the child call child_bind again with no arguments",
  },
  hookNotSeen: {
    ja: "子 {node} が始まってから {minutes} 分たっても、見張り（フック）が 1 度も通っていない。Desktop で daemon の作業ツリーを「ローカル」で始めたかを確かめる（チップや「ワークツリー」で始めた子には、見張りが効かず、報告もできない）",
    en: 'Child {node} started {minutes} min ago, but the watch (hook) has not run even once. Check that the daemon\'s worktree was started as "Local" in Desktop (children started from a chip or as "Worktree" are not watched and cannot report)',
  },
  configDirLearned: {
    ja: "子 {node} の Claude Code の設定の場所が、守る集合の外だった（CLAUDE_CONFIG_DIR が daemon と違う）。守る集合に足した。起動時から守るには、daemon の設定 claudeConfigDirs に書く",
    en: "Child {node}'s Claude Code settings folder was outside the protected set (its CLAUDE_CONFIG_DIR differs from the daemon's). It was added. To protect it from startup, list it in the daemon setting claudeConfigDirs",
  },
  hookSettingsHome: {
    ja: "子 {node} の見張りが外されうる状態になった（{detail}。人が設定を変えた場合も同じ扱い）。子のトークンを失効させた。子を止めるか、node.bindCode を出し直すかを決める",
    en: "Child {node}'s watch could be removed ({detail}; a person changing the settings is treated the same). The child's token was revoked. Decide whether to stop the child or issue node.bindCode again",
  },
  hookSettingsTampered: {
    ja: "子 {node} の見張り（フック）が外された（{detail}）。設定を書き戻し、子のトークンを失効させた。子を止めるか、node.bindCode を出し直すかを決める",
    en: "Child {node}'s watch (hook) was removed ({detail}). The settings were restored and the child's token was revoked. Decide whether to stop the child or issue node.bindCode again",
  },
  tokenExpiredAbsoluteBind: {
    ja: "子 {node} のトークンの期限が切れた（発行から時間がたった）。node.bindCode で紐付けのコードを出し直し、子が結び直す",
    en: "Child {node}'s token expired (too long since it was issued). Issue a new binding code with node.bindCode and have the child bind again",
  },
  tokenExpiredIdleBind: {
    ja: "子 {node} のトークンの期限が切れた（使わなかった時間が長い）。node.bindCode で紐付けのコードを出し直し、子が結び直す",
    en: "Child {node}'s token expired (unused for too long). Issue a new binding code with node.bindCode and have the child bind again",
  },
  tokenExpiredAbsolute: {
    ja: "子 {node} のトークンの期限が切れた（発行から時間がたった）。子を再開するか、作り直す",
    en: "Child {node}'s token expired (too long since it was issued). Resume the child or create it again",
  },
  tokenExpiredIdle: {
    ja: "子 {node} のトークンの期限が切れた（使わなかった時間が長い）。子を再開するか、作り直す",
    en: "Child {node}'s token expired (unused for too long). Resume the child or create it again",
  },
  restartStopCheck: {
    ja: "daemon の再起動で、停止の猶予の調べが途中で終わった。親に claude stop を依頼した: parent_request で文を受け取り、Bash で実行して parent_report で報告する（daemon が作業ツリーのプロセスを確かめてから stopped にする）。対象ノード: {node}",
    en: "A daemon restart cut short the check during the stop grace period. Asked the parent to run claude stop: get the command with parent_request, run it in Bash, and report with parent_report (the daemon marks it stopped after checking the worktree's processes). Target node: {node}",
  },
  violation: {
    ja: "範囲違反（フックが拒んだ・{reason}）: {subject}",
    en: "Scope violation (blocked by the hook, {reason}): {subject}",
  },
  violationOverflow: {
    ja: "ほかにも範囲違反がある（どれもフックが拒んだ。受信箱には、これ以上出さない。記録を確認する）",
    en: "There are more scope violations (all blocked by the hook). No more will be added to the inbox; check the log",
  },
  launchRequest: {
    ja: "子 {node} の起動の依頼。parent_request（nodeId: {node}）で実行する文を受け取り、Bash でそのまま実行して、parent_report で結果を報告する",
    en: "Request to launch child {node}. Get the command with parent_request (nodeId: {node}), run it as is in Bash, and report the result with parent_report",
  },
  removeDiscarded: {
    ja: "子 {node} のセッションの削除の依頼（人間が破棄を決めたので、未 push の成果を捨てる旗つき）。parent_request（nodeId: {node}）で文を受け取り、Bash でそのまま実行して、parent_report で報告する",
    en: "Request to remove child {node}'s session (a person chose to discard it, so the flag to drop unpushed work is set). Get the command with parent_request (nodeId: {node}), run it as is in Bash, and report with parent_report",
  },
  acceptedPendingRequest: {
    ja: "子 {node} は受理したが、まだ報告のない親への依頼があるので、裏のセッションの停止の依頼をまだ出していない。その依頼を片付けたあとに node_stop（nodeId: {node}）を呼ぶと、停止の依頼が出る",
    en: "Child {node} was accepted, but a request to the parent has not been reported yet, so the request to stop its background session has not been sent. After that request is done, call node_stop (nodeId: {node}) to send it",
  },
  acceptedStopRequest: {
    ja: "子 {node} は受理した。裏のセッションの停止の依頼。parent_request（nodeId: {node}）で文を受け取り、Bash でそのまま実行して、parent_report で報告する（止めたのを確かめたら、続けて削除を依頼する）",
    en: "Child {node} was accepted. Request to stop its background session: get the command with parent_request (nodeId: {node}), run it as is in Bash, and report with parent_report (once the stop is confirmed, a removal request follows)",
  },
  pluginNotAttached: {
    ja: "子 {node} に plugin を付けられなかった（{reason}）。子は、利用者の設定で入っている plugin だけで動く。子の道具やフックが無ければ、/touryou:setup の案内で plugin を入れ直す",
    en: "Could not attach the plugin to child {node} ({reason}). The child runs only with the plugins in the user's settings. If the child's tools or hooks are missing, reinstall the plugin following /touryou:setup",
  },
  recreatedStop: {
    ja: "子 {node} のセッションの停止の依頼（親が調べた id で作り直した）。parent_request（nodeId: {node}）で文を受け取り、Bash でそのまま実行して、parent_report で報告する",
    en: "Request to stop child {node}'s session (recreated with the id the parent looked up). Get the command with parent_request (nodeId: {node}), run it as is in Bash, and report with parent_report",
  },
  recreatedRemove: {
    ja: "子 {node} のセッションの削除の依頼（親が調べた id で作り直した）。parent_request（nodeId: {node}）で文を受け取り、Bash でそのまま実行して、parent_report で報告する",
    en: "Request to remove child {node}'s session (recreated with the id the parent looked up). Get the command with parent_request (nodeId: {node}), run it as is in Bash, and report with parent_report",
  },
  stopVerified: {
    ja: "子 {node} の停止を確かめた（作業ツリーのプロセスはない）",
    en: "Confirmed child {node} has stopped (no processes in the worktree)",
  },
  removeRequest: {
    ja: "子 {node} のセッションの削除の依頼。parent_request（nodeId: {node}）で文を受け取り、Bash でそのまま実行して、parent_report で報告する",
    en: "Request to remove child {node}'s session. Get the command with parent_request (nodeId: {node}), run it as is in Bash, and report with parent_report",
  },
  sessionRemoved: {
    ja: "子 {node} のセッションを削除した（claude rm）",
    en: "Removed child {node}'s session (claude rm)",
  },
  gitDirUnknown: {
    ja: "子 {node} の作業ツリーの git のディレクトリを確かめられないため、書き込みを拒否している。人が作業ツリー（git worktree）を確かめる",
    en: "Writes are refused because the git folder of child {node}'s worktree cannot be checked. A person should check the worktree (git worktree)",
  },
} as const satisfies Readonly<Record<string, { readonly ja: string; readonly en: string }>>;

export type InboxMessageKey = keyof typeof INBOX_MESSAGES;

/** 知らせの値（名前 → 文字か数）。 */
export type InboxMessageArgs = Readonly<Record<string, string | number>>;

/** 受信箱の項目に付ける、画面のための知らせ（鍵と値）。 */
export interface InboxMessage {
  readonly key: string;
  readonly args: InboxMessageArgs;
}

/** 値の数・名前・長さの上限（記録の検査と同じ）。 */
export const INBOX_MESSAGE_LIMITS = { args: 8, name: 32, value: 200, key: 64 } as const;
const NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
const KEY = /^[a-z][A-Za-z0-9]{0,63}$/;

/** 制御文字（改行・タブを含む C0 と DEL）。 */
const isControl = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return n < 0x20 || n === 0x7f;
};
const hasControl = (s: string): boolean => [...s].some(isControl);

/** 鍵が表にあるか（古い daemon・新しい daemon の記録で、知らない鍵が来ることがある）。 */
export const isInboxMessageKey = (k: unknown): k is InboxMessageKey =>
  typeof k === "string" && Object.hasOwn(INBOX_MESSAGES, k);

/** 記録に載せてよい形か（鍵は形だけを見る。知らない鍵は、画面が summary を出す）。 */
export function isInboxMessage(x: unknown): x is InboxMessage {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const m = x as Record<string, unknown>;
  if (Object.keys(m).some((k) => k !== "key" && k !== "args")) return false;
  if (typeof m.key !== "string" || !KEY.test(m.key)) return false;
  const a = m.args;
  if (typeof a !== "object" || a === null || Array.isArray(a)) return false;
  const entries = Object.entries(a as Record<string, unknown>);
  if (entries.length > INBOX_MESSAGE_LIMITS.args) return false;
  return entries.every(
    ([k, v]) =>
      NAME.test(k) &&
      (typeof v === "number"
        ? Number.isFinite(v)
        : typeof v === "string" &&
          v.length <= INBOX_MESSAGE_LIMITS.value &&
          // 制御文字（改行を含む）は入れない
          !hasControl(v)),
  );
}

/** `{名前}` を値で置き換える（無い名前は、そのまま残す）。 */
export function fillMessage(template: string, args: InboxMessageArgs): string {
  return template.replace(/\{([a-z][A-Za-z0-9]*)\}/g, (all, name: string) =>
    Object.hasOwn(args, name) ? String(args[name]) : all,
  );
}

/** 言語ごとの文。鍵が表になければ undefined。 */
export function inboxMessageText(lang: Lang, m: InboxMessage): string | undefined {
  if (!isInboxMessageKey(m.key)) return undefined;
  return fillMessage(INBOX_MESSAGES[m.key][lang], m.args);
}

/** 文の中の `{名前}` の一覧（並べ替えて、重なりを除く）。 */
export const placeholdersOf = (template: string): readonly string[] =>
  [
    ...new Set([...template.matchAll(/\{([a-z][A-Za-z0-9]*)\}/g)].map((x) => x[1] as string)),
  ].sort();

/**
 * daemon が知らせを書くときの入口。日本語の `summary` と、画面のための `msg` を作る。
 * 値は、長すぎれば切る（記録の検査に通る形にする）。
 */
export function inboxMessage<K extends InboxMessageKey>(
  key: K,
  args: InboxMessageArgs,
): { readonly summary: string; readonly msg: InboxMessage } {
  const safe: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(args)) {
    safe[k] =
      typeof v === "number"
        ? v
        : [...v]
            .map((c) => (isControl(c) ? " " : c))
            .join("")
            .slice(0, INBOX_MESSAGE_LIMITS.value);
  }
  return { summary: fillMessage(INBOX_MESSAGES[key].ja, safe), msg: { key, args: safe } };
}
