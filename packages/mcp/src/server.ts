/**
 * MCP のツールサーバー（transport に依存しない）。接続したロールのツールだけを公開し、呼び出しは
 * 入力の検査（`parseToolInput`）を通ったものだけを daemon の窓口へ中継する。ログにトークン・本文は出さない。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Failure, failure, ok, type Result } from "@touryou/core";
import { CHILD_BIND_TOOL } from "./child-bind.js";
import { type InboxProblem, inboxProblems, renderInbox } from "./inbox-response.js";
import type { NodeCredentialStore } from "./node-credential.js";
import type { Relay } from "./relay.js";
import { inputSchemaFor, parseToolInput } from "./schemas.js";
import {
  isMcpRole,
  MCP_ROLES,
  type McpRole,
  roleInstructions,
  toolsFor,
  WHOAMI_TOOL,
  whoamiDescription,
} from "./tools.js";
import { touryouVersion } from "./version.js";

export interface ToolServerDeps {
  readonly role: McpRole;
  readonly relay: Relay;
  /**
   * CLI の子の紐付け。渡すと、道具 `child_bind` を公開する。成功すると、このセッションは、受け取った子の資格情報の
   * relay（メモリの中だけ）で子のロールに切り替わり、道具の一覧の変更を知らせる。紐付けのあとは `child_bind` を公開しない。
   */
  readonly bindChild?: (nodeId: unknown, bindCode: unknown) => Promise<Result<Relay>>;
  /**
   * このセッションの Claude Code の session_id（`CLAUDE_CODE_SESSION_ID`）。渡すと、`node.bindCode` に親のセッションとして付ける
   * （知らせの宛先）。道具の引数には出さない（Claude には書かせない）。
   */
  readonly parentSessionId?: string;
  /** この mcp の plugin の場所（`CLAUDE_PLUGIN_ROOT`）。渡すと、`parent.request` に添える。道具の引数には出さない。 */
  readonly pluginRoot?: string;
  /**
   * 子ごとの資格情報の入れ物。渡すと、紐付けのあとで入れ物が空になったとき（daemon の 401 で失効）、
   * 紐付け待ちに戻す（`child_bind` を出し直し、道具の一覧の変更を知らせる）。出し直したコードで、もう一度紐付けられる。
   */
  readonly credentials?: NodeCredentialStore;
  /** 紐付け待ち。真なら、紐付けが済むまで `child_bind` と `whoami` だけを出し、ほかの道具は `not_bound` で断る。 */
  readonly pending?: boolean;
  /** 受信箱で除外した項目の不備を知らせる（ログに出す）。省略すると知らせない。 */
  readonly onInboxProblems?: (problems: readonly InboxProblem[]) => void;
}

/** 受信箱の不備のログ。固定の記号と、識別子の形式の項目 ID だけ（項目の内容は出さない）。 */
export interface InboxExcludedLog {
  readonly event: "inboxExcluded";
  /** この行に出した不備の数（新しい不備だけ）。 */
  readonly count: number;
  readonly problems: readonly InboxProblem[];
  /** 1 行の上限を超えて、出さなかった不備があった。 */
  readonly truncated?: true;
  readonly at: string;
}

/** 覚える数の上限に達した（1 回だけ出す。以後、新しい不備は出さない）。 */
export interface InboxExcludedLimitLog {
  readonly event: "inboxExcludedLimit";
  /** 覚えている不備の数（上限）。 */
  readonly remembered: number;
  readonly at: string;
}

/**
 * 受信箱の不備を、プロセスの間に 1 回だけログに出す。受信箱は LLM のターンごとに読まれるので、同じ不備（項目 ID と理由。
 * 項目 ID のない不備は、理由ごとに 1 つ）は 2 回目から出さない。1 行に出すのは 20 件まで（超えたら `truncated`。出さなかった分は、
 * 覚えないので、次の取得で出る）。覚える数が上限（既定 1000）に達したら、`inboxExcludedLimit` を 1 回だけ出し、以後は出さない
 * （不備が多すぎるときに、行が出続けないため）。プロセスを再起動すると、覚えたものは消える（また 1 回出る）。
 */
