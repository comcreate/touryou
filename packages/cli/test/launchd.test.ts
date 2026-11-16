import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "../src/bin.js";
import { legacyPlistText, plistText, runDaemonScript, v011PlistText } from "../src/launchd.js";

const has = (cmd: string, args: string[]): boolean => spawnSync(cmd, args).error === undefined;

// `touryou launchd init`。生成物を、実際のシェルで走らせて確かめる（launchctl は使わない）。
const TOKEN = "oauth-secret-token-value-0123456789abcdef";
const ORG = "com.example";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** /setup 済みの HOME（config.json・current・state）を作る。macOS の /var → /private/var の違いを避けるため realpath にする。 */
function makeHome(): { home: string; base: string; state: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "touryou-launchd-")));
  dirs.push(home);
  const base = join(home, ".touryou");
  const state = join(base, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(base, "current", "bin"), { recursive: true });
  // daemon の設定の検査の偽物（bin に fail があれば、その中身を標準エラーに出して終了コード 1）
  writeFileSync(
    join(base, "current", "bin", "touryou-daemon"),
    '#!/bin/sh\nf="$(dirname "$0")/fail"\nif [ -f "$f" ]; then cat "$f" >&2; exit 1; fi\nexit 0\n',
    { mode: 0o755 },
  );
  writeFileSync(join(base, "config.json"), JSON.stringify({ stateDir: state }), { mode: 0o600 });
  return { home, base, state };
}

const run = (home: string, args: string[]) =>
  runBin(["launchd", ...args], { env: { HOME: home }, isTTY: { stdin: false, stdout: false } });
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

describe("引数・前提", () => {
  it("--org の形が違う・空・init がない、は終了コード 2（不正な値は、既定値に戻さない）", async () => {
    const { home } = makeHome();
    expect((await run(home, ["init", "--org", ""])).exitCode).toBe(2);
    expect((await run(home, ["init", "--org", "com"])).exitCode).toBe(2);
    expect((await run(home, ["init", "--org", "com.-bad"])).exitCode).toBe(2);
    expect(existsSync(join(home, ".touryou", "launchd"))).toBe(false); // 何も作らない
    expect((await run(home, ["init", "--org", "Example"])).exitCode).toBe(2);
    expect((await run(home, ["init", "--org", "a b.c"])).exitCode).toBe(2);
    expect((await run(home, [])).exitCode).toBe(2);
    expect((await run(home, ["init", "--org", ORG, "--x"])).exitCode).toBe(2);
    expect((await run(home, ["init", "--help"])).exitCode).toBe(0);
  });

  it("/setup が済んでいなければ、何も作らずに終了コード 1", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "touryou-launchd-")));
    dirs.push(home);
    const r = await run(home, ["init", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/\/setup/);
    expect(existsSync(join(home, ".touryou"))).toBe(false);
  });

  it("HOME・--path-prefix に、使えない文字があれば拒否する（plist・スクリプトに入れない）", async () => {
    const { home } = makeHome();
    expect((await run(home, ["init", "--org", ORG, "--path-prefix", 'a"b'])).exitCode).toBe(2);
    expect((await run(home, ["init", "--org", ORG, "--path-prefix", "/x:$(id)"])).exitCode).toBe(2);
    const bad = await runBin(["launchd", "init", "--org", ORG], {
      env: { HOME: "/tmp/a$b" },
      isTTY: { stdin: false, stdout: false },
    });
    expect(bad.exitCode).toBe(2);
  });
});

