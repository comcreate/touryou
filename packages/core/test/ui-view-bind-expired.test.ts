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
