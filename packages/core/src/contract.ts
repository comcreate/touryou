/**
 * daemon 窓口の契約型と Result 型（NFR_003, NFR_004, NFR_010）。I/O を持たない型と純粋関数のみ。
 * `mcp`・`cli` は daemon に依存せず、この契約を通して 127.0.0.1 の窓口を呼ぶ（design 3 章）。
 *
 * 仮置きの範囲: 操作名は spec 4.1 の操作一覧に対応する仮の名前で、引数・結果の型は最小限
 * （識別子と主要な項目のみ）。各操作の実装タスクで確定する。境界での値の検証（zod など）は将来課題。
 */

import type { Brief } from "./brief.js";
import type {
  ExtensionTarget,
  MergeEvidenceKind,
  NodeRuntime,
  ReportEvidence,
  ReportKind,
} from "./events.js";
import type { InboxItem } from "./inbox.js";
import type { NodeRole, NodeState } from "./index.js";
import type { Blocker, UnmetReason } from "./reclaim.js";
import type { Scope } from "./scope.js";

/** 失敗の文の鍵と値（#141）。画面が、選んだ言語の文にする。値は、短い文字か数だけ。 */
export interface FailureMessage {
  readonly key: string;
  readonly args: Readonly<Record<string, string | number>>;
}

/** 失敗。原因と次に取るべき操作を必ず持つ（NFR_010）。 */
export interface Failure {
  /** 機械可読な分類。 */
  readonly code: string;
  /** 原因（人が読める説明。日本語。CLI・skill・MCP が読む）。 */
  readonly cause: string;
  /** 次に取るべき操作の候補。1 件以上。 */
  readonly nextActions: readonly [string, ...string[]];
  /**
   * 画面のための、原因の鍵と値（#141。受信箱の知らせの `msg` と同じ考え方）。daemon が窓口の応答にだけ付ける
   * （記録には残さない）。`cause` は、この鍵の日本語の文と同じ。ないとき（古い daemon・未対応の失敗）は、画面が汎用の文を出す。
   */
  readonly msg?: FailureMessage;
}

/** 失敗を作る。次の操作が 1 件もない失敗は作れない（型と実行時の両方で拒否する）。 */
export function failure(
  code: string,
  cause: string,
  ...nextActions: readonly [string, ...string[]]
): Failure {
  if (nextActions.length === 0) {
    throw new RangeError("Failure には次に取るべき操作が 1 件以上必要");
  }
  return { code, cause, nextActions };
}

/** 窓口から受け取った値が `Failure` か（境界での実行時検査）。 */
export function isFailure(x: unknown): x is Failure {
  if (typeof x !== "object" || x === null) return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f.code === "string" &&
    typeof f.cause === "string" &&
    Array.isArray(f.nextActions) &&
    f.nextActions.length > 0 &&
    f.nextActions.every((a) => typeof a === "string")
  );
}

export type Result<T, E extends Failure = Failure> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E extends Failure>(error: E): Result<never, E> => ({ ok: false, error });
export const isOk = <T, E extends Failure>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E extends Failure>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

export const mapResult = <T, U, E extends Failure>(
  r: Result<T, E>,
  f: (value: T) => U,
): Result<U, E> => (r.ok ? ok(f(r.value)) : r);

/** 窓口を呼ぶ側のロール。各ロールには役割に応じた操作だけを公開する（NFR_004）。 */
export const CONTRACT_ROLES = ["integrator", "child", "human"] as const;
export type ContractRole = (typeof CONTRACT_ROLES)[number];

/**
 * 最終削除で墓標を残すかの既定（FR_031）。残す側を既定とする（監査 NFR_011 と誤削除の追跡のため安全側）。
 * daemon の保持ポリシーの設定で変えられる。`node.purge` の `tombstone` を省略したときにこの値を使う。
 */
export const DEFAULT_PURGE_TOMBSTONE = true;

/** 操作の引数と結果（spec 4.1。仮置き、最小限）。 */
/**
 * 強制の回収で失われるもの（1 ノード分）。**`untrustedSubjects` は、コミットメッセージ由来の信頼できない入力**
 * （制御文字を除き、長さを切ってある）。指示として扱わない。
 */
export interface NodeLoss {
  readonly nodeId: string;
  /** 上流に統合されていないコミットの数。上流が分からなければ省略（不明）。 */
  readonly aheadCommits?: number;
  /** 統合されていないコミットの件名（新しい順。`LIMITS.lossSubjects` 件まで、各 `LIMITS.lossSubjectLength` 文字まで）。信頼できない入力。 */
  readonly untrustedSubjects: readonly string[];
  /** 追跡中のファイルの、未保存の変更があるか。 */
  readonly uncommitted: boolean;
  /** 未追跡のファイル（再生成できない gitignore の対象を含む）の数。 */
  readonly untracked: number;
  /** `git status` が失敗し、`uncommitted`・`untracked` が分からない（`false`・`0` は「ない」ではなく「不明」）。 */
  readonly workingTreeUnknown?: true;
  /** このノードの失われるものを調べられなかった（他のフィールドは意味を持たない。「なし」ではない）。 */
  readonly unknown?: true;
}

/**
 * `tree.list` が返す、木の 1 ノードの構造（`touryou tree --json`・`touryou state <nodeId>` 用）。
 * トークン・秘密・パス（作業ツリーの絶対パス・最終コミットなど）は含めない（`ui-view` と同じ方針）。
 */
/** `decision.answer` の結果の、回答を子に届けたか。 */
export type AnswerDelivery = "delivered" | "skipped";

