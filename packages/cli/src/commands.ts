/**
 * 人間用コマンド（FR_029, FR_031, NFR_006, NFR_010）。入出力は持たず、終了コードと
 * 標準出力・標準エラーの文字列を返す。窓口は `DaemonClient` で受ける。
 *
 *   touryou purge <nodeId> [--dry-run] [--yes --expect <digest>] [--tombstone|--no-tombstone] [--request-id <id>]
 *   touryou reclaim <nodeId> [--yes --expect <digest>] [--request-id <id>]
 *   touryou purge-hold <nodeId> [--until <ISO 8601 UTC> | --days <1〜365>] [--reason <文>] [--request-id <id>]
 *   touryou purge-release <nodeId> [--request-id <id>]
 *   touryou confirm-stopped <nodeId> [--note <根拠>] [--request-id <id>]
 *   touryou accept <nodeId> [--request-id <id>]
 *   touryou hook-unbind <nodeId> [--request-id <id>]
 *   eval "$(touryou hook-env <nodeId>)"
 *   touryou inbox [--detail] [--limit <1〜100>] [--offset <n>] [--since <seq>] [--request-id <id>]
 *   touryou discarded list
 *   touryou discarded restore <nodeId|key> [--branch <名前>] [--request-id <id>]
 *   touryou discarded drop <nodeId|key> [--yes] [--request-id <id>]
 *
 * 結果が確認できないとき（接続不可・不正な応答）は、同じ requestId で再実行できる（冪等、NFR_003）。
 */
import {
  ANSWER_DELIVERABLE_STATES,
  type DaemonRequest,
  DEFAULT_PURGE_TOMBSTONE,
  type Failure,
  INBOX_KINDS,
  type InboxItem,
  isBoundedText,
  isFailure,
  isSafeId,
  LIMITS,
  PRIORITIES,
  priorityOf,
  sortInbox,
} from "@touryou/core";
import type { DaemonClient, HumanOperation } from "./client.js";

export interface CommandDeps {
  readonly client: DaemonClient;
  /** 要求の識別子（冪等性）。時刻・乱数を持たないよう、呼び出し側が渡す。 */
  readonly newRequestId: () => string;
  /**
   * 端末に繋がっているか（bin が `process.stdin.isTTY`・`process.stdout.isTTY` を必ず渡す）。省略すると、どちらも false として
   * 扱う（`hook-env` だけは、省略時もトークンを出さない）。
   */
  readonly isTTY?: { readonly stdin: boolean; readonly stdout: boolean };
}

export interface CommandResult {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly stdout: string;
  readonly stderr: string;
}

const USAGE = `使い方:
  touryou purge <nodeId> [--dry-run] [--yes --expect <digest>] [--tombstone | --no-tombstone] [--request-id <id>]
      アーカイブ済みの木を最終削除する（取り消せない）。
      --dry-run  削除される木・アーカイブ日・経過日数・照合の値を表示するだけで、削除しない
      --yes      対象を表示したうえで削除を実行する（なければ対象の表示だけで止まる）。--expect が要る
      --expect <digest>  表示した、削除される木の照合用の値（表示に出る 12 桁の 16 進）。実行の時点の木から計算し直した値と違えば、何も削除しない
      --tombstone / --no-tombstone  削除後に墓標を残す／残さない（省略時は保持ポリシーの既定）
  touryou reclaim <nodeId> [--yes --expect <digest>] [--request-id <id>]
      停止したノードの成果を破棄して、回収する（取り消せない）。破棄の判断を記録し、そのあと、統合ノードの回収が、
      作業ツリーとブランチを強制して消す。
      まず、失われるもの（統合されていないコミット・未保存の変更・未追跡のファイル）を表示する。
      --yes      破棄を指示する（なければ、表示だけで止まる）。--expect が要る
      --expect <digest>  表示した先端の照合用の値（表示に出る 12 桁の 16 進）。指示の時点の先端から計算し直した値と違えば、何も指示しない
  touryou purge-hold <nodeId> [--until <日時> | --days <日数>] [--reason <理由>] [--request-id <id>]
      自動の最終削除（autoPurge）を、この木について保留する。nodeId は、予告に出ている木の根（アーカイブ済みで、親がアーカイブされていないノード）。
      有効な予告は、その場で取り下げる。人間の touryou purge は、保留に関係なく実行できる（保留を無視したことは監査に残る）。
      --until   保留の期限（ISO 8601 UTC。例: 2026-12-01T00:00:00Z。現在より後、365 日先まで）。省略すると無期限
      --days    保留の日数（1〜365 の整数。いまから数える。--until とは同時に指定できない。期限は daemon の時計で計算し、365 日のときは 1 秒短くなる。実際の期限は、結果に出る）
      --reason  理由（200 文字まで）
  touryou purge-release <nodeId> [--request-id <id>]
      保留を解除する。解除のあとは、予告から出し直し、そこから noticeDays 日たつまで消えない
  touryou confirm-stopped <nodeId> [--note <根拠>] [--request-id <id>]
      daemon が直接止められないノード（Desktop の子。受信箱に停止の代行依頼が出ている）を、親が Desktop で止めた
      （またはアーカイブした）あとに、止めたと宣言する（取り消せない）。停止未完了から停止済みに進み、宣言した者（人間）と根拠が記録に残る。
      --note  根拠（200 文字まで。例: 「Desktop でアーカイブした」）
  touryou accept <nodeId> [--request-id <id>]
      完了報告済み（done）の子を、人間が受理する（done → verified。取り消せない）。確認のために作った子の片付けに使う。
      受理すると、子のトークン・フック専用のトークンが失効し、Desktop の子の引き出しが消える。そのあとは touryou reclaim で回収できる。
      差し戻しは、親の統合ノードだけができる。done 以外の子は invalidTransition（受理できない）
  touryou hook-unbind <nodeId> [--request-id <id>]
      子のフック（plugin のファイルで設定するフック）の session_id の結び付けを外す。/clear・--resume で session_id が変わって、
      フックが拒否され続けるときに使う。次に来たセッションに結び直す。外した者（人間）が記録に残る。
      トークンが漏れた疑いがあるときは、外さずに、子を止めてトークンを失効させる
  eval "$(touryou hook-env <nodeId>)"
      手動の CLI セッション用に、その子のフック専用のトークンを発行し、環境変数 TOURYOU_DAEMON_URL・TOURYOU_NODE_TOKEN を設定する
      （eval で使うときだけ。標準出力が端末なら、トークンを出さずに失敗する）。そのあと、子の作業ツリーで plugin つきの claude を起動する。
      発行し直すと、古いフック用トークンは無効になり、フックの結び付けも外れる。CLI の子（childRuntime: cli）の、動作中の子だけ
  touryou tree [<nodeId>] [--json]
      木のノードを一覧で表示する（読み取りだけ。tree.list の人間版）。ID・役割・状態・親・依存・未解決の数を表で出す。
      <nodeId> を付けると、そのノード 1 つの詳しい状態を出す。--json で機械可読の JSON。
  touryou state <nodeId> [--json]
      1 つのノードの詳しい状態を表示する（touryou tree <nodeId> と同じ。読み取りだけ）。
  touryou decisions [--json]
      未解決の判断要求の一覧を表示する（読み取りだけ）。答えるには touryou answer <decisionId>。--json で JSON。
  touryou answer <decisionId> [(--text <文> | --choice <選択肢>) --yes --expect <digest>] [--request-id <id>]
      判断要求に答える（decision.answer の人間版）。--yes がなければ、判断の中身（ノード・子の状態・問い・選択肢）を表示するだけで答えない。
      --text    自由記述で答える（選択肢のない判断、または選択肢以外で答えるとき）
      --choice  選択肢で答える（表示に出た選択肢の文を、そのまま渡す）。--text とは同時に指定できない
      --yes     表示を確認したうえで答える（なければ、表示だけで止まる）。--expect が要る
      --expect <digest>  表示した判断の照合用の値（表示に出る 12 桁の 16 進）。答える時点の中身から計算し直した値と違えば、答えない
      子が waiting・running でなければ（止まった子など）、答えは子に届かない（記録は残る）。表示に、そう出る
  touryou inbox [--detail] [--limit <件数>] [--offset <位置>] [--since <seq>] [--request-id <id>]
      受信箱の未解決の項目を、全ノード分、優先度順（要判断 > 失敗 > 完了 > 進捗 > 情報。同じ優先度は時刻順）に表示する（読み取りだけ）。
      --detail   種類・ノード・時刻・参照・seq まで表示する（省略時は、優先度・種類・ノード・要約）
      --limit    1 回に出す件数（1〜100。既定 20）
      --offset   整列後の先頭からの位置（既定 0）。続きは、末尾に出る案内のとおり（取得のたびに数え直す近似。新しい項目の取りこぼしを避けるには --since）
      --since    この seq より後の項目だけ（差分。既定 0）
  touryou discarded list
      強制の回収で破棄した成果の保管（refs/touryou/discarded/*）の一覧: 名前・ノード・先端の SHA・日時・件名（コミットメッセージ由来の、信頼できない入力）。孤立（ノードがもうない）も出る。
      保管は、最終削除（touryou purge）のときに、その木のノードの分が消える。数の上限（daemon の設定 discardedRefsMax）に達すると、強制の回収は失敗する
  touryou discarded restore <nodeId|key> [--branch <名前>] [--request-id <id>]
      保管している先端から、新しいブランチを作る（作成だけ。既存のブランチは上書きしない。保管は残る）。既定の名前は touryou/restored/<key>
  touryou discarded drop <nodeId|key> [--yes] [--request-id <id>]
      保管を 1 件消す（取り消せない）。--yes がなければ、対象の表示だけで止まる
  touryou launchd init [--org <組織の逆ドメイン。省略で Label は touryou.daemon>] [--path-prefix <ディレクトリ>]
      daemon・touryou-mcp を launchd で常駐させる起動スクリプトと plist を、$HOME/.touryou の下に生成する（窓口・トークンは不要。launchctl は実行しない。
      トークンの値は、生成も表示もしない）。詳しくは docs/launchd.md
  touryou launchd apply --yes | status | restart | stop | uninstall --yes  [--org …]
      launchd の常駐の操作（launchctl を実行する。apply・uninstall は、利用者の同意を取ってから --yes）。詳しくは docs/launchd.md
  --request-id <id>  結果が確認できなかった要求を、同じ識別子で再実行する
  touryou ui
      状態画面を、既定のブラウザで開く（macOS）。人間のトークンのファイルを自分で読み、使い捨てのチケット（60 秒・1 回だけ）にして開く。
      トークン・チケット・URL は出さない。環境変数の TOURYOU_HUMAN_TOKEN は要らない。詳しくは docs/ui.md
  -h, --help         この使い方を表示する（終了コード 0）
終了コード: 0 成功 / 1 失敗・結果が確認できない / 2 引数の誤り`;

