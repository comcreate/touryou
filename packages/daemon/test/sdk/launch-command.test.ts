import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildLaunchCommand as build,
  CHILD_LAUNCH_INSTRUCTION,
  childLaunchSettings,
  INTEGRATOR_LAUNCH_INSTRUCTION,
  isEffort,
  isModelName,
} from "../../src/sdk/launch-command.js";

const PERMS = {
  allow: ["mcp__node__whoami", "Bash(pnpm test:*)", "Edit(./src/**)", "Read(./**)"],
  deny: ["Edit(./.git/**)"],
};
const SETTINGS = childLaunchSettings(PERMS);
const buildLaunchCommand = (i: Omit<Parameters<typeof build>[0], "permissions">): string =>
  build({ ...i, permissions: PERMS });

/** sh で、`claude` の代わりに引数を 1 行ずつ出す関数を置いて、文の語の分かれ方を確かめる（cd と、全体を囲む `)` は試験の都合で外す）。 */
const argsOf = (command: string): string[] => {
  const tail = command.slice(command.indexOf("&& ") + 3, -1);
  const out = execFileSync(
    "sh",
    ["-c", `claude() { for a in "$@"; do printf '%s\\0' "$a"; done; }; ${tail}`],
    {
      encoding: "utf8",
    },
  );
  return out.split("\0").slice(0, -1);
};

describe("起動の依頼の文（設計 6.2）", () => {
  it("形: (cd <作業ツリー> && claude --bg <指示> --name <名前> --model --effort --settings", () => {
    const c = buildLaunchCommand({
      worktree: "/w/trees/a",
      name: "node-1",
      model: "claude-opus-5[1m]",
      effort: "high",
    });
    expect(c.startsWith("(cd /w/trees/a && claude --bg '")).toBe(true);
    expect(c.endsWith(")")).toBe(true);
    expect(argsOf(c)).toEqual([
      "--bg",
      CHILD_LAUNCH_INSTRUCTION,
      "--name",
      "node-1",
      "--model",
      "claude-opus-5[1m]",
      "--effort",
      "high",
      "--permission-mode",
      "dontAsk",
      "--settings",
      SETTINGS,
    ]);
  });

  it("フォークのときは --resume <親の id> --fork-session を足す。モデル・深さは省ける", () => {
    const c = buildLaunchCommand({ worktree: "/w/a", name: "n", forkSessionRef: "sess-1" });
    expect(argsOf(c)).toEqual([
      "--bg",
      CHILD_LAUNCH_INSTRUCTION,
      "--name",
      "n",
      "--permission-mode",
      "dontAsk",
      "--settings",
      SETTINGS,
      "--resume",
      "sess-1",
      "--fork-session",
    ]);
  });

  it("値はシェルに安全に引用する（空白・引用符・$・バッククォート・; を含む作業ツリーでも、1 語のまま・展開されない）", () => {
    const wt = "/tmp/a b/it's $(echo x) `id`;x";
    const c = buildLaunchCommand({ worktree: wt, name: "n" });
    const out = execFileSync(
      "sh",
      ["-c", `set -- ${c.slice(4, c.indexOf(" && "))}; printf '%s' "$1"`],
      {
        encoding: "utf8",
      },
    );
    expect(out).toBe(wt);
    expect(c).not.toMatch(/\$\{|\$[A-Za-z_]/); // 変数を使わない（値は単一引用符の中だけ）
  });

  it("文と指示に、紐付けのコードを入れない（指示は child_bind を引数なしで呼ぶことだけ）", () => {
    const c = buildLaunchCommand({ worktree: "/w/a", name: "n", model: "opus", effort: "max" });
    expect(c).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
    expect(c).not.toMatch(/bindCode|bind-code/);
    expect(CHILD_LAUNCH_INSTRUCTION).toBe(
      "最初に touryou の child_bind を引数なしで呼んで、受信箱の手順に従って",
    );
  });

  it("ロールで指示を書き分ける: integrator は integrator の skill を指し、implement・investigate・省略は子の文のまま", () => {
    const instructionOf = (role?: string): string =>
      argsOf(
        buildLaunchCommand({ worktree: "/w/a", name: "n", ...(role ? { role } : {}) }),
      )[1] as string;
    expect(instructionOf("integrator")).toBe(INTEGRATOR_LAUNCH_INSTRUCTION);
    expect(INTEGRATOR_LAUNCH_INSTRUCTION).toBe(
      "touryou の integrator の skill に従って、最初に child_bind を引数なしで呼んで",
    );
    for (const role of ["implement", "investigate", undefined]) {
      expect(instructionOf(role)).toBe(
        "最初に touryou の child_bind を引数なしで呼んで、受信箱の手順に従って",
      );
    }
  });

  it("--settings の JSON は sh で 1 語に分かれ、そのまま読み戻せる（crossSessionInbound と permissions.allow）", () => {
    const allow = ["Bash(git status:*)", "Edit(./it's dir/**)", "mcp__plugin_x_node__report_done"];
    const deny = ["Read(./sec ret/**)"];
    const c = build({ worktree: "/w/a", name: "n", permissions: { allow, deny } });
    const args = argsOf(c);
    const json = args[args.indexOf("--settings") + 1] as string;
    expect(JSON.parse(json)).toEqual({
      crossSessionInbound: "accept",
      permissions: { allow, deny },
    });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });

  it("--plugin-dir は、空白のある場所でも 1 語に引用する", () => {
    const c = build({
      worktree: "/w/a",
      name: "n",
      permissions: PERMS,
      pluginDir: "/a b/$x/plugin",
    });
    const args = argsOf(c);
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe("/a b/$x/plugin");
    expect(args.indexOf("--plugin-dir")).toBeLessThan(args.indexOf("--permission-mode"));
    expect(argsOf(buildLaunchCommand({ worktree: "/w/a", name: "n" }))).not.toContain(
      "--plugin-dir",
    );
  });

  it("実行しても、呼び出し元のシェルの cwd が変わらない（サブシェル。統合の cwd が子の作業ツリーに残らない）", () => {
    const c = buildLaunchCommand({ worktree: "/tmp", name: "n" });
    const out = execFileSync("sh", ["-c", `cd / && claude() { :; }; ${c}; pwd`], {
      encoding: "utf8",
    });
    expect(out.trim()).toBe("/");
  });

  it("モデル・深さの形", () => {
    expect(isModelName("claude-opus-5-5")).toBe(true);
    expect(isModelName("opus")).toBe(true);
    expect(isModelName("a b")).toBe(false);
    expect(isModelName("$(x)")).toBe(false);
    expect(isEffort("xhigh")).toBe(true);
    expect(isEffort("ultra")).toBe(false);
  });
});