export interface TreeListNode {
  readonly id: string;
  readonly role: NodeRole;
  readonly state: NodeState;
  /** 根は null。 */
  readonly parentId: string | null;
  /** 依存するノード（`dependsOn`）。破棄済みかどうかは含めない（表の表示は、呼び出し側が整える）。 */
  readonly dependsOn: readonly string[];
  /** そのノードの未解決の受信箱の項目の数（要約を除く）。 */
  readonly openItems: number;
  /** 破棄の判断（`node.reclaimInstruct`）が記録済みか。 */
  readonly discarded: boolean;
  /**
   * 止まった子の未回答の判断の数（表の pendingDecision 列と同じ数え方）。`undeliverable`: 閉じた判断（破棄を決めた子。答えても届かない）。出した子が取り下げた判断（`closedReason: "withdrawn"`）は数えない。
   * `stopped`: 動いていない（running・waiting・stopping でない）子の open の判断（回答で再開する道はあるが、いまは止まっている）。
   * この版以降の daemon が付ける（古い daemon にはない。ないときは、表の列を見る）。
   */
  readonly pendingDecisions?: { readonly undeliverable: number; readonly stopped: number };
  /** 題（目的の先頭を整えて切ったもの。状態画面と同じ）。人が呼んだときだけ付ける（統合には付けない）。目的がなければ、なし。古い daemon にはない（#115）。 */
  readonly title?: string;
}

