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
    ja: "子 {node} が紐付けていない（起動から {minutes} 分）。原因の候補: (1) 接続先違い（--config・TOURYOU_DAEMON_CONFIG を確かめる）(2) plugin 欠落（--plugin-dir の親の子には付かない。/touryou:setup）(3) コード期限切れ（node_bindCode で出し直す）",
    en: "Child {node} has not bound itself ({minutes} min since launch). Likely causes: (1) wrong daemon (check --config and TOURYOU_DAEMON_CONFIG) (2) missing plugin (children of a --plugin-dir parent do not get it; run /touryou:setup) (3) expired code (reissue with node_bindCode)",
  },
  rebind: {
    ja: "子 {node} の紐付けをやり直して（コードが無効。daemon の再起動・期限切れなど）。node_bindCode でコードを出し直し、子に child_bind を引数なしでもう一度呼ばせる",
    en: "Redo the binding for child {node} (the code is no longer valid, for example after a daemon restart or expiry). Issue a new code with node_bindCode and have the child call child_bind again with no arguments",
  },
  bindLostSuspect: {
    ja: "子 {node} の紐付けが外れているかも。いまの状態: トークンは有効だが、{minutes} 分、知らせを受け取る接続がない。次にすること: node_send で「touryou の child_bind を引数なしで呼んで」と送る（「期限が切れた」知らせも出ていれば、先に node_bindCode）",
    en: 'Child {node} may be unbound. State: token valid, but no notice connection for {minutes} min. Next: node_send "call touryou\'s child_bind with no arguments" (if a "token expired" notice is also open, node_bindCode first)',
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
    ja: "子 {node} のトークンの期限が切れた（発行から時間がたった）。node_bindCode で紐付けのコードを出し直し、子が結び直す。期限は設定 tokenExpiryMinutes.bindAbsolute（分。既定 1440。docs/config.md）で変えられる",
    en: "Child {node}'s token expired (too long since it was issued). Issue a new binding code with node_bindCode and have the child bind again. The limit can be changed with the setting tokenExpiryMinutes.bindAbsolute (minutes; default 1440; see docs/config.md)",
  },
  tokenExpiredIdleBind: {
    ja: "子 {node} のトークンの期限が切れた（使わなかった時間が長い）。node_bindCode で紐付けのコードを出し直し、子が結び直す。使わなければ切れる期限は設定 tokenExpiryMinutes.bindIdle（分。既定 60。docs/config.md）で変えられる",
    en: "Child {node}'s token expired (unused for too long). Issue a new binding code with node_bindCode and have the child bind again. The unused-time limit can be changed with the setting tokenExpiryMinutes.bindIdle (minutes; default 60; see docs/config.md)",
  },
  tokenIdleSoonBind: {
    ja: "子 {node} のトークンが、使われないまま、もうすぐ（約 {minutes} 分後）切れる。子が、この知らせを読んだあとに touryou の道具を 1 つ（inbox_fetch など）呼べば延びる（この知らせを読む呼び出しそのものは、数えない）。切れたら node_bindCode で紐付けを出し直す。使わなければ切れる期限は設定 tokenExpiryMinutes.bindIdle（分。既定 60。docs/config.md）で変えられる",
    en: "Child {node}'s token will expire in about {minutes} min if it stays unused. It is extended when the child calls any touryou tool (such as inbox_fetch) after reading this notice (the call that reads the notice does not count). If it expires, issue a new binding with node_bindCode. The unused-time limit can be changed with the setting tokenExpiryMinutes.bindIdle (minutes; default 60; see docs/config.md)",
  },
  // 子への追加指示の文（画面には出さない。子が読む）。日本語・英語を並べて渡す（daemon の `idleSoonInstruction`）
  tokenIdleSoonChild: {
    ja: "紐付けの期限が、使われないまま約 {minutes} 分で切れる。この知らせを読んだあとに、touryou の道具を 1 つ（inbox_fetch など）呼べば延びる（この知らせを読む呼び出しそのものは、数えない）。",
    en: "Your binding expires in about {minutes} min if it stays unused. Call any touryou tool (such as inbox_fetch) after reading this notice to extend it (the call that reads this notice does not count).",
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
  removeRefused: {
    ja: "子 {node} のセッションの削除（claude rm）を拒まれた。消していない: {reason}。成果を捨てるかは人間が決める（破棄を決めたあとに、もう一度削除を依頼する）",
    en: "Removing child {node}'s session (claude rm) was refused. Nothing was removed: {reason}. A person decides whether to discard the work (after deciding to discard, request the removal again)",
  },
  removeRefusedNoReason: {
    ja: "子 {node} のセッションの削除（claude rm）を拒まれた。消していない: 理由の記載なし。成果を捨てるかは人間が決める（破棄を決めたあとに、もう一度削除を依頼する）",
    en: "Removing child {node}'s session (claude rm) was refused. Nothing was removed (no reason given). A person decides whether to discard the work (after deciding to discard, request the removal again)",
  },
  parentFailed: {
    ja: "子 {node} の依頼（{kind}）を、親が実行できなかった: {reason}",
    en: "The parent could not carry out the request ({kind}) for child {node}: {reason}",
  },
  parentFailedNoReason: {
    ja: "子 {node} の依頼（{kind}）を、親が実行できなかった: 理由の記載なし",
    en: "The parent could not carry out the request ({kind}) for child {node} (no reason given)",
  },
  sessionStopped: {
    ja: "受理した子 {node} の裏のセッションを止めた（作業ツリーのプロセスはない）",
    en: "Stopped the background session of accepted child {node} (no processes in the worktree)",
  },
  stopUnverifiable: {
    ja: "子 {node} は親が止めたと報告したが、作業ツリーのプロセスを確かめられない。確かめてから node_confirmStopped で宣言する",
    en: "The parent reported child {node} as stopped, but the worktree's processes cannot be checked. Check them, then declare with node_confirmStopped",
  },
  stopProcessesLeft: {
    ja: "子 {node} は親が止めたと報告したが、作業ツリーを使うプロセスが残っている（pid {pids}）。止めてから node_stop で再試行する",
    en: "The parent reported child {node} as stopped, but processes still use the worktree (pid {pids}). Stop them, then retry with node_stop",
  },
  stopReportedState: {
    ja: "子 {node} は親が止めたと報告した（状態 {state} のため、記録は変えない）",
    en: "The parent reported child {node} as stopped (its state is {state}, so the record is not changed)",
  },
  stopReportedUnknownState: {
    ja: "子 {node} は親が止めたと報告した（状態 不明 のため、記録は変えない）",
    en: "The parent reported child {node} as stopped (its state is unknown, so the record is not changed)",
  },
  sessionGone: {
    ja: "子 {node} のセッションは、もう一覧になかった（止めた時点で消えていた）。削除の依頼は済んだ扱いにした",
    en: "Child {node}'s session was no longer listed (it was gone once stopped). The removal request is treated as done",
  },
  agentStalled: {
    ja: "子 {node} は止まっているかもしれない（親の確かめ: {state}）。人に、子のセッションへの attach を頼む",
    en: "Child {node} may be stuck (the parent checked: {state}). Ask a person to attach to the child's session",
  },
  needsInputOverflow: {
    ja: "子 {node} の入力待ちの知らせが多すぎる（1 日 {max} 件）ので、今日はこれ以上出さない。人が子のセッションを確かめる",
    en: "Too many input-waiting notices for child {node} ({max} a day), so no more will be shown today. A person should check the child's session",
  },
  needsInputMaybe: {
    ja: "子 {node} が止まっているかもしれない（{label}。session_id で引いた報告）。人が子のセッションを開いて（attach）確かめる",
    en: "Child {node} may be stuck ({label}; reported by session_id). A person should open (attach to) the child's session and check",
  },
  needsInput: {
    ja: "子 {node} が止まっている（{label}）。人が子のセッションを開いて（attach）応える",
    en: "Child {node} is stuck ({label}). A person should open (attach to) the child's session and respond",
  },
  needsInputDetail: {
    ja: "子 {node} が止まっている（{label}: {detail}）。人が子のセッションを開いて（attach）応える",
    en: "Child {node} is stuck ({label}: {detail}). A person should open (attach to) the child's session and respond",
  },
  labelPermissionPrompt: { ja: "許可の確認", en: "permission prompt" },
  labelIdlePrompt: {
    ja: "入力待ち（応答のあと操作がない）",
    en: "waiting for input (no action after the reply)",
  },
  labelElicitationDialog: { ja: "MCP の入力の画面", en: "MCP input dialog" },
  labelElicitationUrlDialog: {
    ja: "MCP のブラウザでの確認",
    en: "MCP confirmation in the browser",
  },
  labelAgentNeedsInput: { ja: "入力待ち", en: "waiting for input" },
  unstartableNoBrief: {
    ja: "依存が揃ったが、起動できない: ブリーフ（目的・受け入れ基準・範囲）が記録されていない",
    en: "Dependencies are ready, but the node cannot start: no brief (objective, acceptance criteria, scope) is recorded",
  },
  unstartableNoAdapter: {
    ja: "依存が揃ったが、起動できない: 親 {parent} のランタイム（アダプタ）が見つからない",
    en: "Dependencies are ready, but the node cannot start: the runtime (adapter) of parent {parent} was not found",
  },
  unstartableNoWorktree: {
    ja: "依存が揃ったが、起動できない: 作業ツリーを用意できない",
    en: "Dependencies are ready, but the node cannot start: the worktree cannot be prepared",
  },
  startFailed: {
    ja: "依存が揃ったので起動しようとしたが、失敗した（{code}）: {cause}。対処: {next}",
    en: "Dependencies were ready, so the node tried to start, but it failed ({code}): {cause}. Next step: {next}",
  },
  dependencyDiscarded: {
    ja: "依存先 {dep} が破棄されたため、このノードは起動できない。node.stop で取り消すか、別の依存先で作り直す",
    en: "Dependency {dep} was discarded, so this node cannot start. Cancel it with node.stop or create it again with a different dependency",
  },
  resumeFailed: {
    ja: "子 {node} を再開できなかった（{code}）: {cause}。対処: {next}",
    en: "Could not resume child {node} ({code}): {cause}. Next step: {next}",
  },
  autoPurgeNotice: {
    ja: "木 {node} を {date} 以降に自動で削除する。止めるには touryou purge-hold {node}（人間のコマンド。期限は --until）",
    en: "Tree {node} will be deleted automatically on or after {date}. To stop this, run touryou purge-hold {node} (a human command; set a deadline with --until)",
  },
  autoPurgeNoticeOpen: {
    ja: "木 {node} を {date} 以降に自動で削除する（未回答の判断 {decisions}・未解決の項目 {items}）。止めるには touryou purge-hold {node}（人間のコマンド。期限は --until）",
    en: "Tree {node} will be deleted automatically on or after {date} ({decisions} unanswered decisions, {items} open items). To stop this, run touryou purge-hold {node} (a human command; set a deadline with --until)",
  },
  // ── daemon の再起動のあとの照合: Desktop の子を人に確かめてもらう依頼（先頭は external-check.ts の EXTERNAL_CHECK_SUMMARY と同じ）
  externalCheck: {
    ja: "daemon 再起動後: 子は止まったと決めつけず、Desktop で子ごとに確かめ、アーカイブし、止まりを確かめて宣言（desktop-runtime.md）（{count} 件: {nodes}）",
    en: "After a daemon restart: do not assume the children stopped. Check each child in Desktop, archive it, confirm it stopped, then declare it (desktop-runtime.md) ({count}: {nodes})",
  },
  externalCheckMore: {
    ja: "daemon 再起動後: 子は止まったと決めつけず、Desktop で子ごとに確かめ、アーカイブし、止まりを確かめて宣言（desktop-runtime.md）（{count} 件: {nodes} ほか {more} 件）",
    en: "After a daemon restart: do not assume the children stopped. Check each child in Desktop, archive it, confirm it stopped, then declare it (desktop-runtime.md) ({count}: {nodes} and {more} more)",
  },
  // ── 並べる部分の項目（#140。文は値と区切りだけのこともある）
  value: { ja: "{value}", en: "{value}" },
  count: { ja: "{label} {n}", en: "{n} {label}" },
  nameCount: { ja: "{name} {n}", en: "{name} {n}" },
  // ── 判断の回答で再開しなかった子
  resumeSkipped: {
    ja: "判断 {decision} の回答で、再開しなかった子: {children}",
    en: "Children not resumed after the answer to decision {decision}: {children}",
  },
  resumeSkippedChild: { ja: "{node}（{reason}）", en: "{node} ({reason})" },
  notResumedDiscarded: { ja: "破棄の判断を経たため", en: "a discard decision was made" },
  notResumedStoppedAfterStopIncomplete: {
    ja: "停止未完了のあと止め直したため。新しい子でやり直す",
    en: "it was stopped again after an incomplete stop. Retry with a new child",
  },
  notResumedStoppedByOther: {
    ja: "判断のほかに止められたため",
    en: "it was stopped for a reason other than the decision",
  },
  // ── 中間統合ノードの配下の要約（digest）
  digestHead: {
    ja: "配下 {descendants}（{states}）。未解決: {unresolved}{tail}",
    en: "{descendants} below ({states}). Open: {unresolved}{tail}",
  },
  digestHeadNoStates: {
    ja: "配下 {descendants}。未解決: {unresolved}{tail}",
    en: "{descendants} below. Open: {unresolved}{tail}",
  },
  digestOpen: {
    ja: "。未回答の判断 {decisions}・未判定の拡張要求 {extensions}",
    en: ". Unanswered decisions {decisions}, undecided extension requests {extensions}",
  },
  digestAge: {
    ja: "。最古の要判断 {minutes} 分",
    en: ". Oldest item needing a decision: {minutes} min",
  },
  digestTop: { ja: "。最優先: {items}", en: ". Top priority: {items}" },
  digestStatePending: { ja: "未起動", en: "not started" },
  digestStateRunning: { ja: "実行", en: "running" },
  digestStateWaiting: { ja: "待機", en: "waiting" },
  digestStateDone: { ja: "完了報告", en: "reported done" },
  digestStateVerified: { ja: "受理", en: "accepted" },
  digestStateStopping: { ja: "停止中", en: "stopping" },
  digestStateStopIncomplete: { ja: "停止未完了", en: "stop incomplete" },
  digestStateStopped: { ja: "停止", en: "stopped" },
  digestStateReclaimable: { ja: "回収可", en: "reclaimable" },
  digestStateArchived: { ja: "アーカイブ", en: "archived" },
  digestGroupDecision: { ja: "要判断", en: "needs decision" },
  digestGroupViolation: { ja: "範囲違反", en: "scope violation" },
  digestGroupFailure: { ja: "失敗", en: "failure" },
  digestGroupDone: { ja: "完了", en: "done" },
  digestGroupProgress: { ja: "進捗", en: "progress" },
  digestGroupInfo: { ja: "情報", en: "info" },
  // ── 窓口（API）の警告
  apiAlert: {
    ja: "窓口の警告（{window}）: {kinds}。{hint}の可能性がある（daemon の記録の apiSummary に、内訳がある）",
    en: "API alert ({window}): {kinds}. Possible cause: {hint} (the daemon log's apiSummary has the breakdown)",
  },
  apiWindowRange: {
    ja: "{start}〜{end} UTC（{sec} 秒間）",
    en: "{start} to {end} UTC ({sec} s)",
  },
  apiWindow: { ja: "窓（{sec} 秒間）", en: "window ({sec} s)" },
  apiKind: { ja: "{label} {total} 件", en: "{label}: {total}" },
  apiKindDetail: { ja: "{label} {total} 件（{detail}）", en: "{label}: {total} ({detail})" },
  apiAuthFailed: { ja: "認証の失敗", en: "auth failures" },
  apiRateLimited: { ja: "制限の発動", en: "rate limits hit" },
  apiRetiredExpired: {
    ja: "退役したトークンでの認証の失敗",
    en: "auth failures with retired tokens",
  },
  apiHintBrute: {
    ja: "トークンの総当たりや、暴走した呼び出し",
    en: "token brute-forcing or runaway calls",
  },
  apiHintRetired: {
    ja: "退役した紐付けのトークンを使い続ける呼び出し（mcp の不具合・トークンの使い回し）",
    en: "calls that keep using a retired binding's token (an mcp bug or token reuse)",
  },
  gitDirUnknown: {
    ja: "子 {node} の作業ツリーの git のディレクトリを確かめられないため、書き込みを拒否している。人が作業ツリー（git worktree）を確かめる",
    en: "Writes are refused because the git folder of child {node}'s worktree cannot be checked. A person should check the worktree (git worktree)",
  },
  // ── 判断の取り下げ（#196・#202）
  decisionWithdrawn: {
    ja: "判断を取り下げた（要らなくなった）: {question}",
    en: "Decision withdrawn (no longer needed): {question}",
  },
} as const satisfies Readonly<Record<string, { readonly ja: string; readonly en: string }>>;

