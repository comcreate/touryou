/**
 * イベントログだけで完結する操作の実体（アダプタを使わない）: 一覧表・受信箱の取得、子の報告、判断要求と回答、
 * 完了の判定。権限と部分木の判定は、認可（`authorize`）で済んでいる前提で、ここでは状態の整合を確かめる。
 * PRD: FR_011, FR_012, FR_018, FR_019, FR_020, FR_022, FR_024
 *
 * - 受信箱・一覧は、呼び出した統合ノードの部分木に絞る（`visibleState`）。
 * - 複数イベントの操作は、事前に全体を検査してから追記する（`appendAtomically`）。再試行は冪等。
 * - 子の報告は、動作中（running・waiting・stopping）のノードだけ。
 * - `decision.present` の `pauseNodeIds`（子の一時停止）は、`allowPause` のときだけ受け付ける（止める・再開するのは `pause-handlers`）。
 */

import {
  type EventBody,
  type Failure,
  type NodeState,
  type OperationMap,
  type OrchState,
  type Result,
  stateOf,
  titleOf,
  unresolvedInbox,
  visibleState,
} from "@touryou/core";
import type { PluginDirPorts } from "../../sdk/plugin-dir.js";
import type { HandlerRequest } from "../server.js";
import { unquote } from "./child-inbox-handlers.js";
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
import { type InstructionDelivery, wasNotified } from "./instruction-delivery.js";
import { sessionStopBodies, sessionStopDeferredBodies } from "./parent-request-handlers.js";
import { resolveStaleInbox } from "./stale-inbox.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface StateHandlerDeps {
  readonly log: LogPort;
  /** 子に付ける plugin の場所の確かめ（`parent-request-handlers` が使う）。 */
  readonly pluginDir?: PluginDirPorts;
  /** イベントの時刻（ISO 8601 UTC）。事前検査にも使う。 */
  readonly clock: () => string;
  /**
   * `decision.present` の `pauseNodeIds`（子の一時停止）を受け付ける。止める操作と、回答での再開は、`pause-handlers`
   * が包んで行う。包まないときは false のまま（記録だけして止めない・再開しない、を避けるため notSupported）。
   */
  readonly allowPause?: boolean;
  /** 差し戻しの理由（追加指示）を子へ届ける。省略すると、記録だけを行う。 */
  readonly deliver?: InstructionDelivery["deliver"];
  /** 届ける手段（アダプタ）があるか。`deliver` を渡すときは、差し戻しを記録する前に確かめる。 */
  readonly canDeliver?: InstructionDelivery["available"];
  /**
   * CLI の子（SSE の購読で指示を受け取る子）か。Desktop の子（紐付け）は、購読でなく受信箱・フックで
   * 受け取るので対象外。差し戻しのとき、CLI の子で購読がなければ、指示がすぐには届かないことを親に知らせる。
   */
  readonly isCliChild?: (nodeId: string) => boolean;
  /**
   * そのノードの購読（`GET /v1/events?node=`）が、いま 1 本でもあるか。sse-hub にしか分からないので、
   * compose が後から結ぶ（handlers は server より先に作られる）。分からないとき（未結線）は true とみなし、知らせない。
   */
  readonly hasSubscription?: (nodeId: string) => boolean;
  /** 記録できなかったときの 1 行のログ（reject-nosub の知らせなど）。 */
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

const ACTIVE: ReadonlySet<NodeState> = new Set(["running", "waiting", "stopping"]);

const callerOf = (req: HandlerRequest): string => req.caller?.nodeId ?? "";