const ALLOWED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  purge: ["--dry-run", "--yes", "--expect", "--tombstone", "--no-tombstone"],
  reclaim: ["--yes", "--expect"],
  "purge-hold": ["--until", "--days", "--reason"],
  "purge-release": [],
  "confirm-stopped": ["--note"],
  accept: [],
  "hook-unbind": [],
  "hook-env": [],
  inbox: ["--detail", "--limit", "--offset", "--since"],
  tree: ["--json"],
  state: ["--json"],
  decisions: ["--json"],
  answer: ["--text", "--choice", "--yes", "--expect"],
  "discarded-list": [],
  "discarded-restore": ["--branch"],
  "discarded-drop": ["--yes"],
};
/** 値を取るオプション。 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--until",
  "--days",
  "--reason",
  "--branch",
  "--expect",
  "--note",
  "--limit",
  "--offset",
  "--since",
  "--text",
  "--choice",
]);

export function formatFailure(f: Failure): string {
  return `失敗 [${f.code}]: ${f.cause}\n次の操作:\n${f.nextActions.map((a) => `  - ${a}`).join("\n")}\n`;
}

const usageError = (cause: string): CommandResult => ({
  exitCode: 2,
  stdout: "",
  stderr: `${cause}\n${USAGE}\n`,
});

const failed = (f: Failure): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: formatFailure(f),
});

type Outcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failure"; readonly failure: Failure }
  | { readonly kind: "unconfirmed"; readonly reason: string };

type Req<Op extends HumanOperation> = Extract<DaemonRequest<"human">, { operation: Op }>;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const isStringArray = (x: unknown): x is readonly string[] =>
  Array.isArray(x) && x.every((s) => typeof s === "string");

/** 窓口を呼び、例外・不正な応答は「結果が確認できない」として返す。 */
async function invoke<Op extends HumanOperation, T>(
  client: DaemonClient,
  requestId: string,
  operation: Op,
  params: Req<Op>["params"],
  validate: (value: unknown) => value is T,
): Promise<Outcome<T>> {
  let res: unknown;
  try {
    res = await client.call({ requestId, role: "human", operation, params } as Req<Op>);
  } catch (e) {
    return { kind: "unconfirmed", reason: e instanceof Error ? e.message : String(e) };
  }
  if (!isRecord(res) || typeof res.ok !== "boolean") {
    return { kind: "unconfirmed", reason: "応答の形が不正" };
  }
  if (!res.ok) {
    return isFailure(res.error)
      ? { kind: "failure", failure: res.error }
      : { kind: "unconfirmed", reason: "失敗の形が不正" };
  }
  return validate(res.value)
    ? { kind: "ok", value: res.value }
    : { kind: "unconfirmed", reason: "結果の形が不正" };
}

interface Preview {
  readonly nodeIds: readonly string[];
  readonly archivedAt: string;
  readonly elapsedDays: number;
  readonly retentionDays: number;
  readonly tombstoneTitle: string;
  readonly purgeable: boolean;
  readonly blockers: readonly { readonly code: string; readonly cause: string }[];
  /** 自動の最終削除の保留（有効なもの）。 */
  readonly hold?: { readonly until?: string; readonly reason?: string };
  /** 最終削除で一緒に消える、保管している破棄した成果の数。 */
  readonly discardedRefs?: number;
}
const isPreview = (v: unknown): v is Preview =>
  isRecord(v) &&
  isStringArray(v.nodeIds) &&
  typeof v.archivedAt === "string" &&
  typeof v.elapsedDays === "number" &&
  typeof v.retentionDays === "number" &&
  typeof v.tombstoneTitle === "string" &&
  typeof v.purgeable === "boolean" &&
  Array.isArray(v.blockers) &&
  v.blockers.every(
    (b) => isRecord(b) && typeof b.code === "string" && typeof b.cause === "string",
  ) &&
  (v.discardedRefs === undefined ||
    (typeof v.discardedRefs === "number" &&
      Number.isInteger(v.discardedRefs) &&
      v.discardedRefs >= 0)) &&
  (v.hold === undefined ||
    (isRecord(v.hold) &&
      (v.hold.until === undefined || typeof v.hold.until === "string") &&
      (v.hold.reason === undefined || typeof v.hold.reason === "string")));
interface LossView {
  readonly nodeId: string;
  readonly aheadCommits?: number;
  readonly untrustedSubjects: readonly string[];
  readonly uncommitted: boolean;
  readonly untracked: number;
  readonly workingTreeUnknown?: true;
  readonly unknown?: true;
}
interface ReclaimPreview {
  readonly reclaimable: boolean;
  readonly unmet: readonly string[];
  /** 失われるもの。daemon が対応していなければ、なし（不明）。 */
  readonly loss?: readonly LossView[];
  /** 対象と配下のブランチの先端（nodeId → SHA）。破棄の指示（`expectTips`）に、そのまま渡す。 */
  readonly tips?: Readonly<Record<string, string>>;
}
const isTips = (v: unknown): v is Readonly<Record<string, string>> =>
  isRecord(v) &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(x));
const isLossView = (v: unknown): v is LossView =>
  isRecord(v) &&
  typeof v.nodeId === "string" &&
  (v.aheadCommits === undefined ||
    (typeof v.aheadCommits === "number" &&
      Number.isInteger(v.aheadCommits) &&
      v.aheadCommits >= 0)) &&
  isStringArray(v.untrustedSubjects) &&
  (v.unknown === undefined || v.unknown === true) &&
  (v.workingTreeUnknown === undefined || v.workingTreeUnknown === true) &&
  typeof v.uncommitted === "boolean" &&
  typeof v.untracked === "number" &&
  Number.isInteger(v.untracked) &&
  v.untracked >= 0;
