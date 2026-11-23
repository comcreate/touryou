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

describe("tail・head・wc・cat は、作業ツリーの中のファイルを読む形だけ許す（#194 PR5）", () => {
  it.each([
    "cat README.md",
    "cat docs/a.md docs/b.md",
    "cat -- README.md",
    "head README.md",
    "head -n 20 README.md",
    "head -n20 README.md",
    "head -20 README.md",
    "head -c 100 README.md",
    "head -q a.md b.md",
    "tail README.md",
    "tail -n 50 docs/a.md",
    "tail -n50 docs/a.md",
    "tail -5 docs/a.md",
    "tail -c 100 docs/a.md",
    "wc README.md",
    "wc -l README.md",
    "wc -c README.md",
    "wc -lw docs/a.md docs/b.md",
    "ls docs && cat docs/a.md",
    "cat docs/a.md | head -n 5",
    "tail -n 50 docs/a.md | wc -l",
    "grep -rn x docs | head -20",
  ])("許す: %s", async (c) => {
    expect(await allowed(c)).toBe(true);
  });

  it.each([
    // 長く居座る・未知の旗・長いオプション
    "tail -f docs/a.md",
    "tail -F docs/a.md",
    "tail --follow docs/a.md",
    "tail --follow=name docs/a.md",
    "tail -n 5 -f docs/a.md",
    "tail -nf docs/a.md",
    "tail -n +5 docs/a.md",
    "tail --pid=1 docs/a.md",
    "tail -s 1 docs/a.md",
    "head -n -5 docs/a.md",
    "head -n x docs/a.md",
    "head -n",
    "head --lines=5 docs/a.md",
    "head -z docs/a.md",
    "wc -L docs/a.md",
    "wc --files0-from=list docs/a.md",
    "wc --total=only docs/a.md",
    "cat -n docs/a.md",
    "cat -A docs/a.md",
    "cat --number docs/a.md",
    // 作業ツリーの外・リンクの脱出・禁じる場所
    "cat /etc/passwd",
    "cat ../b/secret",
    "cat ~/.ssh/id_rsa",
    "tail -n 5 /home/u/state/token",
    "head -n 5 out/passwd",
    "wc -l out/passwd",
    "cat st/token",
    "cat docs/a.md /etc/passwd",
    "cat -- /etc/passwd",
    "cat docs/../../b/x",
    "cat *",
    "cat docs/*.md",
    "cat ~",
    "cat {a,b}",
    // 標準入力（ファイルなし・-）
    "cat",
    "head",
    "tail",
    "wc",
    "head -n 5",
    "wc -l",
    "cat -",
    "tail -n 5 -",
    "cat --",
    // パイプの直後でファイルを読む・パイプの先頭が絞るだけの形でない・複合・リダイレクト
    "ls | cat docs/a.md",
    "ls | head docs/a.md",
    "ls | tail -n 5 docs/a.md",
    "ls | wc -l docs/a.md",
    "head -n 5",
    "cat docs/a.md > out.txt",
    "cat docs/a.md >> docs/b.md",
    "cat < docs/a.md",
    "cat docs/a.md; rm x",
    "cat docs/a.md && rm x",
    "cat docs/a.md &",
    "cat $(echo /etc/passwd)",
    "cat `echo /etc/passwd`",
    "cat docs/a.md | sh",
    "cat docs/a.md | tee x",
    "ls | sort docs/a.md",
    "sort docs/a.md",
    "uniq docs/a.md",
    "cd .. && cat a.md",
  ])("許さない: %s", async (c) => {
    expect(await allowed(c)).toBe(false);
  });

  it("禁じる場所（state）が作業ツリーの下にあれば、ファイルを読む形も拒否", async () => {
    const p2 = { ...prot, roots: [{ path: `${WT}/secret`, kind: "stateDir" as const }] };
    for (const command of ["cat secret/token", "tail -n 5 secret/token", "cat README.md"]) {
      const r = await decideToolUse(scope, WT, "Bash", { command }, resolve, p2);
      expect(r.allow).toBe(false);
    }
  });

  // 禁じる場所の守りは、find・grep と同じく、フックの protectedPaths（checkProtected。stateDir・.git の置き場など）と、
  // read-only-search の protectedRoots（作業ツリーと重なれば全体を断る）が担う。ここでは、その経路がファイルを読む形にも効くことを確かめる
  it(".git の置き場が作業ツリーの下にあれば、ファイルを読む形も拒否", async () => {
    const p2 = { ...prot, roots: [{ path: `${WT}/.git`, kind: "stateDir" as const }] };
    for (const command of ["cat .git/config", "head -n 5 .git/HEAD", "wc -l .git/index"]) {
      const r = await decideToolUse(scope, WT, "Bash", { command }, resolve, p2, WT);
      expect(r.allow, command).toBe(false);
    }
  });

  it("cd した先からの相対パスも読める（cd は先頭の && の前だけ）", async () => {
    const direct = (c: string) => isReadOnlySearch(c, WT, WT, resolve, [S]);
    expect(await direct("cd docs && tail -n 5 a.md")).toBe(true);
    expect(await direct("cd docs && cat ../../b/x")).toBe(false);
    expect(await direct("cd docs; cat a.md")).toBe(false);
  });

  it("作業ツリーの外からは使えない", async () => {
    expect(await isReadOnlySearch("cat README.md", "/home/u", WT, resolve)).toBe(false);
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
  // 作業ツリーの中を指すリンク `l -> a/b/c`、外を指すリンク `out -> /etc`・`x -> /outside/out/deep`。
  // カーネルと同じに、語を前から 1 つずつたどり、たどった先がリンクならすぐ解く（`x/..` は `/outside/out`）
  const inLinks: Record<string, string> = {
    ...links,
    [`${WT}/l`]: `${WT}/a/b/c`,
    [`${WT}/x`]: "/outside/out/deep",
  };
  const res = async (p: string) => {
    let cur = "";
    for (const c of p.split("/")) {
      if (c === "" || c === ".") continue;
      if (c === "..") {
        cur = cur.slice(0, Math.max(0, cur.lastIndexOf("/")));
        continue;
      }
      cur = `${cur}/${c}`;
      for (let n = 0; inLinks[cur] !== undefined && n < 8; n++) cur = inLinks[cur] as string;
    }
    return cur === "" ? "/" : cur;
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
    // 外へのリンクの `..`（カーネルは x を先に解くので、外の /outside/out に着く）
    "ls x/..",
    "grep -r foo x/..",
    "find x/.. -name a",
    "cd a && ls ../x/..",
    "ls x/../..",
    "ls src;",
    "ls src &",
  ])("断る: %s", async (c) => {
    expect(await direct(c)).toBe(false);
  });
});
