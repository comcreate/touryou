// plugin/scripts/install-runtime.sh（/touryou:setup が 1 回で走らせる、本体の取得・照合・展開・付け替え）と、
// plugin/scripts/runtime-version-notice.sh（SessionStart のフック）を、ネットワークなしで走らせる試験。`node --test scripts/*.test.mjs`
//
// install-runtime.sh は、`bash <file>` で走らせると、取得（curl）・対象の確認（uname・xcode-select）を差し替えられない。
// 試験は、file を source して、関数（platform・has_git・fetch）だけを差し替え、main を呼ぶ（本番の道筋には、引数・環境変数の抜け道がない）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOOK_COMMAND_SESSION_START } from "./hook-commands.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "plugin", "scripts", "install-runtime.sh");
const NOTICE = join(root, "plugin", "scripts", "runtime-version-notice.sh");
const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "touryou-install-"));
  made.push(d);
  return d;
};
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** 仮の配布物（tar.gz）を作る。stub の touryou は、呼ばれた引数を $HOME/calls.log に足す。 */
const makeTarball = (ver, { extra, failApply = false, daemonOk = true } = {}) => {
  const d = tmp();
  const bin = join(d, "touryou-darwin-arm64", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "touryou-daemon"),
    `#!/bin/sh\n[ "$1" = "--help" ] && { echo "usage: touryou-daemon"; exit ${daemonOk ? 0 : 1}; }\nexit 0\n`,
  );
  writeFileSync(
    join(bin, "touryou"),
    `#!/bin/sh\necho "v${ver} $*" >> "$HOME/calls.log"\n[ "$1 $2" = "launchd stop" ] && [ -n "\${STUB_FAIL_STOP:-}" ] && exit 1\n[ "$1 $2" = "launchd apply" ] && [ -n "\${STUB_FAIL_APPLY_ALL:-}" ] && exit 1\n[ "$1 $2" = "launchd apply" ] && exit ${failApply ? 1 : 0}\nexit 0\n`,
  );
  chmodSync(join(bin, "touryou-daemon"), 0o755);
  chmodSync(join(bin, "touryou"), 0o755);
  extra?.(d);
  const out = join(tmp(), `touryou-${ver}-darwin-arm64.tar.gz`);
  const r = spawnSync("tar", ["-czf", out, "-C", d, ...(extra?.top ?? ["touryou-darwin-arm64"])]);
  assert.equal(r.status, 0, String(r.stderr));
  return out;
};

/** 仮の plugin（script の写しと checksums.json・plugin.json）。 */
const makePlugin = (ver, tarball, { pluginVer = ver, shaOverride, repo } = {}) => {
  const P = join(tmp(), "plugin");
  mkdirSync(join(P, "scripts"), { recursive: true });
  mkdirSync(join(P, ".claude-plugin"), { recursive: true });
  copyFileSync(SCRIPT, join(P, "scripts", "install-runtime.sh"));
  copyFileSync(NOTICE, join(P, "scripts", "runtime-version-notice.sh"));
  const name = `touryou-${ver}-darwin-arm64.tar.gz`;
  const json = {
    version: ver,
    assets: { "darwin-arm64": { name, sha256: shaOverride ?? sha(tarball) } },
    extensions: { mcpb: { name: `touryou-mcp-${ver}.mcpb`, sha256: "0".repeat(64) } },
  };
  writeFileSync(join(P, "checksums.json"), `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(
    join(P, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "touryou", version: pluginVer, repository: repo ?? "https://github.com/comcreate/touryou" }, null, 2)}\n`,
  );
  return P;
};

const newHome = () => {
  const h = join(tmp(), "home");
  mkdirSync(h);
  return h;
};

/** script を source して、platform・has_git・fetch を差し替えて main を呼ぶ。fetch は、tarball を写し、URL を記録する。 */
const install = (P, home, tarball, args = [], { env = {}, extra = "" } = {}) => {
  const body = [
    'source "$1"; shift',
    'platform() { echo "Darwin arm64"; }',
    "has_git() { :; }",
    'fetch() { echo "$1" >> "$HOME/fetch.log"; cp "$SRC" "$2"; }',
    extra,
    'main "$@"',
  ].join("\n");
  return spawnSync("bash", ["-c", body, "_", join(P, "scripts", "install-runtime.sh"), ...args], {
    env: { PATH: process.env.PATH, HOME: home, SRC: tarball, ...env },
    encoding: "utf8",
  });
};
const out = (r) => `${r.stdout}${r.stderr}`;
const cur = (home) => readlinkSync(join(home, ".touryou", "current"));
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : []);

