import { describe, expect, it } from "vitest";
import { runBin } from "../src/bin.js";
import type { UiDeps } from "../src/ui.js";

const TOKEN = "human-token-human-token-human-token-1234";
const TICKET = "T".repeat(43);
const DAEMON_ID = "00112233445566778899aabbccddeeff";
const TTY = { stdin: false, stdout: false };

const files = (over: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    "/home/u/.touryou/config.json": JSON.stringify({ stateDir: "/state" }),
    "/state/port": "43210\n",
    "/state/human-token": `${TOKEN}\n`,
    ...over,
  };
  return (p: string) => {
    const v = base[p];
    if (v === undefined) throw new Error("missing");
    return v;
  };
};

const verifier =
  (result: "ok" | "identity" | "transient" = "ok"): NonNullable<UiDeps["verifierFor"]> =>
  () => ({
    verify: async () =>
      result === "ok"
        ? { ok: true, daemonId: DAEMON_ID }
        : {
            ok: false,
            kind: result,
            failure: { code: "x", cause: "x", nextActions: [] } as never,
          },
  });

const ticketFetch = (status = 200, id = DAEMON_ID) => {
  const seen: { url: string; auth: string | null }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ ok: true, value: { ticket: TICKET } }), {
      status,
      headers: { "x-touryou-daemon-id": id },
    });
  }) as typeof fetch;
  return { f, seen };
};

const run = async (opts: {
  read?: (p: string) => string;
  verify?: "ok" | "identity" | "transient";
  fetch?: typeof fetch;
  open?: boolean;
}) => {
  const opened: string[] = [];
  const r = await runBin(["ui"], {
    env: { HOME: "/home/u" },
    isTTY: TTY,
    fetch: opts.fetch ?? ticketFetch().f,
    ui: {
      readFile: opts.read ?? files(),
      verifierFor: verifier(opts.verify),
      openUrl: (url) => {
        opened.push(url);
        return opts.open ?? true;
      },
    },
  });
  return { r, opened, all: r.stdout + r.stderr };
};

describe("touryou ui", () => {
  it("human-token でチケットをもらい、#ticket= の URL を開く。トークン・チケットを出さない", async () => {
    const { f, seen } = ticketFetch();
    const { r, opened, all } = await run({ fetch: f });
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual([{ url: "http://127.0.0.1:43210/v1/ui/ticket", auth: `Bearer ${TOKEN}` }]);
    expect(opened).toEqual([`http://127.0.0.1:43210/ui#ticket=${TICKET}`]);
    expect(opened[0]).not.toContain(TOKEN);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(TICKET);
    expect(all).not.toContain("http://");
  });

  it("身元が合わないときは、トークンを送らずに止まる", async () => {
    const { f, seen } = ticketFetch();
    const { r, opened, all } = await run({ fetch: f, verify: "identity" });
    expect(r.exitCode).toBe(1);
    expect(seen).toEqual([]);
    expect(opened).toEqual([]);
    expect(all).toContain("身元");
  });

  it("daemon に届かないときは、トークンを送らずに止まる", async () => {
    const { f, seen } = ticketFetch();
    const { r, all } = await run({ fetch: f, verify: "transient" });
    expect(r.exitCode).toBe(1);
    expect(seen).toEqual([]);
    expect(all).toContain("届かない");
  });

  it("応答した daemon が、確かめた daemon と違えば開かない", async () => {
    const { r, opened } = await run({ fetch: ticketFetch(200, "ff".repeat(16)).f });
    expect(r.exitCode).toBe(1);
    expect(opened).toEqual([]);
  });

  it("ブラウザを開けないときは、URL・チケットを出さずに、Mac のターミナルでの実行を案内する", async () => {
    const { r, all } = await run({ open: false });
    expect(r.exitCode).toBe(1);
    expect(all).toContain(
      'Mac のターミナルで "$HOME/.touryou/current/bin/touryou" ui を実行してください',
    );
    expect(all).not.toContain(TICKET);
    expect(all).not.toContain("#ticket");
  });

  it("port・human-token・設定がないときは、原因と次の操作を出して止まる", async () => {
    for (const [over, word] of [
      [{ "/state/port": undefined }, "ポート"],
      [{ "/state/human-token": undefined }, "human-token"],
      [{ "/home/u/.touryou/config.json": undefined }, "設定ファイル"],
    ] as const) {
      const { r, all, opened } = await run({ read: files(over) });
      expect(r.exitCode).toBe(1);
      expect(all).toContain(word);
      expect(all).toContain("次の操作");
      expect(opened).toEqual([]);
    }
  });

  it("daemon がチケットを断ったら開かない。引数は受け取らない", async () => {
    const { r, opened } = await run({ fetch: ticketFetch(403).f });
    expect(r.exitCode).toBe(1);
    expect(opened).toEqual([]);
    const r2 = await runBin(["ui", "x"], { env: { HOME: "/home/u" }, isTTY: TTY });
    expect(r2.exitCode).toBe(2);
  });
});

