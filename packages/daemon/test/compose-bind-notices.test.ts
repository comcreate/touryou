/**
 * 紐付けの期限の知らせの結線（#189）。daemon を組み立て、単調時計を進めて見回りを回し、
 * - 失効の前（前置き）に入ると、親の受信箱の info と、子への追加指示が 1 回ずつ記録される
 * - 子が結び直すのに成功する（トークンの発行ではなく、成功のあと）と、失効の知らせ・前置きの知らせが解決になる。失敗では解決にならない
 * - 使われて切れなくなる・失効する と、前置きの知らせが解決になる
 * - 前置きの知らせだけを読む child.inbox は、使わなければ切れる時計を延ばさない。そのあとの child.inbox・購読の接続・作業の呼び出しは延ばす
 * ことを確かめる。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Failure, ok, type Result } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type Daemon, type WorktreePorts } from "../src/compose.js";
import type { DaemonConfig } from "../src/config.js";
import { FakeCliAdapter } from "./sdk/fakes.js";

const MIN = 60_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const boot = async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-bind-wiring-")));
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  const config: DaemonConfig = {
    stateDir: join(base, "state"),
    repoRoot,
    worktreeRoot,
    rootCwd: repoRoot,
    rootNodeId: "root",
    rootScope: { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] },
    port: 0,
  };
  const worktree: WorktreePorts = {
    factsFor: async () => undefined,
    removeWorktree: async (): Promise<Result<undefined, Failure>> => ok(undefined),
    provisionWorktree: async ({ nodeId }) => {
      const p = join(worktreeRoot, nodeId);
      mkdirSync(p, { recursive: true });
      // 紐付けの確認は、追加の作業ツリー（`.git` がファイル）だけを通す
      writeFileSync(join(p, ".git"), "gitdir: /dev/null\n");
      return ok({ worktreePath: p });
    },
    cwdOf: async (nodeId) => join(worktreeRoot, nodeId),
  };
  let mono = 1_000_000;
  const launcher = new FakeCliAdapter();
  const made = createDaemon(config, {
    cliAdapter: launcher,
    worktree,
    probe: async () => [],
    logLine: () => undefined,
    monoMs: () => mono,
  });
  if (!made.ok) throw new Error(`${made.error.code}: ${made.error.cause}`);
  const daemon: Daemon = made.value;
  const run = await daemon.start();
  cleanups.push(() => daemon.stop());
  launcher.sink = {
    record: (q) => daemon.log.append(q),
    recordAll: (qs) => daemon.log.appendAll(qs),
  };
  const rootToken = readFileSync(run.rootTokenPath, "utf8").trim();
  const post = async (path: string, token: string | undefined, body: unknown) => {
    const res = await fetch(`${run.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
    // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
    return { status: res.status, json: (await res.json()) as any };
  };
  const request = (operation: string, params: unknown) =>
    post("/v1/request", rootToken, {
      requestId: `q-${Math.random()}`.replace(".", ""),
      operation,
      params,
    });
  /** bind コードを出し直させ、コードで紐付ける。子のトークンを返す。 */
  const bindAgain = async (nodeId: string): Promise<string> => {
    const code = await request("node.bindCode", { nodeId });
    expect(code.json.ok, JSON.stringify(code.json)).toBe(true);
    // コードは、子への案内の文（instruction）の中にだけある
    const bindCode = /bindCode: (\S+)/.exec(String(code.json.value.instruction))?.[1];
    const bound = await post("/v1/bind", undefined, {
      nodeId,
      bindCode,
      cwd: join(worktreeRoot, nodeId),
    });
    expect(bound.json.ok, `${JSON.stringify(bound.json)} / ${JSON.stringify(code.json)}`).toBe(
      true,
    );
    return bound.json.value.token;
  };
  /** 子を作り、bind コードで紐付ける。子のトークンを返す。 */
  const spawnAndBind = async (): Promise<{ nodeId: string; token: string }> => {
    const spawn = await request("node.spawn", {
      parentId: "root",
      role: "implement",
      objective: "直す",
      acceptanceCriteria: ["通る"],
      scope: { writableLocations: ["src/x"], forbiddenLocations: [".git"], allowedCommands: [] },
    });
    expect(spawn.json.ok, JSON.stringify(spawn.json)).toBe(true);
    const nodeId: string = spawn.json.value.nodeId;
    return { nodeId, token: await bindAgain(nodeId) };
  };
  const whoami = (token: string) =>
    fetch(`${run.url}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });
  /** 子のトークンで、操作を呼ぶ。 */
  const asChild = (token: string, operation: string, params: unknown) =>
    post("/v1/request", token, {
      requestId: `c-${Math.random()}`.replace(".", ""),
      operation,
      params,
    });
  /** 子のトークンで、ノードの購読（`/v1/events?node=`）を張って、すぐ閉じる（接続の確かめだけ）。 */
  const subscribe = async (token: string, nodeId: string): Promise<number> => {
    const ac = new AbortController();
    const res = await fetch(`${run.url}/v1/events?node=${nodeId}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    ac.abort();
    return res.status;
  };
  /** 誤った bind コードで紐付けを試みる（失敗する）。 */
  const bindWrong = (nodeId: string) =>
    post("/v1/bind", undefined, {
      nodeId,
      bindCode: "wrong-code-0000",
      cwd: join(worktreeRoot, nodeId),
    });
  return {
    daemon,
    request,
    spawnAndBind,
    bindAgain,
    bindWrong,
    whoami,
    asChild,
    subscribe,
    advance: (ms: number) => {
      mono += ms;
    },
  };
};