test("初めて: 取得 → 照合 → 展開 → current を v<版> に向ける。URL は plugin の repository と版から組み立てる。HOME を出さない", () => {
  const tb = makeTarball("1.0.0");
  const P = makePlugin("1.0.0", tb);
  const h = newHome();
  const r = install(P, h, tb);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /RESULT: installed/);
  assert.equal(cur(h), join(h, ".touryou", "v1.0.0", "touryou-darwin-arm64"));
  assert.deepEqual(lines(join(h, "fetch.log")), [
    "https://github.com/comcreate/touryou/releases/download/v1.0.0/touryou-1.0.0-darwin-arm64.tar.gz",
  ]);
  assert.ok(!out(r).includes(h), "HOME の中身を出さない");
  // 一時ディレクトリは残らない
  assert.deepEqual(
    spawnSync("ls", ["-A", join(h, ".touryou")], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .sort(),
    ["current", "v1.0.0", "work"],
  );
  // work に残るのは、取得した tar.gz だけ（中身の一覧のファイルは残らない。#61）
  assert.deepEqual(
    spawnSync("ls", ["-A", join(h, ".touryou", "work")], { encoding: "utf8" })
      .stdout.trim()
      .split("\n"),
    ["touryou-1.0.0-darwin-arm64.tar.gz"],
  );
});

test("同じ版がすでに入って動くなら、何もしない（取得しない）", () => {
  const tb = makeTarball("1.0.0");
  const P = makePlugin("1.0.0", tb);
  const h = newHome();
  assert.equal(install(P, h, tb).status, 0);
  rmSync(join(h, "fetch.log"));
  const r = install(P, h, tb);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /RESULT: already/);
  assert.ok(!existsSync(join(h, "fetch.log")));
});

test("照合の失敗: 展開せず、current は古いまま、取得したものも残さない", () => {
  const old = makeTarball("0.9.0");
  const h = newHome();
  assert.equal(install(makePlugin("0.9.0", old), h, old).status, 0);
  const tb = makeTarball("1.0.0");
  const P = makePlugin("1.0.0", tb, { shaOverride: "a".repeat(64) });
  const r = install(P, h, tb);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /RESULT: failed/);
  assert.match(r.stdout, /照合/);
  assert.equal(cur(h), join(h, ".touryou", "v0.9.0", "touryou-darwin-arm64"));
  assert.ok(!existsSync(join(h, ".touryou", "v1.0.0")));
  assert.ok(!existsSync(join(h, ".touryou", "work", "touryou-1.0.0-darwin-arm64.tar.gz")));
});

test("壊れた tar（sha256 は合う）: 止まり、v<版> を作らない", () => {
  const bad = join(tmp(), "touryou-1.0.0-darwin-arm64.tar.gz");
  writeFileSync(bad, "not a tarball");
  const P = makePlugin("1.0.0", bad);
  const h = newHome();
  const r = install(P, h, bad);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /壊れている|読めない/);
  assert.ok(!existsSync(join(h, ".touryou", "current")));
  assert.ok(!existsSync(join(h, ".touryou", "v1.0.0")));
});

