import { describe, expect, it } from "vitest";
import { resolveVersion, versionLine } from "../src/version.js";

// 版の決め方（#64: launchd が同梱の node で daemon を直に起こすときは、配布物の版の印 lib/dist-version から読む）
describe("resolveVersion", () => {
  it("TOURYOU_DIST_VERSION があれば、それを使う（版の印より先）", () => {
    const v = resolveVersion({
      packageVersion: "0.0.1",
      env: { TOURYOU_DIST_VERSION: "0.2.0" },
      distVersion: "0.1.9\n",
    });
    expect(v).toEqual({ version: "0.2.0", source: "env" });
  });

  it("環境変数がなければ、版の印（前後の空白は除く）を使い、開発ビルドの印を付けない", () => {
    const v = resolveVersion({ packageVersion: "0.0.1", env: {}, distVersion: "0.2.0-rc.1\n" });
    expect(v).toEqual({ version: "0.2.0-rc.1", source: "dist" });
    expect(versionLine(v)).toBe("0.2.0-rc.1");
  });

  it("版の印があるのに空・形が違えば、unknown（開発ビルドと見分けがつく）", () => {
    for (const distVersion of ["", "\n", "1.0.0 extra", "x".repeat(65)]) {
      const v = resolveVersion({ packageVersion: "0.0.1", env: {}, distVersion });
      expect(v, JSON.stringify(distVersion)).toEqual({ version: "unknown", source: "dist" });
      expect(versionLine(v)).toBe("unknown");
    }
    expect(versionLine(resolveVersion({ packageVersion: "0.0.1" }))).toBe("0.0.1（開発ビルド）");
  });
});
