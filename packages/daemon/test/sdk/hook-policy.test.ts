import { PLUGIN_NAME, type Scope } from "@touryou/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideToolUse,
  grantedOnlyByExtension,
  withRealWritePath,
} from "../../src/sdk/hook-policy.js";

const CWD = "/wt/a";
const scope: Scope = {
  writableLocations: ["src", "docs"],
  forbiddenLocations: ["src/secret"],
  allowedCommands: ["ls", "git status", "pnpm test"],
};
const identity = async (p: string) => p;
const decide = (tool: string, input: unknown) => decideToolUse(scope, CWD, tool, input, identity);
type Decision = Awaited<ReturnType<typeof decide>>;
const denied = (d: Decision) => (d.allow ? null : (d.violation?.reason ?? "unknownTool"));

describe("読み込み系のツールは許可（FR_014: 読み込みは制限しない）", () => {
  it("Read・Glob・Grep・NotebookRead は、場所を問わず許可する", async () => {
    expect((await decide("Read", { file_path: "/etc/passwd" })).allow).toBe(true);
    expect((await decide("Glob", { pattern: "**/*.ts" })).allow).toBe(true);
    expect((await decide("Grep", { pattern: "x", path: "/" })).allow).toBe(true);
    expect((await decide("NotebookRead", { notebook_path: "/x.ipynb" })).allow).toBe(true);
  });

  it("Skill（子に渡した skill を読む）は許可する", async () => {
    expect((await decide("Skill", { skill: "touryou-child-skills:child" })).allow).toBe(true);
  });
});

describe("書き込み系のツールは、作業範囲の場所で判定する", () => {
  it("Write・Edit・MultiEdit は file_path、NotebookEdit は notebook_path を判定する", async () => {
    expect((await decide("Write", { file_path: "src/a.ts", content: "x" })).allow).toBe(true);
    expect((await decide("Edit", { file_path: "/wt/a/docs/x.md" })).allow).toBe(true);
    expect((await decide("MultiEdit", { file_path: "src/b.ts", edits: [] })).allow).toBe(true);
    expect((await decide("NotebookEdit", { notebook_path: "src/n.ipynb" })).allow).toBe(true);
    expect(denied(await decide("Write", { file_path: "package.json" }))).toBe("outsideWritable");
    expect(denied(await decide("Edit", { file_path: "src/secret/k" }))).toBe("forbiddenLocation");
    expect(denied(await decide("NotebookEdit", { notebook_path: "/etc/x.ipynb" }))).toBe(
      "outsideWritable",
    );
    expect(denied(await decide("Write", { file_path: "src/../package.json" }))).toBe(
      "outsideWritable",
    );
  });

  it("対象のパスが無い・文字列でない書き込みは拒否する（フェイルクローズ）", async () => {
    for (const input of [{}, { file_path: 5 }, { file_path: "" }, null, undefined, "x", []]) {
      expect(denied(await decide("Write", input)), JSON.stringify(input)).not.toBeNull();
    }
  });
});

describe("Bash は、コマンドで判定し、バックグラウンド実行は拒否する", () => {
  it("許可されたコマンドは許可し、そうでなければ拒否する", async () => {
    expect((await decide("Bash", { command: "ls -la" })).allow).toBe(true);
    expect((await decide("Bash", { command: "git status && pnpm test" })).allow).toBe(true);
    expect(denied(await decide("Bash", { command: "rm -rf src" }))).toBe("commandNotAllowed");
    expect(denied(await decide("Bash", { command: "bash -c ls" }))).toBe("indirectExecution");
    expect(denied(await decide("Bash", { command: "ls > src/out" }))).toBe("unparsable");
  });

  it("run_in_background が真なら、コマンドが許可でも拒否する", async () => {
    const d = await decide("Bash", { command: "ls", run_in_background: true });
    expect(denied(d)).toBe("backgroundExecution");
    expect((await decide("Bash", { command: "ls", run_in_background: false })).allow).toBe(true);
  });

  it("command が文字列でなければ拒否する", async () => {
    for (const input of [{}, { command: 1 }, { command: "" }, null]) {
      expect(denied(await decide("Bash", input)), JSON.stringify(input)).not.toBeNull();
    }
  });
});