test("外を指すシンボリックリンク（絶対パス・..）: 止まり、v<版> を作らず、一時ディレクトリも残さない", () => {
  for (const target of ["/etc", "../../..", "../../../outside/x"]) {
    const tb = makeTarball("1.0.0", {
      extra: (d) => symlinkSync(target, join(d, "touryou-darwin-arm64", "bin", "evil")),
    });
    const h = newHome();
    const r = install(makePlugin("1.0.0", tb), h, tb);
    assert.equal(r.status, 1, `${target}: ${out(r)}`);
    assert.match(r.stdout, /シンボリックリンク/);
    assert.ok(!existsSync(join(h, ".touryou", "v1.0.0")));
    assert.ok(!existsSync(join(h, ".touryou", "current")));
    const left = spawnSync("ls", ["-A", join(h, ".touryou")], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(left, /\.stage/);
  }
});

test("中のシンボリックリンク（配布物の中を指す）は、通る", () => {
  const tb = makeTarball("1.0.0", {
    extra: (d) => symlinkSync("touryou-daemon", join(d, "touryou-darwin-arm64", "bin", "alias")),
  });
  const h = newHome();
  const r = install(makePlugin("1.0.0", tb), h, tb);
  assert.equal(r.status, 0, out(r));
});

test("配布物の先頭が touryou-darwin-arm64/ 以外: 止まる", () => {
  const tb = makeTarball("1.0.0", {
    extra: Object.assign((d) => writeFileSync(join(d, "evil.txt"), "x"), {
      top: ["touryou-darwin-arm64", "evil.txt"],
    }),
  });
  const h = newHome();
  const r = install(makePlugin("1.0.0", tb), h, tb);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /中身が、想定と違う/);
  // 失敗でも、中身の一覧（一時ディレクトリ・work の中）を残さない（#61）
  assert.deepEqual(
    readdirSync(join(h, ".touryou")).filter((n) => n.startsWith(".lists.")),
    [],
  );
  assert.deepEqual(
    readdirSync(join(h, ".touryou", "work")).filter((n) => n.startsWith("list")),
    [],
  );
});

test("check_list: 絶対パス・.. の要素・空の一覧を断る", () => {
  const d = tmp();
  const cases = [
    ["touryou-darwin-arm64/\ntouryou-darwin-arm64/bin/x\n", 0],
    ["/etc/passwd\n", 1],
    ["touryou-darwin-arm64/../x\n", 1],
    ["touryou-darwin-arm64/a/..\n", 1],
    ["", 1],
  ];
  for (const [list, want] of cases) {
    writeFileSync(join(d, "l.txt"), list);
    const r = spawnSync("bash", [
      "-c",
      'source "$1"; check_list "$2"',
      "_",
      SCRIPT,
      join(d, "l.txt"),
    ]);
    assert.equal(r.status, want, JSON.stringify(list));
  }
});

test("新しい版の --help が動かない: current を付け替えない", () => {
  const old = makeTarball("0.9.0");
  const h = newHome();
  assert.equal(install(makePlugin("0.9.0", old), h, old).status, 0);
  const tb = makeTarball("1.0.0", { daemonOk: false });
  const r = install(makePlugin("1.0.0", tb), h, tb);
  assert.equal(r.status, 1, out(r));
  assert.equal(cur(h), join(h, ".touryou", "v0.9.0", "touryou-darwin-arm64"));
});

test("版が変わる（常駐なし）: 新しい版に付け替え、古い版のディレクトリは残す。launchd には触らない", () => {
  const old = makeTarball("0.9.0");
  const h = newHome();
  assert.equal(install(makePlugin("0.9.0", old), h, old).status, 0);
  const tb = makeTarball("1.0.0");
  const r = install(makePlugin("1.0.0", tb), h, tb);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /RESULT: upgraded/);
  assert.equal(cur(h), join(h, ".touryou", "v1.0.0", "touryou-darwin-arm64"));
  assert.ok(existsSync(join(h, ".touryou", "v0.9.0")));
  assert.deepEqual(lines(join(h, "calls.log")), []);
});

const managedHome = () => {
  const old = makeTarball("0.9.0");
  const h = newHome();
  assert.equal(install(makePlugin("0.9.0", old), h, old).status, 0);
  mkdirSync(join(h, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(h, "Library", "LaunchAgents", "touryou.daemon.plist"), "<plist/>");
  return h;
};

test("版が変わる（常駐あり）・同意なし: 何も変えず（取得もしない）、終了コード 3", () => {
  const h = managedHome();
  rmSync(join(h, "fetch.log"));
  const tb = makeTarball("1.0.0");
  const r = install(makePlugin("1.0.0", tb), h, tb);
  assert.equal(r.status, 3, out(r));
  assert.match(r.stdout, /RESULT: need-restart-consent/);
  assert.equal(cur(h), join(h, ".touryou", "v0.9.0", "touryou-darwin-arm64"));
  assert.ok(!existsSync(join(h, "fetch.log")));
  assert.deepEqual(lines(join(h, "calls.log")), []);
});

test("版が変わる（常駐あり）・--restart-daemon: 古い版で init（同じかの確かめ）と stop → 付け替え → 新しい版で apply --yes", () => {
  const h = managedHome();
  const tb = makeTarball("1.0.0");
  const r = install(makePlugin("1.0.0", tb), h, tb, ["--restart-daemon"]);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /RESULT: upgraded-restarted/);
  assert.equal(cur(h), join(h, ".touryou", "v1.0.0", "touryou-darwin-arm64"));
  assert.deepEqual(lines(join(h, "calls.log")), [
    "v0.9.0 launchd init",
    "v0.9.0 launchd stop",
    "v1.0.0 launchd apply --yes",
  ]);
});