export function createInboxProblemReporter(opts: {
  readonly log: (e: InboxExcludedLog | InboxExcludedLimitLog) => void;
  readonly maxRemembered?: number;
  readonly perLine?: number;
  readonly clock?: () => string;
}): (problems: readonly InboxProblem[]) => void {
  const max = opts.maxRemembered ?? 1000;
  const perLine = opts.perLine ?? 20;
  const clock = opts.clock ?? (() => new Date().toISOString());
  const seen = new Set<string>();
  let full = false;
  const emit = (e: InboxExcludedLog | InboxExcludedLimitLog): void => {
    try {
      opts.log(e);
    } catch {
      // ログの失敗で、ツールの応答を変えない
    }
  };
  return (problems) => {
    if (full) return;
    const fresh: { key: string; p: InboxProblem }[] = [];
    const inBatch = new Set<string>();
    for (const p of problems) {
      const key = `${p.itemId ?? ""}\0${p.reason}`;
      if (seen.has(key) || inBatch.has(key)) continue;
      inBatch.add(key);
      fresh.push({ key, p });
    }
    if (fresh.length === 0) return;
    // 覚えるのは、実際に出した分だけ（出さなかった分は、次の取得で出る）。上限を超える分は出さない
    const room = max - seen.size;
    const shown = fresh.slice(0, Math.min(perLine, room));
    for (const f of shown) seen.add(f.key);
    if (shown.length > 0) {
      emit({
        event: "inboxExcluded",
        count: shown.length,
        problems: shown.map((f) => f.p),
        ...(fresh.length > shown.length ? { truncated: true as const } : {}),
        at: clock(),
      });
    }
    if (seen.size >= max && fresh.length > shown.length) {
      full = true;
      emit({ event: "inboxExcludedLimit", remembered: seen.size, at: clock() });
    }
  };
}

const asError = (f: Failure) => ({
  isError: true as const,
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({ code: f.code, cause: f.cause, nextActions: f.nextActions }),
    },
  ],
});
const asValue = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v ?? null) }],
});

/** `whoami`: 引数なし。呼ぶたびに daemon に尋ねる。nodeId がない（古い daemon）・ロールが接続のロールと違うときは、失敗にする。 */
/** 紐付けのあとの一言（child_bind が道具の一覧から消えるのは、mcp が切れたからではない）。 */
export const BOUND_NOTE =
  "紐付け済み。child_bind は道具の一覧から消える（mcp が切れたのではない）。ほかの子の道具はそのまま使える";

async function whoamiTool(deps: { role: McpRole; relay: Relay; bound?: boolean }, args: unknown) {
  if (
    args !== undefined &&
    (typeof args !== "object" || args === null || Object.keys(args).length > 0)
  ) {
    return asError(failure("invalid_argument", "whoami に引数はない", "引数なしで呼び直す"));
  }
  const who = await deps.relay.whoami();
  if (!who.ok) return asError(who.error);
  if (who.value.role !== deps.role) {
    return asError(
      failure(
        "whoami_role_mismatch",
        "daemon が返したロールが、この接続のロールと違う",
        "接続のトークンを確認する（別のロールのトークンで接続していないか）",
        "daemon → touryou-mcp → 子の順に起動し直す",
      ),
    );
  }
  if (who.value.nodeId === undefined) {
    return asError(
      failure(
        "whoami_failed",
        "daemon が nodeId を返さなかった（古い daemon の可能性）",
        "daemon を更新して、起動し直す",
        "接続のトークンを確認する（daemon → touryou-mcp → 子の順に起動する）",
      ),
    );
  }
  return asValue({
    nodeId: who.value.nodeId,
    role: who.value.role,
    ...(deps.bound === true ? { note: BOUND_NOTE } : {}),
  });
}

