// scripts/ui-preview.mjs を --no-open で起動し、画面の資産・束・状態の口が返ること、止めると一時の場所が消えることを確かめる。
// 前提: pnpm build 済み（check.sh の中で build のあとに流れる）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "ui-preview.mjs");
const previews = (dir) => readdirSync(dir).filter((n) => n.startsWith("touryou-ui-preview-"));

test("ui-preview: --no-open で立ち、止めると一時の stateDir を消す", async () => {
  const tmp = tmpdir();
  const before = new Set(previews(tmp));
  const child = spawn(process.execPath, [SCRIPT, "--no-open", "--live"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TOURYOU_PREVIEW_LIVE_MS: "100" },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`起動しない: ${out}`)), 20000);
    child.stdout.on("data", () => {
      const m = /port (\d+)/.exec(out);
      if (m && out.includes("--no-open")) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
  });
  try {
    assert.doesNotMatch(out, /ticket=/);
    const created = previews(tmp).filter((n) => !before.has(n));
    assert.equal(created.length, 1);
    const base = `http://127.0.0.1:${port}`;
    const ui = await fetch(`${base}/ui`);
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /<html/i);
    const g = await fetch(`${base}/ui/graph.js`);
    assert.equal(g.status, 200);
    assert.match(await g.text(), /touryouGraph/);
    // 状態の口は返る（トークンなしなので 401。トークンは外に出さない）
    const s = await fetch(`${base}/v1/ui/state`);
    assert.equal(s.status, 401);
    await s.text();
    const code = await new Promise((resolve) => {
      child.on("exit", resolve);
      child.kill("SIGINT");
    });
    assert.equal(code, 0);
    assert.equal(existsSync(join(tmp, created[0])), false);
  } finally {
    child.kill("SIGKILL");
  }
});

test("ui-preview: 画面の操作は、平易な文で断る（内部の言葉「未実装」を出さない）", async () => {
  const token = "preview-test-token-preview-test-token-0001";
  const child = spawn(process.execPath, [SCRIPT, "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TOURYOU_PREVIEW_TOKEN: token },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`起動しない: ${out}`)), 20000);
    child.stdout.on("data", () => {
      const m = /port (\d+)/.exec(out);
      if (m && out.includes("--no-open")) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
  });
  try {
    assert.doesNotMatch(out, new RegExp(token));
    const ask = async (operation, params) => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/request`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ requestId: `req-${operation}`, operation, params }),
      });
      return r.json();
    };
    for (const [op, params] of [
      ["decision.answer", { decisionId: "d-open", choice: "いちばん古いタブ" }],
      ["scope.decide", { extensionId: "x-open", decision: "reject" }],
      ["node.review", { nodeId: "g1", verdict: "accept" }],
    ]) {
      const body = await ask(op, params);
      assert.equal(body.ok, false, op);
      assert.match(body.error.cause, /ui-preview は見るための道具なので、操作は試せません/, op);
      assert.doesNotMatch(JSON.stringify(body), /未実装|notImplemented/, op);
    }
  } finally {
    child.kill("SIGKILL");
  }
});

test("ui-preview: 知らない引数は断る", async () => {
  const child = spawn(process.execPath, [SCRIPT, "--token=x"], { stdio: "ignore" });
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 2);
});