export type InboxMessageKey = keyof typeof INBOX_MESSAGES;

/** 知らせの値（名前 → 文字か数）。 */
export type InboxMessageArgs = Readonly<Record<string, string | number>>;

/** 並べる部分の区切り。ja は「・」「、」「」、en は「, 」「, 」「」。 */
export const LIST_SEPS = {
  dot: { ja: "・", en: ", " },
  comma: { ja: "、", en: ", " },
  none: { ja: "", en: "" },
} as const satisfies Readonly<Record<string, Readonly<Record<Lang, string>>>>;
export type ListSep = keyof typeof LIST_SEPS;

/** 並べる部分（`{名前}` の所に、項目の文を区切りでつないで入れる）。 */
export interface InboxMessageList {
  readonly sep: ListSep;
  readonly items: readonly InboxMessage[];
}

/** 受信箱の項目に付ける、画面のための知らせ（鍵と値。並べる部分 `parts` は、いくつかの知らせを 1 つの所に並べる）。 */
export interface InboxMessage {
  readonly key: string;
  readonly args: InboxMessageArgs;
  readonly parts?: Readonly<Record<string, InboxMessageList>>;
}

/** 値の数・名前・長さ・並べる部分の上限（記録の検査と同じ）。`depth` は、知らせの入れ子の深さ（いちばん外を 1 と数える）。 */
export const INBOX_MESSAGE_LIMITS = {
  args: 8,
  name: 32,
  value: 200,
  key: 64,
  lists: 4,
  items: 12,
  depth: 3,
} as const;
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

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function isMessageAt(x: unknown, depth: number): boolean {
  if (!isPlainObject(x)) return false;
  if (Object.keys(x).some((k) => k !== "key" && k !== "args" && k !== "parts")) return false;
  if (typeof x.key !== "string" || !KEY.test(x.key)) return false;
  const a = x.args;
  if (!isPlainObject(a)) return false;
  const entries = Object.entries(a);
  if (entries.length > INBOX_MESSAGE_LIMITS.args) return false;
  const argsOk = entries.every(
    ([k, v]) =>
      NAME.test(k) &&
      (typeof v === "number"
        ? Number.isFinite(v)
        : typeof v === "string" &&
          v.length <= INBOX_MESSAGE_LIMITS.value &&
          // 制御文字（改行を含む）は入れない
          !hasControl(v)),
  );
  if (!argsOk) return false;
  if (x.parts === undefined) return true;
  const p = x.parts;
  if (depth >= INBOX_MESSAGE_LIMITS.depth || !isPlainObject(p)) return false;
  const lists = Object.entries(p);
  if (lists.length > INBOX_MESSAGE_LIMITS.lists) return false;
  return lists.every(([name, l]) => {
    if (!NAME.test(name) || Object.hasOwn(a, name) || !isPlainObject(l)) return false;
    if (Object.keys(l).some((k) => k !== "sep" && k !== "items")) return false;
    if (typeof l.sep !== "string" || !Object.hasOwn(LIST_SEPS, l.sep)) return false;
    const items = l.items;
    return (
      Array.isArray(items) &&
      items.length <= INBOX_MESSAGE_LIMITS.items &&
      items.every((it) => isMessageAt(it, depth + 1))
    );
  });
}

