// plugin/scripts/install-runtime.sh の、別名の daemon（touryou launchd init --config。#165）の扱いを、実際に script を走らせて確かめる。
// 形は scripts/install-runtime.test.mjs と同じ: script を source して platform・has_git・fetch だけを差し替え、main を呼ぶ。
// 偽の touryou（呼ばれた引数を ${HOME}/calls.log に足す）・偽の touryou-daemon（--check-config）・偽の HOME を使い、ネットワークには出ない。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

// script を実際に走らせる（tar の作成・展開を含む）重い試験が多く、並列の実行では 5 秒を超えることがある
vi.setConfig({ testTimeout: 30_000 });

const SCRIPT = fileURLToPath(
  new URL("../../../plugin/scripts/install-runtime.sh", import.meta.url),
);
const script = readFileSync(SCRIPT, "utf8");

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "touryou-multi-"));
  made.push(d);
  return d;
};
const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");

/**
 * 仮の配布物（tar.gz）。偽の touryou は、`v<版> <引数>` を ${HOME}/calls.log に足し、`${FAIL_ON}` に書いた
 * 引数の並び（「;」区切り。`v<版> ` を付けない）と一致する呼び出しだけ終了コード 1 にする。
 * 偽の touryou-daemon は、--config の値に `bad` を含むときだけ --check-config が通らない。
 */
const makeTarball = (ver: string, opts: { daemonReadsStdin?: boolean } = {}): string => {
  const d = tmp();
  const bin = join(d, "touryou-darwin-arm64", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "touryou-daemon"),
    `#!/bin/sh
[ "$1" = "--help" ] && { echo "usage: touryou-daemon"; exit 0; }
if [ "$1" = "--check-config" ]; then
${opts.daemonReadsStdin === true ? "  cat >/dev/null" : "  :"}
  echo "$3" >> "$HOME/checked.log"
  case "$3" in *bad*) echo "失敗 [invalidConfig]: 設定が通らない" >&2; exit 1 ;; esac
  exit 0
fi
exit 0
`,
  );
  writeFileSync(
    join(bin, "touryou"),
    `#!/bin/sh
echo "v${ver} $*" >> "$HOME/calls.log"
args="$*"
# FAIL_REPEAT に書いた引数の並びは、同じ版での 2 回目以降の呼び出しだけ失敗にする（restore_old の呼び出しだけを失敗させる）
if [ "\${FAIL_REPEAT:-}" = "$args" ] && [ "$(grep -c -x "v${ver} $args" "$HOME/calls.log")" -ge 2 ]; then exit 1; fi
old_ifs="$IFS"; IFS=";"
for f in \${FAIL_ON:-}; do
  if [ "$f" = "$args" ] || [ "$f" = "v${ver} $args" ]; then IFS="$old_ifs"; exit 1; fi
done
IFS="$old_ifs"
exit 0
`,
  );
  chmodSync(join(bin, "touryou-daemon"), 0o755);
  chmodSync(join(bin, "touryou"), 0o755);
  const out = join(tmp(), `touryou-${ver}-darwin-arm64.tar.gz`);
  const r = spawnSync("tar", ["-czf", out, "-C", d, "touryou-darwin-arm64"]);
  expect(r.status, String(r.stderr)).toBe(0);
  return out;
};

/** 仮の plugin（script の写しと checksums.json・plugin.json）。 */
const makePlugin = (ver: string, tarball: string): string => {
  const P = join(tmp(), "plugin");
  mkdirSync(join(P, "scripts"), { recursive: true });
  mkdirSync(join(P, ".claude-plugin"), { recursive: true });
  copyFileSync(SCRIPT, join(P, "scripts", "install-runtime.sh"));
  const name = `touryou-${ver}-darwin-arm64.tar.gz`;
  const json = {
    version: ver,
    assets: { "darwin-arm64": { name, sha256: sha(tarball) } },
    extensions: { mcpb: { name: `touryou-mcp-${ver}.mcpb`, sha256: "0".repeat(64) } },
  };
  writeFileSync(join(P, "checksums.json"), `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(
    join(P, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "touryou", version: ver, repository: "https://github.com/comcreate/touryou" }, null, 2)}\n`,
  );
  return P;
};