describe("自ノードの MCP ツールは許可し、未知のツールは拒否する（フェイルクローズ）", () => {
  it("mcp__node__* は許可する（自ノードの窓口。権限は窓口側のロールで絞る）", async () => {
    expect((await decide("mcp__node__report_progress", { text: "x" })).allow).toBe(true);
    expect((await decide("mcp__node__whoami", {})).allow).toBe(true); // 自分の nodeId・role を返すメタツール
  });

  it("子のロールの道具は、plugin から入れた名前の形でも許可する。ほかのロールの道具・ほかの plugin は拒否する", async () => {
    const P = `mcp__plugin_${PLUGIN_NAME}_node__`;
    for (const t of [
      "inbox_fetch",
      "report_progress",
      "report_done",
      "report_decision",
      "report_outOfScope",
      "scope_extend",
      "child_bind",
      "whoami",
    ]) {
      expect((await decide(`${P}${t}`, {})).allow, t).toBe(true);
      expect((await decide(`mcp__node__${t}`, {})).allow, t).toBe(true);
    }
    for (const t of [
      "node_spawn",
      "node_stop",
      "parent_request",
      "parent_report",
      "tree_list",
      "decision_answer",
      "node_purge",
    ]) {
      expect((await decide(`${P}${t}`, {})).allow, t).toBe(false);
      expect((await decide(`mcp__node__${t}`, {})).allow, t).toBe(false);
    }
    for (const t of [
      "mcp__plugin_other_node__inbox_fetch",
      "mcp__plugin_touryou_other__inbox_fetch",
      `${P}`,
      "mcp__node__",
    ]) {
      expect((await decide(t, {})).allow, t).toBe(false);
    }
  });

  it("読み取りのみで無害なツール（LS・TodoWrite・ToolSearch・BashOutput）は許可する", async () => {
    for (const tool of ["LS", "TodoWrite", "ToolSearch", "BashOutput"]) {
      expect((await decide(tool, {})).allow, tool).toBe(true);
    }
  });

  it("別の MCP サーバー、サブエージェント、ウェブ、未知のツールは拒否する。範囲違反ではなく unknownTool（記録先は別。受信箱に載せない）", async () => {
    for (const tool of [
      "mcp__other__do",
      "Task",
      "Agent",
      "WebFetch",
      "WebSearch",
      "KillShell",
      "Unknown",
      "",
      "mcp__node",
      "mcp__nodex__a",
    ]) {
      const d = await decide(tool, {});
      expect(d.allow, tool).toBe(false);
      if (!d.allow) {
        expect(d.violation, tool).toBeUndefined();
        expect(d.unknownTool, tool).toBe(tool === "" ? "(ツール名が空)" : tool);
        expect(d.reason).toContain("使えない");
        expect(d.reason).toContain("自分で原因を探したり");
        expect(d.reason).toContain("mcp__plugin_touryou_node__child_bind");
        expect(d.reason).toContain("紐付けを出し直す");
        expect(d.reason).not.toContain("画面を見ている人");
        expect(d.reason).not.toContain("/");
        expect(d.reason).not.toContain("作業範囲");
      }
    }
  });

  it("Bash の dangerouslyDisableSandbox: true は拒否する（false・省略は通常の判定）", async () => {
    expect(denied(await decide("Bash", { command: "ls", dangerouslyDisableSandbox: true }))).toBe(
      "commandNotAllowed",
    );
    expect((await decide("Bash", { command: "ls", dangerouslyDisableSandbox: false })).allow).toBe(
      true,
    );
  });

  it("拒否は、記録に使う違反（reason・subject）と、モデルへ伝える理由を持つ", async () => {
    const d = await decide("Write", { file_path: "package.json" });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.violation?.subject).toBe("/wt/a/package.json");
      expect(d.reason).toContain("範囲");
    }
  });
});

describe("性質（fast-check）", () => {
  it("決定的で、ツール名・入力が何であっても例外を出さない", async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), fc.anything(), async (tool, input) => {
        const a = await decide(tool as never, input);
        expect(await decide(tool as never, input)).toEqual(a);
        expect(typeof a.allow).toBe("boolean");
      }),
    );
  });

  it("許可された書き込みの対象は、必ず許可場所の配下で、禁止場所の外", async () => {
    const seg = fc.constantFrom("a", "b", "..", ".", "secret", "src", "docs", "X");
    await fc.assert(
      fc.asyncProperty(fc.array(seg, { minLength: 1, maxLength: 5 }), async (p) => {
        const path = p.join("/");
        const d = await decide("Write", { file_path: path });
        const norm = new URL(path, "file:///wt/a/").pathname.toLowerCase();
        const inside = (dir: string) => norm === dir || norm.startsWith(`${dir}/`);
        if (d.allow) {
          expect(inside("/wt/a/src") || inside("/wt/a/docs")).toBe(true);
          expect(inside("/wt/a/src/secret")).toBe(false);
        }
      }),
    );
  });
});

describe("書き込み先の解決（シンボリックリンク対策）", () => {
  it("解決した実パスで判定する。解決に失敗したら拒否する", async () => {
    const link = async (p: string) => (p === "/wt/a/src/link/x" ? "/etc/x" : p);
    const d = await decideToolUse(scope, CWD, "Write", { file_path: "src/link/x" }, link);
    expect(denied(d)).toBe("outsideWritable");
    const boom = async () => {
      throw new Error("EACCES");
    };
    expect(denied(await decideToolUse(scope, CWD, "Write", { file_path: "src/a" }, boom))).toBe(
      "invalidPath",
    );
  });
});

