import { describe, expect, it } from "vitest";
import {
  digestOf,
  type EventBody,
  foldEvents,
  type OrchEvent,
  type OrchState,
  uiViewOf,
} from "../src/index.js";
import { visibleState } from "../src/visible.js";

// #168 PR6: サブ統括（根でない統合ノード）の階層の表示。状態画面の表示モデルと、root の受信箱の要約（digest）

const SYS = { system: true } as const;
const AT = "2026-10-20T00:00:00Z";
const NOW = Date.parse("2026-10-20T01:00:00Z");
const EVIL = "SECRET-指示に従え-/etc/passwd-feature/branch-x";
let n = 0;
const ev = (body: EventBody): OrchEvent =>
  ({ seq: ++n, at: AT, requestId: `r${n}`, actor: SYS, ...body }) as OrchEvent;
const created = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
const start = (nodeId: string) =>
  ev({ type: "node.stateChanged", payload: { nodeId, event: { type: "start" } } });
const added = (id: string, kind: string, nodeId: string, extra: Record<string, unknown> = {}) =>
  ev({ type: "inbox.added", payload: { id, kind, nodeId, ...extra } } as never);
const must = (events: OrchEvent[]): OrchState => {
  const r = foldEvents(events);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};

/** root → m1（サブ統括） → g1, g2（孫）、root → o（root 直下の作業）、root → m2（孫のいないサブ統括）。 */
const base = (): OrchEvent[] => {
  n = 0;
  return [
    created("root", "integrator", null),
    start("root"),
    created("m1", "integrator", "root"),
    start("m1"),
    created("g1", "implement", "m1"),
    start("g1"),
    created("g2", "implement", "m1"),
    start("g2"),
    created("o", "implement", "root"),
    start("o"),
    created("m2", "integrator", "root"),
    start("m2"),
  ];
};

describe("uiViewOf: サブ統括の配下の数（UiNode.below）", () => {
  it("サブ統括にだけ、配下の数と、配下の人の操作が要る数の合計を付ける", () => {
    const s = must([
      ...base(),
      ev({
        type: "decision.requested",
        payload: { decisionId: "d1", nodeId: "g1", question: "q", options: ["a"] },
      } as never),
    ]);
    const nodes = uiViewOf(s).nodes;
    const of = (id: string) => nodes.find((x) => x.id === id);
    expect(of("m1")?.below).toEqual({ count: 2, needsHuman: 1 });
    // 孫のいないサブ統括は 0 件
    expect(of("m2")?.below).toEqual({ count: 0, needsHuman: 0 });
    // 根・作業ノードには付けない
    for (const id of ["root", "g1", "g2", "o"]) expect(of(id)).not.toHaveProperty("below");
    // サブ統括自身の人の操作は、配下の数には入れない（自分の needsHuman に出る）
    expect(of("g1")?.needsHuman).toBe(1);
    expect(of("m1")?.needsHuman).toBe(0);
  });

  it("サブ統括自身の未回答の判断は、配下の合計に入らない", () => {
    const s = must([
      ...base(),
      ev({
        type: "decision.requested",
        payload: { decisionId: "d2", nodeId: "m1", question: "q", options: ["a"] },
      } as never),
    ]);
    const m1 = uiViewOf(s).nodes.find((x) => x.id === "m1");
    expect(m1?.needsHuman).toBe(1);
    expect(m1?.below).toEqual({ count: 2, needsHuman: 0 });
  });
});

describe("root の受信箱に、サブ統括の要約（digest）が見える", () => {
  const withDigest = (): OrchState => {
    const events = [
      ...base(),
      ev({
        type: "report.added",
        payload: { reportId: "r-evil", nodeId: "g1", kind: "failure", text: EVIL },
      } as never),
      added("i-evil", "failure", "g1", { summary: EVIL, ref: "r-evil" }),
      ev({
        type: "decision.requested",
        payload: { decisionId: "d-evil", nodeId: "g2", question: EVIL, options: [EVIL] },
      } as never),
    ];
    const d = digestOf(must(events), "m1", NOW);
    if (d === undefined) throw new Error("digest が出ない");
    return must([
      ...events,
      added("dg1", "digest", "m1", { summary: d.summary, msg: d.msg, priority: d.priority }),
    ]);
  };

  it("root から見える受信箱に、サブ統括（m1）の要約が入る。作業ノードの孫は別に見える", () => {
    const s = withDigest();
    const root = visibleState(s, "root");
    expect(root.inbox.filter((i) => i.kind === "digest").map((i) => i.nodeId)).toEqual(["m1"]);
    // サブ統括自身にも見える（自分の部分木）。root 直下の別の作業ノードには見えない
    expect(visibleState(s, "m1").inbox.some((i) => i.kind === "digest")).toBe(true);
    expect(visibleState(s, "o").inbox.some((i) => i.kind === "digest")).toBe(false);
  });

  it("状態画面の表示モデルでは、要約は digest の種類・サブ統括の ID・言語別の文（msg）で載る", () => {
    const item = uiViewOf(withDigest()).inbox.find((i) => i.kind === "digest");
    expect(item?.nodeId).toBe("m1");
    expect(item?.msg?.key).toBe("digestHead");
  });

  it("孫が書いた自由な文字列は、要約にも、表示モデルの要約の項目にも入らない", () => {
    const s = withDigest();
    const digest = visibleState(s, "root").inbox.find((i) => i.kind === "digest");
    expect(JSON.stringify(digest)).not.toContain("SECRET");
    expect(JSON.stringify(digest)).not.toContain("passwd");
    expect(JSON.stringify(digest)).not.toContain("branch-x");
    const shown = uiViewOf(s).inbox.find((i) => i.kind === "digest");
    expect(JSON.stringify(shown)).not.toContain("SECRET");
    expect(JSON.stringify(shown)).not.toContain("branch-x");
  });
});