/** 知らせの写し（並べる部分 `parts` も、入れ子まで写す。表示モデルが記録の値を共有しないため）。 */
export function copyInboxMessage(m: InboxMessage): InboxMessage {
  if (m.parts === undefined) return { key: m.key, args: { ...m.args } };
  const parts: Record<string, InboxMessageList> = {};
  for (const [name, l] of Object.entries(m.parts))
    parts[name] = { sep: l.sep, items: l.items.map(copyInboxMessage) };
  return { key: m.key, args: { ...m.args }, parts };
}

/**
 * 記録に載せてよい形か。鍵は形だけを見て、表にない鍵も断らない：版の違う daemon の記録（新しい daemon が足した鍵を、
 * 古い daemon・画面が読む。その逆も）を、畳むときに断って読めなくしないため。表にない鍵の知らせは、画面が summary を出す。
 */
export function isInboxMessage(x: unknown): x is InboxMessage {
  return isMessageAt(x, 1);
}

/**
 * `{名前}` を値で置き換える（無い名前は、そのまま残す）。
 * `lang` を渡すと、値の名前が `名前Key`（例 `labelKey`）で、その値が表の鍵なら、`{名前}` を、その鍵の文（同じ言語）にする
 * （入力待ちの種類のように、daemon の言葉の表から選ぶ部分を、言語に合わせるため。1 段だけ。差し込みはしない）。
 * `parts` は、`lang` を渡したときだけ、`inboxMessageText` が渡す（並べた文）。
 */
