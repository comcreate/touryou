// plugin/.mcp.json の起動（scripts/mcp-stdio-command.mjs）と、落ちない中継（plugin/scripts/touryou-mcp-shim.sh）を、実際に走らせて確かめる。
// `node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { execSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MCP_STDIO_ARGS, MCP_STDIO_COMMAND } from "./mcp-stdio-command.mjs";

const SHIM = new URL("../plugin/scripts/touryou-mcp-shim.sh", import.meta.url).pathname;
const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "touryou-shim-"));
  made.push(h);
  return h;
};
const bin = (h) => join(h, ".touryou", "current", "bin");

/** 偽の touryou-mcp（JSON-RPC の最低限を、手で話す。initialize・tools/list・tools/call）。 */
const FAKE = `
if (require("node:fs").existsSync(process.env.HOME + "/down")) {
  process.stderr.write("[touryou mcp] 失敗 [daemon_unreachable]: 接続できない /Users/secret/.touryou/root-token tok_SECRET123\\n  次の操作: daemon を起動する\\n");
  process.exit(1);
}
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue;
    const m = JSON.parse(l);
    if (m.id === undefined) continue;
    const out = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    if (m.method === "initialize") out({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    else if (m.method === "tools/list") out({ tools: [{ name: "whoami", inputSchema: { type: "object" } }] });
    else if (m.method === "tools/call") out({ content: [{ type: "text", text: "real:" + m.params.name }] });
    else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "x" } }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;
function placeFake(h) {
  const b = bin(h);
  mkdirSync(b, { recursive: true });
  writeFileSync(join(h, "fake.cjs"), FAKE);
  writeFileSync(
    join(b, "touryou-mcp"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(h, "fake.cjs")}" "$@"\n`,
  );
  chmodSync(join(b, "touryou-mcp"), 0o755);
}

/** 中継を起動し、1 行ずつの JSON を読む。 */
function start(h) {
  const p = spawn("/bin/bash", [SHIM], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const msgs = [];
  p.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l.trim()) msgs.push(JSON.parse(l));
    }
  });
  const send = (o) => p.stdin.write(`${JSON.stringify(o)}\n`);
  const wait = (pred, ms = 10_000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      const h2 = setInterval(() => {
        const m = msgs.find(pred);
        if (m) {
          clearInterval(h2);
          res(m);
        } else if (Date.now() - t0 > ms) {
          clearInterval(h2);
          rej(new Error(`時間切れ: ${JSON.stringify(msgs)}`));
        }
      }, 50);
    });
  const exit = new Promise((r) => p.on("exit", (code) => r(code)));
  return { p, send, wait, msgs, exit };
}
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
};