describe("読み取りも禁じる場所（FR_014 の例外）", () => {
  const S = "/home/u/state";
  const prot = {
    roots: [
      { path: S, kind: "stateDir" as const },
      { path: "/home/u/touryou.json", kind: "daemonConfig" as const },
    ],
    allow: [`${S}/children/shared`, `${S}/children/a`],
    home: `${S}/children/a`,
  };
  // 実パスにする（.. を畳み、/link を stateDir へのリンクとして解決する）
  const resolve = async (p: string) => {
    const { posix } = await import("node:path");
    const n = posix.resolve(p);
    if (n === "/link" || n.startsWith("/link/")) return S + n.slice("/link".length);
    const esc = `${S}/children/a/escape`; // 自分の HOME の中の、stateDir の直下を指すリンク
    if (n === esc || n.startsWith(`${esc}/`)) return S + n.slice(esc.length);
    return n;
  };
  const d = (tool: string, input: unknown) =>
    decideToolUse(scope, "/home/u/wt/a", tool, input, resolve, prot);
  const reasonOf = async (tool: string, input: unknown) => {
    const r = await d(tool, input);
    return r.allow ? null : (r.violation?.subject ?? r.violation?.reason ?? "unknownTool");
  };

  it("Read・NotebookRead・LS: stateDir と設定ファイルの中は拒否。ほかの場所は今までどおり許可", async () => {
    expect(await reasonOf("Read", { file_path: `${S}/human-token` })).toBe("protected:stateDir");
    expect(await reasonOf("Read", { file_path: "/home/u/touryou.json" })).toBe(
      "protected:daemonConfig",
    );
    expect(await reasonOf("NotebookRead", { notebook_path: `${S}/x.ipynb` })).toBe(
      "protected:stateDir",
    );
    expect(await reasonOf("LS", { path: `${S}/children.noindex` })).toBe("protected:stateDir");
    expect(await reasonOf("Read", { file_path: "/etc/hosts" })).toBeNull();
    expect(await reasonOf("LS", { path: "/home/u" })).toBeNull(); // 一覧だけ（再帰しない）の祖先は許す
  });

  it("リンク・.. を通っても、実パスで判定する", async () => {
    expect(await reasonOf("Read", { file_path: "/link/root-token" })).toBe("protected:stateDir");
    expect(await reasonOf("Read", { file_path: "/home/u/wt/a/../../state/human-token" })).toBe(
      "protected:stateDir",
    );
  });

  it("許した場所（自分の引き出し・共有の写し）は読める。ほかのノードの場所は拒否", async () => {
    expect(
      await reasonOf("Read", { file_path: `${S}/children/a/.claude/settings.json` }),
    ).toBeNull();
    expect(
      await reasonOf("Read", { file_path: `${S}/children/shared/skills/x/SKILL.md` }),
    ).toBeNull();
    expect(await reasonOf("Read", { file_path: `${S}/children/b/x` })).toBe("protected:stateDir");
  });

  it("Glob・Grep: 中も、禁じる場所を含む祖先（再帰で読まれる）も拒否。作業ツリーは許可", async () => {
    expect(await reasonOf("Grep", { pattern: "x", path: S })).toBe("protected:stateDir");
    expect(await reasonOf("Grep", { pattern: "x", path: "/home/u" })).toBe("protected:stateDir");
    expect(await reasonOf("Glob", { pattern: "/home/*/state/**" })).toBe("protected:stateDir");
    expect(await reasonOf("Glob", { pattern: "**/*", path: "/" })).toBe("protected:stateDir");
    expect(await reasonOf("Glob", { pattern: "**/*.ts" })).toBeNull();
    expect(await reasonOf("Grep", { pattern: "x" })).toBeNull();
  });

  it("書き込みの道具は、今の範囲の決まりのまま（禁じる場所の判定では見ない）", async () => {
    const r = await d("Write", { file_path: `${S}/x`, content: "y" });
    expect(r.allow ? null : r.violation?.reason).toBe("outsideWritable");
  });

  it("書き込みの拒否（outsideWritable）でも、対象が禁じる場所の中なら、件名と文面には種類だけを書く（判定は変えない）", async () => {
    for (const path of [`${S}/x`, `${S}/children/a/y`]) {
      const r = await d("Write", { file_path: path, content: "y" });
      expect(r.allow).toBe(false);
      if (!r.allow) {
        expect(r.violation?.reason).toBe("outsideWritable");
        expect(r.violation?.subject).toBe("protected:stateDir");
        expect(r.reason).not.toContain(S);
      }
    }
    const other = await d("Write", { file_path: "/etc/x", content: "y" });
    expect(other.allow ? null : other.violation?.subject).toBe("/etc/x");
  });

  it("許す場所の判定も実パスで行う（自分の HOME の中のリンクで、ほかの場所を指しても通らない）", async () => {
    expect(await reasonOf("Read", { file_path: `${S}/children/a/escape/human-token` })).toBe(
      "protected:stateDir",
    );
  });

  it("Bash: パスに見える語（絶対・相対・~・--opt=値・グロブ）を実パスで判定する", async () => {
    expect(await reasonOf("Bash", { command: `ls ${S}/human-token` })).toBe("protected:stateDir");
    expect(await reasonOf("Bash", { command: "pnpm test ../../state/human-token" })).toBe(
      "protected:stateDir",
    );
    expect(await reasonOf("Bash", { command: "pnpm test --config=/home/u/touryou.json" })).toBe(
      "protected:daemonConfig",
    );
    expect(await reasonOf("Bash", { command: "ls ~/../b" })).toBe("protected:stateDir"); // 自分の HOME の外（別のノードの HOME）
    expect(await reasonOf("Bash", { command: "ls ~/.claude" })).toBeNull(); // 自分の HOME
    expect(await reasonOf("Bash", { command: "ls /home/*/state" })).toBe("protected:stateDir");
    expect(await reasonOf("Bash", { command: "ls /link" })).toBe("protected:stateDir");
    expect(await reasonOf("Bash", { command: "ls src" })).toBeNull();
    expect(await reasonOf("Bash", { command: "git status" })).toBeNull();
  });

  it("Bash: 変数・置換を含む命令は、もともと解析できないので拒否される", async () => {
    expect((await d("Bash", { command: 'ls "$HOME"/x' })).allow).toBe(false);
    expect((await d("Bash", { command: "ls $(echo /home/u/state)" })).allow).toBe(false);
  });

  it("波括弧・拡張グロブで、すり抜けられない（展開してすべての候補を確かめる。確かめきれなければ拒否）", async () => {
    expect(await reasonOf("Bash", { command: "ls /home/u/{state,x}/human-token" })).toBe(
      "protected:stateDir",
    );
    expect(await reasonOf("Bash", { command: `ls {${S},/tmp}/human-token` })).toBe(
      "protected:stateDir",
    );
    // 拡張グロブの `(` は、Bash ではもともと解析できず拒否される。Glob の pattern では、固定の部分で判定する
    expect((await d("Bash", { command: "ls /home/u/@(state|x)/human-token" })).allow).toBe(false);
    expect(await reasonOf("Glob", { pattern: "/home/u/@(state|x)/*" })).toBe("protected:stateDir");
    expect(await reasonOf("Bash", { command: "ls /home/u/{1..3}/x" })).toBe(
      "Bash（パスを確かめられない）",
    );
    expect(await reasonOf("Glob", { pattern: "/home/u/{state,x}/*" })).toBe("protected:stateDir");
    expect(await reasonOf("Glob", { pattern: "../../{state,x}/*" })).toBe("protected:stateDir");
    // `/` を含まない `{}`（find -exec・xargs -I）は巻き込まない
    expect(await reasonOf("Bash", { command: "ls src {}" })).toBeNull();
    expect(await reasonOf("Bash", { command: "ls -I{} src" })).toBeNull();
    expect(await reasonOf("Bash", { command: "ls src/{a,b}.ts" })).toBeNull();
  });

  it("`~` と `~/…` 以外の `~` で始まる語（~root・~user・~+・~-）は拒否", async () => {
    for (const w of ["~root/x", "~u/state", "~+/x", "~-/x", "~root"]) {
      expect(await reasonOf("Bash", { command: `ls ${w}` }), w).toBe(
        "Bash（パスを確かめられない）",
      );
    }
  });

  it("語の途中に続くパス（-C/path・-d@/path・a=b=/p・x:/p・x,/p）も確かめる。末尾の / では妨げない", async () => {
    for (const w of [`-C${S}`, `-d@${S}/x`, `a=b=${S}/x`, `x:${S}/x`, `x,${S}/x`]) {
      expect(await reasonOf("Bash", { command: `ls ${w}` }), w).toBe("protected:stateDir");
    }
    expect(await reasonOf("Bash", { command: "ls src/" })).toBeNull();
  });

  it("複合の命令の cd・pushd を追って、後ろの相対の語を確かめる。行き先の分からない cd は拒否", async () => {
    expect(await reasonOf("Bash", { command: "cd /home/u && ls state/human-token" })).toBe(
      "protected:stateDir",
    );
    expect(await reasonOf("Bash", { command: "pushd ../.. ; ls state" })).toBe(
      "protected:stateDir",
    );
    expect(await reasonOf("Bash", { command: "cd ; ls ../b/x" })).toBe("protected:stateDir"); // 引数なしの cd は HOME（自分）
    expect(await reasonOf("Bash", { command: "cd - && ls x" })).toBe(
      "Bash（cd・pushd の行き先を確かめられない）",
    );
    expect(await reasonOf("Bash", { command: "popd && ls x" })).toBe(
      "Bash（cd・pushd の行き先を確かめられない）",
    );
    const ok = await d("Bash", { command: "cd src && ls a.ts" });
    expect(ok.allow ? null : ok.violation?.reason).not.toBe("forbiddenLocation"); // cd は許可リストにないので、範囲の判定で拒否される
  });

  it("大文字小文字・Unicode の正規化の違いを、そろえてから比べる（禁じる場所・許す場所の両方）", async () => {
    expect(await reasonOf("Read", { file_path: "/HOME/U/STATE/human-token" })).toBe(
      "protected:stateDir",
    );
    expect(await reasonOf("Read", { file_path: `${S}/CHILDREN/A/x` })).toBeNull();
    const nfd = "/home/u/state/x".normalize("NFD");
    expect(await reasonOf("Read", { file_path: nfd })).toBe("protected:stateDir");
  });

  it("Linux の /proc の environ（自分・ほかのプロセス）も読めない。/proc のほかのファイルは読める", async () => {
    expect(await reasonOf("Read", { file_path: "/proc/self/environ" })).toBe(
      "protected:processEnv",
    );
    expect(await reasonOf("Read", { file_path: "/proc/1234/environ" })).toBe(
      "protected:processEnv",
    );
    expect(await reasonOf("Read", { file_path: "/proc/1234/task/5/environ" })).toBe(
      "protected:processEnv",
    );
    expect(await reasonOf("Bash", { command: "ls /proc/self/environ" })).toBe(
      "protected:processEnv",
    );
    expect(await reasonOf("Grep", { pattern: "TOKEN", path: "/proc" })).toBe(
      "protected:processEnv",
    );
    expect(await reasonOf("Read", { file_path: "/proc/cpuinfo" })).toBeNull();
  });

  it("拒否の文面に、禁じる場所の実パスを出さない（種類だけ）", async () => {
    const r = await d("Read", { file_path: `${S}/human-token` });
    expect(r.allow).toBe(false);
    if (!r.allow) {
      expect(r.reason).not.toContain(S);
      expect(r.violation?.subject).not.toContain(S);
      expect(r.reason).toContain("daemon の状態の置き場");
    }
  });

  it("禁じる場所を渡さなければ、今までどおり（読み込みは場所を問わず許可）", async () => {
    expect(
      (await decideToolUse(scope, CWD, "Read", { file_path: `${S}/human-token` }, identity)).allow,
    ).toBe(true);
  });
});