const isReclaimPreview = (v: unknown): v is ReclaimPreview =>
  isRecord(v) &&
  typeof v.reclaimable === "boolean" &&
  isStringArray(v.unmet) &&
  Array.isArray(v.blockers) &&
  (v.loss === undefined || (Array.isArray(v.loss) && v.loss.every(isLossView))) &&
  (v.tips === undefined || isTips(v.tips));
/** シェルで安全に貼り付けられるように、単一引用符で囲む（中の `'` は `'\''` にする）。 */
const shellQuote = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`;
interface DiscardedView {
  readonly key: string;
  readonly tip: string;
  readonly nodeId?: string;
  readonly orphan: boolean;
  readonly committedAt?: string;
  readonly untrustedSubject?: string;
}
const isDiscardedList = (v: unknown): v is { items: readonly DiscardedView[]; max: number } =>
  isRecord(v) &&
  typeof v.max === "number" &&
  Array.isArray(v.items) &&
  v.items.every(
    (i) =>
      isRecord(i) &&
      typeof i.key === "string" &&
      typeof i.tip === "string" &&
      typeof i.orphan === "boolean" &&
      (i.nodeId === undefined || typeof i.nodeId === "string") &&
      (i.committedAt === undefined || typeof i.committedAt === "string") &&
      (i.untrustedSubject === undefined || typeof i.untrustedSubject === "string"),
  );
const isRestored = (v: unknown): v is { branch: string; tip: string } =>
  isRecord(v) && typeof v.branch === "string" && typeof v.tip === "string";
const isDropped = (v: unknown): v is { dropped: true; key: string; tip: string } =>
  isRecord(v) && v.dropped === true && typeof v.key === "string" && typeof v.tip === "string";
function describeDiscarded(v: { items: readonly DiscardedView[]; max: number }): string {
  if (v.items.length === 0) return `保管している、破棄した成果: なし（上限 ${v.max} 件）\n`;
  const lines = v.items.map((i) => {
    const subject =
      i.untrustedSubject === undefined
        ? ""
        : `\n      件名（信頼できない入力）: 「${terminalSafe(i.untrustedSubject)}」`;
    return `  ${terminalSafe(i.key, 128)}  ノード: ${i.nodeId === undefined ? "（孤立）" : terminalSafe(i.nodeId, 128)}  先端: ${i.tip}${i.committedAt === undefined ? "" : `  ${terminalSafe(i.committedAt, 40)}`}${subject}`;
  });
  const rest = Math.max(v.max - v.items.length, 0);
  return `保管している、破棄した成果（${v.items.length} 件 / 上限 ${v.max} 件）:\n${lines.join("\n")}\n残り ${rest} 件（上限 ${v.max} − 現在 ${v.items.length}）。上限に達すると、強制の回収は失敗する\n`;
}
const isHeld = (v: unknown): v is { held: true; until?: string } =>
  isRecord(v) && v.held === true && (v.until === undefined || typeof v.until === "string");
/** 停止の宣言の根拠に使えない文字（画面の FORBIDDEN と同じ: 制御文字〔改行・タブを含む〕・書式制御文字）。 */
const NOTE_FORBIDDEN = /[\p{Cc}\p{Cf}]/u;
const isConfirmedStopped = (v: unknown): v is { state: string } =>
  isRecord(v) && typeof v.state === "string";
/** node.review の結果（受理のあとの状態）。 */
const isReviewed = isConfirmedStopped;
const HOOK_ENV_TOKEN = /^[A-Za-z0-9_-]{16,512}$/;
const HOOK_ENV_URL = /^http:\/\/(127\.0\.0\.1|localhost):[0-9]{1,5}$/;
const isHookToken = (v: unknown): v is { token: string; nodeId: string; daemonUrl: string } =>
  isRecord(v) &&
  typeof v.token === "string" &&
  HOOK_ENV_TOKEN.test(v.token) &&
  typeof v.daemonUrl === "string" &&
  HOOK_ENV_URL.test(v.daemonUrl) &&
  typeof v.nodeId === "string";
const isUnbound = (v: unknown): v is { unbound: boolean; duplicate: boolean } =>
  isRecord(v) && typeof v.unbound === "boolean" && typeof v.duplicate === "boolean";
const isReleased = (v: unknown): v is { released: true } => isRecord(v) && v.released === true;
const isPurged = (v: unknown): v is { purged: readonly string[] } =>
  isRecord(v) && isStringArray(v.purged);
const isAccepted = (v: unknown): v is { accepted: true } => isRecord(v) && v.accepted === true;

/** `decision.answer` の結果。`delivery` は古い daemon にはない（知らない値も、ないものとして扱う）。 */
const isAnswerResult = (
  v: unknown,
): v is { accepted: true; delivery?: unknown; deliveredVia?: unknown } => isAccepted(v);

/** 止まった子の未回答の判断の数の表示（表の pendingDecision 列と同じ言葉）。 */
function pendingText(p: { readonly undeliverable: number; readonly stopped: number }): string {
  const parts: string[] = [];
  if (p.undeliverable > 0) parts.push(`${p.undeliverable}（届かない）`);
  if (p.stopped > 0) parts.push(`${p.stopped}（止まった子）`);
  return parts.length === 0 ? "なし" : parts.join("+");
}

/** `tree.list` の結果（人間版。表 + 構造）。 */
interface TreeNodeView {
  readonly id: string;
  readonly role: string;
  readonly state: string;
  readonly parentId: string | null;
  readonly dependsOn: readonly string[];
  readonly openItems: number;
  readonly discarded: boolean;
  /** 止まった子の未回答の判断の数（古い daemon にはない）。 */
  readonly pendingDecisions?: { readonly undeliverable: number; readonly stopped: number };
}
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isPendingDecisions = (v: unknown): boolean =>
  v === undefined || (isRecord(v) && isCount(v.undeliverable) && isCount(v.stopped));
const isTreeNodeView = (v: unknown): v is TreeNodeView =>
  isRecord(v) &&
  typeof v.id === "string" &&
  typeof v.role === "string" &&
  typeof v.state === "string" &&
  (v.parentId === null || typeof v.parentId === "string") &&
  isStringArray(v.dependsOn) &&
  typeof v.openItems === "number" &&
  Number.isInteger(v.openItems) &&
  typeof v.discarded === "boolean" &&
  isPendingDecisions(v.pendingDecisions);
const isTreeList = (v: unknown): v is { table: string; nodes: readonly TreeNodeView[] } =>
  isRecord(v) &&
  typeof v.table === "string" &&
  Array.isArray(v.nodes) &&
  v.nodes.every(isTreeNodeView);

/** `decision.get` の結果。 */
interface DecisionView {
  readonly decisionId: string;
  readonly nodeId: string;
  /** `open` だけが答えられる。`answered`・`closed`（人が破棄を決めて閉じた）・まだ知らない値は、答えない。 */
  readonly status: string;
  readonly question?: string;
  readonly options?: readonly string[];
  readonly answer?: string;
  /** 閉じた理由（`closed` のとき。daemon が返せば）。 */
  readonly closedReason?: string;
}
const isDecisionView = (v: unknown): v is DecisionView =>
  isRecord(v) &&
  typeof v.decisionId === "string" &&
  typeof v.nodeId === "string" &&
  typeof v.status === "string" &&
  (v.closedReason === undefined || typeof v.closedReason === "string") &&
  (v.question === undefined || typeof v.question === "string") &&
  (v.options === undefined || isStringArray(v.options)) &&
  (v.answer === undefined || typeof v.answer === "string");

/** 判断の照合用の値（`touryou answer --expect`）。判断の中身（問い・選択肢）を畳む。表示のあとで中身が変わったことの検出。 */
const decisionDigest = (d: DecisionView): string =>
  digestOfText(
    `${d.decisionId}\n${d.question ?? ""}\n${(d.options ?? []).map((o) => `- ${o}`).join("\n")}\n`,
  );

function describeDecision(d: DecisionView): string {
  const lines = [
    `判断要求: ${terminalSafe(d.decisionId, 128)}（ノード: ${terminalSafe(d.nodeId, 128)}）`,
  ];
  lines.push(`問い: ${d.question === undefined ? "（なし）" : terminalSafe(d.question, 500)}`);
  if (d.options !== undefined && d.options.length > 0) {
    lines.push("選択肢（--choice に、この文をそのまま渡す）:");
    for (const o of d.options) lines.push(`  - ${terminalSafe(o, 200)}`);
  } else {
    lines.push("選択肢: なし（--text で自由に答える）");
  }
  return lines.join("\n");
}

const unconfirmed = (reason: string, rerun: string, requestId: string): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: `結果が確認できない（${reason}）。実行されたかどうかは不明（requestId: ${requestId}）。\n次の操作:\n  - 先に状態を確認する（受信箱・木の一覧）\n  - 同じ requestId で再実行する: ${rerun}\n`,
});

/**
 * 端末に出す、信頼できない文字列（コミットの件名・識別子）。制御文字（エスケープ列を含む）と、双方向の制御文字を除き、1 行にして、
 * 長さを切る（daemon も整えて返すが、端末への出力の直前に、もう一度整える）。
 */
const TERMINAL_UNSAFE = /[\p{Cc}\p{Cf}]/gu;
const terminalSafe = (s: string, max = 100): string => {
  const flat = s.replace(TERMINAL_UNSAFE, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
};

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const digestOfText = (text: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0xa5a5a5a5;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`.slice(0, 12);
};