test(".mcp.json の起動は /bin/bash と plugin の中の中継。中継のファイルがあり、${…} は CLAUDE_PLUGIN_ROOT だけ", () => {
  assert.equal(MCP_STDIO_COMMAND, "/bin/bash");
  assert.deepEqual(MCP_STDIO_ARGS, ["${CLAUDE_PLUGIN_ROOT}/scripts/touryou-mcp-shim.sh"]);
  assert.ok(existsSync(SHIM));
  assert.equal(spawnSync("/bin/bash", ["-n", SHIM]).status, 0, "bash の構文");
  const code = readFileSync(SHIM, "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.doesNotMatch(code, /\bawk\b|\bnode\b|\bpython/, "awk・node・python を使わない");
  for (const m of code.matchAll(/\bsed\b[^|;]*/g)) {
    assert.match(m[0], /^sed -n -E /, `sed は -E（BSD sed の基本の正規表現に頼らない）: ${m[0]}`);
  }
});

test("HOME が空なら、標準出力に何も出さず、標準エラーに理由を出して終了コード 1", () => {
  const r = spawnSync("/bin/bash", [SHIM], {
    env: { PATH: process.env.PATH, HOME: "" },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /HOME が空/);
});

test("配布物があれば、そのまま touryou-mcp --stdio を exec する", () => {
  const h = home();
  mkdirSync(bin(h), { recursive: true });
  writeFileSync(join(bin(h), "touryou-mcp"), '#!/bin/sh\nprintf "args:%s\\n" "$*"\n');
  chmodSync(join(bin(h), "touryou-mcp"), 0o755);
  const r = spawnSync("/bin/bash", [SHIM], {
    env: { PATH: process.env.PATH, HOME: h },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "args:--stdio\n");
});

test("配布物がまだないとき: initialize（listChanged）・ping・tools/list（空）に応え、ほかは JSON-RPC の error。id は数字も文字列も返す", async () => {
  const s = start(home());
  s.send(INIT);
  const init = await s.wait((m) => m.id === 1);
  assert.equal(init.result.capabilities.tools.listChanged, true);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  s.send({ jsonrpc: "2.0", id: "a-2", method: "tools/list" });
  assert.deepEqual((await s.wait((m) => m.id === "a-2")).result.tools, []);
  for (const [id, method] of [
    [3, "resources/list"],
    ["a-4", "prompts/list"],
    [5, "x/unknown"],
    [-6, "tools/call"],
  ]) {
    s.send({ jsonrpc: "2.0", id, method, params: {} });
    assert.equal((await s.wait((m) => m.id === id)).error.code, -32601, method);
  }
  s.send({ jsonrpc: "2.0", id: 7, method: "ping" });
  assert.deepEqual((await s.wait((m) => m.id === 7)).result, {});
  s.p.stdin.end();
  assert.equal(await s.exit, 0, "配布物が現れないまま標準入力が閉じたら、終わる");
});

test("配布物が置かれたら、list_changed を出して本物に引き継ぐ（引き継ぎの initialize の応答は出さない）。標準入力が閉じたら、本物も終わる", async () => {
  const h = home();
  const s = start(h);
  s.send(INIT);
  await s.wait((m) => m.id === 1);
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  placeFake(h);
  await s.wait((m) => m.method === "notifications/tools/list_changed");
  s.send({ jsonrpc: "2.0", id: 8, method: "tools/list" });
  const tl = await s.wait((m) => m.id === 8);
  assert.equal(tl.result.tools[0].name, "whoami");
  s.send({
    jsonrpc: "2.0",
    id: "c-9",
    method: "tools/call",
    params: { name: "whoami", arguments: {} },
  });
  assert.equal((await s.wait((m) => m.id === "c-9")).result.content[0].text, "real:whoami");
  assert.ok(!s.msgs.some((m) => m.id === "__touryou_resume__"));
  s.p.stdin.end();
  assert.equal(await s.exit, 0);
  await new Promise((r) => setTimeout(r, 300));
  const left = execSync(`ps -eo command | grep -c "[f]ake.cjs" || true`).toString().trim();
  assert.equal(left, "0", "本物のプロセスが残らない");
});

test("配布物があっても daemon が動いていない（試しの起動が 1 で終わる）あいだは、引き継がない。動いたら引き継ぐ", async () => {
  const h = home();
  writeFileSync(join(h, "down"), "");
  placeFake(h);
  rmSync(join(bin(h), "touryou-mcp"));
  const s = start(h);
  s.send(INIT);
  await s.wait((m) => m.id === 1);
  placeFake(h);
  await new Promise((r) => setTimeout(r, 3000));
  assert.ok(!s.msgs.some((m) => m.method === "notifications/tools/list_changed"));
  s.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "whoami" } });
  assert.equal((await s.wait((m) => m.id === 5)).error.code, -32601);
  rmSync(join(h, "down"));
  await s.wait((m) => m.method === "notifications/tools/list_changed", 15_000);
  s.p.stdin.end();
  assert.equal(await s.exit, 0);
});

test("試しの起動が失敗したら、失敗の種類を標準エラーと initialize の instructions に出す。トークン・パスの値は出さない", async () => {
  const h = home();
  writeFileSync(join(h, "down"), "");
  placeFake(h);
  const s = start(h);
  let err = "";
  s.p.stderr.on("data", (d) => {
    err += d;
  });
  s.send(INIT);
  const init = await s.wait((m) => m.id === 1);
  assert.match(init.result.instructions, /daemon_unreachable/);
  assert.match(err, /理由: daemon_unreachable/);
  for (const out of [err, JSON.stringify(s.msgs)]) {
    assert.doesNotMatch(out, /SECRET|\/Users\/secret|root-token/, "個人の値を出さない");
  }
  s.p.stdin.end();
  assert.equal(await s.exit, 0);
});

test("会話の始まりに配布物があり daemon が動いていない: すぐ exec せず、道具 0 個で待ち、daemon が動いたら list_changed で引き継ぐ", async () => {
  const h = home();
  writeFileSync(join(h, "down"), "");
  placeFake(h);
  const s = start(h);
  s.send(INIT);
  const init = await s.wait((m) => m.id === 1);
  assert.equal(init.result.serverInfo.name, "touryou-mcp-shim");
  s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual((await s.wait((m) => m.id === 2)).result.tools, []);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(s.p.exitCode, null, "落ちずに待つ");
  rmSync(join(h, "down"));
  await s.wait((m) => m.method === "notifications/tools/list_changed", 15_000);
  s.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal((await s.wait((m) => m.id === 3)).result.tools[0].name, "whoami");
  s.p.stdin.end();
  assert.equal(await s.exit, 0);
});