test("版が変わる（常駐あり）・新しい版の apply が失敗: current を古い版に戻して、起動し直す", () => {
  const h = managedHome();
  const tb = makeTarball("1.0.0", { failApply: true });
  const r = install(makePlugin("1.0.0", tb), h, tb, ["--restart-daemon"]);
  assert.equal(r.status, 1, out(r));
  assert.equal(cur(h), join(h, ".touryou", "v0.9.0", "touryou-darwin-arm64"));
  assert.deepEqual(lines(join(h, "calls.log")), [
    "v0.9.0 launchd init",
    "v0.9.0 launchd stop",
    "v1.0.0 launchd apply --yes",
    "v0.9.0 launchd apply --yes",
  ]);
});

test("--org つきの常駐（名前の違う plist）は、起動し直さずに止まる", () => {
  const old = makeTarball("0.9.0");
  const h = newHome();
  assert.equal(install(makePlugin("0.9.0", old), h, old).status, 0);
  mkdirSync(join(h, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(h, "Library", "LaunchAgents", "com.example.touryou.daemon.plist"), "<plist/>");
  const tb = makeTarball("1.0.0");
  const r = install(makePlugin("1.0.0", tb), h, tb, ["--restart-daemon"]);
  assert.equal(r.status, 1, out(r));
  assert.equal(cur(h), join(h, ".touryou", "v0.9.0", "touryou-darwin-arm64"));
});

test("checksums.json と plugin.json の版の違い・repository の違い・知らない引数: 止まる", () => {
  const tb = makeTarball("1.0.0");
  const h = newHome();
  assert.equal(install(makePlugin("1.0.0", tb, { pluginVer: "1.0.1" }), h, tb).status, 1);
  assert.equal(
    install(makePlugin("1.0.0", tb, { repo: "https://github.com/evil/touryou" }), h, tb).status,
    1,
  );
  const r = install(makePlugin("1.0.0", tb), h, tb, ["--url", "https://example.com/x"]);
  assert.equal(r.status, 2);
  assert.ok(!existsSync(join(h, "fetch.log")));
});

test("current がリンクでない実ディレクトリ: 上書きしない", () => {
  const tb = makeTarball("1.0.0");
  const h = newHome();
  mkdirSync(join(h, ".touryou", "current"), { recursive: true });
  const r = install(makePlugin("1.0.0", tb), h, tb);
  assert.equal(r.status, 1, out(r));
});

test("bash <file> で走らせると、差し替えはなく、対象の確認（Darwin arm64）から始まる（Linux では、ここで止まる）", {
  skip: process.platform === "darwin",
}, () => {
  const tb = makeTarball("1.0.0");
  const P = makePlugin("1.0.0", tb);
  const h = newHome();
  const r = spawnSync("bash", [join(P, "scripts", "install-runtime.sh")], {
    env: { PATH: process.env.PATH, HOME: h },
    encoding: "utf8",
  });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /Apple Silicon/);
  assert.ok(!existsSync(join(h, ".touryou")));
});

test("bash 3.2 の構文で読める（bash -n）・set -eu がある・curl は https だけ", () => {
  assert.equal(spawnSync("bash", ["-n", SCRIPT]).status, 0);
  const s = readFileSync(SCRIPT, "utf8");
  assert.match(s, /^set -eu$/m);
  assert.match(s, /curl -fsSL --proto '=https' --proto-redir '=https'/);
  assert.doesNotMatch(s, /xattr -[dcw]/);
  assert.doesNotMatch(s, /\bsudo\b|launchctl/);
  // 取得元・sha は、引数・環境変数から読まない（TOURYOU_ の環境変数を見ない）
  assert.doesNotMatch(s, /TOURYOU_[A-Z_]+/);
});

