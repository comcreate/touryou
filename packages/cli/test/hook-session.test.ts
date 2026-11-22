import { pluginToolName } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/hook.js";

/** `touryou hook` のトークンのない形（`claude --bg` の子。daemon が session_id で引く）。 */
const ENV = { HOME: "/h" };
const files: Record<string, string> = {
  "/h/.touryou/config.json": JSON.stringify({ stateDir: "/h/.touryou/state" }),
  "/h/.touryou/state/port": "4567\n",
};
const readFile = (p: string): string => {
  const v = files[p];
  if (v === undefined) throw new Error("ENOENT");
  return v;
};
const input = (event: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: event, session_id: "s-1", cwd: "/wt/a", ...extra });
const reply =
  (value: unknown, status = 200, seen: { url?: string; auth?: unknown }[] = []): typeof fetch =>
  async (url, init) => {
    seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.authorization });
    return new Response(JSON.stringify({ ok: true, value }), { status });
  };
const never: typeof fetch = async () => {
  throw new Error("呼ばれない");
};

describe("touryou hook（トークンなし）", () => {
  it("stateDir の port から窓口を作り、Authorization なしで送る", async () => {
    const seen: { url?: string; auth?: unknown }[] = [];
    const r = await runHook({
      env: ENV,
      input: input("PreToolUse", { tool_name: "Read", tool_input: {} }),
      readFile,
      fetchImpl: reply({ decision: "allow" }, 200, seen),
    });
    expect(r).toEqual({ code: 0, stderr: "" });
    expect(seen).toEqual([{ url: "http://127.0.0.1:4567/v1/hook", auth: undefined }]);
  });

  it("範囲外の拒否（deny）は、終了コード 2 と理由", async () => {
    const r = await runHook({
      env: ENV,
      input: input("PreToolUse", { tool_name: "Write", tool_input: {} }),
      readFile,
      fetchImpl: reply({ decision: "deny", reason: "範囲外" }),
    });
    expect(r).toEqual({ code: 2, stderr: "範囲外" });
  });

  it("紐付けの前（none）は、何も出さずに 0", async () => {
    for (const ev of ["PreToolUse", "Notification", "Stop", "SessionStart"]) {
      const r = await runHook({
        env: ENV,
        input: input(ev, { tool_name: "Read", notification_type: "idle_prompt" }),
        readFile,
        fetchImpl: reply({ decision: "none" }),
      });
      expect(r).toEqual({ code: 0, stderr: "" });
    }
  });

  it("daemon がない（設定・port がない、届かない、200 以外、形が違う）ときも、何も出さずに 0", async () => {
    const pre = input("PreToolUse", { tool_name: "Write" });
    expect(await runHook({ env: {}, input: pre, fetchImpl: never })).toEqual({
      code: 0,
      stderr: "",
    });
    expect(await runHook({ env: { HOME: "/x" }, input: pre, readFile, fetchImpl: never })).toEqual({
      code: 0,
      stderr: "",
    });
    const refused: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await runHook({ env: ENV, input: pre, readFile, fetchImpl: refused })).toEqual({
      code: 0,
      stderr: "",
    });
    expect(
      await runHook({
        env: ENV,
        input: pre,
        readFile,
        fetchImpl: reply({ decision: "deny" }, 500),
      }),
    ).toEqual({ code: 0, stderr: "" });
    const garbage: typeof fetch = async () => new Response("nope", { status: 200 });
    expect(await runHook({ env: ENV, input: pre, readFile, fetchImpl: garbage })).toEqual({
      code: 0,
      stderr: "",
    });
    expect(await runHook({ env: ENV, input: "{", readFile, fetchImpl: never })).toEqual({
      code: 0,
      stderr: "",
    });
  });

  it("Stop で未読があるとき（continue）は、標準出力に additionalContext を出し、終了コード 0", async () => {
    const r = await runHook({
      env: ENV,
      input: input("Stop", { stop_hook_active: false }),
      readFile,
      fetchImpl: reply({ decision: "continue", reason: "受信箱を読む" }),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout ?? "")).toEqual({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: "受信箱を読む" },
    });
  });

  it("Notification は、daemon の答えにかかわらず 0（止められないフック）", async () => {
    const r = await runHook({
      env: ENV,
      input: input("Notification", { notification_type: "permission_prompt", message: "m" }),
      readFile,
      fetchImpl: reply({ decision: "deny", reason: "x" }),
    });
    expect(r).toEqual({ code: 0, stderr: "" });
  });

  it("トークンつき（TOURYOU_NODE_TOKEN・TOURYOU_DAEMON_URL）の Stop でも、continue は標準出力に出す", async () => {
    const r = await runHook({
      env: { TOURYOU_NODE_TOKEN: "t".repeat(16), TOURYOU_DAEMON_URL: "http://127.0.0.1:1" },
      input: input("Stop"),
      fetchImpl: reply({ decision: "continue", reason: "読む" }),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("additionalContext");
  });
});

