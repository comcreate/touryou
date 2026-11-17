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
    expect(await page.locator(".gnode").count()).toBe(7); // 7 つのノードだけ（「人」の箱は描かない）
    expect(await page.locator('.gnode[data-id="human"]').count()).toBe(0);
    // 列の見出し（いちばん上の統合・子・孫）は描かない
    expect(await page.locator("#g text.colhead").count()).toBe(0);
    expect(await page.locator("#g .gback text").count()).toBe(0);
    expect(await page.locator("svg.glink path.line").count()).toBe(7); // 根と人のやり取りは線にしない
    // 答え待ちの判断（子 c → 親 m1 の上り）だけ柿色
    expect(await page.locator("svg.glink path.line.wait").count()).toBe(1);
    expect(await page.locator("svg.glink path.line.wait.up").count()).toBe(1);
    expect(await page.locator("svg.glink path.tip").count()).toBe(7);
    // 人の答えは、親 m1 から子 c への下りの線の札で出す
    const labels = await page.locator("svg.glink text.mlabel.down").allTextContents();
    expect(labels.some((t) => t.startsWith("→ 答え"))).toBe(true);
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
    expect(r).toEqual({ twice: 7, holders: 1, after: 0, errors: [] });
    expect(problems).toEqual([]);
  });

  it("箱を押す・Enter・Space で onPick に ID が渡る。指を置くと、その子の線だけ浮かぶ。destroy のあとは何も起きない", async () => {
    const r = await page.evaluate(async () => {
      type G = {
        draw(h: HTMLElement, v: unknown, o?: { onPick?: (id: string) => void }): Promise<unknown>;
        destroy(): void;
      };
      const w = window as unknown as { touryouGraph: G; VIEW: unknown };
      const host = document.getElementById("g") as HTMLElement;
      const picked: string[] = [];
      await w.touryouGraph.draw(host, w.VIEW, { onPick: (id) => picked.push(id) });
      const a = host.querySelector('.gnode[data-id="a"]') as HTMLElement;
      a.click();
      a.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      a.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      a.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
      a.dispatchEvent(new PointerEvent("pointerenter"));
      const hot = host.classList.contains("hot");
      const lit = host.querySelectorAll(".lit").length;
      a.dispatchEvent(new PointerEvent("pointerleave"));
      const cooled = !host.classList.contains("hot") && host.querySelectorAll(".lit").length === 0;
      const tab = a.tabIndex;
      w.touryouGraph.destroy();
      a.click(); // 片付けたあとの古い箱：受け手は外れている
      a.dispatchEvent(new PointerEvent("pointerenter"));
      const after = { picked: picked.length, hot: host.classList.contains("hot") };
      await w.touryouGraph.draw(host, w.VIEW); // 後の試験のために描き直す
      return { picked, hot, lit, cooled, tab, after };
    });
    expect(r.picked).toEqual(["a", "a", "a"]);
    expect(r.hot).toBe(true);
    expect(r.lit).toBe(1); // a の下り（中間の統合からの指示）
    expect(r.cooled).toBe(true);
    expect(r.tab).toBe(0);
    expect(r.after).toEqual({ picked: 3, hot: false });
    expect(problems).toEqual([]);
  });
  /** 描き直しの途中と、そのあとの 12 枚（rAF ごと）で、浮かんでいない線の不透明度のいちばん大きいもの。 */
  const redrawFrames = () =>
    page.evaluate(async () => {
      type G = { draw(h: HTMLElement, v: unknown): Promise<unknown> };
      const w = window as unknown as { touryouGraph: G; VIEW: unknown };
      const host = document.getElementById("g") as HTMLElement;
      const dimmest = (): number =>
        Math.max(
          0,
          ...[...host.querySelectorAll<HTMLElement>(".glink")]
            .filter((g) => g.closest(".lit") === null && g.closest(".gback") === null)
            .map((g) => Number(getComputedStyle(g).opacity)),
        );
      const seen: number[] = [];
      let on = true;
      const tick = () => {
        if (!on) return;
        seen.push(dimmest());
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await w.touryouGraph.draw(host, w.VIEW);
      const right = dimmest(); // 描き直しが返った直後
      for (let i = 0; i < 12; i++) await new Promise((r) => requestAnimationFrame(r));
      on = false;
      return {
        right,
        worst: Math.max(...seen),
        hot: host.classList.contains("hot"),
        lit: host.querySelectorAll(".lit").length,
        active: (document.activeElement as HTMLElement | null)?.dataset?.id ?? null,
      };
    });

  it("指を置いたまま描き直しても、ほかの線は 1 枚も元の明るさに戻らない（#115 のあとの点滅）", async () => {
    const a = must(await page.locator('.gnode[data-id="c"]').boundingBox());
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.waitForTimeout(300); // 浮かびの transition が終わるまで待つ
    const r = await redrawFrames();
    expect(r.hot).toBe(true);
    expect(r.lit).toBe(2);
    expect(r.right).toBeLessThan(0.2);
    expect(r.worst).toBeLessThan(0.2);
    // 箱から指を外せば、浮かびは消える
    await page.mouse.move(2, 2);
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => document.getElementById("g")?.classList.contains("hot"))).toBe(
      false,
    );
    expect(problems).toEqual([]);
  });

  it("キーボードで focus したまま描き直しても、同じ箱に focus が戻り、ほかの線は薄いまま", async () => {
    await page.mouse.move(2, 2);
    await page.evaluate(() =>
      (document.querySelector('#g .gnode[data-id="c"]') as HTMLElement).focus(),
    );
    await page.waitForTimeout(300);
    const r = await redrawFrames();
    expect(r.active).toBe("c");
    expect(r.hot).toBe(true);
    expect(r.lit).toBe(2);
    expect(r.worst).toBeLessThan(0.2);
    // その箱がなくなる描き直しでは、浮かびを外す
    const gone = await page.evaluate(async () => {
      type G = { draw(h: HTMLElement, v: unknown): Promise<unknown> };
      const w = window as unknown as {
        touryouGraph: G;
        VIEW: { nodes: { id: string; parentId: string | null }[] };
      };
      const host = document.getElementById("g") as HTMLElement;
      const view = { ...w.VIEW, nodes: w.VIEW.nodes.filter((n) => n.id !== "c") };
      await w.touryouGraph.draw(host, view);
      const out = {
        hot: host.classList.contains("hot"),
        lit: host.querySelectorAll(".lit").length,
      };
      await w.touryouGraph.draw(host, w.VIEW); // 後の試験のために描き直す
      return out;
    });
    expect(gone).toEqual({ hot: false, lit: 0 });
    expect(problems).toEqual([]);
  });

  it("描いている途中に、ほかの入力の欄へ focus を移したら、描き終えても focus を奪わない", async () => {
    const r = await page.evaluate(async () => {
      type G = { draw(h: HTMLElement, v: unknown): Promise<unknown> };
      const w = window as unknown as { touryouGraph: G; VIEW: unknown };
      const host = document.getElementById("g") as HTMLElement;
      const input = document.createElement("input");
      document.body.append(input);
      (host.querySelector('.gnode[data-id="c"]') as HTMLElement).focus();
      const p = w.touryouGraph.draw(host, w.VIEW);
      input.focus(); // 描いている途中に、答えの欄などへ移る
      await p;
      const kept = document.activeElement === input;
      input.remove();
      await w.touryouGraph.draw(host, w.VIEW); // 後の試験のために描き直す
      return kept;
    });
    expect(r).toBe(true);
    expect(problems).toEqual([]);
  });

  it("描き直しで、人が変えた拡大・移動はそのまま残る", async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(500, 300);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(200);
    const holder = () =>
      page.evaluate(() => (document.querySelector("#g > div") as HTMLElement).style.transform);
    const before = await holder();
    await redrawFrames();
    expect(await holder()).toBe(before);
    // 片付けたあと（destroy）に描けば、枠に合わせ直す
    await page.evaluate(async () => {
      type G = { draw(h: HTMLElement, v: unknown): Promise<unknown>; destroy(): void };
      const w = window as unknown as { touryouGraph: G; VIEW: unknown };
      w.touryouGraph.destroy();
      await w.touryouGraph.draw(document.getElementById("g") as HTMLElement, w.VIEW);
    });
    expect(await holder()).not.toBe(before);
    expect(problems).toEqual([]);
  });
  it("draw が返す操作で、拡大・縮小・全体を見るが効く。上限・下限で止まり、描き直しで拡大が残り、全体を見るで初めの形に戻る", async () => {
    const r = await page.evaluate(async () => {
      type Ctl = { zoomBy(f: number): Promise<void>; fit(): Promise<void> };
      type G = { draw(h: HTMLElement, v: unknown): Promise<Ctl>; destroy(): void };
      const w = window as unknown as { touryouGraph: G; VIEW: unknown };
      const host = document.getElementById("g") as HTMLElement;
      const holder = () => host.firstElementChild as HTMLElement;
      const k = () => Number(/scale\(([\d.]+)\)/.exec(holder().style.transform)?.[1] ?? "NaN");
      w.touryouGraph.destroy();
      const c = await w.touryouGraph.draw(host, w.VIEW);
      const first = holder().style.transform;
      const k0 = k();
      await c.zoomBy(1.4);
      const kIn = k();
      await c.zoomBy(1 / 1.4);
      const kBack = k();
      for (let i = 0; i < 20; i++) await c.zoomBy(1.4);
      const kMax = k();
      for (let i = 0; i < 40; i++) await c.zoomBy(1 / 1.4);
      const kMin = k();
      await c.zoomBy(1.4);
      const kept = holder().style.transform;
      const c2 = await w.touryouGraph.draw(host, w.VIEW); // 描き直し
      const afterRedraw = holder().style.transform;
      await c2.fit();
      const fitted = holder().style.transform;
      return { k0, kIn, kBack, kMax, kMin, kept, afterRedraw, first, fitted };
    });
    expect(r.kIn).toBeCloseTo(r.k0 * 1.4, 5);
    expect(r.kBack).toBeCloseTo(r.k0, 5);
    expect(r.kMax).toBe(2);
    expect(r.kMin).toBe(0.25);
    expect(r.afterRedraw).toBe(r.kept); // ボタンで変えた拡大も、描き直しで残る
    expect(r.fitted).toBe(r.first); // 全体を見るで、初めの形に戻る
    expect(problems).toEqual([]);
  });

  it("ホイールの拡大も、同じ上限で止まる", async () => {
    await page.mouse.move(500, 300);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -400);
    await page.waitForTimeout(200);
    const k = await page.evaluate(() =>
      Number(
        /scale\(([\d.]+)\)/.exec(
          (document.querySelector("#g > div") as HTMLElement).style.transform,
        )?.[1],
      ),
    );
    expect(k).toBe(2);
    await page.evaluate(async () => {
      type G = { draw(h: HTMLElement, v: unknown): Promise<unknown>; destroy(): void };
      const w = window as unknown as { touryouGraph: G; VIEW: unknown };
      w.touryouGraph.destroy();
      await w.touryouGraph.draw(document.getElementById("g") as HTMLElement, w.VIEW);
    });
  });
});
