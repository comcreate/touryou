import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MigrateDeps, copyStateTree, runMigrate } from "../src/migrate.js";
import { readRegistry, registryPath } from "../src/registry.js";

let home: string;
let repo: string;
let calls: string[];

const OLD_CONFIG = () => join(home, ".touryou", "config.json");
const OLD_STATE = () => join(home, ".touryou", "state");
const NEW_DIR = () => join(repo, ".touryou");
const NEW_CONFIG = () => join(NEW_DIR(), "config.json");
const NEW_STATE = () => join(NEW_DIR(), "state");

const ok = { exitCode: 0 as const, stdout: "", stderr: "" };

/** 前の置き場（設定・state・DB のつもりのファイル）を作る。 */
function seedLegacy(): void {
  mkdirSync(OLD_STATE(), { recursive: true, mode: 0o700 });
  writeFileSync(join(OLD_STATE(), "touryou.db"), "db-bytes", { mode: 0o600 });
  writeFileSync(join(OLD_STATE(), "daemon.pid"), "999999");
  mkdirSync(join(OLD_STATE(), "sub"), { mode: 0o700 });
  writeFileSync(join(OLD_STATE(), "sub", "a.txt"), "a", { mode: 0o600 });
  writeFileSync(
    OLD_CONFIG(),
    JSON.stringify({ repoRoot: repo, stateDir: OLD_STATE(), extra: 1 }),
    { mode: 0o600 },
  );
}

/** 旧の設定・state の中身（変わっていないことの確認用）。 */
function snapshotLegacy(): string {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [`${join(d, e.name)}=${readFileSync(join(d, e.name), "utf8")}`],
      )
      .sort();
  return `${readFileSync(OLD_CONFIG(), "utf8")}\n${walk(OLD_STATE()).join("\n")}`;
}