describe("touryou の子の作業ツリー（印あり）で daemon に届かないとき", () => {
  // 仮の印: git worktree の .git（ファイル）が指す git のディレクトリの直下の touryou-child
  const tree: Record<string, string> = {
    "/wt/a/.git": "gitdir: /repo/.git/worktrees/a\n",
    "/wt/b/.git": "gitdir: /repo/.git/worktrees/b\n",
  };
  const marks = new Set(["/repo/.git/worktrees/a/touryou-child"]);
  const read = (p: string): string => {
    const v = tree[p];
    if (v === undefined) throw new Error("ENOENT");
    return v;
  };
  const exists = (p: string) => marks.has(p) || p in tree;
  const refused: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const pre = (cwd: string) =>
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd, tool_name: "Bash" });

  it("isTouryouWorktree: 印のある作業ツリーの中（配下も）だけ真", async () => {
    const { isTouryouWorktree } = await import("../src/hook.js");
    expect(isTouryouWorktree("/wt/a", read, exists)).toBe(true);
    expect(isTouryouWorktree("/wt/a/src/deep", read, exists)).toBe(true);
    expect(isTouryouWorktree("/wt/b", read, exists)).toBe(false);
    expect(isTouryouWorktree("/elsewhere", read, exists)).toBe(false);
  });

  it("印あり: 届かない・窓口が分からない・500 なら、PreToolUse を拒否（2）", async () => {
    const both = (p: string) => (p in files ? readFile(p) : read(p));
    for (const [env, f] of [
      [ENV, refused],
      [{}, never],
      [ENV, reply({ decision: "allow" }, 500)],
    ] as const) {
      const r = await runHook({
        env,
        input: pre("/wt/a/src"),
        readFile: both,
        exists,
        fetchImpl: f,
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("touryou の子の作業ツリー");
    }
  });

  it("印あり でも、Notification・Stop は止めない（0）。印なしは、何も出さずに 0", async () => {
    const both = (p: string) => (p in files ? readFile(p) : read(p));
    const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "s", cwd: "/wt/a" });
    expect(
      await runHook({ env: ENV, input: stop, readFile: both, exists, fetchImpl: refused }),
    ).toEqual(SILENT0);
    expect(
      await runHook({ env: ENV, input: pre("/wt/b"), readFile: both, exists, fetchImpl: refused }),
    ).toEqual(SILENT0);
  });
});
const SILENT0 = { code: 0, stderr: "" };

describe("印の gitdir の解き方", () => {
  it("相対の gitdir は、.git のファイルの場所から解く", async () => {
    const { isTouryouWorktree } = await import("../src/hook.js");
    const read = (p: string) => {
      if (p === "/w/x/.git") return "gitdir: ../repo/.git/worktrees/x\n";
      throw new Error("ENOENT");
    };
    const exists = (p: string) => p === "/w/x/../repo/.git/worktrees/x/touryou-child";
    expect(isTouryouWorktree("/w/x/src", read, exists)).toBe(true);
  });
});

