/**
 * 本物の `/ui` を、daemon の API サーバーから開く Playwright の試験（#89 の PR-5 の土台）。
 * いまの CSP（`UI_HEADERS`）のまま、`/ui/graph.js` を同じ origin から読み、`window.touryouGraph` で図を描けることを確かめる。
 * 画面（app.js）から図を呼ぶのは PR-4 のあと。それまでは、試験の中で `<script src>` を足して読む（CSP の `'self'` の内）。
 */
import { foldEvents, type OrchEvent, uiViewOf } from "@touryou/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";
import { type Browser, type Page, type Pw, pw, type Win } from "./playwright.js";

const HUMAN = "human-token-human-token-human-token-1234";
let n = 0;
const ev = (body: unknown): OrchEvent =>
  ({
    seq: ++n,
    at: "2026-10-20T00:00:00Z",
    requestId: `r${n}`,
    actor: { system: true },
    ...(body as object),
  }) as OrchEvent;
const created = (nodeId: string, role: string, parentId: string | null) => [
  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } }),
  ev({ type: "node.stateChanged", payload: { nodeId, event: { type: "start" } } }),
];

describe.skipIf(pw === null)("本物の /ui（Playwright。CSP の下で graph.js を読む）", () => {
  let server: ApiServer;
  let browser: Browser | undefined;
  let page: Page;
  let url = "";
  const problems: string[] = [];
  const state = (() => {
    const r = foldEvents([
      ...created("root", "integrator", null),
      ...created("a", "implement", "root"),
      ...created("b", "review", "root"),
    ]);
    if (!r.ok) throw new Error(r.error.cause);
    return r.value;
  })();

  beforeAll(async () => {
    server = createApiServer({
      credentials: createCredentialStore({ humanToken: HUMAN }),
      getState: () => state,
      handlers: {},
    });
    url = (await server.listen(0)).url;
    browser = await (pw as Pw).chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
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
    await page.goto(`${url}/ui`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("/ui を開いても、CSP の違反もエラーもない", async () => {
    await page.waitForSelector("body");
    expect(await page.evaluate(() => (window as Win).__csp ?? [])).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("/ui/graph.js を同じ origin から読める。外に出すのは window.touryouGraph（draw・destroy）だけ", async () => {
    await page.addScriptTag({ url: "/ui/graph.js" });
    expect(
      await page.evaluate(() =>
        Object.keys((window as unknown as { touryouGraph: object }).touryouGraph).sort(),
      ),
    ).toEqual(["destroy", "draw"]);
    expect(await page.evaluate(() => (window as Win).__csp ?? [])).toEqual([]);
  });

  it("表示モデル（uiViewOf）を渡すと描け、destroy で消える。CSP の違反はない", async () => {
    const view = JSON.parse(JSON.stringify(uiViewOf(state)));
    const count = await page.evaluate(async (v: unknown) => {
      const g = (
        window as unknown as {
          touryouGraph: { draw(h: HTMLElement, v: unknown): Promise<void>; destroy(): void };
        }
      ).touryouGraph;
      const host = document.createElement("div");
      host.id = "graph-test";
      document.body.append(host);
      await g.draw(host, v);
      const drawn = host.querySelectorAll(".gnode").length;
      g.destroy();
      return [drawn, host.querySelectorAll(".gnode").length];
    }, view);
    expect(count).toEqual([3, 0]);
    expect(await page.evaluate(() => (window as Win).__csp ?? [])).toEqual([]);
    expect(problems).toEqual([]);
  });
});