describe("自分の引き出しの例外", () => {
  const S = "/home/u/state";
  const D = `${S}/children.noindex`;
  const mine = `${D}/aaaa`;
  const other = `${D}/bbbb`;
  const TOURYOU = "node /opt/touryou/bin.js";
  const childScope: Scope = {
    writableLocations: ["src"],
    forbiddenLocations: [],
    allowedCommands: [`${TOURYOU} child`, "cat", "ls", "grep"],
  };
  const prot = {
    roots: [{ path: S, kind: "stateDir" as const }],
    allow: [],
    home: `${S}/children/a`,
    drawer: mine,
    touryouCommand: ["node", "/opt/touryou/bin.js"],
  };
  const resolve = async (p: string) => {
    const { posix } = await import("node:path");
    const n = posix.resolve(p);
    if (n === "/link" || n.startsWith("/link/")) return other + n.slice("/link".length); // 他人の引き出しへのリンク
    return n;
  };
  const reasonOf = async (tool: string, input: unknown) => {
    const r = await decideToolUse(childScope, "/home/u/wt/a", tool, input, resolve, prot);
    return r.allow ? null : (r.violation?.subject ?? r.violation?.reason ?? "unknownTool");
  };
  const bash = (command: string) => reasonOf("Bash", { command });

  it("Bash: touryou child bind|report の --dir の値が自分の引き出しなら許す", async () => {
    expect(
      await bash(`${TOURYOU} child bind --dir ${mine} --url http://127.0.0.1:7777`),
    ).toBeNull();
    expect(
      await bash(`${TOURYOU} child report --dir ${mine}/ --url http://127.0.0.1:7777 progress`),
    ).toBeNull();
  });

  it("Bash: touryou child の命令の --dir が自分の引き出しそのものでなければ拒否（他人の引き出し・リンク経由・中のファイル・--dir=値）", async () => {
    for (const dir of [other, "/link", `${mine}/token`, `${mine}/*`, "/home/u/wt/a", "rel"]) {
      expect(
        await bash(`${TOURYOU} child bind --dir ${dir} --url http://127.0.0.1:7777`),
        dir,
      ).not.toBeNull();
    }
    expect(
      await bash(`${TOURYOU} child bind --dir=${mine} --url http://127.0.0.1:7777`),
    ).not.toBeNull();
  });

  it("Bash: 例外は、先頭が touryouCommand・2 語目が child・3 語目が bind|report の命令だけ", async () => {
    const no = "protected:stateDir";
    expect(await bash(`tar --dir ${mine} -cf - token child bind`)).toBe(no);
    expect(await bash(`pnpm --dir ${mine} exec cat token child bind`)).toBe(no);
    expect(await bash(`${TOURYOU} --dir ${mine} child bind`)).toBe(no);
    expect(await bash(`node /other/bin.js child bind --dir ${mine} --url u`)).toBe(no);
    expect(await bash(`${TOURYOU} child purge --dir ${mine}`)).toBe(no);
    expect(await bash(`${TOURYOU} child bind --url u; cat --dir ${mine}`)).toBe(no);
    // touryouCommand がなければ、先頭が touryou か、末尾が /touryou の語
    const r = await decideToolUse(
      { ...childScope, allowedCommands: ["touryou child", "/usr/local/bin/touryou child"] },
      "/home/u/wt/a",
      "Bash",
      { command: `/usr/local/bin/touryou child bind --dir ${mine} --url u` },
      resolve,
      { ...prot, touryouCommand: undefined },
    );
    expect(r.allow).toBe(true);
  });

  it("Bash: touryou child の命令でも、--dir の値のほかの語（token の 1 語・.）は、ふつうに判定する", async () => {
    // 作業ツリーを基準にした相対の語は、禁じる場所ではない（引き出しの中の token ではない）
    expect(await bash(`${TOURYOU} child report --dir ${mine} --url u progress token`)).toBeNull();
    expect(await bash(`${TOURYOU} child report --dir ${mine} --url u .`)).toBeNull();
    expect(await bash(`${TOURYOU} child report --dir ${mine} --url ${mine}/token progress`)).toBe(
      "protected:stateDir",
    );
  });

  it("Bash: 他人の引き出し・リンク経由・--dir 以外の位置・touryou child でない命令は、禁じる場所のまま", async () => {
    const no = "protected:stateDir";
    expect(await bash(`ls --dir ${mine}`)).toBe(no);
    expect(await bash(`cat ${mine}`)).toBe(no);
    expect(await bash(`${TOURYOU} child bind ${mine} --dir x`)).not.toBeNull();
    expect(await bash(`${TOURYOU} child bind --dir ${mine}/* --url u`)).not.toBeNull();
    expect(await bash(`cd ${mine}`)).toBe(no);
  });

  it("Bash: 自分の引き出しの token とその一時ファイル、ほかの中のファイルの名前を含む語は拒否する", async () => {
    const no = "protected:stateDir";
    for (const f of ["token", "token.tmp-0123", "url", "code", "node"]) {
      expect(await bash(`cat ${mine}/${f}`), f).toBe(no);
      expect(
        await bash(`${TOURYOU} child report --dir ${mine} --url ${mine}/${f} progress`),
        f,
      ).toBe(no);
    }
    expect(await bash(`grep -r x ${mine}`)).toBe(no);
    // リダイレクトは、範囲の判定（コマンドの許可）でも拒否される。どちらの理由でも通らない
    expect(
      await bash(`${TOURYOU} child report --dir ${mine} --url u progress < ${mine}/token`),
    ).not.toBeNull();
  });

  it("Write: 自分の引き出しの code だけ書ける。Edit・ほかのファイル・他人の引き出しは拒否", async () => {
    expect(await reasonOf("Write", { file_path: `${mine}/code`, content: "X" })).toBeNull();
    expect(await reasonOf("Write", { file_path: `${mine}/report`, content: "進んだ" })).toBeNull();
    expect(await reasonOf("Write", { file_path: `${other}/report` })).not.toBeNull();
    expect(await reasonOf("Edit", { file_path: `${mine}/code` })).not.toBeNull();
    expect(await reasonOf("Write", { file_path: `${mine}/token` })).not.toBeNull();
    expect(await reasonOf("Write", { file_path: `${other}/code` })).not.toBeNull();
    expect(await reasonOf("Write", { file_path: "/link/code" })).not.toBeNull();
  });

  it("読み取りの道具は、自分の引き出しも拒否する（token をモデルに読ませない）", async () => {
    expect(await reasonOf("Read", { file_path: `${mine}/token` })).toBe("protected:stateDir");
    expect(await reasonOf("Read", { file_path: `${mine}/code` })).toBe("protected:stateDir");
    expect(await reasonOf("Glob", { pattern: `${mine}/*` })).toBe("protected:stateDir");
    expect(await reasonOf("Grep", { pattern: "x", path: mine })).toBe("protected:stateDir");
  });

  it("引き出しがない（drawer なし）なら、--dir の値も禁じる場所のまま", async () => {
    const r = await decideToolUse(
      childScope,
      "/home/u/wt/a",
      "Bash",
      { command: `${TOURYOU} child bind --dir ${mine} --url u` },
      resolve,
      { ...prot, drawer: undefined },
    );
    expect(r.allow).toBe(false);
  });
});