describe("印のある作業ツリーで daemon が none を返したとき", () => {
  const tree: Record<string, string> = {
    "/wt/a/.git": "gitdir: /repo/.git/worktrees/a\n",
    "/wt/b/.git": "gitdir: /repo/.git/worktrees/b\n",
  };
  const marks = new Set(["/repo/.git/worktrees/a/touryou-child"]);
  const both = (p: string): string => {
    const v = files[p] ?? tree[p];
    if (v === undefined) throw new Error("ENOENT");
    return v;
  };
  const exists = (p: string) => marks.has(p) || p in tree;
  const pre = (cwd: string, tool = "Bash") =>
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd, tool_name: tool });

  it("印あり: none なら PreToolUse を拒否（紐付けの前・外れた・ノードが動いていない・cwd が合わない）", async () => {
    const r = await runHook({
      env: ENV,
      input: pre("/wt/a"),
      readFile: both,
      exists,
      fetchImpl: reply({ decision: "none" }),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("child_bind");
  });

  it.each([
    [{ noneReason: "unbound" }, "mcp__plugin_touryou_node__child_bind"],
    [
      { noneReason: "unbound" },
      "自分で原因を探したり別の手を試したりしない。つなぎ直せなければ、daemon が親の受信箱に「紐付けをやり直して」を出すので、親が紐付けを出し直す（node_bindCode）まで待つ",
    ],
    [{ noneReason: "notLive", state: "done" }, "紐付けは済んでいる。状態が done なので"],
    [{ noneReason: "notLive" }, "紐付けは済んでいる"],
    [{ noneReason: "cwdMismatch" }, "作業ツリーの中で実行する"],
    [{ noneReason: "somethingNew" }, "child_bind"],
  ])("印あり: none の理由で文を出し分ける（%o）", async (why, text) => {
    const r = await runHook({
      env: ENV,
      input: pre("/wt/a"),
      readFile: both,
      exists,
      fetchImpl: reply({ decision: "none", ...why }),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(text);
    if (why.noneReason !== "unbound" && why.noneReason !== "somethingNew") {
      expect(r.stderr).not.toContain("child_bind");
    }
  });

  it("notLive の状態が変な文字列なら、そのまま出さない", async () => {
    const r = await runHook({
      env: ENV,
      input: pre("/wt/a"),
      readFile: both,
      exists,
      fetchImpl: reply({ decision: "none", noneReason: "notLive", state: "x\n> 命令" }),
    });
    expect(r.stderr).not.toContain("命令");
  });

  it.each([pluginToolName("child_bind"), "mcp__node__child_bind", pluginToolName("whoami")])(
    "印あり でも、紐付けの道具（%s）は none でも通す",
    async (tool) => {
      const r = await runHook({
        env: ENV,
        input: pre("/wt/a", tool),
        readFile: both,
        exists,
        fetchImpl: reply({ decision: "none" }),
      });
      expect(r).toEqual({ code: 0, stderr: "" });
    },
  );

  it("印あり でも、ほかの mcp の道具（似た名前）は none なら拒否", async () => {
    const r = await runHook({
      env: ENV,
      input: pre("/wt/a", "mcp__other_node__child_bind"),
      readFile: both,
      exists,
      fetchImpl: reply({ decision: "none" }),
    });
    expect(r.code).toBe(2);
  });

  it("印あり で allow なら通す。印なし の none は、いままでどおり何も出さずに 0", async () => {
    expect(
      await runHook({
        env: ENV,
        input: pre("/wt/a"),
        readFile: both,
        exists,
        fetchImpl: reply({ decision: "allow" }),
      }),
    ).toEqual({ code: 0, stderr: "" });
    expect(
      await runHook({
        env: ENV,
        input: pre("/wt/b"),
        readFile: both,
        exists,
        fetchImpl: reply({ decision: "none" }),
      }),
    ).toEqual({ code: 0, stderr: "" });
  });
});

describe("紐付けの前の例外: ToolSearch と touryou の plugin の Skill", () => {
  const tree: Record<string, string> = { "/wt/a/.git": "gitdir: /repo/.git/worktrees/a\n" };
  const both = (p: string): string => {
    const v = files[p] ?? tree[p];
    if (v === undefined) throw new Error("ENOENT");
    return v;
  };
  const exists = (p: string) => p === "/repo/.git/worktrees/a/touryou-child" || p in tree;
  const run = (tool: string, toolInput: unknown) =>
    runHook({
      env: ENV,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "s",
        cwd: "/wt/a",
        tool_name: tool,
        tool_input: toolInput,
      }),
      readFile: both,
      exists,
      fetchImpl: reply({ decision: "none" }),
    });

  it("ToolSearch は、紐付けの前でも通す", async () => {
    expect(await run("ToolSearch", { query: "child_bind" })).toEqual({ code: 0, stderr: "" });
  });

  it("touryou の plugin の skill は通す", async () => {
    expect(await run("Skill", { skill: "touryou:child" })).toEqual({
      code: 0,
      stderr: "",
    });
  });

  it.each([
    { skill: "other-plugin:child" },
    { skill: "child" },
    { skill: "touryou:" },
    { skill: "touryou-evil:child" },
    {},
  ])("ほかの skill（%j）は拒否", async (input) => {
    expect((await run("Skill", input)).code).toBe(2);
  });
});