export interface OperationMap {
  // 統合
  /** 子の生成。ブリーフ（spec 5.2）を受ける。作業ツリー・ブランチは params に含めず、アダプタが親ブランチから決める。 */
  "node.spawn": {
    /**
     * `parentSessionId`: 呼んだ親の Claude Code の session_id（mcp が付ける。知らせの宛先）。
     * `runtime`: 子の実行環境（#159）。省略すると daemon の設定 `childRuntime`（既定 cli）。`desktop` は、設定 `allowDesktopChildren` が true のときだけ受ける。
     */
    params: {
      parentId: string;
      role: NodeRole;
      runtime?: NodeRuntime;
      parentSessionId?: string;
    } & Brief;
    /** 依存先が未完了なら `pending`（待っている先行ノードを `waitingFor` に）、そうでなければ起動して `running`。 */
    result: { nodeId: string; status: "running" | "pending"; waitingFor?: string[] };
  };
  /** 追加指示。届いたかではなく、受け付けて（`node.instructed` を記録して）送る段取りに入ったことを返す。 */
  "node.send": {
    params: { nodeId: string; text: string };
    result: { status: "queued"; duplicate: boolean };
  };
  "node.stop": {
    /** 停止。猶予時間（`graceMs`。1〜`MAX_GRACE_MS` の整数）は穏当な停止（graceful）のときだけ指定できる。 */
    params: { nodeId: string } & ({ mode: "graceful"; graceMs?: number } | { mode: "immediate" });
    result: { state: NodeState };
  };
  /**
   * 停止の宣言（FR_036）。daemon が直接止められないノード（能力表の `stopDelegated`）を、親が代わりに止めたと宣言し、
   * 停止未完了（stopIncomplete）から停止済み（stopped）に進める。宣言した者を記録に残す（`node.stopDeclared`）。
   */
  "node.confirmStopped": {
    params: { nodeId: string; note?: string };
    result: { state: NodeState };
  };
  /**
   * フックの受け口（`POST /v1/hook`）の `session_id` の結び付けを外す。`/clear`・`--resume` で session_id が変わったときに使う。
   * 次に来た session_id に結び直す。人間と祖先の統合ノードだけ（本人の子は使えない: 盗まれたトークンで結び直させない）。
   * 結び付けがなくても成功する（`unbound: false`）。外した者を記録に残す（`node.hookUnbound`）。
   */
  "node.hookUnbind": {
    params: { nodeId: string };
    /** `duplicate`: 同じ requestId の再送で、すでに記録済み（もう一度は外さない。`unbound` は false）。 */
    result: { unbound: boolean; duplicate: boolean };
  };
  /**
   * Desktop の子の紐付け（FR_032）。一度きりの紐付けコードを新しく発行し（古いコードは無効）、親が Desktop の
   * タスク生成に渡す起動の文面（ID・ブリーフ・紐付けと報告の手順）を返す。コードは記録しない（応答だけ）。
   */
  "node.adopt": {
    params: AdoptParams;
    result: AdoptResult;
  };
  "node.bindCode": {
    /** `parentSessionId`: 呼んだ親の Claude Code の session_id（mcp が付ける。知らせの宛先）。 */
    params: { nodeId: string; parentSessionId?: string };
    result: { instruction: string; expiresAt: string };
  };
  /**
   * 手動の CLI セッション用の、フック専用のトークンを発行する。人間だけ。`childRuntime: "cli"` の、daemon が管理している
   * 動作中の子だけ。トークンは `POST /v1/hook` だけで使える（ほかの入口では 401）。ノードのトークン（SDK の子）は変えない。
   * 発行し直すと、古いフック用トークンは無効になり、フックの結び付けも外れる。トークンは記録しない（`node.hookTokenIssued` に残すのは nodeId だけ）。
   */
  "node.hookToken": {
    params: { nodeId: string };
    result: { token: string; nodeId: string; daemonUrl: string };
  };
  /**
   * `ackItemIds`（#102。統合ノードだけ）: mcp が前の応答を受け取ったあと、応答に載せた項目の ID を付けて呼ぶ。見える項目のうち、
   * その ID のものを、受け取ったものとして記録する（`inbox.acknowledged`。項目は返さない）。応答は優先度順で件数で分けるので、
   * 子の `ackThrough`（最大の番号）のように番号では指さず、載せた項目だけを指す（載せていない項目を受け取ったことにしない）。
   */
  "inbox.fetch": {
    params: { sinceSeq?: number; ackItemIds?: readonly string[] };
    result: { items: readonly InboxItem[] };
  };
  /**
   * 受信箱の項目を片付ける（人間だけ。#99）。片付けた項目は解決済みになり、「要対応」の数に入らない（記録に残る。`inbox.reopen` で戻せる）。
   * 片付けてよい種類は `HUMAN_RESOLVABLE_KINDS`（progress・done・info）だけ。判断・違反・停止未完了などが 1 件でも含まれると、
   * 何も片付けずに `notResolvable` で失敗する。存在しない ID は `notFound`（何も片付けない）。すでに解決済みの項目は、`alreadyResolved` に入れる（冪等）。
   */
  "inbox.resolve": {
    params: { itemIds: readonly string[] };
    result: { resolved: readonly string[]; alreadyResolved: readonly string[] };
  };
  /**
   * 人間が片付けた項目を、未解決に戻す（人間だけ。#99）。戻せるのは、人間が片付けた項目だけ（システム・ノードが解決にしたものは `notReopenable`）。
   * すでに未解決の項目は、`alreadyOpen` に入れる（冪等）。
   */
  "inbox.reopen": {
    params: { itemIds: readonly string[] };
    result: { reopened: readonly string[]; alreadyOpen: readonly string[] };
  };
  /**
   * 子の受信箱（子のロールだけ。自分のノードの分だけ）。最初にブリーフ（目的・受け入れ基準・範囲・依存）を、続けて、まだ受け取って
   * いない追加の指示（差し戻しの理由・判断の回答を含む）を古い順に返す。`all: true` なら、受け取ったものも含める。返した指示は受け取った
   * ものとして記録する。指示の本文は人や親が書いた文で、子への引用として扱う。
   */
  "child.inbox": {
    /** `ackThrough`: mcp が前の応答を受け取ったあと、その最大の番号を付けて呼ぶ（受け取ったものとして記録する。指示は返さない）。 */
    params: { all?: boolean; ackThrough?: number };
    result: { brief: ChildBriefView; instructions: readonly ChildInstructionView[] };
  };
  /**
   * 親への依頼の中身（設計 6.1・6.2）。子の最も新しい、まだ報告のない依頼（起動・停止・削除）を返す。起動の依頼は、親の skill が
   * そのまま Bash で実行できる、変数のないコマンドの文（`command`）を返す。紐付けのコードは入れない（子の mcp が作業ツリーの git の
   * ディレクトリのファイルから読む）。`model`・`effort` は親のものを渡す（コマンドに書き込む）。`forkSessionRef` を渡すと、
   * そのセッション（親）をフォークして起動する文になる。直接の親か人間だけ。
   */
  "parent.request": {
    params: {
      nodeId: string;
      model?: string;
      effort?: string;
      forkSessionRef?: string;
      /** 親の mcp の plugin の場所（`CLAUDE_PLUGIN_ROOT`。mcp が添える。Claude は書かない）。 */
      pluginRoot?: string;
    };
    result: ParentRequestView;
  };
  /**
   * 親が依頼を実行した結果の報告。`outcome: "done"` の起動の報告は、子のセッションの参照（`sessionRef`）を記録に残す。
   * `agentState` は、親が `claude agents --json` で読んだ子の状態（`need_input` など）。止まっている子は受信箱に出す。
   * 停止・削除の報告は記録まで（停止の確かめと stopped への遷移は、親の報告を受けて daemon が確かめてから）。
   */
  "parent.report": {
    params: {
      nodeId: string;
      requestRef: string;
      outcome: "done" | "failed";
      sessionRef?: string;
      reason?: string;
      agentState?: string;
    };
    result: { recorded: boolean; duplicate: boolean };
  };
  "tree.list": {
    params: Record<string, never>;
    result: { table: string; nodes: readonly TreeListNode[] };
  };
  "decision.present": {
    params: { question: string; options: readonly string[]; pauseNodeIds?: readonly string[] };
    result: { decisionId: string };
  };
  "node.split": {
    /** 切り出し。新しい子のブリーフを受ける（役割は元のノードと同じ。作業ツリー・ブランチはアダプタが決める）。 */
    params: { nodeId: string; keep: "mainline" | "stop" } & Brief;
    result: { newNodeId: string };
  };
  "scope.decide": {
    /**
     * `alsoLimit`: 人間だけが付けられる。承認する対象を、子への付与と同時に、根の上限（`permissions.allow`）にも足す
     * （「上限にも足して承認」。`policy.ruleChanged` を同じ記録で書く。#194 PR4）。`approve` のときだけ。
     */
    params: {
      extensionId: string;
      decision: "approve" | "reject" | "split";
      alsoLimit?: boolean;
    };
    /** `limitAdded`: `alsoLimit` つきのときだけ。この呼び出しで、上限に規則を足したか（承認済みへの再承認は `false`）。 */
    result: { state: NodeState; limitAdded?: boolean };
  };
  /**
   * 設定ファイル config.json の、方針（`rootScope`・`permissions`・`autoApprove`）を読み込み直す（人間だけ。#194 PR4）。
   * 検査（`parseConfig`）に通ったときだけ、方針を入れ替える。ほかの項目が変わっていれば、再起動が要る項目の名前を返し、反映しない。
   * `changed`: 入れ替えた項目の名前。`restartRequired`: 変わっているが、再起動しないと効かない項目の名前。
   * `overLimit`: 新しい上限から、すでに子に付与した範囲がはみ出している子の ID（子の範囲は縮めない）。
   */
  /**
   * 実行中の方針の規則を足す・外す（人間だけ。`policy.ruleChanged` を記録する。#194 PR4）。`deny` は実行中の層にも足せる。
   * `changed`: 状態が変わったか（すでにある規則の足し・ない規則の取り外しは、`false`）。
   */
  "policy.ruleChange": {
    params: {
      list: "allow" | "deny" | "ask" | "autoApprove";
      rule: string;
      op: "add" | "remove";
    };
    result: { changed: boolean };
  };
  "config.reload": {
    params: Record<string, never>;
    result: {
      changed: readonly string[];
      restartRequired: readonly string[];
      overLimit: readonly string[];
    };
  };
  "node.review": {
    /** 完了の判定。差し戻し（reject）には理由（feedback）が必須で、受理（accept）では任意。 */
    params: { nodeId: string } & (
      | { verdict: "accept"; feedback?: string }
      | { verdict: "reject"; feedback: string }
    );
    result: { state: NodeState };
  };
  /**
   * 回収の事前確認。結果は `assessReclaim` の結果の構造（満たしていない条件と、原因のノード・プロセス）。
   * `loss`: 強制の回収（人間が破棄を判断したあと）で失われるもの。対象と配下のノードのうち、失われるものがあるノードごと
   * 。人間が、破棄を指示する前に、内容を確かめるために使う。
   */
  "node.reclaimPreview": {
    params: { nodeId: string };
    result: {
      reclaimable: boolean;
      unmet: readonly UnmetReason[];
      blockers: readonly Blocker[];
      loss?: readonly NodeLoss[];
      /**
       * 人間のロールにだけ返す。対象と配下の、作業ツリーを持ち、ブランチの先端（最終コミット）を取れたノードの先端（nodeId → SHA）。
       * `node.reclaimInstruct` の `expectTips` に、そのまま渡す。取れなかったノードは載らない。
       */
      tips?: Readonly<Record<string, string>>;
    };
  };
  "node.reclaim": { params: { nodeId: string }; result: { reclaimed: readonly string[] } };
  /**
   * 統合済みの証拠の記録・宣言（人間だけ。#239。AI は証拠を作れない）。スカッシュ・リベースでマージした子は、祖先判定では統合済みと
   * 分からないので、人間が、その子のブランチの先端（`tip`）が統合済みだと記録する。`evidenceKind`: `prHead`（マージ済みの PR の head の SHA。
   * 人間の CLI が `gh` で取る）、`human`（人の宣言）。`prNumber`: PR の番号（任意）。
   * daemon は、`tip` が、いまの子のブランチの先端と一致するときだけ記録する（違えば何も記録せず `tipMismatch`）。記録は先端に紐付き、
   * 先端が動いたら無効。状態は変えない。同じ内容の記録が済みなら `duplicate: true`（何も変えない）。
   */
  "node.mergeEvidence": {
    params: { nodeId: string; evidenceKind: MergeEvidenceKind; tip: string; prNumber?: number };
    result: { recorded: true; duplicate: boolean };
  };
  /**
   * 統合済みの子の一括の回収の事前確認（人間だけ。#234）。受理済み（verified）で、親のブランチに統合済み（祖先判定）の子を、
   * 回収できるもの（`eligible`）と、できないもの（理由つき。未コミット・未統合・動作中のプロセスなど）に分けて返す。何も変えない。
   * `digest`: 回収できるものの ID と、ブランチの先端を畳んだ照合の値。`node.reclaimBatch` の `expectDigest` に、そのまま渡す。
   * スカッシュ・リベースでマージした子は、祖先判定では統合済みと分からないので、`notMerged` で対象外に出る（個別の `touryou reclaim` で扱う）。
   */
  "node.reclaimBatchPreview": {
    params: Record<string, never>;
    result: {
      candidates: readonly {
        nodeId: string;
        eligible: boolean;
        unmet: readonly UnmetReason[];
        blockers: readonly Blocker[];
        /** 統合済みの根拠（統合済みと判定できたものだけ）。`ancestor`: 祖先判定。`evidence`: 統合済みの証拠（`node.mergeEvidence`）。 */
        mergedBy?: "ancestor" | "evidence";
        /** 子のブランチ名（CLI が、gh でマージ済みの PR を探す手がかり。信頼できる値だが、端末に出す前に整える）。取れなければ省略。 */
        branch?: string;
      }[];
      digest: string;
    };
  };
  /**
   * 統合済みの子の一括の回収（人間だけ。#234）。`expectDigest` は、事前確認の `digest`。いま計算し直した値と違えば、何も消さずに
   * `digestMismatch`。回収は 1 件ずつ、通常の回収（強制なし）で行い、直前に再判定する（未コミット・未統合に変わったものは飛ばして `failed` に出す）。
   * 強制（`--force`・`-D`）は使わない。
   */
  "node.reclaimBatch": {
    params: { expectDigest: string };
    result: {
      reclaimed: readonly string[];
      failed: readonly { nodeId: string; code: string; cause: string }[];
    };
  };
  /**
   * 受理した直接の子（verified）のブランチを、親のブランチへ fast-forward だけで統合する（Issue #4）。
   * `alreadyIntegrated`: すでに統合済みで、何も変えなかった。`target`: 親のブランチ。`tip`: 統合した子の先端。
   * fast-forward できなければ何も変えずに失敗（`notFastForward`）を返す（人間が統合のしかたを決める）。
   */
  "node.integrate": {
    params: { nodeId: string };
    result: { alreadyIntegrated: boolean; target: string; tip: string };
  };
  "node.capabilities": {
    params: { nodeId: string };
    result: { operations: readonly DaemonOperation[] };
  };
  /** 受信箱の項目（`ref`）の判断要求の内容を読む。 */
  "decision.get": {
    params: { decisionId: string };
    result: {
      decisionId: string;
      nodeId: string;
      status: "open" | "answered" | "closed";
      /** 閉じた理由（`status` が `closed` のとき）。`discarded`: 人が破棄を決めた。`withdrawn`: 出した子が取り下げた。 */
      closedReason?: "discarded" | "withdrawn";
      /** 閉じた時刻（ISO 8601 UTC。`status` が `closed` のとき）。 */
      closedAt?: string;
      question?: string;
      options?: readonly string[];
      answer?: string;
    };
  };
  /** 受信箱の項目（`ref`）の報告の内容を読む。 */
  "report.get": {
    params: { reportId: string };
    result: {
      reportId: string;
      nodeId: string;
      kind: ReportKind;
      text: string;
      evidence?: readonly ReportEvidence[];
    };
  };
  // 子（報告は親へのみ）
  "report.progress": { params: { text: string }; result: { accepted: true } };
  "report.decision": {
    params: { question: string; options: readonly string[] };
    result: { decisionId: string };
  };
  /**
   * 自分が出した、未回答の判断要求を取り下げる（子のロールだけ。#196）。判断は閉じ（`closedReason: "withdrawn"`）、受信箱の項目は
   * 解決済みになる。取り下げた判断で waiting だった子は、ほかに未回答の判断がなければ running に戻る（`resumed`）。
   * 答え済み・閉じた判断、ほかのノードの判断は取り下げられない。親には知らせの項目（info）が 1 件届く。
   */
  "decision.withdraw": {
    params: { decisionId: string };
    result: { withdrawn: true; resumed: boolean };
  };
  "report.outOfScope": { params: { text: string }; result: { accepted: true } };
  "report.done": {
    params: { evidence: readonly { criterion: string; evidence: string }[] };
    result: { accepted: true };
  };
  /** 範囲の拡張要求。対象は書き込み可能な場所（`write`）かコマンド（`command`）の追加。 */
  "scope.extend": {
    params: { target: ExtensionTarget; reason: string };
    result: { extensionId: string };
  };
  // 人間（画面・コマンド）
  "decision.answer": {
    params: { decisionId: string } & ({ choice: string } | { text: string });
    /**
     * `notResumed`: 判断で止めた子のうち、回答で再開しなかった子と理由。再開しなかった子がいるときだけ入る
     * （いなければ、今までどおり `{ accepted: true }`）。
     */
    /**
     * `delivery`: 回答を、判断を出した子に届けたか。`delivered`（追加の指示として届けた・回答を添えて再開した）、`skipped`（届ける手段がない・
     * 子が動いていないので届けなかった。回答は記録済み）。この版以降の daemon が付ける（古い daemon と、回答の配送を持たない構成にはない）。
     */
    result: {
      accepted: true;
      notResumed?: readonly NotResumed[];
      delivery?: AnswerDelivery;
      /** `delivered` のときの届け方。`resumed`: 回答を指示に添えて再開した。`instructed`: 動いている子に追加の指示として届けた（子は受信箱で読む）。 */
      deliveredVia?: "resumed" | "instructed";
    };
  };
  /**
   * 破棄の判断（人間。停止したノードの成果を捨ててよいという判断）。**`expectTips`（必須。空でもよい）**: プレビュー（`node.reclaimPreview` の `tips`）で
   * 表示した、対象と配下のノードのブランチの先端（nodeId → SHA）。対象と配下の停止したノードの今の先端と照合し、1 つでも違えば、何も記録せず
   * `tipMismatch`。表示した先端がない（取れなかった）ノードの先端が、今は取れるときも `tipMismatch`。記録した先端は、強制の回収の直前にも照合する。
   */
  "node.reclaimInstruct": {
    params: { nodeId: string; expectTips: Readonly<Record<string, string>> };
    result: { accepted: true };
  };
  /**
   * 最終削除（FR_031）。最上位の木単位。`tombstone`: 削除後に 1 行の墓標（タイトル、結果、最終コミット、日付）を残すか。
   * 省略時は保持ポリシーの既定に従う（`DEFAULT_PURGE_TOMBSTONE` = 残す。daemon の設定で変えられる）。
   * `expectNodeIds`: 事前確認（`node.purgePreview`）で見せた、削除される木のノード。省略すると照合しない。指定したとき、いま
   * 削除される木のノードの集合と違えば（見せたあとで、木が変わった）、何も消さずに `purgeStale` で失敗する。
   */
  "node.purge": {
    params: { nodeId: string; tombstone?: boolean; expectNodeIds?: readonly string[] };
    result: { purged: readonly string[] };
  };
  /**
   * `node.purge` の事前確認。削除される木（ノード ID）、木全体のアーカイブ日、経過日数、保持期間、墓標に残るタイトルを返す。
   * 実行できないときは、理由を `blockers`（構造化）に列挙する（保持期間・残りのログを畳み込めない〔pauseNodeIds など〕）。
   * 最上位の木でない・アーカイブでない・木の外からの依存（`dependedOn`）は、失敗として返す。何も変えない。
   */
  "node.purgePreview": {
    params: { nodeId: string };
    result: {
      nodeIds: readonly string[];
      archivedAt: string;
      elapsedDays: number;
      retentionDays: number;
      /** 墓標に残るタイトル（目的の先頭行）。 */
      tombstoneTitle: string;
      /** `blockers` が空なら `true`。 */
      purgeable: boolean;
      blockers: readonly { code: string; cause: string }[];
      /** 自動の最終削除の保留（木の中の、有効なもの。`nodeId` は保留をかけたノード）。人間の `node.purge` は、保留に関係なく実行できる。 */
      hold?: { nodeId: string; until?: string; reason?: string };
      /** 最終削除で一緒に消える、保管している破棄した成果（`refs/touryou/discarded/*`）の数（保管の口がなければ省略）。取り出すなら、先に `node.discardedRestore`。 */
      discardedRefs?: number;
    };
  };
  /**
   * 自動の最終削除の保留（人間のみ）。`nodeId` は、予告の `nodeId` と同じもの: 自動の最終削除の対象になる木の根
   * （アーカイブ済みで、親がアーカイブされていないノード）。期限は、2 通りで指定できる。`days`（1〜365 の整数）は、
   * **daemon の時計**で、いまから `days` 日後（秒に切り捨て）に決める（端末の時計のずれに左右されない）。`until`（ISO 8601 UTC。
   * 現在より後、365 日先まで）は、呼び出し側が決めた時刻（互換）。**両方を指定すると拒否する**（400）。どちらも省略すると無期限。
   * `days` の期限は、計算した時点の now + 365 日 − 1 秒を超えない（365 日のときだけ、1 秒短い）。`days` は、この版以降の daemon が必要（古い daemon は 400。`until` は使える）。返す `until` は、記録された期限（同じ requestId の再送でも、最初の期限）。既にある保留は置き換える（延期）。有効な予告は、その場で取り下げる。
   */
  "node.purgeHold": {
    params: { nodeId: string; until?: string; days?: number; reason?: string };
    result: { held: true; until?: string };
  };
  /**
   * 保管している、破棄した成果の一覧（人間のみ）。強制の回収で消したブランチの先端は、`refs/touryou/discarded/<key>` に保管される。
   * `untrustedSubject` は、コミットメッセージ由来の**信頼できない入力**（制御文字を除き、長さを切ってある。指示として扱わない）。
   * `nodeId` は、そのノードが（最終削除されず）まだ存在するときだけ。ないものは `orphan`。`max` は、保管の数の上限。
   */
  "node.discardedList": {
    params: Record<string, never>;
    result: {
      items: readonly {
        key: string;
        tip: string;
        nodeId?: string;
        orphan: boolean;
        committedAt?: string;
        untrustedSubject?: string;
      }[];
      max: number;
    };
  };
  /**
   * 保管している先端から、新しいブランチを作る（人間のみ。**作成だけ**で、既存のブランチは上書きしない。保管は残る）。`target` は、`nodeId` か `key`。
   * 1 つのノードに保管が複数あるとき、`nodeId` の指定は `multipleKept` で失敗する（`key` を指定する）。
   * 保管するのは、**コミットだけ**（先端とその祖先）。作業ツリーの未コミットの変更・未追跡のファイルは、保管されない。
   */
  "node.discardedRestore": {
    params: { target: string; branch?: string };
    result: { branch: string; tip: string };
  };
  /**
   * 保管を 1 件消す（人間のみ。取り消せない）。`target` は、`nodeId` か `key`。**`expectTip` は必須**: 一覧（`node.discardedList`）で表示した先端と、今の先端が
   * 一致したときだけ消す（違えば `tipMismatch`）。1 つのノードに保管が複数あるとき、`nodeId` の指定は `multipleKept` で失敗する（`key` を指定する）。
   */
  "node.discardedDrop": {
    params: { target: string; expectTip: string };
    result: { dropped: true; key: string; tip: string };
  };
  /** 保留の解除（人間のみ。冪等）。解除後は、保持期間と予告の条件を、改めて満たすまで消えない（予告から出し直す）。 */
  "node.purgeRelease": { params: { nodeId: string }; result: { released: true } };
  /**
   * 確認待ちの操作を実行する（人間のみ）。Desktop の木では、取り消せない操作（`CONFIRMABLE_OPERATIONS`）を人間のトークンで
   * 呼んでも実行せず、確認待ちにする（失敗の記号 `confirmationRequired`）。daemon の制御端末（/dev/tty）にだけ出した
   * `code` を打つと、元の要求を 1 回だけ実行し、その結果を `result` に入れて返す。
   */
  "confirm.approve": {
    params: { confirmationId: string; code: string };
    result: {
      executed: true;
      operation: ConfirmableOperation;
      result: Readonly<Record<string, unknown>>;
    };
  };
  /** 確認待ちを捨てる（人間のみ）。 */
  "confirm.cancel": { params: { confirmationId: string }; result: { cancelled: true } };
}

