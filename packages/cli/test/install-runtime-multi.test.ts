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
  it("別名の daemon の探す場所は、--others が見る場所（launchd init の出力先）と同じ", () => {
    expect(script).toContain('"${HOME}/.touryou/launchd/"touryou.daemon-????????.plist');
    expect(script).not.toContain('"${HOME}/Library/LaunchAgents/"touryou.daemon-????????.plist');
  });
  it("付け替えのあとに、別名の daemon の plist を新しい版で作り直してから、起動し直す", () => {
    const init = script.indexOf('"${BASE}/current/bin/touryou" launchd init --others');
    const swap = script.indexOf('swap_link "${VDIR}/${DIST_DIR}" "${BASE}/current"');
    // restore_old の中にも apply --others がある。付け替えのあとの最後の 1 つを見る
    const apply = script.lastIndexOf('"${BASE}/current/bin/touryou" launchd apply --yes --others');
    expect(swap).toBeGreaterThan(-1);
    expect(init).toBeGreaterThan(swap);
    expect(apply).toBeGreaterThan(init);
    expect(script).toContain("launchd init --others が通らなかった");
  });
  it("別名の daemon を止めて、付け替えのあとに起動し直す", () => {
    expect(script).toContain("launchd stop --others");
    expect(script).toContain("launchd apply --yes --others");
  });
  it("別名の daemon があることを LAUNCHD_OTHERS で知らせる", () => {
    expect(script).toContain("LAUNCHD_OTHERS: present");
  });
});
