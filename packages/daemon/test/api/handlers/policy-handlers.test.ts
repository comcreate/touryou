import {
  type EventBody,
  type Failure,
  failure,
  ok,
  type Result,
  ROLE_OPERATIONS,
  type Scope,
} from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createPolicyHandlers } from "../../../src/api/handlers/policy-handlers.js";
import { createScopeHandlers } from "../../../src/api/handlers/scope-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { type DaemonConfig, policyBaseOf } from "../../../src/config.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import { createPolicyHolder, policyProblemWith } from "../../../src/policy-holder.js";
import type { RuntimeAdapter } from "../../../src/sdk/runtime.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
let n = 0;
const ROOT_SCOPE: Scope = {
  writableLocations: ["src"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test"],
};
const CHILD: Scope = {
  writableLocations: ["src"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test"],
};

/** 設定（試験用の最小の形）。`DaemonConfig` の残りは、再起動が要る項目の比較にだけ使う。 */
const cfg = (over: Record<string, unknown> = {}): DaemonConfig =>
  ({
    stateDir: "/s",
    port: 1,
    rootScope: ROOT_SCOPE,
    permissions: { allow: [], deny: [], ask: [] },
    autoApprove: { allow: [] },
    ...over,
  }) as unknown as DaemonConfig;

const rig = (initial: DaemonConfig = cfg()) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  add({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } });
  add({
    type: "node.created",
    payload: {
      nodeId: "c",
      role: "implement",
      parentId: "root",
      dependsOn: [],
      objective: "o",
      acceptanceCriteria: ["c"],
      scope: CHILD,
    },
  });
  add({ type: "node.stateChanged", payload: { nodeId: "c", event: { type: "start" } } });

  const holder = createPolicyHolder(policyBaseOf(initial), () => log.state().policyRules);
  const box = { running: initial, next: ok(initial) as Result<DaemonConfig, Failure> };
  const updated: [string, Scope][] = [];
  const adapter = {
    kind: "cli" as const,
    send: async () => ok({ status: "queued" as const }),
    updateScope: (id: string, scope: Scope) => {
      updated.push([id, scope]);
      return ok(undefined);
    },
  } as unknown as RuntimeAdapter;
  const policy = createPolicyHandlers({
    log,
    clock,
    holder,
    loadConfig: () => box.next,
    runningConfig: () => box.running,
    onReloaded: (c) => {
      box.running = c;
    },
    cwdOf: async (id) => `/wt/${id}`,
  });
  const scope = createScopeHandlers({
    log,
    clock,
    adapterFor: () => adapter,
    cwdOf: async (id) => `/wt/${id}`,
    rootScope: () => holder.current().rootScope,
    denyRules: () => holder.current().policy.deny,
    limitRuleProblem: (rule) =>
      policyProblemWith(holder.base(), [...log.state().policyRules, { list: "allow", rule }]),
  });
  // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
  type Loose = { ok: boolean; value?: any; error?: Failure };
  const call = async (
    h: Record<string, unknown>,
    operation: string,
    role: string,
    params: Record<string, unknown>,
    caller?: string,
  ): Promise<Loose> =>
    (await (h[operation] as (r: unknown) => unknown)({
      requestId: `q-${++n}`,
      operation,
      role,
      ...(caller === undefined ? {} : { caller: { nodeId: caller } }),
      params,
    } as unknown as HandlerRequest<"policy.ruleChange">)) as Loose;
  return {
    log,
    holder,
    box,
    updated,
    s: () => log.state(),
    rule: (list: string, rule: string, op: "add" | "remove" = "add") =>
      call(policy, "policy.ruleChange", "human", { list, rule, op }),
    reload: () => call(policy, "config.reload", "human", {}),
    extend: (value: string, kind = "command") =>
      call(scope, "scope.extend", "child", { target: { kind, value }, reason: "r" }, "c"),
    decide: (params: Record<string, unknown>, role: "human" | "integrator" = "human") =>
      call(scope, "scope.decide", role, params, role === "human" ? undefined : "root"),
  };
};

