/**
 * 配布物の版（`touryou --version`・`touryou-daemon --version`・`touryou-mcp --version`、および MCP の serverInfo.version）。
 * daemon・mcp・cli で版の食い違いを切り分けるために使う。
 *
 * 版の決め方（優先順）:
 * 1. `__TOURYOU_VERSION__`（コンパイル時の define）: 拡張機能（`.mcpb`）の esbuild が埋める配布物の版。
 * 2. 環境変数 `TOURYOU_DIST_VERSION`: tar.gz の配布物の起動スクリプト（`scripts/dist-build.sh` が launcher に埋める）。
 * 3. 配布物の版の印（tar.gz の `lib/dist-version`。`scripts/dist-build.sh` が置く）: launchd が起動スクリプトを通さず、
 *    同梱の node で daemon を直に起こすとき（#64）。呼び出し側が読んで `distVersion` に渡す。
 * 4. 隣の `package.json` の version: 開発のビルド（source から動かしているとき）。この場合だけ「開発ビルド」の印を付ける。
 *
 * `__TOURYOU_VERSION__` は、バンドルしない cli・daemon では未宣言のままだが、`typeof` は未宣言の識別子でも例外を投げない。
 */

declare const __TOURYOU_VERSION__: string | undefined;

export interface VersionInfo {
  /** 版の文字列（例: `0.1.0-beta.6`）。 */
  readonly version: string;
  /**
   * 版の出どころ。`embedded`: define（拡張機能）。`env`: `TOURYOU_DIST_VERSION`（tar.gz）。
   * `dist`: 配布物の版の印（tar.gz の `lib/dist-version`）。`package`: 隣の package.json（開発のビルド）。
   */
  readonly source: "embedded" | "env" | "dist" | "package";
}

/**
 * 版を決める。`packageVersion` は、呼び出し側（各 bin）が自分の package.json から読んだ版。
 * I/O を持たない（環境変数は引数で受ける）。
 */
export function resolveVersion(opts: {
  readonly packageVersion: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 配布物の版の印の中身（読めなければ undefined）。前後の空白は除く。 */
  readonly distVersion?: string;
}): VersionInfo {
  if (typeof __TOURYOU_VERSION__ === "string" && __TOURYOU_VERSION__ !== "") {
    return { version: __TOURYOU_VERSION__, source: "embedded" };
  }
  const envVersion = opts.env?.TOURYOU_DIST_VERSION;
  if (typeof envVersion === "string" && envVersion !== "") {
    return { version: envVersion, source: "env" };
  }
  const dist = opts.distVersion?.trim();
  if (dist !== undefined && /^[0-9A-Za-z.+-]{1,64}$/.test(dist)) {
    return { version: dist, source: "dist" };
  }
  return { version: opts.packageVersion, source: "package" };
}

/**
 * `--version` が出す 1 行。開発のビルド（`package`）のときだけ「（開発ビルド）」を付け、
 * 配布物（`embedded`・`env`・`dist`）のときは版だけを出す。
 */
export function versionLine(info: VersionInfo): string {
  return info.source === "package" ? `${info.version}（開発ビルド）` : info.version;
}
