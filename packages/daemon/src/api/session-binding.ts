/**
 * 紐付けで結んだ「session_id → ノード」の対応（フックの受け口が使う）。
 *
 * - 記録するのは、`POST /v1/bind` で、正しい紐付けのコード（一回限り）で紐付けたときだけ（`bound` は、bind の成功の後にだけ呼ぶ）。
 *   コードなしで session_id だけを結ぶ道はない。記録はイベントログ（`node.sessionBound`）に残すので、再起動のあとでも引ける。
 * - **`lookupNodeBySession` で引いた結果は、信頼度の低い報告にしか使わない**: 受信箱への知らせと、本人への範囲の判定の答えだけ。
 *   状態を変える op の認証には使わない（session_id は秘密ではないため）。資格情報（トークン）は返さない。
 * - `onBound`: 紐付けが成功したときに呼ばれる入口（いまは使い手がない。SessionStart の仮の登録は、偽の登録で勝てるため採らない）。ここで呼ばれるのも、
 *   正しいコードで紐付けたときだけ。
 */

import { isSessionId, type OrchState } from "@touryou/core";
import type { LogPort } from "./handlers/context.js";

export interface BoundInfo {
  readonly sessionId?: string;
  /** 子のセッションの作業ディレクトリ（mcp が送ったもの。作業ツリーの確認を通ったもの）。 */
  readonly cwd?: string;
}

/** `lookupNodeBySession` の結果。`trust: "sessionIdOnly"`: トークンなし・session_id（秘密ではない）だけで引いたもの。 */
export interface SessionLookup {
  readonly nodeId: string;
  readonly worktree: string | undefined;
  readonly trust: "sessionIdOnly";
}

/** 終わったノード（session_id で引かない・結び付けの重なりに数えない）。 */
const ENDED: ReadonlySet<string> = new Set(["stopped", "reclaimable", "archived"]);

export interface SessionBindings {
  /** bind の成功の後にだけ呼ぶ。session_id があれば記録し、`onBound` の入口を呼ぶ。記録の失敗は例外にしない（false を返す）。 */
  bound(nodeId: string, info: BoundInfo): boolean;
  /**
   * session_id から、ノードと作業ツリーを引く（信頼度の低い報告にだけ使う。トークンは返さない）。終わったノード
   * （stopped・reclaimable・archived）は引かない。結果の `trust` は、呼び出し側が記録の行為者に写す（型で縛る）。
   */
  lookupNodeBySession(sessionId: string): Promise<SessionLookup | undefined>;
  /**
   * 紐付けの前（コードを消費する前）に呼ぶ。ほかの生きているノードに、同じ session_id が結ばれていれば真（bind を拒む）。
   * session_id は自己申告なので、別のノードのものを名乗って結び替えられないようにする。
   */
  conflicts(nodeId: string, sessionId: string): boolean;
  /**
   * つなぎ直し（コードなし。#145）の前に呼ぶ。記録（`node.sessionBound`）にあるそのノードの session_id が、渡されたものと一致し、
   * ノードが終わっていなければ真。記録は、正しいコードでの紐付けでだけ作られる（ここでは作らない）。
   */
  matches(nodeId: string, sessionId: string): boolean;
  /** 紐付けの成功を受け取る入口を足す。外す関数を返す。 */
  onBound(fn: (nodeId: string, info: BoundInfo) => void): () => void;
}

export interface SessionBindingDeps {
  readonly log: Pick<LogPort, "append" | "state">;
  readonly cwdOf: (nodeId: string) => Promise<string | undefined>;
  /** 記録の requestId（重複しないもの）。 */
  readonly newRequestId?: () => string;
}

let seq = 0;

export function createSessionBindings(deps: SessionBindingDeps): SessionBindings {
  const listeners = new Set<(nodeId: string, info: BoundInfo) => void>();
  const newRequestId =
    deps.newRequestId ?? (() => `session-bound-${Date.now().toString(36)}-${(++seq).toString(36)}`);
  const live = (state: OrchState, sessionId: string) =>
    state.nodes.filter((n) => n.sessionId === sessionId && !ENDED.has(n.state));
  const find = (state: OrchState, sessionId: string) => {
    // 同じ session_id が 2 つ以上の生きているノードに結ばれていたら、どれとも決めない（引かない）
    const hits = live(state, sessionId);
    return hits.length === 1 ? hits[0] : undefined;
  };
  return {
    bound(nodeId, info) {
      let ok = true;
      if (info.sessionId !== undefined && isSessionId(info.sessionId)) {
        const r = deps.log.append({
          requestId: newRequestId(),
          actor: { system: true },
          body: { type: "node.sessionBound", payload: { nodeId, sessionId: info.sessionId } },
        });
        ok = r.ok;
      }
      for (const fn of listeners) {
        try {
          fn(nodeId, info);
        } catch {
          // 入口の失敗で、紐付けの結果を変えない
        }
      }
      return ok;
    },
    async lookupNodeBySession(sessionId) {
      if (!isSessionId(sessionId)) return undefined;
      const node = find(deps.log.state(), sessionId);
      if (node === undefined) return undefined;
      const worktree = await deps.cwdOf(node.id).catch(() => undefined);
      return { nodeId: node.id, worktree, trust: "sessionIdOnly" as const };
    },
    conflicts(nodeId, sessionId) {
      return live(deps.log.state(), sessionId).some((n) => n.id !== nodeId);
    },
    matches(nodeId, sessionId) {
      return deps.log
        .state()
        .nodes.some((n) => n.id === nodeId && n.sessionId === sessionId && !ENDED.has(n.state));
    },
    onBound(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
