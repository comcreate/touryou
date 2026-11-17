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

test("ui-preview: 知らない引数は断る", async () => {
  const child = spawn(process.execPath, [SCRIPT, "--token=x"], { stdio: "ignore" });
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 2);
});
