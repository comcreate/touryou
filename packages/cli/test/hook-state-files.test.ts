/**
 * `touryou hook`（トークンのない形）が読む設定（TOURYOU_DAEMON_CONFIG、または cwd から上の `.touryou/config.json`）と `<stateDir>/port` の確かめ。
 * daemon の port-file.ts と同じ確かめ（リンクでない・持ち主・権限・ACL）をする。確かめに失敗したら、印のある作業ツリーでは
 * PreToolUse を拒み（fail-closed）、印のないところでは黙って通す。
 * macOS では `chmod +a` の終了コードを確かめてから、本物の ACL で確かめる。Linux では本物の ACL の試験はスキップする。
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "../src/hook.js";

const isMac = process.platform === "darwin";
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 本物の $HOME/.touryou/{config.json,state/port} と、印のある作業ツリー・印のない作業ツリー。 */
const setup = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-hook-state-")));
  made.push(base);
  const home = join(base, "home");
  const state = join(home, ".touryou", "state");
  mkdirSync(state, { recursive: true });
  const config = join(home, ".touryou", "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state }), { mode: 0o600 });
  const port = join(state, "port");
  writeFileSync(port, "4567\n", { mode: 0o600 });
  const gitA = join(base, "repo", ".git", "worktrees", "a");
  mkdirSync(gitA, { recursive: true });
  writeFileSync(join(gitA, "touryou-child"), "node-a\n");
  const marked = join(base, "wt", "a");
  mkdirSync(marked, { recursive: true });
  writeFileSync(join(marked, ".git"), `gitdir: ${gitA}\n`);
  const plain = join(base, "plain");
  mkdirSync(plain);
  return { home, config, port, marked, plain };
};
const pre = (cwd: string) =>
  JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd, tool_name: "Bash" });
const recorder = () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ok: true, value: { decision: "allow" } }), {
      status: 200,
    });
  };
  return { urls, fetchImpl };
};

describe("touryou hook の設定・port の確かめ", () => {
  it("確かめが通れば、port の窓口へ送る", async () => {
    const x = setup();
    const f = recorder();
    const r = await runHook({
      env: { TOURYOU_DAEMON_CONFIG: x.config },
      input: pre(x.marked),
      fetchImpl: f.fetchImpl,
    });
    expect(r.code).toBe(0);
    expect(f.urls).toEqual(["http://127.0.0.1:4567/v1/hook"]);
  });

  it("設定は cwd から上へ探す: 深い場所・子の作業ツリー（<根>/.touryou/worktrees/<子>）からも、根の設定の port へ送る", async () => {
    const x = setup();
    const repo = join(dirname(x.home), "proj");
    const state = join(repo, ".touryou", "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(repo, ".touryou", "config.json"), JSON.stringify({ stateDir: state }), {
      mode: 0o600,
    });
    writeFileSync(join(state, "port"), "5678\n", { mode: 0o600 });
    const deep = join(repo, "src", "a");
    const childTree = join(repo, ".touryou", "worktrees", "c1", "src");
    mkdirSync(deep, { recursive: true });
    mkdirSync(childTree, { recursive: true });
    for (const cwd of [deep, childTree]) {
      const f = recorder();
      const r = await runHook({ env: {}, input: pre(cwd), fetchImpl: f.fetchImpl });
      expect(r.code, cwd).toBe(0);
      expect(f.urls, cwd).toEqual(["http://127.0.0.1:5678/v1/hook"]);
    }
  });

  it("設定が見つからない: touryou を使っていないフォルダでは何もしない。印のある子の作業ツリーでは拒む（守りを外さない）。旧パス $HOME/.touryou へは戻らない", async () => {
    const x = setup();
    // x.home の .touryou/config.json はあるが、plain・marked の上にはない（HOME に置いても、見に行かない）
    const f = recorder();
    const silent = await runHook({
      env: { HOME: x.home },
      input: pre(x.plain),
      fetchImpl: f.fetchImpl,
    });
    expect(silent).toEqual({ code: 0, stderr: "" });
    const denied = await runHook({
      env: { HOME: x.home },
      input: pre(x.marked),
      fetchImpl: f.fetchImpl,
    });
    expect(denied.code).toBe(2);
    expect(denied.stderr).toContain("touryou の子の作業ツリー");
    expect(f.urls).toEqual([]);
  });

  const breakers: [string, (x: ReturnType<typeof setup>) => void][] = [
    ["port を他の人が書ける", (x) => chmodSync(x.port, 0o666)],
    ["port を他の人が読める", (x) => chmodSync(x.port, 0o644)],
    [
      "port がリンク",
      (x) => {
        const other = `${x.port}.real`;
        writeFileSync(other, "9999\n", { mode: 0o600 });
        rmSync(x.port);
        symlinkSync(other, x.port);
      },
    ],
    ["config.json を他の人が書ける", (x) => chmodSync(x.config, 0o666)],
    [
      "config.json がリンク",
      (x) => {
        const other = `${x.config}.real`;
        writeFileSync(other, JSON.stringify({ stateDir: "/elsewhere" }), { mode: 0o600 });
        rmSync(x.config);
        symlinkSync(other, x.config);
      },
    ],
  ];
  for (const [name, brk] of breakers) {
    it(`${name}: 印のある作業ツリーでは拒み（送らない）、印のないところでは黙って通す`, async () => {
      const x = setup();
      brk(x);
      const f = recorder();
      const denied = await runHook({
        env: { TOURYOU_DAEMON_CONFIG: x.config },
        input: pre(x.marked),
        fetchImpl: f.fetchImpl,
      });
      expect(denied.code).toBe(2);
      expect(denied.stderr).toContain("touryou の子の作業ツリー");
      const silent = await runHook({
        env: { TOURYOU_DAEMON_CONFIG: x.config },
        input: pre(x.plain),
        fetchImpl: f.fetchImpl,
      });
      expect(silent).toEqual({ code: 0, stderr: "" });
      expect(f.urls).toEqual([]);
    });
  }

  it("ACL を確かめられない（分からない）ときも、同じく拒む・黙って通す", async () => {
    for (const target of ["config", "port"] as const) {
      const x = setup();
      const acl = (p: string) => (p === x[target] ? "ACL を確かめられない（差し替え）" : undefined);
      const f = recorder();
      const denied = await runHook({
        env: { TOURYOU_DAEMON_CONFIG: x.config },
        input: pre(x.marked),
        fetchImpl: f.fetchImpl,
        acl,
      });
      expect(denied.code, target).toBe(2);
      const silent = await runHook({
        env: { TOURYOU_DAEMON_CONFIG: x.config },
        input: pre(x.plain),
        fetchImpl: f.fetchImpl,
        acl,
      });
      expect(silent, target).toEqual({ code: 0, stderr: "" });
      expect(f.urls, target).toEqual([]);
    }
  });

  it.runIf(isMac)(
    "macOS: ACL の付いた port・config.json は拒む（chmod +a の終了コードを確かめる）",
    async () => {
      for (const target of ["config", "port"] as const) {
        const x = setup();
        const r = spawnSync("chmod", ["+a", "everyone allow read", x[target]], {
          encoding: "utf8",
        });
        expect(r.status, r.stderr).toBe(0);
        const f = recorder();
        expect(
          (
            await runHook({
              env: { TOURYOU_DAEMON_CONFIG: x.config },
              input: pre(x.marked),
              fetchImpl: f.fetchImpl,
            })
          ).code,
        ).toBe(2);
        expect(f.urls).toEqual([]);
      }
    },
  );
});
