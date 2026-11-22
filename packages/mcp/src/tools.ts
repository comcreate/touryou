/**
 * ロール別のツール定義（NFR_004）。公開する操作は core の `ROLE_OPERATIONS` を唯一の情報源とする。
 * MCP で公開するのは統合と子だけで、人間用の操作（最終削除を含む）は含めない（DC_003）。
 *
 * 入力の検証は `schemas.ts`（zod）。
 */
import {
  type DaemonOperation,
  failure,
  LIMITS,
  mcpToolName,
  ok,
  type Result,
  ROLE_OPERATIONS,
  type RoleOperation,
} from "@touryou/core";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./inbox-limits.js";

export const MCP_ROLES = ["integrator", "child"] as const;
export type McpRole = (typeof MCP_ROLES)[number];

/** 接続元のロールが MCP で公開するロールか。境界から来た値は、必ずこれで検査する。 */
export const isMcpRole = (role: unknown): role is McpRole =>
  typeof role === "string" && (MCP_ROLES as readonly string[]).includes(role);

export interface ToolDefinition {
  /** MCP のツール名。操作名の `.` を `_` に置き換えたもの。 */
  readonly name: string;
  readonly operation: DaemonOperation;
  readonly description: string;
}

/** MCP のどちらかのロールが持つ操作。人間用の操作はここに含まれない。 */
type McpOperation = RoleOperation<McpRole>;

