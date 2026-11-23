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
 *   touryou stop <nodeId> [--yes] [--request-id <id>]
 *   touryou hook-unbind <nodeId> [--request-id <id>]
 *   eval "$(touryou hook-env <nodeId>)"
 *   touryou inbox [--detail] [--limit <1〜100>] [--offset <n>] [--since <seq>] [--request-id <id>]
 *   touryou inbox resolve <項目 ID>… [--request-id <id>]
 *   touryou inbox reopen <項目 ID>… [--request-id <id>]
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
  /**
   * gh（GitHub CLI）の実行。引数だけを渡す（シェルを通さない）。gh が使えない（見つからない・時間切れ）ときは `undefined`。
   * 省略すると、gh は使えないものとして扱う。出力は、信頼できない入力（端末に出す前に整える）。
   */
  readonly gh?: GhRunner;
}

export type GhRunner = (
  args: readonly string[],
) => Promise<{ readonly code: number; readonly stdout: string } | undefined>;

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
  touryou reclaim <nodeId> --merged-as <PR 番号 | 40 桁のコミット SHA> [--request-id <id>]
      スカッシュ・リベースでマージした子に、「統合済みの証拠」を記録する（人間だけ。AI は記録できない）。ブランチは消さない。
      PR 番号: gh で、マージ済みの PR の head の SHA を取り、子の先端と一致するときだけ記録する（gh が要る）。
      SHA: 人が「この先端は統合済み」と宣言する。短縮 SHA は受けない。子の先端と違えば、記録しない。
      記録したあとは、touryou reclaim-merged（または親の統合ノードの回収）で、証拠による回収ができる。先端が動くと、証拠は無効になる。
  touryou reclaim-merged [--yes --expect <digest>] [--request-id <id>]
      統合済みの子（受理済みで、親のブランチに取り込み済み）の作業ツリーとブランチを、一括で回収する（取り消せない）。
      まず、回収できる子と、対象外の子（理由つき。未コミット・未統合・動作中のプロセスなど）を表示する。強制は使わない。
      スカッシュ・リベースでマージした子は、gh でマージ済みの PR の head の SHA を調べ、子の先端と一致すれば、統合済みの証拠を記録して対象にする
      （gh が使えないときは、親のブランチに取り込み済みと分かる子だけを対象にして、理由を表示する。証拠による回収は、先端を保管してから消す）。
      --yes      一括の回収を実行する（なければ、表示だけで止まる）。--expect が要る
      --expect <digest>  表示した一覧の照合用の値（表示に出る 12 桁の 16 進）。実行の時点の一覧から計算し直した値と違えば、何も回収しない
  touryou purge-hold <nodeId> [--until <日時> | --days <日数>] [--reason <理由>] [--request-id <id>]
      自動の最終削除（autoPurge）を、この木について保留する。nodeId は、予告に出ている木の根（アーカイブ済みで、親がアーカイブされていないノード）。
      有効な予告は、その場で取り下げる。人間の "$HOME/.touryou/current/bin/touryou" purge は、保留に関係なく実行できる（保留を無視したことは監査に残る）。
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
      受理すると、子のトークン・フック専用のトークンが失効し、Desktop の子の引き出しが消える。そのあとは "$HOME/.touryou/current/bin/touryou" reclaim で回収できる。
      差し戻しは、親の統合ノードだけができる。done 以外の子は invalidTransition（受理できない）
  touryou stop <nodeId> [--yes] [--request-id <id>]
      完了報告済み（done）の子を、受理せずに止める（done → stopping。受理の道には戻らない）。成果は消えず、作業ツリーに残る。
      止めて停止を確かめた（stopped）あとは、touryou reclaim で破棄して回収できる。done 以外の子は止めない（動いている子は親の統合が止める）。
      --yes がなければ、何も送らずに説明だけを出す
  touryou hook-unbind <nodeId> [--request-id <id>]
      子のフック（plugin のファイルで設定するフック）の session_id の結び付けを外す。/clear・--resume で session_id が変わって、
      フックが拒否され続けるときに使う。次に来たセッションに結び直す。外した者（人間）が記録に残る。
      トークンが漏れた疑いがあるときは、外さずに、子を止めてトークンを失効させる
  eval "$("$HOME/.touryou/current/bin/touryou" hook-env <nodeId>)"
      手動の CLI セッション用に、その子のフック専用のトークンを発行し、環境変数 TOURYOU_DAEMON_URL・TOURYOU_NODE_TOKEN を設定する
      （eval で使うときだけ。標準出力が端末なら、トークンを出さずに失敗する）。そのあと、子の作業ツリーで plugin つきの claude を起動する。
      発行し直すと、古いフック用トークンは無効になり、フックの結び付けも外れる。CLI の子（childRuntime: cli）の、動作中の子だけ
  touryou tree [<nodeId>] [--json]
      木のノードを一覧で表示する（読み取りだけ。tree.list の人間版）。ID・役割・状態・親・依存・未解決の数を表で出す。
      <nodeId> を付けると、そのノード 1 つの詳しい状態を出す。--json で機械可読の JSON。
  touryou state <nodeId> [--json]
      1 つのノードの詳しい状態を表示する（"$HOME/.touryou/current/bin/touryou" tree <nodeId> と同じ。読み取りだけ）。
  touryou decisions [--json]
      未解決の判断要求の一覧を表示する（読み取りだけ）。答えるには "$HOME/.touryou/current/bin/touryou" answer <decisionId>。--json で JSON。
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
  touryou inbox resolve <項目 ID>… [--request-id <id>]
      受信箱の、済んだ項目を片付ける（人間だけ。項目の ID は "$HOME/.touryou/current/bin/touryou" inbox --detail の id=）。片付けられる種類は、進捗（progress）・完了（done）・情報（info）だけ。
      判断・違反（拡張要求）・停止未完了などが 1 件でも含まれると、何も片付けずに断る。片付けた項目は「要対応」の数に入らず、記録に残る
  touryou inbox reopen <項目 ID>… [--request-id <id>]
      人が片付けた項目を、未解決に戻す（システム・ノードが解決にした項目は戻せない）
  touryou discarded list
      強制の回収で破棄した成果の保管（refs/touryou/discarded/*）の一覧: 名前・ノード・先端の SHA・日時・件名（コミットメッセージ由来の、信頼できない入力）。孤立（ノードがもうない）も出る。
      保管は、最終削除（"$HOME/.touryou/current/bin/touryou" purge）のときに、その木のノードの分が消える。数の上限（daemon の設定 discardedRefsMax）に達すると、強制の回収は失敗する
  touryou discarded restore <nodeId|key> [--branch <名前>] [--request-id <id>]
      保管している先端から、新しいブランチを作る（作成だけ。既存のブランチは上書きしない。保管は残る）。既定の名前は touryou/restored/<key>
  touryou discarded drop <nodeId|key> [--yes] [--request-id <id>]
      保管を 1 件消す（取り消せない）。--yes がなければ、対象の表示だけで止まる
  touryou config reload
      設定ファイル config.json の方針（rootScope・permissions・autoApprove）を読み込み直す（人間だけ）。検査に通ったときだけ入れ替える。
      ほかの項目が変わっていれば、名前を出して反映しない（daemon を起動し直す）。新しい上限からはみ出す子は、名前を出す（子の範囲は縮めない）
  touryou policy add|remove <allow|deny|ask|autoApprove> <規則> [--request-id <id>]
      実行中の方針の規則を足す・外す（人間だけ。記録と受信箱に残る）。deny も足せる。規則は 1 つの引数（例: 'Bash(git push:*)'）
  touryou scope decide <拡張要求の ID> <approve|reject|split> [--also-limit] [--request-id <id>]
      範囲の拡張を判定する（人間だけ。画面と同じ）。--also-limit は、承認する対象を根の上限（permissions.allow）にも足す（approve のときだけ）
  touryou launchd init [--org <組織の逆ドメイン。省略で Label は touryou.daemon>] [--path-prefix <ディレクトリ>] [--config <絶対パス> | --others]
      daemon・touryou-mcp を launchd で常駐させる起動スクリプトと plist を、$HOME/.touryou の下に生成する（窓口・トークンは不要。launchctl は実行しない。
      トークンの値は、生成も表示もしない）。詳しくは docs/launchd.md
  touryou launchd apply --yes | status | restart | stop | uninstall --yes  [--org …] [--config <絶対パス> | --others]
      launchd の常駐の操作（launchctl を実行する。apply・uninstall は、利用者の同意を取ってから --yes）。
      --config は設定ごとの daemon、--others は別名の daemon すべて。詳しくは docs/launchd.md
  --request-id <id>  結果が確認できなかった要求を、同じ識別子で再実行する
  touryou ui [--config <絶対パス> | --list]
      （--config は開く daemon の設定、--list は設定の一覧だけを出す）状態画面を、既定のブラウザで開く（macOS）。人間のトークンのファイルを自分で読み、使い捨てのチケット（60 秒・1 回だけ）にして開く。
      トークン・チケット・URL は出さない。環境変数の TOURYOU_HUMAN_TOKEN は要らない。詳しくは docs/ui.md
  -h, --help         この使い方を表示する（終了コード 0）
終了コード: 0 成功 / 1 失敗・結果が確認できない / 2 引数の誤り`;

const ALLOWED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  purge: ["--dry-run", "--yes", "--expect", "--tombstone", "--no-tombstone"],
  reclaim: ["--yes", "--expect", "--merged-as"],
  "reclaim-merged": ["--yes", "--expect"],
  "purge-hold": ["--until", "--days", "--reason"],
  "purge-release": [],
  "confirm-stopped": ["--note"],
  accept: [],
  stop: ["--yes"],
  "hook-unbind": [],
  "hook-env": [],
  inbox: ["--detail", "--limit", "--offset", "--since"],
  "inbox-resolve": [],
  "inbox-reopen": [],
  tree: ["--json"],
  state: ["--json"],
  decisions: ["--json"],
  answer: ["--text", "--choice", "--yes", "--expect"],
  "discarded-list": [],
  "discarded-restore": ["--branch"],
  "discarded-drop": ["--yes"],
  "config-reload": [],
  "policy-add": [],
  "policy-remove": [],
  "scope-decide": ["--also-limit"],
};
/** 値を取るオプション。 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--until",
  "--days",
  "--reason",
  "--branch",
  "--expect",
  "--note",
  "--merged-as",
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
interface BatchPreview {
  readonly candidates: readonly {
    readonly nodeId: string;
    readonly eligible: boolean;
    readonly unmet: readonly string[];
    readonly mergedBy?: "ancestor" | "evidence";
    readonly branch?: string;
    readonly base?: string;
  }[];
  readonly digest: string;
}
const isBatchPreview = (v: unknown): v is BatchPreview =>
  isRecord(v) &&
  typeof v.digest === "string" &&
  Array.isArray(v.candidates) &&
  v.candidates.every(
    (c) =>
      isRecord(c) &&
      typeof c.nodeId === "string" &&
      typeof c.eligible === "boolean" &&
      isStringArray(c.unmet) &&
      (c.mergedBy === undefined || c.mergedBy === "ancestor" || c.mergedBy === "evidence") &&
      (c.branch === undefined || typeof c.branch === "string") &&
      (c.base === undefined || typeof c.base === "string"),
  );
const isMergeEvidenceResult = (v: unknown): v is { recorded: true; duplicate: boolean } =>
  isRecord(v) && v.recorded === true && typeof v.duplicate === "boolean";

/** マージ済みの PR の、記録に使う値（gh の出力から、形を確かめて取り出したものだけ）。 */
interface MergedPr {
  readonly number: number;
  readonly tip: string;
}
type PrLookup =
  | { readonly kind: "found"; readonly pr: MergedPr }
  | { readonly kind: "none"; readonly reason: string };

