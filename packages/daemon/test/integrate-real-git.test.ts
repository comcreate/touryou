/**
 * 統合（Issue #4）を実際の git で確かめる。既定は fast-forward だけで、できなければ何も変えずに理由を返す。
 * 統合のあと、回収（node.reclaim）が「未統合」で拒まれないこと（作る → 受理 → 統合 → 回収）も確かめる。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBody } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createReclaimHandlers } from "../src/api/handlers/reclaim-handlers.js";
import type { HandlerRequest } from "../src/api/server.js";
import { EventLog } from "../src/eventlog.js";
import { createGitPorts, nodeGit } from "../src/git-ports.js";
import { createMemoryStore } from "../src/memory-store.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

const setup = async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-integrate-")));
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  writeFileSync(join(repoRoot, "a.txt"), "a\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-q", "-m", "init");
  const made = createGitPorts(
    { repoRoot, worktreeRoot, rootCwd: repoRoot, rootNodeId: "root" },
    nodeGit,
  );
  if (!made.ok) throw new Error(made.error.cause);
  const ports = made.value;
  const opened = EventLog.open(createMemoryStore().open(), { clock: () => "2026-11-14T00:00:00Z" });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  let n = 0;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `s-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const st = (nodeId: string, type: "start" | "reportDone" | "accept") =>
    add({ type: "node.stateChanged", payload: { nodeId, event: { type } } });
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  st("root", "start");
  add({
    type: "node.created",
    payload: { nodeId: "c1", role: "implement", parentId: "root", dependsOn: [] },
  });
  st("c1", "start");
  const p = await ports.provisionWorktree({ parentId: "root", nodeId: "c1" });
  if (!p.ok) throw new Error(p.error.cause);
  const wt = p.value.worktreePath;
  writeFileSync(join(wt, "w.txt"), "w\n");
  git(wt, "add", "w.txt");
  git(wt, "commit", "-q", "-m", "work");
  const h = createReclaimHandlers({
    log,
    clock: () => "2026-11-14T00:00:00Z",
    ports: {
      factsFor: (id) => ports.factsFor(id),
      probe: async () => [],
      removeWorktree: (id, o) => ports.removeWorktree(id, o),
      integrate: (id) => ports.integrate(id),
      worktreeRoot,
    },
  });
  const call = async (operation: "node.integrate" | "node.reclaim", nodeId: string) =>
    (
      h[operation] as unknown as (r: unknown) => Promise<{
        ok: boolean;
        value?: Record<string, unknown>;
        error?: { code: string };
      }>
    )({
      requestId: `q-${++n}`,
      operation,
      role: "integrator",
      caller: { nodeId: "root" },
      params: { nodeId },
    } as unknown as HandlerRequest<typeof operation>);
  return { repoRoot, wt, log, st, call };
};

describe("統合（node.integrate。Issue #4）", () => {
  it("受理していない子は統合しない（notVerified）", async () => {
    const r = await setup();
    const res = await r.call("node.integrate", "c1");
    expect(res.error?.code).toBe("notVerified");
  });

  it("受理した子を fast-forward で統合し、そのあと回収できる。もう一度呼ぶと統合済み", async () => {
    const r = await setup();
    r.st("c1", "reportDone");
    r.st("c1", "accept");
    const tip = git(r.wt, "rev-parse", "HEAD");
    const res = await r.call("node.integrate", "c1");
    expect(res).toMatchObject({
      ok: true,
      value: { alreadyIntegrated: false, target: "main", tip },
    });
    // 根の作業ツリー（main をチェックアウト中）も進んでいる
    expect(git(r.repoRoot, "rev-parse", "HEAD")).toBe(tip);
    expect(git(r.repoRoot, "status", "--porcelain")).toBe("");
    expect(r.log.state().inbox.some((i) => i.summary?.includes("fast-forward で統合した"))).toBe(
      true,
    );
    const again = await r.call("node.integrate", "c1");
    expect(again).toMatchObject({ ok: true, value: { alreadyIntegrated: true } });
    const rec = await r.call("node.reclaim", "c1");
    expect(rec).toMatchObject({ ok: true, value: { reclaimed: ["c1"] } });
  });

  it("親のブランチが先に進んでいたら、何も変えずに notFastForward を返す", async () => {
    const r = await setup();
    r.st("c1", "reportDone");
    r.st("c1", "accept");
    writeFileSync(join(r.repoRoot, "b.txt"), "b\n");
    git(r.repoRoot, "add", "b.txt");
    git(r.repoRoot, "commit", "-q", "-m", "parent moved");
    const before = git(r.repoRoot, "rev-parse", "HEAD");
    const res = await r.call("node.integrate", "c1");
    expect(res.error?.code).toBe("notFastForward");
    expect(git(r.repoRoot, "rev-parse", "HEAD")).toBe(before);
  });

  it("親の作業ツリーに未保存の変更があれば、何も変えずに targetDirty を返す", async () => {
    const r = await setup();
    r.st("c1", "reportDone");
    r.st("c1", "accept");
    writeFileSync(join(r.repoRoot, "a.txt"), "変更\n");
    const before = git(r.repoRoot, "rev-parse", "HEAD");
    const res = await r.call("node.integrate", "c1");
    expect(res.error?.code).toBe("targetDirty");
    expect(git(r.repoRoot, "rev-parse", "HEAD")).toBe(before);
  });

  it("親のブランチがどこにもチェックアウトされていなければ、ref だけを進める", async () => {
    const r = await setup();
    r.st("c1", "reportDone");
    r.st("c1", "accept");
    git(r.repoRoot, "checkout", "-q", "--detach");
    const tip = git(r.wt, "rev-parse", "HEAD");
    const res = await r.call("node.integrate", "c1");
    expect(res).toMatchObject({ ok: true, value: { alreadyIntegrated: false, target: "main" } });
    expect(git(r.repoRoot, "rev-parse", "refs/heads/main")).toBe(tip);
  });
});