function makeDeps(over: Partial<MigrateDeps> = {}): MigrateDeps {
  return {
    env: { HOME: home },
    checkConfig: () => ({ status: 0, stdout: "", stderr: "" }),
    run: (cmd, args) => {
      calls.push(`run ${cmd.split("/").pop()} ${args.join(" ")}`);
      return { status: 1, stdout: "", stderr: "" }; // launchctl print: 読み込まれていない
    },
    uid: () => 501,
    launchd: async (argv) => {
      calls.push(`launchd ${argv.join(" ")}`);
      return ok;
    },
    supervisor: async (argv) => {
      calls.push(`supervisor ${argv.join(" ")}`);
      // supervisor が daemon を起こしたことにする（pid・port を書く）
      writeFileSync(join(NEW_STATE(), "daemon.pid"), String(process.pid));
      writeFileSync(join(NEW_STATE(), "port"), "4000");
      return ok;
    },
    probe: async () => 401,
    isPidAlive: (pid) => pid === process.pid, // 前の state の pid（999999）は止まっている
    kill: () => {},
    sleep: async () => {},
    stopWaitMs: 1,
    startWaitMs: 1,
    ...over,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "touryou-migrate-home-"));
  repo = mkdtempSync(join(tmpdir(), "touryou-migrate-repo-"));
  calls = [];
  seedLegacy();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("runMigrate", () => {
  it("--yes がなければ、何もしない", async () => {
    const before = snapshotLegacy();
    const r = await runMigrate([], makeDeps());
    expect(r.exitCode).toBe(2);
    expect(existsSync(NEW_DIR())).toBe(false);
    expect(snapshotLegacy()).toBe(before);
  });

  it("前の設定がなければ、移すものがないと伝えて何もしない", async () => {
    rmSync(OLD_CONFIG());
    const r = await runMigrate(["--yes"], makeDeps());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("移行するものがない");
    expect(existsSync(NEW_DIR())).toBe(false);
  });

  it("コピー → 検査 → 切り替えを行い、元は消さない", async () => {
    const before = snapshotLegacy();
    const r = await runMigrate(["--yes"], makeDeps());
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const next = JSON.parse(readFileSync(NEW_CONFIG(), "utf8")) as Record<string, unknown>;
    expect(next.stateDir).toBe(NEW_STATE());
    expect(next.repoRoot).toBe(repo);
    expect(next.extra).toBe(1); // 知らない値は保つ
    expect(statSync(NEW_CONFIG()).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(NEW_STATE(), "touryou.db"), "utf8")).toBe("db-bytes");
    expect(readFileSync(join(NEW_STATE(), "sub", "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(NEW_DIR(), "config.json.migrating"))).toBe(false);
    expect(readRegistry(registryPath(home))).toEqual({ kind: "ok", configs: [NEW_CONFIG()] });
    expect(calls).toContain("supervisor apply --yes");
    expect(snapshotLegacy()).toBe(before); // 元の設定・state は、そのまま
  });

  it("前の常駐があれば、新しい daemon が応答してから外す", async () => {
    const agents = join(home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "touryou.daemon.plist"), "<plist/>");
    const order: string[] = [];
    const r = await runMigrate(
      ["--yes"],
      makeDeps({
        run: (cmd, args) => {
          calls.push(`run ${cmd.split("/").pop()} ${args.join(" ")}`);
          return { status: 0, stdout: "", stderr: "" };
        },
        launchd: async (argv) => {
          order.push(`launchd ${argv[0]}`);
          return ok;
        },
        supervisor: async (argv) => {
          order.push(`supervisor ${argv[0]}`);
          writeFileSync(join(NEW_STATE(), "daemon.pid"), String(process.pid));
          writeFileSync(join(NEW_STATE(), "port"), "4000");
          return ok;
        },
        isPidAlive: (pid) => pid === process.pid,
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(order).toEqual(["launchd stop", "supervisor apply", "launchd uninstall"]);
  });

  describe("途中で失敗しても、元のまま動く（元の設定・state が変わらない）", () => {
    it("コピーの失敗: 途中まで書いたものを消し、登録簿に足さない", async () => {
      const before = snapshotLegacy();
      const r = await runMigrate(
        ["--yes"],
        makeDeps({
          copyState: (_from, to) => {
            mkdirSync(to, { mode: 0o700 });
            writeFileSync(join(to, "partial"), "x");
            throw new Error("disk full");
          },
        }),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("disk full");
      expect(existsSync(NEW_STATE())).toBe(false);
      expect(existsSync(NEW_DIR())).toBe(false); // 作った空のディレクトリも戻す
      expect(readRegistry(registryPath(home))).toEqual({ kind: "ok", configs: [] });
      expect(calls.some((c) => c.startsWith("supervisor"))).toBe(false);
      expect(snapshotLegacy()).toBe(before);
    });

    it("検査の失敗: 設定も state も置かず、.gitignore の案内を添える", async () => {
      const before = snapshotLegacy();
      const r = await runMigrate(
        ["--yes"],
        makeDeps({ checkConfig: () => ({ status: 1, stdout: "", stderr: "stateDir is not ignored" }) }),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(".gitignore");
      expect(existsSync(NEW_CONFIG())).toBe(false);
      expect(existsSync(join(NEW_DIR(), "config.json.migrating"))).toBe(false);
      expect(existsSync(NEW_STATE())).toBe(false);
      expect(readRegistry(registryPath(home))).toEqual({ kind: "ok", configs: [] });
      expect(calls.some((c) => c.startsWith("supervisor"))).toBe(false);
      expect(snapshotLegacy()).toBe(before);
    });

    it("切り替えの失敗（supervisor が失敗）: 新しいものを戻し、止めた前の常駐を起動し直す", async () => {
      const agents = join(home, "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "touryou.daemon.plist"), "<plist/>");
      const before = snapshotLegacy();
      const r = await runMigrate(
        ["--yes"],
        makeDeps({
          run: () => ({ status: 0, stdout: "", stderr: "" }), // 前の常駐は読み込み済み
          isPidAlive: () => false,
          supervisor: async () => ({ exitCode: 1, stdout: "", stderr: "boom\n" }),
        }),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("boom");
      expect(existsSync(NEW_CONFIG())).toBe(false);
      expect(existsSync(NEW_STATE())).toBe(false);
      expect(readRegistry(registryPath(home))).toEqual({ kind: "ok", configs: [] });
      expect(calls).toContain("launchd stop");
      expect(calls).toContain("launchd apply --yes"); // 起動し直した
      expect(calls).not.toContain("launchd uninstall --yes"); // 前の常駐は外していない
      expect(existsSync(join(agents, "touryou.daemon.plist"))).toBe(true);
      expect(snapshotLegacy()).toBe(before);
    });

    it("切り替えの失敗（登録簿が壊れている）: 何も作らない", async () => {
      mkdirSync(join(home, ".touryou"), { recursive: true });
      writeFileSync(registryPath(home), "{not json");
      const before = snapshotLegacy();
      const r = await runMigrate(["--yes"], makeDeps());
      expect(r.exitCode).toBe(1);
      expect(existsSync(NEW_DIR())).toBe(false);
      expect(snapshotLegacy()).toBe(before);
    });

    it("新しい daemon が応答しない: 戻す（前の常駐を外さない）", async () => {
      const before = snapshotLegacy();
      const r = await runMigrate(["--yes"], makeDeps({ probe: async () => undefined, isPidAlive: () => false }));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("応答しない");
      expect(existsSync(NEW_CONFIG())).toBe(false);
      expect(existsSync(NEW_STATE())).toBe(false);
      expect(readRegistry(registryPath(home))).toEqual({ kind: "ok", configs: [] });
      expect(snapshotLegacy()).toBe(before);
    });

    it("前の daemon が止まらない: コピーせずに断る", async () => {
      // 前の state の daemon.pid が生きていて、窓口も応答する（手で起こした daemon のつもり）
      writeFileSync(join(OLD_STATE(), "port"), "4000");
      writeFileSync(join(OLD_STATE(), "daemon.pid"), String(process.pid));
      const before = snapshotLegacy();
      const r = await runMigrate(["--yes"], makeDeps({ isPidAlive: () => true }));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("まだ動いている");
      expect(existsSync(NEW_DIR())).toBe(false);
      expect(snapshotLegacy()).toBe(before);
    });
  });

  it("新しい置き場に設定がすでにあれば、上書きせず断る", async () => {
    mkdirSync(NEW_DIR(), { recursive: true });
    writeFileSync(NEW_CONFIG(), "{}");
    const r = await runMigrate(["--yes"], makeDeps());
    expect(r.exitCode).toBe(1);
    expect(readFileSync(NEW_CONFIG(), "utf8")).toBe("{}");
    expect(existsSync(NEW_STATE())).toBe(false);
  });
});

describe("copyStateTree", () => {
  it("daemon.pid は写さず、権限を保つ", () => {
    const to = join(repo, "copied");
    copyStateTree(OLD_STATE(), to);
    expect(existsSync(join(to, "daemon.pid"))).toBe(false);
    expect(statSync(to).mode & 0o777).toBe(0o700);
    expect(statSync(join(to, "touryou.db")).mode & 0o777).toBe(0o600);
  });

  it("シンボリックリンクは、コピーせずに例外にする", () => {
    symlinkSync("/etc/hosts", join(OLD_STATE(), "link"));
    expect(() => copyStateTree(OLD_STATE(), join(repo, "copied"))).toThrow(/リンク/);
  });
});