describe("作業ツリーの .claude/ の書き込みの守り", () => {
  const WT = "/home/u/wt/a";
  const scope2: Scope = {
    writableLocations: ["src", "."],
    forbiddenLocations: [],
    allowedCommands: ["rm", "mv", "chmod", "cp", "git", "find", "ls", "grep", "cat", "cd", "node"],
  };
  const prot = {
    roots: [{ path: "/home/u/state", kind: "stateDir" as const }],
    allow: [],
    writeDenied: [`${WT}/.claude`],
  };
  const resolve = async (p: string) => (await import("node:path")).posix.resolve(p);
  const bash = async (command: string, cwd = WT) => {
    const r = await decideToolUse(scope2, WT, "Bash", { command }, resolve, prot, cwd);
    return r.allow;
  };
  const tool = async (name: string, input: unknown) =>
    (await decideToolUse(scope2, WT, name, input, resolve, prot)).allow;

  it("/ を含まない語・グロブ・cd の先からの相対で .claude に当たる命令は拒否", async () => {
    for (const c of [
      "rm -rf .claude",
      "rm -rf .cla*",
      "mv .claude x",
      "chmod -R 000 .claude",
      "cp /dev/null .claude",
      "rm .claude/settings.json",
      "cat .claude/settings.local.json",
      "rm -rf ./.claude/*",
      "cd src && rm -rf ../.claude",
      "rm -rf .[c]laude",
      "rm -rf {.claude,x}",
    ]) {
      expect(await bash(c), c).toBe(false);
    }
    expect(await bash("rm -rf ../.claude", `${WT}/src`)).toBe(false);
  });

  it("消す・動かすコマンドが、作業ツリーそのもの・その親を対象にしたら拒否。git clean・stash --all/-a/-u は拒否", async () => {
    for (const c of [
      "rm -rf .",
      `rm -rf ${WT}`,
      "rm -rf ..",
      "chmod -R 000 .",
      "find . -delete",
      "git clean -fdx",
      "git stash --all",
      "git stash -a",
      "git stash -u",
    ]) {
      expect(await bash(c), c).toBe(false);
    }
  });

  it("ふだんの作業は通る（git add .・grep -rn ・find .・ls .・rm src/x・git stash）", async () => {
    for (const c of [
      "git add .",
      "grep -rn foo .",
      "find . -name x",
      "ls .",
      "rm -rf src/x",
      "git stash",
      "ls src",
    ]) {
      expect(await bash(c), c).toBe(true);
    }
  });

  it("Read・Glob・Grep は .claude を読める。Write・Edit は拒否", async () => {
    expect(await tool("Read", { file_path: `${WT}/.claude/settings.json` })).toBe(true);
    expect(await tool("Glob", { pattern: ".claude/*" })).toBe(true);
    expect(await tool("Grep", { pattern: "x", path: `${WT}/.claude` })).toBe(true);
    expect(
      await tool("Write", { file_path: `${WT}/.claude/settings.local.json`, content: "{}" }),
    ).toBe(false);
    expect(await tool("Edit", { file_path: `${WT}/.claude/settings.json` })).toBe(false);
  });
});

