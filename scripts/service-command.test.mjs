// plugin/commands/service.md（/touryou:service）の文言を守る。`node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const text = readFileSync(new URL("../plugin/commands/service.md", import.meta.url), "utf8");
const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
assert.ok(front, "frontmatter がない");
const body = text.slice(front[0].length);
const rules = /## 進め方の決まり\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
const item = (name) =>
  new RegExp(`- \\*\\*${name}\\*\\*:([\\s\\S]*?)(?=\\n- \\*\\*|$)`).exec(body)?.[1] ?? "";

test("allowed-tools は Read だけ（Bash などを事前に許可しない）", () => {
  assert.match(front[1], /^allowed-tools: Read$/m);
});

test("launchctl を直接は実行しない。使うのは touryou launchd の決まったサブコマンドだけ", () => {
  assert.match(rules, /`launchctl` を直接は実行しない/);
  assert.doesNotMatch(body, /launchctl (?:bootstrap|bootout|kickstart|load|unload)/);
  for (const sub of ["status", "restart", "stop"]) {
    assert.match(
      item(sub),
      new RegExp(`\`"\\$HOME/\\.touryou/current/bin/touryou" launchd ${sub}\``),
    );
  }
});

test("--yes は、チャットで「はい」と答えたあとだけ。承認ダイアログの許可だけでは付けない", () => {
  assert.match(
    rules,
    /`--yes` は、利用者が定型文の問いにチャットで「はい」と答えたあとにだけ付ける。承認ダイアログの許可だけでは付けない/,
  );
});

test("restart・stop は、はっきり「はい」のときだけ。それ以外は何もしない", () => {
  for (const sub of ["restart", "stop"]) {
    assert.match(item(sub), /はっきり「はい」のときだけ/);
    assert.match(item(sub), /それ以外[^。]*は、何もせずに終わる/);
  }
});

test("uninstall: 問いを先に聞き、1 回だけ実行する。終了コード 1 の「残した」は失敗ではない", () => {
  const u = item("uninstall");
  assert.match(u, /実行の前に、次の定型文で尋ねる/);
  assert.match(u, /はっきり「はい」でなければ、何もせずに終わる/);
  assert.match(u, /\*\*1 回だけ\*\*実行する/);
  assert.doesNotMatch(u, /--remove-token/);
  assert.match(u, /`"\$HOME\/\.touryou\/current\/bin\/touryou" launchd uninstall --yes`/);
  assert.ok(u.indexOf("定型文（外す）") < u.indexOf("launchd uninstall --yes"), "実行の前に問い");
  assert.match(u, /終了コード 1 で、出力に「残した」の行があるときは、失敗ではない/);
  assert.match(rules, /`uninstall` の終了コード 1 の「残した」は、下のとおり失敗ではない/);
});

test("トークンの中身は読まない・出さない", () => {
  assert.match(rules, /`root-token` の中身は、読まない・出さない/);
  assert.doesNotMatch(body, /\bcat\b/);
});

test("status・restart: 読み込まれていないときは restart を案内せず、次のログインか、同意のあとの apply --yes を案内する", () => {
  assert.match(item("status"), /読み込まれていないときは、`restart` を案内しない/);
  assert.match(item("status"), /次のログインでまた動く/);
  assert.match(
    item("status"),
    /定型文（再開）で尋ね、\*\*はっきり「はい」のときだけ\*\* `"\$HOME\/\.touryou\/current\/bin\/touryou" launchd apply --yes`。それ以外は、何もせずに終わる/,
  );
  assert.match(
    item("status"),
    /定型文（再開）: 「止めている daemon を、いま読み込み直して動かします（常駐の設定はそのまま）。/,
  );
  assert.doesNotMatch(item("status"), /手順 3-A の 1 と同じく/);
  assert.match(item("status"), /出力のその行の括弧の中で分ける[^\n]*両方を並べて利用者に尋ねない/);
  assert.match(item("status"), /「（常駐にしていない）」: [^\n]*ここで `apply` を尋ねない/);
  assert.match(
    item("status"),
    /「（stop で止めた後）」: [^\n]*\*\*続けて、その場で\*\*次の定型文（再開）/,
  );
  assert.doesNotMatch(item("status"), /status をもう一度/);
  assert.match(item("restart"), /読み込み済みのときだけ使える/);
});

test("uninstall-all: 「はい」のあと 1 回だけ uninstall --yes。plugin・$HOME/.touryou は会話で消さず、/exit のあとのブロックとして出す", () => {
  const u = item("uninstall-all");
  assert.match(
    u,
    /実行の前に、次の定型文で尋ねる\*\*。はっきり「はい」でなければ、何もせずに終わる/,
  );
  assert.match(
    u,
    /実行するのは\*\*合計で最大 2 回\*\*: まず `"\$HOME\/\.touryou\/current\/bin\/touryou" launchd uninstall --yes`（1 回）/,
  );
  assert.ok(
    u.indexOf("定型文（まとめて外す）") < u.indexOf("launchd uninstall --yes"),
    "実行の前に問い",
  );
  assert.match(u, /\*\*会話の中では実行しない\*\*/);
  assert.match(u, /終了コード 2 は、出力を伝えて止まる（次のブロックは出さない）/);
  const block = /```\n([\s\S]*?)\n {2}```/.exec(u)?.[1] ?? "";
  const lines = block.split("\n").map((l) => l.trim());
  assert.deepEqual(lines, [
    "pgrep -fl '\\.touryou/'",
    "claude plugin uninstall touryou@touryou",
    "claude plugin marketplace remove touryou",
    'rm -rf "$HOME/.touryou"',
  ]);
  assert.ok(!lines.some((l) => l.startsWith("#")), "ブロックに # の行を入れない");
  assert.match(u, /ターミナル（Claude Code を終えたあと/);
  assert.match(
    u,
    /`CLAUDE_CONFIG_DIR`[^\n]*`export CLAUDE_CONFIG_DIR=<[^>]+>`[^\n]*`<…>` は自分の値に置き換える/,
  );
  assert.match(u, /1 行目が何かを出したら[^\n]*そこで止める/);
  assert.match(
    rules,
    /`uninstall-all` の plugin・`\$HOME\/\.touryou` の削除も、会話の中では実行せず/,
  );
  assert.match(front[1], /uninstall-all/);
});
