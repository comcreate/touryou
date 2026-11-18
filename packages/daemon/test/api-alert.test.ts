import { inboxMessageText, isInboxMessage, ok } from "@touryou/core";
import { describe, expect, it } from "vitest";
import type { ApiLogEvent } from "../src/api/server.js";
import { createApiAlert } from "../src/api-alert.js";

const summary = (
  authFailed: Record<string, number>,
  rateLimited: Record<string, number> = {},
  at = "2026-10-23T12:00:00.000Z",
): ApiLogEvent => ({
  event: "apiSummary",
  windowSec: 60,
  windowStart: "2026-10-23T11:59:00.000Z",
  windowEnd: "2026-10-23T12:00:00.000Z",
  authFailed,
  rateLimited,
  deduped: {},
  at,
});

const rig = (
  over: { threshold?: number; retiredThreshold?: number; minIntervalMs?: number } = {},
) => {
  let mono = 0;
  const records: { requestId: string; body: { type: string; payload: Record<string, unknown> } }[] =
    [];
  const notes: string[] = [];
  let failNext = false;
  const resolved: string[] = [];
  /** 未解決の警告（人間が解決したものは、ここから外す）。 */
  const open = new Set<string>();
  const alert = createApiAlert({
    threshold: over.threshold ?? 30,
    ...(over.retiredThreshold === undefined ? {} : { retiredThreshold: over.retiredThreshold }),
    minIntervalMs: over.minIntervalMs ?? 600_000,
    rootNodeId: "root",
    monoMs: () => mono,
    record: (requestId, body) => {
      if (failNext) {
        failNext = false;
        return { ok: false, error: { code: "boom", cause: "x", nextActions: ["y"] } } as never;
      }
      records.push({ requestId, body: body as never });
      const b = body as { type: string; payload: { id?: string; itemId?: string } };
      if (b.type === "inbox.added" && b.payload.id !== undefined) open.add(b.payload.id);
      if (b.type === "inbox.resolved" && b.payload.itemId !== undefined) {
        open.delete(b.payload.itemId);
        resolved.push(b.payload.itemId);
      }
      return ok(undefined);
    },
    openAlertIds: () => [...open],
    defer: (fn) => fn(),
    note: (event) => notes.push(event),
  });
  return {
    alert,
    records,
    notes,
    resolved,
    open,
    added: () => records.filter((x) => x.body.type === "inbox.added"),
    advance: (ms: number) => {
      mono += ms;
    },
    failNext: () => {
      failNext = true;
    },
  };
};