describe("policy.ruleChange（実行中の規則の追加・取り消し）", () => {
  it("human だけが呼べる（root の統合ノード・子には公開しない）", () => {
    expect(ROLE_OPERATIONS.human).toContain("policy.ruleChange");
    expect(ROLE_OPERATIONS.human).toContain("config.reload");
    for (const role of ["integrator", "child"] as const) {
      expect(ROLE_OPERATIONS[role] as readonly string[]).not.toContain("policy.ruleChange");
      expect(ROLE_OPERATIONS[role] as readonly string[]).not.toContain("config.reload");
    }
  });

  it("畳み込みでも、人間以外の policy.ruleChanged は断る", () => {
    const r = rig();
    const res = r.log.append({
      requestId: "x-1",
      actor: { nodeId: "root" },
      body: {
        type: "policy.ruleChanged",
        payload: { list: "allow", rule: "Bash(git status:*)", op: "add" },
      },
    });
    expect(res.ok).toBe(false);
    expect(r.s().policyRules).toEqual([]);
  });

  it("deny を実行中の層に足せて、すぐ有効になる。記録と受信箱（info）に残り、取り消せる", async () => {
    const r = rig();
    const res = await r.rule("deny", "Bash(git push:*)");
    expect(res).toMatchObject({ ok: true, value: { changed: true } });
    expect(r.s().policyRules).toMatchObject([{ list: "deny", rule: "Bash(git push:*)" }]);
    expect(r.s().inbox.at(-1)).toMatchObject({ kind: "info", nodeId: "root" });
    expect(r.holder.current().policy.deny).toContain("Bash(git push:*)");
    // 同じ規則の足しは、何も書かない
    const seq = r.s().lastSeq;
    expect((await r.rule("deny", "Bash(git push:*)")).value).toEqual({ changed: false });
    expect(r.s().lastSeq).toBe(seq);
    // 取り消し
    expect((await r.rule("deny", "Bash(git push:*)", "remove")).value).toEqual({ changed: true });
    expect(r.s().policyRules).toEqual([]);
    expect(r.holder.current().policy.deny).not.toContain("Bash(git push:*)");
    // ない規則の取り外しは、何も書かない
    expect((await r.rule("deny", "Bash(git push:*)", "remove")).value).toEqual({ changed: false });
  });

  it("should 3: 受信箱には、長い規則の本文を出さない（抜粋も出さない）", async () => {
    const r = rig();
    const rule = `Bash(${"a".repeat(100)}:*)`;
    expect((await r.rule("deny", rule)).ok).toBe(true);
    const item = r.s().inbox.at(-1);
    expect(item?.summary).not.toContain("aaaa");
    expect(item?.summary).not.toContain(rule);
    expect(JSON.stringify(item?.msg)).not.toContain(rule);
    // 記録（規則そのもの）は、全文のまま
    expect(r.s().policyRules[0]?.rule).toBe(rule);
  });

  it("should 4: 設定ファイル由来の規則の取り外しは、changed: false ではなく、案内つきで断る", async () => {
    const r = rig(cfg({ permissions: { allow: [], deny: ["Bash(rm:*)"], ask: [] } }));
    const seq = r.s().lastSeq;
    const res = await r.rule("deny", "Bash(rm:*)", "remove");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("ruleFromConfig");
    expect(res.error?.nextActions.join(" ")).toContain("config reload");
    expect(r.s().lastSeq).toBe(seq);
    // どこにもない規則は、これまでどおり changed: false
    expect((await r.rule("deny", "Bash(ls:*)", "remove")).value).toEqual({ changed: false });
  });

  it("解析できない規則は断り、何も書かない", async () => {
    const r = rig();
    const seq = r.s().lastSeq;
    const res = await r.rule("allow", "Bash(");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalidRule");
    expect(r.s().lastSeq).toBe(seq);
  });
});

