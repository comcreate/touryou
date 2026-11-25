/**
 * cli が `config.json` を読む所（`touryou launchd` の stateDirOf・`touryou` の TOURYOU_DAEMON_CONFIG）の確かめ。
 * daemon の loadConfigFile と同じく、リンクでない・自分の・他の人が書けない・ACL のないファイルだけを読む。
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "../src/bin.js";
import { stateDirOf } from "../src/launchd.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const config = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "touryou-cli-cfg-")));
  made.push(d);
  const p = join(d, "config.json");
  writeFileSync(p, JSON.stringify({ stateDir: join(d, "state") }), { mode: 0o600 });
  return { d, p };
};

describe("config.json の確かめ", () => {
  it("launchd: 0600 の自分のファイルは読む。他の人が書ける・リンクは読まない", () => {
    const a = config();
    expect(stateDirOf(a.p)).toBe(join(a.d, "state"));
    chmodSync(a.p, 0o666);
    expect(stateDirOf(a.p)).toBeUndefined();
    const b = config();
    const link = join(b.d, "link.json");
    symlinkSync(b.p, link);
    expect(stateDirOf(link)).toBeUndefined();
  });

  it("touryou（TOURYOU_DAEMON_CONFIG）: 他の人が書ける・リンクの設定なら、トークンを送らずに使い方の誤り", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const a = config();
    chmodSync(a.p, 0o666);
    const b = config();
    const link = join(b.d, "link.json");
    symlinkSync(b.p, link);
    for (const p of [a.p, link]) {
      const r = await runBin(["hook-unbind", "a"], {
        env: {
          TOURYOU_DAEMON_URL: "http://127.0.0.1:7777",
          TOURYOU_HUMAN_TOKEN: "human-token-human-token-human-token-1234",
          TOURYOU_DAEMON_CONFIG: p,
        },
        isTTY: { stdin: false, stdout: false },
        fetch,
        sleep: async () => {},
      });
      expect(r.exitCode, p).toBe(2);
      expect(r.stderr).toContain(`daemon の設定ファイル（${p}）を読めない`);
    }
    expect(seen).toEqual([]);
  });
});
