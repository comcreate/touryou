// plugin/commands/setup.md の、安全に関わる決まりの試験。`node --test scripts/*.test.mjs`
// - allowed-tools の照合の規則（`:*` の語境界・連結・リダイレクト）は、Claude Code の実装で未確認なので、パターンに頼らない: 事前に許可するのは `Read` だけ。
// - この試験は、**文書の内容**を検査する（モデルが文書どおりに動くことは、試験では保証できない。文書の「進め方の決まり」に明記）。
//   手順 2（設定）のコマンドは、文書から取り出して、実際にシェルで走らせる。導入の script の動きは install-runtime.test.mjs。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(join(root, "plugin", "commands", "setup.md"), "utf8");
const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
assert.ok(front, "frontmatter がない");
const allowedLine = /^allowed-tools:\s*(.*)$/m.exec(front[1]);
const body = text.slice(front[0].length);
const rules = /## 進め方の決まり\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
const rest = body.replace(rules, "");

/** 「手順」の節の、手順 N の本文（次の手順の直前まで）。 */
const steps = new Map();
{
  const section = /## 手順\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
  for (const p of section.split(/\n(?=\d+\. \*\*)/)) {
    const n = /^(\d+)\. \*\*/.exec(p)?.[1];
    if (n !== undefined) steps.set(Number(n), p);
  }
}
const step = (n) => steps.get(n) ?? "";
const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
/** 手順 N の、先頭のコマンド（`…` のコード片のうち、`startsWith` で始まるもの）。 */
const command = (n, startsWith) => {
  const spans = [...step(n).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const c = spans.find((s) => s.startsWith(startsWith));
  assert.ok(c, `手順 ${n} に ${startsWith} で始まるコマンドがない`);
  return c;
};

test("allowed-tools は、Read だけ（Bash・Write・xattr などを、事前に許可しない）", () => {
  assert.ok(allowedLine, "allowed-tools がない");
  assert.deepEqual(
    (allowedLine[1] ?? "").split(",").map((t) => t.trim()),
    ["Read"],
  );
});

test("手順は 1〜3 が、この順で、すべてある（導入の script < 設定 < 起動のしかた）", () => {
  assert.deepEqual([...steps.keys()], [1, 2, 3]);
  const at = (s) => body.indexOf(s);
  assert.ok(
    at("1. **本体の導入") < at("2. **設定ファイル") &&
      at("2. **設定ファイル") < at("3. **起動のしかた"),
  );
});

test("手順 1: plugin の中の script を、引数なしの 1 コマンドで走らせる（取得・照合・展開・付け替えは script の中）。長めのタイムアウト", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: command の本文で Claude Code が展開する変数の参照
  assert.equal(
    command(1, "env "),
    'env -u BASH_ENV -u ENV bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-runtime.sh"',
  );
  const s = step(1);
  assert.match(s, /タイムアウトを長め（最大 10 分）にして実行する/);
  assert.match(s, /置き換わっていない（`\$\{CLAUDE_PLUGIN_ROOT\}` の文字のまま）ときは、止まる/);
  assert.match(s, /\*\*通るまで、展開も実行もしない\*\*/);
  for (const r of [
    "installed",
    "already",
    "upgraded",
    "upgraded-restarted",
    "need-restart-consent",
    "plugin-older",
    "failed",
  ]) {
    assert.ok(s.includes(`\`RESULT: ${r}\``), r);
  }
  // script の出す RESULT の語と、文書の語が一致する
  const sh = readFileSync(join(root, "plugin", "scripts", "install-runtime.sh"), "utf8");
  const words = new Set([...sh.matchAll(/finish \d ([a-z-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...words].sort(), [
    "already",
    "failed",
    "installed",
    "need-restart-consent",
    "plugin-older",
    "upgraded",
    "upgraded-restarted",
  ]);
  assert.ok(existsSync(join(root, "plugin", "scripts", "install-runtime.sh")));
});

test("手順 1 の script の取得元は、plugin.json の repository と、release.yml の asset の置き場（v<版>/<name>）", () => {
  const sh = readFileSync(join(root, "plugin", "scripts", "install-runtime.sh"), "utf8");
  const repo = JSON.parse(
    readFileSync(join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
  ).repository;
  assert.ok(sh.includes(`REPO_URL="${repo}"`));
  assert.ok(sh.includes('"${REPO_URL}/releases/download/v${ver}/${name}"'));
  const wf = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(wf, /tags: \["v\*"\]/);
  assert.match(wf, /gh release create "\$\{GITHUB_REF_NAME\}"/);
});

test("トークンを出さない: gh auth token・--show-token・GH_TOKEN の設定・Authorization は、「進め方の決まり」の禁止の記述以外に出ない", () => {
  for (const re of [
    /gh auth token/,
    /--show-token/,
    /GH_TOKEN/,
    /Authorization/,
    /\bgh release\b/,
  ]) {
    assert.doesNotMatch(rest, re, `進め方の決まり以外に出てはいけない: ${re}`);
  }
  assert.match(rules, /GitHub のトークンを、出さない・読まない・貼らせない/);
  assert.match(
    rules,
    /\*\*それでも script が、取得したファイルと展開したファイルで、必ず確かめる\*\*/,
  );
});

test("危険なコマンドは、「進め方の決まり」以外に出ない（xattr・rm・eval・bash -c・sudo・spctl・codesign・curl | sh・cat）", () => {
  for (const re of [
    /\bxattr\b/,
    /\bsudo\b/,
    /\brm\s+\S/,
    /\beval\b/,
    /\b(?:ba|z)?sh\s+-c\b/,
    /\bspctl\b/,
    /\bcodesign\b/,
    /curl[^\n]*\|\s*(?:ba|z)?sh\b/,
    /\bcat\b/,
    /chmod\s+-R\b/,
    /launchctl (?:bootstrap|bootout|kickstart|load)/,
  ]) {
    assert.doesNotMatch(rest, re, `進め方の決まり以外に出てはいけない: ${re}`);
  }
  assert.match(rules, /quarantine を、外さない/);
  assert.match(rules, /`xattr` の書き換え〔`-d`・`-c`・`-w`〕・`sudo`・`rm` は、実行しない/);
  assert.match(rules, /`root-token` などのトークンのファイルは、読まない・出さない/);
  assert.match(rules, /手順 1 の script の中の `curl` だけ/);
  assert.match(rules, /引数・環境変数では変えられない。受け付ける引数は `--restart-daemon` だけ/);
  assert.doesNotMatch(body, /ブラウザ[^。\n]*(?:で取得して|からダウンロードして)ください/);
});

test("限界の明記と承認の回数: 安全は人の確認と script の sha256 の照合に依る。約 3 回", () => {
  assert.match(
    rules,
    /安全は、「承認のときに、人が、画面のコマンドが手順 1 のとおりであることを確かめること」と「script の中の sha256 の照合」に依る/,
  );
  assert.match(rules, /文書どおりに動くことは、試験では保証できない/);
  assert.match(text, /約 3 回、コマンドの承認の確認が出ます/);
  assert.doesNotMatch(text, /約 12 回/);
  // 3 つのほかに Bash を走らせない・確かめは出力と Read・node の道具を呼ばない（#63）
  assert.match(
    rules,
    /この `\/setup` の中で走らせる Bash は、手順 1・手順 2・手順 3-A の 2 の 3 つだけ/,
  );
  assert.match(rules, /確かめのための別のコマンドは、走らせない/);
  assert.match(rules, /前もって別のコマンドで確かめない/);
  assert.match(rules, /手順 1 を引数なしで 1 回[^\n]*`--restart-daemon` つきで 1 回、の 2 回/);
  assert.match(body, /手順 2 のコマンドを、置き換える値だけ変えて、もう 1 回走らせてよい/);
  assert.match(rules, /`\/touryou:start` の中身を、代わりに実行しない/);
  assert.match(
    text,
    /auto モード（権限の自動判定）[^\n]*自動判定で止められたときは、出た文面をそのまま利用者に伝え/,
  );
  assert.match(text, /\*\*チャットでの「はい」[^\n]*auto モードでも必ず取る\*\*/);
  // 承認の要る Bash は、手順 1・2（新規の設定か、移行のどちらか）・3-A の 1 つずつ（と、常駐の版上げの 1 つ）
  const cmds = [
    ...body.matchAll(
      /`((?:env -u BASH_ENV -u ENV bash "\$\{CLAUDE_PLUGIN_ROOT\}|R="<repoRoot>"|"\$HOME\/\.touryou\/current\/bin\/touryou" (?:supervisor register|migrate --yes))[^`]*)`/g,
    ),
  ];
  assert.equal(cmds.length, 5, cmds.map((m) => m[1]).join("\n"));
});

const CONFIG_CMD = () => command(2, 'R="<repoRoot>"');
const runConfig = (shell, home, repo, wt, cmds = '"git status"') => {
  const c = CONFIG_CMD()
    .replaceAll("<repoRoot>", repo)
    .replaceAll("<worktreeRoot>", wt)
    .replaceAll("<allowedCommands>", cmds);
  return spawnSync(shell, ["-c", c], {
    env: { PATH: process.env.PATH, HOME: home },
    encoding: "utf8",
  });
};
const SHELLS = ["bash", "sh", ...(spawnSync("zsh", ["--version"]).status === 0 ? ["zsh"] : [])];

for (const shell of SHELLS) {
  test(`[${shell}] 手順 2（実行）: 必須の 5 項目の JSON を、600 で 1 回だけ書く。ホームの外・git でない・すでにある、は書かない`, () => {
    const home = mkdtempSync(join(tmpdir(), "touryou-setup-cfg-"));
    made.push(home);
    const repo = join(home, "repo");
    mkdirSync(repo);
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
    // .touryou/ が ignore されていないと、書かない（daemon の検査が通らないため）
    assert.notEqual(runConfig(shell, home, repo, join(repo, ".touryou", "worktrees")).status, 0);
    assert.ok(!existsSync(join(repo, ".touryou")));
    writeFileSync(join(repo, ".gitignore"), ".touryou/\n");
    const r = runConfig(
      shell,
      home,
      repo,
      join(repo, ".touryou", "worktrees"),
      '"git status", "git add", "git commit"',
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
    const f = join(repo, ".touryou", "config.json");
    const j = JSON.parse(readFileSync(f, "utf8"));
    const doc = readFileSync(join(root, "docs", "config.md"), "utf8");
    const required = [
      ...(/## 必須の項目\n([\s\S]*?)\n## /.exec(doc)?.[1] ?? "").matchAll(/^\| `(\w+)` \|/gm),
    ].map((m) => m[1]);
    assert.deepEqual(Object.keys(j), required);
    assert.equal(j.stateDir, join(repo, ".touryou", "state"));
    assert.equal(j.worktreeRoot, join(repo, ".touryou", "worktrees"));
    assert.equal(j.repoRoot, repo);
    assert.equal(j.rootCwd, repo);
    assert.deepEqual(j.rootScope.allowedCommands, ["git status", "git add", "git commit"]);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(statSync(join(repo, ".touryou", "state")).mode & 0o777, 0o700);
    // すでにある → 上書きしない
    writeFileSync(f, "{}");
    assert.notEqual(runConfig(shell, home, repo, join(home, "wt")).status, 0);
    assert.equal(readFileSync(f, "utf8"), "{}");
    rmSync(f);
    // ホームの外・git でない
    assert.notEqual(runConfig(shell, home, tmpdir(), join(home, "wt")).status, 0);
    assert.notEqual(runConfig(shell, home, repo, tmpdir()).status, 0);
    const plain = join(home, "plain");
    mkdirSync(plain);
    assert.notEqual(runConfig(shell, home, plain, join(home, "wt")).status, 0);
    assert.ok(!existsSync(f));
  });
}

test("手順 2: パスの決まり・トークンを書かない・commit の問い", () => {
  const s = step(2);
  assert.match(s, /トークンの値は、設定ファイルに書かない/);
  assert.doesNotMatch(s, /mcpUrl/);
  assert.match(s, /定型文（commit）/);
  assert.match(text, /改行・引用符（`"`・`'`・`` ` ``）・`\$`・`;`・`\\` を含むときは、止まる/);
});

test("手順 3: 常駐は、同意の定型文にはっきり「はい」のときだけ。touryou launchd の決まったサブコマンドだけを使う", () => {
  const s = step(3);
  assert.match(
    rules,
    /常駐（launchd）の登録は、利用者が定型文の問いに、はっきり「はい」と答えたときだけ/,
  );
  assert.match(
    rules,
    /`--yes`・`--restart-daemon` は、利用者が定型文の問いにチャットで「はい」と答えたあとにだけ付ける。承認ダイアログの許可だけでは付けない/,
  );
  assert.match(s, /それ以外（「いいえ」・あいまい・質問）は、登録せずに 3-B へ進む/);
  assert.ok(s.indexOf("**同意**") < s.indexOf("supervisor apply --yes"), "apply の前に同意を取る");
  assert.match(
    s,
    /`"\$HOME\/\.touryou\/current\/bin\/touryou" supervisor register --config "<repoRoot>\/\.touryou\/config\.json" && "\$HOME\/\.touryou\/current\/bin\/touryou" supervisor init && "\$HOME\/\.touryou\/current\/bin\/touryou" supervisor apply --yes`/,
  );
  assert.match(rules, /\*\*子の認証は扱わない\*\*/);
  for (const re of [/setup-token/, /oauth-token/, /run-mcp\.sh/, /--daemon-url/])
    assert.doesNotMatch(s, re);
});

test("手順 3: 3-A・3-B の最後は、自動でつながるのを待って /start。つながらないときだけ Reconnect（または起動し直す）", () => {
  const s = step(3);
  const a = s.slice(s.indexOf("**3-A."), s.indexOf("**3-B."));
  const b = s.slice(s.indexOf("**3-B."));
  for (const part of [a, b]) {
    assert.match(part, /`\/mcp` で `plugin:touryou:node` を選んで Reconnect する/);
    assert.match(part, /Claude Code を起動し直す/);
    assert.match(part, /\*\*つながるのを待つ\*\*: [^\n]*自動でつながる（Reconnect は要らない/);
    assert.ok(part.indexOf("自動でつながる") < part.indexOf("/touryou:start"), "待ってから /start");
  }
});

test("版が変わり、常駐しているとき: はっきり「はい」のときだけ --restart-daemon。それ以外は何もしない。あとで Reconnect", () => {
  const up = /## 版が変わり、常駐しているとき\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
  assert.match(up, /`RESULT: need-restart-consent`（終了コード 3）/);
  assert.match(
    up,
    /\*\*はっきり「はい」のときだけ\*\* `env -u BASH_ENV -u ENV bash "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/install-runtime\.sh" --restart-daemon`/,
  );
  assert.match(up, /それ以外（「いいえ」・あいまい・質問）は、何もせずに、版を上げずに終わる/);
  assert.match(up, /動いている子のセッションは止まりません/);
  const after = /## 版を上げたあと\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
  assert.match(after, /古い版のまま動き続ける/);
  assert.match(after, /`\/mcp` で `plugin:touryou:node` を選んで Reconnect する/);
});

test("plugin が本体より古いとき（#154）: 手順 1 は plugin-older（終了コード 4）で止まる。plugin の update の例は、すべて --scope user つき（#153）", () => {
  assert.match(step(1), /`RESULT: plugin-older`（終了コード 4。/);
  assert.match(step(1), /定型文（plugin が古い）:/);
  assert.match(body, /`RESULT: plugin-older`）は、常駐していても、この問いを出さずに/);
  const updates = [...body.matchAll(/claude plugin update touryou@touryou[^`\n]*/g)];
  assert.ok(updates.length >= 3, "update の例が 3 か所以上ある");
  for (const m of updates) assert.match(m[0], /--scope user/, m[0]);
});

test("症状表: 観察した症状のとおり（約 1 分後に終了）。原因が未確認のものは、未確認と書く。相談先は『この plugin を配布した COMCREATE』", () => {
  assert.match(body, /起動して約 1 分後に終了する/);
  assert.match(body, /`Killed: 9`、「開けません」 \| 原因は未確認/);
  assert.doesNotMatch(body, /管理者/);
  assert.match(body, /目安として約 41MB/);
  // 取得しないこともある書き方（同じ版がすでに入っているときは、取得しない。#62）
  assert.match(body, /初めてのときと、版が変わったときは、配布物を取得します/);
  assert.match(body, /同じ版がすでに入っているときは、取得しません/);
  assert.doesNotMatch(body, /定型文: 「配布物を取得します/);
  // --restart-daemon での 2 回目の実行の前にも、手順 1 の定型文を言う（1 回目は取得の前に終わる）
  assert.match(body, /この実行の前に、手順 1 の定型文（script を実行する前）を、もう一度言う/);
  assert.doesNotMatch(body, /実機/);
  assert.match(body, /利用者が、自分で消してよい/);
  assert.match(body, /消さなくても動く/);
});

const CONTACT = "contact@comcreate-info.com";
const CONTACT_TEXT = `COMCREATE（連絡先: ${CONTACT}）`;

test("連絡先: プレースホルダーが残らない", () => {
  for (const f of [
    "plugin/commands/setup.md",
    "plugin/.claude-plugin/plugin.json",
    "docs/launchd.md",
  ]) {
    const text = readFileSync(join(root, f), "utf8");
    assert.doesNotMatch(text, /<担当者の連絡先>/, `${f}: プレースホルダーが残っている`);
  }
});

test("連絡先: 案内文（定型文 5 行・症状表 3 行）の、どれにも入っている", () => {
  const lines = readFileSync(join(root, "plugin/commands/setup.md"), "utf8").split("\n");
  const pick = (re) => {
    const found = lines.filter((l) => re.test(l));
    assert.equal(found.length, 1, `${re}: ちょうど 1 行にある`);
    return found[0];
  };
  const targets = [
    /^\s*定型文（`checksums\.json` がない/,
    /^\s*定型文（照合の失敗）/,
    /^\s*定型文（取得の失敗）/,
    /^\s*定型文（quarantine）/,
    /^\s*定型文: 「配布物の中身が、想定と違います/,
    /^\| `touryou-daemon --help` は通るが/,
    /^\| `Killed: 9`/,
    /^\| 手順 1 で、照合に失敗する/,
  ];
  for (const re of targets) assert.ok(pick(re).includes(CONTACT_TEXT), `${re}: 連絡先が入っている`);
  const all = lines.join("\n").split(CONTACT_TEXT).length - 1;
  assert.equal(all, targets.length, "連絡先の案内は、この 8 か所だけ");
});

test("連絡先: 追跡している md・json のメールアドレスは、許可の 1 件と、予約済みの試験用のドメインだけ", () => {
  const r = spawnSync("git", ["ls-files", "*.md", "*.json"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, "git ls-files が動く");
  const found = new Map();
  for (const f of r.stdout.split("\n").filter((x) => x !== "" && !x.endsWith("lock.json"))) {
    const text = readFileSync(join(root, f), "utf8");
    // 末尾が英字の TLD のものだけ（`name@10.28.0` のような、パッケージの版は、アドレスではない）
    for (const m of text.matchAll(
      /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    )) {
      found.set(m[0].toLowerCase(), f);
    }
  }
  const reserved = /@([a-z0-9.-]+\.)?(example\.(com|org|net)|invalid)$/;
  const unexpected = [...found].filter(([a]) => a !== CONTACT && !reserved.test(a));
  assert.deepEqual(unexpected, [], "許可の 1 件・試験用のドメイン以外のアドレスがある");
  assert.ok(found.has(CONTACT));
});

test("start.md: /setup の直後は、Reconnect（または起動し直し）を案内する", () => {
  const start = readFileSync(new URL("../plugin/commands/start.md", import.meta.url), "utf8");
  assert.match(start, /`\/setup` を同じ会話で実行した直後なら/);
  assert.match(start, /自動でつながる/);
  assert.match(start, /Reconnect/);
});

test("setup.md: 別名の daemon だけが常駐のとき（LAUNCHD_OTHERS: present）は、手順 3 を飛ばして service を案内する（#165）", () => {
  const line = body.split("\n").find((l) => l.includes("`RESULT: already`"));
  assert.ok(line, "RESULT: already の行がある");
  assert.match(line, /`LAUNCHD: absent` でも `LAUNCHD_OTHERS: present`/);
  assert.match(line, /手順 3 も飛ばす/);
  assert.match(line, /\/touryou:service/);
});

test("service.md: uninstall-all は supervisor uninstall --yes を 1 回だけ実行し、--others を使わない（#300）", () => {
  const service = readFileSync(join(root, "plugin", "commands", "service.md"), "utf8");
  const lines = service.split("\n");
  const start = lines.findIndex((l) => l.startsWith("- **uninstall-all**"));
  assert.ok(start >= 0, "uninstall-all の節がある");
  // 節は、次の「- **」で始まる行（なければ末尾）まで
  const next = lines.findIndex((l, i) => i > start && l.startsWith("- **"));
  const section = lines.slice(start, next === -1 ? undefined : next).join("\n");
  assert.match(section, /1 回だけ/);
  assert.match(section, /supervisor uninstall --yes/);
  assert.doesNotMatch(section, /--others/);
  assert.doesNotMatch(section, /最大 2 回/);
});

test("setup.md: .gitignore の追記はコミットまで頼む（未保存で残ると node_integrate が targetDirty になる）", () => {
  const m = text.match(/定型文（\.gitignore）: 「([^」]*)」/);
  assert.ok(m, "定型文（.gitignore）がある");
  assert.match(m[1], /コミットしてください/);
  assert.match(m[1], /targetDirty/);
  assert.match(m[1], /\.git\/info\/exclude/);
});

test("setup.md: 決まりの適用範囲は /setup の実行中だけ。setup の外では持ち出さない", () => {
  const rules = text.slice(text.indexOf("## 進め方の決まり"), text.indexOf("## 手順"));
  assert.match(rules, /適用範囲: 以下の決まり[^。]*`\/touryou:setup` を実行している間だけ/);
  assert.match(rules, /setup の外の会話[^。]*案内しない/);
});

test("setup.md: 版上げの同意の問いに supervisor（ログイン項目 TouRyou の 1 項目）の言葉がある", () => {
  const m = text.match(/定型文: 「(常駐している daemon を、いったん止めて[^」]*)」/);
  assert.ok(m, "版上げの同意の問いがある");
  assert.match(m[1], /ログイン項目の \*\*TouRyou\*\*（supervisor の 1 項目）/);
});

test("setup.md: 前の置き場からの移行は touryou migrate の 1 コマンド。同意のあとだけ。元は消さない（#301）", () => {
  const s = step(2);
  assert.match(s, /`CONFIG: absent` で `LEGACY_CONFIG: present`/);
  assert.match(s, /\*\*元は消さない\*\*/);
  assert.match(s, /手順 3 は要らない/);
  const mig = s.slice(s.indexOf("**移行（"));
  assert.ok(
    mig.indexOf("**同意**") < mig.indexOf('touryou" migrate --yes'),
    "migrate の前に同意を取る",
  );
  assert.match(mig, /\*\*はっきり「はい」のときだけ\*\*進む/);
  assert.match(mig, /`"\$HOME\/\.touryou\/current\/bin\/touryou" migrate --yes`/);
  // 設定の置き場は、リポジトリの .touryou/（前の置き場には、新しく書かない）。worktreeRoot の推奨
  assert.match(s, /推奨は `<repoRoot>\/\.touryou\/worktrees`/);
  assert.match(s, /`\.touryou\/` は、`<repoRoot>\/\.gitignore` に入れる/);
  assert.doesNotMatch(CONFIG_CMD(), /\$HOME\/\.touryou\/config\.json/);
  // install-runtime.sh が LEGACY_CONFIG を出す
  const sh = readFileSync(join(root, "plugin", "scripts", "install-runtime.sh"), "utf8");
  assert.match(sh, /echo "LEGACY_CONFIG: present"/);
  assert.match(sh, /echo "LEGACY_CONFIG: absent"/);
});
