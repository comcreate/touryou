import type { Scope } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { childAllowList } from "../../src/sdk/child-permissions.js";
import { decideToolUse, grantedOnlyByExtension } from "../../src/sdk/hook-policy.js";
import { isReadOnlySearch } from "../../src/sdk/read-only-search.js";

/**
 * #92: native 版の Claude Code は Glob・Grep の道具を出さず、Bash の find・grep で探させる。
 * 子は、範囲の allowedCommands が空でも、作業ツリーの中を探す読み取りだけのコマンドを使える。外・禁じる場所・書き込みは拒否する。
 */
const S = "/home/u/state";
const WT = "/home/u/wt/a";
const scope: Scope = { writableLocations: [WT], forbiddenLocations: [], allowedCommands: [] };
const prot = {
  roots: [{ path: S, kind: "stateDir" as const }],
  allow: [] as string[],
  home: "/home/u",
  worktree: WT,
};
const links: Record<string, string> = { [`${WT}/out`]: "/etc", [`${WT}/st`]: S };
const resolve = async (p: string) => {
  const { posix } = await import("node:path");
  const r = posix.resolve(p);
  for (const [from, to] of Object.entries(links)) {
    if (r === from || r.startsWith(`${from}/`)) return to + r.slice(from.length);
  }
  return r;
};
const allowed = async (command: string, toolCwd = WT) =>
  (await decideToolUse(scope, WT, "Bash", { command }, resolve, prot, toolCwd)).allow;

describe("作業ツリーの中を探すコマンドは、範囲が空でも許す", () => {
  it.each([
    "ls",
    "ls -la docs .sdd",
    "find . -name '*.md'",
    "find docs -type f",
    "grep -rn touryou docs",
    "grep -rn 'foo$' .",
    "git ls-files",
    "git ls-files -- '*.ts'",
    "git grep -n childAllowList",
    "git ls-files | grep sdk",
    "ls docs && git grep -n x -- packages",
    "grep -rn -e 'a.*b' docs",
    "grep -rn 'a.*b' docs",
    "grep -rn -A3 -C 2 x --include='*.ts' .",
    "git grep -n -e x --cached -- packages",
    "find . -maxdepth 2 -type f -name '*.md' -print",
    "find . -name node_modules -prune -o -type f -print",
    "git ls-files --others --exclude-standard",
    "ls -laR docs",
  ])("%s", async (c) => {
    expect(await allowed(c)).toBe(true);
  });

  it("作業ツリーの配下に cd した先からも、中を探せる", async () => {
    expect(await allowed("grep -rn x ..", `${WT}/docs`)).toBe(true);
  });
});

describe("外・書き込み・コマンドの実行を伴うものは許さない", () => {
  it.each([
    "ls /",
    "ls ..",
    "ls ~",
    "grep -r token /home/u",
    "grep -r x ../b",
    "find / -name x",
    "find . -exec cat {} ;",
    "find . -delete",
    "find . -fprint out.txt",
    "grep --filter=sh x .",
    "grep --pager=less x .",
    "grep -Q x",
    "grep --save-config x",
    "git grep -O x",
    "git grep --open-files-in-pager=vi x",
    "git grep --textconv x",
    "git -C / grep x",
    "git -c core.pager=sh grep x",
    "ls out",
    "grep -r x out/passwd",
    "ls > list.txt",
    "ls $(echo /)",
    "ls &",
    "cd .. && ls",
    "ls && rm -rf x",
    "grep --file=/etc/passwd x .",
    // リンクをたどる旗（状態の置き場を指すリンクが作業ツリーの中にあっても読ませない）
    "grep -R token .",
    "grep -rnR token .",
    "grep --dereference-recursive token .",
    "grep -S token .",
    "find -L . -name token",
    "find . -follow -name token",
    "find -H st",
    "ls st",
    "grep -r x st",
    "grep -r x st/",
    "git grep x -- st",
    // 長いオプションの略・ugrep の設定
    "git grep --open=echo x",
    "git grep --open-files=vi x",
    "git grep --textc x",
    "grep --pag x .",
    "grep ---/tmp/cfg x .",
    "grep --- x .",
    // 短い旗に値をくっつけた形
    "grep -f/home/u/state/token x .",
    "grep -ftoken x .",
    "git grep -f/etc/x",
    "git ls-files -X/etc/passwd",
    "git ls-files -Xexclude",
    // 引用符の外のパターン・~（シェルが展開して、リンクの先を指しうる）
    "grep -r SECRET o?t/",
    "grep -r SECRET s[t]",
    "ls st/*",
    "ls *",
    "grep -r x {st,docs}",
    "find . -newer st/token",
  ])("%s", async (c) => {
    expect(await allowed(c)).toBe(false);
  });

  it("禁じる場所（state）は、作業ツリーの下にあっても拒否", async () => {
    const p2 = { ...prot, roots: [{ path: `${WT}/secret`, kind: "stateDir" as const }] };
    const r = await decideToolUse(scope, WT, "Bash", { command: "grep -r x secret" }, resolve, p2);
    expect(r.allow).toBe(false);
    const r2 = await decideToolUse(scope, WT, "Bash", { command: "grep -r x ." }, resolve, p2);
    expect(r2.allow).toBe(false);
  });

  it("作業ツリーの外からは使えない", async () => {
    expect(await isReadOnlySearch("ls", "/home/u", WT, resolve)).toBe(false);
  });
});