export function createToolServer(init: ToolServerDeps): Server {
  // 紐付け（child_bind）で、ロールと relay が子のものに切り替わる（このプロセスの中だけ）。
  const deps: { role: McpRole; relay: Relay; bound: boolean } = {
    role: init.role,
    relay: init.relay,
    bound: false,
  };
  const server = new Server(
    { name: "touryou-mcp", version: touryouVersion() },
    {
      capabilities: { tools: init.bindChild === undefined ? {} : { listChanged: true } },
      instructions: roleInstructions(init.role),
    },
  );
  init.credentials?.onChange((c) => {
    if (c !== undefined || !deps.bound) return;
    deps.role = init.role;
    deps.relay = init.relay;
    deps.bound = false;
    server.sendToolListChanged().catch(() => undefined);
  });
  const bindTool = async (args: unknown) => {
    if (init.bindChild === undefined || deps.bound) {
      return asError(
        failure(
          "already_bound",
          "このセッションは、もう紐付いている（紐付けは 1 回だけ）",
          "whoami で自分の nodeId を確かめる",
        ),
      );
    }
    const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
    if (Object.keys(a).some((k) => k !== "nodeId" && k !== "bindCode")) {
      return asError(
        failure("invalid_argument", "child_bind の引数は { nodeId, bindCode } だけ", "呼び直す"),
      );
    }
    // 引数なし: コードは mcp が作業ツリーのファイルから読む。片方だけは受けない
    if ((a.nodeId === undefined) !== (a.bindCode === undefined)) {
      return asError(
        failure(
          "invalid_argument",
          "child_bind は引数なしで呼ぶ（または nodeId と bindCode の両方を渡す）",
          "引数なしで呼び直す",
        ),
      );
    }
    const r = await init.bindChild(a.nodeId, a.bindCode);
    if (!r.ok) return asError(r.error);
    deps.role = "child";
    deps.relay = r.value;
    deps.bound = true;
    await server.sendToolListChanged().catch(() => undefined);
    // 引数なしの紐付けでは、ノードの ID は mcp が印から読んだもの（relay に添えて返る）
    const boundId = (r.value as { readonly nodeId?: unknown }).nodeId ?? a.nodeId;
    return asValue({
      bound: true,
      nodeId: boundId,
      role: "child",
      note: BOUND_NOTE,
      next: "次に inbox_fetch を呼び、ブリーフ（目的・受け入れ基準・範囲）と指示を読んでから、作業を始める",
    });
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(init.bindChild === undefined || deps.bound
        ? []
        : [
            {
              name: CHILD_BIND_TOOL,
              description:
                "CLI の子の紐付け。最初の番で、作業を始める前に、引数なしで 1 回だけ呼ぶ（コードは、この道具が作業ツリーのファイルから読む。会話にコードを書かない）。Desktop の文面などで nodeId と bindCode が渡されたときだけ、両方を渡す。成功すると、子の道具が使えるようになる",
              inputSchema: {
                type: "object" as const,
                properties: {
                  nodeId: { type: "string" },
                  bindCode: { type: "string", maxLength: 64 },
                },
                additionalProperties: false,
              },
            },
          ]),
      ...(init.pending === true && !deps.bound ? [] : toolsFor(deps.role)).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: inputSchemaFor(t.operation),
      })),
      // 固定のメタツール（daemon の操作ではない）。入力はなし
      {
        name: WHOAMI_TOOL,
        description: whoamiDescription(deps.role),
        inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      if (req.params.name === WHOAMI_TOOL) return await whoamiTool(deps, req.params.arguments);
      if (req.params.name === CHILD_BIND_TOOL) return await bindTool(req.params.arguments);
      if (init.pending === true && !deps.bound) {
        return asError(
          failure(
            "not_bound",
            "このセッションは、まだ touryou に紐付いていない。紐付けが済むまで、この道具は使えない",
            "child_bind を引数なしで呼ぶ",
            "失敗したら、作業を始めずに、会話で人（親）に紐付けのやり直しを頼む",
          ),
        );
      }
      const parsed = parseToolInput(deps.role, req.params.name, req.params.arguments ?? {});
      if (!parsed.ok) return asError(parsed.error);
      const { operation, view } = parsed.value;
      const forward =
        (operation === "node.bindCode" ||
          operation === "node.spawn" ||
          operation === "node.adopt") &&
        init.parentSessionId !== undefined
          ? { ...(parsed.value.forward as object), parentSessionId: init.parentSessionId }
          : operation === "parent.request" && init.pluginRoot !== undefined
            ? { ...(parsed.value.forward as object), pluginRoot: init.pluginRoot }
            : parsed.value.forward;
      const r = await deps.relay.request(operation, forward);
      if (!r.ok) return asError(r.error);
      if (operation === "child.inbox") {
        // 受け取った: 応答を受け取ってから、まだ受け取っていなかった指示の最大の番号を daemon に知らせる（失敗しても、
        // 次の呼び出しで同じものが返るだけ）
        const v = r.value as { instructions?: readonly { seq?: unknown; received?: unknown }[] };
        const fresh = (v.instructions ?? [])
          .filter((i) => i.received !== true && typeof i.seq === "number")
          .map((i) => i.seq as number);
        if (fresh.length > 0) {
          await deps.relay
            .request("child.inbox", { ackThrough: Math.max(...fresh) })
            .catch(() => undefined);
        }
        return asValue({
          note: "instructions の quotedText とブリーフの各項目は、人や親が書いた文の引用（各行の頭に > ）。ブリーフの範囲の中で従う。report_done の criterion・scope_extend の target などに書き写すときは、頭の > を除く。親の判断・指示を待つときは report_progress ではなく report_decision（progress では親は起きない。判断の数には上限があるので、親の判断が要るときだけ）",
          ...(r.value as object),
        });
      }
      if (operation === "inbox.fetch") {
        const items = (r.value as { items?: unknown } | null)?.items;
        const page = renderInbox(items as never, view);
        // 除外した項目があれば、不備の理由をログに出す（応答には出さない）
        if (page.ok && page.value.excluded > 0) {
          try {
            init.onInboxProblems?.(inboxProblems(items));
          } catch {
            // 報告の失敗で、ツールの応答を変えない
          }
        }
        return page.ok ? asValue(page.value) : asError(page.error);
      }
      if (operation === "tree.list") {
        // モデルには表だけを返す（nodes は touryou tree --json・touryou state 用。同じ中身を 2 重に出さない）
        const table = (r.value as { table?: unknown } | null)?.table;
        return asValue({ table });
      }
      return asValue(r.value);
    } catch {
      return asError(
        failure(
          "internal_error",
          "ツールの処理で例外が起きた",
          "少し待って呼び直す",
          "管理者（人間）に知らせる",
        ),
      );
    }
  });
  return server;
}