export function fillMessage(
  template: string,
  args: InboxMessageArgs,
  lang?: Lang,
  parts?: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([a-z][A-Za-z0-9]*)\}/g, (all, name: string) => {
    if (Object.hasOwn(args, name)) return String(args[name]);
    if (parts !== undefined && Object.hasOwn(parts, name)) return parts[name] as string;
    const ref = `${name}Key`;
    if (lang !== undefined && Object.hasOwn(args, ref)) {
      const k = args[ref];
      if (isInboxMessageKey(k)) return INBOX_MESSAGES[k][lang];
    }
    return all;
  });
}

/** 言語ごとの文。鍵が表になければ（並べる部分の中の鍵も）undefined。 */
export function inboxMessageText(lang: Lang, m: InboxMessage): string | undefined {
  if (!isInboxMessageKey(m.key)) return undefined;
  let filled: Record<string, string> | undefined;
  if (m.parts !== undefined) {
    filled = {};
    for (const [name, l] of Object.entries(m.parts)) {
      const texts: string[] = [];
      for (const it of l.items) {
        const t = inboxMessageText(lang, it);
        if (t === undefined) return undefined;
        texts.push(t);
      }
      filled[name] = texts.join(LIST_SEPS[l.sep][lang]);
    }
  }
  return fillMessage(INBOX_MESSAGES[m.key][lang], m.args, lang, filled);
}