/**
 * 表示した先端（nodeId → SHA）の照合用の値（`touryou reclaim`）。ID 順の `id:SHA` を、FNV-1a（32 ビット 2 本。種を変える）で畳んだ
 * 12 桁の 16 進。値の形は変えない（試験で固定している）。改ざん対策ではない（表示のあとで、対象が変わったことの検出。
 * 実際の照合は、daemon が行う）。cli は node の型に依存しない。
 */
export const tipsDigest = (tips: Readonly<Record<string, string>> | undefined): string =>
  digestOfText(
    Object.entries(tips ?? {})
      .sort(([a], [b]) => byId(a, b))
      .map(([id, tip]) => `${id}:${tip}\n`)
      .join(""),
  );

/** 削除される木のノード（`touryou purge`）の照合用の値。ID 順の `id` を畳む（同じ方式）。順序に依存しない。 */
export const nodeIdsDigest = (nodeIds: readonly string[]): string =>
  digestOfText(
    [...nodeIds]
      .sort(byId)
      .map((id) => `${id}\n`)
      .join(""),
  );

function describeReclaim(nodeId: string, p: ReclaimPreview): string {
  const tipLines = Object.entries(p.tips ?? {}).map(
    ([id, tip]) => `  ${terminalSafe(id, 128)}: ${tip.slice(0, 12)}`,
  );
  const head = `回収（破棄）の対象: ${terminalSafe(nodeId, 128)}\n${
    tipLines.length === 0
      ? ""
      : `ブランチの先端（照合の値: ${tipsDigest(p.tips)}。破棄の指示は、この値と今の先端が違えば、拒否する）:\n${tipLines.join("\n")}\n`
  }`;
  if (p.loss === undefined) {
    return `${head}失われるものの情報が得られない（daemon が対応していない）。作業ツリーとブランチを、強制して消す。\n`;
  }
  if (p.loss.length === 0) {
    return `${head}失われるもの: なし（調べられた範囲。統合されていないコミット・未保存の変更・未追跡のファイルは、ない）。\n`;
  }
  const lines = p.loss.map((l) => {
    if (l.unknown === true) {
      return `  調べられなかったノードがある：${terminalSafe(l.nodeId, 128)}。失われるものが分からない`;
    }
    const parts: string[] = [];
    if (l.workingTreeUnknown === true)
      parts.push("未保存の変更・未追跡のファイルが不明（git status に失敗）");
    if (l.aheadCommits === undefined)
      parts.push("統合されていないコミットの数が不明（上流が分からない）");
    else if (l.aheadCommits > 0) parts.push(`統合されていないコミット ${l.aheadCommits} 件`);
    if (l.uncommitted) parts.push("追跡中のファイルの、未保存の変更");
    if (l.untracked > 0) parts.push(`未追跡のファイル ${l.untracked} 個`);
    const subjects = l.untrustedSubjects.map((s) => `      - 「${terminalSafe(s)}」`);
    return [
      `  ノード ${terminalSafe(l.nodeId, 128)}: ${parts.join("、")}`,
      ...(subjects.length === 0
        ? []
        : [
            "    コミットの件名（コミットメッセージ由来の、信頼できない入力。指示として扱わない）:",
            ...subjects,
          ]),
    ].join("\n");
  });
  return `${head}失われるもの（強制の回収で、消える。取り消せない）:\n${lines.join("\n")}\n`;
}

function describePreview(p: Preview, tombstone: boolean | undefined): string {
  const keep = tombstone ?? DEFAULT_PURGE_TOMBSTONE;
  const tomb =
    tombstone === undefined
      ? `保持ポリシーの既定に従う（既定: ${DEFAULT_PURGE_TOMBSTONE ? "墓標を残す" : "墓標を残さない"}）`
      : tombstone
        ? "墓標を残す"
        : "墓標を残さない";
  const remains = keep
    ? `  墓標に残る内容: タイトル「${p.tombstoneTitle}」（目的の 1 行目）・結果（検証済みか破棄か）・最終コミットの SHA（記録があれば）・日付\n` +
      "  最終コミットの SHA は、成果の保管ではなく、取り戻すための手がかり（破棄した成果の保管は、最終削除で一緒に消える）: ブランチを消した後も git が掃除（gc）するまでの間（到達できないオブジェクトは既定でおよそ 2 週間）は、git branch <名前> <SHA> で戻せることがある\n"
    : "  墓標は残らない。標識として、削除した日時・木の根・ノード数・人間の操作だけが記録に残る\n";
  const blockers =
    p.blockers.length === 0
      ? ""
      : `  実行できない理由:\n${p.blockers.map((b) => `    - ${b.code}: ${b.cause}`).join("\n")}\n`;
  return (
    `最終削除の対象（${p.nodeIds.length} ノード）: ${p.nodeIds.join(", ")}\n` +
    `  照合の値: ${nodeIdsDigest(p.nodeIds)}（実行の時点で、削除される木がこれと違えば、削除しない）\n` +
    `  アーカイブ日: ${p.archivedAt}\n  経過日数: ${p.elapsedDays}（保持期間: ${p.retentionDays} 日）\n  墓標: ${tomb}\n` +
    remains +
    (p.hold === undefined
      ? ""
      : `  自動の最終削除は保留中（${p.hold.until === undefined ? "無期限" : `${terminalSafe(p.hold.until, 40)} まで`}${p.hold.reason === undefined ? "" : `。理由: 「${terminalSafe(p.hold.reason, 200)}」`}）。人間のこのコマンドは、保留を無視して削除する（無視したことは監査に残る）\n`) +
    (p.discardedRefs === undefined || p.discardedRefs === 0
      ? ""
      : `  保管している、破棄した成果（refs/touryou/discarded/*）: ${p.discardedRefs} 件が、一緒に消える。取り出すなら、先に touryou discarded restore（touryou discarded list で確かめる）\n`) +
    "  物理削除の範囲: 対象のノードに関するイベントの行（本文を含む）を、ログのファイルから消す（取り消せない）。バックアップ・OS のコピーには残りうる\n" +
    blockers
  );
}

const PRIORITY_LABELS: Readonly<Record<string, string>> = {
  blocking: "要判断",
  failed: "失敗",
  completed: "完了",
  progress: "進捗",
  info: "情報",
};
const INBOX_DEFAULT_LIMIT = 20;
const INBOX_MAX_LIMIT = 100;
const INBOX_MAX_OFFSET = 1_000_000;
/** `--since` の上限（9 桁の整数。`intFlag` の桁数の検査と同じ）。 */
const INBOX_MAX_SINCE = 999_999_999;

/** daemon の受信箱の項目の形の検査。不正な項目は除外する（受信箱全体は失敗にしない）。 */
function isInboxItem(v: unknown): v is InboxItem {
  return (
    isRecord(v) &&
    Number.isSafeInteger(v.seq) &&
    typeof v.id === "string" &&
    typeof v.nodeId === "string" &&
    typeof v.at === "string" &&
    typeof v.kind === "string" &&
    (INBOX_KINDS as readonly string[]).includes(v.kind) &&
    Array.isArray(v.dependsOn) &&
    (v.summary === undefined || typeof v.summary === "string") &&
    (v.ref === undefined || typeof v.ref === "string") &&
    (v.priority === undefined || (PRIORITIES as readonly string[]).includes(v.priority as string))
  );
}

