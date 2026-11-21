# キーワード検索の結果: reportDone|invalidTransition|decision\.answer|decision\.asked
docs/cli.md:86:子が出した判断要求（decision）に、人が答えるためのコマンド（`decision.answer` の人間版。画面〔`/ui`〕と同じことを CLI でできる）。
docs/desktop-runtime.md:28:`decision.answer` は対象にしない（選択肢は統合ノードが書く自由な文字列で、回答で破棄が記録される経路はない。破棄の判断を書くのは、上の `node.reclaimInstruct` と、生成に失敗したときの system の後始末だけ）。止めたと宣言（`node.co
docs/desktop-runtime.md:98:**done の子の片付け**: 完了報告済み（done）の子は、**人だけが、受理せずに止められる**（`"$HOME/.touryou/current/bin/touryou" stop <nodeId> --yes`。猶予なしの即時停止。#115）。統合の `node_stop`
docs/manual-verification-ui.md:40:daemon の窓口の実物に、記録するだけの仮のハンドラ（`decision.answer`）を付けて確かめる（`out.operations`）。
docs/ui.md:69:画面から、**判断への回答（`decision.answer`）と、拡張要求の判定（`scope.decide`）だけ**ができる。人間のトークンで、既存の `POST /v1/request` に送る（新しい入口はない。`decision.answer`。認可は、daemon の既存の検査〔人間のロール〕に任
packages/cli/src/commands.ts:85:      差し戻しは、親の統合ノードだけができる。done 以外の子は invalidTransition（受理できない）
packages/cli/src/commands.ts:106:      判断要求に答える（decision.answer の人間版）。--yes がなければ、判断の中身（ノード・子の状態・問い・選択肢）を表示するだけで答えない。
packages/cli/src/commands.ts:372:/** `decision.answer` の結果。`delivery` は古い daemon にはない（知らない値も、ないものとして扱う）。 */
packages/cli/src/commands.ts:893:  const res = await invoke(deps.client, id, "decision.answer", params, isAnswerResult);
packages/cli/test/child.test.ts:345:    for (const op of ["purge", "report.progress", "node.purge", "decision.answer"]) {
packages/cli/test/human-read-answer.test.ts:235:  it("--yes だけ（--expect なし）では答えない（終了コード 1、decision.answer を呼ばない）", async () => {
packages/cli/test/human-read-answer.test.ts:239:      "decision.answer": ok({ accepted: true }),
packages/cli/test/human-read-answer.test.ts:243:    expect(ops(sent)).not.toContain("decision.answer");
packages/cli/test/human-read-answer.test.ts:247:  it("--yes --expect --choice で答える（decision.answer を呼ぶ）", async () => {
packages/cli/test/human-read-answer.test.ts:252:      "decision.answer": ok({ accepted: true }),
packages/cli/test/human-read-answer.test.ts:259:    expect(ops(sent)).toEqual(["decision.get", "tree.list", "decision.answer"]);
packages/cli/test/human-read-answer.test.ts:273:        "decision.answer": ok({ accepted: true, delivery }),
packages/cli/test/human-read-answer.test.ts:292:      "decision.answer": ok({ accepted: true, delivery: "delivered", deliveredVia }),
packages/cli/test/human-read-answer.test.ts:307:        "decision.answer": ok(result),
packages/cli/test/human-read-answer.test.ts:328:      "decision.answer": ok({ accepted: true }),
packages/cli/test/human-read-answer.test.ts:338:  it("選択肢にない --choice は受け付けない（終了コード 2、decision.answer を呼ばない）", async () => {
packages/cli/test/human-read-answer.test.ts:349:    expect(ops(sent)).not.toContain("decision.answer");
packages/cli/test/human-read-answer.test.ts:361:  it("--expect が今の照合の値と違えば、答えない（decision.answer を呼ばない）", async () => {
packages/cli/test/human-read-answer.test.ts:365:      "decision.answer": ok({ accepted: true }),
packages/cli/test/human-read-answer.test.ts:372:    expect(ops(sent)).not.toContain("decision.answer");
packages/cli/test/human-read-answer.test.ts:381:      "decision.answer": ok({ accepted: true }),
packages/cli/test/human-read-answer.test.ts:388:    expect(ops(sent)).not.toContain("decision.answer");
packages/cli/test/human-read-answer.test.ts:402:    expect(ops(sent)).not.toContain("decision.answer");
packages/core/src/contract.ts:100:/** `decision.answer` の結果の、回答を子に届けたか。 */
packages/core/src/contract.ts:355:  "decision.answer": {
packages/core/src/contract.ts:629:    "decision.answer",
packages/core/src/events.ts:367:      readonly type: "decision.answered";
packages/core/src/events.ts:521:   * `decision.answer` は closed に答えさせない（`decisionClosed`）。記録に届いた回答は、却下として積むだけ。
packages/core/src/events.ts:838:    case "reportDone":
packages/core/src/events.ts:936:    "invalidTransition",
packages/core/src/events.ts:1561:          "invalidTransition",
packages/core/src/events.ts:1695:          "invalidTransition",
packages/core/src/events.ts:1872:    case "decision.answered": {
packages/core/src/events.ts:1875:        return invalid(seq, "decision.answered の payload");
packages/core/src/events.ts:2116:            "invalidTransition",
packages/core/src/events.ts:2124:          "invalidTransition",
packages/core/src/events.ts:2383:          "invalidTransition",
packages/core/src/purge.ts:104: * （指示の `nodeId`）・`decision.answered`（判断の `nodeId`）。導けないものは含めない（削除しない側に倒す）。
packages/core/src/purge.ts:169:      case "decision.answered":
packages/core/src/transition.ts:35:  | { readonly type: "reportDone" } // 完了報告（running→done）
packages/core/src/transition.ts:57:export type TransitionFailureCode = "invalidTransition" | "alreadyFinished" | "discardRequired";
packages/core/src/transition.ts:116:    case "reportDone":
packages/core/src/transition.ts:155:    "invalidTransition",
packages/core/test/digest.test.ts:68:      changed("a", { type: "reportDone" }),
packages/core/test/digest.test.ts:69:      changed("b", { type: "reportDone" }),
packages/core/test/digest.test.ts:70:      changed("m1", { type: "reportDone" }),
packages/core/test/digest.test.ts:141:      changed("b", { type: "reportDone" }),
packages/core/test/digest.test.ts:295:    changed("a", { type: "reportDone" }),
packages/core/test/events.test.ts:114:        ev(changed("a", { type: "reportDone" })),
packages/core/test/events.test.ts:118:    const bad = foldEvents([...base(), ev(changed("a", { type: "reportDone" }))]); // pending からは完了できない
packages/core/test/events.test.ts:119:    expect(bad.ok ? null : bad.error.code).toBe("invalidTransition");
packages/core/test/events.test.ts:128:      ev(changed("a", { type: "reportDone" })),
packages/core/test/events.test.ts:156:      ev(changed("a", { type: "reportDone" })),
packages/core/test/events.test.ts:168:      ev(changed(id, { type: "reportDone" })),
packages/core/test/events.test.ts:177:      ev(changed("root", { type: "reportDone" })),
packages/core/test/events.test.ts:305:          { type: "decision.answered", payload: { decisionId: "d1", answer: "A" } },
packages/core/test/events.test.ts:309:          { type: "decision.answered", payload: { decisionId: "d1", answer: "B" } },
packages/core/test/events.test.ts:323:      ev({ type: "decision.answered", payload: { decisionId: "nope", answer: "x" } }),
packages/core/test/events.test.ts:405:  { type: "reportDone" },
packages/core/test/events.test.ts:485:                type: "decision.answered",
packages/core/test/events.test.ts:567:            "invalidTransition",
packages/core/test/events.test.ts:615:      [[{ type: "reportDone" }], "done"],
packages/core/test/events.test.ts:616:      [[{ type: "reportDone" }, { type: "accept" }], "verified"],
packages/core/test/events.test.ts:648:      ev(changed("a", { type: "reportDone" })),
packages/core/test/events.test.ts:839:      { type: "decision.answered", payload: { decisionId: "d", answer: 5 as never } },
packages/core/test/events.test.ts:1085:    expect(code(resumed)).toBe("invalidTransition");
packages/core/test/events.test.ts:1415:    expect(codeOf(foldEvents([...b, requested()]))).toBe("invalidTransition");
packages/core/test/events.test.ts:1606:    ev({ type: "decision.answered", payload: { decisionId, answer: "a" } });
packages/core/test/events.test.ts:1660:    const done = () => ev(changed("root", { type: "reportDone" }));
packages/core/test/events.test.ts:1758:    const done = () => ev(changed("root", { type: "reportDone" }));
packages/core/test/events.test.ts:1809:        ev({ type: "decision.answered", payload: { decisionId: "a-d0", answer: "yes" } }),
packages/core/test/events.test.ts:1850:      ev(changed("a", { type: "reportDone" })),
packages/core/test/events.test.ts:1865:      ev(changed("a", { type: "reportDone" })),
packages/core/test/purge.test.ts:24:  st(nodeId, { type: "reportDone" }),
packages/core/test/purge.test.ts:164:    mine.push(add({ type: "decision.answered", payload: { decisionId: "da", answer: "x" } }));
packages/core/test/purgehold.test.ts:33:  changed(nodeId, { type: "reportDone" }),
packages/core/test/records.test.ts:485:  it("running・waiting・stopping・stopIncomplete のノードに限る（pending・停止済み・完了後は invalidTransition）", () => {
packages/core/test/records.test.ts:487:    expect(code(foldEvents([...pending, exited("a")]))).toBe("invalidTransition");
packages/core/test/records.test.ts:488:    expect(code(foldEvents([...pending, denied("a")]))).toBe("invalidTransition");
packages/core/test/records.test.ts:496:    expect(code(foldEvents([...stopped, exited("a")]))).toBe("invalidTransition");
packages/core/test/records.test.ts:497:    const done = [...base(), changed(10, "a", { type: "reportDone" })];
packages/core/test/records.test.ts:498:    expect(code(foldEvents([...done, denied("a")]))).toBe("invalidTransition");
packages/core/test/records.test.ts:549:    expect(code(pending)).toBe("invalidTransition");
packages/core/test/records.test.ts:552:      changed(5, "a", { type: "reportDone" }),
packages/core/test/records.test.ts:555:    expect(code(done)).toBe("invalidTransition");
packages/core/test/stop-declared.test.ts:93:    expect(r1.ok ? null : r1.error.code).toBe("invalidTransition");
packages/core/test/t13e.test.ts:225:      ).toBe("invalidTransition");
packages/core/test/t13e.test.ts:230:    expect(code(foldEvents([...base(), discard("a")]))).toBe("invalidTransition");
packages/core/test/t13e.test.ts:270:      changed("a", { type: "reportDone" }),
packages/core/test/transition.test.ts:19:  ["running", { type: "reportDone" }, "done"],
packages/core/test/transition.test.ts:51:  { type: "reportDone" },
packages/core/test/transition.test.ts:92:          expect(r.error.code).toBe("invalidTransition");
packages/core/test/ui-view.test.ts:837:        { type: "decision.answered", payload: { decisionId: "d1", answer: "日" } } as never,
packages/core/test/ui-view.test.ts:889:        payload: { nodeId: "a", event: { type: "reportDone" } },
packages/core/test/ui-view.test.ts:907:        payload: { nodeId: "a", event: { type: "reportDone" } },
packages/core/test/ui-view.test.ts:942:        payload: { nodeId: "a", event: { type: "reportDone" } },
packages/core/test/ui-view.test.ts:985:        { type: "decision.answered", payload: { decisionId: "d1", answer: "日" } } as never,
packages/daemon/src/api/handlers/answer-delivery.ts:2: * 判断の回答を、判断を出したノードへ届ける。`decision.answer` が成功したあと、回答を「人間からの回答」と分かる
packages/daemon/src/api/handlers/index.ts:190:            answer: state["decision.answer"],
packages/daemon/src/api/handlers/index.ts:213:  // 依存先の完了（report.done・node.review）と、判断への回答による再開（decision.answer）の後で、起動できる子を起動する。
packages/daemon/src/api/handlers/index.ts:216:    for (const op of ["report.done", "node.review", "decision.answer"] as const) {
packages/daemon/src/api/handlers/pause-handlers.ts:2: * 判断待ちの間に子を止める（`decision.present` の `pauseNodeIds`）と、回答での再開（`decision.answer`）。
packages/daemon/src/api/handlers/pause-handlers.ts:3: * 状態ハンドラ（`createStateHandlers`。`allowPause: true`）の `decision.present`・`decision.answer` を包む。
packages/daemon/src/api/handlers/pause-handlers.ts:64:  readonly answer: (req: HandlerRequest<"decision.answer">) => Async<"decision.answer">;
packages/daemon/src/api/handlers/pause-handlers.ts:369:    "decision.answer": async (
packages/daemon/src/api/handlers/pause-handlers.ts:370:      req: HandlerRequest<"decision.answer">,
packages/daemon/src/api/handlers/pause-handlers.ts:371:    ): Promise<R<"decision.answer">> => {
packages/daemon/src/api/handlers/runtime-handlers.ts:330:          "invalidTransition",
packages/daemon/src/api/handlers/runtime-handlers.ts:447:          "invalidTransition",
packages/daemon/src/api/handlers/state-handlers.ts:395:        { type: "node.stateChanged", payload: { nodeId: caller, event: { type: "reportDone" } } },
packages/daemon/src/api/handlers/state-handlers.ts:481:    "decision.answer": (req: HandlerRequest<"decision.answer">): R<"decision.answer"> => {
packages/daemon/src/api/handlers/state-handlers.ts:518:          { type: "decision.answered", payload: { decisionId: d.decisionId, answer } },
packages/daemon/src/api/handlers/state-handlers.ts:536:        { type: "decision.answered", payload: { decisionId: d.decisionId, answer } },
packages/daemon/src/api/results.ts:53:  "decision.answer": ["accepted", "notResumed", "delivery", "deliveredVia"],
packages/daemon/src/api/ui-assets.ts:690:          openConfirm(t('decision.answerTitle'), [[t('line.node'), d.nodeId], [t('line.decision'), question], [t('line.answerChoi
packages/daemon/src/api/ui-assets.ts:713:        openConfirm(t('decision.answerTitle'), [[t('line.node'), d.nodeId], [t('line.decision'), question], [t('line.answerFree')
packages/daemon/src/api/ui-graph-js.ts:3:export const UI_GRAPH_JS: string = "/*!\n * touryou の関係図（/ui/graph.js）。次のものを束ねている（どれも MIT License）。\n * rete@2.0.6 — MIT — (c) Vi
packages/daemon/src/api/validate.ts:388:  "decision.answer": (p) => {
packages/daemon/src/reconcile.ts:14: *   記録に残す（停止の要求の requestId を判断から決める）。回答（`decision.answer`）の側が、これを見て再開する（人間が止めた子は除く）。
packages/daemon/src/ui/app-text.ts:167:  "decision.answerTitle": { ja: "判断への回答", en: "Answer to a decision" },
packages/daemon/test/api/accepted-session-stop.test.ts:57:  ev("a", { type: "reportDone" });
packages/daemon/test/api/authorize.test.ts:84:    expect(code(run(m1, "decision.answer", { decisionId: "da", choice: "A" }))).toBe("forbidden");
packages/daemon/test/api/authorize.test.ts:95:    expect(run(human, "decision.answer", { decisionId: "da", choice: "A" }).ok).toBe(true);
packages/daemon/test/api/handlers/answer-delivery.test.ts:120:    answer: state["decision.answer"],
packages/daemon/test/api/handlers/answer-delivery.test.ts:140:    (await h["decision.answer"]({
packages/daemon/test/api/handlers/answer-delivery.test.ts:142:      operation: "decision.answer",
packages/daemon/test/api/handlers/answer-delivery.test.ts:145:    } as unknown as HandlerRequest<"decision.answer">)) as Loose<{ accepted: true }>;
packages/daemon/test/api/handlers/answer-delivery.test.ts:245:    r.ev("a", { type: "reportDone" });
packages/daemon/test/api/handlers/answer-delivery.test.ts:438:        body: { type: "decision.answered", payload: { decisionId: id, answer: "YAML" } },
packages/daemon/test/api/handlers/answer-delivery.test.ts:512:describe("decision.answer の結果の delivery（回答を子に届けたか）", () => {
packages/daemon/test/api/handlers/create-handlers.test.ts:47:      "decision.answer",
packages/daemon/test/api/handlers/create-handlers.test.ts:86:    ev("a", { type: "reportDone" });
packages/daemon/test/api/handlers/create-handlers.test.ts:138:    ev("a", { type: "reportDone" });
packages/daemon/test/api/handlers/create-handlers.test.ts:248:  it("decision.answer の成功後に、起動できる pending の子が起動する", async () => {
packages/daemon/test/api/handlers/create-handlers.test.ts:298:    const answered = await h["decision.answer"]?.({
packages/daemon/test/api/handlers/create-handlers.test.ts:300:      operation: "decision.answer",
packages/daemon/test/api/handlers/hook-notify-stop.test.ts:161:    add({ type: "decision.answered", payload: { decisionId: "d1", answer: "x" } } as never);
packages/daemon/test/api/handlers/integration.test.ts:90:      (await t.call(t.tokens.human, "decision.answer", { decisionId, choice: "A" })).status,
packages/daemon/test/api/handlers/integration.test.ts:110:      (await t.call(t.tokens.a, "decision.answer", { decisionId: "x", choice: "A" })).status,
packages/daemon/test/api/handlers/pause-handlers.test.ts:71:  ev("d", { type: "reportDone" });
packages/daemon/test/api/handlers/pause-handlers.test.ts:119:    answer: state["decision.answer"],
packages/daemon/test/api/handlers/pause-handlers.test.ts:148:      operation: "decision.answer",
packages/daemon/test/api/handlers/pause-handlers.test.ts:151:    } as unknown as HandlerRequest<"decision.answer">;
packages/daemon/test/api/handlers/pause-handlers.test.ts:152:    return (await h["decision.answer"](req)) as Loose<{ accepted: true }>;
packages/daemon/test/api/handlers/pause-handlers.test.ts:191:describe("decision.answer（回答で、止めた子を必ず再開する）", () => {
