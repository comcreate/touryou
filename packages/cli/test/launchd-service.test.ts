import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "../src/bin.js";
import { legacyPlistText, runDaemonScript } from "../src/launchd.js";
import type { RunResult } from "../src/launchd-service.js";

// `touryou launchd apply|status|restart|stop|uninstall`。launchctl と窓口は偽物に差し替える（実際の launchctl は呼ばない）。
const TOKEN = "oauth-secret-token-value-0123456789abcdef";
const ORG = "com.example";
const UID = 501;
const DAEMON = `${ORG}.touryou.daemon`;
const MCP = `${ORG}.touryou.mcp`;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fake {
  readonly calls: string[][];
  readonly loaded: Map<string, { state: string; lastExit?: string }>;
  failOn?: string;
  /** daemon を読み込んだら、窓口が応答するか。 */
  daemonAnswers: boolean;
  /** 窓口の whoami の状態コード（応答するとき）。 */
  whoamiCode: number;
  /** 偽の時計（ミリ秒）。sleep で進む。 */
  t: number;
}

function makeHome(opts: { token?: boolean } = {}): { home: string; base: string; state: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "touryou-svc-")));
  dirs.push(home);
  const base = join(home, ".touryou");
  const state = join(base, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(base, "current", "bin"), { recursive: true });
  // daemon の設定の検査の偽物（bin に fail があれば、その中身を標準エラーに出して終了コード 1）
  writeFileSync(
    join(base, "current", "bin", "touryou-daemon"),
    '#!/bin/sh\nf="$(dirname "$0")/fail"\nif [ -f "$f" ]; then cat "$f" >&2; exit 1; fi\nexit 0\n',
    { mode: 0o755 },
  );
  writeFileSync(join(base, "config.json"), JSON.stringify({ stateDir: state }));
  if (opts.token !== false) {
    writeFileSync(join(state, "oauth-token"), TOKEN, { mode: 0o600 });
    chmodSync(join(state, "oauth-token"), 0o600);
  }
  return { home, base, state };
}