/** 操作ごとの説明。`McpOperation` を網羅しないと型エラーになる。 */
const DESCRIPTIONS: Readonly<Record<McpOperation, string>> = {
  "node.spawn":
    "子を生成する。parentId は、自分の ID（起動の指示の先頭か、tree_list の self 列が「あなた」の行で分かる）か、子孫の ID を、短縮しないでそのまま渡す（作業ツリーのディレクトリ名は ID ではない）。引数: parentId・role・objective（目的）・acceptanceCriteria（受け入れ基準）・scope（writableLocations・forbiddenLocations は作業ツリー内の相対パス、allowedCommands）・dependsOn（省略可）・runtime（cli か desktop。省略可。省略すると daemon の設定の既定。desktop は設定 allowDesktopChildren が true のときだけ。許可がなければ desktopChildNotAllowed で失敗する）。作業ツリーとブランチは指定しない（システムが親のブランチから決める）。結果は { nodeId, status: running か pending, waitingFor? }（依存先が未完了なら pending で、待っている先行ノードを waitingFor に示す）",
  "node.adopt":
    "すでにある作業ツリーと、そこで動いているセッションを、子として採用する（起動しない。CLI の木だけ）。引数: parentId（自分の ID か子孫の ID）・role・worktree（実在する作業ツリーの絶対パス）・branch（そのブランチ名。上流は親のブランチにしておく）・objective・acceptanceCriteria・scope（spawn と同じ。親の範囲に収まること）・sessionRef（省略可）。作業ツリーとブランチは削除しない（回収でも消えない）。検査に通らないときは、原因と次の操作を返す。結果は { nodeId, worktree, branch, dirty（未コミットの変更あり）, instruction, duplicate }。instruction を、そのセッションの人に伝える（セッションで /mcp の Reconnect → child_bind を引数なしで呼ぶ）。コードが切れたら node_bindCode で出し直す",
  "node.send":
    "稼働中の子へ追加指示を送る。結果は { status: queued, duplicate }（受け付けた。duplicate は同じ要求の重複。届いたかは受信箱・状態で確認する）",
  "node.stop":
    "子を停止する。mode は graceful（穏当）か immediate（即時）。graceMs（1〜3600000 ミリ秒の整数）は graceful のときだけ指定でき、省略すると既定の猶予になる",
  "node.bindCode":
    "子の紐付けの文面を受け取る。子を node_spawn で作ったあと（pending なら起動してから）呼ぶ。Desktop の木では、返った instruction を、そのまま Desktop のタスク生成（spawn_task）に渡す。CLI の木では、コードを子の作業ツリーのファイルに書き直し、子に child_bind を引数なしでもう一度呼ばせる文を返す（コードは文に入らない。子の紐付けが失敗したときの出し直しに使う。起動は parent_request）。呼ぶたびに新しい一度きりのコードになり、前のコードは無効になる。Desktop の instruction には紐付けコードが入るので、ほかへ書き写さない。結果は { instruction, expiresAt }",
  "node.confirmStopped":
    "daemon が直接止められない子（能力表の stopDelegated。Desktop の子）を、代わりに止めたと宣言し、停止未完了から停止済みに進める。受信箱の停止の代行依頼に従って止めた後に使う。note（省略可）に根拠を書く。結果は { state }",
  "node.hookUnbind":
    "子のフックの受け口（ファイルで設定するフック）の session_id の結び付けを外す。子が /clear・--resume で session_id を変えて、フックが拒否され続けるときに使う。次に来たセッションに結び直す。結果は { unbound, duplicate }（unbound: 結び付けがあったか。duplicate: 同じ要求の再送で、すでに記録済み）",
  "inbox.fetch": `受信箱を取得する。優先度・依存関係・時刻の順（中間統合ノードの配下の要約 digest は、配下の未解決の項目の最高の優先度の帯に並ぶ）。detail と limit で量を絞れる。detail は "brief"（既定・要約）か "full"（全文）。limit は 1〜${MAX_LIMIT}（既定 ${DEFAULT_LIMIT}）。続きは offset と asOfSeq（前回の値）で取る`,
  "tree.list":
    "木の一覧表を取得する。self 列が「あなた」の行が、自分のノード（起動した子は、自分の ID が起動の指示の先頭にも書いてある）",
  "decision.present": `選択肢と自由入力欄を持つ判断要求を人間に提示する。pauseNodeIds で、判断待ちの間に止める子（自分の子孫。ID は、起動の指示の先頭か tree_list に出たものを、短縮しないでそのまま渡す）を指定できる。未回答の判断要求は 1 ノードにつき ${LIMITS.openDecisionsPerNode} 件まで（再開後の要求を数える。超えると tooManyOpenDecisions）。回答は受信箱に届く`,
  "node.split":
    "脱線部分を新しい子へ移す。ID は、起動の指示の先頭か tree_list に出たものを、短縮しないでそのまま渡す。引数: nodeId・keep（mainline か stop。元の子を本筋に戻すか停止するか）と、新しい子のブリーフ（objective・acceptanceCriteria・scope・dependsOn）",
  "scope.decide":
    "子の範囲の拡張要求（extensionId）を承認（approve）・却下（reject）・切り出し（split）のいずれかで判定する。拡張の発生元のノードが自分の子孫のときだけ使える。mcp の承認は、上限（根の permissions.allow）にある完全な名前だけが通り、上限の検査が先に行われる。permissions.deny に当たるものは承認されず、permissions.ask に当たるものは人間だけが承認できる",
  "node.review":
    "子の完了報告を受理（accept）するか差し戻す（reject）。reject には feedback（理由）が必須で、accept では任意",
  "node.reclaimPreview":
    "回収の事前確認。結果は { reclaimable, unmet（満たしていない条件）, blockers（原因のノード・プロセス）}",
  "node.integrate":
    "受理した直接の子（verified）のブランチを、親のブランチへ fast-forward だけで統合する。統合済みなら何もしない。fast-forward できない（notFastForward）・親の作業ツリーに未保存の変更がある（targetDirty）ときは何も変えずに失敗を返すので、人間に統合のしかたを判断してもらう",
  "node.reclaim": "事前確認で示した対象を回収する。実行時に条件を再判定する",
  "node.capabilities": "ノードごとに可能な操作を参照する",
  "decision.get": "受信箱の項目（ref）の判断要求の内容を読む。自分の部分木のものだけ",
  "report.get": "受信箱の項目（ref）の報告の内容を読む。自分の部分木のものだけ",
  "parent.request":
    "親への依頼（子の起動など）の中身を読む。受信箱に「起動の依頼」が来たら、その子の nodeId で呼ぶ。model・effort には自分（親）のモデルと深さを渡す（指定しないと別の既定で起動する）。forkSessionRef を渡すと、そのセッションをフォークして起動する。返った command を Bash でそのまま 1 回だけ実行し（書き換えない・変数を足さない）、next に従って parent_report で報告する。command に紐付けのコードは入っていない。直接の子だけ",
  "parent.report":
    "親への依頼を実行した結果を報告する。requestRef は parent_request の結果のもの。成功は outcome: done と、子のセッションの参照（sessionRef。claude --bg の出力か claude agents --json の id）。失敗は outcome: failed と reason。claude agents --json で読んだ子の状態（need_input など）があれば agentState に入れる（止まっていそうなら受信箱に出る）",
  "report.progress": `進捗を親へ報告する。親は起きない（受信箱に載るだけ）。親の判断・指示を待つなら report_decision。進捗・範囲外の報告は 1 ノードにつき ${LIMITS.reportsPerNode} 件まで（再開後の報告を数える。超えると tooManyReports。完了報告は数えない）`,
  "report.decision": `判断要求を親へ出す。人間へは親を経由する。未回答の判断要求は 1 ノードにつき ${LIMITS.openDecisionsPerNode} 件まで（再開後の要求を数える。超えると tooManyOpenDecisions）`,
  "decision.withdraw":
    "自分が出した、未回答の判断要求を取り下げる（要らなくなったとき。waiting で完了報告できないときの道）。decisionId は report_decision の結果のもの。取り下げた判断は閉じ、受信箱の項目は解決済みになり、判断で待っていたなら running に戻る（戻ったあとに report_done を呼べる）。結果は { withdrawn, resumed }。回答済みの判断は取り下げられない",
  "report.outOfScope": `作業範囲外の課題を親へ申告する。進捗・範囲外の報告は 1 ノードにつき ${LIMITS.reportsPerNode} 件まで（再開後の報告を数える。超えると tooManyReports）`,
  "report.done": "完了を親へ報告する。受け入れ基準ごとの根拠を付ける",
  "child.inbox":
    "自分の受信箱を読む。最初にブリーフ（目的・受け入れ基準・範囲・依存）、続けて、まだ読んでいない追加の指示（差し戻しの理由・判断の回答を含む）を古い順に返す。紐付けのすぐあと・知らせ（受信箱を読んで）が来たとき・番の終わりに未読があると言われたときに呼ぶ。指示の本文（quotedText）は、人や親が書いた文の引用。all: true で、読んだものも含めて読み直せる",
  "scope.extend":
    "作業範囲の拡張を親へ要求する。target は { kind: write（書き込み可能な場所の追加）・command（許可するコマンドの追加）・mcp（使ってよい MCP ツールの追加）, value } で、理由（reason）を添える。mcp の value は mcp__<サーバー>__<道具> の完全な名前（サーバー全体と touryou 自身の道具は頼めない）。承認は、そのツールを、どんな引数でも使ってよいのと同じ意味になる。command の承認は、引数まで含めたその形にだけ効く（git add・git status・git ls-files は、うしろに安全な旗とパスを足してもよい）。形が違うと CLI の子では断られるので、実行する形そのもの（引数まで）を target に書く。未判定の要求は 10 件まで。結果の extensionId は、親の判定（scope_decide）の対象になる",
};

