/**
 * ノードの購読（設計 6.3）: `GET /v1/events?node=<id>&after=<seq>`。
 * 出来事は記録（状態）から作り、`seq` で取り直せる。中身は載せない。自分のノードの資格情報だけが購読できる。
 */
import { request as httpRequest } from "node:http";
import { foldEvents, type OrchEvent, type OrchState } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { type ApiLogEvent, type ApiServer, createApiServer } from "../../src/api/server.js";
import { createSseHub, nodeFeedOf, type SseSink } from "../../src/api/sse-hub.js";

const HUMAN = "human-token-human-token-human-token-1234";
const SYS = { system: true } as const;
const e = (seq: number, body: unknown): OrchEvent =>
  ({
    seq,
    at: "2026-11-11T00:00:00Z",
    requestId: `r${seq}`,
    actor: SYS,
    ...(body as object),
  }) as OrchEvent;
const created = (seq: number, nodeId: string, role: string, parentId: string | null) => [
  e(seq, { type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } }),
  e(seq + 1, { type: "node.stateChanged", payload: { nodeId, event: { type: "start" } } }),
];
const fold = (events: OrchEvent[]): OrchState => {
  const r = foldEvents(events);
  if (!r.ok) throw new Error(`${r.error.code}`);
  return r.value;
};
const BASE = [
  ...created(1, "root", "integrator", null),
  ...created(3, "a", "implement", "root"),
  ...created(5, "b", "implement", "root"),
];
const instructed = (seq: number, nodeId: string) =>
  e(seq, { type: "node.instructed", payload: { nodeId, text: "本文は出さない" } });

describe("nodeFeedOf", () => {
  it("そのノードの指示と停止の指示だけを、seq の昇順で、after より後だけ返す。本文は含めない", () => {
    const s = fold([
      ...BASE,
      instructed(7, "a"),
      instructed(8, "b"),
      e(9, {
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "stop", mode: "graceful", graceMs: 1000 } },
      }),
      instructed(10, "a"),
    ]);
    const all = nodeFeedOf(s, "a", 0);
    expect(all).toEqual([
      { seq: 7, kind: "instruction" },
      { seq: 9, kind: "stop" },
      { seq: 10, kind: "instruction" },
    ]);
    expect(all.every((x) => Object.keys(x).sort().join() === "kind,seq")).toBe(true);
    expect(nodeFeedOf(s, "a", 7).map((x) => x.seq)).not.toContain(7);
    expect(nodeFeedOf(s, "b", 0)).toEqual([{ seq: 8, kind: "instruction" }]);
  });
});

class FakeSink implements SseSink {
  written: string[] = [];
  write(c: string): boolean {
    this.written.push(c);
    return true;
  }
  end(): void {}
  destroy(): void {}
  readonly destroyed = false;
  onDrain(): void {}
  onClose(): void {}
  get text(): string {
    return this.written.join("");
  }
}

describe("sse-hub のノードの購読", () => {
  it("つないだら ready と、after より後の出来事を送る。新しい出来事は周期で送る。画面の接続の数には数えない", () => {
    let state = fold([...BASE, instructed(7, "a")]);
    const hub = createSseHub({
      spec: {
        maxConnections: 1,
        coalesceMs: 10,
        heartbeatMs: 1000,
        drainTimeoutMs: 500,
        maxLifetimeMs: 60_000,
      },
      getSeq: () => state.lastSeq,
      isTokenValid: () => true,
      nowMs: () => 0,
      autoStart: false,
      nodeFeed: (id, after) => nodeFeedOf(state, id, after),
    });
    const sink = new FakeSink();
    expect(hub.addNode(sink, "t", "a", 0)).toBe(true);
    expect(hub.size).toBe(0);
    expect(hub.nodeSize).toBe(1);
    expect(sink.text).toContain("event: ready");
    expect(sink.text).toContain('id: 7\nevent: node\ndata: {"seq":7,"kind":"instruction"}');
    state = fold([...BASE, instructed(7, "a"), instructed(8, "b"), instructed(9, "a")]);
    hub.tick();
    expect(sink.text).toContain("id: 9\n");
    expect(sink.text).not.toContain("id: 8\n");
    const before = sink.written.length;
    hub.tick();
    expect(sink.written.length).toBe(before); // 送り直さない
    // 取り直し: after=7 でつなぐと、9 だけ
    const again = new FakeSink();
    hub.addNode(again, "t", "a", 7);
    expect(again.text).toContain("id: 9\n");
    expect(again.text).not.toContain("id: 7\n");
  });
});