function fake(state: string): Fake & { deps: Parameters<typeof runBin>[1]["launchd"] } {
  const f: Fake = { calls: [], loaded: new Map(), daemonAnswers: true, whoamiCode: 401, t: 0 };
  const label = (target: string): string => target.replace(`gui/${UID}/`, "");
  const run = (cmd: string, args: readonly string[]): RunResult => {
    f.calls.push([cmd, ...args]);
    const [sub, ...rest] = args;
    const tail = `${sub} ${(rest.at(-1) ?? "").split("/").at(-1)}`;
    if (f.failOn !== undefined && (sub === f.failOn || tail === f.failOn))
      return { status: 5, stdout: "", stderr: "boom" };
    if (sub === "print") {
      const l = f.loaded.get(label(rest[0] as string));
      if (l === undefined) return { status: 113, stdout: "", stderr: "Could not find service" };
      return {
        status: 0,
        stdout: `${label(rest[0] as string)} = {\n\tstate = ${l.state}\n\tpid = 123\n${l.lastExit === undefined ? "" : `\tlast exit code = ${l.lastExit}\n`}}\n`,
        stderr: "",
      };
    }
    if (sub === "bootstrap") {
      const file = rest[1] as string;
      const l = file.endsWith(`${DAEMON}.plist`) ? DAEMON : MCP;
      f.loaded.set(l, { state: "running" });
      if (l === DAEMON && f.daemonAnswers) writeFileSync(join(state, "port"), "4321\n");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (sub === "bootout") {
      f.loaded.delete(label(rest[0] as string));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (sub === "kickstart") return { status: 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "unknown" };
  };
  return Object.assign(f, {
    deps: {
      run,
      uid: () => UID,
      probe: async (port: number) => (port === 4321 && f.daemonAnswers ? f.whoamiCode : undefined),
      now: () => f.t,
    },
  });
}

const bin = (home: string, f: ReturnType<typeof fake> | undefined, args: string[]) =>
  runBin(["launchd", ...args], {
    env: { HOME: home },
    isTTY: { stdin: false, stdout: false },
    sleep: async (ms: number) => {
      if (f !== undefined) f.t += ms;
    },
    ...(f === undefined ? {} : { launchd: { ...f.deps, uid: () => process.getuid?.() ?? UID } }),
  });

/** 偽物の uid は、ファイルの持ち主（試験を走らせている人）に合わせる。 */
function withUid(f: ReturnType<typeof fake>): ReturnType<typeof fake> {
  const uid = process.getuid?.() ?? UID;
  const run = f.deps?.run as (c: string, a: readonly string[]) => RunResult;
  const mapped = (c: string, a: readonly string[]) =>
    run(
      c,
      a.map((x) => x.replace(`gui/${uid}`, `gui/${UID}`)),
    );
  return Object.assign(f, { deps: { ...f.deps, run: mapped } });
}

async function initHome(opts: { token?: boolean } = {}) {
  const h = makeHome(opts);
  const r = await bin(h.home, undefined, ["init", "--org", ORG]);
  expect(r.exitCode).toBe(0);
  const f = withUid(fake(h.state));
  return { ...h, f, agents: join(h.home, "Library", "LaunchAgents") };
}

const seq = (f: Fake) =>
  f.calls.filter((c) => c[1] !== "print").map((c) => `${c[1]} ${c.at(-1)?.split("/").at(-1)}`);

describe("apply", () => {
  it("--yes がなければ、何もしない（終了コード 2。launchctl を呼ばない・plist を置かない）", async () => {
    const { home, f, agents } = await initHome();
    const r = await bin(home, f, ["apply", "--org", ORG]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/同意/);
    expect(f.calls).toEqual([]);
    expect(existsSync(agents)).toBe(false);
  });

  it("plist を LaunchAgents に置き、daemon を読み込み、窓口の応答を待つ（常駐は daemon だけ）", async () => {
    const { home, base, f, agents } = await initHome();
    const r = await bin(home, f, ["apply", "--yes", "--org", ORG]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(seq(f)).toEqual([`bootstrap ${DAEMON}.plist`]);
    expect(existsSync(join(agents, `${MCP}.plist`))).toBe(false);
    for (const l of [DAEMON]) {
      expect(readFileSync(join(agents, `${l}.plist`), "utf8")).toBe(
        readFileSync(join(base, "launchd", `${l}.plist`), "utf8"),
      );
    }
    expect(r.stdout).toMatch(/whoami が 401/);
    expect(r.stdout).toMatch(/「ログイン項目」に、node の項目が出るのは、正常/);
    expect(r.stdout).not.toContain("run-daemon.sh");
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("読み込み済みなら、bootstrap しない（やり直せる）", async () => {
    const { home, f } = await initHome();
    expect((await bin(home, f, ["apply", "--yes", "--org", ORG])).exitCode).toBe(0);
    f.calls.length = 0;
    const r = await bin(home, f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(0);
    expect(seq(f)).toEqual([]);
  });

  it("init の生成物がない・--org が違えば、止める", async () => {
    const h = makeHome();
    const f = withUid(fake(h.state));
    let r = await bin(h.home, f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/touryou launchd init/);
    const g = await initHome();
    r = await bin(g.home, g.f, ["apply", "--yes", "--org", "com.other"]);
    expect(r.exitCode).toBe(1);
    expect(g.f.calls).toEqual([]);
  });

  it("LaunchAgents に違う内容の plist があれば、上書きせずに止める", async () => {
    const { home, f, agents } = await initHome();
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, `${DAEMON}.plist`), "other");
    const r = await bin(home, f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(join(agents, `${DAEMON}.plist`), "utf8")).toBe("other");
    expect(seq(f)).toEqual([]);
  });

  it("daemon の窓口が応答しなければ、終了コード 1", async () => {
    const { home, f } = await initHome();
    f.daemonAnswers = false;
    const r = await bin(home, f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(seq(f)).toEqual([`bootstrap ${DAEMON}.plist`]);
  });

  it("bootstrap が失敗したら、終了コード 1", async () => {
    const { home, f } = await initHome();
    f.failOn = "bootstrap";
    const r = await bin(home, f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/bootstrap/);
  });
});

describe("設定の検査（apply の前）", () => {
  it("設定が通らなければ、plist を置かず、launchctl を呼ばずに終了コード 1", async () => {
    const { home, base, f, agents } = await initHome();
    writeFileSync(
      join(base, "current", "bin", "fail"),
      `失敗 [invalidConfig]: rootCwd ${home}/gone が、repoRoot の配下の実在するパスでない\n`,
    );
    const r = await bin(home, f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/daemon の設定の検査を通らない/);
    expect(r.stderr).not.toContain(home);
    expect(f.calls).toEqual([]);
    expect(existsSync(join(agents, `${DAEMON}.plist`))).toBe(false);
  });
});

describe("status の最後の失敗", () => {
  it("last exit code が 0 以外なら、daemon.log の最後の失敗の行を、値を伏せて出す", async () => {
    const { home, base, f } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    mkdirSync(join(base, "logs"), { recursive: true });
    writeFileSync(
      join(base, "logs", "daemon.log"),
      `失敗 [invalidConfig]: 古い\n起動した: http://127.0.0.1:1\n失敗 [invalidConfig]: repoRoot ${home}/gone が、実パスでない${"あ".repeat(400)}\n次の操作:\n  - 直す\n`,
    );
    f.loaded.set(DAEMON, { state: "spawn", lastExit: "1" });
    const r = await bin(home, f, ["status", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(
      /最後の失敗.*失敗 \[invalidConfig\]: repoRoot <パス> が、実パスでない/,
    );
    expect(r.stdout).not.toContain(`${home}/gone`);
    expect(r.stdout).not.toMatch(/古い/);
    expect(r.stdout).toMatch(/…/); // 長さを切る
  });

  it("last exit code が 0 なら、出さない", async () => {
    const { home, base, f } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    mkdirSync(join(base, "logs"), { recursive: true });
    writeFileSync(join(base, "logs", "daemon.log"), "失敗 [x]: y\n");
    f.loaded.set(DAEMON, { state: "running", lastExit: "0" });
    const r = await bin(home, f, ["status", "--org", ORG]);
    expect(r.stdout).not.toMatch(/最後の失敗/);
  });
});

describe("status・restart・stop", () => {
  it("status は、読み込みの状態と窓口を出す。動いていなければ終了コード 1", async () => {
    const { home, f } = await initHome();
    let r = await bin(home, f, ["status", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/読み込まれていない/);
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    r = await bin(home, f, ["status", "--org", ORG]);
    expect(r.exitCode).toBe(0);
    f.loaded.set(DAEMON, { state: "not running", lastExit: "78: Function not implemented" });
    r = await bin(home, f, ["status", "--org", ORG]);
    expect(r.exitCode).toBe(1);
  });

  it("restart は、daemon を kickstart -k。読み込まれていなければ止める", async () => {
    const { home, f } = await initHome();
    let r = await bin(home, f, ["restart", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    f.calls.length = 0;
    r = await bin(home, f, ["restart", "--org", ORG]);
    expect(r.exitCode).toBe(0);
    expect(seq(f)).toEqual([`kickstart ${DAEMON}`]);
  });

  it("stop は、daemon を bootout。plist は残す", async () => {
    const { home, f, agents } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    f.calls.length = 0;
    const r = await bin(home, f, ["stop", "--org", ORG]);
    expect(r.exitCode).toBe(0);
    expect(seq(f)).toEqual([`bootout ${DAEMON}`]);
    expect(existsSync(join(agents, `${DAEMON}.plist`))).toBe(true);
    expect(r.stdout).toMatch(/次のログイン/);
  });

  it("--yes は apply・uninstall だけ。ほかのサブコマンドに付けると引数の誤り", async () => {
    const { home, f } = await initHome();
    expect((await bin(home, f, ["stop", "--yes", "--org", ORG])).exitCode).toBe(2);
  });
});

describe("uninstall", () => {
  it("--yes がなければ、何もしない", async () => {
    const { home, f } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    f.calls.length = 0;
    const r = await bin(home, f, ["uninstall", "--org", ORG]);
    expect(r.exitCode).toBe(2);
    expect(f.calls).toEqual([]);
  });

  it("止めて、touryou が生成した plist・起動スクリプトだけを消す。トークン・logs・state は残す", async () => {
    const { home, base, state, f, agents } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    f.calls.length = 0;
    const r = await bin(home, f, ["uninstall", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(0);
    expect(seq(f)).toEqual([`bootout ${DAEMON}`]);
    for (const l of [DAEMON]) {
      expect(existsSync(join(agents, `${l}.plist`))).toBe(false);
      expect(existsSync(join(base, "launchd", `${l}.plist`))).toBe(false);
    }
    expect(existsSync(join(base, "bin", "run-daemon.sh"))).toBe(false);
    expect(readFileSync(join(state, "oauth-token"), "utf8")).toBe(TOKEN);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("--remove-token は受け付けない（引数の誤り）", async () => {
    const { home, f } = await initHome();
    expect(
      (await bin(home, f, ["uninstall", "--yes", "--remove-token", "--org", ORG])).exitCode,
    ).toBe(2);
  });

  it("touryou が生成したと判定できないファイルは、消さずに残して終了コード 1", async () => {
    const { home, base, f, agents } = await initHome();
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, `${DAEMON}.plist`), "someone else's plist");
    const r = await bin(home, f, ["uninstall", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(join(agents, `${DAEMON}.plist`), "utf8")).toBe("someone else's plist");
    expect(existsSync(join(base, "launchd", `${DAEMON}.plist`))).toBe(false);
  });
});

describe("launchd の操作の回帰", () => {
  it("apply: 窓口の応答の待ちは、時計で 60 秒まで（probe の回数ではない）", async () => {
    const { home, f } = await initHome();
    f.daemonAnswers = false;
    const r = await bin(home, f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(f.t).toBeGreaterThanOrEqual(59_000);
    expect(f.t).toBeLessThanOrEqual(60_000);
    expect(r.stderr).toMatch(/daemon は読み込み済みのまま/);
  });

  it("restart: 窓口の応答を待ちきれなければ、終了コード 1", async () => {
    const { home, f } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    f.calls.length = 0;
    f.daemonAnswers = false;
    const r = await bin(home, f, ["restart", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(seq(f)).toEqual([`kickstart ${DAEMON}`]);
  });

  it("status: whoami が 401 以外（200 など）なら、想定外として終了コード 1", async () => {
    const { home, f } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    f.whoamiCode = 200;
    const r = await bin(home, f, ["status", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/想定外の応答（whoami が 200）/);
  });

  it("uninstall: 手で直した plist（環境変数を足した）・起動スクリプト（中身を変えた）は消さない", async () => {
    const { home, base, f, agents } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    const src = join(base, "launchd", `${DAEMON}.plist`);
    const edited = readFileSync(src, "utf8").replace(
      "<key>PATH</key>",
      "<key>EXTRA</key><string>x</string>\n    <key>PATH</key>",
    );
    writeFileSync(src, edited);
    writeFileSync(join(agents, `${DAEMON}.plist`), edited);
    const r = await bin(home, f, ["uninstall", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(src, "utf8")).toBe(edited);
    expect(readFileSync(join(agents, `${DAEMON}.plist`), "utf8")).toBe(edited);
  });

  it("uninstall: LaunchAgents の plist がシンボリックリンクなら、消さずに残す", async () => {
    const { home, base, f, agents } = await initHome();
    mkdirSync(agents, { recursive: true });
    symlinkSync(join(base, "launchd", `${DAEMON}.plist`), join(agents, `${DAEMON}.plist`));
    const r = await bin(home, f, ["uninstall", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    // リンクそのものを残す（辿った先の有無ではなく、リンクがあるか）
    expect(lstatSync(join(agents, `${DAEMON}.plist`)).isSymbolicLink()).toBe(true);
  });

  it("uninstall: bootout が失敗したら、何も消さずに終了コード 1", async () => {
    const { home, base, f, agents } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    f.failOn = "bootout";
    const r = await bin(home, f, ["uninstall", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/何も消していない/);
    expect(existsSync(join(agents, `${DAEMON}.plist`))).toBe(true);
    expect(existsSync(join(base, "launchd", `${DAEMON}.plist`))).toBe(true);
  });

  it("init の --path-prefix つきの plist も、生成物として扱う（apply・uninstall）", async () => {
    const h = makeHome();
    const init = await bin(h.home, undefined, [
      "init",
      "--org",
      ORG,
      "--path-prefix",
      "/opt/homebrew/bin",
    ]);
    expect(init.exitCode).toBe(0);
    const f = withUid(fake(h.state));
    expect((await bin(h.home, f, ["apply", "--yes", "--org", ORG])).exitCode).toBe(0);
    const r = await bin(h.home, f, ["uninstall", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(h.base, "launchd", `${DAEMON}.plist`))).toBe(false);
  });

  it("uid を得られない環境では、何もせずに止める", async () => {
    const { home, f } = await initHome();
    const r = await runBin(["launchd", "status", "--org", ORG], {
      env: { HOME: home },
      isTTY: { stdin: false, stdout: false },
      launchd: { ...f.deps, uid: () => -1 },
    });
    expect(r.exitCode).toBe(2);
    expect(f.calls).toEqual([]);
  });

  it("uninstall: .touryou/launchd の plist がないときは、init の生成物がないので確かめられない、として残す", async () => {
    const { home, base, f, agents } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    rmSync(join(base, "launchd", `${DAEMON}.plist`));
    const r = await bin(home, f, ["uninstall", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(agents, `${DAEMON}.plist`))).toBe(true);
    expect(r.stdout).toMatch(/init の生成物.*がないので、apply が置いたものか確かめられない/);
  });

  it("status: stop の後は、次のログインか apply --yes（同意のあと）を案内し、restart は使えないと出す", async () => {
    const { home, f } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    await bin(home, f, ["stop", "--org", ORG]);
    const r = await bin(home, f, ["status", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/stop で止めた後/);
    expect(r.stdout).toMatch(/次のログインで、また動く/);
    expect(r.stdout).toMatch(/touryou launchd apply --yes（利用者の同意のあとだけ）/);
    expect(r.stdout).toMatch(/restart は、読み込まれていないので使えない/);
  });

  it("status: 常駐にしていない（LaunchAgents に plist がない）ときは、/setup の手順 3-A を案内する", async () => {
    const { home, f } = await initHome();
    const r = await bin(home, f, ["status", "--org", ORG]);
    expect(r.stdout).toMatch(/常駐にしていない/);
    expect(r.stdout).toMatch(/\/setup の手順 3-A/);
    expect(r.stdout).not.toMatch(/stop で止めた後/);
  });

  it("status: 読み込み済みなら、戻し方の案内は出さない", async () => {
    const { home, f } = await initHome();
    await bin(home, f, ["apply", "--yes", "--org", ORG]);
    const r = await bin(home, f, ["status", "--org", ORG]);
    expect(r.stdout).not.toMatch(/restart は、読み込まれていない/);
  });
});

describe("古い形（v0.1.1 まで。run-daemon.sh を起こす plist）からの引っ越し（#64）", () => {
  /** v0.1.1 の init・apply が置いたのと同じ、古い形の生成物（.touryou/launchd・bin・LaunchAgents）。 */
  function legacyHome(path = "/usr/bin:/bin:/usr/sbin:/sbin") {
    const h = makeHome();
    const agents = join(h.home, "Library", "LaunchAgents");
    for (const d of [join(h.base, "bin"), join(h.base, "logs")]) {
      mkdirSync(d, { recursive: true });
      chmodSync(d, 0o700);
    }
    for (const d of [join(h.base, "launchd"), agents]) mkdirSync(d, { recursive: true });
    const script = join(h.base, "bin", "run-daemon.sh");
    writeFileSync(script, runDaemonScript(h.base), { mode: 0o700 });
    const text = legacyPlistText({
      label: DAEMON,
      script,
      workingDirectory: h.base,
      log: join(h.base, "logs", "daemon.log"),
      path,
    });
    const src = join(h.base, "launchd", `${DAEMON}.plist`);
    const dest = join(agents, `${DAEMON}.plist`);
    writeFileSync(src, text);
    writeFileSync(dest, text);
    return { ...h, agents, script, src, dest, text, f: withUid(fake(h.state)) };
  }

  it("apply: .touryou/launchd が古い形のままなら、init を案内して止める（launchctl は呼ばない）", async () => {
    const h = legacyHome();
    const r = await bin(h.home, h.f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/古い形.*touryou launchd init を実行して/);
    expect(h.f.calls).toEqual([]);
    expect(readFileSync(h.dest, "utf8")).toBe(h.text);
  });

  it("init のあとの apply: LaunchAgents の古い形を、止めてから新しい形に置き換え、読み込む", async () => {
    const h = legacyHome();
    h.f.loaded.set(DAEMON, { state: "running" });
    expect((await bin(h.home, undefined, ["init", "--org", ORG])).exitCode).toBe(0);
    expect(existsSync(h.script)).toBe(false);
    const r = await bin(h.home, h.f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(seq(h.f)).toEqual([`bootout ${DAEMON}`, `bootstrap ${DAEMON}.plist`]);
    expect(readFileSync(h.dest, "utf8")).toBe(readFileSync(h.src, "utf8"));
    expect(readFileSync(h.dest, "utf8")).not.toContain("run-daemon.sh");
    expect(r.stdout).toMatch(/置き換えた（古い形 → 新しい形）/);
  });

  it("init のあとの apply: --path-prefix つきの古い形も、同じ PATH なら置き換える", async () => {
    const pv = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const h = legacyHome(pv);
    expect(
      (await bin(h.home, undefined, ["init", "--org", ORG, "--path-prefix", "/opt/homebrew/bin"]))
        .exitCode,
    ).toBe(0);
    const r = await bin(h.home, h.f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(readFileSync(h.dest, "utf8")).toContain(`<string>${pv}</string>`);
  });

  it("apply: LaunchAgents の古い形が、新しい形と PATH が違えば、置き換えずに止める", async () => {
    const h = legacyHome("/opt/x:/usr/bin:/bin:/usr/sbin:/sbin");
    rmSync(h.src);
    rmSync(h.script);
    expect((await bin(h.home, undefined, ["init", "--org", ORG])).exitCode).toBe(0);
    const before = readFileSync(h.dest, "utf8");
    const r = await bin(h.home, h.f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(h.dest, "utf8")).toBe(before);
    expect(seq(h.f)).toEqual([]);
  });

  it("apply: 古い形の plist を止められなければ、置き換えずに止める", async () => {
    const h = legacyHome();
    h.f.loaded.set(DAEMON, { state: "running" });
    expect((await bin(h.home, undefined, ["init", "--org", ORG])).exitCode).toBe(0);
    h.f.failOn = "bootout";
    const r = await bin(h.home, h.f, ["apply", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/何も置き換えていない/);
    expect(readFileSync(h.dest, "utf8")).toBe(h.text);
  });

  it("uninstall: 古い形のまま（init していない）でも、plist・run-daemon.sh を外す", async () => {
    const h = legacyHome();
    h.f.loaded.set(DAEMON, { state: "running" });
    const r = await bin(h.home, h.f, ["uninstall", "--yes", "--org", ORG]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    for (const p of [h.dest, h.src, h.script]) expect(existsSync(p), p).toBe(false);
  });

  it("uninstall: init で新しい形にしたが、LaunchAgents は古い形のまま（apply の前）でも、両方を外す", async () => {
    const h = legacyHome();
    expect((await bin(h.home, undefined, ["init", "--org", ORG])).exitCode).toBe(0);
    const r = await bin(h.home, h.f, ["uninstall", "--yes", "--org", ORG]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    for (const p of [h.dest, h.src, h.script]) expect(existsSync(p), p).toBe(false);
  });

  it("uninstall: LaunchAgents の古い形を残したら（手で直した）、run-daemon.sh も残す", async () => {
    const h = legacyHome();
    writeFileSync(h.dest, `${h.text}<!-- edited -->\n`);
    const r = await bin(h.home, h.f, ["uninstall", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(h.dest)).toBe(true);
    expect(existsSync(h.script)).toBe(true);
    expect(r.stdout).toMatch(/古い形の起動スクリプトも残した/);
  });

  it("uninstall: run-daemon.sh を手で直していれば、消さずに残す", async () => {
    const h = legacyHome();
    writeFileSync(h.script, "#!/bin/sh\necho mine\n");
    const r = await bin(h.home, h.f, ["uninstall", "--yes", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(h.script, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(existsSync(h.dest)).toBe(false);
  });
});