const FULL_SHA = /^[0-9a-f]{40}$/;
const PR_NUMBER = /^[1-9][0-9]{0,8}$/;

/** gh の JSON の 1 件から、PR 番号と head の SHA を取り出す。形が違えば `undefined`（信頼しない）。 */
const GH_JSON_FIELDS = "number,headRefOid,mergedAt,baseRefName,isCrossRepository";
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * gh の JSON の 1 件から、PR 番号・head の SHA・base ブランチ・マージ時刻を取り出す。形が違えば `undefined`（信頼しない）。
 * fork（`isCrossRepository` が偽でない）の PR は、証拠にしない。
 */
const mergedPrOf = (
  x: unknown,
): (MergedPr & { readonly base: string; readonly mergedAtMs: number }) | undefined => {
  if (!isRecord(x)) return undefined;
  const { number, headRefOid, mergedAt, baseRefName, isCrossRepository } = x;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return undefined;
  if (typeof headRefOid !== "string" || !FULL_SHA.test(headRefOid)) return undefined;
  if (typeof baseRefName !== "string" || baseRefName === "") return undefined;
  if (isCrossRepository !== false) return undefined;
  const mergedAtMs = typeof mergedAt === "string" ? Date.parse(mergedAt) : Number.NaN;
  if (Number.isNaN(mergedAtMs)) return undefined;
  return { number, tip: headRefOid, base: baseRefName, mergedAtMs };
};

