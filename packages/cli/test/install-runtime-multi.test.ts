import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  fileURLToPath(new URL("../../../plugin/scripts/install-runtime.sh", import.meta.url)),
  "utf8",
);

describe("install-runtime.sh の版上げ（複数の daemon。#165）", () => {
  it("別名の daemon の plist を探す", () => {
    expect(script).toContain("has_extra_daemons");
    expect(script).toContain("touryou.daemon-????????.plist");
  });
  it("別名の daemon を止めて、付け替えのあとに起動し直す", () => {
    expect(script).toContain("launchd stop --others");
    expect(script).toContain("launchd apply --yes --others");
  });
  it("別名の daemon があることを LAUNCHD_OTHERS で知らせる", () => {
    expect(script).toContain("LAUNCHD_OTHERS: present");
  });
});