// --- SessionStart のフック ---

const runNotice = (home, pluginRoot) =>
  spawnSync("sh", ["-c", HOOK_COMMAND_SESSION_START], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      ...(pluginRoot ? { CLAUDE_PLUGIN_ROOT: pluginRoot } : {}),
    },
    encoding: "utf8",
  });

test("SessionStart: 版が違えば /touryou:setup を知らせる JSON を出す（取得・launchd はしない）。同じ・本体なし・plugin の場所なしは、何も出さない。どれも 0", () => {
  const tb = makeTarball("0.9.0");
  const h = newHome();
  assert.equal(install(makePlugin("0.9.0", tb), h, tb).status, 0);
  rmSync(join(h, "fetch.log"));
  const P = makePlugin("1.0.0", tb);
  const r = runNotice(h, P);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.match(j.systemMessage, /v0\.9\.0.*v1\.0\.0.*\/touryou:setup/);
  assert.equal(j.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(!r.stdout.includes(h));
  assert.ok(!existsSync(join(h, "fetch.log")));
  assert.deepEqual(lines(join(h, "calls.log")), []);

  const same = runNotice(h, makePlugin("0.9.0", tb));
  assert.equal(same.status, 0);
  assert.equal(same.stdout, "");

  const none = runNotice(newHome(), P);
  assert.equal(none.status, 0);
  assert.equal(none.stdout, "");

  const noRoot = runNotice(h, undefined);
  assert.equal(noRoot.status, 0);
  assert.equal(noRoot.stdout, "");

  // current が壊れたリンク・plugin.json が読めない
  const broken = newHome();
  mkdirSync(join(broken, ".touryou"));
  symlinkSync(join(broken, "nowhere"), join(broken, ".touryou", "current"));
  assert.equal(runNotice(broken, P).status, 0);
  rmSync(join(P, ".claude-plugin", "plugin.json"));
  const nopj = runNotice(h, P);
  assert.equal(nopj.status, 0);
  assert.equal(nopj.stdout, "");
});

// --- 常駐の版上げで、stop のあとに失敗したとき（NFR_015: 前の版で動く状態に戻す） ---

const OLD = (h) => join(h, ".touryou", "v0.9.0", "touryou-darwin-arm64");

test("常駐の版上げ・stop が失敗: current は前の版のまま、前の版で apply --yes してから止まり、本当の状態を出す", () => {
  const h = managedHome();
  const tb = makeTarball("1.0.0");
  const r = install(makePlugin("1.0.0", tb), h, tb, ["--restart-daemon"], {
    env: { STUB_FAIL_STOP: "1" },
  });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /RESULT: failed/);
  assert.equal(cur(h), OLD(h));
  assert.deepEqual(lines(join(h, "calls.log")), [
    "v0.9.0 launchd init",
    "v0.9.0 launchd stop",
    "v0.9.0 launchd apply --yes",
  ]);
  assert.match(
    r.stdout,
    /いまの状態: current は v0\.9\.0 に戻し、常駐の daemon は v0\.9\.0 で動いている/,
  );
  assert.doesNotMatch(r.stdout, /current は変えていません/);
});

test("常駐の版上げ・stop のあとの付け替えが失敗: 前の版で apply --yes してから止まる（set -e で黙って落ちない）", () => {
  const h = managedHome();
  const tb = makeTarball("1.0.0");
  const extra =
    'swap_link() { case "$1" in *v1.0.0*) return 1 ;; esac; rm -f "$2"; ln -s "$1" "$2"; }';
  const r = install(makePlugin("1.0.0", tb), h, tb, ["--restart-daemon"], { extra });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /RESULT: failed/);
  assert.equal(cur(h), OLD(h));
  assert.deepEqual(lines(join(h, "calls.log")), [
    "v0.9.0 launchd init",
    "v0.9.0 launchd stop",
    "v0.9.0 launchd apply --yes",
  ]);
  assert.match(r.stdout, /付け替えられなかった/);
  assert.match(r.stdout, /v0\.9\.0 で動いている/);
});

