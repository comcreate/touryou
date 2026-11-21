import { type EventBody, foldEvents, type OrchEvent, type OrchState, ok } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createBindCodes } from "../../src/api/bind.js";
import { createCredentialStore } from "../../src/api/credentials.js";
import { createBindWorktreeCheck } from "../../src/api/handlers/cli-bind-check.js";
import { type ApiLogEvent, type ApiServer, createApiServer } from "../../src/api/server.js";

// attach で mcp が入れ替わった CLI の子の、コードなしのつなぎ直し（#145）。
let n = 0;
const ev = (body: EventBody): OrchEvent =>
  ({
    seq: ++n,
    at: "2026-11-11T00:00:00Z",
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
    ev({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

const TREES: Record<string, string> = { a: "/w/trees/a" };
let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** `recorded`: 記録にある node → session_id（コードでの紐付けで作られる）。`cli: false` は Desktop の木（rebindOk なし）。 */
const rig = async (opts: { cli?: boolean } = {}) => {
  const cli = opts.cli ?? true;
  let now = 1_000_000;
  const credentials = createCredentialStore({
    humanToken: "human-token-human-token-human-token-1234",
    clock: () => new Date(now).toISOString(),
    nowMs: () => now,
    monoMs: () => now,
  });
  const bind = createBindCodes({ clock: () => now });
  const recorded = new Map<string, string>();
  const logs: ApiLogEvent[] = [];
  let invalid = 0;
  let bound = 0;
  server = createApiServer({
    credentials,
    bind,
    ...(cli
      ? {
          bindWorktreeOk: createBindWorktreeCheck({
            cwdOf: async (id) => TREES[id],
            realpath: (p) => p,
            gitIsFile: (t) => t.startsWith("/w/trees/"),
          }),
          rebindOk: (nodeId: string, sessionId: string) => recorded.get(nodeId) === sessionId,
        }
      : {}),
    onBindSucceeded: (nodeId, info) => {
      bound++;
      if (info.sessionId !== undefined) recorded.set(nodeId, info.sessionId);
    },
    onBindInvalid: () => {
      invalid++;
    },
    logger: (e) => logs.push(e),
    getState: state,
    handlers: { "report.progress": () => ok({ accepted: true }) },
  });
  const { url } = await server.listen(0);
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json()) as {
        ok: boolean;
        value?: { token?: string };
        error?: { cause?: string };
      },
    };
  };
  /** コードでの紐付け（`sessionId` に undefined を渡すと、session_id なし）。 */
  const first = async (...sid: [sessionId?: string]) =>
    post("/v1/bind", {
      nodeId: "a",
      bindCode: bind.issue("a"),
      cwd: "/w/trees/a",
      ...(sid.length === 1 && sid[0] === undefined ? {} : { sessionId: sid[0] ?? "s-1" }),
    });
  const rebind = (body: Record<string, unknown> = {}) =>
    post("/v1/bind", { nodeId: "a", cwd: "/w/trees/a", sessionId: "s-1", ...body });
  const report = (token: string) =>
    post(
      "/v1/request",
      { requestId: `p${++n}`, operation: "report.progress", params: { text: "x" } },
      { authorization: `Bearer ${token}` },
    );
  return {
    credentials,
    first,
    rebind,
    report,
    post,
    logs,
    invalid: () => invalid,
    bound: () => bound,
    advance: (ms: number) => (now += ms),
  };
};

describe("つなぎ直し（POST /v1/bind。コードなし）", () => {
  it("コードで紐付けたあと、同じ session_id・作業ツリー・ノードなら、トークンを出し直し、報告できる。古いトークンは無効", async () => {
    const r = await rig();
    const old = (await r.first()).json.value?.token as string;
    const res = await r.rebind();
    expect(res.status).toBe(200);
    const token = res.json.value?.token as string;
    expect(token).not.toBe(old);
    expect((await r.report(token)).status).toBe(200);
    expect((await r.report(old)).status).toBe(401);
    expect(r.logs).toContainEqual(
      expect.objectContaining({ event: "bindSucceeded", route: "rebind" }),
    );
  });

  it("つなぎ直したあとも、もう一度つなぎ直せる（記録の session_id は変わらない）", async () => {
    const r = await rig();
    await r.first();
    expect((await r.rebind()).status).toBe(200);
    expect((await r.rebind()).status).toBe(200);
  });

  it("session_id が違う・作業ツリーが違う・cwd なし・session_id なしは断る（文はコードが無効なときと同じ）", async () => {
    const r = await rig();
    await r.first();
    const other = await r.rebind({ sessionId: "s-other" });
    expect(other.status).toBe(401);
    expect(other.json.error?.cause).toBe("bind コードが無効");
    // 作業ツリーの確認の文は、コードでの紐付けと同じ（既存）
    expect((await r.rebind({ cwd: "/home/x/repo" })).status).toBe(401);
    expect((await r.rebind({ cwd: undefined })).status).toBe(400);
    expect((await r.rebind({ sessionId: undefined })).status).toBe(400);
    // 失敗のあとも、正しい値ならつなぎ直せる
    expect((await r.rebind()).status).toBe(200);
  });

  it("コードでの紐付けの記録がない子（session_id を送らずに紐付けた）は、つなぎ直せない", async () => {
    const r = await rig();
    expect((await r.first(undefined)).status).toBe(200);
    expect((await r.rebind()).status).toBe(401);
  });

  it("紐付けのトークンがないとき（期限切れ・失効）は、つなぎ直せない。人がコードを出し直す", async () => {
    const r = await rig();
    await r.first();
    // bindIdleMs（既定 1 時間）を過ぎて、トークンが切れる
    r.advance(2 * 3_600_000);
    r.credentials.sweepExpired?.();
    expect((await r.rebind()).status).toBe(401);
    // 失効させた場合も同じ
    const r2 = await rig();
    await r2.first();
    r2.credentials.revokeNode("a");
    expect((await r2.rebind()).status).toBe(401);
  });

  it("期限が切れて、まだ掃除されていない紐付けのトークンでは、つなぎ直せない", async () => {
    const r = await rig();
    await r.first();
    r.advance(2 * 3_600_000); // sweepExpired は呼ばない
    expect((await r.rebind()).status).toBe(401);
  });

  it("つなぎ直しは、発行の時刻を引き継ぐ。24 時間の上限は延びない", async () => {
    const r = await rig();
    await r.first();
    // 1 時間未満の間隔でつなぎ直し続ける（アイドルでは切れない）
    let last = "";
    for (let i = 0; i < 30; i++) {
      r.advance(3_000_000);
      const res = await r.rebind();
      if (res.status !== 200) break;
      last = res.json.value?.token ?? "";
    }
    // 発行から 24 時間（bindAbsoluteMs）を過ぎたら、つなぎ直せない
    expect((await r.rebind()).status).toBe(401);
    expect(last).not.toBe("");
  });

  it("つなぎ直しは、紐付けの記録（onBindSucceeded）を作らない", async () => {
    const r = await rig();
    await r.first();
    expect(r.bound()).toBe(1);
    expect((await r.rebind()).status).toBe(200);
    expect(r.bound()).toBe(1);
  });

  it("木にないノードは断る", async () => {
    const r = await rig();
    await r.first();
    expect((await r.rebind({ nodeId: "zzz" })).status).toBe(401);
  });

  it("失敗は、失敗の数に数えるが、受信箱への「紐付けをやり直して」（onBindInvalid）は出さない", async () => {
    const r = await rig();
    await r.first();
    await r.rebind({ sessionId: "s-other" });
    expect(r.logs).toContainEqual(
      expect.objectContaining({ event: "bindFailed", reason: "rebindRejected" }),
    );
    expect(r.invalid()).toBe(0);
  });

  it("Desktop の木（rebindOk なし）は、コードなしの bind を必ず断る", async () => {
    const r = await rig({ cli: false });
    await r.post("/v1/bind", { nodeId: "a", bindCode: "0".repeat(26), sessionId: "s-1" });
    const res = await r.rebind();
    expect(res.status).toBe(400);
    expect(res.json.value).toBeUndefined();
  });
});
