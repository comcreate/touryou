/**
 * 紐付け（bind）のトークンの「使われなければ切れる」時計（#189・#208）を、偽の時計を進めて確かめる。
 *
 * 待機の子（`child_bind` のあと報告を 1 回送り、道具を呼ばずに待つ子）でも、`/v1/events` の購読が張られていれば、
 * 購読の接続と heartbeat（15 秒ごと）の確かめが認証を通り、トークンの時計を延ばす。だから、道具を呼ばなくても
 * 失効の前の知らせ（tokenIdleSoonBind）も失効の知らせ（tokenExpiredIdleBind）も出ない。これは仕様どおりの動き。
 * 購読が張られていない（確かめが来ない）ときだけ、約 50 分で前の知らせ、60 分で失効になる。
 */
import { describe, expect, it } from "vitest";
import { createCredentialStore, type ExpiryReason } from "../../src/api/credentials.js";
import { idleWarnMsOf, TOKEN_SWEEP_MS } from "../../src/bind-notices.js";

const MIN = 60_000;
const HEARTBEAT_MS = 15_000;
const HUMAN = "h".repeat(40);
const BIND_IDLE_MS = 60 * MIN;
/** 切れる前の知らせの窓（既定。`idleWarnMsOf(BIND_IDLE_MS)` と同じ。型を `number` に保つため、ここで固定する）。 */
const WARN_MS = 2 * TOKEN_SWEEP_MS;

const setup = () => {
  let now = Date.UTC(2026, 9, 20, 0, 0, 0);
  const soon: { nodeId: string; remainingMs: number; atMin: number }[] = [];
  const expired: { nodeId: string; reason: ExpiryReason; atMin: number }[] = [];
  const start = now;
  const store = createCredentialStore({
    humanToken: HUMAN,
    nowMs: () => now,
    expiry: {
      sdkIdleMs: 6 * 60 * MIN,
      bindAbsoluteMs: 24 * 60 * MIN,
      bindIdleMs: BIND_IDLE_MS,
    },
    idleWarnMs: WARN_MS,
    onIdleSoon: (info) => {
      const atMin = (now - start) / MIN;
      soon.push({ nodeId: info.nodeId, remainingMs: info.remainingMs, atMin });
      return true;
    },
    onExpired: (nodeId, reason) => {
      expired.push({ nodeId, reason, atMin: (now - start) / MIN });
    },
  });
  const token = store.issueNodeToken("a", "child", "bind");
  /** 偽の時計を 1 ステップ（15 秒）進め、5 分ごとに見回す。`each` は、そのステップで子が行う呼び出し。 */
  const run = (minutes: number, each?: () => void) => {
    const steps = (minutes * MIN) / HEARTBEAT_MS;
    for (let i = 0; i < steps; i++) {
      now += HEARTBEAT_MS;
      each?.();
      if ((now - start) % TOKEN_SWEEP_MS === 0) store.sweepExpired?.();
    }
  };
  return { store, token, soon, expired, run };
};

describe("bind のトークンの idle の時計（偽の時計）", () => {
  it("購読の heartbeat（15 秒ごとの確かめ。時計を延ばす）が続く間は、70 分たっても、前の知らせも失効の知らせも出ない", () => {
    const { store, token, soon, expired, run } = setup();
    run(70, () => {
      expect(store.authenticate(token)).toEqual({ role: "child", nodeId: "a" });
    });
    expect(soon).toEqual([]);
    expect(expired).toEqual([]);
    expect(store.hasBindToken?.("a")).toBe(true);
  });

  it("確かめが来ない（道具も購読もない）と、50 分で前の知らせが 1 回、60 分で idle の失効になる", () => {
    const { store, token, soon, expired, run } = setup();
    run(70);
    expect(idleWarnMsOf(BIND_IDLE_MS)).toBe(WARN_MS);
    expect(soon).toEqual([{ nodeId: "a", remainingMs: WARN_MS, atMin: 50 }]);
    expect(expired).toEqual([{ nodeId: "a", reason: "idle", atMin: 60 }]);
    expect(store.authenticate(token)).toBeUndefined();
    expect(store.wasExpired?.(token)).toBe(true);
  });

  it("時計を延ばさない確かめ（touch を偽にした認証）だけでは、延びない（確かめ方で、結果が分かれる）", () => {
    const { store, token, soon, expired, run } = setup();
    run(70, () => {
      store.authenticate(token, false);
    });
    expect(soon).toHaveLength(1);
    expect(expired).toEqual([{ nodeId: "a", reason: "idle", atMin: 60 }]);
  });

  it("5 分に 1 回だけ使う子（購読なし）は、使うたびに延びる。最後に使ってから 50 分で前の知らせ", () => {
    const { store, token, soon, expired, run } = setup();
    let n = 0;
    run(30, () => {
      n++;
      // 5 分に 1 回（20 ステップ）だけ使う
      if (n % 20 === 0) store.touchNode("a");
    });
    expect(soon).toEqual([]);
    expect(expired).toEqual([]);
    // 30 分で最後に使った。その 50 分あと（開始から 80 分）に前の知らせ、60 分あと（90 分）に失効
    run(70);
    expect(soon).toEqual([{ nodeId: "a", remainingMs: WARN_MS, atMin: 80 }]);
    expect(expired).toEqual([{ nodeId: "a", reason: "idle", atMin: 90 }]);
    expect(store.authenticate(token)).toBeUndefined();
  });
});
