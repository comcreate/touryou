import { describe, expect, it } from "vitest";
import { CONFIG_NOT_FOUND_FIX, findConfigUpward, locateConfig } from "../src/config-locate.js";

const has =
  (...files: string[]) =>
  (p: string): boolean =>
    files.includes(p);

describe("locateConfig", () => {
  it("--config が最優先（環境変数・cwd より先）", () => {
    const r = locateConfig({
      arg: "/a/config.json",
      env: { TOURYOU_DAEMON_CONFIG: "/b/config.json" },
      cwd: "/repo",
      exists: has("/repo/.touryou/config.json"),
    });
    expect(r).toEqual({ ok: true, path: "/a/config.json", source: "arg" });
  });

  it("環境変数が cwd より先。空の環境変数・空の --config は無視", () => {
    expect(
      locateConfig({
        env: { TOURYOU_DAEMON_CONFIG: "/b/config.json" },
        cwd: "/repo",
        exists: has("/repo/.touryou/config.json"),
      }),
    ).toEqual({ ok: true, path: "/b/config.json", source: "env" });
    expect(
      locateConfig({
        arg: "",
        env: { TOURYOU_DAEMON_CONFIG: "" },
        cwd: "/repo",
        exists: has("/repo/.touryou/config.json"),
      }),
    ).toEqual({ ok: true, path: "/repo/.touryou/config.json", source: "cwd" });
  });

  it("どの深さの cwd からも上へ見つかる。いちばん近いものを選ぶ", () => {
    const exists = has("/repo/.touryou/config.json", "/repo/pkg/.touryou/config.json");
    expect(locateConfig({ env: {}, cwd: "/repo", exists })).toMatchObject({
      path: "/repo/.touryou/config.json",
    });
    expect(locateConfig({ env: {}, cwd: "/repo/a/b/c/d", exists })).toMatchObject({
      path: "/repo/.touryou/config.json",
    });
    expect(locateConfig({ env: {}, cwd: "/repo/pkg/src", exists })).toMatchObject({
      path: "/repo/pkg/.touryou/config.json",
    });
    expect(locateConfig({ env: {}, cwd: "/repo/", exists })).toMatchObject({
      path: "/repo/.touryou/config.json",
    });
  });

  it("子の cwd（<repoRoot>/.touryou/worktrees/<子>）からも、親のリポジトリの設定に届く", () => {
    const r = locateConfig({
      env: {},
      cwd: "/repo/.touryou/worktrees/child-1/src",
      exists: has("/repo/.touryou/config.json"),
    });
    expect(r).toEqual({ ok: true, path: "/repo/.touryou/config.json", source: "cwd" });
  });

  it("ルート直下の .touryou も見つかる", () => {
    expect(findConfigUpward("/x/y", has("/.touryou/config.json"))).toBe("/.touryou/config.json");
  });

  it("見つからないときは、理由と直し方を返す（旧パス $HOME/.touryou/config.json へ戻らない）", () => {
    const r = locateConfig({
      env: { HOME: "/home/u" },
      cwd: "/home/u/work/other",
      exists: has("/home/u/work/other-repo/.touryou/config.json"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("見つからない");
      expect(r.fix).toBe(CONFIG_NOT_FOUND_FIX);
      expect(r.fix).toContain("/touryou:setup");
      expect(r.fix).toContain("--config");
    }
  });

  it("cwd が分からない・絶対パスでないときは止まる", () => {
    expect(locateConfig({ env: {}, exists: () => true }).ok).toBe(false);
    expect(locateConfig({ env: {}, cwd: "rel", exists: () => true }).ok).toBe(false);
  });
});