/** 非負の整数の引数（`min` 以上 `max` 以下）。 */
function intFlag(
  values: ReadonlyMap<string, string>,
  flag: string,
  min: number,
  max: number,
  dflt: number,
): number | undefined {
  const raw = values.get(flag);
  if (raw === undefined) return dflt;
  if (!/^\d{1,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= min && n <= max ? n : undefined;
}

/** 読み取りだけの操作の、結果が確認できないときの案内（そのまま再実行してよい）。 */
const readUnconfirmed = (reason: string, rerun: string): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: `結果が確認できない（${reason}）。読み取りだけなので、そのまま再実行できる: ${rerun}\n`,
});

/** 1 ノードの詳しい状態（`touryou state`・`touryou tree <nodeId>`）。 */
function describeNode(n: TreeNodeView): string {
  return [
    `ノード: ${terminalSafe(n.id, 128)}`,
    `  役割: ${terminalSafe(n.role, 40)}`,
    `  状態: ${terminalSafe(n.state, 40)}`,
    `  親: ${n.parentId === null ? "（根）" : terminalSafe(n.parentId, 128)}`,
    `  依存: ${n.dependsOn.length === 0 ? "なし" : n.dependsOn.map((d) => terminalSafe(d, 128)).join("、")}`,
    `  未解決の受信箱: ${n.openItems}`,
    `  破棄の判断: ${n.discarded ? "済み" : "なし"}`,
    ...(n.pendingDecisions === undefined
      ? []
      : [`  止まった子の未回答の判断: ${pendingText(n.pendingDecisions)}`]),
  ].join("\n");
}

