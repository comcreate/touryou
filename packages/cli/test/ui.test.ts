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
