import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "../src/bin.js";
import { daemonNameOf, LSREGISTER } from "../src/launchd.js";
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
      const label = (rest[1] as string).split("/").at(-1)?.replace(/\.plist$/, "") as string;
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
    loaded,
    calls,
    ls,
    launchd: {
      run,
      uid: () => uid,
      probe: async (port: number) => (port === 4321 || port === 4322 ? 401 : undefined),
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
    expect(w.calls.some((c) => c[1] === "kickstart" && c.at(-1)?.endsWith(w.otherLabel))).toBe(true);
    expect(w.calls.filter((c) => c[1] === "kickstart" && c.at(-1)?.endsWith("touryou.daemon")).length).toBe(0);

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

  it("--config が既定の設定と同じなら、既定の daemon として扱う", () => {
    const w = makeWorld();
    expect(daemonNameOf(w.base, w.defaultConfig)).toBe("daemon");
    expect(daemonNameOf(w.base, w.otherConfig)).toMatch(/^daemon-[0-9a-f]{8}$/);
  });
});
