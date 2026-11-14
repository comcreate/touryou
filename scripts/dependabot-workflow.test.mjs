// .github/dependabot.yml と、Dependabot の自動マージの workflow（dependabot-auto-merge.yml・dependabot-main-ci.yml）の守りを確かめる。
// `node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (f) => readFileSync(new URL(`../.github/${f}`, import.meta.url), "utf8");
const dependabot = read("dependabot.yml");
const merge = read("workflows/dependabot-auto-merge.yml");
const mainCi = read("workflows/dependabot-main-ci.yml");
const ci = read("workflows/ci.yml");

/** 注釈を除いた行（# から後ろ）。 */
const code = (src) =>
  src
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, ""))
    .join("\n");

test("dependabot.yml: github-actions だけ（npm は入れない）。directory は /。週に 1 回で、曜日・時刻・時間帯を決める", () => {
  const ecosystems = [...dependabot.matchAll(/package-ecosystem: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ecosystems, ["github-actions"]);
  assert.match(dependabot, /\n {4}directory: "\/"\n/);
  assert.match(dependabot, /\n {6}interval: "weekly"\n/);
  assert.match(dependabot, /\n {6}day: "monday"\n/);
  assert.match(dependabot, /\n {6}time: "\d\d:\d\d"\n/);
  assert.match(dependabot, /\n {6}timezone: "Asia\/Tokyo"\n/);
});

test("dependabot.yml: cooldown は 14 日（default-days）。patch・minor だけを 1 つの group にまとめる（メジャーは別の PR）。ラベルは既にある chore", () => {
  assert.match(dependabot, /\n {4}cooldown:\n {6}default-days: 14\n/);
  assert.match(
    dependabot,
    /\n {4}groups:\n {6}[a-z][a-z-]*[a-z]:\n {8}patterns:\n {10}- "\*"\n {8}update-types:\n {10}- "minor"\n {10}- "patch"\n(?! {10}-)/,
  );
  assert.equal(
    [...dependabot.matchAll(/\n {6}[a-z][a-z-]*[a-z]:\n {8}patterns:/g)].length,
    1,
    "group は 1 つ",
  );
  assert.match(dependabot, /\n {4}labels:\n {6}- "chore"\n(?! {6}-)/);
  assert.match(dependabot, /\n {6}prefix: "\[update\] "\n/);
});

/** uses: の行がすべて 40 桁の SHA で固定され、「# vX.Y.Z」の注釈が付くこと。 */
function assertPinned(src, name) {
  const uses = [...src.matchAll(/uses: (\S+)(.*)$/gm)];
  for (const [, ref, rest] of uses) {
    assert.match(
      ref,
      /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/,
      `${name}: ${ref} が SHA で固定されていない`,
    );
    assert.match(rest, /^ # v\d+\.\d+\.\d+$/, `${name}: ${ref} に # vX.Y.Z の注釈がない`);
  }
  return uses.length;
}

test("自動マージの workflow: pull_request で動き、pull_request_target を使わない。checkout しない。actions は SHA で固定", () => {
  for (const [name, src] of [
    ["dependabot-auto-merge.yml", merge],
    ["dependabot-main-ci.yml", mainCi],
  ]) {
    assert.doesNotMatch(code(src), /pull_request_target/, name);
    assert.doesNotMatch(code(src), /actions\/checkout/, name);
  }
  assert.match(merge, /\non: pull_request\n/);
  assert.equal(assertPinned(merge, "dependabot-auto-merge.yml"), 1);
  assert.match(merge, /uses: dependabot\/fetch-metadata@[0-9a-f]{40} # v\d/);
  assert.equal(assertPinned(mainCi, "dependabot-main-ci.yml"), 0);
});

test("自動マージの workflow: permissions は contents: write・pull-requests: write だけ（job の permissions を足さない）", () => {
  const perms = /\npermissions:\n((?: {2}.*\n)+)/.exec(merge);
  assert.ok(perms);
  assert.deepEqual(
    perms[1]
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .sort(),
    ["contents: write", "pull-requests: write"],
  );
  assert.equal([...merge.matchAll(/permissions:/g)].length, 1);
});

test("自動マージの workflow: 出したのが dependabot[bot] で、このリポジトリのときだけ。github_actions の patch・minor で、.github/workflows/ の中だけのときに --auto --squash", () => {
  assert.match(
    merge,
    /\n {4}if: github\.event\.pull_request\.user\.login == 'dependabot\[bot\]' && github\.repository == 'comcreate\/touryou'\n/,
  );
  const steps = merge
    .slice(merge.indexOf("\n    steps:\n"))
    .split(/\n(?= {6}- )/)
    .slice(1);
  const at = steps.findIndex((s) => /gh pr merge --auto --squash "\$PR_URL"/.test(s));
  assert.ok(at > 0);
  const cond = steps[at];
  assert.match(cond, /steps\.metadata\.outputs\.package-ecosystem == 'github_actions'/);
  assert.match(cond, /update-type == 'version-update:semver-patch'/);
  assert.match(cond, /update-type == 'version-update:semver-minor'/);
  assert.doesNotMatch(cond, /semver-major/);
  assert.match(cond, /steps\.files\.outputs\.only_workflows == 'true'/);
  // auto-merge を付けるのは、この 1 か所だけ
  assert.equal([...code(merge).matchAll(/gh pr merge --auto/g)].length, 1);
  assert.doesNotMatch(code(merge), /--admin/);
});

test("自動マージの workflow: .github/workflows/ の外のファイル（と空の一覧）なら only_workflows=false", () => {
  const files = merge.slice(merge.indexOf("id: files"));
  assert.match(files, /grep -v '\^\\\.github\/workflows\/\[\^\/\]\*\\\.ya\\\?ml\$'/);
  assert.match(files, /\[ -z "\$\{files\}" \] \|\| \[ -n "\$\{outside\}" \]/);
});

test("main の CI: ci.yml（name: CI）の pull_request の成功のあと、dependabot[bot] の同じリポジトリの PR がマージされたら、main で ci.yml を workflow_dispatch する", () => {
  assert.match(ci, /^name: CI\n/);
  assert.match(ci, /\n {2}workflow_dispatch:\n/);
  assert.match(mainCi, /\n {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]\n/);
  for (const c of [
    "github.repository == 'comcreate/touryou'",
    "github.event.workflow_run.event == 'pull_request'",
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.actor.login == 'dependabot[bot]'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
  ])
    assert.ok(mainCi.includes(c), c);
  const perms = /\npermissions:\n((?: {2}.*\n)+)/.exec(mainCi);
  assert.deepEqual(
    perms[1]
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .sort(),
    ["actions: write", "pull-requests: read"],
  );
  assert.match(mainCi, /actions\/workflows\/ci\.yml\/dispatches" -f ref=main/);
  assert.match(mainCi, /select\(\.user\.login == "dependabot\[bot\]"/);
});
