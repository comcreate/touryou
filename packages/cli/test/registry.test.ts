import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addToRegistry,
  inspectEntries,
  readRegistry,
  registryPath,
  removeFromRegistry,
} from "../src/registry.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "touryou-registry-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("登録簿", () => {
  it("ファイルがなければ空で、登録・重複の登録・外すが読み書きに反映される", () => {
    const p = registryPath(home);
    expect(readRegistry(p)).toEqual({ kind: "ok", configs: [] });
    expect(addToRegistry(p, "/r/a/.touryou/config.json").ok).toBe(true);
    expect(addToRegistry(p, "/r/a/.touryou/config.json").ok).toBe(true);
    expect(addToRegistry(p, "/r/b/.touryou/config.json").ok).toBe(true);
    expect(readRegistry(p)).toEqual({
      kind: "ok",
      configs: ["/r/a/.touryou/config.json", "/r/b/.touryou/config.json"],
    });
    expect(removeFromRegistry(p, "/r/a/.touryou/config.json").ok).toBe(true);
    expect(readRegistry(p)).toEqual({ kind: "ok", configs: ["/r/b/.touryou/config.json"] });
  });

  it("相対パスは登録しない", () => {
    expect(addToRegistry(registryPath(home), "a/config.json").ok).toBe(false);
  });

  it.each([
    ["JSON でない", "{oops"],
    ["configs が配列でない", '{"configs":"x"}'],
    ["相対パスがある", '{"configs":["a/config.json"]}'],
  ])("壊れた登録簿（%s）は全体を壊れとして返し、再登録の手順を出し、書き足さない", (_n, body) => {
    const p = registryPath(home);
    mkdirSync(join(home, ".touryou"));
    writeFileSync(p, body);
    const r = readRegistry(p);
    expect(r.kind).toBe("broken");
    if (r.kind === "broken") expect(r.fix).toContain("/touryou:setup");
    const w = addToRegistry(p, "/r/a/.touryou/config.json");
    expect(w.ok).toBe(false);
    expect(readFileSync(p, "utf8")).toBe(body);
  });

  it("消えたパスは、理由つきで返すだけで、登録簿から自動では外さない", () => {
    const p = registryPath(home);
    const gone = join(home, "gone", ".touryou", "config.json");
    addToRegistry(p, gone);
    const [item] = inspectEntries(readRegistry(p).kind === "ok" ? [gone] : []);
    expect(item?.present).toBe(false);
    if (item && !item.present) expect(item.reason).toContain("起動しない");
    expect(existsSync(p)).toBe(true);
    expect(readRegistry(p)).toEqual({ kind: "ok", configs: [gone] });
  });
});
