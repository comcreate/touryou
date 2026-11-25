import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, type Result } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import type { Relay } from "../src/relay.js";
import {
  createReloadingRelay,
  openStdioSession,
  resolveStdioTarget as resolveStdioTargetRaw,
  runStdio,
  type StdioTarget,
} from "../src/stdio.js";

/** この試験の置き場（`home()`）は、`<h>/.touryou/config.json`。cwd の既定は `h`（リポジトリの根の代わり）。 */
const resolveStdioTarget: typeof resolveStdioTargetRaw = (argv, env, deps = {}) =>
  resolveStdioTargetRaw(argv, env, { cwd: () => env.HOME ?? "/", ...deps });

const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const has = (cmd: string) => spawnSync(cmd, ["--version"]).error === undefined;
const isMac = process.platform === "darwin";

/** 本物のファイルで、$HOME/.touryou/{config.json,state/{root-token,port}} を作る。 */
function home(opts: { token?: string | null; port?: string | null; tokenMode?: number } = {}) {
  const h = mkdtempSync(join(tmpdir(), "touryou-stdio-"));
  made.push(h);
  const touryou = join(h, ".touryou");
  const state = join(touryou, "state");
  mkdirSync(state, { recursive: true });
  chmodSync(touryou, 0o700);
  chmodSync(state, 0o700);
  writeFileSync(
    join(touryou, "config.json"),
    JSON.stringify({ stateDir: state, mcpUrl: "http://127.0.0.1:7777/mcp" }),
    { mode: 0o600 },
  );
  if (opts.token !== null) {
    writeFileSync(join(state, "root-token"), `${opts.token ?? TOKEN}\n`, { mode: 0o600 });
    chmodSync(join(state, "root-token"), opts.tokenMode ?? 0o600);
  }
  if (opts.port !== null)
    writeFileSync(join(state, "port"), `${opts.port ?? "45678"}\n`, { mode: 0o600 });
  return { h, touryou, state };
}

