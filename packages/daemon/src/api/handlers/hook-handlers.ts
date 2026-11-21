/**
 * フックの受け口（`POST /v1/hook`）の session_id の結び付けを外す操作（`node.hookUnbind`）。
 * PRD: FR_014, IR_002 / `docs/plugin.md` の「フック」
 *
 * - 人間と、祖先の統合ノード（自分を含まない子孫が対象）だけ。子のトークンは、操作の表（ROLE_OPERATIONS）にないので、窓口で 403。
 *   本人が外せると、盗まれたトークンで外して、別のセッションで結び直せてしまう。
 * - 記録（`node.hookUnbound`。外した者は actor）に成功してから外す（記録できなければ、外さない）。記録と外す処理は同期の処理の
 *   中で続けて行うので、その間に別のセッションが結ぶことはない。session_id は記録に書かない。
 * - 同じ requestId の再送は、もう一度は外さない（再送のあいだに結んだ、新しいセッションを外さないため）。結果は `{ unbound: false, duplicate: true }`。
 */

import {
  type Failure,
  type InboxMessageKey,
  isPrefaceInstruction,
  isStrictDescendant,
  type OperationMap,
  type OrchState,
  type Result,
  stateOf,
} from "@touryou/core";
import { awaitingHuman } from "../../cli-watch.js";
import { type HookTokens, type SessionBinder, sessionActor } from "../hook.js";
import type { HandlerRequest } from "../server.js";
import {
  alreadyApplied,
  appendAtomically,
  derivedRequestId,
  deriveId,
  fail,
  type LogPort,
  notice,
  summarize,
} from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface HookHandlerDeps {
  readonly log: LogPort;
  readonly sessions: SessionBinder;
  /** フック専用のトークン。`childRuntime: "cli"` のときだけ渡す（省略すると `node.hookToken` は notCli）。 */
  readonly hookTokens?: HookTokens;
  /** daemon が管理している（起動した）子か。 */
  readonly managed?: (nodeId: string) => boolean;
  /** 窓口の URL（待ち受けの前は undefined）。 */
  readonly baseUrl?: () => string | undefined;
  /** Desktop の木か（`node.hookToken` は拒否する。子の引き出しの hook-token を無効にしてしまうため）。 */
  readonly desktop?: boolean;
}

const LIVE = new Set(["running", "waiting"]);

