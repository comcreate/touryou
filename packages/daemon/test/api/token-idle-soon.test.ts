import { describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";

const HUMAN = "h".repeat(40);
const MIN = 60_000;
const T0 = Date.parse("2026-10-20T00:00:00.000Z");

/** 時計を進められるストア。bindIdle は 60 分、前置きは 10 分。 */
const setup = (
  over: {
    isIdlePaused?: (n: string) => boolean;
    isRetired?: () => boolean;
    onIdleSoon?: (i: { nodeId: string; remainingMs: number; lastUsedMs: number }) => boolean;
    onIdleRecovered?: (nodeId: string) => boolean;
    hasOpenIdleSoon?: (nodeId: string) => boolean;
    repository?: {
      load: () => unknown[];
      put: () => void;
      remove: () => void;
    };
  } = {},
) => {
  let now = T0;
  const soon: { nodeId: string; remainingMs: number; lastUsedMs: number }[] = [];
  const s = createCredentialStore({
    humanToken: HUMAN,
    nowMs: () => now,
    clock: () => new Date(now).toISOString(),
    exemptNodeId: "root",
    expiry: {
      sdkIdleMs: 360 * MIN,
      sdkAbsoluteMs: 10_080 * MIN,
      bindAbsoluteMs: 1440 * MIN,
      bindIdleMs: 60 * MIN,
    },
    idleWarnMs: 10 * MIN,
    onIdleSoon: (i: { nodeId: string; remainingMs: number; lastUsedMs: number }) => {
      soon.push(i);
      return true;
    },
    ...over,
  } as never);
  return { s, soon, advance: (ms: number) => (now += ms) };
};

describe("失効の前の知らせ（#189）", () => {
  it("前置きの前は出ない。前置きに入ると 1 回だけ出る", () => {
    const { s, soon, advance } = setup();
    s.issueNodeToken("a", "child", "bind");
    advance(49 * MIN);
    s.sweepExpired?.();
    expect(soon).toEqual([]);
    advance(2 * MIN); // 切れるまで 9 分
    s.sweepExpired?.();
    s.sweepExpired?.();
    expect(soon).toHaveLength(1);
    expect(soon[0]?.nodeId).toBe("a");
    expect(soon[0]?.remainingMs).toBe(9 * MIN);
  });

  it("使われると印が外れ、また止まれば、もう一度出る", () => {
    const { s, soon, advance } = setup();
    const t = s.issueNodeToken("a", "child", "bind");
    advance(52 * MIN);
    s.sweepExpired?.();
    expect(soon).toHaveLength(1);
    expect(s.authenticate(t)).toBeDefined(); // 使った: 時計が延びる
    advance(52 * MIN);
    s.sweepExpired?.();
    expect(soon).toHaveLength(2);
  });

  it("失効したあとは出ない（失効の知らせだけ）", () => {
    const { s, soon, advance } = setup();
    s.issueNodeToken("a", "child", "bind");
    advance(61 * MIN);
    s.sweepExpired?.();
    expect(soon).toEqual([]);
  });

  it("sdk・根・判断待ち（時計が止まる子）・役目の終わった子には出ない", () => {
    const paused = new Set(["p"]);
    const { s, soon, advance } = setup({ isIdlePaused: (n) => paused.has(n) });
    s.issueNodeToken("sdk", "child", "sdk");
    s.issueNodeToken("root", "integrator", "bind");
    s.issueNodeToken("p", "child", "bind");
    advance(55 * MIN);
    s.sweepExpired?.();
    expect(soon).toEqual([]);

    const r = setup({ isRetired: () => true });
    r.s.issueNodeToken("x", "child", "bind");
    r.advance(55 * MIN);
    r.s.sweepExpired?.();
    expect(r.soon).toEqual([]);
  });

  it("知らせを記録できなかった（false・例外）ときは印を立てず、次の見回りでもう一度呼ぶ。できたら 1 回だけ", () => {
    const results = [false, "throw", true] as const;
    let calls = 0;
    const { s, advance } = setup({
      onIdleSoon: () => {
        const r = results[Math.min(calls++, results.length - 1)];
        if (r === "throw") throw new Error("追記の失敗");
        return r === true;
      },
    });
    s.issueNodeToken("a", "child", "bind");
    advance(52 * MIN);
    s.sweepExpired?.();
    s.sweepExpired?.();
    s.sweepExpired?.();
    expect(calls).toBe(3);
    s.sweepExpired?.(); // 記録できたので、もう呼ばない
    expect(calls).toBe(3);
  });

  it("出したあとに使われて切れなくなったら、見回りで 1 回だけ onIdleRecovered を呼ぶ（認証では呼ばない）", () => {
    const recovered: string[] = [];
    const { s, soon, advance } = setup({ onIdleRecovered: (n) => (recovered.push(n), true) });
    const t = s.issueNodeToken("a", "child", "bind");
    advance(52 * MIN);
    s.sweepExpired?.();
    expect(soon).toHaveLength(1);
    expect(s.authenticate(t)).toBeDefined();
    expect(recovered).toEqual([]);
    s.sweepExpired?.();
    s.sweepExpired?.();
    expect(recovered).toEqual(["a"]);
    // 出していない子には呼ばない
    const b = setup({ onIdleRecovered: (n) => (recovered.push(n), true) });
    b.s.issueNodeToken("b", "child", "bind");
    b.advance(10 * MIN);
    b.s.sweepExpired?.();
    expect(recovered).toEqual(["a"]);
  });

  it("解決にできなかった（false・例外）ときは印を残し、次の見回りでもう一度 onIdleRecovered を呼ぶ。できたら呼ばない", () => {
    const results = [false, "throw", true] as const;
    let calls = 0;
    const { s, advance } = setup({
      onIdleRecovered: () => {
        const r = results[Math.min(calls++, results.length - 1)];
        if (r === "throw") throw new Error("解決の失敗");
        return r === true;
      },
    });
    const t = s.issueNodeToken("a", "child", "bind");
    advance(52 * MIN);
    s.sweepExpired?.(); // 出す
    expect(s.authenticate(t)).toBeDefined(); // 使われて復帰
    s.sweepExpired?.();
    s.sweepExpired?.();
    s.sweepExpired?.();
    expect(calls).toBe(3);
    s.sweepExpired?.(); // 解決できたので、もう呼ばない
    expect(calls).toBe(3);
  });

  /** 再起動の前に保存された bind のトークン（発行から 10 分）を読み戻して始めるストア。 */
  const restarted = (over: Parameters<typeof setup>[0]) =>
    setup({
      repository: {
        load: () => [
          {
            tokenHash: "a".repeat(64),
            role: "child",
            nodeId: "a",
            issuedAt: new Date(T0 - 10 * MIN).toISOString(),
            lastUsedAt: new Date(T0 - 10 * MIN).toISOString(),
            kind: "bind",
          },
        ],
        put: () => {},
        remove: () => {},
      },
      ...over,
    });

  it("再起動のあと、未解決の知らせが残っていて切れなくなっていれば、見回りで解決にする（メモリの印がなくても）", () => {
    let open = true;
    const recovered: string[] = [];
    const { s, soon, advance } = restarted({
      hasOpenIdleSoon: () => open,
      onIdleRecovered: (n) => {
        recovered.push(n);
        open = false;
        return true;
      },
    });
    // 起動から使われなかった時間は数え直す（切れるまで 60 分）ので、前置きの窓の外。残っていた知らせを解決にする
    s.sweepExpired?.();
    s.sweepExpired?.();
    expect(recovered).toEqual(["a"]);
    expect(soon).toEqual([]);
    advance(5 * MIN);
    s.sweepExpired?.();
    expect(recovered).toEqual(["a"]);
  });

  it("再起動のあと、窓の中で、同じ知らせが未解決で残っていれば、二重に出さない。そのあと復帰すれば解決にする", () => {
    let open = true;
    const recovered: string[] = [];
    const { s, soon, advance } = restarted({
      hasOpenIdleSoon: () => open,
      onIdleRecovered: (n) => {
        recovered.push(n);
        open = false;
        return true;
      },
    });
    advance(52 * MIN); // 起動から 52 分使われない: 窓の中
    s.sweepExpired?.();
    s.sweepExpired?.();
    expect(soon).toEqual([]);
    expect(recovered).toEqual([]);
    // 使われて切れなくなる（印は上の見回りで立っている）
    s.touchNode?.("a");
    s.sweepExpired?.();
    expect(recovered).toEqual(["a"]);
    expect(soon).toEqual([]);
  });

  describe("使ったものとして数えない確かめ（authenticate の touch = false。#189）", () => {
    it("touch = false の確かめは、使わなければ切れる時計を延ばさない（切れる期限も、そのまま効く）", () => {
      const { s, advance } = setup();
      const t = s.issueNodeToken("a", "child", "bind");
      advance(52 * MIN);
      expect(s.authenticate(t, false)).toBeDefined(); // 確かめるだけ
      advance(9 * MIN); // 最後に使ってから 61 分
      expect(s.authenticate(t, false)).toBeUndefined();
      expect(s.wasExpired?.(t)).toBe(true);
    });

    it("touch = false を繰り返しても、前置きは出続け、時計は延びない。使えば（既定・touchNode）延びる", () => {
      const { s, soon, advance } = setup();
      const t = s.issueNodeToken("a", "child", "bind");
      for (let i = 0; i < 52; i++) {
        advance(MIN);
        s.authenticate(t, false); // heartbeat・知らせの読み出しに相当する
      }
      s.sweepExpired?.();
      expect(soon).toHaveLength(1); // 時計が延びていないので、窓に入っている
      s.authenticate(t); // 使った
      advance(9 * MIN);
      expect(s.authenticate(t, false)).toBeDefined(); // 延びたので、まだ切れない
      s.touchNode?.("a");
      advance(59 * MIN);
      expect(s.authenticate(t, false)).toBeDefined(); // touchNode でも延びる
    });
  });

  it("発行からの絶対の期限が先に来るときは出さない", () => {
    const { s, soon, advance } = setup();
    const t = s.issueNodeToken("a", "child", "bind");
    // 使い続けて、発行から 23 時間 55 分まで進める（最後に使ってから 55 分）
    for (let i = 0; i < 23; i++) {
      advance(59 * MIN);
      s.authenticate(t);
    }
    soon.length = 0;
    advance(10 * MIN);
    s.sweepExpired?.();
    // 絶対の期限（24 時間）まで残りわずか: idle の期限（最後に使ってから 60 分）より先に来る
    expect(soon).toEqual([]);
  });

  it("絶対の期限が、いま使って延びる先（いま + bindIdle）より前に来るときは出さない。先に来るなら出す（#198）", () => {
    const { s, soon, advance } = setup();
    const t = s.issueNodeToken("a", "child", "bind");
    for (let i = 0; i < 22; i++) {
      advance(59 * MIN);
      s.authenticate(t);
    }
    // 最後に使ったのは発行から 21 時間 38 分。51 分たって 22 時間 29 分（切れるまで 8 分）。
    // いま使えば 23 時間 29 分まで延び、絶対の期限（24 時間）はその先なので、知らせる
    advance(51 * MIN);
    s.sweepExpired?.();
    expect(soon).toHaveLength(1);

    // 最後に使ったのが 22 時間 37 分なら、いま（23 時間 29 分）使っても 24 時間 29 分まで延びる前に絶対の期限が来る。
    // 旧: idle の期限 + 窓（10 分）より先なので出ていた。使っても生き延びないので出さない
    const c = setup();
    const tc = c.s.issueNodeToken("c", "child", "bind");
    for (let i = 0; i < 23; i++) {
      c.advance(59 * MIN);
      c.s.authenticate(tc);
    }
    c.advance(52 * MIN);
    c.s.sweepExpired?.();
    expect(c.soon).toEqual([]);

    const b = setup();
    const tb = b.s.issueNodeToken("b", "child", "bind");
    for (let i = 0; i < 23; i++) {
      b.advance(59 * MIN);
      b.s.authenticate(tb);
    }
    b.advance(18 * MIN);
    b.s.authenticate(tb); // 発行から 22 時間 55 分。絶対の期限は idle の期限の 5 分後で、窓の中
    b.advance(52 * MIN);
    b.s.sweepExpired?.();
    expect(b.soon).toEqual([]);
  });
});
