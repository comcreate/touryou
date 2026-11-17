// project の .claude/settings.json の marketplace の ref（marketplace-v<版>）の照らし（scripts/check-marketplace-ref.sh・#90）と、
// それを呼ぶ workflow（ci.yml・marketplace-ref.yml・release.yml の marketplace-self）の形を確かめる。
// `node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (f) => readFileSync(join(root, f), "utf8");
const hasJq = spawnSync("jq", ["--version"]).status === 0;
const skip = hasJq ? false : "jq が無いので飛ばす";

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** 作り物のリポジトリ（origin は手元の bare）。marketplace の版と settings の ref を与える。 */
function fixture(version, ref) {
  const dir = mkdtempSync(join(tmpdir(), "mpref-"));
  const work = join(dir, "work");
  const up = join(dir, "up.git");
  git(dir, "init", "-q", "--bare", up);
  for (const d of ["plugin/.claude-plugin", ".claude-plugin", ".claude", "scripts"]) {
    mkdirSync(join(work, d), { recursive: true });
  }
  writeFileSync(
    join(work, "plugin/.claude-plugin/plugin.json"),
    JSON.stringify({ name: "touryou" }),
  );
  const market = (v, extra = {}) =>
    writeFileSync(
      join(work, ".claude-plugin/marketplace.json"),
      JSON.stringify({ ...extra, plugins: [{ name: "touryou", version: v }] }),
    );
  market(version);
  const source = { source: "github", repo: "comcreate/touryou" };
  if (ref !== undefined) source.ref = ref;
  writeFileSync(
    join(work, ".claude/settings.json"),
    JSON.stringify({ extraKnownMarketplaces: { touryou: { source } } }),
  );
  copyFileSync(
    join(root, "scripts/check-marketplace-ref.sh"),
    join(work, "scripts/check-marketplace-ref.sh"),
  );
  git(work, "init", "-q", "-b", "main");
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  git(work, "remote", "add", "origin", up);
  git(work, "push", "-q", "origin", "main");
  const run = (mode) =>
    spawnSync("bash", ["scripts/check-marketplace-ref.sh", mode], { cwd: work, encoding: "utf8" });
  const tag = (name, v) => {
    market(v, { tagged: true });
    git(work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "t");
    git(work, "tag", name);
    git(work, "push", "-q", "origin", name);
    git(work, "reset", "-q", "--hard", "HEAD^");
    git(work, "tag", "-d", name);
  };
  return { run, tag, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("name: ref が marketplace-v<版> なら通り、違う・ないなら失敗する", { skip }, () => {
  for (const [ref, ok] of [
    ["marketplace-v0.1.2", true],
    ["marketplace-v0.1.1", false],
    ["v0.1.2", false],
    [undefined, false],
  ]) {
    const f = fixture("0.1.2", ref);
    try {
      const r = f.run("name");
      assert.equal(r.status === 0, ok, `${ref}: ${r.stdout}${r.stderr}`);
    } finally {
      f.done();
    }
  }
});

test("tag: 上流に tag がなければ失敗、中の版が違えば失敗、合えば通る", { skip }, () => {
  const f = fixture("0.1.2", "marketplace-v0.1.2");
  try {
    let r = f.run("tag");
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /上流に tag marketplace-v0\.1\.2 がありません/);
    f.tag("marketplace-v0.1.2", "0.1.1");
    r = f.run("tag");
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /版が「0\.1\.1」/);
  } finally {
    f.done();
  }
  const g = fixture("0.1.2", "marketplace-v0.1.2");
  try {
    g.tag("marketplace-v0.1.2", "0.1.2");
    const r = g.run("tag");
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    g.done();
  }
});

test("このリポジトリの settings.json は、いまの marketplace.json の版の tag 名を指す", {
  skip,
}, () => {
  const r = spawnSync("bash", ["scripts/check-marketplace-ref.sh", "name"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("ci.yml は node 22 の job で、docs だけの変更でも name を照らす", () => {
  const ci = read(".github/workflows/ci.yml");
  const i = ci.indexOf("bash scripts/check-marketplace-ref.sh name");
  assert.ok(i > 0);
  assert.ok(i < ci.indexOf("id: changes"), "重い段を飛ばす判定より前に置く");
  assert.match(ci.slice(ci.lastIndexOf("- name:", i), i), /if: matrix\.node == 22/);
});

test("marketplace-ref.yml は main への push・定期・手動で tag を照らす。権限は contents: read だけ", () => {
  const w = read(".github/workflows/marketplace-ref.yml");
  assert.match(w, /\non:\n {2}push:\n {4}branches: \[main\]\n {2}schedule:\n/);
  assert.match(w, /\n {2}workflow_dispatch:\n/);
  assert.doesNotMatch(w, /pull_request/);
  assert.match(w, /permissions:\n {2}contents: read\n/);
  assert.doesNotMatch(w, /write/);
  assert.match(w, /bash scripts\/check-marketplace-ref\.sh tag/);
});

test("release.yml の marketplace-self は、settings.json の ref も marketplace-v<版> に書き換え、name で照らす", {
  skip,
}, () => {
  const rel = read(".github/workflows/release.yml");
  const prog = /jq --arg ref "marketplace-v\$\{VERSION\}" '([^']*)' "\$\{settings\}"/.exec(
    rel,
  )?.[1];
  assert.ok(prog, "settings.json を書き換える jq がない");
  assert.match(rel, /settings=\.claude\/settings\.json/);
  const src = read(".claude/settings.json");
  const r = spawnSync("jq", ["--arg", "ref", "marketplace-v9.9.9", prog], {
    input: src,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const before = JSON.parse(src);
  assert.equal(out.extraKnownMarketplaces.touryou.source.ref, "marketplace-v9.9.9");
  assert.equal(
    out.extraKnownMarketplaces.touryou.source.repo,
    before.extraKnownMarketplaces.touryou.source.repo,
  );
  assert.deepEqual(out.enabledPlugins, before.enabledPlugins);
  const same = spawnSync(
    "jq",
    ["--arg", "ref", before.extraKnownMarketplaces.touryou.source.ref, prog],
    {
      input: src,
      encoding: "utf8",
    },
  );
  assert.equal(same.stdout, src, "同じ値なら一字一句同じ（2 空白の字下げ）");
  const body = rel.slice(rel.indexOf("marketplace-self:"));
  assert.ok(
    body.indexOf("check-marketplace-ref.sh name") < body.indexOf("git commit -am"),
    "commit の前に照らす",
  );
});