describe("一時的な失敗の再試行（印のある作業ツリーの PreToolUse）", () => {
  const tree: Record<string, string> = { "/wt/a/.git": "gitdir: /repo/.git/worktrees/a\n" };
  const both = (p: string): string => {
    const v = files[p] ?? tree[p];
    if (v === undefined) throw new Error("ENOENT");
    return v;
  };
  const exists = (p: string) => p === "/repo/.git/worktrees/a/touryou-child" || p in tree;
  const pre = (cwd = "/wt/a") =>
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd, tool_name: "Bash" });
  const refused = async (): Promise<Response> => {
    throw new TypeError("fetch failed");
  };
  const timedOut = async (): Promise<Response> => {
    throw new DOMException("timeout", "TimeoutError");
  };
  /** 仮の時計: sleep と fetch の失敗で進む時間を数える。 */
  const clock = () => {
    const c = { t: 0, sleeps: [] as number[] };
    return {
      c,
      now: () => c.t,
      sleep: async (ms: number) => {
        c.sleeps.push(ms);
        c.t += ms;
      },
    };
  };
  const run = (fetchImpl: typeof fetch, k = clock(), read = both) =>
    runHook({
      env: ENV,
      input: pre(),
      readFile: read,
      exists,
      fetchImpl,
      now: k.now,
      sleep: k.sleep,
    });

  it("接続の失敗のあと成功したら、再試行で通る", async () => {
    let n = 0;
    const flaky: typeof fetch = async (u, i) => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      return reply({ decision: "allow" })(u, i);
    };
    const k = clock();
    expect(await run(flaky, k)).toEqual({ code: 0, stderr: "" });
    expect(n).toBe(2);
    expect(k.c.sleeps).toEqual([300]);
  });

  it("窓口が分からない失敗のあと成功したら、再試行で通る", async () => {
    let reads = 0;
    const flakyRead = (p: string): string => {
      if (p === "/h/.touryou/config.json" && ++reads === 1) throw new Error("EAGAIN");
      return both(p);
    };
    expect(await run(reply({ decision: "allow" }), clock(), flakyRead)).toEqual({
      code: 0,
      stderr: "",
    });
    expect(reads).toBe(2);
  });

  it("再試行しても届かないなら拒否のまま。試みは 2 回だけで、待ちの合計は上限内", async () => {
    let n = 0;
    const always: typeof fetch = async () => {
      n++;
      throw new TypeError("fetch failed");
    };
    const k = clock();
    const r = await run(always, k);
    expect(r.code).toBe(2);
    expect(n).toBe(2);
    // 最悪: 1 回目 8 秒（窓口 4 + fetch 4）+ 待ち + 2 回目の fetch（残りの予算）は、hooks.json の timeout 10 秒に収まる
    const worst = 4000 + 4000 + k.c.sleeps.reduce((a, b) => a + b, 0) + 500;
    expect(worst).toBeLessThanOrEqual(10_000 - 1000 + 500);
  });

  it("1 回目で予算を使い切ったときは、再試行しない（最悪時間を守る）", async () => {
    let n = 0;
    const slow: typeof fetch = async () => {
      n++;
      k.c.t += 4000;
      throw new DOMException("timeout", "TimeoutError");
    };
    const k = clock();
    k.c.t = 1500; // 窓口の確かめが遅かった想定
    const start = k.c.t;
    const r = await run(slow, k);
    expect(r.code).toBe(2);
    expect(n).toBe(1);
    expect(k.c.sleeps).toEqual([]);
    expect(k.c.t - start).toBeLessThanOrEqual(10_000);
  });

  it("daemon が応答して拒否したとき（200 以外）は、再試行しない", async () => {
    let n = 0;
    const denied: typeof fetch = async (u, i) => {
      n++;
      return reply({ decision: "allow" }, 500)(u, i);
    };
    const k = clock();
    const r = await run(denied, k);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("HTTP 500");
    expect(n).toBe(1);
    expect(k.c.sleeps).toEqual([]);
  });

  it("daemon が deny を返したときも、再試行しない", async () => {
    let n = 0;
    const deny: typeof fetch = async (u, i) => {
      n++;
      return reply({ decision: "deny", reason: "範囲外" })(u, i);
    };
    const r = await run(deny);
    expect(r).toEqual({ code: 2, stderr: "範囲外" });
    expect(n).toBe(1);
  });

  it("拒否の文は、原因（窓口・接続・時間切れ）ごとに分かれ、再試行の案内が出る", async () => {
    const noUrl = await run(refused, clock(), (p) => {
      if (p.startsWith("/h/")) throw new Error("ENOENT");
      return both(p);
    });
    const connect = await run(refused);
    const timeout = await run(timedOut);
    expect(noUrl.stderr).toContain("窓口が分からない");
    expect(connect.stderr).toContain("接続の失敗");
    expect(timeout.stderr).toContain("時間切れ");
    for (const r of [noUrl, connect, timeout]) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("数十秒あけて 1 回だけ再試行する");
      expect(r.stderr).toContain("report_progress");
    }
    expect(connect.stderr).not.toContain("時間切れ");
    expect(timeout.stderr).not.toContain("接続の失敗");
  });

  it("印のない作業ツリーでは、再試行せず、いままでどおり黙って通す", async () => {
    let n = 0;
    const counting: typeof fetch = async () => {
      n++;
      throw new TypeError("fetch failed");
    };
    const k = clock();
    const r = await runHook({
      env: ENV,
      input: pre("/wt/none"),
      readFile: both,
      exists,
      fetchImpl: counting,
      now: k.now,
      sleep: k.sleep,
    });
    expect(r).toEqual({ code: 0, stderr: "" });
    expect(n).toBe(1);
    expect(k.c.sleeps).toEqual([]);
  });
});