/** 文の中の `{名前}` の一覧（並べ替えて、重なりを除く）。 */
export const placeholdersOf = (template: string): readonly string[] =>
  [
    ...new Set([...template.matchAll(/\{([a-z][A-Za-z0-9]*)\}/g)].map((x) => x[1] as string)),
  ].sort();

const safeArgs = (args: InboxMessageArgs): InboxMessageArgs => {
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
  return safe;
};

/** 並べる部分の 1 つの項目（`inboxMessage` の `parts` に入れる）。値は、`inboxMessage` と同じく整える。 */
export function messagePart<K extends InboxMessageKey>(
  key: K,
  args: InboxMessageArgs = {},
  parts?: Readonly<Record<string, InboxMessageList>>,
): InboxMessage {
  return { key, args: safeArgs(args), ...(parts === undefined ? {} : { parts }) };
}

/**
 * daemon が知らせを書くときの入口。日本語の `summary` と、画面のための `msg` を作る。
 * 値は、長すぎれば切る（記録の検査に通る形にする）。`parts` は、項目を並べる所（`messagePart` で作る）。
 */
export function inboxMessage<K extends InboxMessageKey>(
  key: K,
  args: InboxMessageArgs,
  parts?: Readonly<Record<string, InboxMessageList>>,
): { readonly summary: string; readonly msg: InboxMessage } {
  const msg = messagePart(key, args, parts);
  return { summary: inboxMessageText("ja", msg) ?? "", msg };
}
