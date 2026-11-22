/**
 * アダプタ（ランタイム）を伴う操作の実体: 追加指示（`node.send`）、停止（`node.stop`）、可能な操作の参照
 * （`node.capabilities`）。権限と部分木の判定は、認可（`authorize`）で済んでいる前提。
 * PRD: FR_009, FR_010, FR_034
 *
 * - `node.send`: 動作中（running・waiting）のノードの指示を、アダプタへ渡す。
 * - `node.stop`: 先に、停止要求（`stop`・停止未完了からは `retryStop`）をイベントログに記録し、そのイベントの `seq`
 *   （core の停止の試行）を `stopSeq` として、アダプタの 2 段階停止を始める。応答は要求を受け付けた時点（`stopping`）で返し、
 *   停止の進行（観測・確認・`stopTimeout`）は、アダプタがイベントログへ記録する。起動前（pending）の停止は、取り消し
 *   （`stopped`）でアダプタを呼ばない。停止の対象でない状態・アダプタがない動作中のノードは、何も書かずに失敗する。
 * - `node.capabilities`: ノードの状態（core の遷移表）と、アダプタの能力表から、統合ノードが取れる操作を導く。
 * 同じ requestId の再試行は、停止要求を重複して記録しない（冪等）。
 */

import {
  type DaemonOperation,
  type EventBody,
  type Failure,
  failure,
  formatProcesses,
  isDirectChild,
  isInSubtree,
  isStrictDescendant,
  type NodeEvent,
  type NodeRecord,
  type NodeState,
  type OperationMap,
  type OrchState,
  type Result,
  SUBTREE_RULES,
  type SubtreeOperation,
  type SubtreeRule,
  stateOf,
  transition,
} from "@touryou/core";
import { stopDelegation } from "../../sdk/cli-adapter.js";
import type { RuntimeAdapter, StopValue } from "../../sdk/runtime.js";
import type { HandlerRequest } from "../server.js";
import {
  alreadyApplied,
  appendAtomically,
  deriveId,
  fail,
  type LogPort,
  notice,
  summarize,
} from "./context.js";
import { createExclusive } from "./inflight.js";
import {
  createInstructionDelivery,
  type InstructionDelivery,
  wasNotified,
} from "./instruction-delivery.js";
import { sessionStopBodies } from "./parent-request-handlers.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface RuntimeHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  /** ノードのランタイム（アダプタ）。なければ `undefined`。 */
  readonly adapterFor: (nodeId: string) => RuntimeAdapter | undefined;
  /** バックグラウンドの停止が終わったときの通知（結果の記録はアダプタが済ませている。ログ用）。 */
  readonly onStopSettled?: (nodeId: string, result: Result<StopValue, Failure>) => void;
  /** 追加指示の配送。省略すると、`adapterFor` から組み立てる。 */
  readonly delivery?: InstructionDelivery;
  /** 応答に出さない原因（配送の記録の失敗など）の記録先。 */
  readonly onFailure?: (nodeId: string, cause: string) => void;
  /** サブ統括の連動停止で、配下の子の停止の確認を待つ上限と確認の間隔（ミリ秒）。既定は 10 分と 2 秒。試験で短くする。 */
  readonly cascade?: { readonly waitMs?: number; readonly pollMs?: number };
}

const callerOf = (req: HandlerRequest): string => req.caller?.nodeId ?? "";
/** 人の CLI の本体の場所（PATH に touryou がなくても、そのまま貼って動く。#115）。 */
const CLI = '"$HOME/.touryou/current/bin/touryou"';
const nodeOf = (state: OrchState, nodeId: string): NodeRecord | undefined =>
  state.nodes.find((n) => n.id === nodeId);

const SENDABLE: ReadonlySet<NodeState> = new Set(["running", "waiting"]);