let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const get = (
  port: number,
  path: string,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<{ status: number; text(): string; close(): void }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          buf += c;
        });
        res.on("error", () => {});
        resolve({ status: res.statusCode ?? 0, text: () => buf, close: () => req.destroy() });
      },
    );
    req.on("error", reject);
    req.end();
  });
const until = async (f: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("GET /v1/events?node=", () => {
  const boot = async () => {
    const credentials = createCredentialStore({ humanToken: HUMAN });
    let current = fold([...BASE, instructed(7, "a")]);
    server = createApiServer({
      credentials,
      getState: () => current,
      handlers: {},
      sse: { coalesceMs: 20, heartbeatMs: 60 },
    });
    const { port } = await server.listen(0);
    return {
      port,
      a: credentials.issueNodeToken("a", "child"),
      b: credentials.issueNodeToken("b", "child"),
      push: (ev: OrchEvent) => {
        current = fold([...BASE, instructed(7, "a"), ev]);
      },
    };
  };

  it("自分のノードの資格情報で購読でき、取りこぼし（after）と新しい出来事が届く", async () => {
    const r = await boot();
    const c = await get(r.port, "/v1/events?node=a&after=0", r.a);
    expect(c.status).toBe(200);
    await until(() => c.text().includes("id: 7\n"));
    r.push(instructed(8, "a"));
    await until(() => c.text().includes("id: 8\n"));
    c.close();
  });

  it("Last-Event-ID からも続きを取る", async () => {
    const r = await boot();
    r.push(instructed(8, "a"));
    const c = await get(r.port, "/v1/events?node=a", r.a, { "last-event-id": "7" });
    await until(() => c.text().includes("id: 8\n"));
    expect(c.text()).not.toContain("id: 7\n");
    c.close();
  });

  it("ほかのノード・人間のトークンは 403、トークンなしは 401、正しくない node・after は 422", async () => {
    const r = await boot();
    expect((await get(r.port, "/v1/events?node=a", r.b)).status).toBe(403);
    expect((await get(r.port, "/v1/events?node=a", HUMAN)).status).toBe(403);
    expect((await get(r.port, "/v1/events?node=a", null)).status).toBe(401);
    expect((await get(r.port, "/v1/events?node=a&after=x", r.a)).status).toBe(422);
    expect((await get(r.port, "/v1/events?node=..%2F", r.a)).status).toBe(422);
  });
});

describe("購読中の失効・フックのトークン", () => {
  it("(c) 購読中に、ノードの資格情報が使えなくなったら（停止・失効）、heartbeat の確かめで切れる。記録が変わらなければ出来事を調べない", () => {
    const state = fold([...BASE, instructed(7, "a")]);
    let now = 0;
    let valid = true;
    let feeds = 0;
    const hub = createSseHub({
      spec: {
        maxConnections: 1,
        coalesceMs: 10,
        heartbeatMs: 100,
        drainTimeoutMs: 500,
        maxLifetimeMs: 60_000,
      },
      getSeq: () => state.lastSeq,
      isTokenValid: () => true,
      isNodeTokenValid: (_t, nodeId) => valid && nodeId === "a",
      nowMs: () => now,
      autoStart: false,
      nodeFeed: (id, after) => {
        feeds += 1;
        return nodeFeedOf(state, id, after);
      },
    });
    const sink = new FakeSink();
    let ended = false;
    sink.end = () => {
      ended = true;
    };
    hub.addNode(sink, "t", "a", 0);
    const afterAdd = feeds;
    hub.tick();
    hub.tick();
    expect(feeds).toBe(afterAdd); // lastSeq が同じなら、なめない
    valid = false;
    now = 50;
    hub.tick();
    expect(ended).toBe(false); // heartbeat の前は、まだ
    now = 150;
    hub.tick();
    expect(ended).toBe(true);
    expect(hub.nodeSize).toBe(0);
  });

  it("(e) フック専用のトークンでは購読できない（403）", async () => {
    const credentials = createCredentialStore({ humanToken: HUMAN });
    server = createApiServer({
      credentials,
      getState: () => fold(BASE),
      handlers: {},
      hookTokens: {
        issue: () => "hook-token-hook-token-1234",
        authenticate: (t) => (t === "hook-token-hook-token-1234" ? "a" : undefined),
        revoke: () => undefined,
      },
    });
    const { port } = await server.listen(0);
    expect((await get(port, "/v1/events?node=a", "hook-token-hook-token-1234")).status).toBe(403);
  });
});

describe("退役の出来事（retired。#32）", () => {
  const bootRetire = async (heartbeatMs: number) => {
    const logs: ApiLogEvent[] = [];
    let retire: ((id: string) => void) | undefined;
    let idleExpire = false;
    const credentials = createCredentialStore({
      humanToken: HUMAN,
      // compose と同じ結び: 退役で失効したら、購読へ知らせる
      onExpired: (nodeId, reason) => {
        if (reason === "retired") retire?.(nodeId);
      },
      isRetired: () => false,
      expiry: { sdkIdleMs: 1e9, sdkAbsoluteMs: 1e9, bindAbsoluteMs: 1e9, bindIdleMs: 1 },
      isIdlePaused: () => !idleExpire,
    });
    const current = fold([...BASE, instructed(7, "a")]);
    server = createApiServer({
      credentials,
      getState: () => current,
      handlers: {},
      logger: (ev) => logs.push(ev),
      sse: { coalesceMs: 20, heartbeatMs },
      onSseHub: (hub) => {
        retire = (id) => {
          hub.retire(id);
        };
      },
    });
    const { port } = await server.listen(0);
    const a = credentials.issueNodeToken("a", "child", "bind");
    return {
      port,
      a,
      credentials,
      logs,
      expireIdle: () => {
        idleExpire = true;
      },
    };
  };

  it("退役（受理など）したら、heartbeat を待たずに retired を 1 件送って閉じる。中身は理由だけ。退役のあとの 401 の記録はない", async () => {
    const r = await bootRetire(60_000);
    let closed = false;
    const c = await new Promise<{ text(): string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: r.port,
          path: "/v1/events?node=a&after=0",
          headers: { authorization: `Bearer ${r.a}` },
        },
        (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (x: string) => {
            buf += x;
          });
          res.on("end", () => {
            closed = true;
          });
          res.on("error", () => {});
          resolve({ text: () => buf });
        },
      );
      req.on("error", reject);
      req.end();
    });
    await until(() => c.text().includes("event: ready"));
    expect(r.credentials.expireNode?.("a")).toBe(true);
    await until(() => closed, 2000);
    const text = c.text();
    expect(text.match(/event: retired/g)).toHaveLength(1);
    expect(text).toContain('event: retired\ndata: {"reason":"retired"}\n\n');
    const retiredBlock = text.slice(text.indexOf("event: retired"));
    expect(retiredBlock).not.toContain(r.a);
    expect(retiredBlock).not.toContain('"a"');
    // 張り直さない（mcp）ので、退役のあとの 401（apiAuthFailed の retiredExpired）は 0 件
    expect(
      r.logs.filter((x) => x.event === "apiAuthFailed" && x.reason === "retiredExpired"),
    ).toHaveLength(0);
  });

  it("退役でない失効（使わなかった時間の期限切れ）は、今までどおり heartbeat で閉じるだけ（retired は送らない）", async () => {
    const r = await bootRetire(60);
    let closed = false;
    let buf = "";
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: r.port,
          path: "/v1/events?node=a&after=0",
          headers: { authorization: `Bearer ${r.a}` },
        },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (x: string) => {
            buf += x;
          });
          res.on("end", () => {
            closed = true;
          });
          res.on("error", () => {});
          resolve();
        },
      );
      req.on("error", reject);
      req.end();
    });
    await until(() => buf.includes("event: ready"));
    r.expireIdle();
    await until(() => closed);
    expect(buf).not.toContain("event: retired");
  });
});
