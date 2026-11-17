/**
 * 本物の `/ui` を、daemon の API サーバーから開く Playwright の試験（#89 の PR-5）。
 * いまの CSP（`UI_HEADERS`）のまま、画面が `/ui/graph.js` を読み、`#graph` に関係図を描くこと、
 * 図と一覧を切り替えられること、「動きを止める」と OS の `prefers-reduced-motion` で図の動きが止まることを確かめる。
 * 画面写し（`docs/images/ui-light.png`・`ui-dark.png`）は、`TOURYOU_UI_SHOTS=<ディレクトリ>` のときだけ撮る（値は作り物）。
 */
import { foldEvents, type OrchEvent } from "@touryou/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";
import { type Browser, type Page, type Pw, pw, type Win } from "./playwright.js";

const HUMAN = "human-token-human-token-human-token-1234";
let n = 0;
const ev = (body: unknown, actor: unknown = { system: true }): OrchEvent =>
  ({
    seq: ++n,
    at: new Date(Date.now() - (60 - n) * 60_000).toISOString(),
    requestId: `r${n}`,
    actor,
    ...(body as object),
  }) as OrchEvent;
const created = (nodeId: string, role: string, parentId: string | null, objective: string) => [
  ev({
    type: "node.created",
    payload: {
      nodeId,
      role,
      parentId,
      dependsOn: [],
      objective,
      acceptanceCriteria: ["x"],
      scope: { writableLocations: ["src"], forbiddenLocations: [], allowedCommands: [] },
    },
  }),
  ev({ type: "node.stateChanged", payload: { nodeId, event: { type: "start" } } }),
];

describe.skipIf(pw === null)("本物の /ui（Playwright。CSP の下で関係図を描く）", () => {
  let server: ApiServer;
  let browser: Browser | undefined;
  let page: Page;
  let url = "";
  const problems: string[] = [];
  const state = (() => {
    const r = foldEvents([
      ...created("root", "integrator", null, "状態画面の作り直しをまとめる"),
      ...created("ui-a", "implement", "root", "画面に関係図を出す"),
      ...created("ui-b", "review", "root", "関係図のレビュー"),
      ...created("ui-c", "implement", "root", "一覧の見せ方を直す"),
      ev({ type: "node.instructed", payload: { nodeId: "ui-a", text: "x" } }, { nodeId: "root" }),
      // 人からの指示（段を飛ばす。木の外の「人」の箱から）
      ev({ type: "node.instructed", payload: { nodeId: "ui-c", text: "x" } }),
      ev({
        type: "decision.requested",
        payload: { decisionId: "d1", nodeId: "ui-b", question: "どちらにしますか" },
      }),
    ]);
    if (!r.ok) throw new Error(r.error.cause);
    return r.value;
  })();
  const ticket = async (): Promise<string> => {
    const res = await fetch(`${url}/v1/ui/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUMAN}` },
    });
    const body = (await res.json()) as { value: { ticket: string } };
    return body.value.ticket;
  };
  const csp = () => page.evaluate(() => (window as Win).__csp ?? []);
  const animations = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#graph path.line, #graph .pip")].map(
        (e) => getComputedStyle(e).animationName,
      ),
    );

  beforeAll(async () => {
    server = createApiServer({
      credentials: createCredentialStore({ humanToken: HUMAN }),
      getState: () => state,
      handlers: {},
    });
    url = (await server.listen(0)).url;
    browser = await (pw as Pw).chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        (window as Win).__csp = ((window as Win).__csp ?? []).concat(
          `${e.violatedDirective} ${e.blockedURI}`,
        );
      });
    });
    await page.goto(`${url}/ui#ticket=${await ticket()}`);
    await page.waitForSelector("#graph .gnode");
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("画面が graph.js を読み、#graph に図を描く。CSP の違反もエラーもない", async () => {
    expect(await page.locator("#graph .gnode").count()).toBe(5); // 4 つのノードと「人」の箱
    expect(await page.locator("#graph svg.glink path.line").count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.getElementById("list")?.hidden)).toBe(true);
    expect(await page.evaluate(() => document.getElementById("view-switch")?.hidden)).toBe(false);
    expect(await csp()).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("図と一覧を切り替えられる。一覧にすると図は片付き、図に戻すと描き直す", async () => {
    await page.click("#show-list");
    expect(await page.evaluate(() => document.getElementById("graph")?.hidden)).toBe(true);
    expect(await page.evaluate(() => document.getElementById("list")?.hidden)).toBe(false);
    expect(await page.locator("#graph .gnode").count()).toBe(0);
    expect(await page.locator("#show-list[aria-pressed=true]").count()).toBe(1);
    await page.click("#show-graph");
    await page.waitForSelector("#graph .gnode");
    expect(await page.locator("#graph .gnode").count()).toBe(5);
    expect(await page.locator("#show-graph[aria-pressed=true]").count()).toBe(1);
  });

  it("「動きを止める」で、図の線も玉も止まる。戻すと動く", async () => {
    expect((await animations()).some((a) => a !== "none")).toBe(true);
    await page.click("#still");
    expect(new Set(await animations())).toEqual(new Set(["none"]));
    await page.click("#still");
    expect((await animations()).some((a) => a !== "none")).toBe(true);
  });

  it("prefers-reduced-motion のとき、図の線も玉も動かない", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(new Set(await animations())).toEqual(new Set(["none"]));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await csp()).toEqual([]);
    expect(problems).toEqual([]);
  });

  it.runIf(process.env.TOURYOU_UI_SHOTS !== undefined)("画面写し（明・暗）", async () => {
    const dir = process.env.TOURYOU_UI_SHOTS as string;
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.screenshot({ path: `${dir}/ui-${scheme}.png`, fullPage: true });
    }
  });
});