/** 連動停止（サブ統括の停止）で、配下の子を新しく停止の依頼に載せる状態（pending は取り消し）。 */
const CASCADE_STOP: ReadonlySet<NodeState> = new Set(["pending", "running", "waiting"]);
/** 連動停止で、すでに停止の途中にある子（依頼を出し直さず、確認だけを待つ）。 */
const CASCADE_WAIT: ReadonlySet<NodeState> = new Set(["stopping", "stopIncomplete"]);
/** 連動停止で、停止が確認された子の状態。 */
const CASCADE_SETTLED: ReadonlySet<NodeState> = new Set(["stopped", "reclaimable", "archived"]);

const noRuntime = (nodeId: string) =>
  fail(
    "noRuntime",
    `ノード ${nodeId} のランタイム（アダプタ）が見つからない`,
    "ノードの状態を確認する",
    "ノードを起動し直す",
  );

const ruleHolds = (
  rule: SubtreeRule,
  nodes: OrchState["nodes"],
  caller: string,
  target: string,
): boolean =>
  rule === "strictDescendant"
    ? isStrictDescendant(nodes, caller, target)
    : rule === "directChild"
      ? isDirectChild(nodes, caller, target)
      : isInSubtree(nodes, caller, target);

/**
 * ノードについて、呼び出した統合ノード（`caller`）が取れる操作を導く（FR_034）。次の 3 つで絞る:
 * (1) ノードの状態（core の遷移表）、(2) アダプタの能力表（アダプタがなければ、指示・停止・切り出し・子の生成は出さない。
 * 停止は、穏当か即時のどちらかが可能か、代行（`stopDelegated`）できるときだけ。指示は `send` が unsupported でないときだけ）、
 * (3) 呼び出し元との関係（`SUBTREE_RULES`。例: 完了の判定は直接の親だけ、自分自身には何もない）。
 * `node.reclaimPreview`・`node.reclaim` は、回収の入口に立てる状態（verified・stopped）で出す。実際に回収できるかは、
 * `node.reclaimPreview` の判定（回収可能判定。条件 1〜6）で決まる。停止未完了（stopIncomplete）からの `node.stop` は、
 * 再試行（`retryStop`＝即時停止）として扱う。
 */
export function operationsFor(
  node: NodeRecord,
  adapter: RuntimeAdapter | undefined,
  caller: string,
  nodes: OrchState["nodes"],
): DaemonOperation[] {
  const s = node.state;
  const caps = adapter?.capabilities(node.id);
  const candidates: DaemonOperation[] = ["node.capabilities"];
  if (caps !== undefined) {
    if (SENDABLE.has(s) && caps.send !== "unsupported") candidates.push("node.send");
    const canStop = caps.stopGraceful || caps.stopImmediate || caps.stopDelegated === true;
    if (
      canStop &&
      (s === "stopIncomplete" ||
        (s !== "stopped" && transition(s, { type: "stop", mode: "immediate" }).ok))
    ) {
      candidates.push("node.stop");
    }
    if (s === "stopIncomplete" && caps.stopDelegated === true)
      candidates.push("node.confirmStopped");
    if (s === "running") candidates.push("node.split");
    if ((s === "running" || s === "waiting") && node.role === "integrator")
      candidates.push("node.spawn");
  }
  if (s === "done") candidates.push("node.review");
  if (s === "verified") candidates.push("node.integrate");
  if (s === "verified" || s === "stopped") candidates.push("node.reclaimPreview", "node.reclaim");
  return candidates.filter((op) => {
    const rule = SUBTREE_RULES[op as SubtreeOperation];
    // node.spawn は、親にするノード（この node）が、自分か子孫のときに作れる。
    return rule === undefined || ruleHolds(rule, nodes, caller, node.id);
  });
}

