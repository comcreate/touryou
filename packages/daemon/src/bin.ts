#!/usr/bin/env node
/**
 * `touryou-daemon` の入口。git の口を読み込んで `main` を呼び、終了の信号で止める。
 *
 * - 終了の信号（SIGINT・SIGTERM）で止める。止まらなければ 10 秒で諦めて、終了コード 1。
 * - 捕捉されない例外・拒否された Promise は、標準エラーに記録して、終了コード 1 で終わる。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveVersion, versionLine } from "@touryou/core";
import { loadWorktreePorts } from "./loaders.js";
import { main } from "./main.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

// `touryou-daemon --version`（配布物の版。daemon・mcp・cli の食い違いの切り分け）。窓口・トークンは使わない。
if (process.argv[2] === "--version" || process.argv[2] === "-v") {
  const pkgVersion = (() => {
    try {
      const v = (createRequire(import.meta.url)("../package.json") as { version?: unknown })
        .version;
      return typeof v === "string" ? v : "0.0.0";
    } catch {
      return "0.0.0";
    }
  })();
  // tar.gz の配布物の版の印（lib/dist-version。launchd が同梱の node で直に起こすときは、起動スクリプトの環境変数がない。#64）
  const distVersion = (() => {
    try {
      return readFileSync(new URL("../dist-version", import.meta.url), "utf8");
    } catch {
      return undefined;
    }
  })();
  process.stdout.write(
    `${versionLine(resolveVersion({ packageVersion: pkgVersion, env: process.env, ...(distVersion === undefined ? {} : { distVersion }) }))}\n`,
  );
  process.exit(0);
}

const fatal = (what: string, e: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), event: what, error: String(e instanceof Error ? (e.stack ?? e.message) : e) })}\n`,
  );
  process.exit(1);
};
process.on("uncaughtException", (e) => fatal("uncaughtException", e));
process.on("unhandledRejection", (e) => fatal("unhandledRejection", e));

let fatalStop: (() => void) | undefined;
const result = await main(process.argv.slice(2), {
  // 最終削除の後に、追記のみの保証を確かめられなかったら、daemon を止めて、終了コード 1 で終わる（fail closed）。
  onFatal: (cause) => {
    process.stderr.write(`失敗 [storeIntegrity]: ${cause}\n`);
    process.exitCode = 1;
    fatalStop?.();
  },
  loadWorktreePorts,
  // git の口と同じく、使うときに読み込む
  checkRepo: async (repoRoot) => (await import("./git-ports.js")).checkGitRepo(repoRoot),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
if (result.daemon === undefined) {
  process.exitCode = result.exitCode;
} else {
  const daemon = result.daemon;
  let stopping = false;
  const shutdown = (exitCode = 0): void => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => {
      process.stderr.write("失敗 [shutdownTimeout]: 10 秒以内に止まらなかった\n");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    daemon.stop().then(
      () => process.exit(exitCode),
      (e: unknown) => fatal("shutdownFailed", e),
    );
  };
  fatalStop = () => shutdown(1);
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
}