describe("承認済みの範囲の拡張（#91）", () => {
  const bash = input("PreToolUse", { tool_name: "Bash", tool_input: { command: "git ls-files" } });
  it("permit: extension の許可は、PreToolUse の明示の許可（permissionDecision: allow）を返す", async () => {
    const r = await runHook({
      env: ENV,
      input: bash,
      readFile,
      fetchImpl: reply({ decision: "allow", permit: "extension" }),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout ?? "")).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
  });
  it("permit: readOnlySearch（#92）の許可も、明示の許可を出す", async () => {
    const r = await runHook({
      env: ENV,
      input: bash,
      readFile,
      fetchImpl: reply({ decision: "allow", permit: "readOnlySearch" }),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout ?? "")).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
  });
  it("permit のないふつうの許可は、いままでどおり何も出さない（起動のときの許可の一覧に任せる）", async () => {
    const r = await runHook({
      env: ENV,
      input: bash,
      readFile,
      fetchImpl: reply({ decision: "allow" }),
    });
    expect(r).toEqual({ code: 0, stderr: "" });
  });
  it("拒否に permit が付いていても、拒否のまま", async () => {
    const r = await runHook({
      env: ENV,
      input: bash,
      readFile,
      fetchImpl: reply({ decision: "deny", reason: "範囲外", permit: "extension" }),
    });
    expect(r).toEqual({ code: 2, stderr: "範囲外" });
  });
});