export function createStateHandlers(deps: StateHandlerDeps) {
  const { log, clock } = deps;
  const exclusive = createExclusive();

  const notActive = (nodeId: string, state: NodeState | undefined) =>
    fail(
      "notActive",
      `ノード ${nodeId} は ${state ?? "不明"} で、報告できない（running・waiting・stopping のとき）`,
      "状態を確認する",
    );

  /** 報告の保存と、受信箱の項目。 */
  const reportOnly =
    (kind: "progress" | "outOfScope", inboxKind: "progress" | "info") =>
    (req: HandlerRequest<"report.progress" | "report.outOfScope">): R<"report.progress"> => {
      const caller = callerOf(req);
      const state = log.state();
      if (
        !alreadyApplied(state, { nodeId: caller }, req.requestId) &&
        !ACTIVE.has(stateOf(state, caller) as NodeState)
      ) {
        return notActive(caller, stateOf(state, caller));
      }
      const reportId = deriveId("report", caller, req.requestId, "report");
      const text = req.params.text;
      const bodies: EventBody[] = [
        { type: "report.added", payload: { reportId, nodeId: caller, kind, text } },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", caller, req.requestId, "inbox"),
            kind: inboxKind,
            nodeId: caller,
            summary: summarize(text),
            ref: reportId,
          },
        },
      ];
      const r = appendAtomically(log, clock, req.requestId, { nodeId: caller }, bodies);
      return r.ok ? { ok: true, value: { accepted: true } } : r;
    };

  const reviewOnce = async (req: HandlerRequest<"node.review">): Promise<R<"node.review">> => {
    const caller = callerOf(req);
    const { nodeId, verdict } = req.params;
    const human = req.role === "human";
    // 人間は、受理（done → verified。片付けのため）だけができる。差し戻しは、親だけ（届け先の指示を書けるのは親）。
    if (human && verdict !== "accept") {
      return fail(
        "forbidden",
        "人間ができる完了の判定は、受理（accept）だけ",
        "差し戻しは、親の統合ノードに依頼する",
      );
    }
    if (human && log.state().nodes.find((n) => n.id === nodeId) === undefined) {
      return fail("notFound", "ノードが見つからない", "ID を確認する");
    }
    // 認可（directChild）の二重の備え: 完了の判定は、そのノードの親だけ（人間を除く）。
    if (!human && log.state().nodes.find((n) => n.id === nodeId)?.parentId !== caller) {
      return fail(
        "forbidden",
        "完了の判定は、そのノードの親（統合ノード）だけができる",
        "親の統合ノードに依頼する",
      );
    }
    // 差し戻しの理由を届ける手段がなければ、記録する前に失敗させる（記録だけが残らないように）。
    if (
      req.params.verdict === "reject" &&
      deps.deliver !== undefined &&
      deps.canDeliver?.(nodeId) === false
    ) {
      return fail(
        "noRuntime",
        `ノード ${nodeId} のランタイム（アダプタ）が見つからず、差し戻しの理由を届けられない`,
        "ノードの状態を確認する",
      );
    }
    const bodies: EventBody[] = [
      {
        type: "node.stateChanged",
        payload: { nodeId, event: { type: verdict === "accept" ? "accept" : "reject" } },
      },
    ];
    // 受理の feedback は、報告（`review`）として記録する。差し戻しの理由は、再開した子への追加指示として記録する。
    if (req.params.verdict === "accept" && req.params.feedback !== undefined) {
      bodies.push({
        type: "report.added",
        payload: {
          reportId: deriveId("report", human ? "human" : caller, req.requestId, "review"),
          nodeId,
          kind: "review",
          text: req.params.feedback,
        },
      });
    }
    if (req.params.verdict === "reject") {
      bodies.push({ type: "node.instructed", payload: { nodeId, text: req.params.feedback } });
    }
    // 受理した子の裏のセッション（CLI の claude --bg）は、成果が受理済みなので止める。止めるのは親（受信箱の依頼。設計 6.2・Issue #3）。
    if (req.params.verdict === "accept") {
      const now = log.state();
      const stop = sessionStopBodies(now, nodeId, req.requestId);
      // まだ報告のない依頼があって出せないときは、あとで node_stop で出すよう受信箱に知らせる（セッションを残したままにしない）
      bodies.push(
        ...(stop.length > 0 ? stop : sessionStopDeferredBodies(now, nodeId, req.requestId)),
      );
    }
    const r = appendAtomically(
      log,
      clock,
      req.requestId,
      human ? ({ human: true } as const) : { nodeId: caller },
      bodies,
    );
    if (!r.ok) return r;
    // 受理した子に残る、古い停止未完了・失敗の項目は、もう対処がいらないので解決にする（失敗しても受理は成り立つ。起動時の整合が拾う）。
    if (req.params.verdict === "accept") {
      const stale = resolveStaleInbox(log, clock, `${req.requestId}/resolve-stale`, nodeId);
      if (!stale.ok) deps.onFailure?.(nodeId, `古い項目を解決にできない: ${stale.cause}`);
    }
    // 差し戻しの理由を、再開した子へ届ける（未配送のときだけ。再送で、送り直せる）。
    if (req.params.verdict === "reject" && deps.deliver !== undefined) {
      const seq = r.value.events[1]?.seq;
      if (seq !== undefined && !wasNotified(deps.log, r.value.state, seq)) {
        const sent = await deps.deliver(nodeId, req.params.feedback, seq);
        if (!sent.ok) return sent;
      }
    }
    // CLI の子で、いま購読がないときは、差し戻しは通したうえで、指示がすぐには届かないことを親の受信箱に知らせる。
    if (
      req.params.verdict === "reject" &&
      deps.isCliChild?.(nodeId) === true &&
      deps.hasSubscription?.(nodeId) === false
    ) {
      const listed = appendAtomically(
        log,
        clock,
        `${req.requestId}/reject-nosub`,
        { system: true },
        [
          {
            type: "inbox.added",
            payload: {
              id: deriveId("inbox", "system", `${nodeId}-${req.requestId}`, "reject-nosub"),
              kind: "info",
              nodeId,
              ...notice("rejectNoSubscription", { node: nodeId }),
            },
          },
        ],
      );
      // 知らせを記録できなくても、差し戻しそのものは成り立っている（返す状態は変えない）。1 行だけ残す。
      if (!listed.ok) {
        deps.onFailure?.(nodeId, `購読なしの知らせを記録できない: ${listed.error.code}`);
      }
    }
    return { ok: true, value: { state: stateOf(r.value.state, nodeId) as NodeState } };
  };

  return {
    "tree.list": (req: HandlerRequest<"tree.list">): R<"tree.list"> => {
      // 人間は全ノード（touryou tree）。統合ノードは自分の部分木だけ（inbox.fetch と同じ）。
      const v = req.role === "human" ? log.state() : visibleState(log.state(), callerOf(req));
      const all = log.state().nodes;
      // 人間には「あなた」の印を付けない（呼び出したノードがない）。
      const me = req.role === "human" ? "" : callerOf(req);
      const openItems = (nodeId: string): number =>
        unresolvedInbox(v.inbox).filter((i) => i.nodeId === nodeId && i.kind !== "digest").length;
      // 止まった子の未回答の判断。動いていない（running・waiting・stopping でない）子の判断を数える:
      // - closed（破棄を決めた子。答えても届かない）→「届かない」
      // - open（止まった子。回答で再開する道はあるが、いまは止まっている）→「止まった子」
      const live = new Set(["running", "waiting", "stopping"]);
      const countPending = (nodeId: string): { undeliverable: number; stopped: number } => {
        const state = all.find((x) => x.id === nodeId)?.state ?? "";
        const undeliverable = v.decisions.filter(
          (d) => d.nodeId === nodeId && d.status === "closed",
        ).length;
        const stopped = live.has(state)
          ? 0
          : v.decisions.filter((d) => d.nodeId === nodeId && d.status === "open").length;
        return { undeliverable, stopped };
      };
      const pendingOf = (nodeId: string): string => {
        const { undeliverable: closed, stopped: openStopped } = countPending(nodeId);
        if (closed === 0 && openStopped === 0) return "-";
        const parts: string[] = [];
        if (closed > 0) parts.push(`${closed}（届かない）`);
        if (openStopped > 0) parts.push(`${openStopped}（止まった子）`);
        return parts.join("+");
      };
      const nodes = v.nodes.map((n) => ({
        id: n.id,
        role: n.role,
        state: n.state,
        parentId: n.parentId,
        dependsOn: [...n.dependsOn],
        openItems: openItems(n.id),
        discarded: n.discarded !== undefined,
        pendingDecisions: countPending(n.id),
        // 題は人だけに付ける（統合に、孫より下の目的を読ませないため。#115 レビュー）
        ...(req.role === "human" && titleOf(n.objective) !== ""
          ? { title: titleOf(n.objective) }
          : {}),
      }));
      const rows = v.nodes.map((n) => [
        n.id,
        n.role,
        n.state,
        n.parentId ?? "-",
        n.dependsOn.length === 0
          ? "-"
          : n.dependsOn
              .map((d) =>
                all.find((x) => x.id === d)?.discarded === undefined ? d : `${d}(破棄済み)`,
              )
              .join(","),
        pendingOf(n.id),
        // 呼び出したノード自身の行に印を付ける（自分の ID を、表から見分けるため。人間には付けない）。
        me !== "" && n.id === me ? "あなた" : "",
      ]);
      const header = ["id", "role", "state", "parent", "dependsOn", "pendingDecision", "self"];
      const widths = header.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
      );
      const line = (cells: readonly string[]): string =>
        `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;
      const sep = `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`;
      return {
        ok: true,
        value: { table: [line(header), sep, ...rows.map(line)].join("\n"), nodes },
      };
    },

    "inbox.fetch": (req: HandlerRequest<"inbox.fetch">): R<"inbox.fetch"> => {
      const since = req.params.sinceSeq ?? 0;
      // 解決済み（inbox.resolved）の項目は返さない（記録には残る）。
      // 人間は全ノード（touryou inbox）。統合ノードは自分の部分木だけ。
      const source =
        req.role === "human" ? log.state().inbox : visibleState(log.state(), callerOf(req)).inbox;
      const items = unresolvedInbox(source)
        .filter((i) => i.seq > since)
        .sort((a, b) => a.seq - b.seq);
      return { ok: true, value: { items } };
    },

    "report.progress": reportOnly("progress", "progress") as (
      req: HandlerRequest<"report.progress">,
    ) => R<"report.progress">,
    "report.outOfScope": reportOnly("outOfScope", "info") as (
      req: HandlerRequest<"report.outOfScope">,
    ) => R<"report.outOfScope">,

    "report.done": (req: HandlerRequest<"report.done">): R<"report.done"> => {
      const caller = callerOf(req);
      // 根拠は 1 件以上必須。ブリーフ（受け入れ基準）を持つノードは、すべての基準に根拠が要る。
      const criteria = log.state().nodes.find((n) => n.id === caller)?.acceptanceCriteria ?? [];
      // 子がブリーフ（引用の形）を見たまま書き写した「> …」も、元の文と同じとみなす（両側の印を外して比べる）
      const norm = (t: string): string => unquote(t.normalize("NFC").trim()).trim();
      const usable = req.params.evidence.filter((e) => norm(e.evidence) !== "");
      const covered = new Set(usable.map((e) => norm(e.criterion)));
      const missing: string[] = criteria.filter((c) => !covered.has(norm(c)));
      if (
        req.params.evidence.length === 0 ||
        usable.length !== req.params.evidence.length ||
        missing.length > 0
      ) {
        return fail(
          "evidenceRequired",
          missing.length > 0
            ? `完了報告には、すべての受け入れ基準の根拠が要る。根拠がない基準: ${missing.join("、")}`
            : "完了報告には、受け入れ基準ごとの根拠（テスト名・実行結果・コミットなど）が 1 件以上要る",
          "基準ごとに根拠（criterion に基準の文言そのまま）を添えて報告し直す",
        );
      }

      const reportId = deriveId("report", caller, req.requestId, "report");
      const evidence = req.params.evidence.map((e) => ({ ...e }));
      // 報告の文と受信箱の知らせは同じ文。画面は msg から言語を選び、msg のない古い記録は text を出す。
      const done = notice("doneReport", { count: evidence.length });
      const bodies: EventBody[] = [
        {
          type: "report.added",
          payload: {
            reportId,
            nodeId: caller,
            kind: "done",
            text: done.summary,
            msg: done.msg,
            ...(evidence.length > 0 ? { evidence } : {}),
          },
        },
        { type: "node.stateChanged", payload: { nodeId: caller, event: { type: "reportDone" } } },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", caller, req.requestId, "inbox"),
            kind: "done",
            nodeId: caller,
            ...done,
            ref: reportId,
          },
        },
      ];
      const r = appendAtomically(log, clock, req.requestId, { nodeId: caller }, bodies);
      return r.ok ? { ok: true, value: { accepted: true } } : r;
    },

    "report.decision": (req: HandlerRequest<"report.decision">): R<"report.decision"> => {
      const caller = callerOf(req);
      const decisionId = deriveId("decision", caller, req.requestId, "decision");
      const bodies: EventBody[] = [
        {
          type: "decision.requested",
          payload: {
            decisionId,
            nodeId: caller,
            question: req.params.question,
            options: [...req.params.options],
          },
        },
        {
          type: "node.stateChanged",
          payload: { nodeId: caller, event: { type: "requestDecision" } },
        },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", caller, req.requestId, "inbox"),
            kind: "decision",
            nodeId: caller,
            summary: summarize(req.params.question),
            ref: decisionId,
          },
        },
      ];
      const r = appendAtomically(log, clock, req.requestId, { nodeId: caller }, bodies);
      return r.ok ? { ok: true, value: { decisionId } } : r;
    },

    "decision.present": (req: HandlerRequest<"decision.present">): R<"decision.present"> => {
      const pauseNodeIds = req.params.pauseNodeIds ?? [];
      if (pauseNodeIds.length > 0 && deps.allowPause !== true) {
        return fail(
          "notSupported",
          "pauseNodeIds（子の一時停止）は、再開の記録先がないため、まだ使えない",
          "pauseNodeIds を省略して判断要求だけを出す",
          "止めたい子は node.stop で止める",
        );
      }
      const caller = callerOf(req);
      const decisionId = deriveId("decision", caller, req.requestId, "decision");
      const bodies: EventBody[] = [
        {
          type: "decision.requested",
          payload: {
            decisionId,
            nodeId: caller,
            question: req.params.question,
            options: [...req.params.options],
            ...(pauseNodeIds.length > 0 ? { pauseNodeIds: [...pauseNodeIds] } : {}),
          },
        },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", caller, req.requestId, "inbox"),
            kind: "decision",
            nodeId: caller,
            summary: summarize(req.params.question),
            ref: decisionId,
          },
        },
      ];
      const r = appendAtomically(log, clock, req.requestId, { nodeId: caller }, bodies);
      return r.ok ? { ok: true, value: { decisionId } } : r;
    },

    "decision.answer": (req: HandlerRequest<"decision.answer">): R<"decision.answer"> => {
      const state: OrchState = log.state();
      const p = req.params as { decisionId: string; choice?: string; text?: string };
      const d = state.decisions.find((x) => x.decisionId === p.decisionId);
      if (d === undefined) {
        return fail(
          "notFound",
          "判断要求が見つからない",
          "ID を確認する",
          "受信箱の参照 ID（ref）を確認する",
        );
      }
      // 閉じた判断（破棄を決めた子）は、答えても届かない。何も書かずに失敗を返す。
      if (d.status === "closed") {
        return fail(
          "decisionClosed",
          `この判断は閉じている（理由: ${d.closedReason === "discarded" ? "人が破棄を決めた" : (d.closedReason ?? "不明")}）。答えても届かない`,
          "子を作り直すなら、新しい子に聞き直してもらう",
        );
      }
      const answer = p.choice ?? p.text ?? "";
      if (p.choice !== undefined && d.options !== undefined && !d.options.includes(p.choice)) {
        return fail(
          "choiceNotInOptions",
          `選択肢にない回答: ${p.choice}`,
          "選択肢から選ぶ",
          "自由入力（text）で答える",
        );
      }
      const retry = alreadyApplied(state, { human: true }, req.requestId);
      if (d.status === "answered" && !retry && d.answer === answer) {
        // 採用済みの回答と同じ内容の重複は、成功として返し、却下を記録しない。
        return { ok: true, value: { accepted: true } };
      }
      if (d.status === "answered" && !retry) {
        // 後から来た回答は採用しない。却下として記録し、採用された回答を伝える（FR_019）。
        appendAtomically(log, clock, req.requestId, { human: true }, [
          { type: "decision.answered", payload: { decisionId: d.decisionId, answer } },
        ]);
        return fail(
          "alreadyAnswered",
          `既に回答されている（採用された回答: ${d.answer ?? ""}）`,
          "採用された回答を確認する（decision.get）",
        );
      }
      if (retry && d.answer !== answer) {
        return fail(
          "alreadyAnswered",
          `既に別の回答が採用されている（採用された回答: ${d.answer ?? ""}）`,
          "採用された回答を確認する（decision.get）",
        );
      }
      const waiting = stateOf(state, d.nodeId) === "waiting";
      // 再試行でも同じ番号になるよう、任意の再開は最後に置く。
      const bodies: EventBody[] = [
        { type: "decision.answered", payload: { decisionId: d.decisionId, answer } },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", "human", req.requestId, "inbox"),
            kind: "answer",
            nodeId: d.nodeId,
            summary: summarize(answer),
            ref: d.decisionId,
          },
        },
        ...(waiting
          ? ([
              {
                type: "node.stateChanged",
                payload: { nodeId: d.nodeId, event: { type: "resume" } },
              },
            ] as const)
          : []),
      ];
      const r = appendAtomically(log, clock, req.requestId, { human: true }, bodies);
      return r.ok ? { ok: true, value: { accepted: true } } : r;
    },

    // 同じ requestId の同時の判定は、1 つにまとめる（配送が 1 回だけになる）。
    "node.review": (req: HandlerRequest<"node.review">): Promise<R<"node.review">> =>
      exclusive(
        `${req.role === "human" ? "human" : callerOf(req)}\0${req.requestId}`,
        JSON.stringify(req.params),
        () => reviewOnce(req),
      ),
  };
}
