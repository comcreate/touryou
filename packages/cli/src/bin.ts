#!/usr/bin/env node
/**
 * `touryou`（人間用コマンドの実行ファイル）。窓口と認証は、環境変数だけで受ける（引数に置かない。`ps` に出さない）。
 *
 * - `TOURYOU_DAEMON_URL`: daemon の窓口（ループバックだけ）。なければ、daemon の設定の stateDir の port から作る（#115）。
 * - `TOURYOU_HUMAN_TOKEN`: 人間のトークン（`<stateDir>/human-token` の中身）。なければ、そのファイルを自分で読む（#115）。`--token` のような引数はない。
 * - `TOURYOU_DAEMON_CONFIG`: daemon の設定ファイル。`stateDir` の `daemon-identity` で、トークンつきの要求の直前に毎回、daemon の身元を
 *   確かめる（touryou-mcp と同じ）。ないと動かない。環境変数 `TOURYOU_CLI_ALLOW_UNVERIFIED` が**ちょうど `1`** のときだけ、検証なしで動く
 *   （開発用。手元の開発のビルドだけで効き、配布物では効かない。`dev-build.ts`）。
 *
 * 終了コードは `runCommand` と同じ（0 成功・1 失敗／結果が確認できない・2 引数・環境の誤り）。
 *
 * `touryou child bind`・`touryou child report`（Desktop の子が使う）は、人間のトークン・環境変数を使わない（子の引き出しの
 * ファイルと、引数の窓口の URL だけ。`child.ts`）。終了コード 3 は、子のトークンの期限切れ。
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVersion, versionLine } from "@touryou/core";
import { readSecureFile } from "@touryou/core/fs";
import { createIdentityVerifier, createRelay, IDENTITY_FILE } from "@touryou/mcp/relay";
import { runChild } from "./child.js";
import { type CommandResult, runCommand } from "./commands.js";
import { DEV_BUILD } from "./dev-build.js";
import { runHook } from "./hook.js";
import { createHttpClient } from "./http-client.js";
import { runLaunchd } from "./launchd.js";
import {
  type LaunchdServiceDeps,
  runLaunchdService,
  SERVICE_SUBCOMMANDS,
} from "./launchd-service.js";
import { runUi, type UiDeps } from "./ui.js";

export interface BinDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 開発のビルドか（試験用。既定は `DEV_BUILD`）。`false` なら `TOURYOU_CLI_ALLOW_UNVERIFIED` は効かない。 */
  readonly devBuild?: boolean;
  readonly isTTY: { readonly stdin: boolean; readonly stdout: boolean };
  readonly fetch?: typeof fetch;
  readonly readFile?: (path: string) => string;
  /** 秘密のファイル（stateDir の port・human-token）の読み取り（試験用）。既定は、自分だけが読める・リンクでないファイルだけ。 */
  readonly readSecret?: (path: string) => string;
  readonly newRequestId?: () => string;
  /** 標準入力の全部（`touryou child hook` のフック入力）。 */
  readonly readStdin?: () => Promise<string>;
  /** `touryou hook` のフック入力。読み取りの上限で切れたら、`truncated: true`（途中までの `text`）。 */
  readonly readHookStdin?: () => Promise<{ readonly text: string; readonly truncated: boolean }>;
  /** `touryou ui` の差し替え（試験用）。 */
  readonly ui?: Partial<Pick<UiDeps, "readFile" | "verifierFor" | "openUrl">>;
  /** 待ち（daemon の再起動の待ちなど。試験で差し替える）。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** `touryou launchd apply|status|…` の外部コマンド・窓口の確認（試験で差し替える）。 */
  readonly launchd?: Partial<
    Pick<LaunchdServiceDeps, "run" | "uid" | "probe" | "waitMs" | "now" | "checkConfig">
  >;
}

/** 設定の検査（`touryou-daemon --check-config`）を、子プロセスで実行する（窓口・state には触れない）。 */
const checkConfigBySpawn = (
  cmd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => {
  // 環境は、渡したものだけ（呼んだ側の PATH・GIT_DIR などを受け継がない）
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000, env: { ...env } });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.error === undefined ? (r.stderr ?? "") : `起動できない（${r.error.message}）`,
  };
};

