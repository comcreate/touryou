// .github/workflows の ci.yml・ci-macos.yml・macos-capacity-rerun.yml の形を確かめる（macOS の runner の費用を抑える決めごと・必須の check が必ず報告されること）。
// `node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const read = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");
const ci = read("ci.yml");
const mac = read("ci-macos.yml");
const rerun = read("macos-capacity-rerun.yml");
const workflowFiles = spawnSync("git", ["ls-files", ".github/workflows"], { encoding: "utf8" })
  .stdout.split("\n")
  .filter(Boolean);

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
  assert.match(mac, /runs-on: macos-latest\b/);
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

test("ci.yml・ci-macos.yml は、同じ ref の前の実行を止める（concurrency・cancel-in-progress）", () => {
  for (const [name, src] of [
    ["ci.yml", ci],
    ["ci-macos.yml", mac],
  ]) {
    assert.match(
      src,
      /\nconcurrency:\n {2}group: .*\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true\n/,
      name,
    );
  }
  const groups = [ci, mac].map((s) => /\n {2}group: (.*)\n/.exec(s)?.[1]);
  assert.equal(new Set(groups).size, 2, "concurrency の group が、ワークフローごとに違うこと");
});

// コミットのメールの確かめ（scripts/ci-commit-emails.sh）。一時の git のリポジトリで、許す形・外れる形を確かめる。
const EMAILS_SH = new URL("./ci-commit-emails.sh", import.meta.url).pathname;

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ci-emails-"));
  const git = (args, env = {}) => {
    const r = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...env,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]);
  /** author・committer のメールと本文でコミットを作り、sha を返す。 */
  const commit = (author, committer, message) => {
    git(["commit", "-q", "--allow-empty", "-m", message], {
      GIT_AUTHOR_NAME: "a",
      GIT_AUTHOR_EMAIL: author,
      GIT_COMMITTER_NAME: "c",
      GIT_COMMITTER_EMAIL: committer,
    });
    return git(["rev-parse", "HEAD"]);
  };
  const check = (...args) =>
    spawnSync("bash", [EMAILS_SH, ...args], { cwd: dir, encoding: "utf8" });
  return { dir, commit, check };
}

const OK_GH = "12345+someone@users.noreply.github.com";
const BOT = "41898282+github-actions[bot]@users.noreply.github.com";
const BAD = "someone@example.com";
const DEPENDABOT = "49699333+dependabot[bot]@users.noreply.github.com";

