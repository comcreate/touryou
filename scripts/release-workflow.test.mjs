// .github/workflows/release.yml のジョブの形を確かめる（CI で、実行しないと分からない失敗の一部を先に見つける）。
// `node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const text = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

/** `- name: <name>` の step の `run: |` の本文（インデントを外したもの）。 */
function runBlock(name) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `step「${name}」がない`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  assert.ok(runAt > at, `step「${name}」に run: | がない`);
  const body = [];
  let indent;
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() === "") {
      body.push("");
      continue;
    }
    const n = l.length - l.trimStart().length;
    indent ??= n;
    if (n < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

test("release: secrets を参照しない（GITHUB_TOKEN だけで動く）", () => {
  assert.doesNotMatch(text, /\bsecrets\./);
  assert.doesNotMatch(text, /create-github-app-token/);
});

/** release.yml の中の、この run のリポジトリの書き方（シェルの変数の展開）。 */
const REPO = ["$", "{GITHUB_REPOSITORY}"].join("");

test("release: 書き込み先のリポジトリは、この run のリポジトリ（GITHUB_REPOSITORY）だけ", () => {
  // gh の --repo・repos/<owner>/<name> は、どれも ${GITHUB_REPOSITORY} を指す
  const targets = [
    ...text.matchAll(/--repo\s+(\S+)|\brepos\/(\$\{GITHUB_REPOSITORY\}|[^/"\s]+\/[^/"\s]+)/g),
  ].map((m) => (m[1] ?? m[2]).replace(/"/g, ""));
  assert.ok(targets.length > 0);
  for (const t of targets) assert.equal(t, REPO);
  // gh を通らない書き込みの道（git）。行をシェルの区切り（; && || | $( など）で分け、git の呼び出しごとに見る。
  // - 大域のオプション（-C・-c・--git-dir・--work-tree など）を付けた git は使わない（行き先や設定を、確かめの外で変えうるため）
  // - remote は使わない。config で remote.* を書かない（origin の先を付け替えない）
  // - push の行き先は origin（この run の checkout）だけ
  for (const line of text.split("\n")) {
    for (const seg of line.split(/;|&&|\|\||\||\$\(|`/)) {
      const m = seg.match(/(?:^|\s)git\s+(.*)$/);
      if (m === null) continue;
      const words = m[1].trim().split(/\s+/);
      const [sub, ...args] = words;
      assert.doesNotMatch(sub, /^-/, `大域のオプションを付けた git: ${line.trim()}`);
      assert.notEqual(sub, "remote", line.trim());
      if (sub === "config") assert.ok(!args.some((w) => /remote\./.test(w)), line.trim());
      if (sub === "push") {
        const dests = args.filter((w) => !w.startsWith("-"));
        assert.equal(dests[0], "origin", `push の行き先が origin でない: ${line.trim()}`);
      }
    }
    // github.com・api.github.com・uploads.github.com の URL は、この run のリポジトリだけを指す
    for (const u of line.matchAll(
      /(?:https:\/\/github\.com|(?:api|uploads)\.github\.com\/repos)\/(\S*)/g,
    )) {
      assert.ok(u[1].startsWith(REPO), line.trim());
      assert.match(u[1].slice(REPO.length), /^(?:[/"\s]|$)/, line.trim());
    }
  }
  // checkout で別のリポジトリを取らない
  assert.doesNotMatch(text, /^\s+repository:/m);
  // owner/name の形の、ほかのリポジトリの名前を書かない（actions の uses は除く）
  const others = [...text.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@/g)].map((m) => m[1]);
  for (const o of others) assert.match(o, /^(actions|pnpm)\//);
  const jobs = [
    ...text.slice(text.indexOf("\njobs:\n")).matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm),
  ].map((m) => m[1]);
  assert.deepEqual(jobs, ["version", "dist", "release", "marketplace-self", "cleanup"]);
});

const dist = readFileSync(new URL("../.github/workflows/ci-macos.yml", import.meta.url), "utf8");

/** `  <name>:` のジョブの本文（次の 2 字下げのジョブまで）。 */
function jobBlock(src, name) {
  const lines = src.split("\n");
  const at = lines.findIndex((l) => l === `  ${name}:`);
  assert.ok(at >= 0, `ジョブ ${name} がない`);
  const end = lines.findIndex((l, i) => i > at && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

/** upload-artifact の step の本文（次の step まで）。 */
function uploadSteps(src) {
  return src.split(/\n(?= {6}- )/).filter((s) => /uses: actions\/upload-artifact@/.test(s));
}

test("ci-macos（配布物の確かめ）: artifact を上げるのは、手で実行したときだけ（PR では上げない）。保存は 1 日", () => {
  const ups = uploadSteps(dist);
  assert.equal(ups.length, 1);
  assert.match(ups[0], /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(ups[0], /retention-days: 1\b/);
});

test("release: dist の artifact の保存は 1 日", () => {
  const ups = uploadSteps(text);
  assert.ok(ups.length >= 1);
  for (const u of ups) assert.match(u, /retention-days: 1\b/);
});

test("release: cleanup のジョブは、release が成功したときだけ動き（失敗したときは artifact を残し、release だけを再実行できる）、権限は actions: write だけ。消すのはこの run の artifact だけ", () => {
  const c = jobBlock(text, "cleanup");
  assert.match(c, /needs: \[dist, release\]/);
  assert.match(c, /if: always\(\) && needs\.release\.result == 'success'/);
  assert.doesNotMatch(c, /if: always\(\)\n/);
  const perm = /permissions:\n((?: {6}[a-z-]+: \w+\n)+)/.exec(`${c}\n`)?.[1] ?? "";
  assert.equal(perm.trim(), "actions: write");
  assert.match(c, /actions\/runs\/\$\{GITHUB_RUN_ID\}\/artifacts/);
  assert.doesNotMatch(c, /contents: write/);
});

test("release: zip の許可リストは、plugin/ に置いた配るファイル（中継の scripts/touryou-mcp-shim.sh・本体の導入の scripts/install-runtime.sh・版の知らせの scripts/runtime-version-notice.sh を含む）をすべて通し、ほかは通さない", () => {
  const src = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const m = src.match(/grep -Ev '(\^\(.*\)\$)'/);
  assert.ok(m, "許可リストの grep -Ev が見つからない");
  const allow = new RegExp(m[1]);
  const files = spawnSync("git", ["ls-files", "plugin"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((f) => f && !f.endsWith(".gitkeep"))
    .map((f) => f.slice("plugin/".length));
  assert.ok(files.includes("scripts/touryou-mcp-shim.sh"));
  assert.ok(files.includes("scripts/install-runtime.sh"));
  assert.ok(files.includes("scripts/runtime-version-notice.sh"));
  for (const f of files) assert.match(f, allow, f);
  for (const f of [
    "bin/other.sh",
    ".env",
    "node_modules/x/index.js",
    "scripts/touryou-mcp-shim.sh.bak",
    "scripts/other.sh",
    "scripts/install-runtime.sh.bak",
    "scripts/sub/install-runtime.sh",
  ]) {
    assert.doesNotMatch(f, allow, f);
  }
});

const SELF_STEP = "同じリポジトリの marketplace.json を書き換えて PR を出す";

test("marketplace-self: 同じリポジトリの marketplace.json への PR は GITHUB_TOKEN で出す（App・secrets を使わない）。bash の構文として正しい", () => {
  const job = /\n {2}marketplace-self:\n([\s\S]*?)\n {2}[A-Za-z0-9_-]+:\n/.exec(text)?.[1] ?? "";
  assert.ok(job, "marketplace-self のジョブがない");
  assert.match(job, /needs: release/);
  assert.match(job, /contents: write/);
  assert.match(job, /pull-requests: write/);
  assert.match(job, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(job, /create-github-app-token|secrets\./);
  const body = runBlock(SELF_STEP);
  assert.equal(spawnSync("bash", ["-n"], { input: body, encoding: "utf8" }).status, 0);
  assert.match(
    body,
    /jq -r \.name plugin\/\.claude-plugin\/plugin\.json/,
    "名前は plugin.json から取る",
  );
  assert.match(body, /gh pr create --repo "\$\{GITHUB_REPOSITORY\}" --head "\$\{branch\}"/);
  assert.doesNotMatch(body, /headersHelper"?\s*:/, "headersHelper を書かない");
  // GITHUB_TOKEN の PR では pull_request の CI が動かないので、PR を出したあとに ci.yml を workflow_dispatch で起こす
  assert.match(job, /actions: write/);
  const dispatch = body.indexOf(
    `gh api -X POST "repos/${REPO}/actions/workflows/ci.yml/dispatches" -f ref="${["$", "{branch}"].join("")}"`,
  );
  assert.ok(dispatch > 0, "ci.yml を PR のブランチで workflow_dispatch すること");
  assert.ok(dispatch > body.indexOf("gh pr create"), "PR を出したあとに起こすこと");
  assert.match(body, /del\(\.headersHelper, \.strict\)/);
});

test("marketplace-self: url は browser_download_url（認証なし）", () => {
  assert.match(runBlock(SELF_STEP), /DOWNLOAD_URL/);
  assert.match(text, /\.browser_download_url/);
  assert.doesNotMatch(text, /asset_url/);
});

test(".claude-plugin/marketplace.json: name・owner・plugins（配列）があり、headersHelper を含まない", () => {
  const m = JSON.parse(
    readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"),
  );
  assert.equal(typeof m.name, "string");
  assert.equal(typeof m.owner?.name, "string");
  assert.ok(Array.isArray(m.plugins));
  assert.doesNotMatch(JSON.stringify(m), /headersHelper/);
});

const hasJq = spawnSync("jq", ["--version"]).status === 0;

test("marketplace-self: release.yml の jq は上の階層（metadata.description など）を保ち、出力の形（2 空白の字下げ）は今のファイルと同じ", {
  skip: hasJq ? false : "jq が無いので飛ばす",
}, () => {
  const body = runBlock(SELF_STEP);
  const prog = /jq --arg n [^']*'([\s\S]*?)' "\$\{file\}" > "\$\{file\}\.new"/.exec(body)?.[1];
  assert.ok(prog, "jq の式が見つからない");
  const path = new URL("../.claude-plugin/marketplace.json", import.meta.url);
  const src = readFileSync(path, "utf8");
  const m = JSON.parse(src);
  assert.equal(typeof m.metadata?.description, "string", "metadata.description がない");
  const p = m.plugins[0];
  const run = (ver) =>
    spawnSync(
      "jq",
      [
        "--arg",
        "n",
        p.name,
        "--arg",
        "d",
        p.description,
        "--arg",
        "url",
        p.source.url,
        "--arg",
        "sha",
        p.source.sha256,
        "--arg",
        "ver",
        ver,
        prog,
      ],
      { input: src, encoding: "utf8" },
    );
  const same = run(p.version);
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.stdout, src, "同じ値で jq を通すと、ファイルと一字一句同じになる");
  const next = JSON.parse(run("9.9.9").stdout);
  assert.deepEqual(next.metadata, m.metadata);
  assert.equal(next.name, m.name);
  assert.deepEqual(next.owner, m.owner);
  assert.equal(next.plugins[0].version, "9.9.9");
});