const usage = (cause: string): CommandResult => ({
  exitCode: 2,
  stdout: "",
  stderr: `${cause}\n窓口と認証は、daemon の設定（$HOME/.touryou/config.json の stateDir。TOURYOU_DAEMON_CONFIG で別の場所も指せる）から自分で読む（touryou ui と同じ）。daemon を起動していれば、何も渡さなくてよい。\n環境変数で渡すこともできる（あれば、こちらを先に使う）: TOURYOU_DAEMON_URL（daemon の窓口）・TOURYOU_HUMAN_TOKEN（人間のトークン）・TOURYOU_DAEMON_CONFIG（daemon の設定ファイル。身元の確認に使う）\n例: export TOURYOU_HUMAN_TOKEN="$(cat <stateDir>/human-token)"（トークンを、コマンドの行に直接書かない）\n`,
});

/** daemon の設定の `stateDir`（絶対パス）。読めない・形が違えば undefined。 */
function stateDirOf(path: string, readFile: (p: string) => string): string | undefined {
  try {
    const json = JSON.parse(readFile(path)) as unknown;
    const dir =
      typeof json === "object" && json !== null
        ? (json as Record<string, unknown>).stateDir
        : undefined;
    return typeof dir === "string" && isAbsolute(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

const nonEmpty = (v: string | undefined): string | undefined =>
  v === undefined || v === "" ? undefined : v;

/**
 * daemon の設定（`TOURYOU_DAEMON_CONFIG`、なければ `$HOME/.touryou/config.json`）の stateDir から、窓口（port）と
 * 人間のトークン（human-token）を読む（#115。`touryou ui` と同じ置き場）。読めないものは undefined のまま返す。
 */
function localDaemonOf(
  deps: Pick<BinDeps, "env" | "readFile" | "readSecret">,
): { configPath: string; daemonUrl?: string; token?: string } | undefined {
  const home = nonEmpty(deps.env.HOME);
  const configPath =
    nonEmpty(deps.env.TOURYOU_DAEMON_CONFIG) ??
    (home === undefined ? undefined : `${home.replace(/\/+$/, "")}/.touryou/config.json`);
  if (configPath === undefined) return undefined;
  const stateDir = stateDirOf(
    configPath,
    deps.readFile ?? ((p) => readSecureFile(p, { forbid: 0o022, maxBytes: 1024 * 1024 })),
  );
  if (stateDir === undefined) return undefined;
  const secret =
    deps.readSecret ?? ((p: string) => readSecureFile(p, { forbid: 0o077, maxBytes: 64 * 1024 }));
  const read = (name: string): string | undefined => {
    try {
      return secret(join(stateDir, name)).trim();
    } catch {
      return undefined;
    }
  };
  const port = read("port");
  const token = read("human-token");
  const okPort =
    port !== undefined && /^[0-9]{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  return {
    configPath,
    ...(okPort ? { daemonUrl: `http://127.0.0.1:${Number(port)}` } : {}),
    ...(token !== undefined && token.length >= 32 ? { token } : {}),
  };
}

/** 隣の package.json の版（開発のビルドの既定）。読めなければ 0.0.0。 */
function cliPackageVersion(readFile?: (p: string) => string): string {
  try {
    if (readFile !== undefined) {
      const v = (
        JSON.parse(readFile(fileURLToPath(new URL("../package.json", import.meta.url)))) as {
          version?: unknown;
        }
      ).version;
      return typeof v === "string" ? v : "0.0.0";
    }
    const v = (createRequire(import.meta.url)("../package.json") as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function runBin(argv: readonly string[], deps: BinDeps): Promise<CommandResult> {
  if (argv[0] === "--version" || argv[0] === "-v") {
    // 配布物の版（窓口・トークンは使わない）。daemon・mcp・cli の食い違いの切り分け。
    const info = resolveVersion({
      packageVersion: cliPackageVersion(deps.readFile),
      env: deps.env,
    });
    return { exitCode: 0, stdout: `${versionLine(info)}\n`, stderr: "" };
  }
  if (argv[0] === "hook") {
    // Claude Code のフック。環境変数 TOURYOU_DAEMON_URL・TOURYOU_NODE_TOKEN と、標準入力だけを使う（人間のトークンは使わない）
    let input: { text: string; truncated: boolean };
    try {
      input = deps.readHookStdin
        ? { ...(await deps.readHookStdin()) }
        : { text: (await deps.readStdin?.()) ?? "", truncated: false };
    } catch {
      input = { text: "", truncated: false }; // 読めなかった入力は、JSON でない入力と同じ（PreToolUse は拒否）
    }
    const r = await runHook({
      env: deps.env,
      input: input.text,
      truncated: input.truncated,
      ...(deps.fetch === undefined ? {} : { fetchImpl: deps.fetch }),
    });
    return redact(
      {
        exitCode: r.code,
        stdout: r.stdout === undefined ? "" : `${r.stdout}\n`,
        stderr: r.stderr === "" ? "" : `${r.stderr}\n`,
      },
      deps.env.TOURYOU_NODE_TOKEN ?? "",
    );
  }
  if (argv[0] === "launchd" && (SERVICE_SUBCOMMANDS as readonly string[]).includes(argv[1] ?? "")) {
    // 常駐の操作。launchctl を実行する。apply・uninstall は --yes が必須
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const doFetch = deps.fetch ?? fetch;
    return runLaunchdService(argv.slice(1), {
      env: deps.env,
      checkConfig: deps.launchd?.checkConfig ?? checkConfigBySpawn,
      sleep,
      run:
        deps.launchd?.run ??
        ((cmd, args) => {
          const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
          return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
        }),
      uid: deps.launchd?.uid ?? (() => process.getuid?.() ?? -1),
      probe:
        deps.launchd?.probe ??
        (async (port) => {
          try {
            const res = await doFetch(`http://127.0.0.1:${port}/v1/whoami`, {
              signal: AbortSignal.timeout(2000),
            });
            await res.body?.cancel();
            return res.status;
          } catch {
            return undefined;
          }
        }),
      ...(deps.launchd?.waitMs === undefined ? {} : { waitMs: deps.launchd.waitMs }),
      ...(deps.launchd?.now === undefined ? {} : { now: deps.launchd.now }),
    });
  }
  if (argv[0] === "launchd") {
    // 起動スクリプト・plist の生成。daemon の窓口・トークンは使わない。launchctl は実行しない
    return runLaunchd(argv.slice(1), {
      env: deps.env,
      checkConfig: deps.launchd?.checkConfig ?? checkConfigBySpawn,
    });
  }
  if (argv[0] === "ui" && !argv.includes("--help") && !argv.includes("-h")) {
    // 状態画面を開く。human-token を自分で読み、チケットにして開く（環境変数の TOURYOU_HUMAN_TOKEN は使わない）
    return runUi(argv.slice(1), {
      env: deps.env,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.ui?.readFile === undefined ? {} : { readFile: deps.ui.readFile }),
      ...(deps.ui?.verifierFor === undefined ? {} : { verifierFor: deps.ui.verifierFor }),
      openUrl:
        deps.ui?.openUrl ??
        ((url) => {
          if (process.platform !== "darwin") return false;
          // 引数に出るのは、使い捨てのチケットだけ。標準出力・標準エラーは捨てる（URL を出さない）
          const r = spawnSync("/usr/bin/open", [url], { stdio: "ignore", timeout: 15_000 });
          return r.error === undefined && r.status === 0;
        }),
    });
  }
  if (argv[0] === "child") {
    return runChild(argv.slice(1), {
      ...(deps.readStdin === undefined ? {} : { readStdin: deps.readStdin }),
      newRequestId: deps.newRequestId ?? (() => `touryou-child-${randomUUID()}`),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return runCommand(argv, {
      client: { call: async () => Promise.reject(new Error("unused")) },
      newRequestId: () => "help",
      isTTY: deps.isTTY,
    });
  }
  // 窓口・人間のトークン・設定の場所は、環境変数があればそれを使い、なければ daemon の設定から自分で読む（#115。touryou ui と同じ）。
  // トークンは、メモリの中だけで使い、引数・標準出力・標準エラーに出さない（出力は redact で伏せる）
  const local = localDaemonOf(deps);
  const daemonUrl = nonEmpty(deps.env.TOURYOU_DAEMON_URL) ?? local?.daemonUrl;
  const token = nonEmpty(deps.env.TOURYOU_HUMAN_TOKEN) ?? local?.token;
  if (daemonUrl === undefined)
    return usage(
      "TOURYOU_DAEMON_URL がなく、daemon の設定からも窓口（stateDir の port）を読めない",
    );
  if (token === undefined)
    return usage(
      "TOURYOU_HUMAN_TOKEN がなく、daemon の設定からも人間のトークン（stateDir の human-token）を読めない",
    );
  const configPath = nonEmpty(deps.env.TOURYOU_DAEMON_CONFIG) ?? local?.configPath;
  let verifier: ReturnType<typeof createIdentityVerifier> | undefined;
  if (configPath !== undefined && configPath !== "") {
    // 既定は、他の人が書けない・リンクでない・自分の・ACL のないファイルだけを読む（daemon の loadConfigFile と同じ確かめ）
    const stateDir = stateDirOf(
      configPath,
      deps.readFile ?? ((p) => readSecureFile(p, { forbid: 0o022, maxBytes: 1024 * 1024 })),
    );
    if (stateDir === undefined) {
      return usage("TOURYOU_DAEMON_CONFIG の設定ファイルを読めない（stateDir が絶対パスでない）");
    }
    verifier = createIdentityVerifier({
      daemonUrl,
      identityPath: join(stateDir, IDENTITY_FILE),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      log: (e) => process.stderr.write(`${JSON.stringify(e)}\n`),
    });
  } else if (!(deps.devBuild ?? DEV_BUILD) || deps.env.TOURYOU_CLI_ALLOW_UNVERIFIED !== "1") {
    return usage(
      "TOURYOU_DAEMON_CONFIG がない（daemon の身元を確認できないので、動かない）。（TOURYOU_CLI_ALLOW_UNVERIFIED=1 は開発のビルドの試験用で、配布物では効かない）",
    );
  }
  const relay = createRelay({
    daemonUrl,
    token,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(verifier === undefined ? {} : { verifier }),
  });
  if (!relay.ok) return redact(usage(`${relay.error.code}: ${relay.error.cause}`), token);
  const result = await runCommand(argv, {
    client: createHttpClient(relay.value),
    newRequestId: deps.newRequestId ?? (() => `touryou-${randomUUID()}`),
    isTTY: deps.isTTY,
  });
  return redact(result, token);
}

/**
 * 出力・エラーの中の、人間のトークンの値を `***` に置き換える（出す直前。daemon・偽の窓口が、応答にトークンを入れても出さない）。
 * トークンが空のときは、置き換えない。
 */
export function redact(result: CommandResult, token: string): CommandResult {
  if (token === "") return result;
  const hide = (s: string): string => s.split(token).join("***");
  return { ...result, stdout: hide(result.stdout), stderr: hide(result.stderr) };
}

// 直接実行されたときだけ動く（試験では runBin を呼ぶ）。
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  // `touryou hook`・`touryou child hook` が例外で落ちたら、終了コード 2（Claude Code は 2 のときだけ拒否する）
  const isHook = process.argv[2] === "hook";
  const isChildHook = process.argv[2] === "child" && process.argv[3] === "hook";
  const guard = isHook || isChildHook;
  /** 標準入力を、上限（2MiB）まで読む。超えたら、そこで切り、`truncated` を立てる。 */
  const readLimited = async (): Promise<{ text: string; truncated: boolean }> => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    for await (const c of process.stdin) {
      size += (c as Buffer).length;
      if (size > 2 * 1024 * 1024) {
        truncated = true;
        break;
      }
      chunks.push(c as Buffer);
    }
    return { text: Buffer.concat(chunks).toString("utf8"), truncated };
  };
  const result = await runBin(process.argv.slice(2), {
    env: process.env,
    isTTY: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
    // `touryou hook`・`touryou child hook` だけが読む（フック入力）。ほかのコマンドでは読まない（端末で待たない）
    ...(isChildHook ? { readStdin: async () => (await readLimited()).text } : {}),
    ...(isHook ? { readHookStdin: readLimited } : {}),
  }).catch(
    (): CommandResult => ({
      exitCode: guard ? 2 : 1,
      stdout: "",
      stderr: guard
        ? `[touryou ${isHook ? "hook" : "child hook"}] 拒否: 予期しない失敗（人に知らせる）\n`
        : "予期しない失敗\n",
    }),
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