describe("config.reload（設定の読み直し）", () => {
  it("方針（permissions）を入れ替え、反映した項目の名前を返し、知らせを残す", async () => {
    const r = rig();
    r.box.next = ok(cfg({ permissions: { allow: [], deny: ["Bash(rm:*)"], ask: [] } }));
    const res = await r.reload();
    expect(res).toMatchObject({
      ok: true,
      value: { changed: ["permissions"], restartRequired: [], overLimit: [] },
    });
    expect(r.holder.current().policy.deny).toContain("Bash(rm:*)");
    expect(r.s().inbox.some((i) => i.kind === "info")).toBe(true);
  });

  it("再起動が要る項目（port など）は、名前を返して反映しない", async () => {
    const r = rig();
    r.box.next = ok(cfg({ port: 2, permissions: { allow: [], deny: ["Bash(rm:*)"], ask: [] } }));
    const res = await r.reload();
    expect(res.value.restartRequired).toEqual(["port"]);
    expect(res.value.changed).toEqual(["permissions"]);
    expect(r.box.running).toMatchObject({ port: 1 });
  });

  it("読めない・不正な設定は、今の方針のまま断り、失敗を受信箱に出す", async () => {
    const r = rig();
    r.box.next = { ok: false, error: failure("configInvalid", "壊れている", "直す") };
    const before = r.holder.current();
    const res = await r.reload();
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("configInvalid");
    expect(r.holder.current()).toBe(before);
    expect(r.s().inbox.at(-1)).toMatchObject({ kind: "failure" });
  });

  it("should 3: 失敗の文（応答・受信箱）に、設定ファイルのパスを出さない", async () => {
    const r = rig();
    r.box.next = {
      ok: false,
      error: failure(
        "configInvalid",
        "設定ファイル /Users/someone/.touryou/config.json を、他のユーザーが書き換えられる",
        "直す",
      ),
    };
    const res = await r.reload();
    expect(res.error?.cause).not.toContain("/Users/someone");
    const item = r.s().inbox.at(-1);
    expect(item?.summary).not.toContain("/Users/someone");
    expect(JSON.stringify(item?.msg)).not.toContain("/Users/someone");
    expect(res.error?.cause).toContain("他のユーザーが書き換えられる");
  });

  it("nit: 実行中に足した規則と合わせると検査を通らない設定は、入れ替えない", async () => {
    const r = rig();
    // 自動承認に入れられるのは、読み取り専用の表のコマンドだけ（git ls-files）
    expect((await r.rule("allow", "Bash(git ls-files:*)")).ok).toBe(true);
    expect((await r.rule("autoApprove", "Bash(git ls-files:*)")).ok).toBe(true);
    const before = r.holder.current();
    const baseBefore = r.holder.base();
    r.box.next = ok(cfg({ permissions: { allow: [], deny: ["Bash(git ls-files:*)"], ask: [] } }));
    const res = await r.reload();
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("configInvalid");
    expect(r.holder.base()).toBe(baseBefore);
    expect(r.holder.current()).toBe(before);
    expect(r.s().inbox.at(-1)).toMatchObject({ kind: "failure" });
  });

  it("新しい上限からはみ出す子は名前を返すが、子の範囲は縮めない", async () => {
    const r = rig();
    r.box.next = ok(cfg({ rootScope: { ...ROOT_SCOPE, allowedCommands: [] } }));
    const res = await r.reload();
    expect(res.value.overLimit).toEqual(["c"]);
    expect(r.updated).toEqual([]);
    expect(r.s().nodes.find((x) => x.id === "c")).toBeDefined();
  });
});

describe("should 1: 受信箱に規則の本文を出さない（種類と足した・外したの別だけ）", () => {
  const SECRET = "sk-secret-token-123";
  const noticeOf = (r: ReturnType<typeof rig>): string =>
    JSON.stringify(r.s().inbox.filter((i) => i.kind === "info"));

  it("policy.ruleChange: 足す・外すの知らせに、秘密を含む規則の本文が出ない（種類だけ出る）", async () => {
    const r = rig();
    const rule = `Bash(curl -H ${SECRET}:*)`;
    expect((await r.rule("deny", rule)).value).toEqual({ changed: true });
    expect(noticeOf(r)).not.toContain(SECRET);
    expect(noticeOf(r)).toContain("Bash");
    expect((await r.rule("deny", rule, "remove")).value).toEqual({ changed: true });
    expect(noticeOf(r)).not.toContain(SECRET);
    expect(noticeOf(r)).toContain("方針の規則を外した");
  });

  it("scope.decide の alsoLimit: 上限に足した知らせにも、依頼のコマンドの本文が出ない", async () => {
    const r = rig();
    const id = (await r.extend(`curl -H ${SECRET}`)).value.extensionId as string;
    const res = await r.decide({ extensionId: id, decision: "approve", alsoLimit: true });
    expect(res.ok).toBe(true);
    expect(noticeOf(r)).not.toContain(SECRET);
    expect(noticeOf(r)).toContain("方針の規則を足した");
  });
});

