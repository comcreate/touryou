// scripts/dist-check.sh（配布物に、install-runtime.sh と同じ中身の検査を当てる。dist-smoke.sh から使う）の試験（#56）。`node --test scripts/*.test.mjs`
// install-runtime.test.mjs と同じく、仮の tar.gz を作って走らせる（ネットワークなし）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "dist-check.sh");
const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "touryou-dist-check-"));
  made.push(d);
  return d;
};

/** dist-build.sh の形（touryou-darwin-arm64/bin・lib/node_modules/.pnpm）の仮の配布物。extra で中身を足す。 */
const makeTarball = (extra) => {
  const d = tmp();
  const top = join(d, "touryou-darwin-arm64");
  const pnpmNm = join(top, "lib", "node_modules", ".pnpm", "node_modules", "@touryou");
  mkdirSync(join(top, "bin"), { recursive: true });
  mkdirSync(
    join(
      top,
      "lib",
      "node_modules",
      ".pnpm",
      "@touryou+core@file+packages+core",
      "node_modules",
      "@touryou",
      "core",
    ),
    {
      recursive: true,
    },
  );
  mkdirSync(pnpmNm, { recursive: true });
  writeFileSync(join(top, "bin", "touryou-daemon"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(top, "bin", "touryou-daemon"), 0o755);
  // launchd の plist が直に指すもの（#64・#73）。node は TouRyou.app の中で、bin/node はそこへの相対のリンク
  const app = join(top, "TouRyou.app", "Contents");
  mkdirSync(join(app, "MacOS"), { recursive: true });
  mkdirSync(join(app, "Resources"), { recursive: true });
  writeFileSync(join(app, "MacOS", "TouRyou"), "");
  writeFileSync(join(app, "Info.plist"), "");
  writeFileSync(join(app, "Resources", "AppIcon.icns"), "");
  symlinkSync("../TouRyou.app/Contents/MacOS/TouRyou", join(top, "bin", "node"));
  mkdirSync(join(top, "lib", "dist"), { recursive: true });
  writeFileSync(join(top, "lib", "dist", "bin.js"), "");
  writeFileSync(join(top, "lib", "dist-version"), "0.0.0\n");
  // 中を指す、正しいリンク（dist-build.sh の出力にもある形）
  symlinkSync(
    "../../@touryou+core@file+packages+core/node_modules/@touryou/core",
    join(pnpmNm, "core"),
  );
  extra?.(top, pnpmNm);
  const out = join(tmp(), "touryou-0.0.0-darwin-arm64.tar.gz");
  const r = spawnSync("tar", ["-czf", out, "-C", d, "touryou-darwin-arm64"]);
  assert.equal(r.status, 0, String(r.stderr));
  return out;
};
const run = (tgz) => spawnSync("bash", [SCRIPT, tgz], { encoding: "utf8" });

test("dist-check: 中を指すリンクだけの配布物は通る", () => {
  const r = run(makeTarball());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /通った/);
});

test("dist-check: macOS の配布物で、bin/node が TouRyou.app を指さない・Info.plist がないなら赤（#73）", () => {
  const r1 = run(
    makeTarball((top) => {
      rmSync(join(top, "bin", "node"));
      writeFileSync(join(top, "bin", "node"), "");
    }),
  );
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /bin\/node が、TouRyou\.app の中の node への相対のリンクでない/);
  const r2 = run(makeTarball((top) => rmSync(join(top, "TouRyou.app", "Contents", "Info.plist"))));
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /Info\.plist がない/);
});

test("dist-check: v0.1.0 と同じ作り（.pnpm/node_modules/@touryou/daemon がビルドのソースを指す）なら、check_links で赤", () => {
  const r = run(
    makeTarball((_top, pnpmNm) =>
      symlinkSync(
        "../../../../../../../../../../../../Users/runner/work/touryou/touryou/packages/daemon",
        join(pnpmNm, "daemon"),
      ),
    ),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /check_links/);
});

test("dist-check: 絶対パスのリンクは check_links で赤", () => {
  const r = run(makeTarball((top) => symlinkSync("/usr/bin", join(top, "lib", "x"))));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /check_links/);
});

test("dist-check: 中の行き先のないリンクも赤（check_links は通すので、足しの検査で当てる）", () => {
  const r = run(makeTarball((top) => symlinkSync("../nowhere", join(top, "lib", "x"))));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /行き先のない/);
  assert.match(r.stderr, /touryou-darwin-arm64\/lib\/x/);
});

test("dist-check: 写しを作らず、install-runtime.sh を source して関数を使う", () => {
  const src = spawnSync("cat", [SCRIPT], { encoding: "utf8" }).stdout;
  assert.match(src, /\. "\$\{here\}\/\.\.\/plugin\/scripts\/install-runtime\.sh"/);
  assert.doesNotMatch(src, /^check_links\(\)/m);
});

test("dist-check: launchd が直に指すもの（bin/node・lib/dist/bin.js・lib/dist-version）がなければ赤（#64）", () => {
  for (const f of [
    ["bin", "node"],
    ["lib", "dist", "bin.js"],
    ["lib", "dist-version"],
  ]) {
    const r = run(makeTarball((top) => rmSync(join(top, ...f))));
    assert.equal(r.status, 1, f.join("/"));
    assert.match(r.stderr, new RegExp(`launchd が指す ${f.join("/").replace(".", "\\.")} がない`));
  }
});

test("dist-check: 版の印が、配布物の名前の版と違えば赤（#64）", () => {
  const r = run(makeTarball((top) => writeFileSync(join(top, "lib", "dist-version"), "9.9.9\n")));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /版の印（9\.9\.9）が、配布物の名前の版（0\.0\.0）と違う/);
});
