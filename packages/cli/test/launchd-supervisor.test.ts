import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  reportLine,
  runSupervisorCommand,
  SUPERVISOR_LABEL,
  type SupervisorCommandDeps,
  supervisorPlistText,
  supervisorProgramArguments,
} from "../src/launchd-supervisor.js";
import { readRegistry, registryPath } from "../src/registry.js";

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "supv-")));

function setup() {
  const home = tmp();
  mkdirSync(join(home, ".touryou", "current"), { recursive: true });
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".touryou"), { recursive: true });
  const config = join(repo, ".touryou", "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(repo, ".touryou", "state") }));
  const calls: string[][] = [];
  const deps: SupervisorCommandDeps = {
    env: { HOME: home },
    cwd: () => repo,
    exists: (p) => p === config,
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: cmd === "launchctl" && args[0] === "print" ? 1 : 0, stdout: "", stderr: "" };
    },
    checkConfig: () => ({ status: 0, stdout: "", stderr: "" }),
    uid: () => 501,
  };
  return { home, repo, config, calls, deps };
}

describe("supervisor の plist", () => {
  const text = supervisorPlistText({
    programArguments: supervisorProgramArguments("/Users/u/.touryou"),
    workingDirectory: "/Users/u/.touryou",
    log: "/Users/u/.touryou/logs/supervisor.log",
    path: "/usr/bin:/bin",
  });
  it("Label・AbandonProcessGroup・supervisor run の引数を持つ", () => {
    expect(text).toContain(`<string>${SUPERVISOR_LABEL}</string>`);
    expect(text).toContain("<key>AbandonProcessGroup</key><true/>");
    expect(text).toContain("<string>supervisor</string>");
    expect(text).toContain("<string>run</string>");
    expect(text).toContain("/Users/u/.touryou/current/TouRyou.app/Contents/MacOS/TouRyou");
  });
});

describe("supervisor register / unregister", () => {
  it("検査を通った設定を登録簿に足し、外すのは登録だけ", async () => {
    const s = setup();
    const r = await runSupervisorCommand(["register"], s.deps);
    expect(r.exitCode).toBe(0);
    const reg = readRegistry(registryPath(s.home));
    expect(reg.kind === "ok" && reg.configs).toEqual([s.config]);
    const u = await runSupervisorCommand(["unregister", "--config", s.config], s.deps);
    expect(u.exitCode).toBe(0);
    const after = readRegistry(registryPath(s.home));
    expect(after.kind === "ok" && after.configs).toEqual([]);
  });
  it("設定の検査に落ちたら、登録しない", async () => {
    const s = setup();
    const r = await runSupervisorCommand(["register"], {
      ...s.deps,
      checkConfig: () => ({ status: 1, stdout: "", stderr: "bad" }),
    });
    expect(r.exitCode).toBe(1);
    expect(readRegistry(registryPath(s.home)).kind).not.toBe("broken");
  });
  it("--all と --config は同時に使えない", async () => {
    const s = setup();
    const r = await runSupervisorCommand(["unregister", "--all", "--config", s.config], s.deps);
    expect(r.exitCode).toBe(2);
  });
});

describe("supervisor apply / uninstall", () => {
  it("--yes がなければ何もしない", async () => {
    const s = setup();
    expect((await runSupervisorCommand(["apply"], s.deps)).exitCode).toBe(2);
    expect((await runSupervisorCommand(["uninstall"], s.deps)).exitCode).toBe(2);
    expect(s.calls).toEqual([]);
  });
  it("apply --yes は plist を置いて bootstrap する", async () => {
    const s = setup();
    const r = await runSupervisorCommand(["apply", "--yes"], s.deps);
    expect(r.exitCode).toBe(0);
    const dest = join(s.home, "Library", "LaunchAgents", `${SUPERVISOR_LABEL}.plist`);
    expect(readFileSync(dest, "utf8")).toContain("AbandonProcessGroup");
    expect(s.calls.some((c) => c[0] === "launchctl" && c[1] === "bootstrap" && c[2] === "gui/501")).toBe(
      true,
    );
  });
  it("uninstall --yes は、生成した plist を消す", async () => {
    const s = setup();
    await runSupervisorCommand(["apply", "--yes"], s.deps);
    const r = await runSupervisorCommand(["uninstall", "--yes"], s.deps);
    expect(r.exitCode).toBe(0);
    expect(() =>
      readFileSync(join(s.home, "Library", "LaunchAgents", `${SUPERVISOR_LABEL}.plist`)),
    ).toThrow();
  });
});

describe("supervisor restart / status", () => {
  it("daemon が動いていなければ、何も送らない", async () => {
    const s = setup();
    await runSupervisorCommand(["register"], s.deps);
    const killed: number[] = [];
    const r = await runSupervisorCommand(["restart"], {
      ...s.deps,
      kill: (pid) => killed.push(pid),
    });
    expect(r.exitCode).toBe(0);
    expect(killed).toEqual([]);
  });
  it("status は、登録した設定の daemon の有無を出す", async () => {
    const s = setup();
    await runSupervisorCommand(["register"], s.deps);
    const r = await runSupervisorCommand(["status"], s.deps);
    expect(r.stdout).toContain(s.config);
    expect(r.stdout).toContain("daemon が動いていない");
  });
});

describe("reportLine", () => {
  it("登録簿が壊れていれば、理由を出す", () => {
    expect(reportLine({ kind: "broken", reason: "r", fix: "f" } as never)).toContain("登録簿が使えない");
  });
});
