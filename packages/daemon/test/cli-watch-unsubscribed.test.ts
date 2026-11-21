/**
 * 紐付けが外れているかも（cli-watch の 4 つめの検出）。時計を進めて、猶予・N 分の前後・1 日の上限・購読の復帰・止まった子・
 * トークンなし・重複・結び直しでの解決を、表で確かめる。
 */
import type { EventBody, InboxItem, OrchState } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { resolveBindNotices } from "../src/bind-notices.js";
import {
  BIND_LOST_KEY,
  type BindLostProbe,
  recordWatchFindings,
  type WatchCounts,
  type WatchSpec,
  watchFindings,
} from "../src/cli-watch.js";
import { EventLog } from "../src/eventlog.js";
import { createMemoryStore } from "../src/memory-store.js";

const SYS = { system: true } as const;
const MIN = 60_000;
const T0 = Date.parse("2026-10-20T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const N = 15 * MIN;
const SPEC: WatchSpec = { stallMs: 600 * MIN, unreadMs: 600 * MIN, unsubscribedMs: N };

/** 手書きの状態（`watchFindings` の表の試験用。cli-watch-idle-soon.test.ts と同じ作り方）。 */
const stateWith = (nodeState: string, inbox: unknown[] = []): OrchState =>
  ({
    nodes: [{ id: "a", state: nodeState }],
    parentRequests: [{ nodeId: "a", kind: "launch", report: { outcome: "done", at: iso(T0) } }],
    instructions: [],
    reports: [],
    violations: [],
    toolDenials: [],
    decisions: [],
    extensions: [],
    inbox,
  }) as unknown as OrchState;

/** 観測の状態を作る（`absentSince` は購読がない状態を見始めた時刻。なければ購読がある〔または対象外〕）。 */
const probeOf = (absentSince: number | undefined, token = true): BindLostProbe => ({
  absentSinceMs: () => absentSince,
  hasValidBindToken: () => token,
});

const find = (state: OrchState, now: number, probe: BindLostProbe, spec: WatchSpec = SPEC) =>
  watchFindings(state, now, spec, undefined, undefined, probe);

describe("watchFindings: 紐付けが外れているかも（表）", () => {
  // 見始めは T0。now は T0 からの経過（分）
  const table: {
    name: string;
    nodeState: string;
    afterMin: number;
    absent: boolean;
    token: boolean;
    out: boolean;
  }[] = [
    {
      name: "起動の直後（猶予の中。見始めたばかり）",
      nodeState: "running",
      afterMin: 0,
      absent: true,
      token: true,
      out: false,
    },
    {
      name: "N 分の手前（14 分 59 秒）",
      nodeState: "running",
      afterMin: 14.98,
      absent: true,
      token: true,
      out: false,
    },
    {
      name: "ちょうど N 分（超えていない）",
      nodeState: "running",
      afterMin: 15,
      absent: true,
      token: true,
      out: false,
    },
    {
      name: "N 分を超えた（15 分 1 秒）",
      nodeState: "running",
      afterMin: 15.02,
      absent: true,
      token: true,
      out: true,
    },
    {
      name: "waiting（判断待ち）も対象",
      nodeState: "waiting",
      afterMin: 60,
      absent: true,
      token: true,
      out: true,
    },
    {
      name: "止めた子（stopped）は出さない",
      nodeState: "stopped",
      afterMin: 60,
      absent: true,
      token: true,
      out: false,
    },
    {
      name: "回収できる子（reclaimable）は出さない",
      nodeState: "reclaimable",
      afterMin: 60,
      absent: true,
      token: true,
      out: false,
    },
    {
      name: "アーカイブした子は出さない",
      nodeState: "archived",
      afterMin: 60,
      absent: true,
      token: true,
      out: false,
    },
    {
      name: "受理した子（verified）は出さない",
      nodeState: "verified",
      afterMin: 60,
      absent: true,
      token: true,
      out: false,
    },
    {
      name: "紐付けのトークンがない・切れている子は出さない",
      nodeState: "running",
      afterMin: 60,
      absent: true,
      token: false,
      out: false,
    },
    {
      name: "購読がある子（観測なし）は出さない",
      nodeState: "running",
      afterMin: 60,
      absent: false,
      token: true,
      out: false,
    },
  ];
  for (const c of table) {
    it(c.name, () => {
      const f = find(
        stateWith(c.nodeState),
        T0 + c.afterMin * MIN,
        probeOf(c.absent ? T0 : undefined, c.token),
      );
      expect(f.unsubscribed).toEqual(c.out ? [{ nodeId: "a", sinceMs: T0 }] : []);
    });
  }

  it("設定（unsubscribedMs）がない・観測の口がないときは、何も出さず、片付けもしない", () => {
    const s = stateWith("running");
    expect(
      watchFindings(
        s,
        T0 + 60 * MIN,
        { stallMs: 600 * MIN, unreadMs: 600 * MIN },
        undefined,
        undefined,
        probeOf(T0),
      ).unsubscribed,
    ).toEqual([]);
    const f = watchFindings(s, T0 + 60 * MIN, SPEC);
    expect(f.unsubscribed).toEqual([]);
    expect(f.resolvedUnsubscribed).toEqual([]);
  });

  it("親が起動を報告していない子（CLI の子でない）には出さない", () => {
    const s = { ...stateWith("running"), parentRequests: [] } as unknown as OrchState;
    expect(find(s, T0 + 60 * MIN, probeOf(T0)).unsubscribed).toEqual([]);
  });
});

describe("watchFindings: 片付け（購読の復帰・トークン切れ・子が動いていない）", () => {
  const open = (nodeState: string) =>
    stateWith(nodeState, [
      {
        id: "i1",
        nodeId: "a",
        kind: "failure",
        summary: "x",
        msg: { key: BIND_LOST_KEY, args: { node: "a" } },
      },
    ]);
  const table: { name: string; nodeState: string; probe: BindLostProbe; resolved: boolean }[] = [
    {
      name: "まだ購読がない・トークン有効・動いている: 残す",
      nodeState: "running",
      probe: probeOf(T0),
      resolved: false,
    },
    {
      name: "購読が戻った: 解決にする",
      nodeState: "running",
      probe: probeOf(undefined),
      resolved: true,
    },
    {
      name: "トークンが切れた: 解決にする（切れた知らせが別にある）",
      nodeState: "running",
      probe: probeOf(T0, false),
      resolved: true,
    },
    { name: "子が止まった: 解決にする", nodeState: "stopped", probe: probeOf(T0), resolved: true },
  ];
  for (const c of table) {
    it(c.name, () => {
      expect(find(open(c.nodeState), T0 + 60 * MIN, c.probe).resolvedUnsubscribed).toEqual(
        c.resolved ? ["i1"] : [],
      );
    });
  }
});

describe("recordWatchFindings: 受信箱への記録（時計を進める）", () => {
  const rig = (spec: WatchSpec = SPEC) => {
    let nowMs = T0;
    const opened = EventLog.open(createMemoryStore().open(), { clock: () => iso(nowMs) });
    if (!opened.ok) throw new Error(opened.error.code);
    const log = opened.value;
    let n = 0;
    const add = (body: EventBody) => {
      const r = log.append({ requestId: `s-${++n}`, actor: SYS, body });
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
    };
    add({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } });
    add({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } });
    add({
      type: "node.parentRequested",
      payload: { nodeId: "a", requestRef: "q1", kind: "launch", worktree: "/w/a" },
    } as never);
    add({
      type: "node.parentReported",
      payload: { nodeId: "a", requestRef: "q1", outcome: "done" },
    } as never);
    const counts: WatchCounts = new Map();
    let absentSince: number | undefined;
    let token = true;
    const skipped: string[] = [];
    /** 時刻を `nowMs` にして、見張りを 1 回回す。出した件数を返す。 */
    const tick = (at: number): number => {
      nowMs = at;
      const f = watchFindings(log.state(), nowMs, spec, undefined, undefined, {
        absentSinceMs: () => absentSince,
        hasValidBindToken: () => token,
      });
      return recordWatchFindings(
        log,
        () => iso(nowMs),
        f,
        spec,
        counts,
        nowMs,
        (id) => skipped.push(id),
      );
    };
    const lost = (): InboxItem[] => log.state().inbox.filter((i) => i.msg?.key === BIND_LOST_KEY);
    return {
      log,
      tick,
      lost,
      skipped,
      setAbsentSince: (v: number | undefined) => {
        absentSince = v;
      },
      setToken: (v: boolean) => {
        token = v;
      },
      clock: () => iso(nowMs),
    };
  };

  it("N 分の手前では出さず、超えたら 1 件だけ出す。親の失敗の知らせ（failure）で、状態と次にすることが平易な文で書かれる", () => {
    const r = rig();
    r.setAbsentSince(T0);
    expect(r.tick(T0 + 14 * MIN)).toBe(0);
    expect(r.lost()).toHaveLength(0);
    expect(r.tick(T0 + 16 * MIN)).toBe(1);
    const [item] = r.lost();
    expect(item?.kind).toBe("failure");
    expect(item?.nodeId).toBe("a");
    expect(item?.msg).toEqual({ key: BIND_LOST_KEY, args: { node: "a", minutes: 15 } });
    // 状態・次にすること（子への 1 行の指示と、トークンが切れたときの出し直し）があり、秘密・コードを含まない
    expect(item?.summary).toContain("いまの状態");
    expect(item?.summary).toContain("次にすること");
    expect(item?.summary).toContain("node_send");
    expect(item?.summary).toContain("touryou の child_bind を引数なしで呼んで");
    expect(item?.summary).toContain("node_bindCode");
    expect(item?.summary).not.toMatch(/session_?id|token=|Bearer/i);
  });

  it("同じ途切れには 1 回だけ（見張りを何度回しても増えない）", () => {
    const r = rig();
    r.setAbsentSince(T0);
    expect(r.tick(T0 + 16 * MIN)).toBe(1);
    expect(r.tick(T0 + 17 * MIN)).toBe(0);
    expect(r.tick(T0 + 120 * MIN)).toBe(0);
    expect(r.lost()).toHaveLength(1);
  });

  it("購読が戻ったら解決にし、あとで別の途切れが N 分続けば、新しく出す", () => {
    const r = rig();
    r.setAbsentSince(T0);
    r.tick(T0 + 16 * MIN);
    r.setAbsentSince(undefined);
    r.tick(T0 + 20 * MIN);
    expect(r.lost().map((i) => i.resolved !== undefined)).toEqual([true]);
    // 戻ったあと、再び途切れた（見始めは T0 + 30 分）。N 分の手前では出さない
    r.setAbsentSince(T0 + 30 * MIN);
    expect(r.tick(T0 + 40 * MIN)).toBe(0);
    expect(r.tick(T0 + 46 * MIN)).toBe(1);
    expect(r.lost().map((i) => i.resolved === undefined)).toEqual([false, true]);
  });

  it("結び直し（child_bind の成功）で解決にしたあとは、同じ途切れを出し直さない", () => {
    const r = rig();
    r.setAbsentSince(T0);
    r.tick(T0 + 16 * MIN);
    expect(resolveBindNotices(r.log, r.clock, "a")).toEqual({ ok: true });
    expect(r.lost().every((i) => i.resolved !== undefined)).toBe(true);
    expect(r.tick(T0 + 60 * MIN)).toBe(0);
    expect(r.lost()).toHaveLength(1);
  });

  it("トークンが切れたら解決にし、切れている間は出さない（切れた知らせは別にある）", () => {
    const r = rig();
    r.setAbsentSince(T0);
    r.tick(T0 + 16 * MIN);
    r.setToken(false);
    r.tick(T0 + 17 * MIN);
    expect(r.lost().every((i) => i.resolved !== undefined)).toBe(true);
    // 別の途切れでも、トークンがなければ出さない
    r.setAbsentSince(T0 + 30 * MIN);
    expect(r.tick(T0 + 60 * MIN)).toBe(0);
    expect(r.lost()).toHaveLength(1);
  });

  it("ノードごとの 1 日の上限に数える。上限を超えたら、知らせの代わりに「多すぎる」を 1 回だけ出す", () => {
    // 「止まっているかも」が同じ上限の枠を使わないよう、止まりの基準は 1 週間にしておく
    const r = rig({ ...SPEC, perNodePerDay: 1, stallMs: 7 * 24 * 60 * MIN });
    r.setAbsentSince(T0);
    expect(r.tick(T0 + 16 * MIN)).toBe(1);
    r.setAbsentSince(undefined);
    r.tick(T0 + 20 * MIN);
    // 2 回めの途切れ（同じ日）: 上限なので、bindLostSuspect は出ず、watchCapped が 1 件
    r.setAbsentSince(T0 + 30 * MIN);
    expect(r.tick(T0 + 50 * MIN)).toBe(1);
    expect(r.lost()).toHaveLength(1);
    expect(r.log.state().inbox.filter((i) => i.msg?.key === "watchCapped")).toHaveLength(1);
    expect(r.tick(T0 + 60 * MIN)).toBe(0);
    // 24 時間たてば、また出せる（途切れの見始めが新しければ、別の鍵）
    r.setAbsentSince(undefined);
    r.tick(T0 + 61 * MIN);
    r.setAbsentSince(T0 + 25 * 60 * MIN);
    expect(r.tick(T0 + 25 * 60 * MIN + 16 * MIN)).toBe(1);
    expect(r.lost()).toHaveLength(2);
  });
});
