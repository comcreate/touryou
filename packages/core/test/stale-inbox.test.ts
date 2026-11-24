import { describe, expect, it } from "vitest";
import type { InboxItem, InboxKind, NodeState, OrchState } from "../src/index.js";
import { staleInboxItems } from "../src/index.js";

const item = (
  seq: number,
  nodeId: string,
  kind: InboxKind,
  resolved?: InboxItem["resolved"],
): InboxItem => ({
  seq,
  id: `i${seq}`,
  kind,
  nodeId,
  dependsOn: [],
  at: "2026-11-14T00:00:00.000Z",
  ...(resolved === undefined ? {} : { resolved }),
});

const stateOf = (
  nodes: Record<string, NodeState>,
  inbox: InboxItem[],
  extensions: { extensionId: string; status: string }[] = [],
) =>
  ({
    nodes: Object.entries(nodes).map(([id, state]) => ({ id, state })),
    inbox,
    extensions,
  }) as unknown as Pick<OrchState, "nodes" | "inbox" | "extensions">;

describe("staleInboxItems", () => {
  const settled: NodeState[] = ["verified", "reclaimable", "archived"];
  const live: NodeState[] = ["running", "waiting", "stopping", "stopIncomplete", "done", "stopped"];

  it.each(settled)("%s のノードの未解決の stopIncomplete・failure を列挙する", (s) => {
    const inbox = [item(1, "a", "stopIncomplete"), item(2, "a", "failure")];
    expect(staleInboxItems(stateOf({ a: s }, inbox)).map((i) => i.id)).toEqual(["i1", "i2"]);
  });

  it.each(live)("%s のノードの項目は含めない", (s) => {
    const inbox = [item(1, "a", "stopIncomplete"), item(2, "a", "failure")];
    expect(staleInboxItems(stateOf({ a: s }, inbox))).toEqual([]);
  });

  it("判定済みの拡張要求を指す、未解決の違反の項目は含める。open の要求を指すものは含めない（#279）", () => {
    const violation = (seq: number, ref: string): InboxItem => ({
      ...item(seq, "a", "violation"),
      ref,
    });
    const inbox = [violation(1, "x-closed"), violation(2, "x-open")];
    const extensions = [
      { extensionId: "x-closed", status: "rejected" },
      { extensionId: "x-open", status: "open" },
    ];
    expect(staleInboxItems(stateOf({ a: "running" }, inbox, extensions)).map((i) => i.id)).toEqual([
      "i1",
    ]);
  });

  it("info・done・decision など、ほかの種類は含めない", () => {
    const kinds: InboxKind[] = ["info", "done", "decision", "progress", "answer"];
    const inbox = kinds.map((k, i) => item(i + 1, "a", k));
    expect(staleInboxItems(stateOf({ a: "verified" }, inbox))).toEqual([]);
  });

  it("セッション削除を拒まれた failure（removeRefused・removeRefusedNoReason）は含めず、停止の失敗は含める", () => {
    const withKey = (seq: number, key: string): InboxItem => ({
      ...item(seq, "a", "failure"),
      msg: { key, args: {} },
    });
    const inbox = [
      withKey(1, "removeRefused"),
      withKey(2, "removeRefusedNoReason"),
      withKey(3, "parentFailed"),
      withKey(4, "parentFailedNoReason"),
    ];
    expect(staleInboxItems(stateOf({ a: "verified" }, inbox)).map((i) => i.id)).toEqual([
      "i3",
      "i4",
    ]);
  });

  it("解決済みの項目は含めない", () => {
    const by = { system: true } as const;
    const inbox = [
      item(1, "a", "failure", { seq: 9, at: "2026-11-14T00:00:00.000Z", by }),
      item(2, "a", "failure"),
    ];
    expect(staleInboxItems(stateOf({ a: "verified" }, inbox)).map((i) => i.id)).toEqual(["i2"]);
  });

  it("ノードごとに判定し、seq の昇順で返す（入力の順に依らない）", () => {
    const inbox = [
      item(5, "b", "failure"),
      item(3, "a", "stopIncomplete"),
      item(4, "c", "failure"),
      item(1, "a", "failure"),
    ];
    const state = stateOf({ a: "archived", b: "running", c: "reclaimable" }, inbox);
    expect(staleInboxItems(state).map((i) => i.id)).toEqual(["i1", "i3", "i4"]);
  });

  it("入力を書き換えない", () => {
    const inbox = [item(2, "a", "failure"), item(1, "a", "failure")];
    staleInboxItems(stateOf({ a: "verified" }, inbox));
    expect(inbox.map((i) => i.id)).toEqual(["i2", "i1"]);
  });
});