describe("scope.decide の alsoLimit（上限にも足して承認）", () => {
  it("上限にない子の依頼を、人間が alsoLimit で承認すると、規則も同じ記録で足される", async () => {
    const r = rig();
    const e = await r.extend("git status");
    const id = e.value.extensionId as string;
    // 足さずに承認すると、上限の外で断られる
    expect((await r.decide({ extensionId: id, decision: "approve" })).error?.code).toBe(
      "scopeNotSubset",
    );
    const res = await r.decide({ extensionId: id, decision: "approve", alsoLimit: true });
    expect(res.ok).toBe(true);
    expect(r.s().policyRules).toMatchObject([{ list: "allow", rule: "Bash(git status:*)" }]);
    expect(r.s().extensions[0]?.status).toBe("approved");
    expect(r.holder.current().rootScope.allowedCommands).toContain("git status");
  });

  it("統合ノードは alsoLimit を付けられない（forbidden。何も書かない）", async () => {
    const r = rig();
    const id = (await r.extend("git status")).value.extensionId as string;
    const seq = r.s().lastSeq;
    const res = await r.decide(
      { extensionId: id, decision: "approve", alsoLimit: true },
      "integrator",
    );
    expect(res.error?.code).toBe("forbidden");
    expect(r.s().lastSeq).toBe(seq);
  });

  it("should 1: 承認済みへの alsoLimit つきの再承認は、規則を足さず、limitAdded: false を返す", async () => {
    const r = rig();
    const id = (await r.extend("git status")).value.extensionId as string;
    const first = await r.decide({ extensionId: id, decision: "approve", alsoLimit: true });
    expect(first.value.limitAdded).toBe(true);
    const seq = r.s().lastSeq;
    const again = await r.decide({ extensionId: id, decision: "approve", alsoLimit: true });
    expect(again.ok).toBe(true);
    expect(again.value.limitAdded).toBe(false);
    expect(r.s().lastSeq).toBe(seq);
    // alsoLimit なしの再承認は、limitAdded を返さない
    expect((await r.decide({ extensionId: id, decision: "approve" })).value).not.toHaveProperty(
      "limitAdded",
    );
  });

  it("should 2: 長すぎる規則になる対象は、invalidTarget で断り、承認も記録しない", async () => {
    // 依頼が根の範囲に収まる（`git` の許可の前方一致）ので、要求の時点では断られない（#249）
    const r = rig(cfg({ rootScope: { ...ROOT_SCOPE, allowedCommands: ["pnpm test", "git"] } }));
    // 依頼の対象は 1024 字以内に収まるが、Bash(…:*) を付けた規則は 1024 字を超える
    const id = (await r.extend(`git ${"a".repeat(1015)}`)).value.extensionId as string;
    const seq = r.s().lastSeq;
    const res = await r.decide({ extensionId: id, decision: "approve", alsoLimit: true });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalidTarget");
    expect(r.s().lastSeq).toBe(seq);
    expect(r.s().extensions[0]?.status).toBe("open");
  });

  it("deny に当たる MCP ツールは、alsoLimit でも承認しない", async () => {
    const r = rig();
    // 要求のあとに deny を足す（先に足すと、要求の時点で scopeDenied で断られる。#249）
    const id = (await r.extend("mcp__chrome__navigate", "mcp")).value.extensionId as string;
    await r.rule("deny", "mcp__chrome__navigate");
    const res = await r.decide({ extensionId: id, decision: "approve", alsoLimit: true });
    expect(res.error?.code).toBe("scopeDenied");
    expect(r.s().policyRules.filter((x) => x.list === "allow")).toEqual([]);
  });
});
