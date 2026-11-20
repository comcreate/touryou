/**
 * `GET /v1/whoami` の `daemon`（#164）: 統合ノードにだけ、daemon の場所（rootCwd・repoRoot）と daemonId を返す。
 * 子・人間には出さない。
 */
import { type EventBody, foldEvents, type OrchEvent, type OrchState } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { createIdentity } from "../../src/api/identity.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";

let n = 0;
const ev = (body: EventBody): OrchEvent =>
  ({
    seq: ++n,
    at: "2026-10-20T00:00:00Z",
    requestId: `r${n}`,
    actor: { system: true },
    ...body,
  }) as OrchEvent;
const state = (): OrchState => {
  const r = foldEvents([
    ev({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    ev({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
    }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

const HUMAN = "human-token-human-token-human-token-1234";
const DAEMON_INFO = { rootCwd: "/work/root", repoRoot: "/work/repo" } as const;

let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = async (withInfo: boolean) => {
  const credentials = createCredentialStore({ humanToken: HUMAN });
  const identity = createIdentity();
  const s = state();
  server = createApiServer({
    credentials,
    getState: () => s,
    handlers: {},
    identity: () => identity,
    ...(withInfo ? { daemonInfo: DAEMON_INFO } : {}),
  });
  const { url } = await server.listen(0);
  return {
    url,
    daemonId: identity.daemonId,
    tokens: {
      root: credentials.issueNodeToken("root", "integrator"),
      child: credentials.issueNodeToken("a", "child"),
      human: HUMAN,
    },
  };
};

const whoami = async (url: string, token: string) => {
  const res = await fetch(`${url}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });
  return {
    status: res.status,
    json: (await res.json()) as { ok: boolean; value: Record<string, unknown> },
  };
};

describe("whoami の daemon（#164）", () => {
  it("統合ノードには、rootCwd・repoRoot・daemonId が出る", async () => {
    const r = await start(true);
    const res = await whoami(r.url, r.tokens.root);
    expect(res.status).toBe(200);
    expect(res.json.value).toEqual({
      role: "integrator",
      nodeId: "root",
      daemon: { ...DAEMON_INFO, daemonId: r.daemonId },
    });
  });

  it("子には出ない", async () => {
    const r = await start(true);
    const res = await whoami(r.url, r.tokens.child);
    expect(res.status).toBe(200);
    expect(res.json.value).toEqual({ role: "child", nodeId: "a" });
    expect(res.json.value).not.toHaveProperty("daemon");
  });

  it("人間には出ない", async () => {
    const r = await start(true);
    const res = await whoami(r.url, r.tokens.human);
    expect(res.status).toBe(200);
    expect(res.json.value).toEqual({ role: "human" });
  });

  it("daemonInfo を渡さなければ、統合にも出ない", async () => {
    const r = await start(false);
    const res = await whoami(r.url, r.tokens.root);
    expect(res.json.value).toEqual({ role: "integrator", nodeId: "root" });
  });
});
