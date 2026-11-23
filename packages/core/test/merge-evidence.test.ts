import { describe, expect, it } from "vitest";
import {
  type EventBody,
  foldEvents,
  isMergeEvidenceKind,
  isPrNumber,
  MAX_PR_NUMBER,
  type NodeEvent,
  type OrchEvent,
  type OrchState,
  purgeEventSeqs,
  ROLE_OPERATIONS,
} from "../src/index.js";

const SYS = { system: true } as const;
const HUMAN = { human: true } as const;
const TIP = "a".repeat(40);
const OTHER_TIP = "b".repeat(40);
let counter = 7000;
const ev = (
  body: EventBody,
  over: Partial<Pick<OrchEvent, "seq" | "requestId" | "actor" | "at">> = {},
): OrchEvent => {
  counter += 1;
  return {
    seq: over.seq ?? counter,
    at: over.at ?? "2026-10-20T00:00:00Z",
    requestId: over.requestId ?? `req-${counter}`,
    actor: over.actor ?? SYS,
    ...body,
  } as OrchEvent;
};
const created = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
const changed = (nodeId: string, event: NodeEvent) =>
  ev({ type: "node.stateChanged", payload: { nodeId, event } });
const code = (r: ReturnType<typeof foldEvents>) => (r.ok ? null : r.error.code);
const must = (r: ReturnType<typeof foldEvents>): OrchState => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};
const base = (): OrchEvent[] => [
  created("root", "integrator", null),
  changed("root", { type: "start" }),
  created("a", "implement", "root"),
  changed("a", { type: "start" }),
];
const stopped = (): OrchEvent[] => [
  ...base(),
  changed("a", { type: "stop", mode: "immediate" }),
  changed("a", { type: "confirmStopped" }),
];
const evidence = (payload: Record<string, unknown>, over: Parameters<typeof ev>[1] = {}) =>
  ev({ type: "node.mergeEvidenceRecorded", payload: { nodeId: "a", ...payload } } as never, {
    actor: HUMAN,
    at: "2026-10-21T01:00:00Z",
    ...over,
  });

describe("node.mergeEvidenceRecorded（統合済みの証拠。#239）", () => {
  it("先端に紐付けて、記録した者・時刻・seq・種類を残す", () => {
    const s = must(
      foldEvents([
        ...stopped(),
        evidence({ evidenceKind: "prHead", tip: TIP, prNumber: 12 }, { seq: 9100 }),
      ]),
    );
    expect(s.nodes.find((n) => n.id === "a")?.mergeEvidence).toEqual({
      seq: 9100,
      at: "2026-10-21T01:00:00Z",
      by: HUMAN,
      evidenceKind: "prHead",
      tip: TIP,
      prNumber: 12,
    });
  });

  it("人の宣言（human）は、PR 番号なしで記録できる", () => {
    const s = must(foldEvents([...stopped(), evidence({ evidenceKind: "human", tip: TIP })]));
    const rec = s.nodes.find((n) => n.id === "a")?.mergeEvidence;
    expect(rec?.evidenceKind).toBe("human");
    expect(rec?.prNumber).toBeUndefined();
  });

  it("先端が変わった証拠は、新しい先端で置き換えられる", () => {
    const s = must(
      foldEvents([
        ...stopped(),
        evidence({ evidenceKind: "human", tip: TIP }),
        evidence({ evidenceKind: "human", tip: OTHER_TIP }),
      ]),
    );
    expect(s.nodes.find((n) => n.id === "a")?.mergeEvidence?.tip).toBe(OTHER_TIP);
  });

  it("同じ内容の重複は alreadyRecorded で断る", () => {
    const dup = foldEvents([
      ...stopped(),
      evidence({ evidenceKind: "prHead", tip: TIP, prNumber: 3 }),
      evidence({ evidenceKind: "prHead", tip: TIP, prNumber: 3 }),
    ]);
    expect(code(dup)).toBe("alreadyRecorded");
  });

  it("不正な形（tip・evidenceKind・prNumber・nodeId）は invalidPayload で断る", () => {
    const bads: Record<string, unknown>[] = [
      { evidenceKind: "human", tip: "abc" }, // 短縮 SHA
      { evidenceKind: "human", tip: "A".repeat(40) }, // 大文字
      { evidenceKind: "human", tip: `${TIP}0` },
      { evidenceKind: "human" },
      { evidenceKind: "ai", tip: TIP },
      { evidenceKind: "prHead", tip: TIP, prNumber: 0 },
      { evidenceKind: "prHead", tip: TIP, prNumber: 1.5 },
      { evidenceKind: "prHead", tip: TIP, prNumber: MAX_PR_NUMBER + 1 },
      { evidenceKind: "prHead", tip: TIP, prNumber: "12" },
      { evidenceKind: "human", tip: TIP, nodeId: "" },
    ];
    for (const bad of bads) {
      expect(code(foldEvents([...stopped(), evidence(bad)])), JSON.stringify(bad)).toBe(
        "invalidPayload",
      );
    }
  });

  it("存在しないノードは unknownNode、動いている（running）ノードは invalidTransition で断る", () => {
    expect(
      code(foldEvents([...stopped(), evidence({ nodeId: "zzz", evidenceKind: "human", tip: TIP })])),
    ).toBe("unknownNode");
    expect(
      code(foldEvents([...base(), evidence({ evidenceKind: "human", tip: TIP })])),
    ).toBe("invalidTransition");
  });

  it("MERGE_EVIDENCE_KINDS・PR 番号の判定", () => {
    expect(isMergeEvidenceKind("prHead")).toBe(true);
    expect(isMergeEvidenceKind("human")).toBe(true);
    expect(isMergeEvidenceKind("ai")).toBe(false);
    expect(isPrNumber(1)).toBe(true);
    expect(isPrNumber(MAX_PR_NUMBER)).toBe(true);
    expect(isPrNumber(0)).toBe(false);
    expect(isPrNumber(-1)).toBe(false);
    expect(isPrNumber(1.2)).toBe(false);
    expect(isPrNumber(Number.NaN)).toBe(false);
  });

  it("最終削除で、木のノードの証拠のイベントも削除の対象に入る", () => {
    const events = [...stopped(), evidence({ evidenceKind: "human", tip: TIP }, { seq: 9200 })];
    expect(purgeEventSeqs(events, new Set(["a"]))).toContain(9200);
    expect(purgeEventSeqs(events, new Set(["root"]))).not.toContain(9200);
  });
});

describe("ロール表: 証拠の記録は人間だけ（AI は証拠を作れない）", () => {
  it("node.mergeEvidence は、人間のロールだけが持つ（integrator・child には足さない）", () => {
    expect(ROLE_OPERATIONS.human).toContain("node.mergeEvidence");
    expect((ROLE_OPERATIONS.integrator as readonly string[]).includes("node.mergeEvidence")).toBe(
      false,
    );
    expect((ROLE_OPERATIONS.child as readonly string[]).includes("node.mergeEvidence")).toBe(false);
  });
});
