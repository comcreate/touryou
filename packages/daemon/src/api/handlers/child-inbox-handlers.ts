/**
 * 子の受信箱（`child.inbox`。mcp の子の道具 `inbox_fetch`）。子のロールの、自分のノードの分だけ。
 *
 * - 最初に、そのノードのブリーフ（目的・受け入れ基準・範囲・依存）をいつも返す（子が文脈を取り直せるように。未読の数には入れない）。
 * - 続けて、まだ受け取っていない追加の指示（`node.send`・差し戻しの理由・判断の回答。どれも `node.instructed`）を古い順に返す。
 *   `all: true` なら、受け取ったものも含めて返す（印は変えない）。
 * - 「受け取った」の記録は、mcp が応答を受け取ってから、`ackThrough`（受け取った最大の番号）を付けた 2 回目の呼び出しで行う
 *   （`node.instructionDelivered`。`deliveredSeq`）。応答が途中で切れたら記録されないので、次の呼び出しで同じものを返す。
 *   Stop のフックの未読（`pendingForChild`）は、同じ `deliveredSeq` で数える。記録は指示ごとに同じ requestId で、付け直しても害がない。
 *   `ackThrough` の呼び出しは、指示を返さない（ブリーフだけ）。
 * - 指示の本文は、人や親が書いた文。各行の頭に `> ` を付けた引用の形で返す。
 */

import {
  type ChildInstructionView,
  effectiveScope,
  type Failure,
  type InstructionRecord,
  isPrefaceInstruction,
  type OperationMap,
  type Result,
} from "@touryou/core";
import type { HandlerRequest } from "../server.js";
import { appendAtomically, fail, type LogPort } from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface ChildInboxHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  /** 記録の失敗（返す中身は変えない。次の呼び出しで同じものを返す）。 */
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

/** 人や親が書いた文を、引用の形にする（各行の頭に `> `）。CR・CRLF・U+2028・U+2029 も改行として扱う。 */
export const quote = (text: string): string =>
  text
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .map((l) => `> ${l}`)
    .join("\n");

/**
 * 引用の印を外す（各行の頭の `>` と、その後ろの空白）。子がブリーフを見たまま書き写した文を、元の文と比べるため。
 * 1 段だけ外す（元の文が `>` で始まるときは、印のない文にも同じ外しをかけて比べる）。
 */
export const unquote = (text: string): string =>
  text
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .map((l) => l.replace(/^>[ \t]*/, ""))
    .join("\n");

/**
 * この呼び出しが読む（`ackThrough` なし）・受け取りにする（`ackThrough` あり）指示。ハンドラと、時計を延ばすかの判定
 * （`readsOnlyPrefaces`）が、同じ選び方を使う。
 */
export function selectInboxInstructions(
  mine: readonly InstructionRecord[],
  params: { readonly all?: boolean | undefined; readonly ackThrough?: number | undefined },
): { readonly picked: readonly InstructionRecord[]; readonly toMark: readonly InstructionRecord[] } {
  const ack = params.ackThrough;
  return {
    picked:
      ack !== undefined
        ? []
        : mine.filter((i) => params.all === true || i.deliveredSeq === undefined),
    toMark: ack === undefined ? [] : mine.filter((i) => i.seq <= ack && i.deliveredSeq === undefined),
  };
}

/**
 * この呼び出しが読む・受け取りにする指示が、前置きの指示（`tokenIdleSoon`。#189）だけか。1 件もないとき（空の受信箱の読み出し）は、
 * 偽（ふつうの呼び出しとして、使わなければ切れる時計を延ばす）。前置きを読むだけでは、時計を延ばさない。
 */
export function readsOnlyPrefaces(
  mine: readonly InstructionRecord[],
  params: { readonly all?: boolean | undefined; readonly ackThrough?: number | undefined },
): boolean {
  const { picked, toMark } = selectInboxInstructions(mine, params);
  const read = picked.length > 0 ? picked : toMark;
  return read.length > 0 && read.every(isPrefaceInstruction);
}

export function createChildInboxHandlers(deps: ChildInboxHandlerDeps) {
  return {
    "child.inbox": (req: HandlerRequest<"child.inbox">): R<"child.inbox"> => {
      const nodeId = req.caller?.nodeId;
      if (req.role !== "child" || nodeId === undefined) {
        return fail("forbidden", "子のロールだけが使える", "子の資格情報で呼ぶ");
      }
      const state = deps.log.state();
      const node = state.nodes.find((n) => n.id === nodeId);
      const scope = effectiveScope(state, nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "whoami で確かめる");
      const mine = state.instructions.filter((i) => i.nodeId === nodeId);
      const { picked, toMark } = selectInboxInstructions(mine, req.params);
      const instructions: ChildInstructionView[] = picked.map((i) => ({
        seq: i.seq,
        at: i.at,
        quotedText: quote(i.text),
        received: i.deliveredSeq !== undefined,
      }));
      for (const i of toMark) {
        const r = appendAtomically(
          deps.log,
          deps.clock,
          `instruction-delivered-${i.seq}`,
          { system: true },
          [{ type: "node.instructionDelivered", payload: { instructedSeq: i.seq } }],
        );
        if (!r.ok) {
          try {
            deps.onFailure?.(nodeId, `受け取りを記録できない: ${r.error.code}`);
          } catch {
            // 記録先の失敗は、処理を止めない
          }
        }
      }
      return {
        ok: true,
        value: {
          brief: {
            nodeId,
            // ブリーフも人や親が書いた文なので、引用の形にする
            ...(node.objective === undefined ? {} : { objective: quote(node.objective) }),
            ...(node.acceptanceCriteria === undefined
              ? {}
              : { acceptanceCriteria: node.acceptanceCriteria.map(quote) }),
            // 範囲は、承認済みの拡張を足した有効な範囲（フックの判定と同じもの。#91）
            ...(scope === undefined
              ? {}
              : {
                  scope: {
                    writableLocations: scope.writableLocations.map(quote),
                    forbiddenLocations: scope.forbiddenLocations.map(quote),
                    allowedCommands: scope.allowedCommands.map(quote),
                  },
                }),
            dependsOn: node.dependsOn,
          },
          instructions,
        },
      };
    },
  };
}
