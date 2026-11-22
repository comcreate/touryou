import { describe, expect, it } from "vitest";
import { type EventBody, foldEvents, type OrchEvent, uiViewOf } from "../src/index.js";

const SYS = { system: true } as const;
const AT = "2026-10-20T00:00:00Z";
let n = 0;
const ev = (body: EventBody): OrchEvent =>
  ({ seq: ++n, at: AT, requestId: `r${n}`, actor: SYS, ...body }) as OrchEvent;
const created = (nodeId: string, role: string, parentId: string | null) =>
  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } } as never);
const expiredNotice = (id: string, nodeId: string, key: string) =>
  ev({
    type: "inbox.added",
    payload: { id, kind: "info", nodeId, summary: "x", msg: { key, args: { node: nodeId } } },
  } as never);
const viewOf = (events: OrchEvent[]) => {
  const r = foldEvents(events);
  if (!r.ok) throw new Error(r.error.cause);
  return uiViewOf(r.value);
};
const base = (): OrchEvent[] => {
  n = 0;
  return [
    created("root", "integrator", null),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    created("a", "implement", "root"),
    created("b", "implement", "root"),
  ];
};
const nodeOf = (v: ReturnType<typeof viewOf>, id: string) => v.nodes.find((x) => x.id === id);

const lostNotice = (id: string, nodeId: string) =>
  ev({
    type: "inbox.added",
    payload: {
      id,
      kind: "failure",
      nodeId,
      summary: "x",
      msg: { key: "bindLostSuspect", args: { node: nodeId, minutes: 15 } },
    },
  } as never);

describe("uiViewOf の bindLost（紐付けが外れているかも）", () => {
  it("(a) 未解決の bindLostSuspect で bindLost: true を付ける。ほかの子には付けない", () => {
    const v = viewOf([...base(), lostNotice("i1", "a")]);
    expect(nodeOf(v, "a")?.bindLost).toBe(true);
    expect(nodeOf(v, "b")).not.toHaveProperty("bindLost");
  });

  it("(b) 切れた札（bindExpired）がある子には付けない（重ならない）", () => {
    const v = viewOf([
      ...base(),
      lostNotice("i1", "a"),
      expiredNotice("i2", "a", "tokenExpiredIdleBind"),
    ]);
    expect(nodeOf(v, "a")?.bindExpired).toBe("idle");
    expect(nodeOf(v, "a")).not.toHaveProperty("bindLost");
  });

  it("(c) 役目の終わった子には付けない。動いている・待っている子には付ける", () => {
    const r = foldEvents([...base(), lostNotice("i1", "a")]);
    if (!r.ok) throw new Error(r.error.cause);
    const withState = (state: string) =>
      uiViewOf({
        ...r.value,
        nodes: r.value.nodes.map((x) => (x.id === "a" ? { ...x, state } : x)),
      } as never);
    for (const s of ["verified", "archived", "stopped", "reclaimable"]) {
      expect(nodeOf(withState(s), "a"), s).not.toHaveProperty("bindLost");
    }
    for (const s of ["running", "waiting"]) {
      expect(nodeOf(withState(s), "a")?.bindLost, s).toBe(true);
    }
  });

  it("(d) 解決済みの知らせでは付かない", () => {
    const v = viewOf([
      ...base(),
      lostNotice("i1", "a"),
      ev({ type: "inbox.resolved", payload: { itemId: "i1" } } as never),
    ]);
    expect(nodeOf(v, "a")).not.toHaveProperty("bindLost");
  });

  it("鍵のない知らせ（文だけ似ているもの）からは導かない", () => {
    const v = viewOf([
      ...base(),
      ev({
        type: "inbox.added",
        payload: { id: "i1", kind: "failure", nodeId: "a", summary: "紐付けが外れているかも" },
      } as never),
    ]);
    expect(nodeOf(v, "a")).not.toHaveProperty("bindLost");
  });

  it("needsHuman には数えない。知らせの種類が failure なので、動いている子の band は turn になる（unbound の知らせと同じ）", () => {
    const v = viewOf([...base(), lostNotice("i1", "a")]);
    expect(nodeOf(v, "a")?.needsHuman).toBe(0);
    expect(nodeOf(v, "a")?.band).toBe("turn");
    expect(nodeOf(v, "b")?.band).not.toBe("turn");
  });
});

describe("uiViewOf の bindExpired（#189）", () => {
  it("未解決の tokenExpiredIdleBind・tokenExpiredAbsoluteBind から導く。ほかの子・知らせのない子には付けない", () => {
    const v = viewOf([...base(), expiredNotice("i1", "a", "tokenExpiredIdleBind")]);
    expect(nodeOf(v, "a")?.bindExpired).toBe("idle");
    expect(nodeOf(v, "b")).not.toHaveProperty("bindExpired");
    const w = viewOf([...base(), expiredNotice("i1", "a", "tokenExpiredAbsoluteBind")]);
    expect(nodeOf(w, "a")?.bindExpired).toBe("absolute");
  });

  it("両方あれば新しいほう。解決済みなら付けない。needsHuman・band は変えない", () => {
    const both = viewOf([
      ...base(),
      expiredNotice("i1", "a", "tokenExpiredAbsoluteBind"),
      expiredNotice("i2", "a", "tokenExpiredIdleBind"),
    ]);
    expect(nodeOf(both, "a")?.bindExpired).toBe("idle");
    expect(nodeOf(both, "a")?.needsHuman).toBe(0);

    const resolved = viewOf([
      ...base(),
      expiredNotice("i1", "a", "tokenExpiredIdleBind"),
      ev({ type: "inbox.resolved", payload: { itemId: "i1" } } as never),
    ]);
    expect(nodeOf(resolved, "a")).not.toHaveProperty("bindExpired");
  });

  it("役目の終わった子（verified・archived・stopped・reclaimable）には付けない。動いている子には付ける", () => {
    const r = foldEvents([...base(), expiredNotice("i1", "a", "tokenExpiredIdleBind")]);
    if (!r.ok) throw new Error(r.error.cause);
    const withState = (state: string) =>
      uiViewOf({
        ...r.value,
        nodes: r.value.nodes.map((x) => (x.id === "a" ? { ...x, state } : x)),
      } as never);
    for (const s of [
      "verified",
      "archived",
      "stopped",
      "reclaimable",
      "stopping",
      "stopIncomplete",
    ]) {
      expect(nodeOf(withState(s), "a"), s).not.toHaveProperty("bindExpired");
    }
    for (const s of ["running", "waiting", "done"]) {
      expect(nodeOf(withState(s), "a")?.bindExpired, s).toBe("idle");
    }
  });

  it("鍵のない知らせ（文だけ似ているもの）からは導かない", () => {
    const v = viewOf([
      ...base(),
      ev({
        type: "inbox.added",
        payload: { id: "i1", kind: "info", nodeId: "a", summary: "トークンの期限が切れた" },
      } as never),
    ]);
    expect(nodeOf(v, "a")).not.toHaveProperty("bindExpired");
  });
});
