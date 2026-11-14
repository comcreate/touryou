/**
 * 知らせ（設計 6.3）: 受信箱のソケットに 1 行を書く・自分のノードを購読して、再接続のあとは続きから取り直す。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failure, ok } from "@touryou/core";

import { afterEach, describe, expect, it } from "vitest";
import { parseSse, startNodeSubscriber } from "../src/node-subscriber.js";
import {
  framesOf,
  notificationText,
  socketFromEnv,
  writeNotification,
} from "../src/notify-socket.js";

const fail = (code: string, cause: string, next: string) =>
  ({ ok: false, error: failure(code, cause, next) }) as const;

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const listen = async (): Promise<{ path: string; received: () => string }> => {
  const dir = mkdtempSync(join(tmpdir(), "touryou-notify-"));
  dirs.push(dir);
  const path = join(dir, "s.sock");
  let buf = "";
  const server = createServer((c) => {
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  return { path, received: () => buf };
};
const until = async (f: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("notify-socket", () => {
  it("auth の行と本文 1 行を書く。本文の改行は空白にする", async () => {
    const s = await listen();
    const r = await writeNotification({ path: s.path, token: "tk" }, notificationText(12));
    expect(r).toEqual({ written: true });
    await until(() => s.received().endsWith("\n") && s.received().split("\n").length === 3);
    const [auth, body] = s.received().split("\n");
    expect(JSON.parse(auth ?? "")).toEqual({ type: "auth", token: "tk" });
    expect(JSON.parse(body ?? "")).toEqual({
      type: "user",
      message: {
        role: "user",
        content: "touryou の受信箱（inbox_fetch）を読んで、書かれた手順に従って（番号 12）",
      },
    });
    expect(JSON.parse(framesOf("a\nb"))).toEqual({
      type: "user",
      message: { role: "user", content: "a b" },
    });
  });

  it("ソケットがなければ書かない（noSocket）。環境変数がなければ undefined", async () => {
    expect(socketFromEnv({})).toBeUndefined();
    expect(socketFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: "/x" })).toEqual({ path: "/x" });
    expect(await writeNotification(undefined, "x")).toEqual({ written: false, reason: "noSocket" });
    expect(await writeNotification({ path: "/nonexistent/s.sock" }, "x")).toEqual({
      written: false,
      reason: "noSocket",
    });
  });
});

describe("parseSse", () => {
  it("メッセージに分け、途中の残りを返す。コメント行は捨てる", () => {
    const p = parseSse(': hb\n\nid: 3\nevent: node\ndata: {"seq":3}\n\nid: 4\nev');
    expect(p.messages).toEqual([
      { event: "message", data: "" },
      { event: "node", id: "3", data: '{"seq":3}' },
    ]);
    expect(p.rest).toBe("id: 4\nev");
  });
});

/** 偽の daemon: 接続ごとに、渡した SSE の文字列を流して閉じる。要求の URL を残す。 */
const fakeFetch = (streams: string[]) => {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    const body = streams.shift();
    if (body === undefined) return new Response(null, { status: 503 });
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(body));
          c.close();
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { f, urls };
};
const ev = (seq: number) =>
  `id: ${seq}\nevent: node\ndata: {"seq":${seq},"kind":"instruction"}\n\n`;