// 複数の daemon（設定ごと。#165）。別名の設定は、launchd の plist（--config）から見つける
describe("touryou ui（複数の daemon）", () => {
  const OTHER = "/work/b/.touryou-config.json";
  const PLIST = "touryou.daemon-0123abcd.plist";
  const multi = (over: Record<string, string | undefined> = {}) =>
    files({
      "/home/u/.touryou/config.json": JSON.stringify({ stateDir: "/state", repoRoot: "/work/a" }),
      [`/home/u/.touryou/launchd/${PLIST}`]: `<array>\n<string>x</string>\n<string>--config</string>\n<string>${OTHER}</string>\n</array>`,
      [OTHER]: JSON.stringify({ stateDir: "/state-b", repoRoot: "/work/b" }),
      "/state-b/port": "43211\n",
      "/state-b/human-token": `${TOKEN}\n`,
      ...over,
    });

  const go = async (args: string[], env: Record<string, string>, cwd: string) => {
    const { f, seen } = ticketFetch();
    const opened: string[] = [];
    const r = await runBin(["ui", ...args], {
      env: { HOME: "/home/u", ...env },
      cwd,
      isTTY: TTY,
      fetch: f,
      ui: {
        readFile: multi(),
        readDir: () => [PLIST, "touryou.daemon.plist", "other.txt"],
        verifierFor: verifier(),
        openUrl: (u) => {
          opened.push(u);
          return true;
        },
      },
    });
    return { r, seen, opened };
  };

  it("実行したリポジトリの root に合う daemon を、既定にする", async () => {
    const b = await go([], {}, "/work/b/packages/x");
    expect(b.r.exitCode).toBe(0);
    expect(b.opened).toEqual([`http://127.0.0.1:43211/ui#ticket=${TICKET}`]);
    const a = await go([], {}, "/work/a");
    expect(a.opened).toEqual([`http://127.0.0.1:43210/ui#ticket=${TICKET}`]);
  });

  it("どの root にも合わないときは、既定の設定にする", async () => {
    const r = await go([], {}, "/elsewhere");
    expect(r.opened).toEqual([`http://127.0.0.1:43210/ui#ticket=${TICKET}`]);
  });

  it("--config と TOURYOU_DAEMON_CONFIG は、実行場所より先に効く", async () => {
    const byArg = await go(["--config", OTHER], {}, "/work/a");
    expect(byArg.opened).toEqual([`http://127.0.0.1:43211/ui#ticket=${TICKET}`]);
    const byEnv = await go([], { TOURYOU_DAEMON_CONFIG: OTHER }, "/work/a");
    expect(byEnv.opened).toEqual([`http://127.0.0.1:43211/ui#ticket=${TICKET}`]);
  });

  it("--list は、選べる設定を出す（トークン・ポートは出さない）", async () => {
    const r = await go(["--list"], {}, "/work/a");
    expect(r.r.exitCode).toBe(0);
    expect(r.r.stdout).toContain("/home/u/.touryou/config.json（repoRoot: /work/a）");
    expect(r.r.stdout).toContain(`${OTHER}（repoRoot: /work/b）`);
    expect(r.r.stdout).not.toContain(TOKEN);
    expect(r.opened).toEqual([]);
    expect(r.seen).toEqual([]);
  });

  it("--config に相対パスは渡せない", async () => {
    const r = await go(["--config", "rel.json"], {}, "/work/a");
    expect(r.r.exitCode).toBe(2);
  });
});