const parseGhJson = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
};

const GH_UNAVAILABLE = "gh（GitHub CLI）を実行できない（入っていない・ログインしていない・時間切れ）";

/** gh を使うリポジトリ（`<owner>/<repo>`）。gh のすべての呼び出しに `-R` で付ける。使えなければ `unavailable`。 */
async function ghRepoOf(gh: GhRunner | undefined): Promise<string | "unavailable" | "invalid"> {
  if (gh === undefined) return "unavailable";
  const r = await gh(["repo", "view", "--json", "nameWithOwner"]);
  if (r === undefined || r.code !== 0) return "unavailable";
  const v = parseGhJson(r.stdout);
  const name = isRecord(v) ? v.nameWithOwner : undefined;
  return typeof name === "string" && REPO_NAME.test(name) ? name : "invalid";
}

/**
 * ブランチ名に対応する、マージ済みの PR（マージ時刻が一番新しいもの）の head の SHA。
 * base が親のブランチ（`base`）と同じで、fork でない PR だけを使う。gh が使えなければ `unavailable`。
 */
async function findMergedPrByBranch(
  gh: GhRunner | undefined,
  repo: string,
  branch: string,
  base: string,
): Promise<PrLookup | "unavailable"> {
  if (gh === undefined) return "unavailable";
  const r = await gh([
    "pr",
    "list",
    "-R",
    repo,
    `--head=${branch}`,
    "--state",
    "merged",
    "--json",
    GH_JSON_FIELDS,
    "--limit",
    "10",
  ]);
  if (r === undefined || r.code !== 0) return "unavailable";
  const list = parseGhJson(r.stdout);
  if (!Array.isArray(list)) return { kind: "none", reason: "gh の応答の形が不正" };
  const prs = list.map(mergedPrOf).filter((p) => p !== undefined);
  if (prs.length === 0) return { kind: "none", reason: "マージ済みの PR が見つからない" };
  const forBase = prs.filter((p) => p.base === base);
  if (forBase.length === 0) {
    return { kind: "none", reason: "マージ先（base）が親のブランチと違う PR しかない" };
  }
  const latest = forBase.reduce((a, b) => (b.mergedAtMs > a.mergedAtMs ? b : a));
  return { kind: "found", pr: { number: latest.number, tip: latest.tip } };
}

/**
 * PR 番号から、マージ済みの PR の head の SHA。マージ済みでない・base が親のブランチと違う・fork なら `none`。
 * gh が使えなければ `unavailable`。
 */
async function findMergedPrByNumber(
  gh: GhRunner | undefined,
  repo: string,
  prNumber: string,
  base: string,
): Promise<PrLookup | "unavailable"> {
  if (gh === undefined) return "unavailable";
  const r = await gh(["pr", "view", prNumber, "-R", repo, "--json", `state,${GH_JSON_FIELDS}`]);
  if (r === undefined) return "unavailable";
  if (r.code !== 0) return { kind: "none", reason: "PR が見つからない" };
  const v = parseGhJson(r.stdout);
  if (!isRecord(v) || v.state !== "MERGED") {
    return { kind: "none", reason: "PR がマージ済みでない" };
  }
  const pr = mergedPrOf(v);
  if (pr === undefined || String(pr.number) !== prNumber) {
    return { kind: "none", reason: "gh の応答の形が不正、または fork からの PR" };
  }
  if (pr.base !== base) {
    return { kind: "none", reason: "マージ先（base）が親のブランチと違う" };
  }
  return { kind: "found", pr: { number: pr.number, tip: pr.tip } };
}
interface BatchResult {
  readonly reclaimed: readonly string[];
  readonly failed: readonly {
    readonly nodeId: string;
    readonly code: string;
    readonly cause: string;
  }[];
}
const isBatchResult = (v: unknown): v is BatchResult =>
  isRecord(v) &&
  isStringArray(v.reclaimed) &&
  Array.isArray(v.failed) &&
  v.failed.every(
    (f) =>
      isRecord(f) &&
      typeof f.nodeId === "string" &&
      typeof f.code === "string" &&
      typeof f.cause === "string",
  );
