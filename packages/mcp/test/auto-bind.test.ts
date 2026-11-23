import { failure, ok, type Result } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { startAutoBind } from "../src/auto-bind.js";
import { flush, manualClock } from "./manual-clock.js";

// 紐付け待ちの間の自動の紐付け（#255）の、時間の流れと間隔。daemon・ファイルは、すべて差し替える。
const INTERVAL = 60_000;
const MAX = 600_000;

const fail = (code: string): Result<never> => ({
  ok: false,
  error: failure(code, "試験の失敗", "なし"),
});

function harness(init: {
  file?: "present" | "missing" | "unusable";
  rebind?: () => Result<unknown> | undefined;
  bindFromFile?: () => Result<unknown>;
  canRebind?: boolean;
}) {
  const clock = manualClock();
  const abort = new AbortController();
  const state = {
    bound: false,
    file: init.file ?? "missing",
    tick: 0,
    rebindAt: [] as number[],
    fileAt: [] as number[],
    onBound: 0,
    logs: [] as Record<string, unknown>[],
  };
  const done = startAutoBind({
    isBound: () => state.bound,
    codeFile: () => state.file,
    canRebind: init.canRebind ?? true,
    bindFromFile: async () => {
      state.fileAt.push(state.tick);
      const r = init.bindFromFile?.() ?? ok(undefined);
      if (r.ok) state.bound = true;
      return r;
    },
    rebind: async () => {
      state.rebindAt.push(state.tick);
      const r = init.rebind?.() ?? fail("bind_failed");
      if (r?.ok === true) state.bound = true;
      return r;
    },
    onBound: async () => {
      state.onBound += 1;
    },
    log: (e) => state.logs.push(e),
    intervalMs: INTERVAL,
    maxIntervalMs: MAX,
    sleep: clock.sleep,
    signal: abort.signal,
  });
  const advance = async (n: number) => {
    for (let i = 0; i < n; i++) {
      state.tick += 1;
      await clock.tick();
    }
  };
  const stop = async () => {
    abort.abort();
    await clock.tick();
    await done;
  };
  return { state, advance, stop, clock };
}

describe("自動の紐付けの間隔", () => {
  it("起動直後に 1 回試し、失敗のたびに間隔を倍にして、上限（10 分）で止まる", async () => {
    const h = harness({});
    await flush();
    await h.advance(36);
    // 試す間隔: 60 秒 → 120 秒 → 240 秒 → 480 秒 → 上限の 600 秒（間隔の数: 1, 2, 4, 8, 10, 10）
    expect(h.state.rebindAt).toEqual([0, 1, 3, 7, 15, 25, 35]);
    expect(h.state.onBound).toBe(0);
    await h.stop();
  });

  it("429（rate_limited）を受けたら、すぐ上限まで待つ", async () => {
    const h = harness({ rebind: () => fail("rate_limited") });
    await flush();
    await h.advance(25);
    expect(h.state.rebindAt).toEqual([0, 10, 20]);
    await h.stop();
  });

  it("通ったら、道具の切り替えの処理を 1 回だけ呼び、それ以後は何もしない", async () => {
    const h = harness({ rebind: () => ok(undefined) });
    await flush();
    await h.advance(5);
    expect(h.state.rebindAt).toEqual([0]);
    expect(h.state.onBound).toBe(1);
    await h.stop();
  });
});

describe("コードのファイルの扱い", () => {
  it("最初の起動（コードのファイルがある）では、コードなしの結び直しを試さず、ファイルを使う", async () => {
    const h = harness({ file: "present" });
    await flush();
    expect(h.state.fileAt).toEqual([0]);
    expect(h.state.rebindAt).toEqual([]);
    expect(h.state.onBound).toBe(1);
    await h.advance(3);
    expect(h.state.fileAt).toEqual([0]);
    await h.stop();
  });

  it("結び直しが失敗している間に、ファイルが現れたら、間隔を待たずに使って紐付く", async () => {
    const h = harness({});
    await flush();
    await h.advance(2); // 結び直しは 0・1 で失敗（次は 3）
    h.state.file = "present";
    await h.advance(1); // 2 回目の確かめ。結び直しの間隔は、まだ来ていない
    expect(h.state.fileAt).toEqual([3]);
    expect(h.state.rebindAt).toEqual([0, 1]);
    expect(h.state.onBound).toBe(1);
    await h.stop();
  });

  it("ファイルを使って失敗が続くときも、daemon を叩く間隔を倍にする（使えないコードを、毎回送らない）", async () => {
    const h = harness({ file: "present", bindFromFile: () => fail("bind_failed") });
    await flush();
    await h.advance(16);
    expect(h.state.fileAt).toEqual([0, 1, 3, 7, 15]);
    await h.stop();
  });

  it("ファイルが安全でない・読めないときは、何もしない（理由は、子の AI の child_bind が返す）", async () => {
    const h = harness({ file: "unusable" });
    await flush();
    await h.advance(5);
    expect(h.state.fileAt).toEqual([]);
    expect(h.state.rebindAt).toEqual([]);
    await h.stop();
  });

  it("印・セッション ID がなくて結び直せないときは、結び直しを試さない（ファイルは見る）", async () => {
    const h = harness({ canRebind: false });
    await flush();
    await h.advance(3);
    expect(h.state.rebindAt).toEqual([]);
    h.state.file = "present";
    await h.advance(1);
    expect(h.state.fileAt).toEqual([4]);
    await h.stop();
  });
});

describe("紐付いたあとに外れたとき", () => {
  it("外れた直後は、道具の 401 の復旧が試したばかりなので、1 間隔あとに結び直す", async () => {
    const h = harness({ rebind: () => ok(undefined) });
    await flush();
    expect(h.state.rebindAt).toEqual([0]);
    await h.advance(2);
    // 401 で入れ物が空になった
    h.state.bound = false;
    await h.advance(1); // 外れたと気づいた回: すぐには試さない
    expect(h.state.rebindAt).toEqual([0]);
    await h.advance(1);
    expect(h.state.rebindAt).toEqual([0, 4]);
    expect(h.state.onBound).toBe(2);
    await h.stop();
  });

  it("ログには、記号と失敗の記号だけを出す（値は出さない）", async () => {
    const h = harness({});
    await flush();
    await h.advance(2);
    expect(h.state.logs[0]).toMatchObject({
      event: "autoBindFailed",
      via: "rebind",
      code: "bind_failed",
      nextWaitMs: INTERVAL,
    });
    await h.stop();
  });
});