describe("startNodeSubscriber", () => {
  it("最初は after なしで購読し、切れたら最後の seq の続きから取り直す。重複は捨て、まとめて 1 行だけ知らせる", async () => {
    const { f, urls } = fakeFetch([
      `retry: 3000\nevent: ready\ndata: {"from":4}\n\n${ev(5)}${ev(6)}`,
      `event: ready\ndata: {}\n\n${ev(6)}${ev(9)}`,
    ]);
    const notified: number[] = [];
    const sub = startNodeSubscriber({
      fetch: f,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
      coalesceMs: 5,
      target: async () => ok({ daemonUrl: "http://127.0.0.1:1", token: "t", nodeId: "a" }),
      verify: async () => true,
      notify: async (seq) => {
        notified.push(seq);
        return { written: true };
      },
    });
    await until(() => urls.length >= 3);
    sub.stop();
    await sub.done;
    expect(urls[0]).toBe("http://127.0.0.1:1/v1/events?node=a");
    expect(urls[1]).toBe("http://127.0.0.1:1/v1/events?node=a&after=6");
    expect(urls[2]).toBe("http://127.0.0.1:1/v1/events?node=a&after=9");
    expect(sub.lastSeq).toBe(9);
    // 6 は 2 回来たが、1 回だけ数える。知らせは、まとめた最大の seq（番号）
    expect(notified.at(-1)).toBe(9);
    expect(notified.every((n, i) => i === 0 || n > (notified[i - 1] ?? 0))).toBe(true);
  });

  it("最初の接続の ready の起点から続ける（出来事なしで切れても、再接続で落とさない）", async () => {
    const { f, urls } = fakeFetch([
      'event: ready\ndata: {"from":4}\n\n',
      `event: ready\ndata: {"from":9}\n\n${ev(5)}`,
    ]);
    const notified: number[] = [];
    const sub = startNodeSubscriber({
      fetch: f,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
      coalesceMs: 5,
      target: async () => ok({ daemonUrl: "http://127.0.0.1:1", token: "t", nodeId: "a" }),
      verify: async () => true,
      notify: async (seq) => {
        notified.push(seq);
        return { written: true };
      },
    });
    await until(() => urls.length >= 3 && notified.length > 0);
    sub.stop();
    await sub.done;
    expect(urls[1]).toBe("http://127.0.0.1:1/v1/events?node=a&after=4");
    expect(notified).toEqual([5]);
  });

  it("身元を確かめられなければ、トークンを送らない", async () => {
    const { f, urls } = fakeFetch([ev(1)]);
    let calls = 0;
    const sub = startNodeSubscriber({
      fetch: f,
      sleep: async () => {
        calls += 1;
        if (calls > 2) sub.stop();
      },
      target: async () => ok({ daemonUrl: "http://127.0.0.1:1", token: "t", nodeId: "a" }),
      verify: async () => false,
      notify: async () => ({ written: true }),
    });
    await sub.done;
    expect(urls).toEqual([]);
  });
});

