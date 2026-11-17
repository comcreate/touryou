/**
 * 本物の `/ui` を、daemon の API サーバーから開く Playwright の試験（#89 の PR-5）。
 * いまの CSP（`UI_HEADERS`）のまま、画面が `/ui/graph.js` を読み、`#graph` に関係図を描くこと、
 * 図と一覧を切り替えられること、「動きを止める」と OS の `prefers-reduced-motion` で図の動きが止まることを確かめる。
 * 画面写し（`docs/images/ui-light.png`・`ui-dark.png`）は、`TOURYOU_UI_SHOTS=<ディレクトリ>` のときだけ撮る（値は作り物）。
 */
import { foldEvents, type OrchEvent, stallSummary } from "@touryou/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";
import { type Browser, type Page, type Pw, pw, type Win } from "./playwright.js";

const HUMAN = "human-token-human-token-human-token-1234";
const LONG = "investigate-graph-fidelity-check-with-a-long-node-id-0001";
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
      // 長い進み具合の報告（カードのやり取りでは、たたむ）
      ev({
        type: "report.added",
        payload: {
          reportId: "rp1",
          nodeId: "ui-a",
          kind: "progress",
          text: "関係図の箱を見本の形にそろえ、線の色と玉の動きを確かめているところです",
        },
      }),
      // 人からの指示（人の箱は描かない。親 root から子への下りの線で表す）
      ev({ type: "node.instructed", payload: { nodeId: "ui-c", text: "x" } }),
      // 人から子への、範囲の頼みの却下（札は「指示」でなく「却下」。#115）と、範囲の頼みの知らせ（内部の言葉を言い換える）
      ev({
        type: "node.instructed",
        payload: {
          nodeId: "ui-c",
          text: "範囲の拡張の要求（コマンド ls）は却下された。範囲の内側で進める",
          kind: "extensionRejected",
        },
      }),
      // 子が書いた進み具合（ID らしい語があっても、題に置き換えない）
      ev({
        type: "inbox.added",
        payload: { id: "p1", kind: "progress", nodeId: "ui-c", summary: "ui-b の結果を待っている" },
      }),
      ev({
        type: "inbox.added",
        payload: {
          id: "x1",
          kind: "info",
          nodeId: "ui-c",
          summary: "範囲の拡張要求（command）: pnpm lint",
        },
      }),
      // 止まっているかもの子（長い ID。狭い窓で、はみ出さないことも見る）と、済んだ子
      ...created(LONG, "investigate", "root", "関係図の見た目を見本と比べる"),
      ev({
        type: "inbox.added",
        payload: { id: "st1", kind: "info", nodeId: LONG, summary: stallSummary(LONG, 12) },
      }),
      // 閉じた判断だけが残る子（止めて破棄を決めた。閉じた判断は答え待ちに数えない。カードと図で同じ札になる）
      ...created("ui-d", "implement", "root", "閉じた判断だけが残る子"),
      ev({
        type: "decision.requested",
        payload: { decisionId: "d9", nodeId: "ui-d", question: "閉じる問い" },
      }),
      ev({
        type: "node.stateChanged",
        payload: { nodeId: "ui-d", event: { type: "stop", mode: "immediate" } },
      }),
      ev({
        type: "node.stateChanged",
        payload: { nodeId: "ui-d", event: { type: "confirmStopped" } },
      }),
      ev({ type: "node.discardDecided", payload: { nodeId: "ui-d", noTip: true } }),
      ...created("ui-old", "implement", "root", "前の画面を片付ける"),
      ev({
        type: "node.stateChanged",
        payload: { nodeId: "ui-old", event: { type: "reportDone" } },
      }),
      ev({ type: "node.stateChanged", payload: { nodeId: "ui-old", event: { type: "accept" } } }),
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
    expect(await page.locator("#graph .gnode").count()).toBe(7); // 7 つのノードだけ（「人」の箱は描かない）
    expect(await page.locator('#graph .gnode[data-id="human"]').count()).toBe(0);
    expect(await page.locator("#graph svg.glink path.line").count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.getElementById("list")?.hidden)).toBe(true);
    expect(await page.evaluate(() => document.getElementById("view-switch")?.hidden)).toBe(false);
    expect(await csp()).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("知らせの文は、長いノード ID でなく子の題。内部の言葉（墓標・範囲の拡張要求（command））を出さない（#115）", async () => {
    const body = (await page.evaluate(() => document.body.textContent)) ?? "";
    const entries = await page.evaluate(() =>
      [...document.querySelectorAll(".entry")].map((e) => e.textContent ?? ""),
    );
    const stall = entries.find((t) => t.includes("止まっているかもしれない")) ?? "";
    expect(stall).toContain("「関係図の見た目を見本と比べる」");
    expect(stall).not.toContain(LONG);
    expect(entries.some((t) => t.includes("コマンドを足す頼み: pnpm lint"))).toBe(true);
    // 子が書いた文は、そのまま（ほかのノードの題に置き換えない）
    expect(entries.some((t) => t.includes("ui-b の結果を待っている"))).toBe(true);
    expect(body).not.toContain("墓標");
    expect(body).not.toContain("範囲の拡張要求");
  });

  it("人から子への範囲の頼みの却下の線の札は「却下」（「指示」でない）。親から子への下りの線に出る", async () => {
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll("#graph text.mlabel.down")].map((e) => e.textContent ?? ""),
    );
    expect(labels.some((t) => t.startsWith("→ 却下"))).toBe(true);
  });

  it("一覧の「詳しく」は、狭い窓でも 1 行（折れない）", async () => {
    await page.click("#show-list");
    for (const width of [1280, 900, 700, 420]) {
      await page.setViewportSize({ width, height: 900 });
      const heights = await page.evaluate(() =>
        [...document.querySelectorAll("#list .tname button")].map((b) => {
          const r = b.getBoundingClientRect();
          const line = Number.parseFloat(getComputedStyle(b).lineHeight) || 20;
          return r.height / line;
        }),
      );
      expect(heights.length).toBeGreaterThan(0);
      for (const h of heights) expect(h, `幅 ${width}`).toBeLessThan(1.9);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click("#show-graph");
    await page.waitForSelector("#graph .gnode");
  });

  it("作業ごとのようすのカードは見本の形：札は状態 1 つと答えの数、題は h3、棒は 12 区切り、やり取りは 3 件まで、知らせ・ID はたたむ", async () => {
    const shape = await page.evaluate(() =>
      [...document.querySelectorAll("#cards .card, #finished-cards .card")].map((c) => ({
        id: c.id,
        chips: [...(c.children[0]?.querySelectorAll(".chip") ?? [])].map(
          (x) => x.textContent ?? "",
        ),
        need: c.classList.contains("need"),
        h3: c.querySelector(":scope > h3")?.textContent ?? "",
        slots: c.querySelectorAll(":scope > .spark > .slot").length,
        flows: c.querySelectorAll(":scope > .flowlist > .fl").length,
        // カードの表（たたみの外）に、ID の行・受信箱の項目がない
        idOutside: [...c.children].some((x) => x.classList.contains("idline")),
        entryOutside: [...c.children].some((x) => x.classList.contains("entry")),
        folds: [...c.querySelectorAll(":scope > details > summary")].map(
          (x) => x.textContent ?? "",
        ),
        attach: c.querySelector(":scope > .cmd code")?.textContent ?? "",
      })),
    );
    expect(shape.length).toBeGreaterThan(0);
    for (const c of shape) {
      expect(c.chips.length, c.id).toBeLessThanOrEqual(2);
      expect(
        c.chips.some((t) => t === "あなたの出番" || t === "進んでいる"),
        c.id,
      ).toBe(false);
      expect(c.h3, c.id).not.toBe("");
      expect(c.slots, c.id).toBe(12);
      expect(c.flows, c.id).toBeLessThanOrEqual(3);
      expect(c.idOutside, c.id).toBe(false);
      expect(c.entryOutside, c.id).toBe(false);
      expect(
        c.folds.some((t) => t === "この子への操作" || t === "この子の ID"),
        c.id,
      ).toBe(true);
    }
    const b = shape.find((c) => c.id === "card-ui-b");
    expect(b?.chips).toEqual(["● あなたの答え待ち", "あなたの答え 1 件"]);
    expect(b?.need).toBe(true);
    const stall = shape.find((c) => c.id === `card-${LONG}`);
    expect(stall?.chips[0]).toBe("‖ 止まっているかも");
    expect(stall?.attach).toBe(`claude attach ${LONG}`);
    expect(stall?.folds.some((t) => /^知らせ \d+ 件（たたんでいます）$/.test(t))).toBe(true);
    // いちばん上の統合にも「最後の動き」。人とのやり取りの相手は「あなた」
    const meta = await page.evaluate(
      () => document.querySelector("#card-root .meta")?.textContent ?? "",
    );
    expect(meta).toContain("最後の動き");
    const flowsC = await page.evaluate(() =>
      [...document.querySelectorAll("#card-ui-c .flowlist .fl")].map((x) => x.textContent ?? ""),
    );
    expect(flowsC.some((t) => t.includes("← あなた　却下"))).toBe(true);
    expect(flowsC.some((t) => t.includes("人　"))).toBe(false);
    const old = shape.find((c) => c.id === "card-ui-old");
    expect(old?.chips[0]).toBe("済んだ");
  });

  it("同じ表示モデルから、カードの状態の札と、図の箱の状態の言葉が、子ごとに同じ（閉じた判断だけが残る子も）", async () => {
    const pairs = await page.evaluate(() =>
      [...document.querySelectorAll("#cards .card, #finished-cards .card")].map((c) => {
        const id = c.id.replace(/^card-/, "");
        const box = document.querySelector(`#graph .gnode[data-id="${CSS.escape(id)}"] .gst`);
        return {
          id,
          card: c.children[0]?.querySelector(".chip")?.textContent ?? "",
          graph: box?.textContent ?? null,
        };
      }),
    );
    expect(pairs.some((p) => p.id === "ui-d")).toBe(true);
    for (const p of pairs) {
      expect(p.graph, p.id).not.toBeNull();
      // 図の箱は、止まっているかもの子に「　N 分」を足す。頭の言葉が同じこと
      expect(
        (p.graph ?? "").startsWith(p.card),
        `${p.id}: カード「${p.card}」図「${p.graph}」`,
      ).toBe(true);
    }
    expect(pairs.find((p) => p.id === "ui-d")?.card).not.toBe("● あなたの答え待ち");
  });

  it("カードの meta は 1 行、親の題は 12 字、やり取りの相手の題は 10 字で切る。短い文は 1 行、長い文はたたむ", async () => {
    const c = await page.evaluate(() => {
      const card = (id: string) => document.getElementById(`card-${id}`);
      const meta = card("ui-b")?.querySelector(".meta") as HTMLElement | null;
      const spans = [...(meta?.children ?? [])] as HTMLElement[];
      const a = card("ui-a");
      return {
        metaText: meta?.textContent ?? "",
        // 見本の .meta と同じく、flex で並べ、足りなければ折り返す。それぞれの欄は、中で折れない（1 行の高さ）
        oneLine:
          spans.length === 2 &&
          spans.every(
            (x) =>
              x.getBoundingClientRect().height <
              1.5 * (Number.parseFloat(getComputedStyle(x).lineHeight) || 18),
          ),
        bLines: [...(card("ui-b")?.querySelectorAll(".flowlist .fl") ?? [])].map(
          (x) => x.textContent ?? "",
        ),
        aFolded: [...(a?.querySelectorAll(".flowlist details.fbody > summary") ?? [])].map(
          (x) => x.textContent ?? "",
        ),
        aBody: a?.querySelector(".flowlist details.fbody > p")?.textContent ?? "",
      };
    });
    expect(c.metaText).toContain("（親：状態画面の作り直しをまと…）");
    expect(c.oneLine).toBe(true);
    expect(
      c.bLines.some((t) => t.includes("→ 状態画面の作り直しを…　判断を求む：どちらにしますか")),
    ).toBe(true);
    expect(c.aFolded.some((t) => t.startsWith("→ 状態画面の作り直しを…　報告"))).toBe(true);
    expect(c.aBody).toContain("関係図の箱を見本の形にそろえ");
  });

  it("箱は見本の形：状態の言葉と印・左の縁の段・役割の印・列の見出し。止まっているかもは、くすんだ黄（カードも）", async () => {
    const box = (id: string) => page.locator(`#graph .gnode[data-id="${id}"]`);
    expect(await box("root").getAttribute("class")).toContain("t-go");
    expect(await box("root").locator(".gst").textContent()).toBe("動いている");
    expect(await box("ui-b").getAttribute("class")).toContain("s-wait");
    expect(await box("ui-b").locator(".gst").textContent()).toBe("● あなたの答え待ち");
    expect(await box("ui-b").locator(".gbadge").textContent()).toBe("1");
    expect(await box(LONG).getAttribute("class")).toContain("s-stall");
    expect(await box(LONG).locator(".gst").textContent()).toBe("‖ 止まっているかも");
    expect(await box("ui-old").getAttribute("class")).toContain("t-over");
    expect(await box("ui-a").locator(".galive").count()).toBe(1);
    expect(await box("ui-a").locator(".gs").textContent()).toMatch(/^作業　\d+ 分前$/);
    const colors = await page.evaluate((id: string) => {
      const c = (sel: string) => getComputedStyle(document.querySelector(sel) as Element);
      return {
        stall: c(`#graph .gnode[data-id="${id}"]`).borderTopColor,
        wait: c('#graph .gnode[data-id="ui-b"]').borderTopColor,
        card: c(`#card-${id}`).borderLeftColor,
      };
    }, LONG);
    expect(colors.stall).not.toBe(colors.wait);
    expect(colors.card).toBe(colors.stall);
    // 列の見出し（いちばん上の統合・子・孫）は出さない（利用者の決め）
    expect(await page.locator("#graph text.colhead").count()).toBe(0);
    const heads = await page.locator("#graph text").allTextContents();
    for (const t of ["いちばん上の統合", "子", "孫"]) expect(heads).not.toContain(t);
    expect(await page.locator("#graph text.mstage").count()).toBeGreaterThan(0);
  });

  it("箱を押すと、その子のカードへ移って光る（一覧の「詳しく」と同じ）。凡例は図のときだけ出る", async () => {
    expect(await page.evaluate(() => document.getElementById("graph-legend")?.hidden)).toBe(false);
    await page.click('#graph .gnode[data-id="ui-c"]');
    await page.waitForSelector("#card-ui-c.flash"); // 光らせるのは次の番（setTimeout 0）
    await page.click("#show-list");
    expect(await page.evaluate(() => document.getElementById("graph-legend")?.hidden)).toBe(true);
    await page.click("#show-graph");
    await page.waitForSelector("#graph .gnode");
  });

  it("図と一覧を切り替えられる。一覧にすると図は片付き、図に戻すと描き直す", async () => {
    await page.click("#show-list");
    expect(await page.evaluate(() => document.getElementById("graph")?.hidden)).toBe(true);
    expect(await page.evaluate(() => document.getElementById("list")?.hidden)).toBe(false);
    expect(await page.locator("#graph .gnode").count()).toBe(0);
    expect(await page.locator("#show-list[aria-pressed=true]").count()).toBe(1);
    await page.click("#show-graph");
    await page.waitForSelector("#graph .gnode");
    expect(await page.locator("#graph .gnode").count()).toBe(7);
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
    await page.mouse.move(1, 1); // 箱の上に指を残さない（線が薄くならないように）
    await page.evaluate(() => window.scrollTo(0, 0));
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.screenshot({ path: `${dir}/ui-${scheme}.png`, fullPage: true });
    }
  });

  it("狭い窓でも、横にはみ出さない。いちばん上の帯の「動きを止める」が切れない", async () => {
    for (const width of [1280, 900, 600, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const r = await page.evaluate(() => {
        const b = (document.getElementById("still") as HTMLElement).getBoundingClientRect();
        return {
          over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          right: b.right,
          vw: document.documentElement.clientWidth,
        };
      });
      expect(r.over, `幅 ${width}`).toBeLessThanOrEqual(0);
      expect(r.right, `幅 ${width}`).toBeLessThanOrEqual(r.vw);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});