describe("createApiAlert（窓口の 429・401 の件数の見える化）", () => {
  it("フックの受け口の要求数（hook）は、閾値を超えても警告に入らない（数え方は変わらない）", () => {
    const r = rig({ threshold: 5 });
    r.alert({ ...summary({}), hook: { received: 1000, allowed: 990, denied: 10 } } as ApiLogEvent);
    expect(r.added()).toEqual([]);
    r.alert({ ...summary({ invalid: 5 }), hook: { received: 1000 } } as ApiLogEvent);
    expect(r.added()).toHaveLength(1);
    expect(JSON.stringify(r.added())).not.toContain("1000");
  });

  it("期限切れのトークンでの失敗（expired・hookExpired）は、閾値に数えない", () => {
    const r = rig({ threshold: 5 });
    r.alert(summary({ expired: 100, hookExpired: 100, invalid: 4 }));
    expect(r.added()).toEqual([]);
    r.alert(summary({ expired: 100, invalid: 5 }));
    expect(r.added()).toHaveLength(1);
    expect(String(r.added()[0]?.body.payload.summary)).not.toContain("expired");
  });

  it("閾値以上なら、根の受信箱に info を 1 件出す。文面は件数と固定の語だけ", () => {
    const r = rig();
    r.alert(summary({ invalid: 25, missing: 10, bindFailed: 2 }));
    expect(r.records).toHaveLength(1);
    const item = r.records[0]?.body;
    expect(item?.type).toBe("inbox.added");
    expect(item?.payload).toMatchObject({ kind: "info", nodeId: "root" });
    const text = String(item?.payload.summary);
    expect(text).toContain("認証の失敗 37 件");
    expect(text).toContain("invalid 25・missing 10・bindFailed 2"); // 件数の多い順
    // 窓の開始・終了の時刻（UTC）を出す。「直近 60 秒」という言い方はしない（窓の終わりと、記録の時刻はずれうる）
    expect(text).toContain("2026-10-23T11:59:00〜2026-10-23T12:00:00 UTC（60 秒間）");
    expect(text).not.toContain("直近");
    expect(text).not.toContain("制限の発動"); // 閾値未満の種類は、書かない
    expect(r.notes).toEqual(["apiAlert.posted"]);
  });

  it("閾値未満の窓は、何も出さない。ちょうど閾値は出す。apiSummary 以外のイベントは無視する", () => {
    const r = rig();
    r.alert(summary({ invalid: 29 }));
    r.alert({ event: "apiAuthFailed", reason: "invalid", at: "2026-10-23T12:00:00Z" });
    expect(r.records).toEqual([]);
    r.alert(summary({ invalid: 30 }));
    expect(r.records).toHaveLength(1);
  });

  it("認証の失敗と制限の発動は、別々に閾値と間隔を見る。両方が閾値以上なら、1 件にまとめる", () => {
    const r = rig();
    r.alert(summary({ invalid: 40 }, { principal: 50 }));
    expect(r.records).toHaveLength(1);
    const text = String(r.records[0]?.body.payload.summary);
    expect(text).toContain("認証の失敗 40 件");
    expect(text).toContain("制限の発動 50 件（principal 50）");
  });

  it("出しすぎない: 同じ種類は、最短の間隔（既定 10 分）あける。間隔のあとは、また出す。別の種類は、別に数える", () => {
    const r = rig();
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:00:00.000Z"));
    r.advance(60_000);
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:01:00.000Z"));
    r.advance(60_000);
    r.alert(summary({ invalid: 99 }, {}, "2026-10-23T12:02:00.000Z"));
    expect(r.added()).toHaveLength(1); // 間隔の内は、出さない
    // 別の種類（制限の発動）は、別に数える
    r.alert(summary({}, { principal: 40 }, "2026-10-23T12:02:30.000Z"));
    expect(r.added()).toHaveLength(2);
    r.advance(600_000);
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:12:30.000Z"));
    expect(r.added()).toHaveLength(3);
    // 項目の ID は、窓の時刻から決まる（同じ ID が重ならない）
    expect(new Set(r.added().map((x) => x.body.payload.id)).size).toBe(3);
  });

  it("新しい警告を出すとき、同じ種類の前の未解決の警告を system が解決済みにする。未解決の警告は、種類ごとに高々 1 件", () => {
    const r = rig({ minIntervalMs: 0 });
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:00:00.000Z"));
    const first = [...r.open];
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/^api-alert-a-/);
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:01:00.000Z"));
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:02:00.000Z"));
    expect([...r.open]).toHaveLength(1); // 積み上がらない
    expect(r.resolved).toHaveLength(2);
    expect(r.resolved).toContain(first[0]);
    // 別の種類は、別（制限の発動の警告は、認証の失敗の警告を解決済みにしない）
    r.alert(summary({}, { principal: 40 }, "2026-10-23T12:03:00.000Z"));
    expect([...r.open].map((x) => x.slice(0, 12)).sort()).toEqual(["api-alert-a-", "api-alert-r-"]);
    // 両方の種類を含む警告は、両方の前の警告を解決済みにする
    r.alert(summary({ invalid: 40 }, { principal: 40 }, "2026-10-23T12:04:00.000Z"));
    expect([...r.open]).toHaveLength(1);
    expect([...r.open][0]).toMatch(/^api-alert-ar-/);
    // 解決の要求は、system の記録（inbox.resolved）
    expect(r.records.filter((x) => x.body.type === "inbox.resolved").length).toBe(
      r.resolved.length,
    );
  });

  it("人間が先に解決した警告は、解決の要求を出さない（open にない）。解決に失敗しても、新しい警告は残り、記録に出す", () => {
    const r = rig({ minIntervalMs: 0 });
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:00:00.000Z"));
    const first = [...r.open][0] as string;
    r.open.delete(first); // 人間が解決済みにした
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:01:00.000Z"));
    expect(r.resolved).toEqual([]);
    expect([...r.open]).toHaveLength(1);
  });

  it("記録は defer で窓口の処理から切り離す（既定は setImmediate。defer の中で、初めて記録する）", async () => {
    const records: string[] = [];
    let queued: (() => void) | undefined;
    const alert = createApiAlert({
      threshold: 5,
      minIntervalMs: 0,
      rootNodeId: "root",
      monoMs: () => 0,
      record: (requestId) => {
        records.push(requestId);
        return ok(undefined);
      },
      openAlertIds: () => [],
      defer: (fn) => {
        queued = fn;
      },
      note: () => undefined,
    });
    alert(summary({ invalid: 40 }));
    expect(records).toEqual([]); // 呼び出しの中では、記録しない
    queued?.();
    expect(records).toHaveLength(1);
    // 既定の defer（setImmediate）: 同期では記録せず、次のターンで記録する
    const seen: string[] = [];
    const def = createApiAlert({
      threshold: 5,
      minIntervalMs: 0,
      rootNodeId: "root",
      monoMs: () => 0,
      record: (requestId) => {
        seen.push(requestId);
        return ok(undefined);
      },
      openAlertIds: () => [],
      note: () => undefined,
    });
    def(summary({ invalid: 40 }));
    expect(seen).toEqual([]);
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(seen).toHaveLength(1);
  });

  it("窓の時刻がないイベント（壁時計がない）・形の崩れた時刻は、窓の長さだけを書く（不正な文字列を本文に出さない）", () => {
    const r = rig();
    r.alert({
      ...(summary({ invalid: 40 }) as object),
      windowStart: undefined,
      windowEnd: undefined,
    } as never);
    expect(String(r.records[0]?.body.payload.summary)).toContain("窓（60 秒間）");
    const r2 = rig();
    r2.alert({
      ...(summary({ invalid: 40 }) as object),
      windowStart: "<script>",
      windowEnd: "x",
    } as never);
    const t = String(r2.records[0]?.body.payload.summary);
    expect(t).toContain("窓（60 秒間）");
    expect(t).not.toContain("<script>");
  });

  it("記録できなかったときは、間隔を消費しない（次の窓で、また試す）。例外にしない", () => {
    const r = rig();
    r.failNext();
    r.alert(summary({ invalid: 40 }));
    expect(r.records).toEqual([]);
    expect(r.notes).toEqual(["apiAlert.failed"]);
    r.advance(1000);
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:01:00.000Z"));
    expect(r.records).toHaveLength(1);
  });

  it("本文に、トークン・nodeId・接続元になりうる文字列を出さない: 内訳の名前は、固定の語の形（英字）だけ。形が違うものは、件数には数えるが、名前は書かない", () => {
    const r = rig();
    r.alert(
      summary({
        invalid: 31,
        "token-abc123": 5, // ハイフン・数字から始まらない英字でない
        "127.0.0.1": 5,
        "../x": 5,
        "a b": 5,
      }),
    );
    const text = String(r.records[0]?.body.payload.summary);
    expect(text).toContain("認証の失敗 51 件");
    expect(text).toContain("（invalid 31）");
    for (const secret of ["token-abc123", "127.0.0.1", "../x", "a b"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("内訳の名前は 8 件まで。不正な件数（負・NaN・文字列）は数えない", () => {
    const r = rig({ threshold: 5 });
    const counts: Record<string, number> = {};
    for (let i = 0; i < 12; i++) counts[`kind${String.fromCharCode(97 + i)}`] = 10 + i;
    counts.neg = -5;
    counts.nan = Number.NaN;
    counts.str = "9" as unknown as number;
    r.alert(summary(counts));
    const text = String(r.records[0]?.body.payload.summary);
    expect(text.match(/kind[a-z] \d+/g)).toHaveLength(8);
    expect(text).not.toContain("neg");
    expect(text).not.toContain("nan");
    expect(text).not.toContain("str ");
  });

  describe("退役したトークンでの失敗（retiredExpired）のくり返し", () => {
    it("既定の閾値は 3: 2 件は出さず、ちょうど 3 件で 1 件出す。文面は件数と理由の名前だけ", () => {
      const r = rig();
      r.alert(summary({ retiredExpired: 1 }));
      r.alert(summary({ retiredExpired: 2 }, {}, "2026-10-23T12:01:00.000Z"));
      expect(r.added()).toEqual([]);
      r.alert(summary({ retiredExpired: 3 }, {}, "2026-10-23T12:02:00.000Z"));
      expect(r.added()).toHaveLength(1);
      const p = r.added()[0]?.body.payload;
      expect(p).toMatchObject({ kind: "info", nodeId: "root" });
      expect(String(p?.id)).toMatch(/^api-alert-x-/);
      const text = String(p?.summary);
      expect(text).toContain("退役したトークンでの認証の失敗 3 件（retiredExpired 3）");
      expect(text).toContain("mcp の不具合・トークンの使い回し");
      expect(text).not.toContain("）: 認証の失敗"); // authFailed としては書かない
      expect(text).not.toContain("総当たり");
    });

    it("閾値を超えても 1 件。閾値は設定で変えられる", () => {
      const r = rig();
      r.alert(summary({ retiredExpired: 50 }));
      expect(r.added()).toHaveLength(1);
      expect(String(r.added()[0]?.body.payload.summary)).toContain("retiredExpired 50");
      const r2 = rig({ retiredThreshold: 10 });
      r2.alert(summary({ retiredExpired: 9 }));
      expect(r2.added()).toEqual([]);
      r2.alert(summary({ retiredExpired: 10 }, {}, "2026-10-23T12:01:00.000Z"));
      expect(r2.added()).toHaveLength(1);
    });

    it("間隔の内のくり返しは出さない。間隔のあとは出し、前の警告を解決済みにする", () => {
      const r = rig();
      r.alert(summary({ retiredExpired: 5 }, {}, "2026-10-23T12:00:00.000Z"));
      r.advance(60_000);
      r.alert(summary({ retiredExpired: 5 }, {}, "2026-10-23T12:01:00.000Z"));
      expect(r.added()).toHaveLength(1);
      const first = r.added()[0]?.body.payload.id;
      r.advance(600_000);
      r.alert(summary({ retiredExpired: 5 }, {}, "2026-10-23T12:11:00.000Z"));
      expect(r.added()).toHaveLength(2);
      expect(r.resolved).toEqual([first]);
      expect([...r.open]).toHaveLength(1);
    });

    it("ほかの理由の警告と混ざらない: 認証の失敗の閾値に数えず、間隔・解決は種類ごと", () => {
      const r = rig({ threshold: 5 });
      // retiredExpired は認証の失敗の件数に入らない（invalid 4 + retiredExpired 10 でも authFailed は出ない）
      r.alert(summary({ invalid: 4, retiredExpired: 10 }));
      expect(r.added()).toHaveLength(1);
      const t1 = String(r.added()[0]?.body.payload.summary);
      expect(t1).not.toContain("invalid");
      expect(String(r.added()[0]?.body.payload.id)).toMatch(/^api-alert-x-/);
      // 認証の失敗の警告は、退役の警告の間隔に関係なく出て、退役の警告を解決済みにしない
      r.alert(summary({ invalid: 5 }, {}, "2026-10-23T12:01:00.000Z"));
      expect(r.added()).toHaveLength(2);
      const t2 = String(r.added()[1]?.body.payload.summary);
      expect(t2).toContain("認証の失敗 5 件（invalid 5）");
      expect(t2).not.toContain("retiredExpired");
      expect(r.resolved).toEqual([]);
      expect([...r.open].map((x) => x.slice(0, 12)).sort()).toEqual([
        "api-alert-a-",
        "api-alert-x-",
      ]);
      // 両方が同時に出す条件を満たすと、1 件にまとめ、両方の前の警告を解決済みにする
      r.advance(600_000);
      r.alert(summary({ invalid: 6, retiredExpired: 3 }, {}, "2026-10-23T12:11:00.000Z"));
      expect(r.added()).toHaveLength(3);
      const p3 = r.added()[2]?.body.payload;
      expect(String(p3?.id)).toMatch(/^api-alert-ax-/);
      expect(String(p3?.summary)).toContain(
        "認証の失敗 6 件（invalid 6）・退役したトークンでの認証の失敗 3 件",
      );
      expect([...r.open]).toEqual([p3?.id]);
    });
  });
});

describe("窓口の警告の、英語の文（#140）", () => {
  it("日本語の summary は表の文と同じ。msg は、同じ項目を英語で出す", () => {
    const r = rig({ retiredThreshold: 1 });
    r.alert(summary({ invalid: 40, retiredExpired: 2 }));
    const p = r.added()[0]?.body.payload as { summary: string; msg: never };
    expect(isInboxMessage(p.msg)).toBe(true);
    expect(inboxMessageText("ja", p.msg)).toBe(p.summary);
    expect(inboxMessageText("en", p.msg)).toBe(
      "API alert (2026-10-23T11:59:00 to 2026-10-23T12:00:00 UTC (60 s)): auth failures: 40 (invalid 40), auth failures with retired tokens: 2 (retiredExpired 2). Possible cause: token brute-forcing or runaway calls, calls that keep using a retired binding's token (an mcp bug or token reuse) (the daemon log's apiSummary has the breakdown)",
    );
  });
});