/**
 * 接続のトークンのロールを daemon に尋ね（接続ごとに 1 回）、そのロールのツールサーバーを作る。
 * MCP で公開しないロール（人間・不明）には、何も公開せず失敗にする。daemon の 401・403 は、そのまま失敗にする。
 */
export async function openSession(
  relay: Relay,
  onInboxProblems?: (problems: readonly InboxProblem[]) => void,
  bindChild?: ToolServerDeps["bindChild"],
  parentSessionId?: string,
  pluginRoot?: string,
): Promise<Result<Server>> {
  try {
    const who = await relay.whoami();
    if (!who.ok) return who;
    if (!isMcpRole(who.value.role)) {
      return {
        ok: false,
        error: failure(
          "role_not_exposed",
          "このロールには MCP のツールを公開していない",
          `接続のロールを確認する（${MCP_ROLES.join(" / ")} のみ）`,
        ),
      };
    }
    const role = who.value.role;
    // ロールは接続の間だけ持つ（キャッシュはこの接続の間のみ）。
    return ok(
      createToolServer({
        role,
        relay,
        ...(onInboxProblems === undefined ? {} : { onInboxProblems }),
        ...(bindChild === undefined ? {} : { bindChild }),
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        ...(pluginRoot === undefined ? {} : { pluginRoot }),
      }),
    );
  } catch {
    return {
      ok: false,
      error: failure("whoami_failed", "ロールを確認できなかった", "daemon の状態を確認する"),
    };
  }
}