/**
 * Desktop の木で、画面での確認（端末に出たコード）がないと実行しない操作。どれも取り消せない
 * （木を消す・保管した成果を消す・成果を捨てる判断）。
 */
export const CONFIRMABLE_OPERATIONS = [
  "node.purge",
  "node.discardedDrop",
  "node.reclaimInstruct",
] as const;
export type ConfirmableOperation = (typeof CONFIRMABLE_OPERATIONS)[number];

/** 画面に出す確認待ち。コードは含めない。 */
export interface PendingConfirmation {
  readonly confirmationId: string;
  /** 端末の行と見比べるための、確認の番号の先頭。 */
  readonly shortId: string;
  readonly operation: ConfirmableOperation;
  /** 対象（`nodeId` か `target`）。 */
  readonly target: string;
  /** ISO 8601 UTC。 */
  readonly expiresAt: string;
  /** 残りの試行回数。 */
  readonly attemptsLeft: number;
}

export type DaemonOperation = keyof OperationMap;

/**
 * 判断の回答で、子を再開しなかった理由。1 つの子に複数が当てはまるときは、この順で最初のもの:
 * `discarded`（破棄の判断を経た）> `stoppedAfterStopIncomplete`（判断の要求のあと、停止未完了を経て止め直された〔retryStop〕）>
 * `stoppedByOther`（この判断のほかに止められた）。
 */
