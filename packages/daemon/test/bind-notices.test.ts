/**
 * 紐付けの期限の知らせ（#189）の単体試験。解決（冪等・0 件で何も書かない・対象ごとに別 ID）と、
 * 失効の前の知らせ（running だけ・冪等・失敗は false）と、窓の決め方。
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventBody, type Failure, ok, type Result } from "@touryou/core";
import { describe, expect, it } from "vitest";
import {
  createIdleSoonNotifier,
  idleSoonInstruction,
  idleSoonKeyOf,
  idleWarnMsOf,
  openBindNotices,
  resolveBindNotices,
  TOKEN_SWEEP_MS,
} from "../src/bind-notices.js";
import { createDaemon, type DaemonDeps } from "../src/compose.js";
import type { DaemonConfig } from "../src/config.js";

const open = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-bind-notices-")));
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  const config: DaemonConfig = {
    stateDir: join(base, "state"),
    repoRoot,
    worktreeRoot,
    rootCwd: repoRoot,
    rootNodeId: "root",
    rootScope: { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] },
    port: 0,
  };
  const deps: DaemonDeps = {
    worktree: {
      factsFor: async () => undefined,
      removeWorktree: async (): Promise<Result<undefined, Failure>> => ok(undefined),
      provisionWorktree: async ({ nodeId }) => ok({ worktreePath: join(worktreeRoot, nodeId) }),
      cwdOf: async () => undefined,
    },
    probe: async () => [],
    logLine: () => undefined,
  };
  const made = createDaemon(config, deps);
  if (!made.ok) throw new Error(`${made.error.code}: ${made.error.cause}`);
  return made.value;
};

let n = 0;
const clock = () => "2026-10-20T00:00:00.000Z";

const seeded = () => {
  const d = open();
  const add = (body: EventBody) => {
    const r = d.log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  for (const id of ["a", "b"]) {
    add({
      type: "node.created",
      payload: { nodeId: id, role: "implement", parentId: "root", dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: id, event: { type: "start" } } });
  }
  const notice = (id: string, nodeId: string, key: string) =>
    add({
      type: "inbox.added",
      payload: {
        id,
        kind: "info",
        nodeId,
        summary: key,
        msg: { key, args: { node: nodeId } },
      } as never,
    });
  return { d, notice };
};

describe("idleWarnMsOf", () => {
  it("見回りの間隔の 2 倍。期限が見回りの 4 倍より短いときは知らせない", () => {
    expect(idleWarnMsOf(60 * 60_000)).toBe(2 * TOKEN_SWEEP_MS);
    expect(idleWarnMsOf(4 * TOKEN_SWEEP_MS)).toBe(2 * TOKEN_SWEEP_MS);
    expect(idleWarnMsOf(4 * TOKEN_SWEEP_MS - 1)).toBeUndefined();
    expect(idleWarnMsOf(10 * 60_000)).toBeUndefined();
  });
});

describe("resolveBindNotices", () => {
  it("未解決の知らせを 1 回の追記で解決にする。対象がなければ何も書かず、同じ対象を続けても重複しない", () => {
    const { d, notice } = seeded();
    notice("i1", "a", "tokenExpiredIdleBind");
    notice("i2", "a", "tokenIdleSoonBind");
    notice("i3", "b", "tokenExpiredIdleBind");
    expect(resolveBindNotices(d.log, clock, "a")).toEqual({ ok: true });
    expect(openBindNotices(d.log.state(), "a")).toEqual([]);
    expect(openBindNotices(d.log.state(), "b")).toHaveLength(1);
    const before = d.log.state().inbox.length;
    expect(resolveBindNotices(d.log, clock, "a")).toEqual({ ok: true });
    expect(d.log.state().inbox.length).toBe(before);
  });
});

describe("createIdleSoonNotifier", () => {
  const info = (nodeId: string, lastUsedMs = 1_000, issuedAt = "2026-10-20T00:00:00.000Z") => ({
    nodeId,
    issuedAt,
    lastUsedMs,
    remainingMs: 9 * 60_000,
  });
  const notifierOf = (d: ReturnType<typeof seeded>["d"]) =>
    createIdleSoonNotifier({
      log: d.log,
      clock,
      stateOf: (id) => d.log.state().nodes.find((x) => x.id === id)?.state,
      note: () => {},
    });
  const soonItems = (d: ReturnType<typeof seeded>["d"]) =>
    d.log.state().inbox.filter((i) => i.msg?.key === "tokenIdleSoonBind");

  it("同じ idle 期間なら、最後に使った時刻のミリ秒（小数）がずれても、前置きは 1 回だけ（#189）", () => {
    const { d } = seeded();
    const f = notifierOf(d);
    // 再起動・見回りで、同じ期間の最後に使った時刻が、1 秒未満だけずれる
    expect(f(info("a", 5_000.25))).toBe(true);
    expect(f(info("a", 5_000.75))).toBe(true);
    expect(f(info("a", 5_999.5))).toBe(true);
    expect(soonItems(d)).toHaveLength(1);
    expect(d.log.state().instructions.filter((i) => i.nodeId === "a")).toHaveLength(1);
    // 秒が変われば（使われて、また止まった）別の期間、発行し直されたトークンも別
    expect(f(info("a", 6_000))).toBe(true);
    expect(f(info("a", 5_000, "2026-10-20T01:00:00.000Z"))).toBe(true);
    expect(soonItems(d)).toHaveLength(3);
  });

  it("手動で解決にしたあとも、同じ idle 期間には、前置きを出し直さない（#189）", () => {
    const { d } = seeded();
    const f = notifierOf(d);
    expect(f(info("a", 5_000.25))).toBe(true);
    const item = soonItems(d)[0];
    expect(item).toBeDefined();
    const r = d.log.append({
      requestId: "manual-resolve",
      actor: { system: true },
      body: { type: "inbox.resolved", payload: { itemId: item?.id ?? "" } },
    });
    expect(r.ok).toBe(true);
    const before = d.log.state().lastSeq;
    // 解決にしたあと、見回りがもう一度呼んでも（時刻が少しずれていても）、新しい記録は増えない
    expect(f(info("a", 5_400.5))).toBe(true);
    expect(d.log.state().lastSeq).toBe(before);
    expect(soonItems(d)).toHaveLength(1);
    expect(d.log.state().instructions.filter((i) => i.nodeId === "a")).toHaveLength(1);
  });

  it("idleSoonKeyOf は、発行の時刻と、最後に使った時刻の秒で決まる", () => {
    const k = idleSoonKeyOf("a", "2026-10-20T00:00:00.000Z", 5_999.9);
    expect(k).toBe("token-idle-soon/a/2026-10-20T00:00:00.000Z/5");
    expect(idleSoonKeyOf("a", "2026-10-20T00:00:00.000Z", 5_000)).toBe(k);
    expect(idleSoonKeyOf("a", "2026-10-20T00:00:00.000Z", 6_000)).not.toBe(k);
    expect(idleSoonKeyOf("a", "2026-10-20T01:00:00.000Z", 5_000)).not.toBe(k);
  });

  it("running の子には、親の info と子への追加指示を 1 回ずつ。同じ時刻への再試行は増えない", () => {
    const { d } = seeded();
    const notes: string[] = [];
    const f = createIdleSoonNotifier({
      log: d.log,
      clock,
      stateOf: (id) => d.log.state().nodes.find((x) => x.id === id)?.state,
      note: (e) => notes.push(e),
    });
    expect(f(info("a"))).toBe(true);
    expect(f(info("a"))).toBe(true);
    const soon = d.log.state().inbox.filter((i) => i.msg?.key === "tokenIdleSoonBind");
    expect(soon).toHaveLength(1);
    expect(soon[0]?.nodeId).toBe("a");
    // 子への指示は、システムの指示（kind）として記録する（読まれていない指示・関係図の矢印・最後の動きの対象にしない）
    const sent = d.log.state().instructions.filter((i) => i.nodeId === "a");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe("tokenIdleSoon");
    expect(f(info("a", 2_000))).toBe(true); // 別の最後に使った時刻（秒が違う）は別の知らせ
    expect(d.log.state().inbox.filter((i) => i.msg?.key === "tokenIdleSoonBind")).toHaveLength(2);
    expect(notes).toEqual([]);
  });

  it("running でない子には何も書かず false", () => {
    const { d } = seeded();
    const f = createIdleSoonNotifier({ log: d.log, clock, stateOf: () => "done", note: () => {} });
    expect(f(info("a"))).toBe(false);
    expect(d.log.state().inbox.filter((i) => i.msg?.key === "tokenIdleSoonBind")).toEqual([]);
  });

  it("追記に失敗したら note して false（印を立てさせない）", () => {
    const { d } = seeded();
    const notes: string[] = [];
    const failing = {
      ...d.log,
      state: d.log.state,
      append: () => ({ ok: false, error: { code: "x", cause: "x", nextActions: ["再試行する"] } }),
      appendAll: () => ({
        ok: false,
        error: { code: "x", cause: "x", nextActions: ["再試行する"] },
      }),
    } as never;
    const f = createIdleSoonNotifier({
      log: failing,
      clock,
      stateOf: () => "running",
      note: (e) => notes.push(e),
    });
    expect(f(info("a"))).toBe(false);
    expect(notes).toEqual(["tokenIdleSoonNoticeFailure"]);
  });
});

describe("idleSoonInstruction", () => {
  it("日本語と英語を並べ、分数を入れる", () => {
    const t = idleSoonInstruction(9);
    expect(t).toContain("9");
    expect(t).toContain("touryou");
    expect(t).toContain("minutes".slice(0, 3));
  });
});