describe("startNotifications（子。資格情報の入れ物に従う）", () => {
  it("入れ物が空の間は何も送らない。入ったら購読を始め、空になったら止める。根のトークンは読まない", async () => {
    const { startNotifications } = await import("../src/stdio.js");
    const { createNodeCredentialStore } = await import("../src/node-credential.js");
    const s = await listen();
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;
    const store = createNodeCredentialStore();
    const errs: string[] = [];
    const sub = startNotifications(
      [],
      { CLAUDE_CODE_MESSAGING_SOCKET: s.path },
      { stderr: (t: string) => errs.push(t) } as never,
      {
        fetch: f,
        sleep: () => new Promise((r) => setTimeout(r, 5)),
        files: {
          read: () => {
            throw new Error("根のトークンを読んではいけない");
          },
        },
      },
      {
        credentials: store,
        endpoint: () => ok({ daemonUrl: "http://127.0.0.1:1", identityPath: "/nonexistent" }),
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
    expect(errs.join("")).toContain("subscribeWaitingForBind");
    store.set({ nodeId: "a", token: "child-token-child-token-1234" });
    await until(() => errs.join("").includes("subscribeIdentityFailed"));
    store.clear();
    const n = errs.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(errs.slice(n).join("")).not.toContain("subscribeIdentityFailed");
    sub?.stop();
  });
});

describe("購読の、身元の確かめ・張り直し・知らせ直し", () => {
  it("身元を確かめられなければ、whoami も購読も、fetch を 1 回も呼ばない（根の道）", async () => {
    const { startNotifications } = await import("../src/stdio.js");
    const s = await listen();
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;
    const errs: string[] = [];
    let sleeps = 0;
    // 根の道: 置き場の解決を偽装する（トークンを読むだけ）。身元のファイルは読めない＝確かめは失敗。
    const sub = startNotifications(
      [],
      { CLAUDE_CODE_MESSAGING_SOCKET: s.path, HOME: "/h" },
      { stderr: (t: string) => errs.push(t) } as never,
      {
        fetch: f,
        sleep: async () => {
          sleeps += 1;
          await new Promise((r) => setTimeout(r, 1));
        },
        files: {
          checkDir: () => undefined,
          modeString: (p: string) => (p.endsWith("root-token") ? "-rw-------" : "drwx------"),
          read: (p: string) => {
            if (p.endsWith("config.json")) return JSON.stringify({ stateDir: "/h/.touryou/state" });
            if (p.endsWith("port")) return "45000";
            if (p.endsWith("root-token")) return "root-token-root-token-1234567890";
            throw new Error("no");
          },
        },
      },
    );
    await until(() => sleeps >= 2);
    sub?.stop();
    // 身元の確かめは daemon-identity のファイルを読んでから /v1/identity を呼ぶ。ファイルが読めないので、トークンつきの要求は 0 回。
    expect(calls.filter((u) => u.includes("/v1/whoami") || u.includes("/v1/events"))).toEqual([]);
  });

  it("ready だけ受けてすぐ切る daemon には、待ちを延ばしながら張り直す（詰めない）", async () => {
    const streams = Array.from({ length: 6 }, () => 'event: ready\ndata: {"from":1}\n\n');
    const { f } = fakeFetch(streams);
    const waits: number[] = [];
    const sub = startNodeSubscriber({
      fetch: f,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length >= 5) sub.stop();
        await new Promise((r) => setTimeout(r, 1));
      },
      nowMs: () => 0,
      target: async () => ok({ daemonUrl: "http://127.0.0.1:1", token: "t", nodeId: "a" }),
      verify: async () => true,
      notify: async () => ({ written: true }),
    });
    await sub.done;
    expect(waits.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("知らせを書けなかった番号は捨てず、次の出来事のときにまとめて知らせ直す。書けないことの記録は続く間 1 回", async () => {
    const { f } = fakeFetch([`${ev(3)}`, `${ev(4)}`]);
    const tried: number[] = [];
    const logs: string[] = [];
    const sub = startNodeSubscriber({
      fetch: f,
      sleep: () => new Promise((r) => setTimeout(r, 20)),
      coalesceMs: 1,
      log: (e) => logs.push(String(e.event)),
      target: async () => ok({ daemonUrl: "http://127.0.0.1:1", token: "t", nodeId: "a" }),
      verify: async () => true,
      notify: async (seq) => {
        tried.push(seq);
        return { written: false, reason: "noSocket" };
      },
    });
    await until(() => tried.length >= 2);
    sub.stop();
    await sub.done;
    expect(tried.slice(0, 2)).toEqual([3, 4]);
    expect(logs.filter((l) => l === "notifyUnavailable")).toHaveLength(1);
  });
});

describe("張り直したときの、書けなかった知らせと続きの番号", () => {
  it("書けなかった知らせは、次の出来事が来なくても、張り直したときに書き直す", async () => {
    const { f, urls } = fakeFetch([ev(3), 'event: ready\ndata: {"from":3}\n\n']);
    const tried: number[] = [];
    const sub = startNodeSubscriber({
      fetch: f,
      sleep: () => new Promise((r) => setTimeout(r, 20)),
      coalesceMs: 1,
      target: async () => ok({ daemonUrl: "http://127.0.0.1:1", token: "t", nodeId: "a" }),
      verify: async () => true,
      notify: async (seq) => {
        tried.push(seq);
        return { written: tried.length > 1 };
      },
    });
    await until(() => tried.length >= 2 && urls.length >= 2);
    sub.stop();
    await sub.done;
    expect(tried.slice(0, 2)).toEqual([3, 3]);
  });

  it("initialSeq（同じノードの前の購読の続き）があれば、最初の接続から after を付ける", async () => {
    const { f, urls } = fakeFetch([]);
    const sub = startNodeSubscriber({
      fetch: f,
      initialSeq: 7,
      sleep: async () => {
        sub.stop();
      },
      target: async () => ok({ daemonUrl: "http://127.0.0.1:1", token: "t", nodeId: "a" }),
      verify: async () => true,
      notify: async () => ({ written: true }),
    });
    await sub.done;
    expect(urls[0]).toBe("http://127.0.0.1:1/v1/events?node=a&after=7");
  });
});

describe("子は子の資格情報だけで、自分のノードを購読する", async () => {
  const { writeFileSync, chmodSync } = await import("node:fs");
  const { proofOf } = await import("../src/identity.js");
  const { startNotifications } = await import("../src/stdio.js");
  const { createNodeCredentialStore } = await import("../src/node-credential.js");
  const identity = { daemonId: "a".repeat(32), secret: "b".repeat(64) };

  const rigOf = async (whoamiNode: (token: string) => string) => {
    const dir = mkdtempSync(join(tmpdir(), "touryou-id-"));
    dirs.push(dir);
    const identityPath = join(dir, "daemon-identity");
    writeFileSync(identityPath, JSON.stringify({ version: 1, ...identity }));
    chmodSync(identityPath, 0o600);
    const s = await listen();
    const seen: { path: string; auth: string | null }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      const auth = new Headers(init?.headers).get("authorization");
      seen.push({ path: u.pathname, auth });
      if (u.pathname === "/v1/identity") {
        const proof = proofOf(identity, "127.0.0.1:45001", u.searchParams.get("nonce") ?? "");
        return Response.json({ ok: true, value: { daemonId: identity.daemonId, proof } });
      }
      if (u.pathname === "/v1/whoami") {
        return Response.json({
          ok: true,
          value: { role: "child", nodeId: whoamiNode(auth ?? "") },
        });
      }
      return new Response('event: ready\ndata: {"from":1}\n\n', { status: 200 });
    }) as unknown as typeof fetch;
    const store = createNodeCredentialStore();
    const sub = startNotifications(
      [],
      { CLAUDE_CODE_MESSAGING_SOCKET: s.path },
      { stderr: () => {} } as never,
      {
        fetch: f,
        sleep: () => new Promise((r) => setTimeout(r, 5)),
        files: {
          read: () => {
            throw new Error("根のトークンを読んではいけない");
          },
        },
      },
      {
        credentials: store,
        endpoint: () => ok({ daemonUrl: "http://127.0.0.1:45001", identityPath }),
      },
    );
    return { seen, store, sub };
  };

  it("紐付け待ちは購読しない。紐付けたら子のトークンで購読し、clear で止まる", async () => {
    const r = await rigOf(() => "a");
    await new Promise((x) => setTimeout(x, 30));
    expect(r.seen).toEqual([]);
    r.store.set({ nodeId: "a", token: "child-token-child-token-1234" });
    await until(() => r.seen.some((x) => x.path === "/v1/events"));
    const tokened = r.seen.filter((x) => x.auth !== null);
    expect(tokened.every((x) => x.auth === "Bearer child-token-child-token-1234")).toBe(true);
    // 身元の確かめ（トークンなし）が、トークンつきの要求より先
    expect(r.seen[0]?.path).toBe("/v1/identity");
    r.store.clear();
    await new Promise((x) => setTimeout(x, 30));
    const n = r.seen.length;
    await new Promise((x) => setTimeout(x, 50));
    expect(r.seen.length).toBe(n);
    r.sub?.stop();
  });

  it("whoami のノードが資格情報のノードと違えば、購読しない", async () => {
    const r = await rigOf(() => "root");
    r.store.set({ nodeId: "a", token: "child-token-child-token-1234" });
    await until(() => r.seen.some((x) => x.path === "/v1/whoami"));
    await new Promise((x) => setTimeout(x, 30));
    expect(r.seen.some((x) => x.path === "/v1/events")).toBe(false);
    r.sub?.stop();
  });
});

describe("購読の 401 で止まる（張り直しの詰まり）", () => {
  const base = {
    target: async () => ok({ daemonUrl: "http://127.0.0.1:1", token: "t", nodeId: "a" }),
    verify: async () => true,
    notify: async () => ({ written: true }) as const,
  };
  it("whoami が unauthenticated なら、張り直さない。記録は 1 回、onAuthFailed も 1 回", async () => {
    let tries = 0;
    let authFailed = 0;
    const logs: Record<string, unknown>[] = [];
    const sub = startNodeSubscriber({
      ...base,
      fetch: (async () => {
        throw new Error("購読まで行かない");
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      resolveNode: async () => {
        tries += 1;
        return fail("unauthenticated", "x", "y");
      },
      onAuthFailed: () => {
        authFailed += 1;
      },
      log: (e) => logs.push(e),
    });
    await sub.done;
    expect(tries).toBe(1);
    expect(authFailed).toBe(1);
    expect(logs.filter((e) => e.event === "subscribeAuthStopped")).toHaveLength(1);
    expect(logs.some((e) => e.event === "subscribeNodeUnknown")).toBe(false);
  });
  it("購読の要求が 401 なら、張り直さない", async () => {
    let urls = 0;
    const sub = startNodeSubscriber({
      ...base,
      fetch: (async () => {
        urls += 1;
        return new Response("", { status: 401 });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    await sub.done;
    expect(urls).toBe(1);
  });
  it("退役で購読を切られたあと: 張り直しの 1 回目が 401 なら、それ以上は張り直さない。onAuthFailed・記録は 1 回だけ（#7）", async () => {
    let urls = 0;
    let authFailed = 0;
    let sleeps = 0;
    const logs: Record<string, unknown>[] = [];
    const sub = startNodeSubscriber({
      ...base,
      healthyAfterMs: 0,
      fetch: (async () => {
        urls += 1;
        // 1 回目: つながってから daemon が切る（heartbeat で失効を見つけた）。2 回目以降: 401
        return urls === 1
          ? new Response('event: ready\ndata: {"from":1}\n\n', { status: 200 })
          : new Response("", { status: 401 });
      }) as unknown as typeof fetch,
      sleep: async () => {
        sleeps += 1;
        if (sleeps > 5) sub.stop(); // 止まらない不具合のときに、試験が終わるように
      },
      onAuthFailed: () => {
        authFailed += 1;
      },
      log: (e) => logs.push(e),
    });
    await sub.done;
    expect(urls).toBe(2);
    expect(sleeps).toBe(1);
    expect(authFailed).toBe(1);
    expect(logs.filter((e) => e.event === "subscribeAuthStopped")).toHaveLength(1);
  });
  it("つながらない（fetch が投げる・daemon_unreachable）ときは、張り直す", async () => {
    let urls = 0;
    let resolves = 0;
    let authFailed = 0;
    const sub = startNodeSubscriber({
      ...base,
      fetch: (async () => {
        urls += 1;
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      sleep: async () => {
        if (urls >= 3) sub.stop();
      },
      resolveNode: async () => {
        resolves += 1;
        return resolves === 1 ? fail("daemon_unreachable", "x", "y") : ok("a");
      },
      onAuthFailed: () => {
        authFailed += 1;
      },
    });
    await sub.done;
    expect(urls).toBeGreaterThanOrEqual(3);
    expect(authFailed).toBe(0);
  });
  it("authRetryMs を渡すと（根）、401 でも止めずに長く待って張り直す。記録は窓ごとに 1 回。通ったら戻る", async () => {
    let tries = 0;
    let authFailed = 0;
    let clock = 0;
    const waits: number[] = [];
    const logs: Record<string, unknown>[] = [];
    const sub = startNodeSubscriber({
      ...base,
      nowMs: () => clock,
      healthyAfterMs: 0,
      fetch: (async () =>
        new Response('event: ready\ndata: {"from":1}\n\n', {
          status: 200,
        })) as unknown as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
        if (tries >= 5) sub.stop();
      },
      resolveNode: async () => {
        tries += 1;
        return tries <= 4 ? fail("unauthenticated", "x", "y") : ok("a");
      },
      onAuthFailed: () => {
        authFailed += 1;
      },
      authRetryMs: 60_000,
      log: (e) => logs.push(e),
    });
    await sub.done;
    expect(waits.slice(0, 4)).toEqual([60_000, 60_000, 60_000, 60_000]);
    expect(authFailed).toBe(0);
    expect(logs.filter((e) => e.event === "subscribeAuthFailed")).toHaveLength(1);
    expect(logs.some((e) => e.event === "subscribed")).toBe(true);
    expect(logs.some((e) => e.event === "subscribeAuthRecovered")).toBe(true);
  });
});
