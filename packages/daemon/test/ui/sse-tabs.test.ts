/**
 * 状態画面の購読（`/v1/events`）を、タブが多いときに取り合わないこと（本物の `/ui` と daemon の API サーバー。Playwright）。
 * - 人の側の枠（既定 4）が埋まったら、いちばん古いタブが譲り（`event: replaced`）、張り直さずにポーリングに移る。
 *   譲ったタブは、フォーカス・見えたときだけ張り直す（タブどうしで、自分から交互に追い出し合わない）。
 * - 裏に回って 4 秒たったタブは、購読を閉じる（利用者の決めで、枠が埋まったときは裏のタブを先に譲る）。見えたら張り直し、最新を取り直す。
 * - 枠が埋まったときは、表のタブのうちいちばん古いものが譲る（裏に回って閉じたタブは、枠を持たない）。
 * - 429 が 3 回続いたら、購読の再試行をやめる（見えたとき・フォーカスで試す）。
 */
import { foldEvents } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";
import { type Browser, type Page, type Pw, pw } from "./playwright.js";

const HUMAN = "human-token-human-token-human-token-1234";
const state = (() => {
  const r = foldEvents([]);
  if (!r.ok) throw new Error(r.error.cause);
  return r.value;
})();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(maxConnections?: number) {
  const server: ApiServer = createApiServer({
    credentials: createCredentialStore({ humanToken: HUMAN }),
    getState: () => state,
    handlers: {},
    ...(maxConnections === undefined ? {} : { sse: { maxConnections } }),
  });
  const url = (await server.listen(0)).url;
  cleanups.push(() => server.close());
  const browser: Browser = await (pw as Pw).chromium.launch();
  cleanups.push(() => browser.close());
  const ticket = async (): Promise<string> => {
    const res = await fetch(`${url}/v1/ui/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUMAN}` },
    });
    return ((await res.json()) as { value: { ticket: string } }).value.ticket;
  };
  /** 1 つのタブを開く（タブごとに別の画面のセッション）。`/v1/events` を開いた回数を数える。 */
  const openTab = async (o: { clock?: boolean } = {}) => {
    const page: Page = await browser.newPage({
      viewport: { width: 900, height: 600 },
      locale: "ja-JP",
    });
    const tab = { page, events: 0, states: 0 };
    page.on("request", (r) => {
      if (r.url().endsWith("/v1/events")) tab.events += 1;
      if (r.url().includes("/v1/ui/state")) tab.states += 1;
    });
    if (o.clock === true) {
      await page.clock.install();
      // 偽の時計を進めると、背景の描画（rAF）が何千回も走って時間切れになる。この試験は背景を見ないので描かせない
      await page.emulateMedia({ reducedMotion: "reduce" });
    }
    await page.goto(`${url}/ui#ticket=${await ticket()}`);
    return tab;
  };
  return { openTab };
}

const status = (p: Page) => p.evaluate(() => document.getElementById("status")?.textContent ?? "");
const waitStatus = (p: Page, part: string) =>
  p.waitForFunction(
    // biome-ignore lint/suspicious/noExplicitAny: 引数は文字列
    ((s: any) => (document.getElementById("status")?.textContent ?? "").includes(s)) as never,
    part as never,
    { timeout: 15_000 },
  );
/** 偽の時計を、少しずつ進める（進めるあいだに、本物の通信の返事を待つ）。 */
const advance = async (p: Page, ms: number, step = 5_000) => {
  for (let t = 0; t < ms; t += step) {
    await p.clock.runFor(step);
    await new Promise((r) => setTimeout(r, 30));
  }
};
/** タブを裏に回す・戻す（Playwright の無頭の Chromium では、document.hidden を上書きして visibilitychange を送る）。 */
const setHidden = (p: Page, hidden: boolean) =>
  p.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