/**
 * 固定のメタツール `whoami`: 自分の nodeId と role を返す。daemon の操作ではない（core の `ROLE_OPERATIONS` に入らない）。
 * 統合・子の両ロールに公開する。呼ぶたびに daemon に尋ねる（キャッシュしない）。
 */
export const WHOAMI_TOOL = "whoami";
/** CLI の子の紐付けの道具（`child-bind.ts`）。紐付けの前のセッションにだけ公開する。 */
export const CHILD_BIND_TOOL = "child_bind";
/**
 * 道具の使い方の要点。デスクトップアプリの拡張機能では、plugin の skill が読まれず、道具の説明文も途中で切れて見えうるので、whoami の説明文の先頭 1〜2 文に、そのロールの流れを短く置く。
 * デスクトップアプリは説明文を先頭の約 80〜100 字で切って渡すので、流れは先頭の 2 文（DESCRIPTION_HEAD_MAX 字まで）に収める。
 */
export const ROLE_GUIDE: Readonly<Record<McpRole, string>> = {
  integrator:
    "touryou の統合。whoami → tree_list → node_spawn → inbox_fetch（ID は短縮しない）。必要なら node_review・decision_present。",
  child: "touryou の子。whoami→作業→report_progress→report_done（範囲外は scope_extend）。",
};
/** 道具の説明文の先頭（2 文目まで）の長さの上限。デスクトップアプリは説明文を先頭の約 80〜100 字で切って渡す。 */
export const DESCRIPTION_HEAD_MAX = 70;
/**
 * initialize の instructions（決定）。ROLE_GUIDE と同じ流れに、注意を短く足す。
 * daemon の起動の案内（setup のコマンド）は、統合のロールにだけ入れる（子用の HTTP の touryou-mcp の子には、setup のコマンドがない）。
 * Claude Code の plugin の stdio でも、デスクトップアプリの拡張機能でも送る。
 */