export type NotResumedReason = "discarded" | "stoppedAfterStopIncomplete" | "stoppedByOther";
export const NOT_RESUMED_REASONS: readonly NotResumedReason[] = [
  "discarded",
  "stoppedAfterStopIncomplete",
  "stoppedByOther",
];
export interface NotResumed {
  readonly nodeId: string;
  readonly reason: NotResumedReason;
}

/** `child.inbox` のブリーフ。 */
export interface ChildBriefView {
  readonly nodeId: string;
  readonly objective?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly scope?: Scope;
  readonly dependsOn: readonly string[];
}

/** `child.inbox` の指示。`seq` は知らせの番号（6.2b の「番号 N」）。 */
export interface ChildInstructionView {
  readonly seq: number;
  readonly at: string;
  /** 指示の本文（引用）。 */
  readonly quotedText: string;
  /** 前に受け取ったものか（`all: true` のときだけ真がある）。 */
  readonly received: boolean;
}

/** 親への依頼の種類（設計 6.1 の ParentRequest）。 */
export type ParentRequestKind = "launch" | "stop" | "remove";
export const PARENT_REQUEST_KINDS: readonly ParentRequestKind[] = ["launch", "stop", "remove"];

/** `parent.request` の結果。 */
export interface ParentRequestView {
  readonly requestRef: string;
  readonly nodeId: string;
  readonly kind: ParentRequestKind;
  /** 親が Bash でそのまま実行する文（変数なし・値は引用済み）。 */
  readonly command: string;
  /** 実行のあとにすること（`parent_report` で報告する、など）。 */
  readonly next: string;
}

