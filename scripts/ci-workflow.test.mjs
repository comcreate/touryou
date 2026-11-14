// .github/workflows の ci.yml・ci-macos.yml・dist-smoke.yml の形を確かめる（macOS の runner の費用を抑える決めごと・必須の check が必ず報告されること）。
// `node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");
const ci = read("ci.yml");
const mac = read("ci-macos.yml");
const dist = read("dist-smoke.yml");

/** `on.<event>.<key>:` の一覧（2 字下げのイベント、4 字下げのキー、6 字下げの「- "…"」）。 */
function list(src, event, key) {
  const m = new RegExp(`\\n  ${event}:\\n(?:    .*\\n)*?    ${key}:\\n((?:      - .*\\n)+)`).exec(
    src,
  );
  assert.ok(m, `on.${event}.${key} がない`);
  return m[1]
    .trim()
    .split("\n")
    .map((l) => l.replace(/^\s*- /, "").replace(/^"|"$/g, ""));
}

/** GitHub の paths の形（** と *）だけを扱う簡単な照合。 */
const glob = (pattern) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "@@")
      .replace(/\*/g, "[^/]*")
      .replace(/@@/g, ".*")}$`,
  );
const matches = (patterns, file) => patterns.some((p) => glob(p).test(file));

const DOCS_ONLY = [
  "docs/release.md",
  "docs/plugin.md",
  ".sdd/task/initial-spec-design/tasks.md",
  "CHANGELOG.md",
  "README.md",
  "LICENSE",
];
const CODE = [
  "packages/cli/src/launchd.ts",
  "scripts/check.sh",
  "plugin/commands/setup.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "biome.json",
  "tsconfig.base.json",
  ".github/workflows/ci-macos.yml",
];

test("ci.yml は ubuntu だけ（macOS は ci-macos.yml）", () => {
  assert.doesNotMatch(ci, /os: macos|runs-on: macos/);
  assert.match(mac, /runs-on: macos-15\b/);
});

test("ci-macos.yml: push・pull_request とも paths があり、同じ一覧。コードの変更で動き、docs だけでは動かない", () => {
  const push = list(mac, "push", "paths");
  const pr = list(mac, "pull_request", "paths");
  assert.deepEqual(push, pr);
  for (const f of CODE) assert.ok(matches(pr, f), `${f} で動くこと`);
  for (const f of DOCS_ONLY) assert.ok(!matches(pr, f), `${f} だけでは動かないこと`);
});

test("ci.yml: paths・paths-ignore を使わない（必須の check が必ず報告される）。push（main）・pull_request・workflow_dispatch で動く", () => {
  const on = ci.slice(ci.indexOf("\non:\n"), ci.indexOf("\npermissions:"));
  assert.doesNotMatch(on, /paths/);
  assert.match(on, /\n {2}push:\n {4}branches: \[main\]\n/);
  assert.match(on, /\n {2}pull_request:\n {4}branches: \[main\]\n/);
  assert.match(on, /\n {2}workflow_dispatch:\n/);
});

test("ci.yml: 必須の check の名前（check (<os>, node <node>)）と、ubuntu の node 22・24 を保つ", () => {
  assert.match(ci, /\n {4}name: check \(\$\{\{ matrix\.os \}\}, node \$\{\{ matrix\.node \}\}\)\n/);
  assert.match(ci, /- \{ os: ubuntu-latest, node: 22 \}/);
  assert.match(ci, /- \{ os: ubuntu-latest, node: 24 \}/);
});

test("ci.yml: docs などだけの変更では、checkout と判定のあとの段（install・check.sh など）をすべて飛ばす", () => {
  const steps = ci
    .slice(ci.indexOf("\n    steps:\n"))
    .split(/\n(?= {6}- )/)
    .slice(1);
  const at = steps.findIndex((s) => /id: changes/.test(s));
  assert.ok(at > 0, "変更を見る段がない");
  assert.match(steps[at], /bash scripts\/ci-code-changed\.sh/);
  const rest = steps.slice(at + 1);
  assert.ok(rest.some((s) => /bash scripts\/check\.sh/.test(s)));
  for (const s of rest) assert.match(s, /if: steps\.changes\.outputs\.code == 'true'/, s);
});

const codeChanged = (files) =>
  spawnSync("bash", [new URL("./ci-code-changed.sh", import.meta.url).pathname], {
    input: files.map((f) => `${f}\n`).join(""),
    encoding: "utf8",
  }).stdout.trim();

test("ci-code-changed.sh: docs・.sdd・CHANGELOG・README・LICENSE だけなら false。コードを含めば true。空なら true", () => {
  assert.equal(codeChanged(DOCS_ONLY), "false");
  for (const f of DOCS_ONLY) assert.equal(codeChanged([f]), "false", f);
  for (const f of CODE) assert.equal(codeChanged([f]), "true", f);
  assert.equal(codeChanged([...DOCS_ONLY, "packages/cli/src/launchd.ts"]), "true");
  assert.equal(codeChanged([".github/workflows/ci.yml"]), "true");
  assert.equal(codeChanged([]), "true");
  assert.equal(codeChanged(["docs.ts", "README.md.bak"]), "true");
});

test("ci.yml・ci-macos.yml・dist-smoke.yml は、同じ ref の前の実行を止める（concurrency・cancel-in-progress）", () => {
  for (const [name, src] of [
    ["ci.yml", ci],
    ["ci-macos.yml", mac],
    ["dist-smoke.yml", dist],
  ]) {
    assert.match(
      src,
      /\nconcurrency:\n {2}group: .*\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true\n/,
      name,
    );
  }
  const groups = [ci, mac, dist].map((s) => /\n {2}group: (.*)\n/.exec(s)?.[1]);
  assert.equal(new Set(groups).size, 3, "concurrency の group が、ワークフローごとに違うこと");
});
