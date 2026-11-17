import { foldEvents, type OrchState } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";
import { UI_JS } from "../../src/api/ui-assets.js";
import { createUiSessionStore, type UiSessionStore } from "../../src/api/ui-session.js";

const HUMAN = "human-token-human-token-human-token-1234";

const state = (): OrchState => {
  const r = foldEvents([
    {
      seq: 1,
      at: "2026-10-20T00:00:00Z",
      requestId: "r1",
      actor: { system: true },
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    },
  ] as never);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

describe("createUiSessionStore", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("チケットは 1 回だけ交換できる。セッションは human-token と別の値", () => {
    const store = createUiSessionStore();
    const ticket = store.issueTicket();
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const s = store.exchange(ticket);
    expect(s).toBeDefined();
    expect(s).not.toBe(ticket);
    expect(store.isSession(s)).toBe(true);
    expect(store.exchange(ticket)).toBeUndefined();
  });

  it("チケットは 60 秒で切れる", () => {
    const c = clock();
    const store = createUiSessionStore({ nowMs: c.now });
    const ticket = store.issueTicket();
    c.advance(60_000);
    expect(store.exchange(ticket)).toBeUndefined();
    const t2 = store.issueTicket();
    c.advance(59_999);
    expect(store.exchange(t2)).toBeDefined();
  });

  it("誤ったチケット・形の違う値は断る", () => {
    const store = createUiSessionStore();
    store.issueTicket();
    expect(store.exchange("x".repeat(43))).toBeUndefined();
    expect(store.exchange(undefined)).toBeUndefined();
    expect(store.exchange(HUMAN)).toBeUndefined();
  });

  it("セッションは、使わないと 1 時間・最長 12 時間で切れる。revokeAll で全部切れる", () => {
    const c = clock();
    const store = createUiSessionStore({ nowMs: c.now });
    const idle = store.exchange(store.issueTicket());
    c.advance(3_600_000);
    expect(store.isSession(idle)).toBe(false);

    const busy = store.exchange(store.issueTicket());
    c.advance(50 * 60_000);
    expect(store.isSession(busy)).toBe(true);
    c.advance(50 * 60_000);
    expect(store.isSession(busy)).toBe(true);

    const a = store.exchange(store.issueTicket());
    store.revokeAll();
    expect(store.isSession(a)).toBe(false);
  });

  it("最長 12 時間は、使い続けても延びない", () => {
    const c = clock();
    const store = createUiSessionStore({ nowMs: c.now });
    const s = store.exchange(store.issueTicket());
    for (let i = 0; i < 14; i++) {
      c.advance(55 * 60_000);
      store.isSession(s);
    }
    expect(store.isSession(s)).toBe(false);
  });
});

let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});
const start = async (uiSessions?: UiSessionStore) => {
  const credentials = createCredentialStore({ humanToken: HUMAN });
  const logs: unknown[] = [];
  server = createApiServer({
    credentials,
    getState: state,
    handlers: {},
    logger: { log: (e: unknown) => logs.push(e) },
    ...(uiSessions === undefined ? {} : { uiSessions }),
    rateLimit: { authFailures: { burst: 5, perSecond: 0.001 }, summaryScheduler: null },
  } as never);
  const { url } = await server.listen(0);
  return { url, logs, root: credentials.issueNodeToken("root", "integrator") };
};
const ticketOf = async (url: string, token: string) =>
  fetch(`${url}/v1/ui/ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
const exchange = async (url: string, ticket: unknown) =>
  fetch(`${url}/v1/ui/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });

describe("POST /v1/ui/ticket・POST /v1/ui/session", () => {
  it("human-token でチケットをもらい、交換したセッションで状態を読める", async () => {
    const r = await start();
    const res = await ticketOf(r.url, HUMAN);
    expect(res.status).toBe(200);
    const ticket = (await res.json()).value.ticket as string;
    const ex = await exchange(r.url, ticket);
    expect(ex.status).toBe(200);
    const session = (await ex.json()).value.session as string;
    expect(session).not.toBe(HUMAN);
    const st = await fetch(`${r.url}/v1/ui/state`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(st.status).toBe(200);
    // 記録・ログに値を出さない
    const logged = JSON.stringify(r.logs);
    expect(logged).not.toContain(ticket);
    expect(logged).not.toContain(session);
  });

  it("2 回目・誤り・期限切れは、同じ文面で断る", async () => {
    let t = 0;
    const r = await start(createUiSessionStore({ nowMs: () => t }));
    const ticket = (await (await ticketOf(r.url, HUMAN)).json()).value.ticket as string;
    expect((await exchange(r.url, ticket)).status).toBe(200);
    const second = await exchange(r.url, ticket);
    const wrong = await exchange(r.url, "A".repeat(43));
    const old = (await (await ticketOf(r.url, HUMAN)).json()).value.ticket as string;
    t += 61_000;
    const expired = await exchange(r.url, old);
    const bodies = [];
    for (const x of [second, wrong, expired]) {
      expect(x.status).toBe(401);
      bodies.push(await x.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("失敗が続くと、照合せずに 429 で断る（総当たりを断つ）", async () => {
    const r = await start();
    for (let i = 0; i < 5; i++) expect((await exchange(r.url, "B".repeat(43))).status).toBe(401);
    const ticket = (await (await ticketOf(r.url, HUMAN)).json()).value.ticket as string;
    const res = await exchange(r.url, ticket);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });

  it("チケットは human-token だけがもらえる（セッション・ノードは 403、なし・誤りは 401）", async () => {
    const r = await start();
    const ticket = (await (await ticketOf(r.url, HUMAN)).json()).value.ticket as string;
    const session = (await (await exchange(r.url, ticket)).json()).value.session as string;
    expect((await ticketOf(r.url, session)).status).toBe(403);
    expect((await ticketOf(r.url, r.root)).status).toBe(403);
    expect((await fetch(`${r.url}/v1/ui/ticket`, { method: "POST" })).status).toBe(401);
    expect((await ticketOf(r.url, "C".repeat(43))).status).toBe(401);
    expect((await fetch(`${r.url}/v1/ui/ticket`)).status).toBe(405);
  });

  it("daemon を起動し直す（ストアを作り直す）と、セッションは切れる", async () => {
    const r = await start();
    const ticket = (await (await ticketOf(r.url, HUMAN)).json()).value.ticket as string;
    const session = (await (await exchange(r.url, ticket)).json()).value.session as string;
    await server?.close();
    const r2 = await start();
    const st = await fetch(`${r2.url}/v1/ui/state`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(st.status).toBe(401);
  });
});

describe("画面の入口", () => {
  it("#token= を受け取らず、#ticket= を交換する", () => {
    expect(UI_JS).not.toMatch(/token=\(/);
    expect(UI_JS).toContain("ticket=([A-Za-z0-9_-]{43})");
    expect(UI_JS).toContain("'/v1/ui/session'");
    expect(UI_JS).toContain("replaceState");
  });
});