/**
 * 既存の作業ツリーを子ノードとして採用する（#163）。親（`parentId`）の下に、`worktree`（`repoRoot` に登録済みの実パス）と
 * `branch`（その作業ツリーで検出している、親のブランチを上流にしたブランチ）を持つノードを作る。作業ツリー・ブランチは動かさない。
 * `scope` は親の範囲（根の子は根の範囲）の部分集合に限る。
 */
export interface AdoptParams {
  readonly parentId: string;
  readonly role: NodeRole;
  readonly worktree: string;
  readonly branch: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly scope: Scope;
  /** 既存セッションの参照（`claude agents --json` の id。停止の依頼に使う。任意）。 */
  readonly sessionRef?: string;
  /** 呼んだ親の Claude Code の session_id（mcp が付ける。知らせの宛先）。 */
  readonly parentSessionId?: string;
}

export interface AdoptResult {
  readonly nodeId: string;
  /** 採用した作業ツリーとブランチ（検査で確かめたもの）。 */
  readonly worktree: string;
  readonly branch: string;
  /** 未コミットの変更があるまま採用したか。 */
  readonly dirty: boolean;
  /** 既存セッションに伝える手順（child_bind の前に /mcp で再接続する、など）。 */
  readonly instruction: string;
  /** `duplicate`: 同じ requestId の再送で、すでに記録済み。 */
  readonly duplicate: boolean;
}

/**
 * 子の操作。子のロールが持つ。サブ統括（親を持つ統合ノード。#168）も、自分の親に対して同じ操作を使う（完了の報告・範囲の拡張・
 * 自分の受信箱の読み取りなど）ので、統合ロールの操作にも足す。根（親がない）は使えない（`INTEGRATOR_OPERATION_CLASS` の `self`）。
 */