/** 一括の回収の、対象外の理由（`UnmetReason`）の文。 */
const UNMET_TEXT: Readonly<Record<string, string>> = {
  stateNotEligible: "回収できる状態でない",
  factsMissing: "作業ツリーの情報を確認できない",
  notMerged: "統合されていない",
  dirty: "未コミット（未保存の変更がある）",
  dependentsIncomplete: "依存する別のノードがまだ完了していない",
  openDecision: "未回答の判断がある",
  descendantsNotReclaimable: "配下に回収できないノードがある",
  processesRunning: "作業ツリーでプロセスが動いている",
  processesUnknown: "作業ツリーのプロセスを調べられない",
  discardRequired: "破棄の判断が要る",
};
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
  /** 題（古い daemon にはない）。 */
  readonly title?: string;
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
  isPendingDecisions(v.pendingDecisions) &&
  (v.title === undefined || typeof v.title === "string");
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
  // `^` は符号つき 32 ビットを返すので、`>>> 0` で符号なしにする（空の入力で、値に「-」が混じっていた。Issue #137）。
  let h2 = (0x01000193 ^ 0xa5a5a5a5) >>> 0;
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
  // 先端がない（ブランチが、もうない）ときも、照合の値を出す（ふだんと同じ 12 桁。Issue #137）。
  const head = `回収（破棄）の対象: ${terminalSafe(nodeId, 128)}\nブランチの先端（照合の値: ${tipsDigest(p.tips)}。破棄の指示は、この値と今の先端が違えば、拒否する）:\n${
    tipLines.length === 0 ? "  なし（ブランチがない）" : tipLines.join("\n")
  }\n`;
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
      : `  保管している、破棄した成果（refs/touryou/discarded/*）: ${p.discardedRefs} 件が、一緒に消える。取り出すなら、先に "$HOME/.touryou/current/bin/touryou" discarded restore（"$HOME/.touryou/current/bin/touryou" discarded list で確かめる）\n`) +
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
        stderr: `ノードが見つからない: ${terminalSafe(target, 128)}（"$HOME/.touryou/current/bin/touryou" tree で一覧を確認する）\n`,
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
  if (res.kind === "unconfirmed")
    return readUnconfirmed(res.reason, '"$HOME/.touryou/current/bin/touryou" decisions');
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
    stdout: `未解決の判断要求（${decisions.length} 件）:\n${lines.join("\n")}\n答えるには、まず中身を表示する: "$HOME/.touryou/current/bin/touryou" answer <decisionId>\n`,
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
    return readUnconfirmed(got.reason, `"$HOME/.touryou/current/bin/touryou" answer ${decisionId}`);
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
  const how = `"$HOME/.touryou/current/bin/touryou" answer ${decisionId} --text <文>（または --choice <選択肢>） --yes --expect ${digest}`;
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
      `"$HOME/.touryou/current/bin/touryou" answer ${decisionId} ${choice !== undefined ? `--choice ${shellQuote(choice)}` : `--text ${shellQuote(text as string)}`} --yes --expect ${digest} --request-id ${id}`,
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
      stderr: `結果が確認できない（${res.reason}）。読み取りだけなので、そのまま再実行できる: "$HOME/.touryou/current/bin/touryou" inbox（requestId: ${id}）\n`,
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
      lines.push(
        `--offset が件数（${sorted.length}）以上。先頭から: "$HOME/.touryou/current/bin/touryou" inbox`,
      );
    } else {
      const end = offset + page.length;
      lines.push(`全 ${sorted.length} 件（未解決）のうち ${offset + 1}〜${end} 件目`);
      if (end < sorted.length) {
        lines.push(
          `続き: "$HOME/.touryou/current/bin/touryou" inbox --offset ${end}${limit === INBOX_DEFAULT_LIMIT ? "" : ` --limit ${limit}`}${since === 0 ? "" : ` --since ${since}`}${detail ? " --detail" : ""}`,
        );
      }
    }
    lines.push(
      '操作は画面（/ui）から: 判断の回答・範囲の承認。完了の受理は "$HOME/.touryou/current/bin/touryou" accept <nodeId>',
    );
  }
  return {
    exitCode: 0,
    stdout: `${lines.join("\n")}\n`,
    stderr: excluded === 0 ? "" : `注意: 形が不正な項目を ${excluded} 件、除外した\n`,
  };
}

const isResolveResult = (
  v: unknown,
): v is { resolved: readonly string[]; alreadyResolved: readonly string[] } =>
  isRecord(v) && isStringArray(v.resolved) && isStringArray(v.alreadyResolved);
const isReopenResult = (
  v: unknown,
): v is { reopened: readonly string[]; alreadyOpen: readonly string[] } =>
  isRecord(v) && isStringArray(v.reopened) && isStringArray(v.alreadyOpen);

/** `touryou inbox resolve <項目 ID>…`（片付ける）・`touryou inbox reopen <項目 ID>…`（片付けた項目を戻す）。#99 */
async function runInboxResolve(
  resolve: boolean,
  positional: readonly string[],
  requestId: string | undefined,
  deps: CommandDeps,
): Promise<CommandResult> {
  const sub = resolve ? "resolve" : "reopen";
  if (positional.length === 0) {
    return usageError(`touryou inbox ${sub} には、受信箱の項目の ID を 1 つ以上指定する`);
  }
  if (positional.length > LIMITS.inboxResolveItems) {
    return usageError(`項目の ID は ${LIMITS.inboxResolveItems} 個まで`);
  }
  const bad = positional.find((p) => !isSafeId(p));
  if (bad !== undefined) {
    return usageError(
      `項目の ID が不正: ${JSON.stringify(bad)}（英数字で始まり、英数字と . _ : - のみ）`,
    );
  }
  const itemIds = [...new Set(positional)];
  const id = requestId ?? deps.newRequestId();
  const rerun = `"$HOME/.touryou/current/bin/touryou" inbox ${sub} ${itemIds.join(" ")} --request-id ${id}`;
  if (resolve) {
    const res = await invoke(deps.client, id, "inbox.resolve", { itemIds }, isResolveResult);
    if (res.kind === "failure") return failed(res.failure);
    if (res.kind === "unconfirmed") return unconfirmed(res.reason, rerun, id);
    const { resolved, alreadyResolved } = res.value;
    return {
      exitCode: 0,
      stdout: `片付けた: ${resolved.length} 件${alreadyResolved.length === 0 ? "" : `（すでに片付け済み ${alreadyResolved.length} 件）`}\n戻すには: "$HOME/.touryou/current/bin/touryou" inbox reopen <項目 ID>…\nrequestId: ${id}\n`,
      stderr: "",
    };
  }
  const res = await invoke(deps.client, id, "inbox.reopen", { itemIds }, isReopenResult);
  if (res.kind === "failure") return failed(res.failure);
  if (res.kind === "unconfirmed") return unconfirmed(res.reason, rerun, id);
  const { reopened, alreadyOpen } = res.value;
  return {
    exitCode: 0,
    stdout: `戻した: ${reopened.length} 件${alreadyOpen.length === 0 ? "" : `（すでに未解決 ${alreadyOpen.length} 件）`}\nrequestId: ${id}\n`,
    stderr: "",
  };
}