describe.skipIf(pw === null)("状態画面の購読を、タブどうしで取り合わない（Playwright）", () => {
  it("5 つ目のタブを開くと、いちばん古いタブが譲る。譲ったタブは張り直さず、フォーカスで張り直す（交互に追い出し合わない）", async () => {
    const s = await setup();
    const tabs = [];
    for (let i = 0; i < 4; i++) {
      const t = await s.openTab();
      await waitStatus(t.page, "変わるとすぐ更新");
      tabs.push(t);
    }
    const fifth = await s.openTab();
    await waitStatus(fifth.page, "変わるとすぐ更新");
    const [first, second] = tabs as [(typeof tabs)[0], (typeof tabs)[0]];
    await waitStatus(first.page, "別のタブで開いています");
    for (const t of tabs.slice(1)) expect(await status(t.page)).toContain("変わるとすぐ更新");
    // 譲ったタブは、自分からは張り直さない（数秒待っても、/v1/events を開き直さない）
    const before = first.events;
    await first.page.waitForTimeout(3000);
    expect(first.events).toBe(before);
    expect(await status(second.page)).toContain("変わるとすぐ更新");
    // フォーカスが来たら張り直す。そのとき、いちばん古い（2 つ目の）タブが譲る。譲ったタブも、自分からは張り直さない
    await first.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await waitStatus(first.page, "変わるとすぐ更新");
    await waitStatus(second.page, "別のタブで開いています");
    const secondBefore = second.events;
    await second.page.waitForTimeout(3000);
    expect(second.events).toBe(secondBefore);
    expect(await status(first.page)).toContain("変わるとすぐ更新");
  }, 90_000);

  it("裏に回って 4 秒たったら購読を閉じ、確かめの間を 30 秒にする。見えたら張り直し、最新を取り直す", async () => {
    const s = await setup();
    const t = await s.openTab({ clock: true });
    await waitStatus(t.page, "変わるとすぐ更新");
    await setHidden(t.page, true);
    await t.page.clock.runFor(2_000);
    expect(await status(t.page)).toContain("変わるとすぐ更新"); // まだ 4 秒たっていない（すぐ戻ればチラつかない）
    await t.page.clock.runFor(2_500);
    await waitStatus(t.page, "30 秒ごとに確かめて更新");
    // 裏の間は、張り直さない
    const before = t.events;
    await advance(t.page, 120_000);
    expect(t.events).toBe(before);
    const statesBefore = t.states;
    await setHidden(t.page, false);
    await waitStatus(t.page, "変わるとすぐ更新");
    expect(t.events).toBe(before + 1);
    // 見えたら、状態を取り直す（裏の間の古い表示のまま残らない。取り直しは最短 1 秒ごとにまとめる）
    await advance(t.page, 2_000, 500);
    expect(t.states).toBeGreaterThan(statesBefore);
  }, 60_000);

  it("枠が埋まったときは、裏のタブを先に譲る：裏に回って閉じたタブは枠を持たず、外れるのは表のいちばん古いタブ", async () => {
    const s = await setup();
    const tabs = [];
    for (let i = 0; i < 4; i++) {
      const t = await s.openTab();
      await waitStatus(t.page, "変わるとすぐ更新");
      tabs.push(t);
    }
    const [first, second, third] = tabs as [(typeof tabs)[0], (typeof tabs)[0], (typeof tabs)[0]];
    // いちばん古いタブを裏に回す。短い待ちで閉じて、枠を空ける
    await setHidden(first.page, true);
    await waitStatus(first.page, "30 秒ごとに確かめて更新");
    // 5 つ目は、空いた枠に入る（だれも譲らない）
    const fifth = await s.openTab();
    await waitStatus(fifth.page, "変わるとすぐ更新");
    for (const t of tabs.slice(1)) expect(await status(t.page)).toContain("変わるとすぐ更新");
    // 6 つ目で枠が埋まる。譲るのは、表のタブのうちいちばん古い 2 つ目（裏のタブは、もう枠を持っていない）
    const sixth = await s.openTab();
    await waitStatus(sixth.page, "変わるとすぐ更新");
    await waitStatus(second.page, "別のタブで開いています");
    expect(await status(third.page)).toContain("変わるとすぐ更新");
    expect(await status(first.page)).not.toContain("別のタブで開いています");
  }, 90_000);

  it("429 が 3 回続いたら、購読の再試行をやめる。フォーカスで、もう一度だけ試す", async () => {
    const s = await setup(0); // 枠が 0（いつも 429）
    const t = await s.openTab({ clock: true });
    await waitStatus(t.page, "2 秒ごとに確かめて更新");
    await advance(t.page, 10 * 60_000);
    expect(t.events).toBe(3);
    await t.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await advance(t.page, 10 * 60_000);
    expect(t.events).toBe(6);
  }, 60_000);
});
