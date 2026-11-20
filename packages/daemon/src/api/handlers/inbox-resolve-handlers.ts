/**
 * 受信箱の項目を、人が片付ける・戻す（`inbox.resolve`・`inbox.reopen`。#99）。人間だけ（認可でも拒否するが、ハンドラでも `human` を確かめる）。
 *
 * - 片付けてよい種類は、core の `HUMAN_RESOLVABLE_KINDS`（progress・done・info）だけ。判断・違反・停止未完了・失敗などが 1 件でも含まれると、
 *   何も片付けずに `notResolvable` で失敗する（答える・判定する・宣言する前に消えないように）。
 * - 存在しない ID が 1 件でもあれば、何も片付けずに `notFound`。すでに解決済みの項目は、`alreadyResolved` に入れて冪等にする。
 * - 戻せるのは、人が片付けた項目だけ（`isResolvedByHuman`）。システム・ノードが解決にしたものは `notReopenable`。
 * - 記録は、人間として `inbox.resolved`・`inbox.reopened` を 1 トランザクションで追記する（`appendAtomically`）。
 */

import {
  type EventBody,
  type Failure,
  type InboxItem,
  isHumanResolvable,
  isResolvedByHuman,
  type OperationMap,
  type Result,
} from "@touryou/core";
import type { HandlerRequest } from "../server.js";
import { appendAtomically, fail, type LogPort } from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface InboxResolveHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
}

const human = { human: true } as const;

export function createInboxResolveHandlers(deps: InboxResolveHandlerDeps) {
  const humanOnly = (role: string): Result<never, Failure> | undefined =>
    role === "human"
      ? undefined
      : fail(
          "forbidden",
          "受信箱の項目の片付けは、人間だけが実行できる",
          "状態画面（/ui）か、人間用のコマンド（touryou inbox resolve）を使う",
        );

  /** 項目 ID を項目に引く。1 件でもなければ `notFound`（何も書かない）。 */
  const lookup = (itemIds: readonly string[]): Result<InboxItem[], Failure> => {
    const byId = new Map(deps.log.state().inbox.map((i) => [i.id, i] as const));
    const items: InboxItem[] = [];
    for (const id of itemIds) {
      const item = byId.get(id);
      if (item === undefined) {
        return fail(
          "notFound",
          `受信箱の項目 ${id} は存在しない`,
          "touryou inbox で項目の ID を確かめる",
        );
      }
      items.push(item);
    }
    return { ok: true, value: items };
  };

  return {
    "inbox.resolve": (req: HandlerRequest<"inbox.resolve">): R<"inbox.resolve"> => {
      const denied = humanOnly(req.role);
      if (denied !== undefined) return denied;
      const found = lookup(req.params.itemIds);
      if (!found.ok) return found;
      const alreadyResolved = found.value.filter((i) => i.resolved !== undefined).map((i) => i.id);
      const open = found.value.filter((i) => i.resolved === undefined);
      const refused = open.filter((i) => !isHumanResolvable(i));
      if (refused.length > 0) {
        return fail(
          "notResolvable",
          `片付けられない種類の項目がある（${refused.map((i) => `${i.id}: ${i.kind}`).join("、")}）。片付けられるのは progress・done・info だけ`,
          "判断には答える。拡張要求は判定する。停止未完了は子の状態を確かめて宣言する",
        );
      }
      if (open.length === 0) {
        return { ok: true, value: { resolved: [], alreadyResolved } };
      }
      const bodies: EventBody[] = open.map(
        (i): EventBody => ({ type: "inbox.resolved", payload: { itemId: i.id } }),
      );
      const r = appendAtomically(deps.log, deps.clock, req.requestId, human, bodies);
      if (!r.ok) return r;
      return { ok: true, value: { resolved: open.map((i) => i.id), alreadyResolved } };
    },

    "inbox.reopen": (req: HandlerRequest<"inbox.reopen">): R<"inbox.reopen"> => {
      const denied = humanOnly(req.role);
      if (denied !== undefined) return denied;
      const found = lookup(req.params.itemIds);
      if (!found.ok) return found;
      const alreadyOpen = found.value.filter((i) => i.resolved === undefined).map((i) => i.id);
      const resolved = found.value.filter((i) => i.resolved !== undefined);
      const refused = resolved.filter((i) => !isResolvedByHuman(i));
      if (refused.length > 0) {
        return fail(
          "notReopenable",
          `人が片付けていない項目は戻せない（${refused.map((i) => i.id).join("、")}）`,
          "システムやノードが解決にした項目は、そのままにする",
        );
      }
      if (resolved.length === 0) {
        return { ok: true, value: { reopened: [], alreadyOpen } };
      }
      const bodies: EventBody[] = resolved.map(
        (i): EventBody => ({ type: "inbox.reopened", payload: { itemId: i.id } }),
      );
      const r = appendAtomically(deps.log, deps.clock, req.requestId, human, bodies);
      if (!r.ok) return r;
      return { ok: true, value: { reopened: resolved.map((i) => i.id), alreadyOpen } };
    },
  };
}
