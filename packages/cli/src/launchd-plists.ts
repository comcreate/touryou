/**
 * daemon の plist の、名前の規則・置き場の一覧・読み取り・中身（設定・PATH）の解釈（`docs/launchd.md`）。
 *
 * plist の名前（`[<org>.]touryou.daemon[-<8 文字>].plist`）の規則は、ここだけが持つ。init・apply などの launchd の操作・
 * `touryou ui` は、どれもここを通して、plist を探し・読み・中身を解釈する（同じ規則を、別々に書かない）。
 * 例外は `plugin/scripts/install-runtime.sh`（シェルなので、同じ規則を別に書く。`install-runtime-multi.test.ts` が、この規則と合っていることを確かめる）。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readSecureFile } from "@touryou/core/fs";

/** パスに使える文字（空白は可。シェルの二重引用符・XML で、特別な意味を持つ文字を含まない）。 */
const SAFE_PATH = /^\/[A-Za-z0-9._/@+ -]*$/;
/** 使える文字だけで、`..` の要素・`//` を含まない。 */
export const plainPath = (p: string): boolean =>
  SAFE_PATH.test(p) && !p.includes("//") && !/(^|\/)\.\.(\/|$)/.test(p);

export const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** init が生成する plist のファイル名。`[<org>.]touryou.daemon[-<8 文字>].plist`（8 文字は、別名の設定〔--config〕のときだけ）。 */
const PLIST_NAME = /^((?:[a-z0-9-]+\.)*)touryou\.daemon(?:-([0-9a-f]{8}))?\.plist$/;

/** plist のファイル名を分けたもの。 */
export interface DaemonPlistName {
  /** ファイル名（`touryou.daemon-1234abcd.plist`）。 */
  readonly file: string;
  /** launchd の Label（拡張子を除いた名前）。 */
  readonly label: string;
  /** daemon の名前（`daemon`・`daemon-<8 文字>`）。ログのファイル名に使う。 */
  readonly name: string;
  /** 組織の逆ドメイン（Label が `touryou.…` で始まるときは undefined）。 */
  readonly org: string | undefined;
  /** 別名の設定（`--config`）のときだけ、設定のパスから決まる 8 文字。 */
  readonly suffix: string | undefined;
}

/** plist のファイル名を分ける。daemon の plist の名前でなければ undefined。 */
export const parsePlistName = (file: string): DaemonPlistName | undefined => {
  const m = PLIST_NAME.exec(file);
  if (m === null) return undefined;
  const prefix = m[1] as string;
  const suffix = m[2];
  return {
    file,
    label: file.slice(0, -".plist".length),
    name: suffix === undefined ? "daemon" : `daemon-${suffix}`,
    org: prefix === "" ? undefined : prefix.slice(0, -1),
    suffix,
  };
};

/**
 * plist の置き場にある daemon の plist の名前（ファイル名の順）。`others` なら、別名の設定（`--config`）のものだけ。
 * 置き場がない・読めなければ空。
 */
export const daemonPlistNames = (
  dir: string,
  kind: "all" | "others" = "all",
  readDir: (path: string) => string[] = (p) => readdirSync(p),
): DaemonPlistName[] => {
  try {
    return [...readDir(dir)]
      .sort()
      .flatMap((n) => {
        const p = parsePlistName(n);
        return p === undefined || (kind === "others" && p.suffix === undefined) ? [] : [p];
      });
  } catch {
    return [];
  }
};

/** plist の ProgramArguments の `--config` の値。 */
export const plistConfigOf = (text: string): string | undefined =>
  text.match(/<string>--config<\/string>\s*<string>([^<]*)<\/string>/)?.[1];

/** plist の PATH の値（init の `--path-prefix` の有無で変わる）。形が違えば undefined。 */
export function pathValueOf(text: string): string | undefined {
  const v = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(text)?.[1];
  if (v === undefined) return undefined;
  if (v === DEFAULT_PATH) return v;
  const prefix = v.endsWith(`:${DEFAULT_PATH}`) ? v.slice(0, -(DEFAULT_PATH.length + 1)) : "";
  return prefix !== "" && prefix.split(":").every((d) => d !== "" && plainPath(d)) ? v : undefined;
}

/** PATH の値から、init に渡す `--path-prefix` の引数を作り戻す（既定の PATH なら空）。 */
export const pathPrefixArgs = (pathValue: string): string[] =>
  pathValue === DEFAULT_PATH ? [] : ["--path-prefix", pathValue.slice(0, -(DEFAULT_PATH.length + 1))];

/** 安全な読み取り（他の人が書ける・リンク・持ち主の違うファイルは例外）。`forbid` は禁じる権限のビット。 */
export type PlistReader = (path: string, forbid: number) => string;

const secureRead: PlistReader = (path, forbid) =>
  readSecureFile(path, { forbid, maxBytes: 1024 * 1024 });

/** 読んだ plist。`file` は、実際に読んだパス。 */
export interface PlistFile {
  readonly file: string;
  readonly text: string;
}

/**
 * 置き場（先のものから）の中の、同じ名前の plist を、最初に読めたものから返す。
 * 元の plist（`<home>/.touryou/launchd`）が消えて、LaunchAgents にだけ残るものも読めるように、置き場を順に試す。どれも読めなければ undefined。
 */
export function readDaemonPlist(
  dirs: readonly string[],
  file: string,
  read: PlistReader = secureRead,
): PlistFile | undefined {
  for (const dir of dirs) {
    const path = join(dir, file);
    try {
      return { file: path, text: read(path, 0o022) };
    } catch {
      // 読めない plist は、次の置き場のものを試す（その 1 つのために、全体をやめない）
    }
  }
  return undefined;
}