export function createRuntimeHandlers(deps: RuntimeHandlerDeps) {
  const { log, clock, adapterFor } = deps;
  const exclusive = createExclusive();
  const delivery =
    deps.delivery ??
    createInstructionDelivery({
      log,
      clock,
      ...(deps.onFailure === undefined ? {} : { onFailure: deps.onFailure }),
    });

  /** 認可（`SUBTREE_RULES`）の二重の備え: 対象は、呼び出した統合ノードの、自分を含まない子孫だけ。 */
  const outsideSubtree = (caller: string, nodeId: string) =>
    isStrictDescendant(log.state().nodes, caller, nodeId)
      ? undefined
      : fail(
          "forbidden",
          "対象のノードが、自分の部分木の規則（自分を含まない子孫）を満たさない",
          "親（統合ノード）に依頼する",
        );

  /**
   * 停止の結果を、イベントログへ反映する（アダプタが記録しない分）。停止の試行（`stopSeq`）ごとに 1 回（冪等）。
   * - 停止を確認した（stopped）: 受信箱に info。
   * - 停止未完了（stopIncomplete。残っているプロセスの pid つき）: 受信箱に stopIncomplete。
   * - 代行（`delegation` つき。Desktop）: 受信箱に stopIncomplete（代行の文面）。
   * - アダプタの失敗: まだ stopping なら、`stopTimeout` を記録して stopIncomplete にし、受信箱に stopIncomplete。
   */
  const settle = (nodeId: string, stopSeq: number, result: Result<StopValue, Failure>): void => {
    const bodies: EventBody[] = [];
    const inbox = (
      kind: "info" | "stopIncomplete",
      text: string | ReturnType<typeof notice>,
    ): EventBody => ({
      type: "inbox.added",
      payload: {
        id: deriveId("inbox", "system", `stop-${stopSeq}`, "settled"),
        kind,
        nodeId,
        ...(typeof text === "string" ? { summary: summarize(text) } : text),
      },
    });
    if (result.ok && result.value.state === "stopped") {
      bodies.push(inbox("info", notice("stopConfirmed", { outcome: result.value.outcome })));
    } else if (
      result.ok &&
      result.value.state === "stopIncomplete" &&
      result.value.delegation !== undefined
    ) {
      // 親への停止の依頼（CLI のアダプタの決まった文）は、鍵と値で載せる。ほかの文は、そのまま
      bodies.push(
        inbox(
          "stopIncomplete",
          result.value.delegation === stopDelegation(nodeId)
            ? notice("stopDelegated", { node: nodeId })
            : result.value.delegation,
        ),
      );
    } else if (result.ok) {
      bodies.push(
        inbox(
          "stopIncomplete",
          result.value.processes !== undefined
            ? notice("stopIncomplete", { processes: formatProcesses(result.value.processes) })
            : notice("stopIncompletePids", { pids: result.value.blockers.join(", ") || "不明" }),
        ),
      );
    } else {
      if (stateOf(log.state(), nodeId) === "stopping") {
        bodies.push({
          type: "node.stateChanged",
          payload: { nodeId, event: { type: "stopTimeout" } },
        });
      }
      bodies.push(inbox("stopIncomplete", notice("stopFailed", { cause: result.error.cause })));
    }
    appendAtomically(log, clock, `stop-settled-${stopSeq}`, { system: true }, bodies);
  };

  /** 停止の結果の通知。どこで例外が出ても、unhandledRejection にしない。 */
  const notifySettled = (
    nodeId: string,
    stopSeq: number,
    result: Result<StopValue, Failure>,
  ): void => {
    try {
      settle(nodeId, stopSeq, result);
    } catch {
      // 反映に失敗しても、次の停止要求（再試行）で整合を取れる。
    }
    try {
      deps.onStopSettled?.(nodeId, result);
    } catch {
      // 通知の失敗で、停止の処理を止めない。
    }
  };

  const sendOnce = async (req: HandlerRequest<"node.send">): Promise<R<"node.send">> => {
    const { nodeId, text } = req.params;
    const outside = outsideSubtree(callerOf(req), nodeId);
    if (outside) return outside;
    const actor = { nodeId: callerOf(req) };
    const entry = [{ type: "node.instructed", payload: { nodeId, text } }] as const;
    // 重複の判定は、状態の検査より前に行う（再試行の間にノードが進んでいても成功）。判定は追記が行う
    // （同じ内容なら重複で何も書かず、内容が違えば `requestIdConflict`）。重複は、記録しない。
    // 記録済みでも未配送なら、配送だけをやり直す（送信に成功した記録がないため）。
    if (alreadyApplied(log.state(), actor, req.requestId)) {
      const dup = appendAtomically(log, clock, req.requestId, actor, entry);
      if (!dup.ok) return dup;
      if (dup.value.duplicate) {
        const seq = dup.value.events[0]?.seq;
        // 配送済みなら重複（duplicate: true）。未配送なら、配送だけをやり直す（duplicate: false）。
        if (seq === undefined || wasNotified(log, dup.value.state, seq)) {
          return { ok: true, value: { status: "queued", duplicate: true } };
        }
        if (SENDABLE.has(stateOf(dup.value.state, nodeId) ?? "pending")) {
          const again = await delivery.deliver(nodeId, text, seq);
          if (!again.ok) return again;
          return { ok: true, value: { status: "queued", duplicate: false } };
        }
        return { ok: true, value: { status: "queued", duplicate: true } };
      }
    }
    const state = stateOf(log.state(), nodeId);
    if (state === undefined) {
      return fail("notFound", "ノードが見つからない", "ID を確認する");
    }
    if (!SENDABLE.has(state)) {
      return fail(
        "notActive",
        `ノード ${nodeId} は ${state} で、指示を送れない（running・waiting のとき）`,
        "状態を確認する",
        "再開してから指示する",
        "done の子には、先に node_review で reject（差し戻し）してから送る",
      );
    }
    const adapter = adapterFor(nodeId);
    if (adapter === undefined) return noRuntime(nodeId);
    if (adapter.capabilities(nodeId).send === "unsupported") {
      return fail(
        "unsupported",
        `ノード ${nodeId} の実行環境（${adapter.kind}）には、daemon から直接指示を届けられない`,
        "親（統合セッション）に、実行環境の機能で代わりに送るよう頼む",
      );
    }
    // 先に記録し、そのあとアダプタへ渡す（配送に成功したら、配送を記録する）。
    const recorded = appendAtomically(log, clock, req.requestId, actor, entry);
    if (!recorded.ok) return recorded;
    const seq = recorded.value.events[0]?.seq;
    if (seq === undefined)
      return fail("internal", "記録した指示の番号を取得できない", "もう一度試す");
    const r = await delivery.deliver(nodeId, text, seq);
    if (!r.ok) return r;
    return { ok: true, value: { status: "queued", duplicate: false } };
  };

  // 連動停止の待ちの上限と確認の間隔（ミリ秒）。待ちは、サブ統括のセッションが孫の停止の依頼を実行する時間を見込む。
  const cascadeWaitMs = deps.cascade?.waitMs ?? 600_000;
  const cascadePollMs = Math.max(1, deps.cascade?.pollMs ?? 2_000);

  /**
   * 子の停止がすべて確認される（stopped・回収可能・アーカイブ）まで待つ。上限までに確認できなかった子を、
   * `ID（状態）` の形で返す（なければ空）。理由には、ID と状態名だけを入れる（子の自由な文字列を含めない）。
   */
  const waitChildrenStopped = async (ids: readonly string[]): Promise<string[]> => {
    const until = Date.now() + cascadeWaitMs;
    for (;;) {
      const state = log.state();
      const rest = ids.filter((id) => !CASCADE_SETTLED.has(stateOf(state, id) ?? "archived"));
      if (rest.length === 0) return [];
      if (Date.now() >= until) return rest.map((id) => `${id}（${stateOf(state, id) ?? "不明"}）`);
      await new Promise<void>((resolve) => setTimeout(resolve, cascadePollMs));
    }
  };

  // サブ統括の停止は、配下の子に対して `node.stop` を呼び直す（呼び出し元は止める統合ノード）。ハンドラの表ができたあとで束ねる。
  let stopSelf: (req: HandlerRequest<"node.stop">) => R<"node.stop"> = () => {
    throw new Error("node.stop が未初期化");
  };

  const handlers = {
    // 同じ requestId の同時の送信は、1 つにまとめる（配送が 1 回だけになる）。
    "node.send": (req: HandlerRequest<"node.send">): Promise<R<"node.send">> =>
      exclusive(`${callerOf(req)}\0${req.requestId}`, JSON.stringify(req.params), () =>
        sendOnce(req),
      ),

    "node.stop": (req: HandlerRequest<"node.stop">): R<"node.stop"> => {
      const { nodeId, mode } = req.params;
      const graceMs = req.params.mode === "graceful" ? req.params.graceMs : undefined;
      const human = req.role === "human";
      if (!human) {
        const outside = outsideSubtree(callerOf(req), nodeId);
        if (outside) return outside;
      }
      const actor = human ? ({ human: true } as const) : { nodeId: callerOf(req) };
      const before = log.state();
      const node = nodeOf(before, nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      // 済んだと報告した（done）が受理していない子を、受理せずに止められるのは人だけ（#115）。止めると受理の道には戻らないので、
      // 統合・親が「受理しない」を決めて成果を受理できなくする道は作らない。人が止められるのも、done の子だけ。
      if (node.state === "done" && !human) {
        return fail(
          "alreadyFinished",
          `ノード ${nodeId} は済んだと報告済み（done）で、受理せずに止められるのは人だけ`,
          "受理するなら node_review（accept）、差し戻すなら node_review（reject）",
          `受理せずに片付けるなら、人に頼む: ${CLI} stop ${nodeId} --yes（そのあと ${CLI} reclaim ${nodeId}）`,
        );
      }
      if (human && node.state !== "done") {
        return fail(
          "invalidTransition",
          `人が止められるのは、済んだと報告した（done）が受理していない子だけ（ノード ${nodeId} は ${node.state}）`,
          "動いている子を止めるのは、親の統合に頼む（node_stop）",
        );
      }
      // 受理した子（verified）は、状態を変えずに、裏のセッションの停止を親に依頼し直す（受理のときの依頼の再試行。Issue #3）。
      if (node.state === "verified") {
        const bodies = sessionStopBodies(before, nodeId, req.requestId);
        if (bodies.length === 0 && !alreadyApplied(before, actor, req.requestId)) {
          return fail(
            "alreadyFinished",
            `ノード ${nodeId} は受理済みで、止める裏のセッションの依頼を作れない（起動の報告がない・まだ報告のない依頼がある）`,
            "受信箱（inbox_fetch）で、親への依頼の項目を確かめる",
            "状態を確認する",
          );
        }
        if (bodies.length > 0) {
          const r = appendAtomically(log, clock, req.requestId, { nodeId: callerOf(req) }, bodies);
          if (!r.ok) return r;
        }
        return { ok: true, value: { state: "verified" } };
      }
      // 停止未完了からの要求は、再試行（即時停止）として記録する。
      const event: NodeEvent =
        node.state === "stopIncomplete"
          ? { type: "retryStop" }
          : { type: "stop", mode, ...(graceMs === undefined ? {} : { graceMs }) };
      const t = transition(node.state, event);
      if (!t.ok)
        return { ok: false, error: failure(t.error.code, t.error.cause, ...t.error.nextActions) };
      const effect = t.value.effect;
      if (graceMs !== undefined && effect !== "gracefulStop") {
        return fail(
          "graceMsNotApplicable",
          "graceMs は、新しく始める穏当な停止（graceful）のときだけ指定できる（停止中・起動前の取り消し・即時停止では効かない）",
          "graceMs を省略する",
        );
      }
      const adapter = adapterFor(nodeId);
      if (effect !== "cancelStart" && adapter === undefined) return noRuntime(nodeId);

      // サブ統括（統合ノード）の停止は、配下の子を先に停止の依頼に載せる（連動停止。#168 PR5。後順: 孫が先、サブ統括が後）。
      // 自分の記録より前に、子の検査を済ませる（子を止められないときに、一部だけ止めた状態を残さない）。再送（効果なし）では何もしない。
      const waitIds: string[] = [];
      if (node.role === "integrator" && (effect === "gracefulStop" || effect === "immediateStop")) {
        const kids = before.nodes.filter((c) => isDirectChild(before.nodes, nodeId, c.id));
        for (const kid of kids) {
          const needsAdapter = CASCADE_STOP.has(kid.state) && kid.state !== "pending";
          if (needsAdapter && adapterFor(kid.id) === undefined) return noRuntime(kid.id);
        }
        for (const kid of kids) {
          if (CASCADE_WAIT.has(kid.state)) {
            // すでに停止の途中（確認待ち）。依頼を出し直さず、確認だけを待つ（再試行でも、先の依頼の確認を待つ）。
            waitIds.push(kid.id);
          } else if (CASCADE_STOP.has(kid.state)) {
            const stopped = stopSelf({
              requestId: `${req.requestId}/cascade/${kid.id}`,
              operation: "node.stop",
              role: "integrator",
              caller: { nodeId },
              params: {
                nodeId: kid.id,
                mode,
                ...(mode === "graceful" && graceMs !== undefined && kid.state !== "pending"
                  ? { graceMs }
                  : {}),
              },
            } as HandlerRequest<"node.stop">);
            if (!stopped.ok) return stopped;
            waitIds.push(kid.id);
          } else if (kid.state === "verified") {
            // 受理済みの子は、状態を変えずに、裏のセッションの停止の依頼を出し直す（#115 の既存の規則）。確認は待たない。
            const bodies = sessionStopBodies(before, kid.id, `${req.requestId}/cascade/${kid.id}`);
            if (bodies.length > 0) {
              const done = appendAtomically(
                log,
                clock,
                `${req.requestId}/cascade/${kid.id}`,
                { nodeId },
                bodies,
              );
              if (!done.ok) return done;
            }
          }
          // done（人だけが止められる。#115）・停止済み・回収可能・アーカイブの子は、対象にしない。
        }
      }

      const r = appendAtomically(log, clock, req.requestId, actor, [
        { type: "node.stateChanged", payload: { nodeId, event } },
      ]);
      if (!r.ok) return r;
      const after = r.value.state;

      // 停止の進行はアダプタが行う。起動前の取り消し・進行中の穏当な停止の再送（効果なし）は、アダプタを呼ばない。
      if (adapter !== undefined && (effect === "gracefulStop" || effect === "immediateStop")) {
        // 停止の試行は、追記の結果の seq でとる（追記のあとに別の記録が入っても、ずれない。NFR_002）。
        // 新しい試行にならない要求（猶予中の即時への切り替え）は、進行中の試行（そのノードの最後の停止要求）を使う。
        const stopSeq = r.value.events[0]?.seq;
        if (stopSeq === undefined)
          return fail("internal", "記録した停止の要求の番号を取得できない", "もう一度試す");
        const attempt =
          after.stopRequests.find((q) => q.seq === stopSeq && q.nodeId === nodeId) ??
          [...after.stopRequests].reverse().find((q) => q.nodeId === nodeId && q.seq < stopSeq);
        if (attempt !== undefined) {
          const adapterMode = effect === "immediateStop" ? "immediate" : "graceful";
          // 配下の子の停止がすべて確認されてから、自分のセッションの停止を始める（停止未完了にすると、統合の資格が失効し、
          // 孫の停止の依頼を実行できなくなる）。確認できなければ、停止未完了にして、理由（子の ID と状態）を受信箱に出す。
          const stopSelfSession = (): Promise<Result<StopValue, Failure>> =>
            adapter.stop(nodeId, {
              mode: adapterMode,
              stopSeq: attempt.seq,
              ...(adapterMode === "graceful" && attempt.graceMs !== undefined
                ? { graceMs: attempt.graceMs }
                : {}),
            });
          const stopAfterChildren = async (): Promise<Result<StopValue, Failure>> => {
            const unconfirmed = await waitChildrenStopped(waitIds);
            if (unconfirmed.length > 0) {
              return fail(
                "stopFailed",
                `配下の子の停止を確認できない: ${unconfirmed.join("、")}`,
                "子ごとに、親のセッションで claude stop を実行したか確かめ、node_confirmStopped で宣言する",
                "そのあと、このノードを node_stop で止め直す",
              );
            }
            return stopSelfSession();
          };
          // 待つ子がなければ（子のない統合ノード・子のいる子ではないノード）、これまでと同じ経路で、すぐに停止を始める。
          void (waitIds.length === 0 ? stopSelfSession() : stopAfterChildren())
            .then(
              (result) => notifySettled(nodeId, attempt.seq, result),
              (error: unknown) =>
                notifySettled(
                  nodeId,
                  attempt.seq,
                  fail(
                    "stopFailed",
                    `停止の処理が例外: ${String(error)}`,
                    "ノードの状態を確認する",
                  ),
                ),
            )
            .catch(() => undefined);
        }
      }
      return { ok: true, value: { state: stateOf(after, nodeId) as NodeState } };
    },

    /**
     * 停止の宣言（FR_036）。能力表の `stopDelegated` のノードだけ。1 トランザクションで、宣言（`node.stopDeclared`。宣言者は
     * 封筒の actor）・`confirmStopped`（stopIncomplete → stopped）・そのノードの未解決の stopIncomplete の項目（代行依頼）の解決・
     * 受信箱の info を記録する。同じ requestId の再送は、同じ結果（記録は 1 回）。
     */
    "node.confirmStopped": (
      req: HandlerRequest<"node.confirmStopped">,
    ): R<"node.confirmStopped"> => {
      const { nodeId, note } = req.params;
      const human = req.role === "human";
      if (!human) {
        const outside = outsideSubtree(callerOf(req), nodeId);
        if (outside) return outside;
      }
      const state = log.state();
      const node = nodeOf(state, nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      const actor = human ? ({ human: true } as const) : { nodeId: callerOf(req) };
      // 同じ要求の再送は、記録済みの結果（今の状態）を返す。
      if (alreadyApplied(state, actor, req.requestId))
        return { ok: true, value: { state: stateOf(state, nodeId) as NodeState } };
      const adapter = adapterFor(nodeId);
      if (adapter?.capabilities(nodeId).stopDelegated !== true) {
        return fail(
          "notDelegated",
          `ノード ${nodeId} は daemon が直接止めるノードで、停止を宣言できない（能力表の stopDelegated のノードだけ）`,
          "node.stop で停止を再試行する",
        );
      }
      if (node.state !== "stopIncomplete") {
        return fail(
          "invalidTransition",
          `ノード ${nodeId} は ${node.state} で、停止を宣言できない（stopIncomplete のとき）`,
          "ノードの状態を確認する",
        );
      }
      const bodies: EventBody[] = [
        { type: "node.stopDeclared", payload: { nodeId, ...(note === undefined ? {} : { note }) } },
        { type: "node.stateChanged", payload: { nodeId, event: { type: "confirmStopped" } } },
        ...state.inbox
          .filter(
            (i) => i.kind === "stopIncomplete" && i.nodeId === nodeId && i.resolved === undefined,
          )
          .map((i): EventBody => ({ type: "inbox.resolved", payload: { itemId: i.id } })),
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", human ? "human" : callerOf(req), req.requestId, "declared"),
            kind: "info",
            nodeId,
            ...(human
              ? note === undefined
                ? notice("stopDeclaredHuman", {})
                : notice("stopDeclaredHumanNote", { note })
              : note === undefined
                ? notice("stopDeclaredNode", { by: callerOf(req) })
                : notice("stopDeclaredNodeNote", { by: callerOf(req), note })),
          },
        },
      ];
      const r = appendAtomically(log, clock, req.requestId, actor, bodies);
      if (!r.ok) return r;
      try {
        adapter.release?.(nodeId);
      } catch {
        // 管理から外す処理の失敗は、宣言の記録を取り消さない
      }
      return { ok: true, value: { state: stateOf(r.value.state, nodeId) as NodeState } };
    },

    "node.capabilities": (req: HandlerRequest<"node.capabilities">): R<"node.capabilities"> => {
      const outside = outsideSubtree(callerOf(req), req.params.nodeId);
      if (outside) return outside;
      const state = log.state();
      const node = nodeOf(state, req.params.nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      return {
        ok: true,
        value: { operations: operationsFor(node, adapterFor(node.id), callerOf(req), state.nodes) },
      };
    },
  };
  stopSelf = handlers["node.stop"];
  return handlers;
}
