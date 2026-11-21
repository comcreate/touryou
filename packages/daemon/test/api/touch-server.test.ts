/**
 * ノードのトークンを「使った」と数える（使わなければ切れる時計を延ばす）窓口の振る舞い（#189・#193）。
 * 認証に通った呼び出しは、弾かれても延ばす。例外は、前置きの知らせだけを読む `child.inbox`（と、その ack）。
 */
import type { EventBody } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { createChildInboxHandlers } from "../../src/api/handlers/child-inbox-handlers.js";
import { type ApiServer, createApiServer, type Handlers } from "../../src/api/server.js";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";

const HUMAN = "human-token-human-token-human-token-1234";
const MIN = 60_000;
const T0 = Date.parse("2026-10-20T00:00:00.000Z");
const SCOPE = { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] };

let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

let n = 0;
const setup = async (over: { perPrincipalBurst?: number } = {}) => {
  let now = T0;
  const o = EventLog.open(createMemoryStore().open(), { clock: () => "2026-11-12T00:00:00Z" });
  if (!o.ok) throw new Error(o.error.code);
  const log = o.value;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  add({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } });
  add({
    type: "node.created",
    payload: {
      nodeId: "a",
      role: "implement",
      parentId: "root",
      dependsOn: [],
      objective: "a を直す",
      acceptanceCriteria: ["テストが通る"],
      scope: SCOPE,
    },
  });
  add({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } });
  const credentials = createCredentialStore({
    humanToken: HUMAN,
    nowMs: () => now,
    clock: () => new Date(now).toISOString(),
    exemptNodeId: "root",
    expiry: {
      sdkIdleMs: 360 * MIN,
      sdkAbsoluteMs: 10_080 * MIN,
      bindAbsoluteMs: 1440 * MIN,
      bindIdleMs: 60 * MIN,
    },
  });
  const token = credentials.issueNodeToken("a", "child", "bind");
  const handlers = {
    ...createChildInboxHandlers({ log, clock: () => "2026-11-12T00:00:00Z" }),
  } as unknown as Handlers;
  server = createApiServer({
    credentials,
    getState: () => log.state(),
    handlers,
    ...(over.perPrincipalBurst === undefined
      ? {}
      : { rateLimit: { perPrincipal: { burst: over.perPrincipalBurst, perSecond: 0.0001 } } }),
  });
  const { url } = await server.listen(0);
  const call = async (operation: string, params: unknown = {}) => {
    const res = await fetch(`${url}/v1/request`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ requestId: `q-${++n}`, operation, params }),
    });
    return { status: res.status, json: (await res.json()) as { ok: boolean } };
  };
  /** 50 分たってから `act` を呼び、さらに 20 分たったとき（最後に使ってから 20 分か、70 分か）まだ切れていないか。 */
  const extended = async (act: () => Promise<unknown>): Promise<boolean> => {
    now += 50 * MIN;
    await act();
    now += 20 * MIN;
    return credentials.authenticate(token, false) !== undefined;
  };
  const instruct = (text: string, kind?: "tokenIdleSoon"): number => {
    const r = log.append({
      requestId: `seed-${++n}`,
      actor: { system: true },
      body: {
        type: "node.instructed",
        payload: { nodeId: "a", text, ...(kind === undefined ? {} : { kind }) },
      },
    });
    if (!r.ok) throw new Error(r.error.code);
    return r.value.event.seq;
  };
  return { call, extended, instruct };
};

describe("ノードのトークンを使ったと数える（窓口）", () => {
  it("(a) 弾かれた呼び出しも、認証に通れば時計を延ばす（引数エラー・権限の拒否・429）", async () => {
    const bad = await setup();
    expect(
      await bad.extended(async () => {
        const r = await bad.call("child.inbox", { nodeId: "b" }); // 未知の引数
        expect(r.status).toBe(400);
      }),
    ).toBe(true);
    await server?.close();

    const forbidden = await setup();
    expect(
      await forbidden.extended(async () => {
        const r = await forbidden.call("node.purge", { nodeId: "a", tombstone: false }); // 子には使えない
        expect(r.status).toBe(403);
      }),
    ).toBe(true);
    await server?.close();

    const limited = await setup({ perPrincipalBurst: 1 });
    await limited.call("child.inbox"); // 1 回目で枠が尽きる
    expect(
      await limited.extended(async () => {
        const r = await limited.call("child.inbox");
        expect(r.status).toBe(429);
      }),
    ).toBe(true);
  });

  it("(b) 前置きだけの child.inbox と、その ack は、時計を延ばさない", async () => {
    const read = await setup();
    read.instruct("もうすぐ切れる", "tokenIdleSoon");
    expect(
      await read.extended(async () => {
        const r = await read.call("child.inbox");
        expect(r.status).toBe(200);
      }),
    ).toBe(false);
    await server?.close();

    const ack = await setup();
    const seq = ack.instruct("もうすぐ切れる", "tokenIdleSoon");
    expect(
      await ack.extended(async () => {
        const r = await ack.call("child.inbox", { ackThrough: seq });
        expect(r.status).toBe(200);
      }),
    ).toBe(false);
  });

  it("(c) ふつうの指示を含む child.inbox・空の受信箱・前置きの ack のあとの読み出しは、時計を延ばす", async () => {
    const mixed = await setup();
    mixed.instruct("もうすぐ切れる", "tokenIdleSoon");
    mixed.instruct("続けて");
    expect(await mixed.extended(() => mixed.call("child.inbox"))).toBe(true);
    await server?.close();

    const empty = await setup();
    expect(await empty.extended(() => empty.call("child.inbox"))).toBe(true);
    await server?.close();

    const after = await setup();
    const seq = after.instruct("もうすぐ切れる", "tokenIdleSoon");
    await after.call("child.inbox", { ackThrough: seq });
    expect(await after.extended(() => after.call("child.inbox"))).toBe(true);
  });

  it("(d) all: true は、配信済みの前置きだけを選んでも、時計を延ばす", async () => {
    const s = await setup();
    const seq = s.instruct("もうすぐ切れる", "tokenIdleSoon");
    await s.call("child.inbox", { ackThrough: seq }); // 前置きを配信済みにする（延ばさない）
    expect(await s.extended(() => s.call("child.inbox", { all: true }))).toBe(true);
  });
});