describe("子が持つ道具の許し（permissions.allow）", () => {
  it("Read・Grep・Glob は作業ツリーの中だけ。探すコマンドの Bash の規則は足さない（フックのない子で find -exec を通さない）", () => {
    const r = childAllowList({ ...scope, writableLocations: [] }, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.allow).toEqual(["Read(./**)", "Grep(./**)", "Glob(./**)"]);
    expect(r.value.allow.some((a) => a.startsWith("Bash("))).toBe(false);
  });
});

describe("#91 との組み合わせ: 探すコマンドの許しと、承認済みの拡張への明示の許可", () => {
  it("探すコマンドはフックが通すが、明示の許可は付かない。承認済みの完全一致の命令には付く", async () => {
    const approved = "git log --oneline -5";
    const effective: Scope = { ...scope, allowedCommands: [approved] };
    const permit = (command: string) =>
      grantedOnlyByExtension(scope, effective, "Bash", { command }, WT);
    for (const c of ["find . -name x", "grep -rn x .", "git ls-files docs .sdd", "ls -la"]) {
      expect(await allowed(c), c).toBe(true);
      expect(permit(c), c).toBe(false);
    }
    expect(
      (await decideToolUse(effective, WT, "Bash", { command: approved }, resolve, prot, WT)).allow,
    ).toBe(true);
    expect(permit(approved)).toBe(true);
    expect(permit(`${approved} -p`)).toBe(false);
  });
});

describe("isReadOnlySearch を直に（#92 の追記: cd・パイプの後ろ・リンク）", () => {
  // 作業ツリーの中を指すリンク `l -> a/b/c`、外を指すリンク `out -> /etc`
  const inLinks: Record<string, string> = { ...links, [`${WT}/l`]: `${WT}/a/b/c` };
  const res = async (p: string) => {
    const { posix } = await import("node:path");
    const r = posix.resolve(p);
    for (const [from, to] of Object.entries(inLinks)) {
      if (r === from || r.startsWith(`${from}/`)) return to + r.slice(from.length);
    }
    if (r.startsWith(`${WT}/out-missing`)) throw new Error("ENOENT");
    return r;
  };
  const direct = (c: string, cwd = WT) => isReadOnlySearch(c, cwd, WT, res, [S]);
  it.each([
    "cd src && ls",
    "cd l && ls",
    // ls の引数の `..` は、カーネルが実パスで解く（<wt>/a/b/c から 3 つ上は <wt>）。cd の `..` だけが字句
    "cd l && ls ../../..",
    "find src -type f | head -50",
    "find src | head -n 20",
    "grep -rln foo src | sort | uniq -c | wc -l",
    "ls src 2>/dev/null",
  ])("通す: %s", async (c) => {
    expect(await direct(c)).toBe(true);
  });
  it.each([
    // 絞るコマンドは位置の引数を取らない（uniq の出力のファイル・ほかのファイルを読む）
    "ls src | uniq - out.txt",
    "ls a | uniq a/x a/y",
    "ls a | head -c 5 a/x",
    "ls a | head -",
    "ls a | sort -o out",
    "ls a | tail -f",
    // 絞るコマンドは `|` の直後だけ
    "ls src ; head",
    "ls src && wc",
    "head -n 5",
    "ls src |& head",
    // cd は先頭の `&&` の前だけ・1 つだけ・行き先に `..` なし
    "cd l && cd ../../.. && ls",
    "cd l && ls ../../../..",
    "cd l/.. && ls",
    "cd src/../.. && ls",
    "cd src; ls",
    "cd src || ls",
    "ls && cd src && ls",
    // 途中に外へのリンクがあり、先がまだないパス
    "ls out/nope",
    "ls src;",
    "ls src &",
  ])("断る: %s", async (c) => {
    expect(await direct(c)).toBe(false);
  });
});