const noticesOf = (d: Daemon, nodeId: string, key: string) =>
  d.log.state().inbox.filter((i) => i.nodeId === nodeId && i.msg?.key === key);
const openOf = (d: Daemon, nodeId: string, key: string) =>
  noticesOf(d, nodeId, key).filter((i) => i.resolved === undefined);

describe("紐付けの期限の知らせの結線（#189）", () => {
  it("前置きに入ると、親の info と子への追加指示が 1 回ずつ。見回りを重ねても増えない", async () => {
    const r = await boot();
    const { nodeId } = await r.spawnAndBind();
    const instructed = () =>
      r.daemon.log.state().instructions.filter((i) => i.nodeId === nodeId).length;
    const before = instructed();
    r.advance(49 * MIN);
    r.daemon.sweepTokens();
    expect(noticesOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0);
    r.advance(2 * MIN); // 切れるまで 9 分
    r.daemon.sweepTokens();
    r.daemon.sweepTokens();
    expect(noticesOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    expect(instructed() - before).toBe(1);
  });

  it("使われて切れなくなったら、前置きの知らせが解決になる。切れたら、失効の知らせが出て、前置きは解決のまま", async () => {
    const r = await boot();
    const { nodeId, token } = await r.spawnAndBind();
    r.advance(52 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    // 使われる（認証が通る）: 時計が延びる。次の見回りで復帰と分かり、解決になる
    expect((await r.whoami(token)).status).toBe(200);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0);
    // もう一度止まり、切れる: 失効の知らせが出る
    r.advance(52 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    r.advance(10 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0);
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(1);
  });

  it("結び直すと、失効の知らせが解決になる", async () => {
    const r = await boot();
    const { nodeId } = await r.spawnAndBind();
    r.advance(61 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(1);
    await r.bindAgain(nodeId);
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(0);
    expect(noticesOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(1);
  });

  it("結び直しが失敗したときは、知らせを解決にしない（成功したときだけ解決にする）", async () => {
    const r = await boot();
    const { nodeId } = await r.spawnAndBind();
    r.advance(61 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(1);
    // 誤ったコードでの紐付けは失敗する。トークンは出ず、知らせはそのまま残る
    const failed = await r.bindWrong(nodeId);
    expect(failed.json.ok).toBe(false);
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(1);
    // 成功したときに、はじめて解決になる
    await r.bindAgain(nodeId);
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(0);
  });

  it("前置きの知らせだけを読む child.inbox（読み出し・受け取りの ack）は、使わなければ切れる時計を延ばさない", async () => {
    const r = await boot();
    const { nodeId, token } = await r.spawnAndBind();
    r.advance(52 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    // 前置きを読む（まだ受け取りにならないので、何度読んでも前置きだけ）。受け取りの ack を送っても、時計は延びない
    let seq = -1;
    for (let i = 0; i < 3; i++) {
      const inbox = await r.asChild(token, "child.inbox", {});
      expect(inbox.json.ok, JSON.stringify(inbox.json)).toBe(true);
      expect(inbox.json.value.instructions, JSON.stringify(inbox.json)).toHaveLength(1);
      seq = inbox.json.value.instructions[0].seq;
    }
    const acked = await r.asChild(token, "child.inbox", { ackThrough: seq });
    expect(acked.json.ok, JSON.stringify(acked.json)).toBe(true);
    r.daemon.sweepTokens();
    // 復帰とは扱われず（解決にならず）、前置きは残ったまま
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    // そのまま使われずに 60 分たてば、切れる（前置きを読んだだけでは、生き続けない）
    r.advance(9 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(1);
    expect((await r.whoami(token)).status).toBe(401);
  });

  it("案内文のとおり、前置きを読んだあとの inbox_fetch（child.inbox）は、時計を延ばす", async () => {
    const r = await boot();
    const { nodeId, token } = await r.spawnAndBind();
    r.advance(52 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    // 前置きを読んで、受け取りにする（ここまでは延びない）
    const first = await r.asChild(token, "child.inbox", {});
    expect(first.json.ok, JSON.stringify(first.json)).toBe(true);
    const seq: number = first.json.value.instructions[0].seq;
    expect((await r.asChild(token, "child.inbox", { ackThrough: seq })).json.ok).toBe(true);
    // 案内文のとおり、もう一度 inbox_fetch を呼ぶ（前置きはもうない）: 延びる
    const again = await r.asChild(token, "child.inbox", {});
    expect(again.json.ok, JSON.stringify(again.json)).toBe(true);
    expect(again.json.value.instructions).toHaveLength(0);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0); // 復帰して解決になる
    r.advance(9 * MIN); // 最初の idle の期限（60 分）を過ぎても、延びているので切れない
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(0);
    expect((await r.whoami(token)).status).toBe(200);
  });

  it("切れなくなって知らせが解決になったあとは、受け取っていない古い前置きを子に見せない（#198）", async () => {
    const r = await boot();
    const { nodeId, token } = await r.spawnAndBind();
    r.advance(52 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    // 前置きを読まないまま、作業の呼び出しで時計が延び、見回りで知らせが解決になる
    expect((await r.asChild(token, "report.progress", { text: "進めている" })).json.ok).toBe(true);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0);
    const inbox = await r.asChild(token, "child.inbox", {});
    expect(inbox.json.ok, JSON.stringify(inbox.json)).toBe(true);
    expect(inbox.json.value.instructions).toHaveLength(0);
  });

  it("ふつうの指示も一緒に読む child.inbox は、時計を延ばす（前置きだけのときだけが例外）", async () => {
    const r = await boot();
    const { nodeId, token } = await r.spawnAndBind();
    r.advance(52 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    const sent = await r.request("node.send", { nodeId, text: "ふつうの指示" });
    expect(sent.json.ok, JSON.stringify(sent.json)).toBe(true);
    const inbox = await r.asChild(token, "child.inbox", {});
    expect(inbox.json.value.instructions.length, JSON.stringify(inbox.json)).toBe(2);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0);
  });

  it("購読の接続は、時計を延ばす（購読して待つ生きた子が切れないように）", async () => {
    const r = await boot();
    const { nodeId, token } = await r.spawnAndBind();
    r.advance(52 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    expect(await r.subscribe(token, nodeId)).toBe(200);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0); // 復帰して解決になる
    r.advance(9 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(0);
    expect((await r.whoami(token)).status).toBe(200);
  });

  // #208: 報告のあとに道具を呼ばず待つ子（waiting・done）は、使わなければ切れる時計が止まるので、
  // bindIdle を超えても、切れる前の知らせも切れた知らせも出ない（仕様どおり。docs/plugin.md）
  it("判断待ち（waiting）の子は、bindIdle を超えても、切れる前・切れたの知らせが出ない", async () => {
    const r = await boot();
    const { nodeId, token } = await r.spawnAndBind();
    const asked = await r.asChild(token, "report.decision", { question: "どうする", options: ["a", "b"] });
    expect(asked.json.ok, JSON.stringify(asked.json)).toBe(true);
    expect(r.daemon.log.state().nodes.find((n) => n.id === nodeId)?.state).toBe("waiting");
    for (const m of [52, 10, 10]) {
      r.advance(m * MIN);
      r.daemon.sweepTokens();
    }
    expect(noticesOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0);
    expect(noticesOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(0);
    expect((await r.whoami(token)).status).toBe(200);
  });

  it("報告のあと待つ子（done）は、bindIdle を超えても、切れる前・切れたの知らせが出ない", async () => {
    const r = await boot();
    const { nodeId, token } = await r.spawnAndBind();
    const done = await r.asChild(token, "report.done", {
      evidence: [{ criterion: "通る", evidence: "通った" }],
    });
    expect(done.json.ok, JSON.stringify(done.json)).toBe(true);
    expect(r.daemon.log.state().nodes.find((n) => n.id === nodeId)?.state).toBe("done");
    for (const m of [52, 10, 10]) {
      r.advance(m * MIN);
      r.daemon.sweepTokens();
    }
    expect(noticesOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0);
    expect(noticesOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(0);
    expect((await r.whoami(token)).status).toBe(200);
  });

  it("実際の作業の呼び出し（report.progress）は、時計を延ばす", async () => {
    const r = await boot();
    const { nodeId, token } = await r.spawnAndBind();
    r.advance(52 * MIN);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(1);
    const progress = await r.asChild(token, "report.progress", { text: "進めている" });
    expect(progress.json.ok, JSON.stringify(progress.json)).toBe(true);
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenIdleSoonBind")).toHaveLength(0); // 復帰して解決になる
    r.advance(9 * MIN); // 最初の idle の期限（60 分）を過ぎても、延びているので切れない
    r.daemon.sweepTokens();
    expect(openOf(r.daemon, nodeId, "tokenExpiredIdleBind")).toHaveLength(0);
    expect((await r.whoami(token)).status).toBe(200);
  });
});
