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
  it("別名の daemon の探す場所は、--others の対象と同じ LaunchAgents（init しただけの plist は数えない）", () => {
    const fn = script.slice(
      script.indexOf("has_extra_daemons() {"),
      script.indexOf("cleanup_lists() {"),
    );
    expect(fn).toContain('"${HOME}/Library/LaunchAgents/"touryou.daemon-????????.plist');
    expect(fn).toContain('"${HOME}/Library/LaunchAgents/"*.touryou.daemon-????????.plist');
    expect(fn).not.toContain('"${HOME}/.touryou/launchd/"touryou.daemon-');
  });
  it("冒頭の説明も、LaunchAgents に置いたものと書いている", () => {
    expect(script).toContain("LaunchAgents に置いたもの。[<org>.]touryou.daemon-<8 文字>.plist");
  });
  it("変数は、コメントも ${NAME} の形で書く（$HOME のように括弧なしで書かない）", () => {
    const bare = script
      .split("\n")
      .filter((l) => l.trimStart().startsWith("#") && /\$[A-Za-z_]/.test(l));
    expect(bare).toEqual([]);
  });
  it("付け替えのあとに、別名の daemon の plist を新しい版で作り直してから、起動し直す", () => {
    // restore_old の中にも init --others がある。付け替えのあとの最後の 1 つを見る
    const init = script.lastIndexOf('"${BASE}/current/bin/touryou" launchd init --others');
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
  it("止める前に、別名の daemon の設定も、新しい版の --check-config で検査する", () => {
    const check = script.indexOf("plist_config_of \"${extra_plist}\"");
    const stop = script.indexOf('launchd stop --others');
    expect(check).toBeGreaterThan(-1);
    expect(script).toContain('"${VDIR}/${DIST_DIR}/bin/touryou-daemon" --check-config --config "${extra_cfg}"');
    expect(stop).toBeGreaterThan(check);
    // 検査は、LaunchAgents に置いた plist（init --others・stop --others の対象と同じ集合）だけを見る
    expect(script).toContain("extra_daemon_plists");
  });
  it("巻き戻しは、別名の daemon も旧版の launchd init --others で plist を旧版の形に戻してから、apply --others する", () => {
    const fn = script.slice(script.indexOf("restore_old() {"), script.indexOf("check_kinds() {"));
    const init = fn.indexOf('"${BASE}/current/bin/touryou" launchd init --others');
    const apply = fn.indexOf('"${BASE}/current/bin/touryou" launchd apply --yes --others');
    expect(init).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(init);
  });
  it("init --others・has_extra_daemons・stop --others は、同じ LaunchAgents の集合を対象にする（壊れた未使用の plist で巻き戻さない）", () => {
    const fn = script.slice(
      script.indexOf("has_extra_daemons() {"),
      script.indexOf("cleanup_lists() {"),
    );
    expect(fn).toContain("extra_daemon_plists");
    expect(fn).not.toContain('"${HOME}/.touryou/launchd/"');
  });
  it("別名の daemon があることを LAUNCHD_OTHERS で知らせる", () => {
    expect(script).toContain("LAUNCHD_OTHERS: present");
  });
});