export function createHookHandlers(deps: HookHandlerDeps) {
  const { log, sessions } = deps;
  return {
    "node.hookUnbind": (req: HandlerRequest<"node.hookUnbind">): R<"node.hookUnbind"> => {
      const { nodeId } = req.params;
      const human = req.role === "human";
      const caller = req.caller?.nodeId ?? "";
      const state = log.state();
      if (!human && !isStrictDescendant(state.nodes, caller, nodeId)) {
        return fail(
          "forbidden",
          "対象のノードが、自分の部分木の規則（自分を含まない子孫）を満たさない",
          "親（統合ノード）か人間に依頼する",
        );
      }
      if (!state.nodes.some((n) => n.id === nodeId)) {
        return fail("notFound", "ノードが見つからない", "ID を確認する");
      }
      const actor = human ? ({ human: true } as const) : { nodeId: caller };
      if (alreadyApplied(state, actor, req.requestId))
        return { ok: true, value: { unbound: false, duplicate: true } };
      const hadBinding = sessions.has(nodeId);
      const r = log.append({
        requestId: derivedRequestId(actor, req.requestId, 0),
        actor,
        body: { type: "node.hookUnbound", payload: { nodeId, hadBinding } },
      });
      if (!r.ok) return fail(r.error.code, r.error.cause, ...r.error.nextActions);
      return { ok: true, value: { unbound: sessions.unbind(nodeId), duplicate: false } };
    },

    /**
     * 手動の CLI セッション用の、フック専用のトークン。人間だけ（操作の表で、統合ノード・子は 403。ここでも確かめる）。
     * 記録（`node.hookTokenIssued`。トークンは書かない）に成功してから発行し、古いフック用トークンを無効にして、結び付けを外す。
     * 同じ requestId の再送は、新しいトークンを発行する（トークンを保存しないので、前の応答を返せない。記録は 1 回）。
     */
    "node.hookToken": (req: HandlerRequest<"node.hookToken">): R<"node.hookToken"> => {
      const { nodeId } = req.params;
      if (req.role !== "human") {
        return fail(
          "forbidden",
          "フック専用のトークンは、人間だけが発行できる",
          "人間のトークンで呼び出す",
        );
      }
      if (deps.desktop === true) {
        return fail(
          "desktopHookEnvNotAllowed",
          "Desktop の木では、touryou hook-env（フック専用のトークンの発行）は使えない（子の引き出しの見張りのトークンを無効にしてしまう）",
          "Desktop の子の見張りのトークンは、親か人が node.bindCode を出し直すと新しくなる",
        );
      }
      const tokens = deps.hookTokens;
      if (tokens === undefined) {
        return fail(
          "notCli",
          "この木の子は CLI の子ではない（設定 childRuntime が cli のときだけ）",
          "Desktop の子の紐付けは node.bindCode を使う",
        );
      }
      const state = log.state();
      const node = state.nodes.find((n) => n.id === nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      if (node.role === "integrator") {
        return fail(
          "integratorNotSupported",
          `ノード ${nodeId} は統合ノードで、フック専用のトークンは発行できない（子だけ）`,
          "作業の子のノード ID を指定する",
        );
      }
      const s = stateOf(state, nodeId);
      if (s === undefined || !LIVE.has(s)) {
        return fail(
          "notActive",
          `ノード ${nodeId} は ${String(s)} で、発行できない（running・waiting のとき）`,
          "ノードの状態を確認する",
        );
      }
      if (deps.managed !== undefined && !deps.managed(nodeId)) {
        return fail(
          "notManaged",
          `ノード ${nodeId} を、daemon が管理していない（daemon の再起動のあとなど。範囲と作業ツリーがない）`,
          "ノードの状態を確認する",
        );
      }
      const daemonUrl = deps.baseUrl?.();
      if (daemonUrl === undefined) {
        return fail("unavailable", "窓口がまだ待ち受けていない", "少し待って、もう一度呼び出す");
      }
      const actor = { human: true } as const;
      if (!alreadyApplied(state, actor, req.requestId)) {
        const r = log.append({
          requestId: derivedRequestId(actor, req.requestId, 0),
          actor,
          body: { type: "node.hookTokenIssued", payload: { nodeId } },
        });
        if (!r.ok) return fail(r.error.code, r.error.cause, ...r.error.nextActions);
      }
      // 古いトークンを無効にしてから（issue が置き換える）、同じ同期の処理の中で結び付けを外す
      const token = tokens.issue(nodeId);
      sessions.unbind(nodeId);
      return { ok: true, value: { token, nodeId, daemonUrl } };
    },
  };
}

/**
 * フックの Notification・Stop（設計 6.2 の「止まったことの検出」(1) と 6.2b の逃げ道）。
 * 判定の中身（hook-policy.ts）とは別で、`POST /v1/hook` の入口から呼ぶ。紐付けたノードだけが対象（紐付けの前のセッションは、入口で何もしない）。
 *
 * 入力の形は公式の文書（hooks の Notification・Stop の節）に従う:
 * - Notification: `message`・`title`（省略あり）・`notification_type`。止められない（終了コード・出力は無視される）。
 * - Stop: `stop_hook_active`（フックで続けている最中なら true）。続けさせるのは `decision: "block"` か
 *   `hookSpecificOutput.additionalContext`。ここでは後者（エラーの表示にならない）を返す。
 */

/** 「入力待ち」として受信箱に出す notification_type。ほか（auth_success など）は何もしない。 */
export const NEEDS_INPUT_TYPES: ReadonlySet<string> = new Set([
  "permission_prompt",
  "idle_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);

/** 入力待ちの種類の言葉（#140。鍵は core の知らせの表。画面が言語に合わせる）。 */
const NEEDS_INPUT_LABEL: Readonly<Record<string, InboxMessageKey>> = {
  permission_prompt: "labelPermissionPrompt",
  idle_prompt: "labelIdlePrompt",
  elicitation_dialog: "labelElicitationDialog",
  elicitation_url_dialog: "labelElicitationUrlDialog",
  agent_needs_input: "labelAgentNeedsInput",
};

export interface NotificationInput {
  readonly notificationType: string;
  readonly message?: string;
  readonly title?: string;
}

/**
 * Notification を受けて、入力待ちの種類なら受信箱に出す（同じノード・種類・番は 1 件）。出したら真。
 * 失敗しても例外は出さない（Notification のフックは止められないので、呼んだ側には常に allow を返す）。
 */
/** 同じノードの入力待ちを抑える時間（直近にあれば足さない）。 */
export const NEEDS_INPUT_WINDOW_MS = 10 * 60_000;
/** ノードごとの 1 日（UTC の日付）の上限。超えたら 1 回だけ「多すぎるので止めた」を出す。 */
export const NEEDS_INPUT_DAILY_MAX = 50;

/**
 * 入力待ちの知らせの間引き。daemon が自分で出した知らせだけを、メモリの中で数える（受信箱の文字列は見ない。子の報告や
 * 偽の Notification で真似られないように）。daemon を再起動すると数え直す。
 */
export interface NeedsInputThrottle {
  /** 足してよいなら "add"、上限を超えた最初の 1 回は "overflow"、それ以外は "skip"。足す・知らせるときは、数え上げを進める。 */
  take(nodeId: string, nowMs: number, day: string): "add" | "overflow" | "skip";
}

export function createNeedsInputThrottle(): NeedsInputThrottle {
  const byNode = new Map<
    string,
    { lastMs: number; day: string; count: number; overflow: boolean }
  >();
  return {
    take(nodeId, nowMs, day) {
      const cur = byNode.get(nodeId);
      const v =
        cur === undefined || cur.day !== day
          ? { lastMs: Number.NEGATIVE_INFINITY, day, count: 0, overflow: false }
          : cur;
      byNode.set(nodeId, v);
      if (nowMs - v.lastMs < NEEDS_INPUT_WINDOW_MS) return "skip";
      if (v.count >= NEEDS_INPUT_DAILY_MAX) {
        if (v.overflow) return "skip";
        v.overflow = true;
        return "overflow";
      }
      v.count += 1;
      v.lastMs = nowMs;
      return "add";
    },
  };
}

/**
 * Notification を受けて、入力待ちの種類なら受信箱に出す。同じノードは、直近 10 分に出していれば足さない。1 日の上限を超えたら、
 * 1 回だけ「多すぎるので止めた」を出す。出したら真。失敗しても例外は出さない（Notification のフックは止められない）。
 */
export function reportNeedsInput(
  deps: {
    readonly log: LogPort;
    readonly clock: () => string;
    readonly throttle: NeedsInputThrottle;
  },
  nodeId: string,
  n: NotificationInput,
  /** トークンのない（session_id で引いた）報告か。記録の行為者に写し、「かもしれない」と書く。 */
  trust?: "sessionIdOnly",
): boolean {
  if (!NEEDS_INPUT_TYPES.has(n.notificationType)) return false;
  // 判断・範囲の頼みの答えを待っているだけの子には出さない（cli-watch と同じ決め方・#131）
  if (awaitingHuman(deps.log.state(), nodeId)) return false;
  const at = deps.clock();
  const nowMs = Date.parse(at);
  if (Number.isNaN(nowMs)) return false;
  // 窓と上限は、トークンつきの報告と session_id で引いた報告で分ける（偽のものが本物を抑えられないように）
  const verdict = deps.throttle.take(`${nodeId}\0${trust ?? "token"}`, nowMs, at.slice(0, 10));
  if (verdict === "skip") return false;
  const key = `needs-input/${nodeId}/${at}`;
  // 知らない種類は、種類の名前をそのまま出す
  const labelKey = Object.hasOwn(NEEDS_INPUT_LABEL, n.notificationType)
    ? NEEDS_INPUT_LABEL[n.notificationType]
    : undefined;
  const label = labelKey === undefined ? { label: n.notificationType } : { labelKey };
  // session_id で引いた報告（秘密でない session_id だけで名乗れる）は、本文（message）を受信箱に入れない。種類だけ（注入の通り道を塞ぐ）
  const detail = n.message === undefined || trust !== undefined ? undefined : n.message;
  const actor = trust === undefined ? ({ system: true } as const) : sessionActor(trust);
  const text =
    verdict === "overflow"
      ? notice("needsInputOverflow", { node: nodeId, max: NEEDS_INPUT_DAILY_MAX })
      : trust !== undefined
        ? notice("needsInputMaybe", { node: nodeId, ...label })
        : detail === undefined
          ? notice("needsInput", { node: nodeId, ...label })
          : notice("needsInputDetail", { node: nodeId, ...label, detail });
  const r = appendAtomically(deps.log, deps.clock, key, actor, [
    {
      type: "inbox.added",
      payload: {
        id: deriveId(
          "inbox",
          "system",
          key,
          verdict === "overflow" ? "needs-input-overflow" : "needs-input",
        ),
        kind: "info",
        nodeId,
        ...text,
      },
    },
  ]);
  return r.ok;
}

/** 子に届いていない知らせ（配送の記録がない追加の指示）の数。 */
export const pendingForChild = (state: OrchState, nodeId: string): number =>
  state.instructions.filter(
    (i) => i.nodeId === nodeId && i.deliveredSeq === undefined && !isPrefaceInstruction(i),
  ).length;

export type StopOutcome =
  | { readonly decision: "allow" }
  | { readonly decision: "continue"; readonly reason: string };

/**
 * Stop（番の終わり）: 子の受信箱に未読があれば、続けて読むよう促す。フックで続けている最中（stop_hook_active）は、
 * 同じことを繰り返さないよう、促さない（子が読まないままでも、番を終われる）。
 */
export function stopOutcome(
  state: OrchState,
  nodeId: string,
  stopHookActive: boolean,
): StopOutcome {
  if (stopHookActive) return { decision: "allow" };
  const n = pendingForChild(state, nodeId);
  if (n === 0) return { decision: "allow" };
  return {
    decision: "continue",
    reason: `touryou の受信箱に、まだ読んでいない知らせが ${n} 件ある。inbox_fetch で読んで、書かれた手順に従う。`,
  };
}