describe("touryou-mcp --stdio の接続先とトークン", () => {
  it("$HOME/.touryou/config.json の stateDir から、root-token と port を読む（URL は port から作る）", () => {
    const { h, state } = home();
    expect(resolveStdioTarget([], { HOME: h })).toEqual({
      ok: true,
      value: {
        daemonUrl: "http://127.0.0.1:45678",
        token: TOKEN,
        identityPath: join(state, "daemon-identity"),
      },
    });
  });

  it("環境変数 TOURYOU_ROOT_TOKEN は使わない（ファイルがなければ、環境変数があっても失敗。あれば、ファイルを使う）", () => {
    const other = "ZYXWVUTSRQPONMLKJIHGFEDCBA987654";
    const none = home({ token: null });
    expect(resolveStdioTarget([], { HOME: none.h, TOURYOU_ROOT_TOKEN: other }).ok).toBe(false);
    const { h } = home();
    const r = resolveStdioTarget([], { HOME: h, TOURYOU_ROOT_TOKEN: other });
    expect(r.ok && r.value.token).toBe(TOKEN);
  });

  it("--config で設定ファイルを変えられる。未知の引数は拒否する", () => {
    const { h } = home();
    expect(
      resolveStdioTarget(["--config", join(h, ".touryou", "config.json")], { HOME: h }).ok,
    ).toBe(true);
    expect(resolveStdioTarget(["--port", "1"], { HOME: h }).ok).toBe(false);
  });

  it("root-token の権限が 0600 でない（0640・0644・0700）・リンク・ない、なら失敗（トークンの値は原因に出さない）", () => {
    for (const mode of [0o640, 0o644, 0o700]) {
      const x = home({ tokenMode: mode });
      const r = resolveStdioTarget([], { HOME: x.h });
      expect(r.ok, mode.toString(8)).toBe(false);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
    const link = home({ token: null });
    writeFileSync(join(link.h, "real"), TOKEN, { mode: 0o600 });
    symlinkSync(join(link.h, "real"), join(link.state, "root-token"));
    expect(resolveStdioTarget([], { HOME: link.h }).ok).toBe(false);
    const none = home({ token: null });
    const r3 = resolveStdioTarget([], { HOME: none.h });
    expect(r3.ok === false && r3.error.code).toBe("unauthenticated");
  });

  it("トークンの形（16〜512 文字・使える文字）を確かめる", () => {
    expect(resolveStdioTarget([], { HOME: home({ token: "short" }).h }).ok).toBe(false);
    expect(resolveStdioTarget([], { HOME: home({ token: `${"a".repeat(20)} x` }).h }).ok).toBe(
      false,
    );
  });

  it("置き場（.touryou・state）の権限: 0700・0755 は可、0775・0777・0770・0722 は不可", () => {
    for (const [mode, good] of [
      [0o700, true],
      [0o755, true],
      [0o775, false],
      [0o777, false],
      [0o770, false],
      [0o722, false],
    ] as const) {
      for (const which of ["touryou", "state"] as const) {
        const x = home();
        chmodSync(x[which], mode);
        expect(resolveStdioTarget([], { HOME: x.h }).ok, `${which} ${mode.toString(8)}`).toBe(good);
      }
    }
  });

  it("置き場がリンクなら失敗する", () => {
    const { h } = home();
    const target = join(h, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    rmSync(join(h, ".touryou", "state"), { recursive: true });
    symlinkSync(target, join(h, ".touryou", "state"));
    expect(resolveStdioTarget([], { HOME: h }).ok).toBe(false);
  });

  it("設定ファイル・port がリンク・他の人が書ける、なら読まない", () => {
    const a = home();
    chmodSync(join(a.touryou, "config.json"), 0o666);
    expect(resolveStdioTarget([], { HOME: a.h }).ok).toBe(false);
    const b = home();
    writeFileSync(join(b.h, "cfg"), JSON.stringify({ stateDir: b.state }), { mode: 0o600 });
    rmSync(join(b.touryou, "config.json"));
    symlinkSync(join(b.h, "cfg"), join(b.touryou, "config.json"));
    expect(resolveStdioTarget([], { HOME: b.h }).ok).toBe(false);
    const c = home();
    chmodSync(join(c.state, "port"), 0o666);
    expect(resolveStdioTarget([], { HOME: c.h }).ok).toBe(false);
  });

  it.runIf(isMac || has("setfacl"))("ACL つきの root-token・置き場は拒否する", () => {
    const acl = (path: string) =>
      isMac
        ? spawnSync("chmod", ["+a", "everyone allow read", path])
        : spawnSync("setfacl", ["-m", "o::r", "-m", "u:root:r", path]);
    const a = home();
    // macOS では chmod +a は必ず通る（黙って抜けない）。Linux はファイルシステムが ACL に対応しないときだけ抜ける。
    const r = acl(join(a.state, "root-token"));
    if (r.status !== 0 && !isMac) return;
    expect(r.status).toBe(0);
    expect(resolveStdioTarget([], { HOME: a.h }).ok).toBe(false);
    const b = home();
    const rb = acl(b.state);
    if (rb.status !== 0 && !isMac) return;
    expect(rb.status).toBe(0);
    expect(resolveStdioTarget([], { HOME: b.h }).ok).toBe(false);
  });

  // macOS の `ls -l` は `@` を `+` より優先して出す。拡張属性と ACL の両方があっても拒否する。
  it.runIf(isMac)("macOS で拡張属性（@）と ACL の両方がついた root-token・置き場も拒否する", () => {
    const both = (path: string) => {
      expect(spawnSync("xattr", ["-w", "com.example.touryou-test", "1", path]).status).toBe(0);
      expect(spawnSync("chmod", ["+a", "everyone allow read", path]).status).toBe(0);
      const ls = spawnSync("ls", ["-lde", path], { encoding: "utf8" });
      expect(ls.stdout.split(" ")[0]).toMatch(/@$/); // `@` が出て `+` が隠れる状態を作れている
      expect(ls.stdout).toMatch(/\n\s*\d+:/); // ACL の行がある
    };
    const a = home();
    both(join(a.state, "root-token"));
    expect(resolveStdioTarget([], { HOME: a.h }).ok).toBe(false);
    const b = home();
    both(b.state);
    expect(resolveStdioTarget([], { HOME: b.h }).ok).toBe(false);
  });

  it.runIf(isMac)("macOS の拡張属性（@）つきの root-token・置き場は、読める", () => {
    const { h, state } = home();
    expect(
      spawnSync("xattr", ["-w", "com.example.touryou-test", "1", join(state, "root-token")]).status,
    ).toBe(0);
    expect(spawnSync("xattr", ["-w", "com.example.touryou-test", "1", state]).status).toBe(0);
    expect(resolveStdioTarget([], { HOME: h }).ok).toBe(true);
  });

  it("port がない・範囲外なら、起動の案内つきで失敗する", () => {
    const r = resolveStdioTarget([], { HOME: home({ port: null }).h });
    expect(r.ok === false && r.error.code).toBe("daemon_unreachable");
    expect(r.ok === false && r.error.nextActions.join(" ")).toContain(
      "launchd か touryou-daemon で起動してください",
    );
    expect(resolveStdioTarget([], { HOME: home({ port: "99999" }).h }).ok).toBe(false);
  });

  it("HOME がない・設定ファイルがないなら、/setup と --config の案内つきで失敗する", () => {
    const empty = mkdtempSync(join(tmpdir(), "touryou-stdio-empty-"));
    made.push(empty);
    const r = resolveStdioTarget([], {}, { cwd: () => empty });
    expect(r.ok).toBe(false);
    const next = r.ok === false ? r.error.nextActions.join(" ") : "";
    expect(next).toContain("/touryou:setup");
    expect(next).toContain("--config");
    expect(resolveStdioTarget([], { HOME: empty }).ok).toBe(false);
  });

  it("見つからないとき、旧パス（$HOME/.touryou/config.json）へは戻らない（cwd が HOME の外）", () => {
    const x = home();
    const elsewhere = mkdtempSync(join(tmpdir(), "touryou-stdio-else-"));
    made.push(elsewhere);
    const r = resolveStdioTarget([], { HOME: x.h }, { cwd: () => elsewhere });
    expect(r.ok).toBe(false);
  });

  it("cwd から上へ探す: 深い場所・子の作業ツリー（<根>/.touryou/worktrees/<子>）からも、根の設定に届く", () => {
    const { h, state } = home();
    const deep = join(h, "src", "a", "b");
    const child = join(h, ".touryou", "worktrees", "child-1", "src");
    mkdirSync(deep, { recursive: true });
    mkdirSync(child, { recursive: true });
    for (const cwd of [deep, child]) {
      const r = resolveStdioTargetRaw([], {}, { cwd: () => cwd });
      expect(r.ok && r.value.identityPath).toBe(join(state, "daemon-identity"));
    }
  });
});

describe("daemon の再起動への追従（置き場の読み直し）", () => {
  const t = (port: number, token = TOKEN): StdioTarget => ({
    daemonUrl: `http://127.0.0.1:${port}`,
    token,
    identityPath: "/x",
  });
  const fakeRelay = (target: StdioTarget, up: Set<string>): Relay => ({
    whoami: async () =>
      up.has(`${target.daemonUrl}|${target.token}`)
        ? ok({ role: "integrator", nodeId: "root" })
        : { ok: false, error: { code: "daemon_unreachable", cause: "x", nextActions: ["y"] } },
    request: async () => ok("done"),
  });

  it("失敗したら置き場を読み直し、窓口かトークンが変わっていれば、1 回だけ送り直す", async () => {
    const up = new Set([`${t(2).daemonUrl}|NEWTOKEN0123456789`]);
    let reloads = 0;
    const relay = createReloadingRelay(
      t(1),
      () => {
        reloads++;
        return ok(t(2, "NEWTOKEN0123456789"));
      },
      (x) => ok(fakeRelay(x, up)),
    );
    if (!relay.ok) throw new Error("前提");
    const r = await relay.value.whoami();
    expect(r.ok).toBe(true);
    expect(reloads).toBe(1);
    // 以後は新しい接続先を使う（読み直さない）
    expect((await relay.value.whoami()).ok).toBe(true);
    expect(reloads).toBe(1);
  });

  it("request の送り直しでも、requestId は 1 回目と同じ（daemon の重複の記録で、操作を重ねない）", async () => {
    const seen: (string | undefined)[] = [];
    const relay = createReloadingRelay(
      t(1),
      () => ok(t(2)),
      (x) =>
        ok({
          whoami: async () => ok({ role: "integrator" }),
          request: async (_op, _p, o) => {
            seen.push(o?.requestId);
            return x.daemonUrl === t(1).daemonUrl
              ? { ok: false, error: { code: "daemon_unreachable", cause: "x", nextActions: ["y"] } }
              : ok("done");
          },
        }),
    );
    if (!relay.ok) throw new Error("前提");
    expect((await relay.value.request("child.spawn", {})).ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^mcp-stdio-/);
    expect(seen[1]).toBe(seen[0]);
    // 呼び出し元が requestId を渡したら、それを使う
    seen.length = 0;
    await relay.value.request("x", {}, { requestId: "given-1" });
    expect(seen).toEqual(["given-1"]);
  });

  it("時間切れ（daemon_timeout。実行されたか分からない）のあとは、送り直さない", async () => {
    let calls = 0;
    let reloads = 0;
    const relay = createReloadingRelay(
      t(1),
      () => {
        reloads++;
        return ok(t(2));
      },
      () =>
        ok({
          whoami: async () => ok({ role: "integrator" }),
          request: async () => {
            calls++;
            return { ok: false, error: { code: "daemon_timeout", cause: "x", nextActions: ["y"] } };
          },
        }),
    );
    if (!relay.ok) throw new Error("前提");
    expect((await relay.value.request("child.spawn", {})).ok).toBe(false);
    expect(calls).toBe(1);
    expect(reloads).toBe(0);
  });

  it("読み直しても変わっていなければ、送り直さない（失敗のまま）", async () => {
    let made = 0;
    const relay = createReloadingRelay(
      t(1),
      () => ok(t(1)),
      (x) => {
        made++;
        return ok(fakeRelay(x, new Set()));
      },
    );
    if (!relay.ok) throw new Error("前提");
    const r: Result<unknown> = await relay.value.whoami();
    expect(r.ok).toBe(false);
    expect(made).toBe(1);
  });
});

describe("touryou-mcp --stdio の起動", () => {
  it("daemon に届かない（接続の拒否）なら、トークンを送らずに、起動の案内で失敗する", async () => {
    const { h } = home();
    const target = resolveStdioTarget([], { HOME: h });
    if (!target.ok) throw new Error("前提");
    const err: string[] = [];
    const refuse = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const r = await openStdioSession(
      target.value,
      { stderr: (x) => err.push(x) },
      { fetch: refuse, sleep: async () => {} },
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(err.join("")).not.toContain(TOKEN);
  });

  it("失敗は標準エラーにだけ出し、終了コードで返す（標準出力は使わない）", async () => {
    const err: string[] = [];
    // 実際の cwd の上に設定があっても結果が変わらないよう、cwd は設定のない場所に固定する
    const code = await runStdio(
      [],
      {},
      { stderr: (x) => err.push(x) },
      { cwd: () => "/nonexistent-touryou-cwd", files: { exists: () => false } },
    );
    expect(code).toBe(2);
    expect(err.join("")).toMatch(/^\[touryou mcp\] 失敗 \[invalid_config\]/);
  });
});