const CHILD_OPERATIONS = [
  "report.progress",
  "report.decision",
  "decision.withdraw",
  "report.outOfScope",
  "report.done",
  "scope.extend",
  "child.inbox",
] as const;

/** ロールごとに公開する操作（NFR_004）。`node.purge`・`node.purgePreview` は人間のコマンドだけ（DC_003）。 */
export const ROLE_OPERATIONS = {
  integrator: [
    "node.spawn",
    "node.adopt",
    "node.send",
    "node.stop",
    "node.confirmStopped",
    "node.hookUnbind",
    "node.bindCode",
    "inbox.fetch",
    "tree.list",
    "decision.present",
    "node.split",
    "scope.decide",
    "node.review",
    "node.integrate",
    "node.reclaimPreview",
    "node.reclaim",
    "node.capabilities",
    "decision.get",
    "report.get",
    "parent.request",
    "parent.report",
    ...CHILD_OPERATIONS,
  ],
  child: CHILD_OPERATIONS,
  human: [
    "inbox.fetch",
    "inbox.resolve",
    "inbox.reopen",
    "tree.list",
    "decision.get",
    "decision.answer",
    // 人間が止められるのは、済んだと報告した（done）が受理していない子だけ（受理せずに破棄して回収するため。#115）
    "node.stop",
    "node.confirmStopped",
    "node.review",
    "node.bindCode",
    "node.hookUnbind",
    "node.hookToken",
    "scope.decide",
    "config.reload",
    "policy.ruleChange",
    "node.reclaimInstruct",
    // 統合済みの証拠の記録・宣言は、人間だけ（AI は証拠を作れない。integrator・child・root・Desktop の子には足さない）
    "node.mergeEvidence",
    "node.reclaimPreview",
    "node.reclaimBatchPreview",
    "node.reclaimBatch",
    "node.purge",
    "node.purgePreview",
    "node.purgeHold",
    "node.purgeRelease",
    "node.discardedList",
    "node.discardedRestore",
    "node.discardedDrop",
    "confirm.approve",
    "confirm.cancel",
    "parent.request",
    "parent.report",
  ],
} as const satisfies Record<ContractRole, readonly DaemonOperation[]>;

export type RoleOperation<R extends ContractRole> = (typeof ROLE_OPERATIONS)[R][number];

/** 操作の一覧（重複なし）。 */
export const DAEMON_OPERATIONS: readonly RoleOperation<ContractRole>[] = [
  ...new Set(CONTRACT_ROLES.flatMap((r) => ROLE_OPERATIONS[r])),
];

/** 部分木の規則: 対象は、呼び出した統合ノードの、自分自身を含まない子孫／直接の子／自分自身か子孫。 */
export type SubtreeRule = "strictDescendant" | "directChild" | "selfOrDescendant";

/** 統合ノードの、呼び出し側のノードの部分木では判定しない操作（一覧系は、呼び出し側で絞る）。 */
type NonSubtreeIntegratorOperation =
  | "inbox.fetch"
  | "tree.list"
  | (typeof CHILD_OPERATIONS)[number];
export type SubtreeOperation = Exclude<RoleOperation<"integrator">, NonSubtreeIntegratorOperation>;

/**
 * 統合ノードの、ノード・判断・報告を指す操作の、部分木の規則（spec 4.1）。対象は、`caller` の部分木に限る。
 * - `strictDescendant`: 自分自身を含まない子孫。自分の停止・自分への指示は、親か人間だけができる。
 * - `directChild`: 完了の判定（受理・差し戻し）は、直接の親だけ。
 * - `selfOrDescendant`: 自分か子孫。子の生成（`parentId`）と、記録（判断・報告）の読み取り（記録のノード）。
 * `decision.present` は `pauseNodeIds` のすべてに、`node.spawn` は `parentId` に適用する。
 * 型で網羅を保証する（統合ノードの操作を足すと、ここか `INTEGRATOR_OPERATION_CLASS` の例外に足すまでコンパイルできない）。
 * 適用は窓口（daemon の `authorize`）。
 */
export const SUBTREE_RULES: Readonly<Record<SubtreeOperation, SubtreeRule>> = {
  "node.spawn": "selfOrDescendant",
  "node.adopt": "selfOrDescendant", // 対象は採用先の親（`parentId`）。spawn と同じ
  "node.send": "strictDescendant",
  "node.stop": "strictDescendant",
  "node.confirmStopped": "strictDescendant",
  "node.bindCode": "strictDescendant",
  "node.hookUnbind": "strictDescendant",
  "node.split": "strictDescendant",
  "node.review": "directChild",
  "node.integrate": "directChild",
  "node.reclaimPreview": "strictDescendant",
  "node.reclaim": "strictDescendant",
  "node.capabilities": "strictDescendant",
  "decision.present": "strictDescendant",
  "scope.decide": "strictDescendant", // 対象は拡張の発生元のノード（拡張要求の `nodeId`）。人間は全ノード
  "decision.get": "selfOrDescendant",
  "report.get": "selfOrDescendant",
  "parent.request": "directChild",
  "parent.report": "directChild",
};

export const SUBTREE_SCOPED_OPERATIONS = Object.keys(SUBTREE_RULES) as readonly SubtreeOperation[];

/**
 * 統合ノードの操作の分類（型で網羅）。`subtree`: `SUBTREE_RULES` で判定する。`callerFiltered`: 呼び出し側の部分木に
 * 絞った結果だけを返す（ハンドラの責務。`visibleState` を使う）。`denied`: 発生元の記録がまだないので、記録ができる
 * までは統合ロールからの呼び出しを拒否する（`scope.decide`。フェイルクローズ）。`self`: 呼び出したノード自身の分だけを扱う子の操作
 * （サブ統括が自分の親へ使う。#168）。対象は呼び出し側の資格情報で決まり、親を持たない根は拒否する。
 */
export const INTEGRATOR_OPERATION_CLASS: Readonly<
  Record<RoleOperation<"integrator">, "subtree" | "callerFiltered" | "denied" | "self">