describe("plugin の設定（plugin.json の name・.mcp.json のサーバーの名前）から作った、子の道具の名前は許可する", () => {
  it("両方の名前の形で、子の道具がすべて ALLOW になる", async () => {
    const { readFileSync } = await import("node:fs");
    const { CHILD_MCP_TOOL_NAMES } = await import("@touryou/core");
    const root = new URL("../../../../plugin/", import.meta.url);
    const name = (
      JSON.parse(readFileSync(new URL(".claude-plugin/plugin.json", root), "utf8")) as {
        name: string;
      }
    ).name;
    const servers = Object.keys(
      (
        JSON.parse(readFileSync(new URL(".mcp.json", root), "utf8")) as {
          mcpServers: Record<string, unknown>;
        }
      ).mcpServers,
    );
    expect(servers).toEqual(["node"]);
    for (const server of servers) {
      for (const t of CHILD_MCP_TOOL_NAMES) {
        for (const full of [`mcp__${server}__${t}`, `mcp__plugin_${name}_${server}__${t}`]) {
          expect((await decide(full, {})).allow, full).toBe(true);
        }
      }
    }
  });
});

describe("範囲の階層（#168 PR3）: 孫のフックは、孫自身の範囲で判定する", () => {
  // サブ統括の範囲（src・docs）の内側に、孫の範囲（src/feature だけ）がある。判定のコードは孫の範囲だけを見る
  const subIntegrator: Scope = {
    writableLocations: ["src", "docs"],
    forbiddenLocations: [".git"],
    allowedCommands: ["pnpm test", "git status"],
  };
  const grandchild: Scope = {
    writableLocations: ["src/feature"],
    forbiddenLocations: [".git", "src/feature/secret"],
    allowedCommands: ["git status"],
  };
  const asGrandchild = (tool: string, input: unknown) =>
    decideToolUse(grandchild, "/wt/grandchild", tool, input, identity);
  const asSubIntegrator = (tool: string, input: unknown) =>
    decideToolUse(subIntegrator, "/wt/sub", tool, input, identity);

  it("サブ統括の範囲の内でも、孫自身の範囲の外なら拒否する", async () => {
    expect((await asSubIntegrator("Write", { file_path: "docs/x.md", content: "x" })).allow).toBe(
      true,
    );
    expect(denied(await asGrandchild("Write", { file_path: "docs/x.md", content: "x" }))).toBe(
      "outsideWritable",
    );
    expect(denied(await asGrandchild("Bash", { command: "pnpm test" }))).toBe("commandNotAllowed");
  });

  it("孫自身の範囲の内なら許可し、孫の禁止の場所は拒否する", async () => {
    expect(
      (await asGrandchild("Write", { file_path: "src/feature/a.ts", content: "x" })).allow,
    ).toBe(true);
    expect((await asGrandchild("Bash", { command: "git status" })).allow).toBe(true);
    expect(denied(await asGrandchild("Edit", { file_path: "src/feature/secret/k" }))).toBe(
      "forbiddenLocation",
    );
  });

  it("孫の範囲がサブ統括の範囲の外の場所を含んでも、判定は孫の範囲だけで決まる（範囲の包含は spawn の検査の仕事）", async () => {
    const wide: Scope = { ...grandchild, writableLocations: ["src/feature", "scripts"] };
    expect(
      (
        await decideToolUse(
          wide,
          "/wt/grandchild",
          "Write",
          { file_path: "scripts/a.sh" },
          identity,
        )
      ).allow,
    ).toBe(true);
    expect(denied(await asSubIntegrator("Write", { file_path: "scripts/a.sh" }))).toBe(
      "outsideWritable",
    );
  });
});