/** 統合済みの子の一括の回収（#234）。まず一覧を表示し、`--yes --expect <digest>` のときだけ実行する。 */
async function runReclaimMerged(
  flags: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
  positional: readonly string[],
  requestId: string | undefined,
  deps: CommandDeps,
): Promise<CommandResult> {
  if (positional.length !== 0) return usageError("touryou reclaim-merged に、引数はない");
  const id = requestId ?? deps.newRequestId();
  const rerun = `"$HOME/.touryou/current/bin/touryou" reclaim-merged --request-id ${id}`;
  const fail = (o: Outcome<unknown>): CommandResult =>
    o.kind === "failure"
      ? failed(o.failure)
      : unconfirmed((o as { reason: string }).reason, rerun, id);
  let preview = await invoke(deps.client, id, "node.reclaimBatchPreview", {}, isBatchPreview);
  if (preview.kind !== "ok") return fail(preview);
  // スカッシュ・リベースでマージした子（祖先判定で統合済みと分からない）は、gh でマージ済みの PR の head の SHA を調べる。
  // 子の先端と一致したものは、「記録したものとして」一覧を出す。記録は `--yes --expect` で実行するときだけ（表示では記録しない）。
  const evidenceLines: string[] = [];
  const notMerged = preview.value.candidates.filter(
    (c) => !c.eligible && c.unmet.includes("notMerged") && c.branch !== undefined,
  );
  const found: { nodeId: string; tip: string; prNumber: number }[] = [];
  let ghUnavailable = false;
  let repo: string | undefined;
  if (notMerged.length > 0) {
    const r = await ghRepoOf(deps.gh);
    if (r === "unavailable") ghUnavailable = true;
    else if (r === "invalid") {
      evidenceLines.push("  gh が返したリポジトリ名の形が不正。証拠を探さなかった");
    } else repo = r;
  }
  for (const c of notMerged) {
    if (repo === undefined) break;
    const who = terminalSafe(c.nodeId, 128);
    if (c.base === undefined) {
      evidenceLines.push(`  - ${who}: 統合済みの証拠なし（親のブランチが分からない。証拠を探さない）`);
      continue;
    }
    const lookup = await findMergedPrByBranch(deps.gh, repo, c.branch as string, c.base);
    if (lookup === "unavailable") {
      ghUnavailable = true;
      break;
    }
    if (lookup.kind === "none") {
      evidenceLines.push(`  - ${who}: 統合済みの証拠なし（${lookup.reason}）`);
      continue;
    }
    found.push({ nodeId: c.nodeId, tip: lookup.pr.tip, prNumber: lookup.pr.number });
  }
  if (ghUnavailable) {
    evidenceLines.push(
      `  ${GH_UNAVAILABLE}。親のブランチに取り込み済みと分かる子だけを対象にした（スカッシュ・リベースでマージした子は、対象外のまま）`,
    );
  }
  if (found.length > 0) {
    // 記録なしで、gh の一致の結果を使った一覧にする（先端が違う子には、daemon が使わない）。照合の値は、記録のあとと同じになる。
    preview = await invoke(
      deps.client,
      id,
      "node.reclaimBatchPreview",
      { assumeEvidence: found.map((f) => ({ nodeId: f.nodeId, tip: f.tip })) },
      isBatchPreview,
    );
    if (preview.kind !== "ok") return fail(preview);
  }
  const { candidates, digest } = preview.value;
  // 一致を確認できて、一覧で「証拠」になった子だけを、実行のときに記録する。
  const toRecord = found.filter((f) =>
    candidates.some((c) => c.nodeId === f.nodeId && c.mergedBy === "evidence"),
  );
  for (const f of found) {
    const who = terminalSafe(f.nodeId, 128);
    evidenceLines.push(
      toRecord.includes(f)
        ? `  - ${who}: PR #${f.prNumber} の head が先端と一致（gh で確認できた。--yes で実行するときに記録する）`
        : `  - ${who}: PR #${f.prNumber} の head が、いまの先端と違う（証拠にしない）`,
    );
  }
  const eligible = candidates.filter((c) => c.eligible);
  const skipped = candidates.filter((c) => !c.eligible);
  const lines = [`統合済みの子の一括の回収（照合の値: ${digest}）`];
  if (evidenceLines.length > 0) {
    lines.push("統合済みの証拠（gh でマージ済みの PR を調べた結果。表示だけでは記録しない）:", ...evidenceLines);
  }
  lines.push(
    eligible.length === 0
      ? "回収できる子: なし"
      : `回収できる子（${eligible.length} 件。作業ツリーとブランチを、強制せずに消す）:`,
  );
  for (const c of eligible) {
    const basis =
      c.mergedBy === "evidence"
        ? "（根拠: 統合済みの証拠。先端を保管してから、ブランチを消す）"
        : "（根拠: 親のブランチに取り込み済み）";
    lines.push(`  - ${terminalSafe(c.nodeId, 128)} ${basis}`);
  }
  if (skipped.length > 0) {
    lines.push(`対象外（${skipped.length} 件）:`);
    for (const c of skipped) {
      const why = c.unmet.map((r) => UNMET_TEXT[r] ?? terminalSafe(r, 40)).join("、");
      lines.push(`  - ${terminalSafe(c.nodeId, 128)}: ${why}`);
    }
  }
  if (skipped.some((c) => c.unmet.includes("notMerged"))) {
    lines.push(
      "「統合されていない」の子は、親のブランチに取り込まれていない（スカッシュ・リベースでマージした子も、ここに入る）。個別に確かめて回収する: touryou reclaim <nodeId>",
    );
  }
  const shown = `${lines.join("\n")}\n`;
  const expect = values.get("--expect");
  if (!flags.has("--yes")) {
    return {
      exitCode: 2,
      stdout: shown,
      stderr:
        eligible.length === 0
          ? "回収できる子がない。何も実行していない\n"
          : `${values.has("--expect") ? "--expect は、表示だけ（実行には --yes が要る）。" : ""}回収は取り消せない（作業ツリーとブランチが消える）。上の内容でよければ、表示の値を付けて再実行する: "$HOME/.touryou/current/bin/touryou" reclaim-merged --yes --expect ${digest}\n`,
    };
  }
  if (expect === undefined) {
    return usageError(
      `--yes には --expect <digest> が要る（表示した一覧の照合用の値。--yes なしで実行すると、表示される: ${digest}）`,
    );
  }
  if (expect !== digest) {
    return {
      exitCode: 1,
      stdout: shown,
      stderr: `表示した内容のあとで、回収できる子または先端が変わっている（照合の値が違う）。何も回収していない。上の内容を確かめ直して、よければ再実行する: "$HOME/.touryou/current/bin/touryou" reclaim-merged --yes --expect ${digest}\n`,
    };
  }
  if (eligible.length === 0) return { exitCode: 0, stdout: shown, stderr: "" };
  // 実行するときだけ、gh で一致を確認した証拠を記録する（daemon が先端と照合する。記録しても、何も消えない）。
  for (const f of toRecord) {
    const rec = await invoke(
      deps.client,
      `${id}:evidence:${f.nodeId}`,
      "node.mergeEvidence",
      { nodeId: f.nodeId, evidenceKind: "prHead", tip: f.tip, prNumber: f.prNumber },
      isMergeEvidenceResult,
    );
    if (rec.kind === "failure") {
      return {
        exitCode: 1,
        stdout: shown,
        stderr: `${terminalSafe(f.nodeId, 128)} の証拠を記録できなかった（${terminalSafe(rec.failure.code, 40)}）。何も回収していない。一覧を確かめ直す: "$HOME/.touryou/current/bin/touryou" reclaim-merged\n`,
      };
    }
    if (rec.kind !== "ok") return fail(rec);
  }
  // 照合の値は、表示した値と同じ（記録のあとの一覧と同じになる。daemon が、実行の直前に計算し直して照合する）。
  const res = await invoke(
    deps.client,
    id,
    "node.reclaimBatch",
    { expectDigest: expect },
    isBatchResult,
  );
  if (res.kind !== "ok") return fail(res);
  const out = [`回収した: ${res.value.reclaimed.length} 件`];
  for (const n of res.value.reclaimed) out.push(`  - ${terminalSafe(n, 128)}`);
  if (res.value.failed.length > 0) {
    out.push(
      `回収できなかった: ${res.value.failed.length} 件（消していない。確かめ直して、もう一度実行する）`,
    );
    for (const f of res.value.failed) {
      out.push(
        `  - ${terminalSafe(f.nodeId, 128)}: ${terminalSafe(f.code, 40)}: ${terminalSafe(f.cause, 300)}`,
      );
    }
  }
  return {
    exitCode: res.value.failed.length === 0 ? 0 : 1,
    stdout: `${shown}${out.join("\n")}\nrequestId: ${id}\n`,
    stderr: "",
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
  if (command === "inbox" && (rest[0] === "resolve" || rest[0] === "reopen")) {
    command = `inbox-${rest[0]}`;
    rest = rest.slice(1);
  }
  if (command === "discarded") {
    const sub = rest[0];
    if (sub !== "list" && sub !== "restore" && sub !== "drop") {
      return usageError("touryou discarded には、list・restore・drop のどれかを指定する");
    }
    command = `discarded-${sub}`;
    rest = rest.slice(1);
  }
  if (command === "config") {
    if (rest[0] !== "reload") return usageError("touryou config には、reload を指定する");
    command = "config-reload";
    rest = rest.slice(1);
  } else if (command === "policy") {
    if (rest[0] !== "add" && rest[0] !== "remove") {
      return usageError("touryou policy には、add・remove のどちらかを指定する");
    }
    command = `policy-${rest[0]}`;
    rest = rest.slice(1);
  } else if (command === "scope") {
    if (rest[0] !== "decide") return usageError("touryou scope には、decide を指定する");
    command = "scope-decide";
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
  if (command === "config-reload") {
    if (positional.length !== 0) return usageError("touryou config reload に、引数はない");
    const id = requestId ?? deps.newRequestId();
    const res = await invoke(
      deps.client,
      id,
      "config.reload",
      {},
      (v): v is { changed: string[]; restartRequired: string[]; overLimit: string[] } =>
        isRecord(v) &&
        isStringArray(v.changed) &&
        isStringArray(v.restartRequired) &&
        isStringArray(v.overLimit),
    );
    if (res.kind === "failure") return failed(res.failure);
    if (res.kind === "unconfirmed") {
      return unconfirmed(res.reason, `"$HOME/.touryou/current/bin/touryou" config reload`, id);
    }
    const { changed, restartRequired, overLimit } = res.value;
    const lines = [
      `設定を読み込み直した（反映した項目: ${changed.length === 0 ? "なし" : changed.join("・")}）`,
    ];
    if (restartRequired.length > 0) {
      lines.push(
        `反映していない（再起動が要る項目）: ${restartRequired.join("・")}。反映するには daemon を起動し直す`,
      );
    }
    if (overLimit.length > 0) {
      lines.push(
        `新しい上限からはみ出している子（範囲は縮めていない）: ${overLimit.map((n) => terminalSafe(n, 64)).join("・")}`,
      );
    }
    return { exitCode: 0, stdout: `${lines.join("\n")}\nrequestId: ${id}\n`, stderr: "" };
  }
  if (command === "policy-add" || command === "policy-remove") {
    const [list, rule, ...more] = positional;
    if (
      list === undefined ||
      rule === undefined ||
      more.length !== 0 ||
      !["allow", "deny", "ask", "autoApprove"].includes(list)
    ) {
      return usageError(
        `touryou policy ${command === "policy-add" ? "add" : "remove"} <allow|deny|ask|autoApprove> <規則> （規則は 1 つの引数。例: 'Bash(git push:*)'）`,
      );
    }
    const id = requestId ?? deps.newRequestId();
    const res = await invoke(
      deps.client,
      id,
      "policy.ruleChange",
      {
        list: list as "allow" | "deny" | "ask" | "autoApprove",
        rule,
        op: command === "policy-add" ? "add" : "remove",
      },
      (v): v is { changed: boolean } => isRecord(v) && typeof v.changed === "boolean",
    );
    if (res.kind === "failure") return failed(res.failure);
    if (res.kind === "unconfirmed") {
      return unconfirmed(
        res.reason,
        `"$HOME/.touryou/current/bin/touryou" ${argv.join(" ")} --request-id ${id}`,
        id,
      );
    }
    const verb = command === "policy-add" ? "足した" : "外した";
    return {
      exitCode: 0,
      stdout: `${res.value.changed ? verb : "変わらなかった（すでにその状態）"}: ${list} ${terminalSafe(rule, 200)}\nrequestId: ${id}\n`,
      stderr: "",
    };
  }
  if (command === "scope-decide") {
    const [extensionId, decision, ...more] = positional;
    if (
      extensionId === undefined ||
      more.length !== 0 ||
      (decision !== "approve" && decision !== "reject" && decision !== "split")
    ) {
      return usageError(
        "touryou scope decide <拡張要求の ID> <approve|reject|split> [--also-limit]",
      );
    }
    const alsoLimit = flags.has("--also-limit");
    if (alsoLimit && decision !== "approve") {
      return usageError("--also-limit は approve のときだけ付けられる");
    }
    const id = requestId ?? deps.newRequestId();
    const res = await invoke(
      deps.client,
      id,
      "scope.decide",
      { extensionId, decision, ...(alsoLimit ? { alsoLimit: true } : {}) },
      (v): v is { state: string; limitAdded?: boolean } =>
        isRecord(v) &&
        typeof v.state === "string" &&
        (v.limitAdded === undefined || typeof v.limitAdded === "boolean"),
    );
    if (res.kind === "failure") return failed(res.failure);
    if (res.kind === "unconfirmed") {
      return unconfirmed(
        res.reason,
        `"$HOME/.touryou/current/bin/touryou" ${argv.join(" ")} --request-id ${id}`,
        id,
      );
    }
    // 上限に足したかは、daemon の応答を見る（すでに承認済みへの再承認は、規則を足さない）
    const limitNote = !alsoLimit
      ? ""
      : res.value.limitAdded === false
        ? "（すでに承認済みなので、上限には足していない）"
        : "（上限にも足した）";
    return {
      exitCode: 0,
      stdout: `判定した: ${decision}${limitNote}（子の状態 ${terminalSafe(res.value.state, 32)}）\nrequestId: ${id}\n`,
      stderr: "",
    };
  }
  if (command === "inbox") return runInbox(flags, values, positional, requestId, deps);
  if (command === "inbox-resolve" || command === "inbox-reopen") {
    return runInboxResolve(command === "inbox-resolve", positional, requestId, deps);
  }
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
        : unconfirmed(
            res.reason,
            '"$HOME/.touryou/current/bin/touryou" discarded list',
            requestId ?? "-",
          );
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
  if (command === "reclaim-merged") {
    return runReclaimMerged(flags, values, positional, requestId, deps);
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
        nextActions: [
          '"$HOME/.touryou/current/bin/touryou" discarded list で確かめて、鍵（key）を指定する',
        ],
      } as Failure);
    }
    const item = matches[0];
    if (item === undefined) {
      return failed({
        code: "notFound",
        cause: "その保管はない",
        nextActions: ['"$HOME/.touryou/current/bin/touryou" discarded list で名前を確かめる'],
      } as Failure);
    }
    const shown = `消す保管: ${terminalSafe(item.key, 128)}（ノード ${item.nodeId === undefined ? "孤立" : terminalSafe(item.nodeId, 128)}。先端 ${item.tip}）\n`;
    if (!flags.has("--yes")) {
      return {
        exitCode: 2,
        stdout: shown,
        stderr:
          '保管を消すと、取り戻せない（先に "$HOME/.touryou/current/bin/touryou" discarded restore で取り出せる）。上の対象でよければ --yes を付けて再実行する\n',
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
      stdout: `自動の最終削除を保留した: ${nodeId}（${res.value.until === undefined ? "無期限" : `${res.value.until} まで`}）\n有効な予告は取り下げた。人間の "$HOME/.touryou/current/bin/touryou" purge は、保留に関係なく実行できる\nrequestId: ${id}\n`,
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
        stderr: `hook-env は eval で使う: eval "$("$HOME/.touryou/current/bin/touryou" hook-env ${nodeId})"（標準出力が端末のときは、トークンを出さない）\n`,
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
      stdout: `受理した: ${nodeId}（状態: ${terminalSafe(res.value.state, 40)}）\n子のトークンは失効した。回収は "$HOME/.touryou/current/bin/touryou" reclaim ${nodeId}\nrequestId: ${id}\n`,
      stderr: "",
    };
  }

  if (command === "stop") {
    if (!flags.has("--yes")) {
      // 止める子を取り違えないよう、いまの状態と役割を出す（読めなければ ID だけで案内する。#115）
      const listed = await invoke(deps.client, deps.newRequestId(), "tree.list", {}, isTreeList);
      const node =
        listed.kind === "ok" ? listed.value.nodes.find((n) => n.id === nodeId) : undefined;
      if (listed.kind === "ok" && node === undefined) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `ノードが見つからない: ${terminalSafe(nodeId, 128)}（"$HOME/.touryou/current/bin/touryou" tree で一覧を確認する）\n`,
        };
      }
      if (node !== undefined && node.state !== "done") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `止められない: ${nodeId} の状態は ${terminalSafe(node.state, 40)}（人が止められるのは、済んだと報告した done の子だけ。動いている子は、親の統合が止める）\n`,
        };
      }
      const seen =
        node === undefined
          ? ""
          : `${node.title === undefined ? "" : `題: ${terminalSafe(node.title, 80)}\n`}いまの状態: ${terminalSafe(node.state, 40)}・役割: ${terminalSafe(node.role, 40)}・親: ${terminalSafe(node.parentId ?? "なし", 128)}\n`;
      return {
        exitCode: 2,
        stdout: "",
        stderr: `${seen}済んだと報告した（done）子 ${nodeId} を、受理せずに止める。止めると、その子は受理できなくなる（成果は作業ツリーに残り、捨てるかは reclaim で決める）。\nよければ、--yes を付けて再実行する: "$HOME/.touryou/current/bin/touryou" stop ${nodeId} --yes\n`,
      };
    }
    const res = await invoke(
      deps.client,
      id,
      "node.stop",
      { nodeId, mode: "immediate" },
      isReviewed,
    );
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `止めた: ${nodeId}（状態: ${terminalSafe(res.value.state, 40)}）\n停止を確かめたら（状態が stopped になったら）、破棄して回収できる: "$HOME/.touryou/current/bin/touryou" reclaim ${nodeId}\nrequestId: ${id}\n`,
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

  if (command === "reclaim" && values.has("--merged-as")) {
    // 統合済みの証拠の記録（人間の宣言。#239）。ブランチも作業ツリーも消さない。--yes・--expect は使わない。
    if (flags.has("--yes") || values.has("--expect")) {
      return usageError("--merged-as は、証拠を記録するだけ（--yes・--expect とは同時に使えない）");
    }
    const as = values.get("--merged-as") ?? "";
    const rerun = `"$HOME/.touryou/current/bin/touryou" reclaim ${nodeId} --merged-as ${as} --request-id ${id}`;
    let params: Req<"node.mergeEvidence">["params"];
    if (PR_NUMBER.test(as)) {
      const unavailable: CommandResult = {
        exitCode: 1,
        stdout: "",
        stderr: `${GH_UNAVAILABLE}ので、PR 番号は確かめられない。何も記録していない。gh を使えるようにするか、子の先端の 40 桁の SHA を --merged-as に渡して、人が宣言する\n`,
      };
      // PR の base は、子の親のブランチと同じでなければ、証拠にしない（親のブランチは、一覧の候補から取る）。
      const list = await invoke(deps.client, id, "node.reclaimBatchPreview", {}, isBatchPreview);
      if (list.kind !== "ok") return fail(list);
      const base = list.value.candidates.find((c) => c.nodeId === nodeId)?.base;
      if (base === undefined) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "子の親のブランチが分からない（受理済みでない・上流がない、など）ので、PR を証拠にできない。何も記録していない。40 桁の SHA で宣言することはできる\n",
        };
      }
      const repo = await ghRepoOf(deps.gh);
      if (repo === "unavailable") return unavailable;
      if (repo === "invalid") {
        return { exitCode: 1, stdout: "", stderr: "gh が返したリポジトリ名の形が不正。何も記録していない\n" };
      }
      const found = await findMergedPrByNumber(deps.gh, repo, as, base);
      if (found === "unavailable") return unavailable;
      if (found.kind === "none") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `PR #${as} は統合済みの証拠にならない（${found.reason}）。何も記録していない\n`,
        };
      }
      params = {
        nodeId,
        evidenceKind: "prHead",
        tip: found.pr.tip,
        prNumber: found.pr.number,
      };
    } else if (FULL_SHA.test(as)) {
      params = { nodeId, evidenceKind: "human", tip: as };
    } else {
      return usageError(
        "--merged-as は、PR 番号（例: 123）か、40 桁の小文字の 16 進のコミット SHA（短縮は不可）",
      );
    }
    const res = await invoke(deps.client, id, "node.mergeEvidence", params, isMergeEvidenceResult);
    if (res.kind === "failure") return failed(res.failure);
    if (res.kind === "unconfirmed") return unconfirmed(res.reason, rerun, id);
    const kindText =
      params.evidenceKind === "prHead"
        ? `PR #${params.prNumber} の head の SHA が、子の先端と一致した`
        : "人が、この先端は統合済みと宣言した";
    return {
      exitCode: 0,
      stdout: `統合済みの証拠を記録した: ${terminalSafe(nodeId, 128)}（${kindText}${res.value.duplicate ? "。すでに同じ内容を記録済み" : ""}）\n先端が動くと、この証拠は無効になる。回収は、"$HOME/.touryou/current/bin/touryou" reclaim-merged（先端を保管してから、作業ツリーとブランチを消す）\nrequestId: ${id}\n`,
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
    // daemon が作業ツリーの情報を確かめられないノードは、破棄を決めても回収できない。指示を記録せずに、理由と次の操作を出す（Issue #137）。
    if (preview.value.unmet.includes("factsMissing")) {
      return {
        exitCode: 1,
        stdout: shown,
        stderr:
          "回収できない: daemon が、このノードの作業ツリーの情報を確かめられない（作業ツリーが daemon の置き場の外にある・別の場所に登録されている・git を調べられない、など）。破棄は指示していない。\n" +
          "次の操作: git worktree list で、このノードのブランチ（touryou/…）の作業ツリーがどこにあるか確かめる。git が使えるか確かめてから、もう一度 touryou reclaim で確かめ直す\n",
      };
    }
    const digest = tipsDigest(tips);
    const expect = values.get("--expect");
    if (!flags.has("--yes")) {
      return {
        exitCode: 2,
        stdout: shown,
        stderr: `${values.has("--expect") ? "--expect は、表示だけ（実行には --yes が要る）。" : ""}破棄の判断は取り消せない（停止したノードの作業ツリーとブランチが、強制して消える）。上の内容でよければ、表示の値を付けて再実行する: "$HOME/.touryou/current/bin/touryou" reclaim ${nodeId} --yes --expect ${digest}\n`,
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
        stderr: `表示した内容のあとで、先端が変わっている（照合の値が違う）。何も指示していない。上の内容を確かめ直して、よければ再実行する: "$HOME/.touryou/current/bin/touryou" reclaim ${nodeId} --yes --expect ${digest}\n`,
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
        '破棄した成果を保管していた木は、"$HOME/.touryou/current/bin/touryou" discarded list で、その木のノードの保管が（孤立として残っていないか）確かめる',
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
      stderr: `${values.has("--expect") ? "--expect は、表示だけ（実行には --yes が要る）。" : ""}最終削除は取り消せない。上の対象でよければ、表示の値を付けて再実行する: "$HOME/.touryou/current/bin/touryou" purge ${nodeId} --yes --expect ${digest}\n`,
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
      stderr: `表示した内容のあとで、削除される木が変わっている（照合の値が違う）。何も削除していない。上の内容を確かめ直して、よければ再実行する: "$HOME/.touryou/current/bin/touryou" purge ${nodeId} --yes --expect ${digest}\n`,
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