const run = (
  P: string,
  home: string,
  tarball: string,
  args: string[] = [],
  env: Record<string, string> = {},
  cwd: string = tmpdir(),
) => {
  const body = [
    'source "$1"; shift',
    'platform() { echo "Darwin arm64"; }',
    "has_git() { :; }",
    'fetch() { cp "$SRC" "$2"; }',
    'main "$@"',
  ].join("\n");
  return spawnSync("bash", ["-c", body, "_", join(P, "scripts", "install-runtime.sh"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, SRC: tarball, ...env },
    encoding: "utf8",
    cwd,
  });
};
const out = (r: { stdout: string; stderr: string }): string => `${r.stdout}${r.stderr}`;
const lines = (f: string): string[] =>
  existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : [];

/** 別名の daemon の plist の中身（ProgramArguments の --config の次の行が、設定のパス）。 */
const aliasPlist = (cfg: string): string =>
  `<plist><dict><key>ProgramArguments</key><array>
    <string>/x/touryou-daemon</string>
    <string>--config</string>
    <string>${cfg}</string>
  </array></dict></plist>\n`;

const PLIST_ALIAS = "touryou.daemon-0123abcd.plist";

/** v0.9.0 が入った HOME。別名の plist（名前 → 設定のパス）を LaunchAgents に置く。 */
const homeWith = (aliases: Record<string, string>, opts: { defaultPlist?: boolean } = {}) => {
  const old = makeTarball("0.9.0");
  const h = join(tmp(), "home");
  mkdirSync(h);
  expect(run(makePlugin("0.9.0", old), h, old).status).toBe(0);
  const agents = join(h, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  if (opts.defaultPlist) writeFileSync(join(agents, "touryou.daemon.plist"), "<plist/>");
  for (const [name, cfg] of Object.entries(aliases))
    writeFileSync(join(agents, name), aliasPlist(cfg));
  return h;
};

const OLD = (h: string): string => join(h, ".touryou", "v0.9.0", "touryou-darwin-arm64");
const NEW = (h: string): string => join(h, ".touryou", "v1.0.0", "touryou-darwin-arm64");

/** 版上げを --restart-daemon で走らせる。 */
const upgrade = (h: string, env: Record<string, string> = {}) => {
  const tb = makeTarball("1.0.0");
  return run(makePlugin("1.0.0", tb), h, tb, ["--restart-daemon"], env);
};

describe("別名の daemon の plist の検出（extra_daemon_plists・has_extra_daemons）", () => {
  const detect = (home: string) =>
    spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; has_extra_daemons && echo HAS || echo NONE; extra_daemon_plists',
        "_",
        SCRIPT,
      ],
      { env: { PATH: process.env.PATH ?? "", HOME: home }, encoding: "utf8" },
    );
  const homeOnly = (names: string[]): string => {
    const h = join(tmp(), "home");
    mkdirSync(join(h, "Library", "LaunchAgents"), { recursive: true });
    for (const n of names) writeFileSync(join(h, "Library", "LaunchAgents", n), "<plist/>");
    return h;
  };

  it("小文字の 16 進 8 文字の名前（組織名つきも）だけを拾う", () => {
    const h = homeOnly([PLIST_ALIAS, "com.example.touryou.daemon-89abcdef.plist"]);
    const r = detect(h);
    expect(r.status).toBe(0);
    const [first, ...found] = r.stdout.trim().split("\n");
    expect(first).toBe("HAS");
    expect(found.sort()).toEqual([
      join(h, "Library", "LaunchAgents", "com.example.touryou.daemon-89abcdef.plist"),
      join(h, "Library", "LaunchAgents", PLIST_ALIAS),
    ]);
  });
  it("16 進でない 8 文字・大文字・長さの違う名前は拾わない（TS 側の OTHER_PLIST と同じ）", () => {
    const h = homeOnly([
      "touryou.daemon-zzzzzzzz.plist",
      "touryou.daemon-0123ABCD.plist",
      "touryou.daemon-0123abc.plist",
      "touryou.daemon-0123abcde.plist",
      "touryou.daemon-backup.plist",
      "touryou.daemon.plist",
    ]);
    const r = detect(h);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("NONE");
  });
  it("組織の部分は、TS 側の OTHER_PLIST と同じ範囲（小文字の英数字とハイフンのラベルを、ドットでつないだもの）だけを拾う", () => {
    const inRange = [
      "a.touryou.daemon-0123abcd.plist",
      "a.b-c.touryou.daemon-0123abcd.plist",
      "0-9.x.touryou.daemon-0123abcd.plist",
    ];
    const outOfRange = [
      "Com.example.touryou.daemon-0123abcd.plist",
      "a_b.touryou.daemon-0123abcd.plist",
      ".touryou.daemon-0123abcd.plist",
      ".x.touryou.daemon-0123abcd.plist",
      "a..b.touryou.daemon-0123abcd.plist",
      "a b.touryou.daemon-0123abcd.plist",
    ];
    const h = homeOnly([...inRange, ...outOfRange]);
    const r = detect(h);
    expect(r.status).toBe(0);
    const [first, ...found] = r.stdout.trim().split("\n");
    expect(first).toBe("HAS");
    expect(found.sort()).toEqual(inRange.map((n) => join(h, "Library", "LaunchAgents", n)).sort());
  });
  it("範囲外の名前の plist だけなら、別名の daemon なしとして数える", () => {
    const h = homeOnly(["A.touryou.daemon-0123abcd.plist", "a_b.touryou.daemon-0123abcd.plist"]);
    expect(detect(h).stdout.trim()).toBe("NONE");
  });
  it("LaunchAgents にない（~/.touryou/launchd に init しただけの）plist は数えない", () => {
    const h = join(tmp(), "home");
    mkdirSync(join(h, ".touryou", "launchd"), { recursive: true });
    mkdirSync(join(h, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(h, ".touryou", "launchd", PLIST_ALIAS), "<plist/>");
    expect(detect(h).stdout.trim()).toBe("NONE");
  });
});