test("常駐の版上げ・新しい版も前の版も apply が失敗: current は前の版、daemon は止まっている、と出す", () => {
  const h = managedHome();
  const tb = makeTarball("1.0.0");
  const r = install(makePlugin("1.0.0", tb), h, tb, ["--restart-daemon"], {
    env: { STUB_FAIL_APPLY_ALL: "1" },
  });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /RESULT: failed/);
  assert.equal(cur(h), OLD(h));
  assert.match(
    r.stdout,
    /いまの状態: current は v0\.9\.0 に戻したが、常駐の daemon は止まっている/,
  );
  assert.match(r.stdout, /次にすること: \/touryou:service status/);
});

test("常駐の版上げ・init の違いで止まる: daemon は止めていない、と出す", () => {
  const h = managedHome();
  const tb = makeTarball("1.0.0");
  const extra = 'run_masked() { case "$*" in *"launchd init"*) return 1 ;; esac; "$@"; }';
  const r = install(makePlugin("1.0.0", tb), h, tb, ["--restart-daemon"], { extra });
  assert.equal(r.status, 1, out(r));
  assert.equal(cur(h), OLD(h));
  assert.match(r.stdout, /daemon は止めていない（v0\.9\.0 のまま動いている）/);
});

test("特殊なファイル（FIFO・ハードリンク）・名前に制御文字を含むもの: 止まり、v<版> を作らない", () => {
  const cases = [
    ["FIFO", (d) => spawnSync("mkfifo", [join(d, "touryou-darwin-arm64", "bin", "pipe")])],
    [
      "ハードリンク",
      (d) =>
        linkSync(
          join(d, "touryou-darwin-arm64", "bin", "touryou"),
          join(d, "touryou-darwin-arm64", "bin", "hard"),
        ),
    ],
    ["制御文字（タブ）", (d) => writeFileSync(join(d, "touryou-darwin-arm64", "bin", "a\tb"), "x")],
    ["制御文字（改行）", (d) => writeFileSync(join(d, "touryou-darwin-arm64", "bin", "a\nb"), "x")],
  ];
  for (const [label, make] of cases) {
    const tb = makeTarball("1.0.0", { extra: make });
    const h = newHome();
    const r = install(makePlugin("1.0.0", tb), h, tb);
    assert.equal(r.status, 1, `${label}: ${out(r)}`);
    assert.match(r.stdout, /RESULT: failed/, label);
    assert.ok(!existsSync(join(h, ".touryou", "v1.0.0")), label);
    assert.ok(!existsSync(join(h, ".touryou", "current")), label);
    // tar -tv の一覧（check_types）の後で止まっても、一覧の一時ディレクトリを残さない（#61）
    assert.deepEqual(
      readdirSync(join(h, ".touryou")).filter((n) => n.startsWith(".lists.")),
      [],
      label,
    );
  }
});

test("環境に LISTS があっても、早い die（手順 6 より前）で、そのパスを消さない（#61）", () => {
  const tb = makeTarball("1.0.0");
  const h = newHome();
  const victim = join(tmp(), "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "keep.txt"), "x");
  const r = install(makePlugin("1.0.0", tb), h, tb, [], {
    env: { LISTS: victim },
    extra: 'platform() { echo "Linux x86_64"; }',
  });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /RESULT: failed/);
  assert.ok(existsSync(join(victim, "keep.txt")), "環境から入った LISTS のパスを消さない");
});

