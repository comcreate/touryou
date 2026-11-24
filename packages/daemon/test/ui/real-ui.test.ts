/**
 * 本物の `/ui` を、daemon の API サーバーから開く Playwright の試験（#89 の PR-5）。
 * いまの CSP（`UI_HEADERS`）のまま、画面が `/ui/graph.js` を読み、`#graph` に関係図を描くこと、
 * 図と一覧を切り替えられること、「動きを止める」と OS の `prefers-reduced-motion` で図の動きが止まることを確かめる。
 * 画面写し（`docs/images/ui-light.png`・`ui-dark.png`）は、`TOURYOU_UI_SHOTS=<ディレクトリ>` のときだけ撮る（値は作り物）。
 */
import { foldEvents, inboxMessage, type OrchEvent, stallSummary } from "@touryou/core";
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
  // いまの状態（試験の途中で lastSeq を進めて、描き直させる）
  let current: typeof state;
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
      // daemon が書いた知らせ（msg つき。#140）。英語の画面では、英語の文になる
      ev({
        type: "inbox.added",
        payload: {
          id: "u1",
          kind: "info",
          nodeId: "ui-c",
          ...inboxMessage("unreadInstruction", { node: "ui-c", seq: 3, minutes: 10 }),
        },
      }),
      // 止まっているかもの子（長い ID。狭い窓で、はみ出さないことも見る）と、済んだ子
      ...created(LONG, "investigate", "root", "関係図の見た目を見本と比べる"),
      // CLI の子（親が起動を報告した。#136: attach のコマンドは CLI の子にだけ出す）
      ev({
        type: "node.parentRequested",
        payload: { nodeId: LONG, requestRef: "pr-long", kind: "launch", worktree: "/w/long" },
      }),
      ev({
        type: "node.parentReported",
        payload: { nodeId: LONG, requestRef: "pr-long", outcome: "done" },
      }),
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
      // 答え待ちの子の失敗の知らせ（札は答え待ちを先に出す）と、動いている子の断られた操作（失敗にしない）。#131
      ev({
        type: "inbox.added",
        payload: { id: "f1", kind: "failure", nodeId: "ui-b", summary: "試験が落ちた" },
      }),
      ev({
        type: "inbox.added",
        payload: { id: "v1", kind: "violation", nodeId: "ui-a", summary: "範囲の外のコマンド" },
      }),
    ]);
    if (!r.ok) throw new Error(r.error.cause);
    return r.value;
  })();
  current = state;
  const ticket = async (): Promise<string> => {
    const res = await fetch(`${url}/v1/ui/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUMAN}` },
    });
    const body = (await res.json()) as { value: { ticket: string } };
    return body.value.ticket;
  };
  // 開き直す（再読み込みの代わり。チケットは 1 回きりなので、新しいチケットで開く。ブラウザに残したものは続く）
  const reopen = async (): Promise<void> => {
    await page.goto("about:blank");
    await page.goto(`${url}/ui#ticket=${await ticket()}`);
    await page.waitForSelector("#graph .gnode");
  };
  const csp = () => page.evaluate(() => (window as Win).__csp ?? []);
  const animations = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#graph path.line, #graph .msp .sk")].map(
        (e) => getComputedStyle(e).animationName,
      ),
    );

  beforeAll(async () => {
    server = createApiServer({
      credentials: createCredentialStore({ humanToken: HUMAN }),
      getState: () => current,
      handlers: {},
      repoName: "sample-repo",
    });
    url = (await server.listen(0)).url;
    browser = await (pw as Pw).chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "ja-JP" });
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    // 既定は、止めた・済んだ子を隠す（#274）。ほかの試験は、7 つの箱が出る前提なので、残してあるものがないときだけ「表示する」を入れておく
    // （既定そのものは、新しい文脈で確かめる試験がある。残してあるものは上書きしないので、再読み込みの試験もそのまま通る）
    await page.addInitScript(() => {
      try {
        if (window.localStorage.getItem("touryou.ui.settings") === null)
          window.localStorage.setItem(
            "touryou.ui.settings",
            JSON.stringify({ showFinished: true }),
          );
      } catch {
        /* 残せなければ、既定のまま */
      }
    });
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
    expect(labels.some((t) => t.startsWith("↓ 却下"))).toBe(true);
  });

  it("一覧の「詳しく」は、狭い窓でも 1 行（折れない）", async () => {
    await page.click("#show-list");
    for (const width of [1280, 900, 700, 420]) {
      await page.setViewportSize({ width, height: 900 });
      const heights = await page.evaluate(() =>
        [...document.querySelectorAll("#list .tname button")].map((b) => {
          // スマホ幅では、押す所を 44px にそろえるため、ボタンの箱は 1 行より高い。折れたかは、中の文字の高さで見る
          const range = document.createRange();
          range.selectNodeContents(b);
          const line = Number.parseFloat(getComputedStyle(b).lineHeight) || 20;
          return range.getBoundingClientRect().height / line;
        }),
      );
      expect(heights.length).toBeGreaterThan(0);
      for (const h of heights) expect(h, `幅 ${width}`).toBeLessThan(1.9);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click("#show-graph");
    await page.waitForSelector("#graph .gnode");
  });

  it("幅の区切り（#254 の段階 2）: 1280px 以上は 3 つの窓が横に並び、900〜1279px は左＋右の上下、899px 以下は下のタブで切り替える", async () => {
    const boxes = () =>
      page.evaluate(() =>
        ["left", "graph", "right"].map((p) => {
          const r = document.querySelector(`#view .win[data-p="${p}"]`)?.getBoundingClientRect();
          return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } : null;
        }),
      );
    const navShown = () =>
      page.evaluate(
        () => getComputedStyle(document.querySelector("#view .nav") as Element).display !== "none",
      );
    // 3 列: 窓は同じ高さから始まり、左 → 中 → 右の順に並ぶ
    const [l, g, r] = await boxes();
    expect(l && g && r).toBeTruthy();
    expect(g?.y).toBe(l?.y);
    expect(r?.y).toBe(l?.y);
    expect((l?.x ?? 0) < (g?.x ?? 0) && (g?.x ?? 0) < (r?.x ?? 0)).toBe(true);
    expect(await navShown()).toBe(false);
    // 画面全体はスクロールしない（窓の中だけ）
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1),
    ).toBe(true);
    // 2 列: 図と作業は同じ列で、図が上
    await page.setViewportSize({ width: 1000, height: 900 });
    const [l2, g2, r2] = await boxes();
    expect(g2?.x).toBe(r2?.x);
    expect((g2?.y ?? 0) < (r2?.y ?? 0)).toBe(true);
    expect((l2?.x ?? 0) < (g2?.x ?? 0)).toBe(true);
    // 1 列: 下のタブで「出番」と「図と作業」を切り替える。選んだタブに aria-current="page"
    await page.setViewportSize({ width: 420, height: 900 });
    expect(await navShown()).toBe(true);
    const shown = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#view .win")]
          .filter((w) => getComputedStyle(w).display !== "none")
          .map((w) => (w as HTMLElement).dataset.p),
      );
    expect(await shown()).toEqual(["left"]);
    expect(
      await page.evaluate(() => document.querySelector("#nav-yours")?.getAttribute("aria-current")),
    ).toBe("page");
    await page.click("#nav-explore");
    expect(await shown()).toEqual(["graph", "right"]);
    expect(
      await page.evaluate(() =>
        document.querySelector("#nav-explore")?.getAttribute("aria-current"),
      ),
    ).toBe("page");
    expect(
      await page.evaluate(() => document.querySelector("#nav-yours")?.getAttribute("aria-current")),
    ).toBe("false");
    // キーボードでも切り替えられる（ボタンなので Enter で押せる）
    await page.focus("#nav-yours");
    await page.keyboard.press("Enter");
    expect(await shown()).toEqual(["left"]);
    // 下のタブの名前と、出番の件数の札
    expect(
      await page.evaluate(() => document.querySelector("#view .nav")?.getAttribute("aria-label")),
    ).toBe("表示の切り替え");
    const countOf = (sel: string) =>
      page.evaluate((q) => document.querySelector(q)?.textContent ?? "", sel);
    expect(await countOf("#nav-count")).toBe(await countOf("#now-count"));
    // 下のタブの下にも余白があり、最後の窓がタブに隠れない
    expect(
      await page.evaluate(() =>
        parseFloat(getComputedStyle(document.querySelector("main") as Element).paddingBottom),
      ),
    ).toBeGreaterThanOrEqual(56);
    // 899px と 900px の境: 899px は下のタブ、900px は 2 列でタブなし
    await page.setViewportSize({ width: 899, height: 900 });
    expect(await navShown()).toBe(true);
    await page.setViewportSize({ width: 900, height: 900 });
    expect(await navShown()).toBe(false);
    const [l3, g3] = await boxes();
    expect((l3?.x ?? 0) < (g3?.x ?? 0)).toBe(true);
    // 高さの低い横長の画面: 窓は最小の高さを保ち、main がスクロールする
    await page.setViewportSize({ width: 1280, height: 400 });
    expect(
      await page.evaluate(
        () => (document.querySelector("#view") as HTMLElement).getBoundingClientRect().height,
      ),
    ).toBeGreaterThanOrEqual(359);
    await page.setViewportSize({ width: 1280, height: 900 });
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
    // 答え待ちは失敗より先。断られた操作の知らせだけでは失敗にしない（#131）
    expect(pairs.find((p) => p.id === "ui-b")?.card).toBe("● あなたの答え待ち");
    expect(pairs.find((p) => p.id === "ui-a")?.card).toBe("動いている");
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

  it("「写す」はクリップボードのアイコン。名前（aria-label・title）が付き、押すと済みの形になって読み上げにも伝え、数秒で戻る", async () => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
    const named = await page.evaluate(() =>
      [...document.querySelectorAll("button.copy")].map((b) => ({
        label: b.getAttribute("aria-label"),
        title: b.getAttribute("title"),
        text: b.textContent ?? "",
        icon: b.querySelector(".copy-ico") !== null,
        h: b.getBoundingClientRect().height,
      })),
    );
    expect(named.length).toBeGreaterThan(0);
    for (const b of named) {
      expect(b).toMatchObject({ label: "写す", title: "写す", text: "", icon: true });
      expect(b.h).toBeGreaterThanOrEqual(34);
    }
    await page.click(`#card-${LONG} .cmd button.copy`);
    await page.waitForFunction(() => document.querySelector(".cmd button.copy.done") !== null);
    const after = await page.evaluate(() => ({
      label: document.querySelector(".cmd button.copy.done")?.getAttribute("aria-label"),
      live: document.getElementById("live")?.textContent,
    }));
    expect(after).toEqual({ label: "写しました", live: "写しました" });
    await page.waitForFunction(
      () => document.querySelector(".cmd button.copy.done") === null,
      undefined,
      { timeout: 6000 },
    );
    expect(
      await page.evaluate(() =>
        document.querySelector(".cmd button.copy")?.getAttribute("aria-label"),
      ),
    ).toBe("写す");
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
    await page.waitForSelector("#card-ui-c.picked");
    // 移った先のカードに focus も移る
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("card-ui-c");
    await page.click("#show-list");
    expect(await page.evaluate(() => document.getElementById("graph-legend")?.hidden)).toBe(true);
    await page.click("#show-graph");
    await page.waitForSelector("#graph .gnode");
  });

  it("移った先のカードは 1.5 秒ほど光り、外れる。続けて押すとはじめから。光っている途中の描き直しのあとも、残りの時間は光る", async () => {
    const has = () =>
      page.evaluate(
        () => document.getElementById("card-ui-b")?.classList.contains("picked") ?? false,
      );
    await page.click('#graph .gnode[data-id="ui-b"]');
    await page.waitForSelector("#card-ui-b.picked");
    const first = await page.evaluate(() => document.getElementById("card-ui-b")?.className ?? "");
    // 続けて押すと、動きのクラスが入れ替わる（はじめから動く）
    await page.click('#graph .gnode[data-id="ui-b"]');
    const second = await page.evaluate(() => document.getElementById("card-ui-b")?.className ?? "");
    expect(first.includes(" pa") !== second.includes(" pa")).toBe(true);
    // 途中で描き直す（記録の番号を進める）→ 作り直したカードにも、残りの時間は付いている
    await page.evaluate(() => {
      const c = document.getElementById("card-ui-b");
      if (c) c.dataset.old = "1";
    });
    current = { ...state, lastSeq: state.lastSeq + 1 };
    await page.waitForFunction(
      () => {
        const c = document.getElementById("card-ui-b");
        return c !== null && c.dataset.old === undefined;
      },
      undefined,
      { timeout: 5000 },
    );
    expect(await has()).toBe(true);
    // 描き直しのあとも、focus は作り直した同じ子のカードにある
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("card-ui-b");
    await page.waitForTimeout(1700);
    expect(await has()).toBe(false);
    // focus がほかの所（答えの欄）へ移っていたら、描き直しのあとにカードへ奪わない
    await page.click("#todo textarea");
    await page.evaluate(() => {
      const c = document.getElementById("card-ui-b");
      if (c) c.dataset.old = "1";
    });
    current = { ...state, lastSeq: state.lastSeq + 2 };
    await page.waitForFunction(
      () => {
        const c = document.getElementById("card-ui-b");
        return c !== null && c.dataset.old === undefined;
      },
      undefined,
      { timeout: 5000 },
    );
    expect(await page.evaluate(() => /^card-/.test(document.activeElement?.id ?? ""))).toBe(false);
    current = state;
  });

  it("図と一覧を切り替えられる。一覧にすると図は片付き、図に戻すと描き直す", async () => {
    await page.click("#show-list");
    expect(await page.evaluate(() => document.getElementById("graph")?.hidden)).toBe(true);
    expect(await page.evaluate(() => document.getElementById("list")?.hidden)).toBe(false);
    expect(await page.locator("#graph .gnode").count()).toBe(0);
    expect(await page.locator("#show-list[aria-checked=true]").count()).toBe(1);
    await page.click("#show-graph");
    await page.waitForSelector("#graph .gnode");
    expect(await page.locator("#graph .gnode").count()).toBe(7);
    expect(await page.locator("#show-graph[aria-checked=true]").count()).toBe(1);
  });

  it("図の右上の「＋」「−」「全体を見る」で、拡大・縮小・初めの形に戻せる。キーボードでも押せる。一覧のときは出ない", async () => {
    const zoomBox = page.locator("#graph-zoom");
    expect(await zoomBox.isVisible()).toBe(true);
    expect(await page.locator("#zoom-in").getAttribute("aria-label")).toBe("拡大する");
    expect(await page.locator("#zoom-out").getAttribute("aria-label")).toBe("縮める");
    expect(await page.locator("#zoom-fit").getAttribute("aria-label")).toBe("全体を見る");
    for (const id of ["zoom-in", "zoom-out", "zoom-fit"])
      expect(await page.locator(`#${id}`).getAttribute("title")).not.toBe(null);
    const holder = () =>
      page.evaluate(() => (document.querySelector("#graph > div") as HTMLElement).style.transform);
    const first = await holder();
    await page.click("#zoom-in");
    await page.waitForTimeout(100);
    const zoomed = await holder();
    expect(zoomed).not.toBe(first);
    await page.focus("#zoom-out");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    expect(await holder()).not.toBe(zoomed);
    await page.click("#zoom-in");
    await page.focus("#zoom-fit");
    await page.keyboard.press(" ");
    await page.waitForTimeout(100);
    expect(await holder()).toBe(first);
    // 右上に置く（枠の中の右上の隅）
    const b = await page.locator("#graph").boundingBox();
    const z = await zoomBox.boundingBox();
    expect(
      b && z && z.x + z.width <= b.x + b.width && z.x > b.x + b.width / 2 && z.y < b.y + 60,
    ).toBe(true);
    await page.click("#show-list");
    expect(await zoomBox.isVisible()).toBe(false);
    await page.click("#show-graph");
    await page.waitForSelector("#graph .gnode");
    expect(await zoomBox.isVisible()).toBe(true);
    expect(await csp()).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("頭の帯の「設定」で設定の窓が開く。キーボードで開け、窓の中は Tab で回り、Esc・閉じるで閉じて、ボタンへ focus が戻る", async () => {
    expect(await page.locator("header .tools #still").count()).toBe(0); // 頭の帯から「動きを止める」はなくなった
    const btn = page.locator("#open-settings");
    expect([await btn.getAttribute("aria-label"), await btn.getAttribute("title")]).toEqual([
      "設定",
      "設定",
    ]);
    await btn.focus();
    await page.keyboard.press("Enter");
    expect(await page.locator("#settings").evaluate((d) => (d as HTMLDialogElement).open)).toBe(
      true,
    );
    expect(await page.getByRole("dialog", { name: "設定" }).count()).toBe(1);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("set-still");
    // 動きを止める → 明暗（選んだ 1 つ）→ 言語（選んだ 1 つ）→ 管理 → 閉じる → また動きを止める
    const order: string[] = [];
    for (let k = 0; k < 5; k += 1) {
      await page.keyboard.press("Tab");
      order.push(
        await page.evaluate(() => {
          const a = document.activeElement as HTMLInputElement | null;
          return a?.id || `${a?.name}:${a?.value}`;
        }),
      );
    }
    expect(order).toEqual([
      "set-theme:auto",
      "set-lang:ja",
      "to-admin",
      "close-settings",
      "set-still",
    ]);
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("close-settings");
    await page.keyboard.press("Escape");
    expect(await page.locator("#settings").evaluate((d) => (d as HTMLDialogElement).open)).toBe(
      false,
    );
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("open-settings");
    await btn.click();
    await page.click("#close-settings");
    expect(await page.locator("#settings").evaluate((d) => (d as HTMLDialogElement).open)).toBe(
      false,
    );
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("open-settings");
    // 言語の欄（#140）。English も選べる
    expect(await page.locator('input[name="set-lang"][value="en"]').isDisabled()).toBe(false);
  });

  it("管理の窓: 設定の窓の「管理」から開く。確認の欄は窓の中に出て、送るボタンが読める。Shift+Tab は窓の外へ抜けず、Esc で閉じて歯車へ focus が戻る", async () => {
    await page.click("#open-settings");
    await page.click("#to-admin");
    const isOpen = (id: string) => page.locator(id).evaluate((d) => (d as HTMLDialogElement).open);
    expect(await isOpen("#admin")).toBe(true);
    expect(await isOpen("#settings")).toBe(false); // 窓は重ねない
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("admin-title");
    // 開いた直後（見出しに focus）の Shift+Tab は、窓の末尾へ回る
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("close-admin");
    // 確認の欄は管理の窓の中（#confirm-admin）。送るボタン（primary）は、文字と地が同じ色にならない（窓の中の button の地が勝たない）
    const colors = await page.evaluate(() => {
      const box = document.getElementById("confirm-admin") as HTMLElement;
      box.hidden = false;
      const b = document.createElement("button");
      b.className = "primary";
      b.textContent = "x";
      box.appendChild(b);
      const s = getComputedStyle(b);
      const r = { fg: s.color, bg: s.backgroundColor, inside: box.closest("dialog")?.id };
      b.remove();
      box.hidden = true;
      return r;
    });
    expect(colors.inside).toBe("admin");
    expect(colors.fg).not.toBe(colors.bg);
    await page.keyboard.press("Escape");
    expect(await isOpen("#admin")).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("open-settings");
    expect(await csp()).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("管理の窓: 本文で出した確認は、管理の窓を開いて閉じても残る（管理の窓から出した確認だけが、閉じると取り消される）", async () => {
    // 本文のボタンを順に押し、確認の欄（#confirm）が出るものを探す（確認の 2 段目は押さないので、何も送らない）
    // 見せ方の切り替え（#show-list）や「隠す／表示する」（#finished-toggle）は押さない（押すと、あとの試験の前提の「図」が変わる）
    const buttons = page.locator(
      "#approvals button:not([disabled]), #todo button:not([disabled]), #cards button:not([disabled])",
    );
    const n = Math.min(await buttons.count(), 40);
    let opened = false;
    for (let i = 0; i < n && !opened; i += 1) {
      const b = buttons.nth(i);
      if (!(await b.isVisible())) continue;
      await b.click({ timeout: 2000 }).catch(() => undefined);
      opened = await page.locator("#confirm").isVisible();
    }
    if (!opened) return; // この試験データには、確認を開くボタンがない
    const before = await page.locator("#confirm").innerText();
    await page.click("#open-settings");
    await page.click("#to-admin");
    expect(await page.locator("#confirm-admin").isHidden()).toBe(true); // 管理の窓の側の欄は、出所のない確認を動かさない
    await page.keyboard.press("Escape");
    expect(await page.locator("#confirm").isVisible()).toBe(true);
    expect(await page.locator("#confirm").innerText()).toBe(before);
    expect(problems).toEqual([]);
  });

  it("設定の窓の「動きを止める」で、図の線も流星・火花も止まる（流星・火花は出ない）。戻すと動く。再読み込みのあとも残る", async () => {
    const meteors = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#graph :is(.mh, .mhc, .mtl, .msp)")].map(
          (e) => getComputedStyle(e).display,
        ),
      );
    expect((await animations()).some((a) => a !== "none")).toBe(true);
    expect((await meteors()).some((d) => d !== "none")).toBe(true);
    await page.click("#open-settings");
    await page.click("#set-still");
    expect(new Set(await animations())).toEqual(new Set(["none"]));
    expect(new Set(await meteors())).toEqual(new Set(["none"]));
    await page.click("#close-settings");
    await reopen();
    expect(new Set(await animations())).toEqual(new Set(["none"]));
    await page.click("#open-settings");
    expect(await page.locator("#set-still").isChecked()).toBe(true);
    await page.click("#set-still");
    await page.click("#close-settings");
    expect((await animations()).some((a) => a !== "none")).toBe(true);
    expect(await csp()).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("設定の窓の明暗で、OS に合わせる・明るい・暗いが切り替わり、再読み込みのあとも残る", async () => {
    const bg = () =>
      page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    await page.emulateMedia({ colorScheme: "light" });
    const light = await bg();
    await page.click("#open-settings");
    await page.check('input[name="set-theme"][value="dark"]');
    await page.click("#close-settings");
    const dark = await bg();
    expect(dark).not.toBe(light);
    await reopen();
    expect(await bg()).toBe(dark);
    // OS が暗くても「明るい」を選べば明るい
    await page.emulateMedia({ colorScheme: "dark" });
    await page.click("#open-settings");
    await page.check('input[name="set-theme"][value="light"]');
    expect(await bg()).toBe(light);
    await page.check('input[name="set-theme"][value="auto"]');
    expect(await bg()).toBe(dark);
    await page.click("#close-settings");
    await page.emulateMedia({ colorScheme: "light" });
    expect(await bg()).toBe(light);
    expect(await csp()).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("ブラウザに残せないとき（localStorage が使えない）も、設定の窓は動く", async () => {
    const ctx = await (browser as Browser).newContext({ locale: "ja-JP" });
    const p2 = await ctx.newPage();
    await p2.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("blocked");
        },
      });
    });
    const errs: string[] = [];
    p2.on("pageerror", (e: Error) => errs.push(e.message));
    await p2.goto(`${url}/ui#ticket=${await ticket()}`);
    await p2.waitForSelector("#graph .gnode");
    await p2.click("#open-settings");
    await p2.click("#set-still");
    expect(await p2.evaluate(() => document.documentElement.classList.contains("still"))).toBe(
      true,
    );
    await p2.click("#close-settings");
    expect(errs).toEqual([]);
    await ctx.close();
  });

  it("言語（#140）: ブラウザが英語なら英語の画面。設定で日本語にすると、その場で画面・図・知らせが切り替わり、再読み込みのあとも残る", async () => {
    const ctx = await (browser as Browser).newContext({ locale: "en-US" });
    const p2 = await ctx.newPage();
    const errs: string[] = [];
    p2.on("pageerror", (e: Error) => errs.push(e.message));
    const open = async () => {
      await p2.goto("about:blank");
      await p2.goto(`${url}/ui#ticket=${await ticket()}`);
      await p2.waitForSelector("#graph .gnode");
    };
    const cjk = /[\u3040-\u30ff\u3400-\u9fff]/;
    const textOf = (sel: string) =>
      p2.evaluate((s: string) => document.querySelector(s)?.textContent ?? "", sel);
    const all = (sel: string) =>
      p2.evaluate(
        (s: string) => [...document.querySelectorAll(s)].map((e) => e.textContent ?? ""),
        sel,
      );
    await open();
    expect(await p2.evaluate(() => document.documentElement.lang)).toBe("en");
    expect(await p2.evaluate(() => document.title)).toBe("sample-repo - touryou status");
    for (const sel of [
      "h1",
      "#now-title",
      "#status",
      "#graph-legend",
      "#view-switch",
      "#admin-title",
      "#to-admin",
    ])
      expect(cjk.test(await textOf(sel)), sel).toBe(false);
    // 図の箱の状態の言葉・カードの札も英語
    const states = await all("#graph .gst");
    expect(states.length).toBeGreaterThan(0);
    for (const t of states) expect(cjk.test(t), t).toBe(false);
    expect(await p2.evaluate(() => document.getElementById("open-settings")?.ariaLabel)).toBe(
      "Settings",
    );
    // 止めた・済んだ子のスイッチ（アイコンだけ）の名前とツールチップも英語（#281）
    expect(await p2.locator("#finished-toggle").getAttribute("aria-label")).toBe(
      "Show stopped and finished",
    );
    expect(cjk.test((await p2.locator("#finished-toggle").getAttribute("data-tip")) ?? "")).toBe(
      false,
    );
    // daemon が書いた知らせ（msg つき）は英語。msg のない知らせ・子が書いた文は、書かれたまま（利用者の決め）
    const entries = await all(".entry");
    expect(entries.some((t) => t.includes("has not picked up instruction #3 after 10 min"))).toBe(
      true,
    );
    expect(entries.some((t) => t.includes("ui-b の結果を待っている"))).toBe(true);
    // 言語を選ばずに明暗だけ変えても、言語は残さない（あとでブラウザの言語を変えれば、ついてくる）
    const saved = () =>
      p2.evaluate(() => JSON.parse(window.localStorage.getItem("touryou.ui.settings") ?? "null"));
    await p2.click("#open-settings");
    await p2.check('input[name="set-theme"][value="light"]');
    await p2.click("#close-settings");
    expect(await saved()).toEqual({ still: false, theme: "light", showFinished: false });
    // 設定で日本語を選ぶと、その場で切り替わり、言語も残る
    await p2.click("#open-settings");
    await p2.check('input[name="set-lang"][value="ja"]');
    await p2.click("#close-settings");
    expect(await p2.evaluate(() => document.documentElement.lang)).toBe("ja");
    expect(await textOf("#now-title")).toMatch(cjk);
    expect(await saved()).toEqual({
      still: false,
      theme: "light",
      lang: "ja",
      showFinished: false,
    });
    expect((await all("#graph .gst")).some((t) => cjk.test(t))).toBe(true);
    expect(
      (await all(".entry")).some((t) =>
        t.includes("指示（番号 3）を 10 分たっても受け取っていない"),
      ),
    ).toBe(true);
    // 再読み込みのあとも残る（ブラウザが英語でも、覚えた日本語）
    await open();
    expect(await p2.evaluate(() => document.documentElement.lang)).toBe("ja");
    // 左上は、言語によらず、リポジトリの名前（#274）
    expect(await textOf("h1")).toBe("sample-repo");
    // 英語に戻すと、覚えた値も英語
    await p2.click("#open-settings");
    await p2.check('input[name="set-lang"][value="en"]');
    await p2.click("#close-settings");
    await open();
    expect(await p2.evaluate(() => document.documentElement.lang)).toBe("en");
    expect(errs).toEqual([]);
    await ctx.close();
  });

  it("図の「N 分前」は、再読み込みも描き直しもなしに、15 秒ごとに現在時刻から計算し直される（#204）", async () => {
    const ctx = await (browser as Browser).newContext({ locale: "ja-JP" });
    const p2 = await ctx.newPage();
    const errs: string[] = [];
    p2.on("pageerror", (e: Error) => errs.push(e.message));
    // 時計は、画面を開く前に差し替える（setInterval も、Date.now も、差し替えた時計のもの）
    await p2.clock.install();
    // 偽の時計を進めると、背景の描画（rAF）が何千回も走って時間切れになる。この試験は背景を見ないので描かせない
    await p2.emulateMedia({ reducedMotion: "reduce" });
    await p2.goto(`${url}/ui#ticket=${await ticket()}`);
    await p2.waitForSelector("#graph .gnode");
    const agoOf = () =>
      p2.evaluate(() => {
        const t = document.querySelector('#graph .gnode[data-id="ui-a"] .gs')?.textContent ?? "";
        const m = /^作業　(\d+) 分前$/.exec(t);
        return m === null ? null : Number(m[1]);
      });
    const before = await agoOf();
    expect(before).not.toBeNull();
    // 描き直したら消える印を、箱に付ける（描き直さずに、文字だけ書き換えることを確かめる）
    await p2.evaluate(() => {
      const box = document.querySelector('#graph .gnode[data-id="ui-a"]') as HTMLElement | null;
      if (box) box.dataset.mark = "kept";
    });
    // 15 秒では 1 分に届かないので、文字は変わらない
    await p2.clock.runFor(15_000);
    expect(await agoOf()).toBe(before);
    // 2 分進めると、15 秒ごとの更新で、少なくとも 2 分は増える（60 分を超えると「N 時間」の書き方に変わるので、短く進める）
    await p2.clock.runFor(2 * 60_000);
    const after = await agoOf();
    expect(after).not.toBeNull();
    expect((after ?? 0) - (before ?? 0)).toBeGreaterThanOrEqual(2);
    expect(
      await p2.evaluate(
        () =>
          (document.querySelector('#graph .gnode[data-id="ui-a"]') as HTMLElement | null)?.dataset
            .mark,
      ),
    ).toBe("kept");
    expect(errs).toEqual([]);
    await ctx.close();
  });

  it("「止めた・済んだ子を隠す／表示する」を押すと、図から止めた・済んだ子の箱が消え、押すと戻る。文言は押したあとの動きに替わり、再読み込みのあとも残る（#206・#274）", async () => {
    // 表示する文言はなく（アイコンだけ）、名前は固定の aria-label。いまの状態は role="switch" の aria-checked（入＝表示している）で見る（#277・#281）
    const label = async () =>
      (await page.locator("#finished-toggle").getAttribute("aria-label")) +
      ":" +
      (await page.locator("#finished-toggle").getAttribute("aria-checked"));
    const ids = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#graph .gnode")].map((e) => e.getAttribute("data-id")),
      );
    const toggle = async () => {
      await page.click("#finished-toggle");
      await page.waitForSelector("#graph .gnode");
    };
    // 初めは「表示する」で始めてある（上の beforeAll の初期値）ので、いまは出ている。押すと隠れる
    expect(await label()).toBe("止めた・済んだ子を表示する:true");
    expect(await page.locator("#finished-toggle").getAttribute("role")).toBe("switch");
    // 表示する文言はない。「図／一覧」の丸薬と、スイッチの丸薬の高さがそろっている（#281）
    expect(
      await page.evaluate(() => document.getElementById("finished-toggle")?.textContent?.trim()),
    ).toBe("");
    const heights = await page.evaluate(() =>
      ["view-switch", "finished-filter"].map(
        (id) => document.getElementById(id)?.getBoundingClientRect().height,
      ),
    );
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights[1]).toBe(heights[0]);
    // ツールチップは、フォーカスで出る。入のときは「隠す」（押したあとの動き）
    await page.focus("#finished-toggle");
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.getElementById("finished-toggle") as Element, "::after").display,
      ),
    ).toBe("block");
    expect(await page.locator("#finished-toggle").getAttribute("data-tip")).toBe(
      "止めた・済んだ子を隠す",
    );
    // 説明文は、窓の上でなく図の下の小さな文
    expect(
      await page.evaluate(() => {
        const note = document.getElementById("graph-note")?.getBoundingClientRect();
        const board = document.getElementById("graph")?.getBoundingClientRect();
        return !!note && !!board && note.top >= board.bottom;
      }),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        document.getElementById("finished-toggle")?.hasAttribute("aria-pressed"),
      ),
    ).toBe(false);
    const all = await ids();
    expect(all).toContain("ui-old");
    expect(await page.locator("#graph .gnode.t-over").count()).toBeGreaterThan(0);
    await toggle();
    expect(await label()).toBe("止めた・済んだ子を表示する:false");
    const hidden = await ids();
    expect(hidden).not.toContain("ui-old");
    expect(await page.locator("#graph .gnode.t-over").count()).toBe(0);
    for (const id of ["root", "ui-a", "ui-b", "ui-c", LONG]) expect(hidden).toContain(id);
    expect(hidden.length).toBeLessThan(all.length);
    // ブラウザに残る（鍵は 1 つ。値は still・theme・lang・showFinished のどれか）
    const saved = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("touryou.ui.settings") ?? "null"),
    );
    expect(saved.showFinished).toBe(false);
    // 再読み込みのあとも、隠れたまま
    await reopen();
    expect(await label()).toBe("止めた・済んだ子を表示する:false");
    expect(await ids()).not.toContain("ui-old");
    // 押すと戻る
    await toggle();
    expect(await label()).toBe("止めた・済んだ子を表示する:true");
    expect(new Set(await ids())).toEqual(new Set(all));
    await reopen();
    expect(await label()).toBe("止めた・済んだ子を表示する:true");
    expect(new Set(await ids())).toEqual(new Set(all));
    expect(await csp()).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("何も選んでいない画面は、止めた・済んだ子を隠す。図でも一覧でも同じボタンで「表示する」と、出る（#274）", async () => {
    const ctx = await (browser as Browser).newContext({ locale: "ja-JP" });
    const p2 = await ctx.newPage();
    const errs: string[] = [];
    p2.on("pageerror", (e: Error) => errs.push(e.message));
    await p2.goto(`${url}/ui#ticket=${await ticket()}`);
    await p2.waitForSelector("#graph .gnode");
    const label = async () =>
      (await p2.locator("#finished-toggle").getAttribute("aria-label")) +
      ":" +
      (await p2.locator("#finished-toggle").getAttribute("aria-checked"));
    const graphIds = () =>
      p2.evaluate(() =>
        [...document.querySelectorAll("#graph .gnode")].map((e) => e.getAttribute("data-id")),
      );
    const listText = () => p2.evaluate(() => document.getElementById("list")?.textContent ?? "");
    // 図: 既定は隠す。ボタンは「表示する」
    expect(await graphIds()).not.toContain("ui-old");
    expect(await label()).toBe("止めた・済んだ子を表示する:false");
    // 一覧へ切り替えても、同じボタンがあり、同じ状態（隠している）。隠した数を出す
    await p2.click("#show-list");
    expect(
      await p2.evaluate(() => document.getElementById("finished-toggle")?.offsetParent !== null),
    ).toBe(true);
    expect(await label()).toBe("止めた・済んだ子を表示する:false");
    expect(await listText()).not.toContain("前の画面を片付ける");
    expect(await listText()).toMatch(/\d+ 件隠しています/);
    // 一覧の「N 件隠しています」も、図と同じ角丸の札（hpill）で、地・縁・余白がある（#277）
    const pill = await p2.evaluate(() => {
      const e = document.querySelector("#list .hpill");
      if (!e) return null;
      const s = getComputedStyle(e);
      return { border: s.borderTopWidth, radius: s.borderTopLeftRadius, margin: s.marginLeft };
    });
    expect(pill).not.toBeNull();
    expect(pill?.border).toBe("1px");
    expect(pill?.margin).not.toBe("0px");
    // 押すと、一覧に出る（隠した数の文は消える）
    await p2.click("#finished-toggle");
    expect(await label()).toBe("止めた・済んだ子を表示する:true");
    expect(await listText()).toContain("前の画面を片付ける");
    expect(await listText()).not.toMatch(/件隠しています/);
    // 図へ戻すと、図にも出ている（同じ状態）
    await p2.click("#show-graph");
    await p2.waitForSelector("#graph .gnode");
    expect(await graphIds()).toContain("ui-old");
    expect(errs).toEqual([]);
    await ctx.close();
  });

  it("紐付けが外れているかもしれない子（bindLostSuspect）のカードに、札と次にすること（統合が利用者に確かめ、承認後に自動でつなぎ直す。直らないときだけ claude attach。内部の道具名は出さない）が出る（#209・#255・#260）", async () => {
    const lost = foldEvents([
      ...created("root", "integrator", null, "紐付けの試験をまとめる"),
      ...created("ui-lost", "implement", "root", "紐付けが外れた子"),
      ev({
        type: "inbox.added",
        payload: {
          id: "bl1",
          kind: "info",
          nodeId: "ui-lost",
          ...inboxMessage("bindLostSuspect", { node: "ui-lost", minutes: 12 }),
        },
      }),
    ]);
    if (!lost.ok) throw new Error(lost.error.cause);
    const server2 = createApiServer({
      credentials: createCredentialStore({ humanToken: HUMAN }),
      getState: () => lost.value,
      handlers: {},
    });
    const url2 = (await server2.listen(0)).url;
    try {
      for (const [locale, chip, next] of [
        [
          "ja-JP",
          "紐付けの接続が途切れているかも",
          "次の操作: 統合の Claude に、子のつなぎ直しを頼む",
        ],
        [
          "en-US",
          "Connection to the binding may be down",
          "Next: ask the integrator Claude to reconnect the child",
        ],
      ] as const) {
        const ctx = await (browser as Browser).newContext({ locale });
        const p2 = await ctx.newPage();
        const errs: string[] = [];
        p2.on("pageerror", (e: Error) => errs.push(e.message));
        const res = await fetch(`${url2}/v1/ui/ticket`, {
          method: "POST",
          headers: { authorization: `Bearer ${HUMAN}` },
        });
        const t = ((await res.json()) as { value: { ticket: string } }).value.ticket;
        await p2.goto(`${url2}/ui#ticket=${t}`);
        await p2.waitForSelector("#card-ui-lost");
        const chips = await p2.evaluate(() =>
          [...document.querySelectorAll("#card-ui-lost > div .chip")].map(
            (e) => e.textContent ?? "",
          ),
        );
        expect(
          chips.some((x) => x.includes(chip)),
          `${locale}: ${chips.join(" / ")}`,
        ).toBe(true);
        // 次にすること（カードの表の説明。知らせの項目の文は、たたみの中にあるので数えない）
        const descs = await p2.evaluate(() =>
          [...document.querySelectorAll("#card-ui-lost > p.desc")].map((e) => e.textContent ?? ""),
        );
        // runtime の記録がない子は、runtime 不明の文（統合の Claude に頼む）。CLI の文（claude attach）は出さない（#264）
        const nextText = descs.find((x) => x.includes(next)) ?? "";
        expect(nextText, locale).not.toBe("");
        expect(nextText).not.toContain("claude attach");
        expect(nextText).not.toContain("node_bindCode");
        expect(nextText).not.toContain("child_bind");
        expect(errs).toEqual([]);
        await ctx.close();
      }
    } finally {
      await server2.close();
    }
  });

  it("知らせの接続が途切れた子のカードの次の操作は、runtime ごとに分かれ、CLI の子は「開き方」の欄が開いた状態で出る（#264）", async () => {
    const withRuntime = (nodeId: string, runtime: "cli" | "desktop") =>
      created(nodeId, "implement", "root", `紐付けが外れた ${runtime} の子`).map((e) =>
        e.type === "node.created" ? ({ ...e, payload: { ...e.payload, runtime } } as OrchEvent) : e,
      );
    const lostNotice = (id: string, nodeId: string) =>
      ev({
        type: "inbox.added",
        payload: {
          id,
          kind: "info",
          nodeId,
          ...inboxMessage("bindLostSuspect", { node: nodeId, minutes: 12 }),
        },
      });
    const lost = foldEvents([
      ...created("root", "integrator", null, "紐付けの試験をまとめる"),
      ...withRuntime("ui-lost-cli", "cli"),
      ...withRuntime("ui-lost-dt", "desktop"),
      lostNotice("blc", "ui-lost-cli"),
      lostNotice("bld", "ui-lost-dt"),
    ]);
    if (!lost.ok) throw new Error(lost.error.cause);
    const server2 = createApiServer({
      credentials: createCredentialStore({ humanToken: HUMAN }),
      getState: () => lost.value,
      handlers: {},
    });
    const url2 = (await server2.listen(0)).url;
    try {
      const ctx = await (browser as Browser).newContext({ locale: "ja-JP" });
      const p2 = await ctx.newPage();
      const errs: string[] = [];
      p2.on("pageerror", (e: Error) => errs.push(e.message));
      const res = await fetch(`${url2}/v1/ui/ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${HUMAN}` },
      });
      const t = ((await res.json()) as { value: { ticket: string } }).value.ticket;
      await p2.goto(`${url2}/ui#ticket=${t}`);
      await p2.waitForSelector("#card-ui-lost-cli");
      await p2.waitForSelector("#card-ui-lost-dt");
      const descsOf = (id: string) =>
        p2.evaluate(
          (sel) =>
            [...document.querySelectorAll(`${sel} > p.desc`)].map((e) => e.textContent ?? ""),
          `#card-${id}`,
        );
      const cli = await descsOf("ui-lost-cli");
      expect(
        cli.some((x) => x.includes("「つなぎ直してよいか」に答える")),
        cli.join(" / "),
      ).toBe(true);
      expect(cli.some((x) => x.includes("「開き方」の claude attach"))).toBe(true);
      const dt = await descsOf("ui-lost-dt");
      expect(
        dt.some((x) => x.includes("次の操作: 統合の Claude に、子のつなぎ直しを頼む")),
        dt.join(" / "),
      ).toBe(true);
      expect(dt.some((x) => x.includes("claude attach"))).toBe(false);
      // CLI の子は、案内の先（「開き方」の claude attach）が、たたまれずに見える
      const openFold = await p2.evaluate(() =>
        [...document.querySelectorAll("#card-ui-lost-cli details")].some(
          (d) => (d as HTMLDetailsElement).open && (d.textContent ?? "").includes("claude attach"),
        ),
      );
      expect(openFold).toBe(true);
      expect(errs).toEqual([]);
      await ctx.close();
    } finally {
      await server2.close();
    }
  });

  it("prefers-reduced-motion のとき、図の線も彗星も動かない", async () => {
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
    // 設定の窓（#139）
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.click("#open-settings");
    await page.screenshot({ path: `${dir}/ui-settings.png` });
    await page.click("#close-settings");
    // 英語の画面（#140）
    const ctx = await (browser as Browser).newContext({ locale: "en-US" });
    const en = await ctx.newPage();
    await en.setViewportSize({ width: 1280, height: 900 });
    await en.goto(`${url}/ui#ticket=${await ticket()}`);
    await en.waitForSelector("#graph .gnode");
    await en.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await en.mouse.move(1, 1);
    await en.screenshot({ path: `${dir}/ui-en.png`, fullPage: true });
    await ctx.close();
  });

  it("狭い窓でも、横にはみ出さない。いちばん上の帯の「設定」が切れない", async () => {
    for (const width of [1280, 900, 600, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const r = await page.evaluate(() => {
        const b = (document.getElementById("open-settings") as HTMLElement).getBoundingClientRect();
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