describe("finish の出力（LAUNCHD・LAUNCHD_OTHERS）", () => {
  it("別名の daemon だけが常駐: LAUNCHD: absent と LAUNCHD_OTHERS: present を出す（setup.md は、これで手順 3 を飛ばす）", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" });
    const tb = makeTarball("0.9.0");
    const r = run(makePlugin("0.9.0", tb), h, tb);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toMatch(/RESULT: already/);
    expect(r.stdout).toContain("LAUNCHD: absent");
    expect(r.stdout).toContain("LAUNCHD_OTHERS: present");
  });
  it("別名がなければ LAUNCHD_OTHERS を出さない", () => {
    const h = homeWith({});
    const tb = makeTarball("0.9.0");
    const r = run(makePlugin("0.9.0", tb), h, tb);
    expect(r.stdout).toContain("LAUNCHD: absent");
    expect(r.stdout).not.toContain("LAUNCHD_OTHERS");
  });
});

describe("finish の出力（CONFIG・SUPERVISOR。#300）", () => {
  const present = (dir: string): string => {
    mkdirSync(join(dir, ".touryou"), { recursive: true });
    writeFileSync(join(dir, ".touryou", "config.json"), "{}");
    return dir;
  };
  it("実行した場所から上へ <リポジトリ>/.touryou/config.json を探す（深い場所からでも見つかる）", () => {
    const h = homeWith({});
    const repo = present(join(tmp(), "repo"));
    const deep = join(repo, "a", "b");
    mkdirSync(deep, { recursive: true });
    const tb = makeTarball("0.9.0");
    const r = run(makePlugin("0.9.0", tb), h, tb, [], {}, deep);
    expect(r.stdout).toContain("CONFIG: present");
  });
  it("前の置き場（$HOME/.touryou/config.json）だけがあっても、CONFIG: absent（前の置き場には戻らない）", () => {
    const h = homeWith({});
    writeFileSync(join(h, ".touryou", "config.json"), "{}");
    const tb = makeTarball("0.9.0");
    const r = run(makePlugin("0.9.0", tb), h, tb, [], {}, h);
    expect(r.stdout).toContain("CONFIG: absent");
    expect(r.stdout).toContain("LEGACY_CONFIG: present"); // 移行（touryou migrate）の対象
  });
  it("前の置き場の設定がなければ LEGACY_CONFIG: absent。リンクは、あるとみなさない（#301）", () => {
    const h = homeWith({});
    const tb = makeTarball("0.9.0");
    expect(run(makePlugin("0.9.0", tb), h, tb, [], {}, h).stdout).toContain("LEGACY_CONFIG: absent");
    writeFileSync(join(h, "real.json"), "{}");
    symlinkSync(join(h, "real.json"), join(h, ".touryou", "config.json"));
    expect(run(makePlugin("0.9.0", tb), h, tb, [], {}, h).stdout).toContain("LEGACY_CONFIG: absent");
  });
  it("supervisor の plist が LaunchAgents にあれば SUPERVISOR: present、なければ absent", () => {
    const h = homeWith({});
    const tb = makeTarball("0.9.0");
    expect(run(makePlugin("0.9.0", tb), h, tb).stdout).toContain("SUPERVISOR: absent");
    writeFileSync(join(h, "Library", "LaunchAgents", "touryou.supervisor.plist"), "<plist/>");
    expect(run(makePlugin("0.9.0", tb), h, tb).stdout).toContain("SUPERVISOR: present");
  });
});

