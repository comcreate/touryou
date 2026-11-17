/**
 * CSP を付けたページで、束ねた graph.js が動くこと（#89 の試作。R0 の確かめ）。
 * Playwright は依存に加えない（環境にあるものを使う。`TOURYOU_PLAYWRIGHT` でパスを指定でき、なければ `playwright` を探す）。
 * 見つからないときは飛ばす（CI には Playwright がない）。
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleGraph } from "../../../../scripts/ui-graph-bundle.mjs";
import { UI_CSS, UI_HEADERS } from "../../src/api/ui-assets.js";
import { type Browser, must, type Page, type Pw, pw, type Win } from "./playwright.js";

const HTML =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>graph</title>' +
  '<link rel="stylesheet" href="/graph.css"></head><body><div id="g" class="board"></div>' +
  '<script src="/graph.js"></script><script src="/boot.js"></script></body></html>';

describe.skipIf(pw === null)("CSP の下で graph.js が動く（Playwright）", () => {
  let server: Server;
  let base = "";
  let browser: Browser | undefined;
  let page: Page;
  const problems: string[] = [];

  beforeAll(async () => {
    const files: Record<string, [string, string]> = {
      "/": [HTML, "text/html; charset=utf-8"],
      "/graph.js": [await bundleGraph(), "text/javascript; charset=utf-8"],
      "/boot.js": [
        readFileSync(new URL("boot.js", import.meta.url), "utf8"),
        "text/javascript; charset=utf-8",
      ],
      // 見た目は本物の画面の CSS（app.css）に、試験の枠の大きさだけを足す
      "/graph.css": [
        `${UI_CSS}\n${readFileSync(new URL("fixture.css", import.meta.url), "utf8")}`,
        "text/css; charset=utf-8",
      ],
    };
    server = createServer((req, res) => {
      const f = files[req.url ?? ""];
      if (f === undefined) {
        res.writeHead(404).end();
        return;
      }
      // いまの画面と同じ守りのヘッダー（CSP は変えない）
      res.writeHead(200, { ...UI_HEADERS, "content-type": f[1] }).end(f[0]);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await (pw as Pw).chromium.launch();
    page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        (window as Win).__csp = ((window as Win).__csp ?? []).concat(
          `${e.violatedDirective} ${e.blockedURI}`,
        );
      });
    });
    await page.goto(`${base}/`);
    await page.waitForSelector("body[data-ready]");
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
  });

  it("CSP のヘッダーが付いていて、違反もエラーもない", async () => {
    const res = await page.request.get(`${base}/`);
    expect(res.headers()["content-security-policy"]).toContain("style-src 'self'");
    expect(await page.evaluate(() => document.body.dataset.ready)).toBe("1");
    expect(await page.evaluate(() => (window as Win).__csp ?? [])).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("箱と線が描かれる。文字は textContent（差し込まれた HTML は要素にならない）", async () => {
    expect(await page.locator(".gnode").count()).toBe(8); // 7 つのノードと「人」の箱
    expect(await page.locator("svg.glink path.line").count()).toBe(9);
    expect(await page.locator("svg.glink path.line.human").count()).toBe(3);
    expect(await page.locator("svg.glink path.line.wait").count()).toBe(1); // 答え待ちの判断だけ
    expect(await page.locator("svg.glink path.tip").count()).toBe(9);
    expect(await page.locator("svg.glink path.twig").count()).toBe(1); // やり取りのない子 e
    expect(await page.locator("#g img, #g script, #g style, #g foreignObject").count()).toBe(0);
    expect(await page.locator('.gnode[data-id="a"] .gt').textContent()).toContain("<img src=x");
    expect(await page.evaluate(() => document.querySelectorAll("style").length)).toBe(0);
    const box = await page.locator('.gnode[data-id="root"]').boundingBox();
    expect(box?.width).toBeGreaterThan(50);
  });

  it("段で流れ方が変わる。sent だけに玉が走り、offset-path が効いている。終わった子の線は止まる", async () => {
    const anim = (sel: string) =>
      page.evaluate(
        (s: string) => getComputedStyle(document.querySelector(s) as Element).animationName,
        sel,
      );
    expect(await anim("path.line.g-sent")).toBe("gflow");
    expect(await anim("path.line.g-unknown")).toBe("gflow");
    expect(await anim("path.line.g-delivered")).toBe("gflow");
    expect(await anim("path.line.g-done")).toBe("none");
    // sent は root → m1 の 1 本だけ（unknown は届いたか分からないので玉を走らせない）
    expect(await page.locator(".pip").count()).toBe(1);
    const op = await page.evaluate(
      () => getComputedStyle(document.querySelector(".pip") as Element).offsetPath,
    );
    expect(op).toMatch(/^path\("M /);
  });

  it("読み取り専用：箱は引っぱっても動かない。拡大（ホイール）は効く", async () => {
    const node = page.locator('.gnode[data-id="d"]');
    const root = page.locator('.gnode[data-id="root"]');
    const before = must(await node.boundingBox());
    const rootBefore = must(await root.boundingBox());
    await page.mouse.move(before.x + 20, before.y + 20);
    await page.mouse.down();
    await page.mouse.move(before.x + 220, before.y + 160, { steps: 8 });
    await page.mouse.up();
    const after = must(await node.boundingBox());
    const rootAfter = must(await root.boundingBox());
    // 箱を掴んで引いても、箱どうしの位置の関係は変わらない（引いた分は、背景の移動になるだけ）
    expect(Math.round(after.x - rootAfter.x)).toBe(Math.round(before.x - rootBefore.x));
    expect(Math.round(after.y - rootAfter.y)).toBe(Math.round(before.y - rootBefore.y));
    if (process.env.TOURYOU_GRAPH_SHOT)
      await page.screenshot({ path: process.env.TOURYOU_GRAPH_SHOT });
    const holder = await page.evaluate(
      () => (document.querySelector("#g > div") as HTMLElement).style.transform,
    );
    await page.mouse.move(500, 300);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(200);
    const holder2 = await page.evaluate(
      () => (document.querySelector("#g > div") as HTMLElement).style.transform,
    );
    expect(holder2).not.toBe(holder);
    expect(problems).toEqual([]);
  });

  it("prefers-reduced-motion のとき、線も玉も動かない", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const names = await page.evaluate(() =>
      [...document.querySelectorAll("#g path.line, #g .pip")].map(
        (e) => getComputedStyle(e).animationName,
      ),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set(["none"]));
    await page.emulateMedia({ reducedMotion: "no-preference" });
  });

  it("draw を続けて呼んでも、図は 1 つだけ（前の描きの続きは黙って抜ける）。draw の直後の destroy で、何も残らない", async () => {
    const r = await page.evaluate(async () => {
      type G = { draw(h: HTMLElement, v: unknown): Promise<void>; destroy(): void };
      const w = window as unknown as { touryouGraph: G; VIEW: unknown };
      const host = document.getElementById("g") as HTMLElement;
      const errors: string[] = [];
      const p1 = w.touryouGraph.draw(host, w.VIEW).catch((e) => errors.push(String(e)));
      const p2 = w.touryouGraph.draw(host, w.VIEW).catch((e) => errors.push(String(e)));
      await Promise.all([p1, p2]);
      const twice = host.querySelectorAll(".gnode").length;
      const holders = host.children.length;
      const p3 = w.touryouGraph.draw(host, w.VIEW).catch((e) => errors.push(String(e)));
      w.touryouGraph.destroy();
      await p3;
      const after = host.querySelectorAll(".gnode, svg").length;
      await w.touryouGraph.draw(host, w.VIEW); // 後の試験のために描き直す
      return { twice, holders, after, errors };
    });
    expect(r).toEqual({ twice: 8, holders: 1, after: 0, errors: [] });
    expect(problems).toEqual([]);
  });
});