describe("道具の許可は、呼び出したノードのロールで決まる（#168 PR3）", () => {
  const P = `mcp__plugin_${PLUGIN_NAME}_node__`;
  const sub = (tool: string) =>
    decideToolUse(scope, CWD, tool, {}, identity, undefined, CWD, "integrator");
  const child = (tool: string) => decideToolUse(scope, CWD, tool, {}, identity, undefined, CWD);

  it("サブ統括（統合ロール）は、統合の道具・親への報告の道具・child_bind を、2 つの名前の形で許可する", async () => {
    for (const t of [
      "node_spawn",
      "node_review",
      "scope_decide",
      "parent_request",
      "parent_report",
      "inbox_fetch",
      "tree_list",
      "report_done",
      "scope_extend",
      "child_inbox",
      "child_bind",
      "whoami",
    ]) {
      expect((await sub(`mcp__node__${t}`)).allow, t).toBe(true);
      expect((await sub(`${P}${t}`)).allow, t).toBe(true);
    }
  });

  it("サブ統括でも、人間専用の道具・知らない道具・ほかの plugin は拒否する", async () => {
    for (const t of [
      "mcp__node__node_purge",
      "mcp__node__node_hookToken",
      "mcp__node__inbox_resolve",
      "mcp__node__confirm_approve",
      "mcp__plugin_other_node__node_spawn",
      "mcp__node__nothing",
    ]) {
      expect((await sub(t)).allow, t).toBe(false);
    }
  });

  it("子（ロールの指定なし・child）は、統合の道具（node_spawn など）を拒否する。子の道具は許可する", async () => {
    for (const t of [
      "node_spawn",
      "node_review",
      "scope_decide",
      "parent_request",
      "child_inbox",
    ]) {
      expect((await child(`mcp__node__${t}`)).allow, t).toBe(false);
      expect((await child(`${P}${t}`)).allow, t).toBe(false);
    }
    for (const t of ["report_done", "scope_extend", "inbox_fetch", "child_bind"]) {
      expect((await child(`mcp__node__${t}`)).allow, t).toBe(true);
    }
  });

  it("ロールが変わっても、範囲・禁じる場所の判定は変わらない（道具の許可の一覧だけが変わる）", async () => {
    const write = (role: "integrator" | "child") =>
      decideToolUse(
        scope,
        CWD,
        "Write",
        { file_path: "/etc/passwd", content: "x" },
        identity,
        undefined,
        CWD,
        role,
      );
    expect((await write("integrator")).allow).toBe(false);
    expect((await write("child")).allow).toBe(false);
  });
});

describe("grantedOnlyByExtension（#91: 承認済みの拡張にだけ、明示の許可）", () => {
  const grep = `git grep -n -E "TODO|FIXME|XXX|HACK" -- . ':!pnpm-lock.yaml'`;
  const brief: Scope = {
    writableLocations: ["src"],
    forbiddenLocations: [".git"],
    allowedCommands: ["pnpm test"],
  };
  const risky = [
    "node",
    "node x.js",
    "pnpm exec x",
    "git -c a=b log",
    "git",
    "cd docs",
    "git config x y",
  ];
  const effective: Scope = {
    ...brief,
    allowedCommands: ["pnpm test", "git ls-files docs .sdd", grep, "git grep", ...risky],
  };
  const permit = (command: string, tool = "Bash") =>
    grantedOnlyByExtension(brief, effective, tool, { command }, "/w");

  it("承認した形そのもの（引用符の付け方だけ違う形を含む）だけが真", () => {
    expect(permit("git ls-files docs .sdd")).toBe(true);
    expect(permit(grep)).toBe(true);
    expect(permit(`git grep -n -E 'TODO|FIXME|XXX|HACK' -- . ':!pnpm-lock.yaml'`)).toBe(true);
    expect(permit("git grep x")).toBe(false); // 2 語の "git grep" は承認済みでも、語の数が違う
  });
  it("前方一致のぶん（うしろに旗を足した形）は偽（フックだけ通し、Claude Code の判定に任せる）", () => {
    // git ls-files は引数を足してよい一覧のコマンド（#130）なので、ここでは一覧の外のコマンドだけを見る
    expect(permit("git ls-files docs .sdd -z")).toBe(true);
    expect(permit("git grep -O sh x")).toBe(false);
    expect(permit("git grep --open-files-in-pager=sh x")).toBe(false);
  });
  it("前方一致で通るだけの、リンクをたどる旗・略した長いオプションは偽", () => {
    const e2: Scope = {
      ...brief,
      allowedCommands: ["pnpm test", "git grep", "find", "grep", "grep -R", "find -L ."],
    };
    for (const c of ["git grep --open=echo x", "grep -R x .", "find -L . -name a"])
      expect(grantedOnlyByExtension(brief, e2, "Bash", { command: c }, "/w"), c).toBe(false);
  });
  it("書き込み: 承認した場所だけが真。ブリーフの場所・承認していない場所・禁じる場所は偽", () => {
    const e3: Scope = {
      ...brief,
      writableLocations: ["src", "docs"],
      forbiddenLocations: [".git", "docs/secret"],
    };
    const w = (tool: string, input: Record<string, unknown>) =>
      grantedOnlyByExtension(brief, e3, tool, input, "/w");
    expect(w("Write", { file_path: "/w/docs/a.md" })).toBe(true);
    expect(w("Edit", { file_path: "docs/b.md" })).toBe(true);
    expect(w("NotebookEdit", { notebook_path: "/w/docs/n.ipynb" })).toBe(true);
    expect(w("MultiEdit", { file_path: "/w/docs/m.md" })).toBe(true);
    expect(w("MultiEdit", { file_path: "/w/src/m.ts" })).toBe(false);
    expect(w("Write", { file_path: "/w/src/a.ts" })).toBe(false);
    expect(w("Write", { file_path: "/w/other/a.ts" })).toBe(false);
    expect(w("Write", { file_path: "/w/docs/secret/k" })).toBe(false);
    expect(w("Write", {})).toBe(false);
  });
  it("任意のコードが動く形・1 語・cd 始まりの承認には、明示の許可を付けない（起動のときの一覧と同じ規則）", () => {
    for (const c of risky) expect(permit(c), c).toBe(false);
  });
  it("ブリーフで通る形・承認していない形・区切りで足した形・Bash 以外は偽", () => {
    expect(permit("pnpm test")).toBe(false);
    expect(permit("git ls-files src")).toBe(false);
    expect(permit("git push")).toBe(false);
    expect(permit(`${grep}; rm -rf /`)).toBe(false);
    expect(permit("pnpm test && git ls-files docs .sdd")).toBe(false);
    expect(permit(grep, "Read")).toBe(false);
    expect(grantedOnlyByExtension(brief, effective, "Bash", {}, "/w")).toBe(false);
  });
});