> = {
  "report.progress": "self",
  "report.decision": "self",
  "decision.withdraw": "self",
  "report.outOfScope": "self",
  "report.done": "self",
  "scope.extend": "self",
  "child.inbox": "self",
  "node.spawn": "subtree",
  "node.adopt": "subtree",
  "node.send": "subtree",
  "node.stop": "subtree",
  "node.confirmStopped": "subtree",
  "node.bindCode": "subtree",
  "node.hookUnbind": "subtree",
  "inbox.fetch": "callerFiltered",
  "tree.list": "callerFiltered",
  "decision.present": "subtree",
  "node.split": "subtree",
  "scope.decide": "subtree",
  "node.review": "subtree",
  "node.integrate": "subtree",
  "node.reclaimPreview": "subtree",
  "node.reclaim": "subtree",
  "node.capabilities": "subtree",
  "decision.get": "subtree",
  "report.get": "subtree",
  "parent.request": "subtree",
  "parent.report": "subtree",
};

/**
 * 窓口への要求の封筒。`requestId` で冪等にする（NFR_003）。`requestId` は `isSafeId` の形式（英数字で始まり、
 * 英数字と `.` `_` `:` `-` のみ、128 文字以下）。窓口（daemon）と cli が同じ規則で検査する。
 * ロールが持たない操作は型で表せない。
 */
export type DaemonRequest<R extends ContractRole = ContractRole> = {
  [Role in R]: {
    [Op in RoleOperation<Role>]: {
      readonly requestId: string;
      readonly role: Role;
      /** 呼び出したノード。クライアントは指定せず、daemon が認証（ノード専用の資格情報）で決めて付ける。 */
      readonly caller?: { readonly nodeId: string };
      readonly operation: Op;
      readonly params: OperationMap[Op]["params"];
    };
  }[RoleOperation<Role>];
}[R];

/** 窓口からの応答。成功も失敗も Result にそろえる。 */
export type DaemonResponse<Op extends DaemonOperation = DaemonOperation> = Result<
  OperationMap[Op]["result"]
>;

/** touryou の plugin の名前（plugin/.claude-plugin/plugin.json の name。道具・skill の名前空間）。名前を変えるときは、ここを直す。 */
export const PLUGIN_NAME = "touryou";

/**
 * mcp の道具の名前（接頭辞なし）。操作名の `.` を `_` にする。`child.inbox` は、子では `inbox_fetch`（統合の `inbox.fetch` と
 * 同じ名前で、ロールごとに片方だけが出る）、統合（サブ統括）では `child_inbox`（`inbox_fetch` は統合の受信箱）。
 */
export const mcpToolName = (op: DaemonOperation, role: "integrator" | "child"): string =>
  op === "child.inbox"
    ? role === "child"
      ? "inbox_fetch"
      : "child_inbox"
    : op.replaceAll(".", "_");

/** 子のセッションに出る touryou の mcp の道具の名前（接頭辞なし）。紐付けの道具と、ROLE_OPERATIONS.child の操作（mcp の toolName と同じ変換）。 */
export const CHILD_MCP_TOOL_NAMES: readonly string[] = [
  "child_bind",
  "whoami",
  ...ROLE_OPERATIONS.child.map((op) => mcpToolName(op, "child")),
];

/**
 * 統合のセッション（root・サブ統括）に出る touryou の mcp の道具の名前（接頭辞なし）。`whoami` と、ROLE_OPERATIONS.integrator の操作
 * （mcp の toolName と同じ変換）。サブ統括の起動時の許可の一覧に使う。紐付けの道具 `child_bind` は含めない（統合は紐付け済みで起動するため）。
 */
export const INTEGRATOR_MCP_TOOL_NAMES: readonly string[] = [
  "whoami",
  ...ROLE_OPERATIONS.integrator.map((op) => mcpToolName(op, "integrator")),
];

/** ロール別の、セッションに出る touryou の mcp の道具の名前（接頭辞なし）。`human` は mcp の道具を持たない。 */
export const MCP_TOOL_NAMES_BY_ROLE = {
  integrator: INTEGRATOR_MCP_TOOL_NAMES,
  child: CHILD_MCP_TOOL_NAMES,
} as const satisfies Partial<Record<ContractRole, readonly string[]>>;

/**
 * 親（統合）のセッションで、確認なしにしてよい、読むだけの touryou の道具（接頭辞なし）。`/setup` の案内の Allow の例と、
 * 「記録（イベント）を書かない」ことの試験が、この一覧を見る。ものを変える道具（書く・起動・停止・判定・回収・`node_bindCode`）と、
 * 起動のコマンドを返して Bash で実行させる入口の `parent_request` は入れない（確認の画面で目で止めるため）。
 */
export const PARENT_READONLY_TOOL_NAMES: readonly string[] = [
  "whoami",
  "inbox_fetch",
  "tree_list",
  "node_capabilities",
  "decision_get",
  "report_get",
  "node_reclaimPreview",
];

/** plugin から入れた親の道具の名前（`mcp__plugin_<PLUGIN_NAME>_node__<道具>`）。Allow の例に使う。 */
export const pluginToolName = (tool: string): string => `mcp__plugin_${PLUGIN_NAME}_node__${tool}`;

const OWN_MCP_RE = new RegExp(
  `^mcp__(?:plugin_${PLUGIN_NAME.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}_)?node__([A-Za-z_]+)$`,
);

/** touryou の mcp の道具の名前（`mcp__node__<道具>` と、plugin から入れたときの `mcp__plugin_<plugin>_node__<道具>`）から、道具の名前を取る。違えば undefined。 */
export const ownMcpToolOf = (name: string): string | undefined => OWN_MCP_RE.exec(name)?.[1];

/**
 * 自ノードの touryou の MCP サーバーの道具か。`ownMcpToolOf` の形に加えて、サーバーの名前の前置き（`mcp__node__`・
 * `mcp__plugin_<plugin>_node__`）で見る（道具の名前が変わっても、親の道具を子に付与しない。#194 PR3）。
 */
export const isOwnMcpServerTool = (name: string): boolean =>
  ownMcpToolOf(name) !== undefined ||
  name.startsWith("mcp__node__") ||
  name.startsWith(`mcp__plugin_${PLUGIN_NAME}_node__`);