describe("設定の検査（daemon の --check-config）", () => {
  it("設定が通らなければ、何も生成せずに終了コード 1。理由と直し方を出し、値（パス）は伏せる", async () => {
    const { home, base } = makeHome();
    writeFileSync(
      join(base, "current", "bin", "fail"),
      `失敗 [invalidConfig]: repoRoot ${home}/gone が、実パスでない（存在しない、またはリンクを含む）\n次の操作:\n  - repoRoot を、リンクを解決した実パスで指定する\n`,
    );
    const r = await run(home, ["init", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/daemon の設定の検査を通らない/);
    expect(r.stderr).toMatch(/invalidConfig/);
    expect(r.stderr).toMatch(/直し方/);
    expect(r.stderr).not.toContain(home);
    expect(existsSync(join(base, "launchd"))).toBe(false);
    expect(existsSync(join(base, "bin"))).toBe(false);
  });

  it("検査を実行できない（終了コード 2〔古い daemon〕など）ときは、設定の誤りと分けて止める", async () => {
    const { home, base } = makeHome();
    writeFileSync(join(base, "current", "bin", "touryou-daemon"), "#!/bin/sh\nexit 2\n", {
      mode: 0o755,
    });
    const r = await run(home, ["init", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/設定を検査できない/);
    expect(r.stderr).not.toMatch(/検査を通らない/);
    expect(existsSync(join(base, "launchd"))).toBe(false);
  });

  it("検査には、HOME と plist と同じ PATH だけを渡す（呼んだ側の環境を受け継がない）", async () => {
    const { home } = makeHome();
    const seen: Record<string, string>[] = [];
    const r = await runBin(
      ["launchd", "init", "--org", ORG, "--path-prefix", "/opt/homebrew/bin"],
      {
        env: { HOME: home, GIT_DIR: "/elsewhere" },
        isTTY: { stdin: false, stdout: false },
        launchd: {
          checkConfig: (_c, _a, env) => {
            seen.push({ ...env });
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual([{ HOME: home, PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" }]);
  });

  it("daemon の入口を実行できなければ、止める", async () => {
    const { home, base } = makeHome();
    rmSync(join(base, "current", "bin", "touryou-daemon"));
    const r = await run(home, ["init", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(base, "launchd"))).toBe(false);
  });
});

describe("生成物", () => {
  it("plist 0644・logs は 0700 で作る。起動スクリプト（bin/）は作らない（#64）。launchctl の案内を出す", async () => {
    const { home, base } = makeHome();
    const r = await run(home, ["init", "--org", ORG]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(base, "bin"))).toBe(false);
    expect(mode(join(base, "logs"))).toBe("700");
    expect(r.stdout).not.toContain("run-daemon.sh");
    const plists = readdirSync(join(base, "launchd")).sort();
    expect(plists).toEqual([`${ORG}.touryou.daemon.plist`]);
    for (const p of plists) expect(mode(join(base, "launchd", p))).toBe("644");
    // LaunchAgents へは置かない（人が cp する）
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(r.stdout).toMatch(/launchctl bootstrap/);
    expect(r.stdout).toMatch(/launchctl を実行していない/);
  });

  it("--org を省略すると、組織のドメインを含まない touryou.daemon になる。plist のファイル名・Label・ログの名前にも入る", async () => {
    const { home, base } = makeHome();
    const r = await run(home, ["init"]);
    expect(r.exitCode).toBe(0);
    expect(readdirSync(join(base, "launchd")).sort()).toEqual(["touryou.daemon.plist"]);
    const d = readFileSync(join(base, "launchd", "touryou.daemon.plist"), "utf8");
    expect(d).toContain("<key>Label</key><string>touryou.daemon</string>");
    expect(d).toContain(join(base, "logs", "daemon.log"));
    expect(r.stdout).toContain('launchctl bootout "gui/$(id -u)/touryou.daemon"');
    expect(r.stdout).toContain("touryou.daemon.plist");
  });

  it("--org を指定すると、既定値を上書きする。別の --org で生成済みでも、既存を触らず、別名で並ぶ", async () => {
    const { home, base } = makeHome();
    expect((await run(home, ["init"])).exitCode).toBe(0);
    const before = readFileSync(join(base, "launchd", "touryou.daemon.plist"), "utf8");
    const r = await run(home, ["init", "--org", "org.other"]);
    expect(r.exitCode).toBe(0);
    expect(readdirSync(join(base, "launchd")).sort()).toEqual([
      "org.other.touryou.daemon.plist",
      "touryou.daemon.plist",
    ]);
    expect(readFileSync(join(base, "launchd", "org.other.touryou.daemon.plist"), "utf8")).toContain(
      "<string>org.other.touryou.daemon</string>",
    );
    expect(readFileSync(join(base, "launchd", "touryou.daemon.plist"), "utf8")).toBe(before);
  });

  it("既存の plist と、同じ名前で内容が違う（既定の --org のまま --path-prefix を変えた）ときは、黙って上書きせず止まる", async () => {
    const { home, base } = makeHome();
    expect((await run(home, ["init"])).exitCode).toBe(0);
    const file = join(base, "launchd", "touryou.daemon.plist");
    const before = readFileSync(file, "utf8");
    const r = await run(home, ["init", "--path-prefix", "/opt/x"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/黙って上書きしない/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("plist: 秘密がなく、ProgramArguments・WorkingDirectory・ログ・KeepAlive・ThrottleInterval が決めどおり", async () => {
    const { home, base, state } = makeHome();
    writeFileSync(join(state, "oauth-token"), TOKEN, { mode: 0o600 });
    const r = await run(home, ["init", "--org", ORG, "--path-prefix", "/opt/homebrew/bin"]);
    expect(r.exitCode).toBe(0);
    const text = readFileSync(join(base, "launchd", `${ORG}.touryou.daemon.plist`), "utf8");
    expect(text).toContain(`<key>Label</key><string>${ORG}.touryou.daemon</string>`);
    // shell を通さず、TouRyou.app の中の node（TouRyou）で daemon の JS を直に起こす（current のリンクを通す。#64・#73）
    expect(text).toContain(
      "<key>AssociatedBundleIdentifiers</key>\n  <array><string>com.comcreate-info.touryou</string></array>",
    );
    expect(text).toContain(
      `<key>ProgramArguments</key>\n  <array>\n    <string>${join(base, "current", "TouRyou.app", "Contents", "MacOS", "TouRyou")}</string>\n    <string>${join(base, "current", "lib", "dist", "bin.js")}</string>\n    <string>--config</string>\n    <string>${join(base, "config.json")}</string>\n  </array>`,
    );
    expect(text).not.toContain("run-daemon.sh");
    expect(text).not.toContain("TOURYOU_DIST_VERSION"); // 版は plist に入れない（版を上げても plist は同じ）
    expect(text).toContain(`<key>WorkingDirectory</key><string>${base}</string>`);
    expect(text).toContain(
      `<key>StandardOutPath</key><string>${join(base, "logs", "daemon.log")}</string>`,
    );
    expect(text).toContain(
      `<key>StandardErrorPath</key><string>${join(base, "logs", "daemon.log")}</string>`,
    );
    expect(text).toContain(
      "<key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>",
    );
    expect(text).toContain("<key>ThrottleInterval</key><integer>30</integer>");
    expect(text).toContain(
      "<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
    );
    for (const t of [text, r.stdout, r.stderr]) {
      expect(t).not.toContain(TOKEN);
      expect(t).not.toMatch(/OAUTH|oauth-secret/);
    }
  });

  it("plist の XML を自前で検証する（開き閉じの対応・必須のキー・文字のエスケープ）", async () => {
    const { home, base } = makeHome();
    await run(home, ["init", "--org", ORG]);
    const REQUIRED = [
      "Label",
      "AssociatedBundleIdentifiers",
      "ProgramArguments",
      "WorkingDirectory",
      "EnvironmentVariables",
      "PATH",
      "RunAtLoad",
      "KeepAlive",
      "SuccessfulExit",
      "ThrottleInterval",
      "Umask",
      "StandardOutPath",
      "StandardErrorPath",
    ];
    for (const p of readdirSync(join(base, "launchd"))) {
      const text = readFileSync(join(base, "launchd", p), "utf8");
      const stack: string[] = [];
      for (const m of text.matchAll(/<(\/?)([A-Za-z]+)([^>]*?)(\/?)>/g)) {
        const [, close, name, , selfClose] = m;
        if (selfClose === "/") continue;
        if (close === "/") expect(stack.pop()).toBe(name);
        else stack.push(name as string);
      }
      expect(stack).toEqual([]);
      const keys = [...text.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1]);
      expect(keys.sort()).toEqual([...REQUIRED].sort());
      // テキストの中に、エスケープされていない & や < がない
      const body = text.replace(/<[^>]*>/g, "\u0000");
      expect(body).not.toMatch(/&(?!amp;|lt;|gt;)/);
    }
    // エスケープ: 値に & < > があっても、XML が壊れない
    const t = plistText({
      label: "a&b<c>d",
      programArguments: ["/x/n&ode", "/x/y"],
      workingDirectory: "/x",
      log: "/x/l",
      path: "/usr/bin",
    });
    expect(t).toContain("<string>a&amp;b&lt;c&gt;d</string>");
    expect(t).toContain("<string>/x/n&amp;ode</string>");
    expect(t).not.toContain("a&b<c>d");
  });

  // 外部ツールがあるときだけ走る。ないときは、スキップとして見える（黙って通らない）
  it.skipIf(!has("plutil", ["-help"]))("plutil -lint が通る", async () => {
    const { home, base } = makeHome();
    await run(home, ["init", "--org", ORG]);
    for (const p of readdirSync(join(base, "launchd"))) {
      expect(spawnSync("plutil", ["-lint", join(base, "launchd", p)]).status).toBe(0);
    }
  });

  it.skipIf(!has("python3", ["--version"]))(
    "python3 の plistlib で読めて、KeepAlive・ThrottleInterval が決めどおり",
    async () => {
      const { home, base } = makeHome();
      await run(home, ["init", "--org", ORG]);
      for (const p of readdirSync(join(base, "launchd"))) {
        const py = spawnSync(
          "python3",
          [
            "-I",
            "-c",
            "import plistlib,sys; d=plistlib.load(open(sys.argv[1],'rb')); assert d['KeepAlive']=={'SuccessfulExit':False}; assert d['ThrottleInterval']==30",
            join(base, "launchd", p),
          ],
          { encoding: "utf8" },
        );
        expect(py.status, py.stderr).toBe(0);
      }
    },
  );

  it("再実行できる（同じ内容なら何もしない）。違う内容の既存は、黙って上書きせず、何も書かずに止まる", async () => {
    const { home, base } = makeHome();
    expect((await run(home, ["init", "--org", ORG])).exitCode).toBe(0);
    const again = await run(home, ["init", "--org", ORG]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/既存と同じ/);
    // 別の組織名: plist が別名になるだけ（既存の plist は触らない）
    expect((await run(home, ["init", "--org", "org.other"])).exitCode).toBe(0);
    // --path-prefix を変えると、既存の plist と内容が違う → 書かれない
    const r = await run(home, ["init", "--org", ORG, "--path-prefix", "/opt/x"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/黙って上書きしない/);
    expect(
      readFileSync(join(base, "launchd", `${ORG}.touryou.daemon.plist`), "utf8"),
    ).not.toContain("/opt/x");
  });

  it("既存のログ・bin が、他人から読める権限なら、直すよう知らせる（黙って変えない）", async () => {
    const { home, base } = makeHome();
    mkdirSync(join(base, "logs"), { mode: 0o755 });
    chmodSync(join(base, "logs"), 0o755);
    const r = await run(home, ["init", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/logs の権限が 0755/);
    expect(mode(join(base, "logs"))).toBe("755");
  });

  it("古い形の run-daemon.sh だけがあり、中身が古い形の生成物と違えば、plist がまだなくても、何も書かずに止まる（launchd/ を作らない）", async () => {
    const { home, base } = makeHome();
    mkdirSync(join(base, "bin"), { mode: 0o700 });
    const script = join(base, "bin", "run-daemon.sh");
    writeFileSync(script, "#!/bin/sh\necho mine\n", { mode: 0o700 });
    const r = await run(home, ["init", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(script, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(existsSync(join(base, "bin", "run-mcp.sh"))).toBe(false);
    expect(existsSync(join(base, "launchd"))).toBe(false);
    expect(existsSync(join(base, "logs"))).toBe(false);
  });

  it("umask が 077・022・000 のどれでも、権限は同じになる", async () => {
    const before = process.umask();
    try {
      for (const mask of [0o077, 0o022, 0o000]) {
        process.umask(mask);
        const { home, base } = makeHome();
        expect((await run(home, ["init", "--org", ORG])).exitCode).toBe(0);
        expect(mode(join(base, "logs"))).toBe("700");
        expect(mode(join(base, "launchd", `${ORG}.touryou.daemon.plist`))).toBe("644");
      }
    } finally {
      process.umask(before);
    }
  });

  it("生成先（.touryou・bin・logs・launchd）がシンボリックリンクなら、辿らずに、何も書かずに止まる", async () => {
    for (const name of ["bin", "logs", "launchd"]) {
      const { home, base } = makeHome();
      const elsewhere = join(home, "elsewhere");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(base, name));
      expect(lstatSync(join(base, name)).isSymbolicLink()).toBe(true);
      const r = await run(home, ["init", "--org", ORG]);
      expect(r.exitCode, name).toBe(1);
      expect(r.stderr).toMatch(/通常のディレクトリでない/);
      expect(readdirSync(elsewhere)).toEqual([]); // 別の場所へは書いていない
    }
    // .touryou 自体がリンク
    const home = realpathSync(mkdtempSync(join(tmpdir(), "touryou-launchd-")));
    dirs.push(home);
    const real = join(home, "real-touryou");
    mkdirSync(join(real, "state"), { recursive: true });
    mkdirSync(join(real, "current"));
    writeFileSync(join(real, "config.json"), JSON.stringify({ stateDir: join(real, "state") }));
    symlinkSync(real, join(home, ".touryou"));
    const r = await run(home, ["init", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(readdirSync(real).sort()).toEqual(["config.json", "current", "state"]);
  });

  it("--path-prefix に .. の要素・// があれば拒否する", async () => {
    const { home } = makeHome();
    for (const v of ["/opt/../etc", "/opt//bin", "/opt/..", "relative/bin"]) {
      expect((await run(home, ["init", "--org", ORG, "--path-prefix", v])).exitCode, v).toBe(2);
    }
  });

  it("権限の問題の一覧に、直し方（chmod）が入る。前の版のトークンのファイルがあっても、中身を読まず、出さない", async () => {
    const { home, base, state } = makeHome();
    mkdirSync(join(base, "logs"), { mode: 0o755 });
    chmodSync(join(base, "logs"), 0o755);
    writeFileSync(join(state, "oauth-token"), TOKEN, { mode: 0o600 });
    const r = await run(home, ["init", "--org", ORG]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`chmod 700 "${join(base, "logs")}"`);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("plist の値: Umask 63・RunAtLoad true・launchd/ は 0755", async () => {
    const { home, base } = makeHome();
    await run(home, ["init", "--org", ORG]);
    expect(mode(join(base, "launchd"))).toBe("755");
    for (const p of readdirSync(join(base, "launchd"))) {
      const text = readFileSync(join(base, "launchd", p), "utf8");
      expect(text).toContain("<key>Umask</key><integer>63</integer>");
      expect(text).toContain("<key>RunAtLoad</key><true/>");
    }
  });

  it("HOME・stateDir に .. の要素・// があれば拒否する。--path-prefix に空文字を渡しても、黙って無視しない", async () => {
    const { home } = makeHome();
    expect((await run(home, ["init", "--org", ORG, "--path-prefix", ""])).exitCode).toBe(2);
    const dotted = await runBin(["launchd", "init", "--org", ORG], {
      env: { HOME: `${home}/../x` },
      isTTY: { stdin: false, stdout: false },
    });
    expect(dotted.exitCode).toBe(2);
    const h2 = makeHome();
    writeFileSync(
      join(h2.base, "config.json"),
      JSON.stringify({ stateDir: `${h2.state}/../state` }),
    );
    expect((await run(h2.home, ["init", "--org", ORG])).exitCode).toBe(1);
  });

  // 案内の「トークンのファイルを作る」を、実際に bash で走らせる（利用者の zsh・bash の `read -s` と同じ形）
});

describe("plist の ProgramArguments（実際に走らせる）", () => {
  it("秘密を扱わない（子の認証トークンを読まない）。同梱の node に daemon の JS と --config を渡す", async () => {
    const h = makeHome();
    const out = join(h.home, "observed.txt");
    // 同梱の node の偽物（受け取った引数と、トークンの環境変数を書き出す）
    const exe = join(h.base, "current", "TouRyou.app", "Contents", "MacOS");
    mkdirSync(exe, { recursive: true });
    writeFileSync(
      join(exe, "TouRyou"),
      `#!/bin/sh\n{ echo "args=$*"; echo "tok=\${CLAUDE_CODE_OAUTH_TOKEN:-none}"; } > "${out}"\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(h.state, "oauth-token"), TOKEN, { mode: 0o600 });
    expect((await run(h.home, ["init", "--org", ORG])).exitCode).toBe(0);
    const text = readFileSync(join(h.base, "launchd", `${ORG}.touryou.daemon.plist`), "utf8");
    expect(text).not.toMatch(/oauth-token|CLAUDE_CODE_OAUTH_TOKEN/);
    const args = [
      ...(
        /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? ""
      ).matchAll(/<string>([^<]*)<\/string>/g),
    ].map((m) => m[1] as string);
    const r = spawnSync(args[0] as string, args.slice(1), {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(r.status).toBe(0);
    const seen = readFileSync(out, "utf8");
    expect(seen).toContain(
      `args=${join(h.base, "current", "lib", "dist", "bin.js")} --config ${join(h.base, "config.json")}`,
    );
    expect(seen).toContain("tok=none");
  });
});

describe("古い形（v0.1.0 まで。run-daemon.sh を起こす plist）からの引っ越し（#64）", () => {
  /** v0.1.1 の init が生成したのと同じ、古い形の生成物を置く。 */
  const legacy = (
    h: { home: string; base: string },
    label: string,
    path = "/usr/bin:/bin:/usr/sbin:/sbin",
  ): { plist: string; script: string } => {
    mkdirSync(join(h.base, "bin"), { recursive: true, mode: 0o700 });
    mkdirSync(join(h.base, "launchd"), { recursive: true, mode: 0o755 });
    mkdirSync(join(h.base, "logs"), { recursive: true, mode: 0o700 });
    const script = join(h.base, "bin", "run-daemon.sh");
    writeFileSync(script, runDaemonScript(h.base), { mode: 0o700 });
    const plist = join(h.base, "launchd", `${label}.plist`);
    writeFileSync(
      plist,
      legacyPlistText({
        label,
        script,
        workingDirectory: h.base,
        log: join(h.base, "logs", "daemon.log"),
        path,
      }),
      { mode: 0o644 },
    );
    return { plist, script };
  };

  it("古い形と同じなら、plist を新しい形に置き換える。run-daemon.sh は、LaunchAgents の古い形が起こしうるので残す。もう一度 init しても同じ", async () => {
    const h = makeHome();
    const { plist, script } = legacy(h, "touryou.daemon");
    const r = await run(h.home, ["init"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /古い形〔run-daemon\.sh か bin\/node を起こす〕から、新しい形〔TouRyou\.app を起こす〕に置き換えた/,
    );
    expect(readFileSync(script, "utf8")).toBe(runDaemonScript(h.base));
    const text = readFileSync(plist, "utf8");
    expect(text).toContain(join(h.base, "current", "TouRyou.app", "Contents", "MacOS", "TouRyou"));
    expect(text).not.toContain("run-daemon.sh");
    expect(mode(plist)).toBe("644");
    expect(existsSync(`${plist}.new`)).toBe(false);
    const again = await run(h.home, ["init"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/既存と同じ/);
  });

  it("--org・--path-prefix つきの古い形も、同じ引数の init なら置き換える（PATH の値の扱いも同じ）", async () => {
    const h = makeHome();
    const { plist, script } = legacy(
      h,
      `${ORG}.touryou.daemon`,
      "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
    const r = await run(h.home, ["init", "--org", ORG, "--path-prefix", "/opt/homebrew/bin"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(existsSync(script)).toBe(true);
    const text = readFileSync(plist, "utf8");
    expect(text).toContain(join(h.base, "current", "TouRyou.app", "Contents", "MacOS", "TouRyou"));
    expect(text).toContain(
      "<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
    );
  });

  it("古い形でも、--path-prefix が違う init なら、置き換えずに止まる（何も消さない）", async () => {
    const h = makeHome();
    const { plist, script } = legacy(h, "touryou.daemon", "/opt/x:/usr/bin:/bin:/usr/sbin:/sbin");
    const before = readFileSync(plist, "utf8");
    const r = await run(h.home, ["init"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/黙って上書きしない/);
    expect(readFileSync(plist, "utf8")).toBe(before);
    expect(readFileSync(script, "utf8")).toBe(runDaemonScript(h.base));
  });

  it("古い形の plist でも、run-daemon.sh を手で直していれば、何も書かず・消さずに止まる", async () => {
    const h = makeHome();
    const { plist, script } = legacy(h, "touryou.daemon");
    writeFileSync(script, "#!/bin/sh\necho mine\n");
    const before = readFileSync(plist, "utf8");
    const r = await run(h.home, ["init"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(script);
    expect(readFileSync(plist, "utf8")).toBe(before);
    expect(readFileSync(script, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("古い形の plist を手で直していれば（環境変数を足したなど）、置き換えずに止まる", async () => {
    const h = makeHome();
    const { plist, script } = legacy(h, "touryou.daemon");
    const edited = readFileSync(plist, "utf8").replace(
      "<key>PATH</key>",
      "<key>FOO</key><string>1</string>\n    <key>PATH</key>",
    );
    writeFileSync(plist, edited);
    const r = await run(h.home, ["init"]);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(plist, "utf8")).toBe(edited);
    expect(existsSync(script)).toBe(true);
  });
});

describe("launchctl を実行しない", () => {
  it("launchd.ts は子プロセスを起動しない", () => {
    const src = readFileSync(new URL("../src/launchd.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/child_process|spawn|exec(Sync|File)?\(/);
  });
});

describe("前の形（v0.1.1。current/bin/node を直に起こす plist）からの引っ越し（#73）", () => {
  const v011 = (h: { base: string }, label: string, path = "/usr/bin:/bin:/usr/sbin:/sbin") => {
    mkdirSync(join(h.base, "launchd"), { recursive: true, mode: 0o755 });
    mkdirSync(join(h.base, "logs"), { recursive: true, mode: 0o700 });
    const plist = join(h.base, "launchd", `${label}.plist`);
    writeFileSync(
      plist,
      v011PlistText({
        label,
        workingDirectory: h.base,
        log: join(h.base, "logs", "daemon.log"),
        path,
        base: h.base,
      }),
      { mode: 0o644 },
    );
    return plist;
  };

  it("v0.1.1 の形と同じなら、TouRyou.app を起こす形に置き換える。もう一度 init しても同じ", async () => {
    const h = makeHome();
    const plist = v011(h, "touryou.daemon");
    expect(readFileSync(plist, "utf8")).toContain(join(h.base, "current", "bin", "node"));
    const r = await run(h.home, ["init"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/新しい形〔TouRyou\.app を起こす〕に置き換えた/);
    const text = readFileSync(plist, "utf8");
    expect(text).toContain(join(h.base, "current", "TouRyou.app", "Contents", "MacOS", "TouRyou"));
    expect(text).not.toContain(join(h.base, "current", "bin", "node"));
    expect(text).toContain("com.comcreate-info.touryou");
    expect(existsSync(`${plist}.new`)).toBe(false);
    expect((await run(h.home, ["init"])).stdout).toMatch(/既存と同じ/);
  });

  it("--org・--path-prefix つきの v0.1.1 の形も、同じ引数なら置き換え、違えば止まる", async () => {
    const h = makeHome();
    const plist = v011(h, `${ORG}.touryou.daemon`, "/opt/x:/usr/bin:/bin:/usr/sbin:/sbin");
    const before = readFileSync(plist, "utf8");
    const bad = await run(h.home, ["init", "--org", ORG]);
    expect(bad.exitCode).toBe(1);
    expect(readFileSync(plist, "utf8")).toBe(before);
    const ok = await run(h.home, ["init", "--org", ORG, "--path-prefix", "/opt/x"]);
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(readFileSync(plist, "utf8")).toContain("TouRyou.app");
  });

  it("v0.1.1 の形を手で直していれば、置き換えずに止まる", async () => {
    const h = makeHome();
    const plist = v011(h, "touryou.daemon");
    const edited = readFileSync(plist, "utf8").replace("<key>RunAtLoad</key><true/>", "");
    writeFileSync(plist, edited);
    expect((await run(h.home, ["init"])).exitCode).toBe(1);
    expect(readFileSync(plist, "utf8")).toBe(edited);
  });

  it("plistText と v011PlistText は、ProgramArguments と AssociatedBundleIdentifiers だけが違う", () => {
    const base = "/Users/x/.touryou";
    const o = {
      label: "touryou.daemon",
      workingDirectory: base,
      log: `${base}/logs/daemon.log`,
      path: "/usr/bin",
    };
    const a = v011PlistText({ ...o, base });
    const b = plistText({
      ...o,
      programArguments: [
        `${base}/current/bin/node`,
        `${base}/current/lib/dist/bin.js`,
        "--config",
        `${base}/config.json`,
      ],
    });
    expect(
      b.replace(
        /\n {2}<key>AssociatedBundleIdentifiers<\/key>\n {2}<array><string>[^<]*<\/string><\/array>/,
        "",
      ),
    ).toBe(a);
  });
});