test("ci-commit-emails.sh: 許す形（users.noreply.github.com・noreply@github.com・noreply@anthropic.com・ボット）だけなら成功", () => {
  const { dir, commit, check } = tempRepo();
  try {
    const base = commit(OK_GH, "noreply@github.com", "base");
    commit(OK_GH, "noreply@github.com", "x\n\nCo-authored-by: A <NoReply@Anthropic.com>");
    commit(BOT, BOT, `y\n\nCo-Authored-By: B <${OK_GH}>\nco-authored-by: C <noreply@github.com>`);
    const r = check(`${base}..HEAD`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /2 件/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci-commit-emails.sh: Dependabot のコミット（author は dependabot[bot]・committer は GitHub）と、自動マージの squash のコミットが通る", () => {
  const { dir, commit, check } = tempRepo();
  try {
    const base = commit(OK_GH, OK_GH, "base");
    commit(
      DEPENDABOT,
      "noreply@github.com",
      "[update] Bump the actions group with 1 update\n\nSigned-off-by: dependabot[bot] <support@github.com>",
    );
    // squash: author は PR の作者（dependabot[bot]）、committer は GitHub
    commit(DEPENDABOT, "noreply@github.com", "[update] Bump the actions group with 1 update (#1)");
    const r = check(`${base}..HEAD`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci-commit-emails.sh: author・committer・Co-authored-by のどれかが外れたら失敗。どのコミットのどの欄かを出し、アドレスは出さない。直し方を出す", () => {
  const { dir, commit, check } = tempRepo();
  try {
    const base = commit(OK_GH, OK_GH, "base");
    const a = commit(BAD, OK_GH, "author が外れる");
    const c = commit(OK_GH, BAD, "committer が外れる");
    const co = commit(OK_GH, OK_GH, `本文\n\nCo-authored-by: X <${BAD}>`);
    const lookalike = commit("noreply@github.com.evil.example", OK_GH, "似た形");
    const r = check(`${base}..HEAD`);
    assert.equal(r.status, 1);
    const out = r.stdout + r.stderr;
    assert.match(out, new RegExp(`${a.slice(0, 7)}[0-9a-f]*: author`));
    assert.match(out, new RegExp(`${c.slice(0, 7)}[0-9a-f]*: committer`));
    assert.match(out, new RegExp(`${co.slice(0, 7)}[0-9a-f]*: 本文の Co-authored-by`));
    assert.match(out, new RegExp(`${lookalike.slice(0, 7)}[0-9a-f]*: author`));
    assert.doesNotMatch(out, /example/);
    assert.match(out, /git config user\.email/);
    assert.match(out, /Settings → Emails/);
    // 範囲の外（base）は見ない
    assert.equal(check("-1", base).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci.yml: コミットのメールの確かめは、変更の判定より前で、node 22 の job だけで（docs だけの変更でも）動く。fetch-depth: 0。pull_request は base..head、push は before..after", () => {
  const steps = ci
    .slice(ci.indexOf("\n    steps:\n"))
    .split(/\n(?= {6}- )/)
    .slice(1);
  const at = steps.findIndex((s) => /bash scripts\/ci-commit-emails\.sh/.test(s));
  const changes = steps.findIndex((s) => /id: changes/.test(s));
  assert.ok(at > 0 && at < changes);
  // 条件は node 22 の job だけ（変更の判定には依らない。docs だけでも動く）
  assert.match(steps[at], /\n {8}if: matrix\.node == 22\n/);
  assert.doesNotMatch(steps[at], /steps\.changes/);
  assert.match(steps[0], /fetch-depth: 0/);
  assert.match(steps[at], /ci-commit-emails\.sh "\$\{PR_BASE\}\.\.\$\{PR_HEAD\}"/);
  assert.match(steps[at], /ci-commit-emails\.sh "\$\{BEFORE\}\.\.\$\{AFTER\}"/);
  const body = steps[at].slice(steps[at].indexOf("run: |") + 6).replace(/^ {10}/gm, "");
  assert.equal(spawnSync("bash", ["-n"], { input: body, encoding: "utf8" }).status, 0);
});

// PR ごとの macOS のジョブは 1 つ（#85）。機械が割り当てられなかったときの走らせ直し（#84）。
test("macOS の PR・push の workflow は ci-macos.yml の 1 ジョブだけ。check.sh と配布物の確かめ（dist-build・mcpb・smoke）を続けて行う", () => {
  const macOs = workflowFiles.filter(
    (f) => !f.endsWith("release.yml") && /runs-on: macos/.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(macOs, [".github/workflows/ci-macos.yml"]);
  assert.equal([...mac.matchAll(/runs-on: macos/g)].length, 1);
  assert.match(mac, /\n {4}name: check \(macos-latest, node 24\)\n/);
  const order = [
    "bash scripts/check.sh",
    "bash scripts/dist-build.sh",
    "bash scripts/mcpb-build.sh",
    "bash scripts/dist-smoke.sh",
  ].map((c) => mac.indexOf(c));
  for (const i of order) assert.ok(i > 0);
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.match(mac, /\non:\n {2}workflow_dispatch:\n/);
  // 配布物のビルドは release.yml の dist と同じ Node（22.20.0）
  const rel = /node-version: (\S+)/.exec(
    read("release.yml").slice(read("release.yml").indexOf("\n  dist:\n")),
  )?.[1];
  assert.equal(rel, "22.20.0");
  const before = mac.slice(0, mac.indexOf("run: pnpm build"));
  assert.equal(/node-version: (\S+)\n(?![\s\S]*node-version:)/.exec(before)?.[1], rel);
});

test("ci-macos.yml: 配布物の確かめは main への push では飛ばす。artifact は手で実行したときだけ（1 日）", () => {
  const steps = mac.split(/\n(?= {6}- )/);
  const at = steps.findIndex((s) => /pnpm build/.test(s));
  assert.ok(at > 0);
  for (const s of steps.slice(at)) {
    if (/upload-artifact@/.test(s)) {
      assert.match(s, /if: github\.event_name == 'workflow_dispatch'/);
      assert.match(s, /retention-days: 1\b/);
    } else assert.match(s, /if: github\.event_name != 'push'/, s);
  }
});

test("macos-capacity-rerun.yml: workflow_run（completed）で CI (macOS) と Release を見る。failure・run_attempt 1・このリポジトリのときだけ。権限は actions: write と checks: read。checkout しない", () => {
  assert.match(
    rerun,
    /\n {2}workflow_run:\n {4}workflows: \["CI \(macOS\)", Release\]\n {4}types: \[completed\]\n/,
  );
  assert.match(mac, /^name: CI \(macOS\)$/m);
  assert.match(read("release.yml"), /^name: Release$/m);
  assert.match(rerun, /github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(rerun, /github\.event\.workflow_run\.run_attempt == 1\b/);
  assert.match(rerun, /github\.repository == 'comcreate\/touryou'/);
  assert.match(rerun, /\npermissions:\n {2}actions: write\n {2}checks: read\n\n/);
  assert.equal([...rerun.matchAll(/permissions:/g)].length, 1);
  assert.doesNotMatch(rerun, /actions\/checkout|pull_request_target|head_sha|head_branch/);
});

/** 走らせ直しの段を、偽の gh（呼び出しを記録し、決めた答えを返す）で動かす。 */
function runRerun(jobs, annotations) {
  const dir = mkdtempSync(join(tmpdir(), "ci-rerun-"));
  try {
    const body = rerun.slice(rerun.indexOf("run: |") + 6).replace(/^ {10}/gm, "");
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls"
case "$*" in
  *"/attempts/1/jobs"*) printf '%s\\n' ${jobs.map((j) => `"${j}"`).join(" ")} ;;
  *"/check-runs/"*) id="$(echo "$*" | sed -E 's#.*/check-runs/([0-9]+)/.*#\\1#')"; cat "${dir}/ann-$id" 2>/dev/null || true ;;
esac
`,
    );
    chmodSync(gh, 0o755);
    for (const [id, text] of Object.entries(annotations))
      writeFileSync(join(dir, `ann-${id}`), text);
    const r = spawnSync("bash", ["-e"], {
      input: body,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_STEP_SUMMARY: join(dir, "summary"),
        RUN_ID: "9",
        RUN_NAME: "CI (macOS)",
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = readFileSync(join(dir, "calls"), "utf8");
    return {
      rerun: /-X POST .*actions\/runs\/9\/rerun-failed-jobs/.test(calls),
      summary: readFileSync(join(dir, "summary"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NOT_ACQUIRED =
  "The job was not acquired by Runner of type hosted even after multiple attempts\nDue to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.\n";

test("macos-capacity-rerun.yml: 落ちたジョブのすべてに「was not acquired by Runner」があるときだけ走らせ直す。試験の失敗・混ざったとき・落ちたジョブがないときは走らせ直さない", () => {
  assert.equal(runRerun(["11"], { 11: NOT_ACQUIRED }).rerun, true);
  assert.equal(runRerun(["11", "12"], { 11: NOT_ACQUIRED, 12: NOT_ACQUIRED }).rerun, true);
  const real = runRerun(["11"], { 11: "Process completed with exit code 1.\n" });
  assert.equal(real.rerun, false);
  assert.match(real.summary, /走らせ直しません/);
  assert.equal(runRerun(["11", "12"], { 11: NOT_ACQUIRED, 12: "exit code 1\n" }).rerun, false);
  // 注意の文（capacity constraints）だけでは走らせ直さない
  assert.equal(
    runRerun(["11"], {
      11: "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.\n",
    }).rerun,
    false,
  );
  assert.equal(runRerun([], {}).rerun, false);
});

test("ci-macos.yml・release.yml の dist は macos-latest で、最初の段で arm64 でなければ止める", () => {
  const rel = read("release.yml");
  assert.match(rel, /os: \[macos-latest\]/);
  for (const [name, text, job] of [
    ["ci-macos.yml", mac, "  check:\n"],
    ["release.yml", rel, "  dist:\n"],
  ]) {
    const body = text.slice(text.indexOf(job));
    const first = body.slice(body.indexOf("    steps:\n")).split("\n      - ")[1];
    assert.match(first, /Apple Silicon（arm64）/, `${name}: 最初の段が arm64 の確かめでない`);
    assert.match(first, /\[ "\$\{arch\}" = arm64 \] \|\| \{.*exit 1; \}/, name);
  }
});