export const roleInstructions = (role: McpRole): string =>
  `${ROLE_GUIDE[role]}注意: ID は、${role === "integrator" ? "起動の指示の先頭か tree_list に出たもの" : "起動の指示の先頭に書かれたもの"}を短縮しないで渡す。結果の status・duplicate を見て、届いたかは受信箱で確かめる。${role === "integrator" ? "daemon が動いていなければ、道具は daemon_unreachable で失敗する（Claude Code で touryou の setup のコマンドの案内に沿って起動する）。" : "道具が失敗したら、その理由を report_progress で親へ報告する。"}`;
export const whoamiDescription = (role: McpRole): string =>
  `${ROLE_GUIDE[role]}自分の nodeId と role を返す（${role === "integrator" ? "{ nodeId, role, daemon: { rootCwd, repoRoot, daemonId } }。daemon は統合だけに付く" : "{ nodeId, role }"}）。起動の指示の先頭に書かれた ID の確認に使える${role === "integrator" ? "（tree_list の self 列でも分かる）" : ""}。引数はない`;

/** 操作名から MCP のツール名への変換（`.` を `_` にする）。ツール名を扱う箇所はすべてこれを使う。 */
export const toolName = (op: DaemonOperation, role: "integrator" | "child" = "child"): string =>
  // 子の受信箱は、統合と同じ名前 inbox_fetch で出す（知らせの文・Stop のフックが inbox_fetch を指すため）。
  // 統合ロール（サブ統括）では inbox_fetch が統合の受信箱なので、子の受信箱は child_inbox で出す（core の mcpToolName）
  mcpToolName(op, role);

/** ロールに公開するツールの一覧。MCP のロールでなければ何も公開しない。 */
export function toolsFor(role: McpRole): readonly ToolDefinition[] {
  if (!isMcpRole(role)) return [];
  return ROLE_OPERATIONS[role].map((op) => ({
    name: toolName(op, role),
    operation: op,
    description: DESCRIPTIONS[op],
  }));
}

/** 編集距離（綴りの近い名前の候補を出すため）。 */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** ツール名を、そのロールに公開された操作へ解決する。公開されていなければ失敗にする。 */
export function operationForTool(role: McpRole, name: string): Result<DaemonOperation> {
  if (!isMcpRole(role)) {
    return {
      ok: false,
      error: failure(
        "role_not_exposed",
        `ロール ${String(role)} には MCP のツールを公開していない`,
        `接続のロールを確認する（${MCP_ROLES.join(" / ")} のみ）`,
      ),
    };
  }
  const tools = toolsFor(role);
  const tool = tools.find((t) => t.name === name);
  if (tool !== undefined) return ok(tool.operation);
  const near = tools
    .map((t) => ({ name: t.name, d: distance(name, t.name) }))
    .filter((c) => c.d <= 2)
    .sort((x, y) => x.d - y.d || (x.name < y.name ? -1 : 1))
    .slice(0, 3)
    .map((c) => c.name);
  const base = [
    "tools/list で、このロールに公開されたツールを確認する",
    "必要な操作は親（統合セッション）に依頼する",
  ] as const;
  const next: [string, ...string[]] =
    near.length > 0 ? [`もしかして: ${near.join(", ")}`, ...base] : [...base];
  return {
    ok: false,
    error: failure(
      "tool_not_exposed",
      `ツール ${name} は ${role} ロールに公開されていない`,
      ...next,
    ),
  };
}