async function runTree(
  command: string,
  flags: ReadonlySet<string>,
  positional: readonly string[],
  requestId: string | undefined,
  deps: CommandDeps,
): Promise<CommandResult> {
  const json = flags.has("--json");
  let target: string | undefined;
  if (command === "state") {
    if (positional.length !== 1)
      return usageError("touryou state には、ノード識別子を 1 つ指定する");
    target = positional[0];
  } else {
    if (positional.length > 1) {
      return usageError("touryou tree には、ノード識別子を 0 個か 1 個だけ指定する");
    }
    target = positional[0];
  }
  if (target !== undefined && !isSafeId(target)) {
    return usageError(
      `ノード識別子が不正: ${JSON.stringify(target)}（英数字で始まり、英数字と . _ : - のみ）`,
    );
  }
  const id = requestId ?? deps.newRequestId();
  const res = await invoke(deps.client, id, "tree.list", {}, isTreeList);
  if (res.kind === "failure") return failed(res.failure);
  if (res.kind === "unconfirmed") return readUnconfirmed(res.reason, `touryou ${command}`);
  const nodes = res.value.nodes;
  if (target !== undefined) {
    const node = nodes.find((n) => n.id === target);
    if (node === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ノードが見つからない: ${terminalSafe(target, 128)}（touryou tree で一覧を確認する）\n`,
      };
    }
    return json
      ? { exitCode: 0, stdout: `${JSON.stringify(node, null, 2)}\n`, stderr: "" }
      : { exitCode: 0, stdout: `${describeNode(node)}\n`, stderr: "" };
  }
  if (json) return { exitCode: 0, stdout: `${JSON.stringify(nodes, null, 2)}\n`, stderr: "" };
  if (nodes.length === 0) return { exitCode: 0, stdout: "ノードがありません\n", stderr: "" };
  return { exitCode: 0, stdout: `${res.value.table}\n`, stderr: "" };
}

/** 木の一覧から、ノードの状態を引く（読めなければ undefined。表示の補助なので、失敗で止めない）。 */
async function nodeStates(deps: CommandDeps): Promise<ReadonlyMap<string, string> | undefined> {
  const res = await invoke(deps.client, deps.newRequestId(), "tree.list", {}, isTreeList);
  if (res.kind !== "ok") return undefined;
  return new Map(res.value.nodes.map((n) => [n.id, n.state]));
}

/** 答えを子に届けられる状態か（core の集合。cli は状態を文字列で扱うので、ここで橋渡し）。 */
const isDeliverableState = (state: string): boolean =>
  (ANSWER_DELIVERABLE_STATES as ReadonlySet<string>).has(state);

/** open でない判断の、答えられない理由（status と、あれば答え・閉じた理由）。 */
function notOpenReason(d: DecisionView): string {
  const st = terminalSafe(d.status, 40);
  if (d.status === "answered") {
    return `この判断要求は、すでに答え済み（status: ${st}）: ${d.answer === undefined ? "（内容なし）" : `「${terminalSafe(d.answer, 200)}」`}`;
  }
  const why = d.closedReason === undefined ? "" : `（理由: ${terminalSafe(d.closedReason, 200)}）`;
  return `この判断要求は答えられない（status: ${st}${why}）`;
}

/** 判断を出したノードの状態の行と、届かないときの注意。 */
function stateNote(state: string | undefined): string {
  if (state === undefined) return "子の状態: 不明（木の一覧を読めなかった）";
  const s = terminalSafe(state, 40);
  return isDeliverableState(state)
    ? `子の状態: ${s}（届ける手段があれば、子に届く）`
    : `子の状態: ${s}（この子は ${s} なので、答えは子に届かない。記録は残り、回収の片付けにはなる）`;
}

async function runDecisions(
  flags: ReadonlySet<string>,
  positional: readonly string[],
  requestId: string | undefined,
  deps: CommandDeps,
): Promise<CommandResult> {
  if (positional.length !== 0) return usageError("touryou decisions に、位置引数はない");
  const id = requestId ?? deps.newRequestId();
  const res = await invoke(
    deps.client,
    id,
    "inbox.fetch",
    {},
    (v): v is { items: readonly unknown[] } => isRecord(v) && Array.isArray(v.items),
  );
  if (res.kind === "failure") return failed(res.failure);
  if (res.kind === "unconfirmed") return readUnconfirmed(res.reason, "touryou decisions");
  const decisions = res.value.items
    .filter(isInboxItem)
    .filter((it) => it.kind === "decision" && it.ref !== undefined);
  const states = decisions.length === 0 ? new Map<string, string>() : await nodeStates(deps);
  const stateOf = (nodeId: string): string | undefined => states?.get(nodeId);
  // 判断ごとの status（open 以外は答えられない）。読めなければ undefined（表示の補助なので止めない）。
  const views = new Map<string, DecisionView>();
  for (const it of decisions) {
    const g = await invoke(
      deps.client,
      deps.newRequestId(),
      "decision.get",
      { decisionId: it.ref as string },
      isDecisionView,
    );
    if (g.kind === "ok") views.set(it.ref as string, g.value);
  }
  if (flags.has("--json")) {
    const out = decisions.map((it) => {
      const state = stateOf(it.nodeId);
      return {
        decisionId: it.ref,
        nodeId: it.nodeId,
        summary: it.summary,
        at: it.at,
        ...(views.get(it.ref as string) === undefined
          ? {}
          : {
              status: views.get(it.ref as string)?.status,
              answerable: views.get(it.ref as string)?.status === "open",
            }),
        ...(state === undefined
          ? {}
          : { nodeState: state, deliverable: isDeliverableState(state) }),
      };
    });
    return { exitCode: 0, stdout: `${JSON.stringify(out, null, 2)}\n`, stderr: "" };
  }
  if (decisions.length === 0) {
    return { exitCode: 0, stdout: "未解決の判断要求はありません\n", stderr: "" };
  }
  const lines = decisions.map((it) => {
    const sum = it.summary === undefined ? "" : `  問い: ${terminalSafe(it.summary, 200)}`;
    const v = views.get(it.ref as string);
    const head = `${terminalSafe(it.ref ?? "", 128)}  ノード: ${terminalSafe(it.nodeId, 128)}${sum}`;
    if (v !== undefined && v.status !== "open") return `${head}\n    ${notOpenReason(v)}`;
    return `${head}\n    ${stateNote(stateOf(it.nodeId))}`;
  });
  return {
    exitCode: 0,
    stdout: `未解決の判断要求（${decisions.length} 件）:\n${lines.join("\n")}\n答えるには、まず中身を表示する: touryou answer <decisionId>\n`,
    stderr: "",
  };
}

async function runAnswer(
  flags: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
  positional: readonly string[],
  requestId: string | undefined,
  deps: CommandDeps,
): Promise<CommandResult> {
  const [decisionId] = positional;
  if (decisionId === undefined || positional.length !== 1) {
    return usageError("touryou answer には、判断要求の識別子を 1 つ指定する");
  }
  if (!isSafeId(decisionId)) {
    return usageError(
      `判断要求の識別子が不正: ${JSON.stringify(decisionId)}（英数字で始まり、英数字と . _ : - のみ）`,
    );
  }
  const choice = values.get("--choice");
  const text = values.get("--text");
  if (choice !== undefined && text !== undefined) {
    return usageError("--choice と --text は同時に指定できない");
  }
  // まず判断の中身を読む（読み取りだけ。requestId は使わない）。
  const got = await invoke(
    deps.client,
    deps.newRequestId(),
    "decision.get",
    { decisionId },
    isDecisionView,
  );
  if (got.kind === "failure") return failed(got.failure);
  if (got.kind === "unconfirmed") {
    return readUnconfirmed(got.reason, `touryou answer ${decisionId}`);
  }
  const d = got.value;
  if (d.status !== "open") {
    // answered・closed・まだ知らない値: 表示だけで止めて、答えない
    return {
      exitCode: 1,
      stdout: `${describeDecision(d)}\n`,
      stderr: `${notOpenReason(d)}。何も答えていない\n`,
    };
  }
  const digest = decisionDigest(d);
  const state = (await nodeStates(deps))?.get(d.nodeId);
  const preview = `${describeDecision(d)}\n${stateNote(state)}\n照合の値: ${digest}\n`;
  const how = `touryou answer ${decisionId} --text <文>（または --choice <選択肢>） --yes --expect ${digest}`;
  if (!flags.has("--yes")) {
    return {
      exitCode: 0,
      stdout: preview,
      stderr: `答えるには、答えと --yes・--expect（上の照合の値）を付けて再実行する: ${how}\n`,
    };
  }
  const expect = values.get("--expect");
  if (expect === undefined) {
    // touryou reclaim とそろえる: --yes には、表示した照合の値が要る（表示を見ずに答えない）。
    return {
      exitCode: 1,
      stdout: preview,
      stderr: `--yes には --expect（表示した照合の値）が要る。何も答えていない。上の内容でよければ: ${how}\n`,
    };
  }
  if (choice === undefined && text === undefined) {
    return usageError("--yes のときは、--text か --choice のどちらかで答えを指定する");
  }
  // 選択肢のある判断で --choice を使うときは、表示に出た選択肢と一致することを確かめる。
  if (
    choice !== undefined &&
    d.options !== undefined &&
    d.options.length > 0 &&
    !d.options.includes(choice)
  ) {
    return {
      exitCode: 2,
      stdout: preview,
      stderr:
        "--choice が選択肢と一致しない。選択肢の文をそのまま渡す（または --text で自由に答える）\n",
    };
  }
  if (expect !== digest) {
    return {
      exitCode: 1,
      stdout: preview,
      stderr: `表示したあとで、判断の中身が変わっている（照合の値が違う: 期待 ${terminalSafe(expect, 40)}、現在 ${digest}）。何も答えていない。上の内容を確かめ直して、よければ再実行する\n`,
    };
  }
  const id = requestId ?? deps.newRequestId();
  const params =
    choice !== undefined ? { decisionId, choice } : { decisionId, text: text as string };
  const res = await invoke(deps.client, id, "decision.answer", params, isAnswerResult);
  if (res.kind === "failure") return failed(res.failure);
  if (res.kind === "unconfirmed") {
    return unconfirmed(
      res.reason,
      `touryou answer ${decisionId} ${choice !== undefined ? `--choice ${shellQuote(choice)}` : `--text ${shellQuote(text as string)}`} --yes --expect ${digest} --request-id ${id}`,
      id,
    );
  }
  // daemon が届けたかを返すなら、それを出す。返さない（古い daemon）なら、子の状態から見込みを出す。
  const delivery = res.value.delivery;
  const undelivered =
    delivery === "delivered"
      ? res.value.deliveredVia === "resumed"
        ? "答えを子に届けた（答えを添えて、子を再開した）\n"
        : res.value.deliveredVia === "instructed"
          ? "答えを子に届けた（追加の指示として。子は受信箱で読む）\n"
          : "答えを子に届けた\n"
      : delivery === "skipped"
        ? "注意: 答えは子に届けていない（届ける手段がないか、子が動いていない。記録は残る）\n"
        : state !== undefined && !isDeliverableState(state)
          ? `注意: この子は ${terminalSafe(state, 40)} なので、答えは子に届かない（記録は残る）\n`
          : "";
  return {
    exitCode: 0,
    stdout: `答えた: ${terminalSafe(decisionId, 128)}\nrequestId: ${id}\n${undelivered}`,
    stderr: "",
  };
}

async function runInbox(
  flags: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
  positional: readonly string[],
  requestId: string | undefined,
  deps: CommandDeps,
): Promise<CommandResult> {
  if (positional.length !== 0) return usageError("touryou inbox に、位置引数はない");
  const limit = intFlag(values, "--limit", 1, INBOX_MAX_LIMIT, INBOX_DEFAULT_LIMIT);
  if (limit === undefined) return usageError(`--limit は 1〜${INBOX_MAX_LIMIT} の整数`);
  const offset = intFlag(values, "--offset", 0, INBOX_MAX_OFFSET, 0);
  if (offset === undefined) return usageError(`--offset は 0〜${INBOX_MAX_OFFSET} の整数`);
  const since = intFlag(values, "--since", 0, INBOX_MAX_SINCE, 0);
  if (since === undefined) return usageError(`--since は 0〜${INBOX_MAX_SINCE} の整数（seq）`);
  const id = requestId ?? deps.newRequestId();
  const res = await invoke(
    deps.client,
    id,
    "inbox.fetch",
    since === 0 ? {} : { sinceSeq: since },
    (v): v is { items: readonly unknown[] } => isRecord(v) && Array.isArray(v.items),
  );
  if (res.kind === "failure") return failed(res.failure);
  if (res.kind === "unconfirmed") {
    // 読み取りだけなので、そのまま再実行してよい。
    return {
      exitCode: 1,
      stdout: "",
      stderr: `結果が確認できない（${res.reason}）。読み取りだけなので、そのまま再実行できる: touryou inbox（requestId: ${id}）\n`,
    };
  }
  const valid = res.value.items.filter(isInboxItem);
  const excluded = res.value.items.length - valid.length;
  const sorted = sortInbox(valid);
  const page = sorted.slice(offset, offset + limit);
  const detail = flags.has("--detail");
  const lines: string[] = [];
  if (sorted.length === 0) {
    lines.push("未解決の項目はありません");
  } else {
    for (const it of page) {
      const head = `[${PRIORITY_LABELS[priorityOf(it)] ?? "?"}] ${it.kind}  ${terminalSafe(it.nodeId, 64)}`;
      const sum = it.summary === undefined ? "" : `  ${terminalSafe(it.summary, 200)}`;
      lines.push(`${head}${sum}`);
      if (detail) {
        lines.push(
          `    seq=${it.seq} id=${terminalSafe(it.id, 64)} at=${terminalSafe(it.at, 32)}${it.ref === undefined ? "" : ` ref=${terminalSafe(it.ref, 64)}`}`,
        );
      }
    }
    if (offset >= sorted.length) {
      lines.push(`--offset が件数（${sorted.length}）以上。先頭から: touryou inbox`);
    } else {
      const end = offset + page.length;
      lines.push(`全 ${sorted.length} 件（未解決）のうち ${offset + 1}〜${end} 件目`);
      if (end < sorted.length) {
        lines.push(
          `続き: touryou inbox --offset ${end}${limit === INBOX_DEFAULT_LIMIT ? "" : ` --limit ${limit}`}${since === 0 ? "" : ` --since ${since}`}${detail ? " --detail" : ""}`,
        );
      }
    }
    lines.push(
      "操作は画面（/ui）から: 判断の回答・範囲の承認。完了の受理は touryou accept <nodeId>",
    );
  }
  return {
    exitCode: 0,
    stdout: `${lines.join("\n")}\n`,
    stderr: excluded === 0 ? "" : `注意: 形が不正な項目を ${excluded} 件、除外した\n`,
  };
}

export async function runCommand(
  argv: readonly string[],
  deps: CommandDeps,
): Promise<CommandResult> {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { exitCode: 0, stdout: `${USAGE}\n`, stderr: "" };
  }
  let [command, ...rest] = argv;
  if (command === undefined) return usageError("コマンドを指定する");
  if (command === "discarded") {
    const sub = rest[0];
    if (sub !== "list" && sub !== "restore" && sub !== "drop") {
      return usageError("touryou discarded には、list・restore・drop のどれかを指定する");
    }
    command = `discarded-${sub}`;
    rest = rest.slice(1);
  }
  const allowed = ALLOWED_FLAGS[command];
  if (allowed === undefined) return usageError(`不明なコマンド: ${command}`);

  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  let requestId: string | undefined;
  const rerunArgs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--request-id") {
      const v = rest[i + 1];
      if (v === undefined || !isSafeId(v)) {
        return usageError("--request-id には識別子（英数字と . _ : -）を 1 つ指定する");
      }
      requestId = v;
      i++;
    } else if (a.startsWith("-")) {
      if (!allowed.includes(a)) return usageError(`不明なオプション: ${a}`);
      if (VALUE_FLAGS.has(a)) {
        const v = rest[i + 1];
        if (v === undefined || v.startsWith("--")) return usageError(`${a} には値を指定する`);
        values.set(a, v);
        rerunArgs.push(a, shellQuote(v));
        i++;
        continue;
      }
      flags.add(a);
      rerunArgs.push(a);
    } else {
      positional.push(a);
      rerunArgs.push(a);
    }
  }
  if (command === "inbox") return runInbox(flags, values, positional, requestId, deps);
  if (command === "discarded-list") {
    if (positional.length !== 0) return usageError("touryou discarded list に、引数はない");
    const res = await invoke(
      deps.client,
      requestId ?? deps.newRequestId(),
      "node.discardedList",
      {},
      isDiscardedList,
    );
    if (res.kind !== "ok") {
      return res.kind === "failure"
        ? failed(res.failure)
        : unconfirmed(res.reason, "touryou discarded list", requestId ?? "-");
    }
    return { exitCode: 0, stdout: describeDiscarded(res.value), stderr: "" };
  }
  if (command === "tree" || command === "state") {
    return runTree(command, flags, positional, requestId, deps);
  }
  if (command === "decisions") {
    return runDecisions(flags, positional, requestId, deps);
  }
  if (command === "answer") {
    return runAnswer(flags, values, positional, requestId, deps);
  }
  const [nodeId] = positional;
  if (nodeId === undefined || positional.length !== 1) {
    return usageError(`${command} にはノード識別子（または保管の名前）を 1 つ指定する`);
  }
  if (!isSafeId(nodeId)) {
    return usageError(
      `ノード識別子が不正: ${JSON.stringify(nodeId)}（英数字で始まり、英数字と . _ : - のみ）`,
    );
  }
  if (flags.has("--tombstone") && flags.has("--no-tombstone")) {
    return usageError("--tombstone と --no-tombstone は同時に指定できない");
  }

  const id = requestId ?? deps.newRequestId();
  const rerun = `touryou ${command} ${rerunArgs.join(" ")} --request-id ${id}`;
  const fail = (o: Outcome<unknown>): CommandResult =>
    o.kind === "failure"
      ? failed(o.failure)
      : unconfirmed((o as { reason: string }).reason, rerun, id);

  if (command === "discarded-restore") {
    const branch = values.get("--branch");
    const res = await invoke(
      deps.client,
      id,
      "node.discardedRestore",
      { target: nodeId, ...(branch === undefined ? {} : { branch }) },
      isRestored,
    );
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `ブランチを作った: ${terminalSafe(res.value.branch, 200)}（先端 ${res.value.tip}）。保管は残っている\nrequestId: ${id}\n`,
      stderr: "",
    };
  }
  if (command === "discarded-drop") {
    const listed = await invoke(deps.client, id, "node.discardedList", {}, isDiscardedList);
    if (listed.kind !== "ok") return fail(listed);
    const exact = listed.value.items.filter((i) => i.key === nodeId);
    const matches =
      exact.length > 0 ? exact : listed.value.items.filter((i) => i.nodeId === nodeId);
    if (matches.length > 1) {
      return failed({
        code: "multipleKept",
        cause: `ノード ${terminalSafe(nodeId, 128)} の保管が複数ある（${matches.map((m) => terminalSafe(m.key, 128)).join("、")}）`,
        nextActions: ["touryou discarded list で確かめて、鍵（key）を指定する"],
      } as Failure);
    }
    const item = matches[0];
    if (item === undefined) {
      return failed({
        code: "notFound",
        cause: "その保管はない",
        nextActions: ["touryou discarded list で名前を確かめる"],
      } as Failure);
    }
    const shown = `消す保管: ${terminalSafe(item.key, 128)}（ノード ${item.nodeId === undefined ? "孤立" : terminalSafe(item.nodeId, 128)}。先端 ${item.tip}）\n`;
    if (!flags.has("--yes")) {
      return {
        exitCode: 2,
        stdout: shown,
        stderr:
          "保管を消すと、取り戻せない（先に touryou discarded restore で取り出せる）。上の対象でよければ --yes を付けて再実行する\n",
      };
    }
    // 表示した先端を渡す（表示のあとで保管が変わっていたら、消さない）。鍵で指定する（ノード ID だと、複数あるときに曖昧）。
    const res = await invoke(
      deps.client,
      id,
      "node.discardedDrop",
      { target: item.key, expectTip: item.tip },
      isDropped,
    );
    if (res.kind !== "ok") return fail(res);
    return { exitCode: 0, stdout: `${shown}消した\nrequestId: ${id}\n`, stderr: "" };
  }

  if (command === "purge-hold") {
    const until = values.get("--until");
    const daysText = values.get("--days");
    let days: number | undefined;
    if (daysText !== undefined) {
      if (until !== undefined) return usageError("--until と --days は同時に指定できない");
      if (
        !/^[0-9]{1,3}$/.test(daysText) ||
        Number(daysText) < 1 ||
        Number(daysText) > LIMITS.purgeHoldMaxDays
      ) {
        return usageError(`--days は 1〜${LIMITS.purgeHoldMaxDays} の整数`);
      }
      days = Number(daysText); // 期限は、daemon の時計で決める
    }
    const reason = values.get("--reason");
    const res = await invoke(
      deps.client,
      id,
      "node.purgeHold",
      {
        nodeId,
        ...(until === undefined ? {} : { until }),
        ...(days === undefined ? {} : { days }),
        ...(reason === undefined ? {} : { reason }),
      },
      isHeld,
    );
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `自動の最終削除を保留した: ${nodeId}（${res.value.until === undefined ? "無期限" : `${res.value.until} まで`}）\n有効な予告は取り下げた。人間の touryou purge は、保留に関係なく実行できる\nrequestId: ${id}\n`,
      stderr: "",
    };
  }
  if (command === "purge-release") {
    const res = await invoke(deps.client, id, "node.purgeRelease", { nodeId }, isReleased);
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `保留を解除した: ${nodeId}（保持期間を過ぎていれば、予告から出し直し、noticeDays 日後に消える）\nrequestId: ${id}\n`,
      stderr: "",
    };
  }

  if (command === "hook-env") {
    // 画面に出す経路を作らない: 標準出力が端末なら（分からないときも）、daemon を呼ばずに失敗する（トークンを発行しない）
    if (deps.isTTY === undefined || deps.isTTY.stdout !== false) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `hook-env は eval で使う: eval "$(touryou hook-env ${nodeId})"（標準出力が端末のときは、トークンを出さない）\n`,
      };
    }
    const res = await invoke(deps.client, id, "node.hookToken", { nodeId }, isHookToken);
    if (res.kind !== "ok") return fail(res);
    // 値は、形を確かめた文字（英数字・_・-、ループバックの URL）だけなので、単一引用符の中にそのまま置ける
    return {
      exitCode: 0,
      stdout: `export TOURYOU_DAEMON_URL='${res.value.daemonUrl}'\nexport TOURYOU_NODE_TOKEN='${res.value.token}'\n`,
      stderr: "",
    };
  }

  if (command === "hook-unbind") {
    const res = await invoke(deps.client, id, "node.hookUnbind", { nodeId }, isUnbound);
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: res.value.duplicate
        ? `すでに記録済み（再送。もう一度は外さない）: ${nodeId}\nrequestId: ${id}\n`
        : `${res.value.unbound ? "フックの結び付けを外した" : "フックの結び付けはなかった（記録だけ残した）"}: ${nodeId}\n次に来たセッションに結び直す\nrequestId: ${id}\n`,
      stderr: "",
    };
  }

  if (command === "accept") {
    const res = await invoke(
      deps.client,
      id,
      "node.review",
      { nodeId, verdict: "accept" },
      isReviewed,
    );
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `受理した: ${nodeId}（状態: ${terminalSafe(res.value.state, 40)}）\n子のトークンは失効した。回収は touryou reclaim ${nodeId}\nrequestId: ${id}\n`,
      stderr: "",
    };
  }

  if (command === "confirm-stopped") {
    // 画面と同じ規則: 1 行（改行・制御文字・書式制御文字は不可）。前後の空白を削り、連続する空白を 1 つにした値を送る。
    const rawNote = values.get("--note");
    const note = rawNote?.replace(/\s+/g, " ").trim();
    if (
      rawNote !== undefined &&
      (note === "" ||
        NOTE_FORBIDDEN.test(rawNote) ||
        note === undefined ||
        !isBoundedText(note, LIMITS.summary))
    ) {
      return usageError(
        `--note は 1 行・${LIMITS.summary} 文字以下の文（空白だけ・改行・制御文字は不可）`,
      );
    }
    const res = await invoke(
      deps.client,
      id,
      "node.confirmStopped",
      { nodeId, ...(note === undefined ? {} : { note }) },
      isConfirmedStopped,
    );
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `止めたと宣言した: ${nodeId}（状態: ${terminalSafe(res.value.state, 40)}）\n宣言した者（人間）と根拠を記録し、受信箱の停止の代行依頼を解決済みにした\nrequestId: ${id}\n`,
      stderr: "",
    };
  }

  if (command === "reclaim") {
    // まず、失われるものを表示する。破棄の指示は、--yes があるときだけ。
    const preview = await invoke(
      deps.client,
      id,
      "node.reclaimPreview",
      { nodeId },
      isReclaimPreview,
    );
    if (preview.kind !== "ok") return fail(preview);
    const tips = preview.value.tips ?? {};
    if (Object.keys(tips).length > LIMITS.expectTips) {
      return failed({
        code: "tooManyNodes",
        cause: `配下のノードが多すぎて、先端の照合ができない（${Object.keys(tips).length} 件。上限 ${LIMITS.expectTips} 件）`,
        nextActions: ["配下を先に回収して、数を減らす"],
      } as Failure);
    }
    const shown = describeReclaim(nodeId, preview.value);
    const digest = tipsDigest(tips);
    const expect = values.get("--expect");
    if (!flags.has("--yes")) {
      return {
        exitCode: 2,
        stdout: shown,
        stderr: `${values.has("--expect") ? "--expect は、表示だけ（実行には --yes が要る）。" : ""}破棄の判断は取り消せない（停止したノードの作業ツリーとブランチが、強制して消える）。上の内容でよければ、表示の値を付けて再実行する: touryou reclaim ${nodeId} --yes --expect ${digest}\n`,
      };
    }
    if (expect === undefined) {
      return usageError(
        `--yes には --expect <digest> が要る（表示した先端の照合用の値。--yes なしで実行すると、表示される: ${digest}）`,
      );
    }
    if (expect !== digest) {
      return {
        exitCode: 1,
        stdout: shown,
        stderr: `表示した内容のあとで、先端が変わっている（照合の値が違う）。何も指示していない。上の内容を確かめ直して、よければ再実行する: touryou reclaim ${nodeId} --yes --expect ${digest}\n`,
      };
    }
    // 表示した先端（プレビューの tips）を渡す。daemon が、今の先端と照合する（違えば tipMismatch）。
    const res = await invoke(
      deps.client,
      id,
      "node.reclaimInstruct",
      { nodeId, expectTips: tips },
      isAccepted,
    );
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `${shown}回収を指示した: ${nodeId}\nrequestId: ${id}\n`,
      stderr: "",
    };
  }

  // purge: まず対象を表示する。削除は --yes があるときだけ。
  const tombstone = flags.has("--tombstone")
    ? true
    : flags.has("--no-tombstone")
      ? false
      : undefined;
  const preview = await invoke(deps.client, id, "node.purgePreview", { nodeId }, isPreview);
  if (
    preview.kind === "failure" &&
    preview.failure.code === "notFound" &&
    requestId !== undefined
  ) {
    // --request-id を指定した再実行で、木が見つからない: 前回の実行が成功して、木がもう消えている可能性がある（事前確認は飛ばさない）。
    return failed({
      ...preview.failure,
      cause: `${preview.failure.cause}（前回の実行が成功して、木がすでに消えた可能性がある）`,
      nextActions: [
        "画面の木の一覧に、そのノードがないか確かめる。ないなら、前回の最終削除は成功している",
        "墓標を残した場合は、墓標の記録（削除した日時・木の根）が残っている。残さない場合も、標識（削除した日時・ノード数）が記録に残る",
        "破棄した成果を保管していた木は、touryou discarded list で、その木のノードの保管が（孤立として残っていないか）確かめる",
        ...preview.failure.nextActions,
      ] as unknown as Failure["nextActions"],
    } as Failure);
  }
  if (preview.kind !== "ok") return fail(preview);
  const shown = describePreview(preview.value, tombstone);

  if (flags.has("--dry-run"))
    return { exitCode: 0, stdout: `${shown}（--dry-run: 何も削除していない）\n`, stderr: "" };
  if (!preview.value.purgeable) {
    return {
      exitCode: 1,
      stdout: shown,
      stderr: `最終削除を実行できない（理由を解消してから、もう一度実行する）:\n${preview.value.blockers.map((b) => `  - ${b.code}: ${b.cause}`).join("\n")}\n`,
    };
  }
  const digest = nodeIdsDigest(preview.value.nodeIds);
  if (!flags.has("--yes")) {
    return {
      exitCode: 2,
      stdout: shown,
      stderr: `${values.has("--expect") ? "--expect は、表示だけ（実行には --yes が要る）。" : ""}最終削除は取り消せない。上の対象でよければ、表示の値を付けて再実行する: touryou purge ${nodeId} --yes --expect ${digest}\n`,
    };
  }
  const expect = values.get("--expect");
  if (expect === undefined) {
    return usageError(
      `--yes には --expect <digest> が要る（表示した、削除される木の照合用の値。--yes なしで実行すると、表示される: ${digest}）`,
    );
  }
  if (expect !== digest) {
    return {
      exitCode: 1,
      stdout: shown,
      stderr: `表示した内容のあとで、削除される木が変わっている（照合の値が違う）。何も削除していない。上の内容を確かめ直して、よければ再実行する: touryou purge ${nodeId} --yes --expect ${digest}\n`,
    };
  }

  // 見せた木（削除されるノード）を渡す。実行までの間に木が変わっていたら、daemon が削除しない（purgeStale）。
  // ノードが 2000 件（`LIMITS.expectNodeIds`）を超える木は、daemon の照合（expectNodeIds）を省く。照合は、--expect（取り直した事前確認との照合）だけになる。
  const daemonCheck = preview.value.nodeIds.length <= LIMITS.expectNodeIds;
  const params = {
    nodeId,
    ...(tombstone === undefined ? {} : { tombstone }),
    ...(daemonCheck ? { expectNodeIds: preview.value.nodeIds } : {}),
  };
  const res = await invoke(deps.client, id, "node.purge", params, isPurged);
  if (res.kind !== "ok") return fail(res);
  return {
    exitCode: 0,
    stdout: `${shown}最終削除した（${res.value.purged.length} ノード）: ${res.value.purged.join(", ")}\nrequestId: ${id}\n`,
    stderr: daemonCheck
      ? ""
      : `注意: ノードが ${LIMITS.expectNodeIds} 件を超える木なので、daemon での照合（expectNodeIds）は省いた。照合は、--expect（実行の直前に取り直した事前確認との照合）だけ\n`,
  };
}
