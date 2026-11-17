/**
 * 状態画面の購読（`/v1/events`）を、タブが多いときに取り合わないこと（本物の `/ui` と daemon の API サーバー。Playwright）。
 * - 人の側の枠（既定 4）が埋まったら、いちばん古いタブが譲り（`event: replaced`）、張り直さずにポーリングに移る。
 *   譲ったタブは、フォーカス・見えたときだけ張り直す（タブどうしで、自分から交互に追い出し合わない）。
 * - 裏に回って 30 秒たったタブは、購読を閉じる。見えたら張り直す。
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
    const page: Page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const tab = { page, events: 0 };
    page.on("request", (r) => {
      if (r.url().endsWith("/v1/events")) tab.events += 1;
    });
    if (o.clock === true) await page.clock.install();
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

  it("裏に回って 30 秒たったら購読を閉じ、確かめの間を 30 秒にする。見えたら張り直す", async () => {
    const s = await setup();
    const t = await s.openTab({ clock: true });
    await waitStatus(t.page, "変わるとすぐ更新");
    await setHidden(t.page, true);
    await t.page.clock.runFor(10_000);
    expect(await status(t.page)).toContain("変わるとすぐ更新"); // まだ 30 秒たっていない
    await t.page.clock.runFor(21_000);
    await waitStatus(t.page, "30 秒ごとに確かめて更新");
    // 裏の間は、張り直さない
    const before = t.events;
    await advance(t.page, 120_000);
    expect(t.events).toBe(before);
    await setHidden(t.page, false);
    await waitStatus(t.page, "変わるとすぐ更新");
    expect(t.events).toBe(before + 1);
  }, 60_000);

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
