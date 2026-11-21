import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Daemon } from "../src/compose.js";
import { loadWorktreePorts } from "../src/loaders.js";
import { main } from "../src/main.js";

const running: Daemon[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const d of running.splice(0)) await d.stop();
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

const setup = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-start-")));
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  writeFileSync(join(repoRoot, "a.txt"), "a\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-q", "-m", "init");
  const config = {
    stateDir: join(base, "state"),
    repoRoot,
    worktreeRoot,
    rootCwd: repoRoot,
    rootScope: {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    },
  };
  const path = join(base, "daemon.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { base, config, path };
};

describe("起動を、実物の git の口（loadWorktreePorts）を通して確かめる", () => {
  it("touryou-daemon の読み込みで git の口を得て起動する。CLI の子の spawn は、親への起動の依頼になり、コードは作業ツリーの git のディレクトリのファイルにだけある", async () => {
    const s = setup();
    const out: string[] = [];
    const err: string[] = [];
    const r = await main(["--config", s.path], {
      loadWorktreePorts, // 実物の git の口（./git-ports.js を読み込む）
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    expect(r.exitCode, err.join("")).toBe(0);
    if (r.daemon) running.push(r.daemon);
    const url = /(http:\/\/127\.0\.0\.1:\d+)/.exec(out.join(""))?.[1] as string;
    const rootToken = readFileSync(join(s.config.stateDir, "root-token"), "utf8").trim();
    const call = async (requestId: string, operation: string, params: unknown) => {
      const res = await fetch(`${url}/v1/request`, {
        method: "POST",
        headers: { authorization: `Bearer ${rootToken}`, "content-type": "application/json" },
        body: JSON.stringify({ requestId, operation, params }),
      });
      return (await res.json()) as {
        ok: boolean;
        value?: Record<string, unknown>;
        error?: { code: string };
      };
    };
    const spawned = await call("sp-real-1", "node.spawn", {
      parentId: "root",
      role: "implement",
      objective: "UI を直す",
      acceptanceCriteria: ["テストが通る"],
      scope: {
        writableLocations: ["src/ui"],
        forbiddenLocations: [".git"],
        allowedCommands: ["pnpm test"],
      },
    });
    expect(spawned.ok, JSON.stringify(spawned)).toBe(true);
    const nodeId = spawned.value?.nodeId as string;
    expect(spawned.value?.status).toBe("running");
    const wt = realpathSync(
      git(s.config.repoRoot, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length))
        .find((p) => p.startsWith(s.config.worktreeRoot)) as string,
    );
    const gitDir = git(wt, "rev-parse", "--absolute-git-dir");
    const codePath = join(gitDir, "touryou-bind-code");
    const st = lstatSync(codePath);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    // 1 行目がコード、2 行目が書いた daemon の公開 ID
    const [code = "", daemonLine = ""] = readFileSync(codePath, "utf8").trim().split("\n");
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(daemonLine).toMatch(/^daemon=[0-9a-f]{32}$/);
    // 依頼の中身: コードは入らない。作業ツリーと名前は入る
    // 組み立てで、plugin の場所の確かめが handler に渡る: 外の plugin は実パスで付き、作業ツリーの中は付かない
    const pluginBase = realpathSync(mkdtempSync(join(tmpdir(), "touryou-plugin-")));
    const plugin = join(pluginBase, "real");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), '{"name":"touryou"}');
    symlinkSync(plugin, join(pluginBase, "link"));
    const withPlugin = await call("pr-0", "parent.request", {
      nodeId,
      pluginRoot: join(pluginBase, "link"),
    });
    expect(withPlugin.ok, JSON.stringify(withPlugin)).toBe(true);
    expect(withPlugin.value?.command as string).toContain(` --plugin-dir ${plugin} `);
    const fake = join(wt, "fake-plugin");
    mkdirSync(join(fake, ".claude-plugin"), { recursive: true });
    writeFileSync(join(fake, ".claude-plugin", "plugin.json"), '{"name":"touryou"}');
    const inTree = await call("pr-00", "parent.request", { nodeId, pluginRoot: fake });
    expect(inTree.value?.command as string).not.toContain("--plugin-dir");
    const req = await call("pr-1", "parent.request", { nodeId, model: "opus", effort: "high" });
    expect(req.ok, JSON.stringify(req)).toBe(true);
    const command = req.value?.command as string;
    expect(command).toContain(`cd ${wt} && claude --bg`);
    expect(command).toContain("--model opus --effort high");
    expect(command).not.toContain(code);
    // 作業ツリーの一番上でない cwd の紐付けは断られ、コードは残る
    const bindAt = (cwd: string) =>
      fetch(`${url}/v1/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId, bindCode: code, cwd }),
      });
    expect((await bindAt(s.config.repoRoot)).status).toBe(401);
    expect(lstatSync(codePath).isFile()).toBe(true);
    // 正しい作業ツリーでは通り、daemon がファイルを消す
    expect((await bindAt(wt)).status).toBe(200);
    expect(existsSync(codePath)).toBe(false);
  });

  it("daemon の再起動のあと: 残ったファイルは起動時に消え、受信箱に「紐付けをやり直して」が出る。node.bindCode でファイルを書き直すと紐付けられる。ほかの子の作業ツリーの cwd は断られる", async () => {
    const s = setup();
    const boot = async () => {
      const out: string[] = [];
      const err: string[] = [];
      const r = await main(["--config", s.path], {
        loadWorktreePorts,
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
      });
      expect(r.exitCode, err.join("")).toBe(0);
      if (r.daemon) running.push(r.daemon);
      return {
        daemon: r.daemon as Daemon,
        url: /(http:\/\/127\.0\.0\.1:\d+)/.exec(out.join(""))?.[1] as string,
      };
    };
    const rootToken = () => readFileSync(join(s.config.stateDir, "root-token"), "utf8").trim();
    const call = async (url: string, requestId: string, operation: string, params: unknown) => {
      const res = await fetch(`${url}/v1/request`, {
        method: "POST",
        headers: { authorization: `Bearer ${rootToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ requestId, operation, params }),
      });
      return (await res.json()) as { ok: boolean; value?: Record<string, unknown> };
    };
    const spawn = async (url: string, requestId: string, objective: string) => {
      const r = await call(url, requestId, "node.spawn", {
        parentId: "root",
        role: "implement",
        objective,
        acceptanceCriteria: ["テストが通る"],
        scope: { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] },
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      return r.value?.nodeId as string;
    };
    const first = await boot();
    const a = await spawn(first.url, "sp-a", "A を直す");
    const b = await spawn(first.url, "sp-b", "B を直す");
    const trees = git(s.config.repoRoot, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((l) => l.startsWith("worktree ") && l.includes(s.config.worktreeRoot))
      .map((l) => realpathSync(l.slice("worktree ".length)));
    const wtOf = (id: string) =>
      trees.find(
        (t) =>
          readFileSync(
            join(git(t, "rev-parse", "--absolute-git-dir"), "touryou-child"),
            "utf8",
          ).trim() === id,
      ) as string;
    const codePath = (id: string) =>
      join(git(wtOf(id), "rev-parse", "--absolute-git-dir"), "touryou-bind-code");
    const codeA = readFileSync(codePath(a), "utf8").split("\n")[0]?.trim() ?? "";
    const bindAt = (url: string, code: string, cwd: string) =>
      fetch(`${url}/v1/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: a, bindCode: code, cwd }),
      });
    // ほかの子（b）の作業ツリーの cwd では断られる（コードは使われずに残る）
    expect((await bindAt(first.url, codeA, wtOf(b))).status).toBe(401);
    // 再起動
    await first.daemon.stop();
    running.splice(running.indexOf(first.daemon), 1);
    const second = await boot();
    // 起動時に、残ったコードのファイルは消える（メモリのコードは無効）。古いコードでは紐付けられない
    expect(existsSync(codePath(a))).toBe(false);
    expect((await bindAt(second.url, codeA, wtOf(a))).status).toBe(401);
    const inbox = await call(second.url, "ib-1", "inbox.fetch", {});
    const items = (inbox.value?.items ?? []) as {
      nodeId: string;
      kind: string;
      summary?: string;
    }[];
    expect(
      items.some(
        (i) =>
          i.nodeId === a &&
          i.kind === "failure" &&
          (i.summary ?? "").includes("紐付けをやり直して"),
      ),
    ).toBe(true);
    // 偽の「紐付けをやり直して」を絞る: 同じ子には 10 分に 1 件まで
    const rebindCount = async (id: string) => {
      const r = await call(second.url, `ib-${Math.random()}`, "inbox.fetch", {});
      return ((r.value?.items ?? []) as { nodeId: string; summary?: string }[]).filter(
        (i) => i.nodeId === id && (i.summary ?? "").includes("紐付けをやり直して"),
      ).length;
    };
    expect((await bindAt(second.url, "0123456789ABCDEFGHJKMNPQRS", wtOf(a))).status).toBe(401);
    expect(await rebindCount(a)).toBe(1);
    // 親が出し直す: ファイルが新しいコードに書き直され、応答にコードはない
    const re = await call(second.url, "bc-1", "node.bindCode", { nodeId: a });
    expect(re.ok, JSON.stringify(re)).toBe(true);
    const codeA2 = readFileSync(codePath(a), "utf8").split("\n")[0]?.trim() ?? "";
    expect(codeA2).not.toBe(codeA);
    expect(String(re.value?.instruction)).not.toContain(codeA2);
    expect((await bindAt(second.url, codeA2, wtOf(a))).status).toBe(200);
    expect(existsSync(codePath(a))).toBe(false);
    // 紐付けたあとは、でたらめなコードを送られても出さない（有効な紐付けのトークンがある）
    const before = await rebindCount(a);
    expect((await bindAt(second.url, "ZZZZZZZZZZZZZZZZZZZZZZZZZZ", wtOf(a))).status).toBe(401);
    expect(await rebindCount(a)).toBe(before);
  });

  it("git の口が失敗したら、notConfigured ではなく、原因つきの失敗で起動しない", async () => {
    const s = setup();
    // repoRoot をリンク経由にして、createGitPorts を失敗させる
    const link = join(s.base, "repo-link");
    symlinkSync(s.config.repoRoot, link);
    writeFileSync(s.path, JSON.stringify({ ...s.config, repoRoot: link, rootCwd: link }), {
      mode: 0o600,
    });
    const err: string[] = [];
    const r = await main(["--config", s.path], {
      loadWorktreePorts,
      stdout: () => undefined,
      stderr: (t) => err.push(t),
    });
    expect(r.exitCode).toBe(1);
    expect(err.join("")).toContain("invalidConfig");
    expect(err.join("")).not.toContain("notConfigured");
  });
});