describe("grantedOnlyByExtension: 引数を足してよい一覧のコマンド（#130）", () => {
  const brief: Scope = {
    writableLocations: ["src"],
    forbiddenLocations: [".git"],
    allowedCommands: ["git status"],
  };
  const eff: Scope = {
    ...brief,
    allowedCommands: [
      "git status",
      "git add",
      "git add src",
      "git ls-files",
      "git rm docs/old.md",
      "git mv src/a.ts",
      "git grep",
      "git log",
    ],
  };
  const permit = (command: string) => grantedOnlyByExtension(brief, eff, "Bash", { command }, "/w");

  it("一覧のコマンドは、承認した形のうしろに、許す表の旗と安全な位置の引数を足しても真", () => {
    for (const c of [
      "git add --dry-run .",
      "git add src/a.ts src/b.ts",
      "git add -A",
      "git add -nv .", // まとめ書きは 1 字ずつ照らす
      "git add -- -p", // `--` のあとは位置の引数
      "git add src -u",
      "git ls-files -zc", // まとめ書き
      "git ls-files -- src",
      "git ls-files -z src",
      "git ls-files --others --exclude-standard",
    ])
      expect(permit(c), c).toBe(true);
  });
  it("一覧のコマンドでも、許す表にない旗・外のパス・展開・リダイレクトを足した形は偽", () => {
    for (const c of [
      "git add -e",
      "git add --edit",
      "git add -p",
      "git add --patch",
      "git add -i",
      "git add --interactive",
      "git add -f .env",
      "git add --force .env",
      "git add -nf .", // まとめ書きの中の -f
      "git add --pathspec-from-file=list.txt",
      "git add --pathspec-from-file=-",
      "git ls-files --exclude-from=x",
      "git ls-files -X x",
      "git add /etc/passwd",
      "git add ../other",
      "git add src/../../x",
      "git add -- ../x",
      "git add -c x",
      "git add ~/x",
      "git add '*.ts'",
      "git add $HOME",
      "git add . > out",
      "git add 'a b'",
      "git add . ; rm -rf src",
    ])
      expect(permit(c), c).toBe(false);
  });
  it("git rm・git mv は一覧に入れない（作業ツリーのファイルを消す・動かすので、承認した形そのものだけ）", () => {
    // 承認した形そのものでも、パスを足す形は実パスの照らしが要る（非同期の grantedBashByExtension）ので、ここでは真にしない
    expect(permit("git rm docs/old.md")).toBe(false);
    expect(permit("git rm docs/old.md -r src")).toBe(false);
    expect(permit("git mv src/a.ts")).toBe(false);
    expect(permit("git mv src/a.ts tmp.ts")).toBe(false);
  });
  it("一覧の外のコマンドは、今のまま完全一致だけ", () => {
    expect(permit("git grep")).toBe(true); // 承認した形そのものは、今までどおり真
    expect(permit("git grep x")).toBe(false);
    expect(permit("git log --output=x")).toBe(false);
    expect(permit("git log -1")).toBe(false);
  });
});

describe("grantedOnlyByExtension の区切りを含む承認・withRealWritePath（#91）", () => {
  const brief: Scope = {
    writableLocations: ["src"],
    forbiddenLocations: [".git"],
    allowedCommands: ["pnpm test"],
  };
  it("区切りを含む承認の項目は、引用符で同じ語にしても明示の許可を付けない", () => {
    const eff: Scope = { ...brief, allowedCommands: ["pnpm test", "git log; rm x"] };
    expect(grantedOnlyByExtension(brief, eff, "Bash", { command: "git 'log;' rm x" }, "/w")).toBe(
      false,
    );
    expect(grantedOnlyByExtension(brief, eff, "Bash", { command: "git log; rm x" }, "/w")).toBe(
      false,
    );
  });
  it("書き込みのパスを実パスにする（相対は道具の cwd から）。解決できなければそのまま", async () => {
    const resolve = async (p: string) => p.replace(/^\/var\//, "/private/var/");
    expect(await withRealWritePath("Write", { file_path: "/var/w/docs/a" }, "/x", resolve)).toEqual(
      {
        file_path: "/private/var/w/docs/a",
      },
    );
    expect(await withRealWritePath("Edit", { file_path: "docs/a" }, "/var/w", resolve)).toEqual({
      file_path: "/private/var/w/docs/a",
    });
    const fail = async (): Promise<string> => {
      throw new Error("x");
    };
    expect(await withRealWritePath("Write", { file_path: "/a" }, "/w", fail)).toEqual({
      file_path: "/a",
    });
    expect(await withRealWritePath("Bash", { command: "ls" }, "/w", resolve)).toEqual({
      command: "ls",
    });
  });
});
