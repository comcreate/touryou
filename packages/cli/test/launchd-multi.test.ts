import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { daemonNameOf, LSREGISTER, legacyScriptPath, runDaemonScript } from "../src/launchd.js";
import type { RunResult } from "../src/launchd-service.js";

// 設定ごとに別の daemon（#165）。launchctl と窓口は偽物に差し替える。
const UID = 501;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface World {
  readonly home: string;
  readonly base: string;
  readonly agents: string;
  readonly defaultConfig: string;
  readonly otherConfig: string;
  readonly otherLabel: string;
  readonly states: Record<string, string>;
  readonly ports: Record<string, string>;
  readonly loaded: Set<string>;
  readonly calls: string[][];
  readonly ls: string[];
  readonly launchd: NonNullable<Parameters<typeof runBin>[1]["launchd"]>;
}

function makeWorld(): World {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "touryou-multi-")));
  dirs.push(home);
  const base = join(home, ".touryou");
  mkdirSync(join(base, "current", "bin"), { recursive: true });
  writeFileSync(join(base, "current", "bin", "touryou-daemon"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  const defaultConfig = join(base, "config.json");
  const otherDir = join(base, "other");
  const otherConfig = join(otherDir, "config.json");
  const stateA = join(base, "state");
  const stateB = join(otherDir, "state");
  mkdirSync(stateA, { recursive: true });
  mkdirSync(stateB, { recursive: true });
  writeFileSync(defaultConfig, JSON.stringify({ stateDir: stateA }), { mode: 0o600 });
  writeFileSync(otherConfig, JSON.stringify({ stateDir: stateB }), { mode: 0o600 });
  const otherLabel = `touryou.${daemonNameOf(base, otherConfig)}`;
  const states = { "touryou.daemon": stateA, [otherLabel]: stateB };
  const ports: Record<string, string> = { "touryou.daemon": "4321", [otherLabel]: "4322" };
  const loaded = new Set<string>();
  const calls: string[][] = [];
  const ls: string[] = [];
  const uid = process.getuid?.() ?? UID;
  const run = (cmd: string, args: readonly string[]): RunResult => {
    if (cmd === LSREGISTER) {
      ls.push(args.join(" "));
      return { status: 0, stdout: "", stderr: "" };
    }
    calls.push([cmd, ...args]);
    const [sub, ...rest] = args;
    const labelOf = (t: string): string => t.replace(`gui/${uid}/`, "");
    if (sub === "print") {
      return loaded.has(labelOf(rest[0] as string))
        ? { status: 0, stdout: "\tstate = running\n\tpid = 1\n", stderr: "" }
        : { status: 113, stdout: "", stderr: "" };
    }
    if (sub === "bootstrap") {
      const label = (rest[1] as string)
        .split("/")
        .at(-1)
        ?.replace(/\.plist$/, "") as string;
      loaded.add(label);
      writeFileSync(join(states[label] as string, "port"), `${ports[label]}\n`, { mode: 0o600 });
    } else if (sub === "bootout") {
      loaded.delete(labelOf(rest[0] as string));
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return {
    home,
    base,
    agents: join(home, "Library", "LaunchAgents"),
    defaultConfig,
    otherConfig,
    otherLabel,
    states,
    ports,
    loaded,
    calls,
    ls,
    launchd: {
      run,
      uid: () => uid,
      probe: async (port: number) => (port >= 4321 && port <= 4323 ? 401 : undefined),
    },
  };
}

const bin = (w: World, args: string[]) =>
  runBin(["launchd", ...args], {
    env: { HOME: w.home },
    isTTY: { stdin: false, stdout: false },
    sleep: async () => undefined,
    launchd: w.launchd,
  });

describe("複数の daemon（--config）", () => {
  it("設定ごとに、別の Label・plist・ログの plist を生成し、既定は今までどおり", async () => {
    const w = makeWorld();
    expect((await bin(w, ["init"])).exitCode).toBe(0);
    const r = await bin(w, ["init", "--config", w.otherConfig]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(readdirSync(join(w.base, "launchd")).sort()).toEqual(
      [`${w.otherLabel}.plist`, "touryou.daemon.plist"].sort(),
    );
    const other = readFileSync(join(w.base, "launchd", `${w.otherLabel}.plist`), "utf8");
    expect(other).toContain(`<key>Label</key><string>${w.otherLabel}</string>`);
    expect(other).toContain(`<string>${w.otherConfig}</string>`);
    expect(other).toContain(`${w.otherLabel.replace("touryou.", "logs/")}.log`);
    const def = readFileSync(join(w.base, "launchd", "touryou.daemon.plist"), "utf8");
    expect(def).toContain(`<string>${w.defaultConfig}</string>`);
    expect(def).toContain("logs/daemon.log");
  });

  it("2 つの設定で、それぞれ登録・状態確認・停止・削除ができる", async () => {
    const w = makeWorld();
    await bin(w, ["init"]);
    await bin(w, ["init", "--config", w.otherConfig]);

    // 登録（別名の設定だけ）
    const a = await bin(w, ["apply", "--yes", "--config", w.otherConfig]);
    expect(a.stderr).toBe("");
    expect(a.exitCode).toBe(0);
    expect([...w.loaded]).toEqual([w.otherLabel]);
    expect(existsSync(join(w.agents, `${w.otherLabel}.plist`))).toBe(true);
    expect(existsSync(join(w.agents, "touryou.daemon.plist"))).toBe(false);

    // 既定も登録
    expect((await bin(w, ["apply", "--yes"])).exitCode).toBe(0);
    expect(new Set(w.loaded)).toEqual(new Set(["touryou.daemon", w.otherLabel]));

    // 状態確認は、設定ごと
    const s1 = await bin(w, ["status", "--config", w.otherConfig]);
    expect(s1.exitCode).toBe(0);
    expect(s1.stdout).toContain(`${w.otherLabel}: 読み込み済み`);
    expect(s1.stdout).not.toContain("touryou.daemon:");

    // 停止は、設定ごと（もう片方は動いたまま）
    expect((await bin(w, ["stop", "--config", w.otherConfig])).exitCode).toBe(0);
    expect([...w.loaded]).toEqual(["touryou.daemon"]);

    // --others は、別名の daemon だけを対象にする
    await bin(w, ["apply", "--yes", "--others"]);
    expect(new Set(w.loaded)).toEqual(new Set(["touryou.daemon", w.otherLabel]));
    const rs = await bin(w, ["restart", "--others"]);
    expect(rs.exitCode).toBe(0);
    expect(w.calls.some((c) => c[1] === "kickstart" && c.at(-1)?.endsWith(w.otherLabel))).toBe(
      true,
    );
    expect(
      w.calls.filter((c) => c[1] === "kickstart" && c.at(-1)?.endsWith("touryou.daemon")).length,
    ).toBe(0);

    // 削除は、設定ごと。別名を消しても、既定の plist と TouRyou.app の登録は残る
    w.ls.length = 0;
    const u = await bin(w, ["uninstall", "--yes", "--config", w.otherConfig]);
    expect(u.stderr).toBe("");
    expect(u.exitCode).toBe(0);
    expect(existsSync(join(w.agents, `${w.otherLabel}.plist`))).toBe(false);
    expect(existsSync(join(w.base, "launchd", `${w.otherLabel}.plist`))).toBe(false);
    expect(existsSync(join(w.agents, "touryou.daemon.plist"))).toBe(true);
    expect(w.loaded.has("touryou.daemon")).toBe(true);
    expect(w.ls.filter((x) => x.startsWith("-u"))).toEqual([]);

    // 既定を消すと、最後なので登録も解く
    expect((await bin(w, ["uninstall", "--yes"])).exitCode).toBe(0);
    expect(existsSync(join(w.agents, "touryou.daemon.plist"))).toBe(false);
  });

  it("--others は、別名の daemon がなければ、何もせず成功する", async () => {
    const w = makeWorld();
    await bin(w, ["init"]);
    const r = await bin(w, ["restart", "--others"]);
    expect(r.exitCode).toBe(0);
    expect(w.calls).toEqual([]);
  });

  it("--config と --others は、同時に指定できない・相対パスは断る", async () => {
    const w = makeWorld();
    expect((await bin(w, ["status", "--others", "--config", w.otherConfig])).exitCode).toBe(2);
    expect((await bin(w, ["status", "--config", "relative.json"])).exitCode).toBe(2);
    expect((await bin(w, ["init", "--config", "relative.json"])).exitCode).toBe(2);
  });

  it("窓口の応答は、daemon を並べて待つ（応答しない daemon が 2 つでも、待ち時間は 1 つ分）", async () => {
    const w = makeWorld();
    const third = join(w.base, "third", "config.json");
    const thirdState = join(w.base, "third", "state");
    mkdirSync(thirdState, { recursive: true });
    writeFileSync(third, JSON.stringify({ stateDir: thirdState }), { mode: 0o600 });
    w.states[`touryou.${daemonNameOf(w.base, third)}`] = thirdState;
    w.ports[`touryou.${daemonNameOf(w.base, third)}`] = "4323";
    const up = { ...w.launchd, probe: async () => 401 };
    const run = (args: string[], launchd: typeof w.launchd, sleep: (ms: number) => Promise<void>) =>
      runBin(["launchd", ...args], {
        env: { HOME: w.home },
        isTTY: { stdin: false, stdout: false },
        sleep,
        launchd,
      });
    for (const c of [w.otherConfig, third]) {
      expect((await run(["init", "--config", c], up, async () => undefined)).exitCode).toBe(0);
      expect(
        (await run(["apply", "--yes", "--config", c], up, async () => undefined)).exitCode,
      ).toBe(0);
    }
    // 偽の時計。sleep が進める（直列なら、2 つ目は 1 つ目の待ちが終わってから始まり、2 倍かかる）
    let clock = 0;
    const waitMs = 10_000;
    const r = await run(
      ["restart", "--others"],
      { ...w.launchd, probe: async () => undefined, waitMs, now: () => clock },
      async (ms) => {
        clock += ms;
      },
    );
    expect(r.exitCode).toBe(1);
    expect(clock).toBeLessThanOrEqual(waitMs + 2000);
  });

  it("リンク経由の --config でも、実パスの設定と同じ daemon（同じ Label・plist）になる", async () => {
    const w = makeWorld();
    const linkToOther = join(w.base, "link-other.json");
    const linkToDefault = join(w.base, "link-default.json");
    symlinkSync(w.otherConfig, linkToOther);
    symlinkSync(w.defaultConfig, linkToDefault);
    expect(daemonNameOf(w.base, linkToOther)).toBe(daemonNameOf(w.base, w.otherConfig));
    expect(daemonNameOf(w.base, linkToDefault)).toBe("daemon");
    const r = await bin(w, ["init", "--config", linkToOther]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(readdirSync(join(w.base, "launchd"))).toEqual([`${w.otherLabel}.plist`]);
    // plist には、実パスの設定が書かれる。リンク経由でも、同じ daemon を apply・stop できる
    expect(readFileSync(join(w.base, "launchd", `${w.otherLabel}.plist`), "utf8")).toContain(
      `<string>${w.otherConfig}</string>`,
    );
    expect((await bin(w, ["apply", "--yes", "--config", linkToOther])).exitCode).toBe(0);
    expect([...w.loaded]).toEqual([w.otherLabel]);
    expect((await bin(w, ["stop", "--config", w.otherConfig])).exitCode).toBe(0);
    expect(w.loaded.size).toBe(0);
  });

  it("別の設定と同じ stateDir を使う設定は、plist を作らずに止める", async () => {
    const w = makeWorld();
    expect((await bin(w, ["init"])).exitCode).toBe(0);
    const dup = join(w.base, "dup", "config.json");
    mkdirSync(join(w.base, "dup"), { recursive: true });
    // 既定の設定の stateDir（<base>/state）を、リンク経由の別の書き方で指す
    const stateLink = join(w.base, "state-link");
    symlinkSync(join(w.base, "state"), stateLink);
    writeFileSync(dup, JSON.stringify({ stateDir: stateLink }), { mode: 0o600 });
    const r = await bin(w, ["init", "--config", dup]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("stateDir が、別の設定");
    expect(readdirSync(join(w.base, "launchd"))).toEqual(["touryou.daemon.plist"]);
    // init 済みの別名の設定とも、重ならない
    expect((await bin(w, ["init", "--config", w.otherConfig])).exitCode).toBe(0);
    const dup2 = join(w.base, "dup", "config2.json");
    writeFileSync(dup2, JSON.stringify({ stateDir: w.states[w.otherLabel] }), { mode: 0o600 });
    expect((await bin(w, ["init", "--config", dup2])).exitCode).toBe(1);
  });

  it("別名の daemon の apply・uninstall は、既定と共有する古い形の起動スクリプトを消さない", async () => {
    const w = makeWorld();
    await bin(w, ["init"]);
    await bin(w, ["init", "--config", w.otherConfig]);
    const script = legacyScriptPath(w.base);
    mkdirSync(join(w.base, "bin"), { recursive: true });
    writeFileSync(script, runDaemonScript(w.base), { mode: 0o755 });
    expect((await bin(w, ["apply", "--yes", "--config", w.otherConfig])).exitCode).toBe(0);
    expect(existsSync(script)).toBe(true);
    expect((await bin(w, ["uninstall", "--yes", "--config", w.otherConfig])).exitCode).toBe(0);
    expect(existsSync(script)).toBe(true);
    // 既定の daemon を外すときは、これまでどおり消す
    expect((await bin(w, ["apply", "--yes"])).exitCode).toBe(0);
    expect((await bin(w, ["uninstall", "--yes"])).exitCode).toBe(0);
    expect(existsSync(script)).toBe(false);
  });

  it("--others は、init しただけで常駐にしていない別名の daemon を、apply・restart で常駐にしない", async () => {
    const w = makeWorld();
    await bin(w, ["init", "--config", w.otherConfig]);
    for (const args of [["apply", "--yes"], ["restart"], ["status"]]) {
      const r = await bin(w, [...args, "--others"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("常駐にしたものがない");
    }
    expect(w.calls).toEqual([]);
    expect(existsSync(join(w.agents, `${w.otherLabel}.plist`))).toBe(false);
    // uninstall は、置いていない plist（init の出力）も片づける
    expect((await bin(w, ["uninstall", "--yes", "--others"])).exitCode).toBe(0);
    expect(existsSync(join(w.base, "launchd", `${w.otherLabel}.plist`))).toBe(false);
  });

  it("--others は --org の Label のものだけを対象にする", async () => {
    const w = makeWorld();
    await bin(w, ["init", "--config", w.otherConfig, "--org", "com.example"]);
    const orgLabel = `com.example.${w.otherLabel}`;
    w.states[orgLabel] = w.states[w.otherLabel] as string;
    w.ports[orgLabel] = "4322";
    // --others は、置いた（常駐にした）ものだけが対象。先に --config で置く
    expect(
      (await bin(w, ["apply", "--yes", "--config", w.otherConfig, "--org", "com.example"])).exitCode,
    ).toBe(0);
    expect([...w.loaded]).toEqual([orgLabel]);
    expect((await bin(w, ["apply", "--yes", "--others", "--org", "com.example"])).exitCode).toBe(0);
    // 別の組織を指定したら、対象がない
    w.calls.length = 0;
    const other = await bin(w, ["restart", "--others", "--org", "org.other"]);
    expect(other.exitCode).toBe(0);
    expect(w.calls).toEqual([]);
    // 指定した組織なら、対象になる
    expect((await bin(w, ["restart", "--others", "--org", "com.example"])).exitCode).toBe(0);
    expect(w.calls.some((c) => c[1] === "kickstart" && c.at(-1)?.endsWith(orgLabel))).toBe(true);
  });

  it("init --others は、登録済みの別名の daemon を、plist の設定で作り直す（手で直した plist は上書きしない）", async () => {
    const w = makeWorld();
    await bin(w, ["init", "--config", w.otherConfig]);
    const plist = join(w.base, "launchd", `${w.otherLabel}.plist`);
    const before = readFileSync(plist, "utf8");
    const r = await bin(w, ["init", "--others"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(readFileSync(plist, "utf8")).toBe(before);
    // 生成した内容と違う plist は、黙って上書きしない
    writeFileSync(plist, `${before}<!-- 手で足した -->\n`);
    const edited = await bin(w, ["init", "--others"]);
    expect(edited.exitCode).toBe(1);
    expect(edited.stderr).toContain("黙って上書きしない");
    expect(readFileSync(plist, "utf8")).toContain("手で足した");
    // 別名の daemon がなければ、何もしない
    rmSync(plist);
    expect((await bin(w, ["init", "--others"])).exitCode).toBe(0);
    expect(existsSync(plist)).toBe(false);
    // ほかの引数とは同時に指定できない
    expect((await bin(w, ["init", "--others", "--config", w.otherConfig])).exitCode).toBe(2);
  });

  it("--config が既定の設定と同じなら、既定の daemon として扱う", () => {
    const w = makeWorld();
    expect(daemonNameOf(w.base, w.defaultConfig)).toBe("daemon");
    expect(daemonNameOf(w.base, w.otherConfig)).toMatch(/^daemon-[0-9a-f]{8}$/);
  });
});
