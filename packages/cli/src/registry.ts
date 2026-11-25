/**
 * 登録簿（#288 決定 12・15）: `~/.touryou/registry.json` に、daemon の設定ファイル
 * （`<repoRoot>/.touryou/config.json`）の絶対パスの一覧だけを持つ。
 *
 * - 壊れたとき（JSON でない・形が違う・相対パスがある）は、全体を「壊れ」として扱い、何も書き換えず、再登録の手順を返す。
 * - 消えたパスは自動で外さない（実態を正とする。外すのは人が `removeFromRegistry` を呼ぶとき）。`inspectEntries` は、理由つきで「消えた」と返すだけ。
 * - 書くときは一時ファイルに 0600 で書いてから置き換える。壊れた登録簿の上には、書き足さない（黙って上書きしない）。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REGISTRY_FILE = "registry.json";

export const registryPath = (home: string): string => join(home, ".touryou", REGISTRY_FILE);

export type RegistryRead =
  | { readonly kind: "ok"; readonly configs: readonly string[] }
  | { readonly kind: "broken"; readonly reason: string; readonly fix: string };

const brokenFix = (path: string): string =>
  `登録簿（${path}）を直す、または消してから、各リポジトリで /touryou:setup を実行して登録し直す（各リポジトリの状態は無傷）`;

/** 登録簿を読む。ファイルがなければ、空の登録簿（ok）。 */
export function readRegistry(path: string): RegistryRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "ok", configs: [] };
    return {
      kind: "broken",
      reason: `登録簿を読めない（${String(e instanceof Error ? e.message : e)}）`,
      fix: brokenFix(path),
    };
  }
  const broken = (reason: string): RegistryRead => ({
    kind: "broken",
    reason: `登録簿が壊れている（${reason}）`,
    fix: brokenFix(path),
  });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return broken("JSON として読めない");
  }
  const configs = (json as { configs?: unknown } | null)?.configs;
  if (!Array.isArray(configs)) return broken("configs が配列でない");
  for (const c of configs) {
    if (typeof c !== "string" || !c.startsWith("/")) return broken("絶対パスでない項目がある");
  }
  return { kind: "ok", configs: [...new Set(configs as string[])] };
}

function writeRegistry(path: string, configs: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify({ configs }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export type RegistryWrite =
  | { readonly ok: true; readonly configs: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly fix: string };

/** 登録する（すでにあれば何もしない）。登録簿が壊れているときは、書かずに理由と直し方を返す。 */
export function addToRegistry(path: string, config: string): RegistryWrite {
  if (!config.startsWith("/")) {
    return {
      ok: false,
      reason: "設定ファイルは絶対パスで登録する",
      fix: `絶対パスで指定する: ${config}`,
    };
  }
  const cur = readRegistry(path);
  if (cur.kind === "broken") return { ok: false, reason: cur.reason, fix: cur.fix };
  if (cur.configs.includes(config)) return { ok: true, configs: cur.configs };
  const next = [...cur.configs, config];
  writeRegistry(path, next);
  return { ok: true, configs: next };
}

/** 登録だけを外す（人が呼ぶ。設定・state・daemon には触れない）。 */
export function removeFromRegistry(path: string, config: string): RegistryWrite {
  const cur = readRegistry(path);
  if (cur.kind === "broken") return { ok: false, reason: cur.reason, fix: cur.fix };
  if (!cur.configs.includes(config)) return { ok: true, configs: cur.configs };
  const next = cur.configs.filter((c) => c !== config);
  writeRegistry(path, next);
  return { ok: true, configs: next };
}

export type EntryInspection =
  | { readonly config: string; readonly present: true }
  | { readonly config: string; readonly present: false; readonly reason: string };

/** 登録された設定ごとに、実態（ファイルの有無）を調べる。消えたものも、登録簿からは外さない。 */
export function inspectEntries(
  configs: readonly string[],
  exists: (path: string) => boolean = existsSync,
): EntryInspection[] {
  return configs.map((config) =>
    exists(config)
      ? { config, present: true }
      : {
          config,
          present: false,
          reason: `設定ファイルがない（${config}）。起動しない。リポジトリを消したなら /touryou:service で登録だけを外す。動かしたいなら、そこで /touryou:setup を実行し直す`,
        },
  );
}