test("setup.md の呼び出し（env -u BASH_ENV -u ENV bash）では、BASH_ENV のファイルが読まれない。環境から取り込んだ関数（uname の上書き）は、script の頭で消える", {
  skip: process.platform === "darwin",
}, () => {
  const tb = makeTarball("1.0.0");
  const P = makePlugin("1.0.0", tb);
  const h = newHome();
  const rc = join(tmp(), "rc.sh");
  writeFileSync(rc, `echo planted > "${join(h, "planted")}"\n`);
  const r = spawnSync(
    "env",
    ["-u", "BASH_ENV", "-u", "ENV", "bash", join(P, "scripts", "install-runtime.sh")],
    {
      env: {
        PATH: process.env.PATH,
        HOME: h,
        BASH_ENV: rc,
        // export -f uname 相当（bash が取り込む形）。消えなければ Darwin arm64 と偽って先に進む
        "BASH_FUNC_uname%%": '() { echo "Darwin arm64"; }',
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /Apple Silicon/);
  assert.ok(!existsSync(join(h, "planted")), "BASH_ENV のファイルが読まれた");
});

// --- ロケール（#47） ---
// macOS の bash 3.2 は、UTF-8 のロケールで、`$name` のすぐあとの全角の文字（の 1 バイト目）を名前の一部として読む（`$ver）` が `ver\xEF`）。
// ロケールなし（C）の組だけでは見つからないので、利用者の Mac と同じ UTF-8 の組でも走らせる。
const LOCALES = [
  { label: "ロケールなし", env: {} },
  { label: "ja_JP.UTF-8", env: { LANG: "ja_JP.UTF-8", LC_ALL: "ja_JP.UTF-8" } },
  { label: "en_US.UTF-8", env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } },
];
/** 出力が正しい UTF-8 であること（壊れた文字〔U+FFFD〕がない） */
const assertUtf8 = (s, label) => {
  assert.ok(!s.includes("�"), `${label}: 正しい UTF-8 でない: ${s}`);
};

for (const { label, env } of LOCALES) {
  test(`ロケール ${label}: 初めて・上げる（全角の文字の直前の版の表示）が、版をそのまま出して 0 で終わる`, () => {
    const old = makeTarball("0.9.0");
    const h = newHome();
    const first = install(makePlugin("0.9.0", old), h, old, [], { env });
    assert.equal(first.status, 0, `${label}: ${out(first)}`);
    assertUtf8(out(first), label);
    assert.match(first.stdout, /配布物を取得します（v0\.9\.0。/);
    assert.match(first.stdout, /インストールできました（v0\.9\.0）/);
    assert.match(first.stdout, /RESULT: installed/);
    assert.doesNotMatch(out(first), /unbound variable/);

    const tb = makeTarball("1.0.0");
    const up = install(makePlugin("1.0.0", tb), h, tb, [], { env });
    assert.equal(up.status, 0, `${label}: ${out(up)}`);
    assertUtf8(out(up), label);
    assert.match(up.stdout, /current を v1\.0\.0 に付け替えました（前は v0\.9\.0）/);
    assert.match(up.stdout, /v0\.9\.0 から v1\.0\.0 に上げました/);
    assert.match(up.stdout, /RESULT: upgraded/);
    assert.equal(cur(h), join(h, ".touryou", "v1.0.0", "touryou-darwin-arm64"));

    // 版が食い違う（checksums.json と plugin.json）: 版を出して 1 で止まる
    const bad = install(makePlugin("1.0.0", tb, { pluginVer: "1.0.1" }), newHome(), tb, [], {
      env,
    });
    assert.equal(bad.status, 1, `${label}: ${out(bad)}`);
    assertUtf8(out(bad), label);
    assert.match(out(bad), /checksums\.json の版（1\.0\.0）と plugin の版（1\.0\.1）が違う/);
    assert.doesNotMatch(out(bad), /unbound variable/);
  });

  test(`ロケール ${label}: SessionStart の知らせが、版をそのまま出した正しい UTF-8 の JSON で、0 で終わる`, () => {
    const tb = makeTarball("0.9.0");
    const h = newHome();
    assert.equal(install(makePlugin("0.9.0", tb), h, tb).status, 0);
    const r = spawnSync("sh", ["-c", HOOK_COMMAND_SESSION_START], {
      env: { PATH: "/usr/bin:/bin", HOME: h, CLAUDE_PLUGIN_ROOT: makePlugin("1.0.0", tb), ...env },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `${label}: ${out(r)}`);
    assertUtf8(r.stdout, label);
    const j = JSON.parse(r.stdout);
    assert.match(j.systemMessage, /本体（v0\.9\.0）と plugin（v1\.0\.0）の版が違います/);
    assert.equal(j.hookSpecificOutput.additionalContext, j.systemMessage);
  });
}
