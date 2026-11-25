/**
 * 秘密を読む道の ACL。mcp の、身元の秘密・紐付けのコードのファイル・設定・port・置き場の上の階層。
 * どの道も `@touryou/core/fs` の共通の確かめを使い、分からないときは拒む。
 * macOS では、`xattr -w`・`chmod +a` の終了コードを確かめてから（黙って抜けない）、本物のファイルで確かめる。
 * Linux では、本物の ACL の試験はスキップする（差し替えの試験だけが走る）。
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BIND_CODE_FILE, readCodeFile } from "../src/bind-code-file.js";
import { readIdentityFileSecure } from "../src/identity.js";
import { resolveDaemonEndpoint as resolveDaemonEndpointRaw } from "../src/stdio.js";

/** この試験の置き場（`home()`）は `<h>/.touryou/config.json`。cwd の既定は `h`（リポジトリの根の代わり）。 */
const resolveDaemonEndpoint: typeof resolveDaemonEndpointRaw = (argv, env, deps = {}) =>
  resolveDaemonEndpointRaw(argv, env, { cwd: () => env.HOME ?? "/", ...deps });

const isMac = process.platform === "darwin";
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
};
const must = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} が失敗した（${r.status}）: ${r.stderr}`);
};
const xattr = (p: string) => must("xattr", ["-w", "com.example.touryou-test", "1", p]);
const acl = (p: string, dir = false) =>
  must("chmod", ["+a", dir ? "everyone allow list" : "everyone allow read", p]);
/** 3 つの状態（@ と ACL・ACL だけ・@ だけ）を作る。 */
const STATES = [
  {
    name: "@ と ACL の両方",
    apply: (p: string, d = false) => {
      xattr(p);
      acl(p, d);
    },
    ok: false,
  },
  { name: "ACL だけ", apply: (p: string, d = false) => acl(p, d), ok: false },
  { name: "拡張属性だけ", apply: (p: string) => xattr(p), ok: true },
] as const;
const UNKNOWN = () => "ACL を確かめられない（差し替え）";

const IDENTITY = `${JSON.stringify({ version: 1, daemonId: "0".repeat(32), secret: "f".repeat(64) })}\n`;
const identityFile = () => {
  const p = join(tmp("touryou-acl-id-"), "daemon-identity");
  writeFileSync(p, IDENTITY, { mode: 0o600 });
  return p;
};
const CODE = "0123456789ABCDEFGHJKMNPQRS";
const codeTree = () => {
  const base = tmp("touryou-acl-bcf-");
  const gitDir = join(base, "repo", ".git", "worktrees", "a");
  mkdirSync(gitDir, { recursive: true });
  const wt = join(base, "wt");
  mkdirSync(wt);
  writeFileSync(join(wt, ".git"), `gitdir: ${gitDir}\n`);
  const codePath = join(gitDir, BIND_CODE_FILE);
  writeFileSync(codePath, `${CODE}\n`, { mode: 0o600 });
  return { wt, codePath };
};
/** $HOME/.touryou/{config.json,state/port}。 */
const home = () => {
  const h = tmp("touryou-acl-home-");
  const touryou = join(h, ".touryou");
  const state = join(touryou, "state");
  mkdirSync(state, { recursive: true });
  chmodSync(touryou, 0o700);
  chmodSync(state, 0o700);
  writeFileSync(join(touryou, "config.json"), JSON.stringify({ stateDir: state }), { mode: 0o600 });
  writeFileSync(join(state, "port"), "45678\n", { mode: 0o600 });
  return { h, touryou, state, config: join(touryou, "config.json"), port: join(state, "port") };
};

describe("分からないときは拒む（ACL の確かめを差し替える。どの OS でも走る）", () => {
  it("身元の秘密: 確かめが理由を返せば読まない", () => {
    const p = identityFile();
    expect(readIdentityFileSecure(p, { acl: () => undefined })).toBe(IDENTITY);
    expect(() => readIdentityFileSecure(p, { acl: UNKNOWN })).toThrow();
  });
  it("紐付けのコードのファイル: 確かめが理由を返せば unsafe", () => {
    const t = codeTree();
    expect(readCodeFile(t.wt, { acl: () => undefined })).toMatchObject({ ok: true, code: CODE });
    expect(readCodeFile(t.wt, { acl: UNKNOWN })).toMatchObject({ ok: false, reason: "unsafe" });
  });
  it("設定・port・置き場（上の階層を含む）: ls が失敗した（undefined）・出力が想定外なら拒む", () => {
    const x = home();
    const plain = (p: string) =>
      p.endsWith("config.json") || p.endsWith("port") ? "-rw-------" : "drwx------";
    expect(resolveDaemonEndpoint([], { HOME: x.h }, { files: { modeString: plain } }).ok).toBe(
      true,
    );
    for (const target of [x.config, x.port, x.touryou, x.state]) {
      for (const bad of [undefined, "weird", "-rw-------+", "drwx------+"]) {
        const r = resolveDaemonEndpoint(
          [],
          { HOME: x.h },
          { files: { modeString: (p) => (p === target ? bad : plain(p)) } },
        );
        expect(r.ok, `${target} ${String(bad)}`).toBe(false);
      }
    }
  });
});

/** $HOME/.touryou の外の設定（<dir>/config.json と <dir>/state/port）。`port` で、どの設定を読んだかを見分ける。 */
const outside = (port: number) => {
  const dir = tmp("touryou-acl-outside-");
  const state = join(dir, "state");
  mkdirSync(state);
  chmodSync(dir, 0o700);
  chmodSync(state, 0o700);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: state }), { mode: 0o600 });
  writeFileSync(join(state, "port"), `${port}\n`, { mode: 0o600 });
  return { dir, state, config: join(dir, "config.json") };
};

describe("設定ファイルの決め方（--config → TOURYOU_DAEMON_CONFIG → cwd から上へ .touryou/config.json）", () => {
  const url = (r: ReturnType<typeof resolveDaemonEndpoint>) => (r.ok ? r.value.daemonUrl : r.error);

  it("環境変数だけ: その設定の daemon に向く（$HOME/.touryou の外でも、親ディレクトリの検査が通る）", () => {
    const x = home();
    const o = outside(45679);
    const r = resolveDaemonEndpoint([], { HOME: x.h, TOURYOU_DAEMON_CONFIG: o.config });
    expect(url(r)).toBe("http://127.0.0.1:45679");
    expect(r.ok && r.value.stateDir).toBe(o.state);
  });
  it("引数と環境変数の両方: 引数が優先", () => {
    const x = home();
    const o = outside(45679);
    const r = resolveDaemonEndpoint(["--config", x.config], {
      HOME: x.h,
      TOURYOU_DAEMON_CONFIG: o.config,
    });
    expect(url(r)).toBe("http://127.0.0.1:45678");
  });
  it("環境変数が空: 無視して、cwd から上の .touryou/config.json", () => {
    const x = home();
    const r = resolveDaemonEndpoint([], { HOME: x.h, TOURYOU_DAEMON_CONFIG: "" });
    expect(url(r)).toBe("http://127.0.0.1:45678");
  });
  it("どちらもない: cwd から上の .touryou/config.json", () => {
    const x = home();
    expect(url(resolveDaemonEndpoint([], { HOME: x.h }))).toBe("http://127.0.0.1:45678");
  });
  it("設定の親ディレクトリの権限が緩ければ、$HOME/.touryou が正しくても拒む", () => {
    const x = home();
    const o = outside(45679);
    chmodSync(o.dir, 0o777);
    const r = resolveDaemonEndpoint([], { HOME: x.h, TOURYOU_DAEMON_CONFIG: o.config });
    expect(r.ok).toBe(false);
  });
});

describe.runIf(isMac)("macOS の本物のファイル", () => {
  for (const s of STATES) {
    it(`身元の秘密: ${s.name}`, () => {
      const p = identityFile();
      s.apply(p);
      if (s.ok) expect(readIdentityFileSecure(p)).toBe(IDENTITY);
      else expect(() => readIdentityFileSecure(p)).toThrow();
    });
    it(`紐付けのコードのファイル: ${s.name}`, () => {
      const t = codeTree();
      s.apply(t.codePath);
      expect(readCodeFile(t.wt).ok).toBe(s.ok);
    });
    it(`設定ファイル: ${s.name}`, () => {
      const x = home();
      s.apply(x.config);
      expect(resolveDaemonEndpoint([], { HOME: x.h }).ok).toBe(s.ok);
    });
    it(`port: ${s.name}`, () => {
      const x = home();
      s.apply(x.port);
      expect(resolveDaemonEndpoint([], { HOME: x.h }).ok).toBe(s.ok);
    });
    it(`上の階層（$HOME/.touryou）: ${s.name}`, () => {
      const x = home();
      s.apply(x.touryou, true);
      expect(resolveDaemonEndpoint([], { HOME: x.h }).ok).toBe(s.ok);
    });
  }
});
