import { describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";

const HUMAN = "h".repeat(40);
const MIN = 60_000;
const T0 = Date.parse("2026-10-20T00:00:00.000Z");

/** 時計を進められるストア。bindIdle は 60 分、前置きは 10 分。 */
const setup = (over: { isIdlePaused?: (n: string) => boolean; isRetired?: () => boolean } = {}) => {
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
    onIdleSoon: (i) => soon.push(i),
    ...over,
  });
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
