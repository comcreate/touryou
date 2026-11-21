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
    onIdleRecovered?: (nodeId: string) => void;
    onTokenIssued?: (nodeId: string, kind: string) => void;
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
    const { s, soon, advance } = setup({ onIdleRecovered: (n) => recovered.push(n) });
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
    const b = setup({ onIdleRecovered: (n) => recovered.push(n) });
    b.s.issueNodeToken("b", "child", "bind");
    b.advance(10 * MIN);
    b.s.sweepExpired?.();
    expect(recovered).toEqual(["a"]);
  });

  it("onTokenIssued は、発行（つなぎ直しを含む）のたびに、ノードと種類つきで呼ぶ。例外は発行を止めない", () => {
    const issued: string[] = [];
    const { s } = setup({
      onTokenIssued: (n, k) => {
        issued.push(`${n}:${k}`);
        throw new Error("解決の失敗");
      },
    });
    expect(typeof s.issueNodeToken("a", "child", "bind")).toBe("string");
    expect(typeof s.rebindNodeToken?.("a")).toBe("string");
    s.issueNodeToken("b", "child");
    expect(issued).toEqual(["a:bind", "a:bind", "b:sdk"]);
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
});
