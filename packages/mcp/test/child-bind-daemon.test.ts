import { describe, expect, it } from "vitest";
import { parseCodeFile } from "../src/bind-code-file.js";
import { bindChild } from "../src/child-bind.js";

// 紐付けのコードを書いた daemon と、接続先の daemon の突き合わせ（#167）と、失敗の理由の区別。
const TOKEN = "t".repeat(43);
const CODE = "0123456789ABCDEFGHJKMNPQRS";
const DAEMON_A = "a".repeat(32);
const DAEMON_B = "b".repeat(32);

/** 接続先の daemon（公開 ID `daemonId`）。送られた本文を記録し、その daemon の ID を応答のヘッダに付ける。 */
const daemon = (daemonId: string, reply: () => Response, seen: unknown[] = []) => ({
  seen,
  verifier: { verify: async () => ({ ok: true as const, daemonId }) },
  fetch: (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    const res = reply();
    res.headers.set("x-touryou-daemon-id", daemonId);
    return res;
  }) as unknown as typeof fetch,
});
const okReply = () =>
  new Response(JSON.stringify({ ok: true, value: { nodeId: "a", token: TOKEN } }));
const errorReply = (code: string) => () =>
  new Response(JSON.stringify({ ok: false, error: { code } }), { status: 401 });

const bind = (d: ReturnType<typeof daemon>, codeDaemonId?: string) =>
  bindChild(
    {
      daemonUrl: "http://127.0.0.1:7777",
      fetch: d.fetch,
      verifier: d.verifier,
      cwd: () => "/w/a",
      ...(codeDaemonId === undefined ? {} : { codeDaemonId }),
    },
    "a",
    CODE,
  );

describe("コードのファイルの中身（古い形も読める）", () => {
  it("古い形（コードだけ）は daemonId なし", () => {
    expect(parseCodeFile(`${CODE}\n`)).toEqual({ code: CODE });
    expect(parseCodeFile(CODE)).toEqual({ code: CODE });
  });

  it("新しい形（2 行目に daemon=<ID>）は daemonId つき。知らない行・形の違う行は無視する", () => {
    expect(parseCodeFile(`${CODE}\ndaemon=${DAEMON_A}\n`)).toEqual({
      code: CODE,
      daemonId: DAEMON_A,
    });
    expect(parseCodeFile(`${CODE}\r\nfuture=1\r\ndaemon=${DAEMON_A}\r\n`)).toEqual({
      code: CODE,
      daemonId: DAEMON_A,
    });
    expect(parseCodeFile(`${CODE}\ndaemon=XYZ\n`)).toEqual({ code: CODE });
  });
});

describe("コードを書いた daemon にだけ bind する", () => {
  it("2 つの daemon を並べても、書いた daemon にだけ送り、もう一方には送らない", async () => {
    const a = daemon(DAEMON_A, okReply);
    const b = daemon(DAEMON_B, errorReply("unauthenticated"));
    // コードは daemon A が書いた
    const toB = await bind(b, DAEMON_A);
    expect(toB.ok).toBe(false);
    expect(b.seen).toEqual([]);
    const toA = await bind(a, DAEMON_A);
    expect(toA).toEqual({ ok: true, value: { nodeId: "a", token: TOKEN } });
    expect(a.seen).toHaveLength(1);
  });

  it("接続先違いは、別の daemon のコードと分かる失敗（bind_daemon_mismatch）。コードは含まない", async () => {
    const b = daemon(DAEMON_B, okReply);
    const r = await bind(b, DAEMON_A);
    expect(r.ok ? "" : r.error.code).toBe("bind_daemon_mismatch");
    expect(r.ok ? "" : r.error.cause).toContain("別の daemon");
    expect(JSON.stringify(r)).not.toContain(CODE);
    expect(b.seen).toEqual([]);
  });

  it("古い形のファイル（daemonId なし）は、突き合わせずに今までどおり送る", async () => {
    const b = daemon(DAEMON_B, okReply);
    expect((await bind(b)).ok).toBe(true);
    expect(b.seen).toHaveLength(1);
  });
});

describe("daemon の失敗の理由を区別して返す", () => {
  const reasons: [string, string][] = [
    ["bindCodeExpired", "bind_code_expired"],
    ["bindCodeUsed", "bind_code_used"],
    ["bindWorktreeMismatch", "bind_worktree_mismatch"],
    ["unauthenticated", "bind_failed"],
  ];
  for (const [daemonCode, code] of reasons) {
    it(`${daemonCode} は ${code}`, async () => {
      const r = await bind(daemon(DAEMON_A, errorReply(daemonCode)), DAEMON_A);
      expect(r.ok ? "" : r.error.code).toBe(code);
      expect(JSON.stringify(r)).not.toContain(CODE);
    });
  }
});