describe("版上げ（別名の daemon がある。#165）", () => {
  it("別名だけが常駐でも managed になり、同意がなければ何も変えずに終了コード 3", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" });
    const tb = makeTarball("1.0.0");
    const r = run(makePlugin("1.0.0", tb), h, tb);
    expect(r.status, out(r)).toBe(3);
    expect(r.stdout).toMatch(/RESULT: need-restart-consent/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    expect(lines(join(h, "calls.log"))).toEqual([]);
  });
  it("範囲外の名前の plist だけなら、同意を求めない（need-restart-consent にならず、そのまま版を上げる）", () => {
    const h = homeWith({ "A.touryou.daemon-0123abcd.plist": "/cfg/a.json" });
    const tb = makeTarball("1.0.0");
    const r = run(makePlugin("1.0.0", tb), h, tb);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).not.toMatch(/need-restart-consent/);
    expect(r.stdout).toMatch(/RESULT: upgraded/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(NEW(h));
    expect(lines(join(h, "calls.log"))).toEqual([]);
  });
  it("事前検査は、init の出力先の plist があればそれを読む（launchd の --others と同じ設定を検査する）", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/stale.json" });
    // init の出力先には、新しい設定を書いた plist がある（LaunchAgents のものは古いまま）
    mkdirSync(join(h, ".touryou", "launchd"), { recursive: true });
    writeFileSync(join(h, ".touryou", "launchd", PLIST_ALIAS), aliasPlist("/cfg/fresh.json"));
    const r = upgrade(h);
    expect(r.status, out(r)).toBe(0);
    expect(lines(join(h, "checked.log"))).toEqual(["/cfg/fresh.json"]);
  });
  it("--restart-daemon: 止める前に別名の設定を新しい版で検査 → stop --others → 付け替え → init --others → apply --yes --others", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" });
    const r = upgrade(h);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toMatch(/RESULT: upgraded-restarted/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(NEW(h));
    expect(lines(join(h, "checked.log"))).toEqual(["/cfg/a.json"]);
    // 既定の daemon はないので、引数なしの init・stop・apply は呼ばない
    expect(lines(join(h, "calls.log"))).toEqual([
      "v0.9.0 launchd init --others",
      "v0.9.0 launchd stop --others",
      "v1.0.0 launchd init --others",
      "v1.0.0 launchd apply --yes --others",
    ]);
  });
  it("別名が 2 つ以上: 2 つ目以降も、止める前に新しい版の --check-config で検査する（子が標準入力を奪わない）", () => {
    const h = homeWith({
      "touryou.daemon-11111111.plist": "/cfg/a.json",
      "touryou.daemon-22222222.plist": "/cfg/b.json",
      "touryou.daemon-33333333.plist": "/cfg/c.json",
    });
    // 偽の touryou-daemon が標準入力を読み切る（本物の子が標準入力を奪う場面）
    const tb = makeTarball("1.0.0", { daemonReadsStdin: true });
    const r = run(makePlugin("1.0.0", tb), h, tb, ["--restart-daemon"]);
    expect(r.status, out(r)).toBe(0);
    expect(lines(join(h, "checked.log")).sort()).toEqual([
      "/cfg/a.json",
      "/cfg/b.json",
      "/cfg/c.json",
    ]);
  });
  it("別名が 2 つ以上で、2 つ目の設定が検査を通らない: 標準入力を奪われても見逃さず、止める前に die する", () => {
    const h = homeWith({
      "touryou.daemon-11111111.plist": "/cfg/ok.json",
      "touryou.daemon-22222222.plist": "/cfg/bad.json",
    });
    const tb = makeTarball("1.0.0", { daemonReadsStdin: true });
    const r = run(makePlugin("1.0.0", tb), h, tb, ["--restart-daemon"]);
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/設定が、v1\.0\.0 の daemon の設定の検査を通らない/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    expect(lines(join(h, "calls.log"))).toEqual([]);
  });
  it("今の版の init --others が通らない（生成物の食い違い）: 何も止めず、current も変えずに終わる", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" });
    const r = upgrade(h, { FAIL_ON: "v0.9.0 launchd init --others" });
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/RESULT: failed/);
    expect(r.stdout).toMatch(/v0\.9\.0 の launchd init --others が通らない/);
    expect(r.stdout).toMatch(/daemon は止めていない（v0\.9\.0 のまま動いている）/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    // stop・apply は 1 つも呼んでいない
    expect(lines(join(h, "calls.log"))).toEqual(["v0.9.0 launchd init --others"]);
  });
  it("既定と別名の両方で、別名の init --others が通らない: 既定の daemon も止めない", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" }, { defaultPlist: true });
    writeFileSync(join(h, ".touryou", "config.json"), "{}\n");
    const r = upgrade(h, { FAIL_ON: "v0.9.0 launchd init --others" });
    expect(r.status, out(r)).toBe(1);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    expect(lines(join(h, "calls.log"))).toEqual([
      "v0.9.0 launchd init",
      "v0.9.0 launchd init --others",
    ]);
  });
  it("既定と別名の両方: 既定の分も呼び、別名の分は --others で続ける", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" }, { defaultPlist: true });
    writeFileSync(join(h, ".touryou", "config.json"), "{}\n");
    const r = upgrade(h);
    expect(r.status, out(r)).toBe(0);
    expect(lines(join(h, "calls.log"))).toEqual([
      "v0.9.0 launchd init",
      "v0.9.0 launchd init --others",
      "v0.9.0 launchd stop",
      "v0.9.0 launchd stop --others",
      "v1.0.0 launchd init",
      "v1.0.0 launchd init --others",
      "v1.0.0 launchd apply --yes",
      "v1.0.0 launchd apply --yes --others",
    ]);
  });
  it("別名の設定が --check-config を通らない: 止める前に die し、daemon を止めず、current も変えない", () => {
    const h = homeWith({
      "touryou.daemon-11111111.plist": "/cfg/ok.json",
      [PLIST_ALIAS]: "/cfg/bad.json",
    });
    const r = upgrade(h);
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/RESULT: failed/);
    expect(r.stdout).toMatch(
      /別名の daemon（.*）の設定が、v1\.0\.0 の daemon の設定の検査を通らない/,
    );
    expect(r.stdout).toMatch(/daemon は止めていない（v0\.9\.0 のまま）/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    // stop・init などは 1 つも呼んでいない
    expect(lines(join(h, "calls.log"))).toEqual([]);
    expect(lines(join(h, "checked.log"))).toContain("/cfg/bad.json");
  });
  it("別名の plist に --config がなく設定を読めない: 同じく止める前に die する", () => {
    const h = homeWith({});
    writeFileSync(join(h, "Library", "LaunchAgents", PLIST_ALIAS), "<plist/>\n");
    const r = upgrade(h);
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/設定が、v1\.0\.0 の daemon の設定の検査を通らない/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    expect(lines(join(h, "calls.log"))).toEqual([]);
  });
});

