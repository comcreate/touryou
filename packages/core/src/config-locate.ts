/**
 * daemon の設定ファイルの探し方（#288 PR 2。mcp・hook・cli・ui・launchd が共有する）。
 *
 * 順: `--config` の引数 → 環境変数 `TOURYOU_DAEMON_CONFIG`（空は無視）→ cwd から上へ `<dir>/.touryou/config.json`。
 * 見つからないときは、旧パス（`$HOME/.touryou/config.json`）へ黙って戻らず、理由と直し方を返す。
 *
 * - 純粋な文字列の処理だけ（ファイルの有無は `exists` で受け取る。core 本体は node: に依存しない）。
 * - 旧パスへ戻るコードは持たない。`$HOME` の下で実行したとき、上へ探す途中で `$HOME/.touryou/config.json` があれば当たるのは、
 *   設計書 4-2 の「cwd から上へ」の素直な帰結（特別扱いはしない）。
 */

export type ConfigSource = "arg" | "env" | "cwd";

export interface LocateConfigInput {
  /** `--config` の値。空文字は無視。 */
  readonly arg?: string | undefined;
  /** 環境変数。`TOURYOU_DAEMON_CONFIG`（空は無視）だけを読む。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 探し始めるディレクトリ（絶対パス）。 */
  readonly cwd?: string | undefined;
  /** 設定ファイルがあるか。 */
  readonly exists: (path: string) => boolean;
}

export type LocateConfigResult =
  | { readonly ok: true; readonly path: string; readonly source: ConfigSource }
  | { readonly ok: false; readonly reason: string; readonly fix: string };

/** 見つからないときの直し方（全入口で同じ文）。 */
export const CONFIG_NOT_FOUND_FIX =
  "/touryou:setup を実行して設定を作る、または --config <daemon の設定ファイルの絶対パス> で指定する（環境変数 TOURYOU_DAEMON_CONFIG でも指せる）";

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** cwd から上へ、`<dir>/.touryou/config.json` がある最初の（いちばん近い）ものを返す。 */
export function findConfigUpward(
  cwd: string,
  exists: (path: string) => boolean,
): string | undefined {
  let dir = trimSlash(cwd);
  for (;;) {
    const candidate = `${dir === "/" ? "" : dir}/.touryou/config.json`;
    if (exists(candidate)) return candidate;
    if (dir === "/") return undefined;
    const i = dir.lastIndexOf("/");
    dir = i <= 0 ? "/" : dir.slice(0, i);
  }
}

export function locateConfig(input: LocateConfigInput): LocateConfigResult {
  if (input.arg !== undefined && input.arg !== "") {
    return { ok: true, path: input.arg, source: "arg" };
  }
  const envConfig = input.env.TOURYOU_DAEMON_CONFIG;
  if (envConfig !== undefined && envConfig !== "") {
    return { ok: true, path: envConfig, source: "env" };
  }
  const cwd = input.cwd;
  if (cwd === undefined || !cwd.startsWith("/")) {
    return {
      ok: false,
      reason: "daemon の設定ファイルを探せない（--config も TOURYOU_DAEMON_CONFIG もなく、実行した場所も分からない）",
      fix: CONFIG_NOT_FOUND_FIX,
    };
  }
  const found = findConfigUpward(cwd, input.exists);
  if (found === undefined) {
    return {
      ok: false,
      reason: `daemon の設定ファイルが見つからない（${cwd} から上へ <dir>/.touryou/config.json を探した。--config も TOURYOU_DAEMON_CONFIG もない）`,
      fix: CONFIG_NOT_FOUND_FIX,
    };
  }
  return { ok: true, path: found, source: "cwd" };
}