describe("restore_old（別名の daemon の分岐）", () => {
  it("stop --others が失敗: current は前の版のまま、前の版で apply --yes --others してから止まる（init --others はしない）", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" });
    const r = upgrade(h, { FAIL_ON: "launchd stop --others" });
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/設定ごとの別名の常駐の daemon を止められなかった/);
    expect(r.stdout).toMatch(/v0\.9\.0 で動いている/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    expect(lines(join(h, "calls.log"))).toEqual([
      "v0.9.0 launchd init --others",
      "v0.9.0 launchd stop --others",
      "v0.9.0 launchd apply --yes --others",
    ]);
  });
  it("init --others が失敗: current を前の版に戻し、前の版の init --others で plist を前の形に戻してから apply --yes --others", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" });
    const r = upgrade(h, { FAIL_ON: "v1.0.0 launchd init --others" });
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/launchd init --others が通らなかった/);
    expect(r.stdout).toMatch(/v0\.9\.0 で動いている/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    expect(lines(join(h, "calls.log"))).toEqual([
      "v0.9.0 launchd init --others",
      "v0.9.0 launchd stop --others",
      "v1.0.0 launchd init --others",
      "v1.0.0 launchd stop --others",
      "v0.9.0 launchd init --others",
      "v0.9.0 launchd apply --yes --others",
    ]);
  });
  it("巻き戻しの前に、新しい版の stop --others で別名を止める。止められなければ、前の版で読み直さず、前の版で動いているとは言わない", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" });
    const r = upgrade(h, {
      FAIL_ON: "v1.0.0 launchd apply --yes --others;v1.0.0 launchd stop --others",
    });
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/RESULT: failed/);
    expect(r.stdout).toMatch(/別名の daemon を止められず、v0\.9\.0 で読み込み直せなかった/);
    expect(r.stdout).not.toMatch(/常駐の daemon は v0\.9\.0 で動いている/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    const calls = lines(join(h, "calls.log"));
    expect(calls.at(-1)).toBe("v1.0.0 launchd stop --others");
    expect(calls).not.toContain("v0.9.0 launchd apply --yes --others");
  });
  it("巻き戻しで、前の版の init --others が止まる（作り直せない plist など）: uninstall を挟まず、別名の daemon は止まっていると出す", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" });
    // 新しい版の init --others が失敗して巻き戻しに入り、前の版の 2 回目の init --others（巻き戻しの分）も失敗する
    const r = upgrade(h, {
      FAIL_ON: "v1.0.0 launchd init --others",
      FAIL_REPEAT: "launchd init --others",
    });
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/v0\.9\.0 での起動し直しにも失敗した/);
    expect(r.stdout).toMatch(/常駐の daemon は止まっている/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    const calls = lines(join(h, "calls.log"));
    expect(calls).toEqual([
      "v0.9.0 launchd init --others",
      "v0.9.0 launchd stop --others",
      "v1.0.0 launchd init --others",
      "v1.0.0 launchd stop --others",
      "v0.9.0 launchd init --others",
    ]);
    // 前の版の init --others・apply --others は LaunchAgents の plist を対象にするので、別名では uninstall を挟まない
    expect(calls.some((c) => c.includes("uninstall"))).toBe(false);
  });
  it("apply --yes --others が新しい版でだけ失敗: current を前の版に戻し、前の版で init --others → apply --yes --others で動いている", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" });
    const r = upgrade(h, { FAIL_ON: "v1.0.0 launchd apply --yes --others" });
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/v0\.9\.0 で動いている/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    expect(lines(join(h, "calls.log")).slice(-2)).toEqual([
      "v0.9.0 launchd init --others",
      "v0.9.0 launchd apply --yes --others",
    ]);
  });
  it("apply --yes --others が前の版でも失敗: current は前の版、daemon は止まっている、と出す", () => {
    const h = homeWith({ [PLIST_ALIAS]: "/cfg/a.json" });
    const r = upgrade(h, { FAIL_ON: "launchd apply --yes --others" });
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/設定ごとの別名の daemon が起動しなかった/);
    expect(r.stdout).toMatch(/常駐の daemon は止まっている/);
    expect(readlinkSync(join(h, ".touryou", "current"))).toBe(OLD(h));
    expect(lines(join(h, "calls.log"))).toEqual([
      "v0.9.0 launchd init --others",
      "v0.9.0 launchd stop --others",
      "v1.0.0 launchd init --others",
      "v1.0.0 launchd apply --yes --others",
      "v1.0.0 launchd stop --others",
      "v0.9.0 launchd init --others",
      "v0.9.0 launchd apply --yes --others",
    ]);
  });
});

describe("script の書き方", () => {
  it("変数は、コメントも ${NAME} の形で書く（$HOME のように括弧なしで書かない）", () => {
    const bare = script
      .split("\n")
      .filter((l) => l.trimStart().startsWith("#") && /\$[A-Za-z_]/.test(l));
    expect(bare).toEqual([]);
  });
  it("bash 3.2 の構文で読める（bash -n）", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });
});
