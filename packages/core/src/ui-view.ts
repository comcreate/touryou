/**
 * HTML 画面の表示モデル（FR_021）。I/O を持たない純粋関数。
 *
 * - **含めるもの**: ノードの識別子・役割・親・状態・依存、未解決の受信箱の項目、未回答の判断、未判定の拡張要求。
 * - **含めないもの**: トークン・秘密・パス（作業ツリーの絶対パス・作業範囲の場所・最終コミットなど）。ただし、拡張要求の対象は、`uiTargetOf` の規則を満たすものだけ載せる。
 *   ブリーフは、目的（objective）の先頭を `UI_TITLE_MAX` で切った題（`title`）だけ載せる（#89）。受け入れ基準・目的の全文・セッションの識別子は含めない。
 * - やり取りの段（`flows`。#89）: 記録から、種類・向き・相手・段（`sent`・`delivered`・`done`）・時刻を導く。利用者の決めで、短い本文（`text`。
 *   上限 `UI_FLOW_TEXT_MAX`）を載せる。載せるのは、画面のほかの所で、いま見える文、またはかつて見えた文だけ（報告〔受信箱の要約〕・判断の問い・範囲の頼みの理由）。
 *   追加指示・判断の答えの文は載せない（画面のどこにも出したことがないため）。
 * - 子が書いた文字列（要約・判断の質問・選択肢・拡張の理由）は、制御文字（タブ・改行は残す）と書式制御文字（U+202E など）を除いて、種類ごとの上限（コードポイント）に切る。
 *   切ったときは、末尾に `UI_CUT_MARK`（「…（省略）」）を付ける。画面は、これを `textContent` だけで描く。
 *   上限: 要約・理由 `UI_TEXT_MAX`（200）、判断の質問 `UI_QUESTION_MAX`（2,000）、選択肢 `UI_OPTION_MAX`（500。サーバーの選択肢の上限と同じ）。
 * - **選択肢は、回答の `choice` に、そのまま送る文字列**なので、切った・文字を除いたものは、そのままでは送れない（`UiOption.truncated`。画面は、ボタンを無効にして、自由入力を促す）。
 * - 件数には上限がある（`UI_LIMITS`）。切ったときは、`truncated` に種類を入れる。
 */

import type { Actor, OrchState } from "./events.js";
import { ID_PATTERN } from "./ids.js";
import { isResolvedByHuman } from "./inbox.js";
import { isStallSummary, PRIORITIES, type Priority, priorityOf } from "./inbox-kinds.js";
import { copyInboxMessage, type InboxMessage } from "./inbox-messages.js";
import type { NodeRole, NodeState } from "./index.js";

export const UI_TEXT_MAX = 200;
/** 判断の質問の上限（コードポイント）。人間が、何を聞かれているかを読んで答えるので、ほかより長い。 */
export const UI_QUESTION_MAX = 2000;
/** 選択肢の上限（サーバーの `LIMITS.optionLength` と同じ）。これを超える・文字を除いたものは、`choice` に使えない。 */
export const UI_OPTION_MAX = 500;
/** 拡張要求の対象の上限（コードポイント）。超えたものは、切らずに隠す（切った値を承認させない）。 */
export const UI_TARGET_MAX = 200;
/** 題（目的の先頭）の上限（コードポイント）。 */
export const UI_TITLE_MAX = 80;
/** 上限で切ったときに、末尾に付ける印。 */
export const UI_CUT_MARK = "…（省略）";
export const UI_LIMITS = {
  nodes: 500,
  inbox: 200,
  decisions: 100,
  extensions: 100,
  options: 10,
  flows: 200,
  /** 人が片付けた項目（「片付けた項目」にたたんで出すもの）。新しい順で、この件数まで。 */
  resolved: 50,
} as const;

export interface UiNode {
  readonly id: string;
  readonly role: NodeRole;
  readonly parentId: string | null;
  readonly state: NodeState;
  readonly dependsOn: readonly string[];
  /** そのノードの未解決の項目の数（要約を除く）。 */
  readonly openItems: number;
  /** 破棄の判断（`node.reclaimInstruct`）が記録済みか。画面は、停止したノードで、指示済みなら、もう一度は出さない。 */
  readonly discarded: boolean;
  /**
   * daemon が直接止められず、停止を親に代行してもらうノード（能力表の `stopDelegated`。Desktop の子と CLI の子）か。真のときだけ付ける。
   * 画面は、停止未完了のこのノードに、停止の宣言（`node.confirmStopped`）を出す。
   */
  readonly stopDelegated?: true;
  /**
   * CLI の子（親が `claude --bg` で起動し、起動を報告した子）か。真のときだけ付ける（#136）。画面は、CLI の子にだけ
   * `claude attach` のコマンドを出し、Desktop の子の文は、CLI の子でない停止の代行のノードにだけ出す。
   */
  readonly cli?: true;
  /** 題: 目的（objective）の先頭を整えて `UI_TITLE_MAX` で切ったもの。目的がなければ、なし。 */
  readonly title?: string;
  /** そのノードの最後の動き（報告・受信箱の項目・指示と受け取り・判断と拡張の要求）の時刻。記録がなければ、なし。 */
  readonly lastActivityAt?: string;
  /**
   * 人の操作が要る数: 未回答の判断・未判定の拡張要求・未解決の「止まっているかも」と停止未完了の項目。
   * `openItems`（未解決の項目すべて）と違い、進み具合・完了・知らせを数えない。
   */
  readonly needsHuman: number;
  /** 作業の状態の 3 段。`turn`: 人の出番（`needsHuman` が 1 以上・停止未完了・未解決の失敗）、`finished`: 終わった、`running`: 進んでいる。 */
  readonly band: UiBand;
}

export const UI_BANDS = ["turn", "running", "finished"] as const;
export type UiBand = (typeof UI_BANDS)[number];

/** 表示モデルを作るときの、状態の外の情報（daemon が渡す）。 */
export interface UiViewOptions {
  /** そのノードの能力表の `stopDelegated`（アダプタの能力表から。省略すると、どのノードにも付けない）。 */
  readonly stopDelegated?: (nodeId: string) => boolean;
}

export interface UiInboxItem {
  readonly id: string;
  readonly kind: string;
  readonly nodeId: string;
  readonly at: string;
  readonly priority: Priority;
  readonly summary?: string;
  /** 全文の参照（報告の ID・判断の ID・拡張要求の ID）。識別子の形のものだけ。 */
  readonly ref?: string;
  /** 「止まっているかもしれない子」の知らせ（`isStallSummary`）。 */
  readonly stall?: true;
  /** daemon が書いた知らせの鍵と値（#140）。画面は、言語を選んで文にし、ないときは `summary` を出す。 */
  readonly msg?: InboxMessage;
}

/**
 * 人が片付けた項目（#99）。画面は「片付けた項目」にたたんで出し、「戻す」（`inbox.reopen`）を付ける。
 * 戻せるのは人が片付けた項目だけなので、システム・ノードが解決にしたものは載せない。
 */
export interface UiResolvedItem {
  readonly id: string;
  readonly kind: string;
  readonly nodeId: string;
  readonly at: string;
  /** 片付けた時刻。 */
  readonly resolvedAt: string;
  readonly summary?: string;
  readonly msg?: InboxMessage;
}

export interface UiOption {
  readonly text: string;
  /** 切った・文字を除いた（`choice` に、そのままは送れない）。画面は、ボタンを無効にして、自由入力を促す。 */
  readonly truncated: boolean;
}

export interface UiDecision {
  readonly id: string;
  readonly nodeId: string;
  readonly question?: string;
  readonly options: readonly UiOption[];
  /** 選択肢が多くて、一部を載せていない（`UI_LIMITS.options` 件まで）。 */
  readonly optionsCut: boolean;
  /**
   * 閉じた理由。いまは `discarded`（破棄を決めた子の未回答）だけ。
   * あるときは、答えても子に届かない。画面は、答える操作を促さず、理由を示す。
   */
  readonly closedReason?: "discarded";
}

export interface UiExtension {
  readonly id: string;
  readonly nodeId: string;
  readonly reason: string;
  /** 要求の対象の種類（write: 書き込みの場所、command: 実行するコマンド）。種類が分からなければ、なし。 */
  readonly kind?: "write" | "command";
  /** 要求の対象。表示してよいもの（`uiTargetOf`）だけ。隠したときは、なし。 */
  readonly target?: string;
  /** 対象を隠した（絶対パス・`..`・制御文字・長すぎる、など）。画面は、承認・切り出しをさせない。 */
  readonly targetHidden: boolean;
  /** 要求の時刻。古い記録にはない。 */
  readonly at?: string;
}

export const UI_FLOW_STAGES = ["sent", "delivered", "done"] as const;
/** やり取りの段。`sent`: 送った・まだ届いていない、`delivered`: 届いた・返事を待っている、`done`: 済んだ。 */
export type UiFlowStage = (typeof UI_FLOW_STAGES)[number];
export const UI_FLOW_KINDS = [
  "instruction",
  "report",
  "done",
  "decision",
  "extension",
  "answer",
  "approved",
  "rejected",
  "split",
] as const;
export type UiFlowKind = (typeof UI_FLOW_KINDS)[number];
/** 人（ノードでない相手）。 */
export const UI_HUMAN = "human";

/**
 * 追加指示のやり取りの種類（#115）。daemon が付けた種類（`node.instructed` の `kind`）だけを見る（文は見ない。だれでも書けるため）。
 * 判断の答えは、判断の記録の側（`answer`）で描くので null（重ねない）。種類のないもの（ふつうの指示・古い記録）は「指示」。
 */
const INSTRUCTION_FLOW: Readonly<Record<string, UiFlowKind | null>> = {
  answer: null,
  extensionApproved: "approved",
  extensionRejected: "rejected",
  extensionSplit: "split",
};
function instructionKind(kind: string | undefined): UiFlowKind | null {
  if (kind === undefined || !Object.hasOwn(INSTRUCTION_FLOW, kind)) return "instruction";
  return INSTRUCTION_FLOW[kind] ?? null;
}

/** やり取りの短い本文の上限（コードポイント）。 */
export const UI_FLOW_TEXT_MAX = 200;

/** やり取り 1 件（#89）。本文は、画面のほかの所で、いま見える文、またはかつて見えた文だけ、短く（`UI_FLOW_TEXT_MAX`）載せる。 */
export interface UiFlow {
  readonly id: string;
  readonly kind: UiFlowKind;
  /** `up`: 子 → 親（または人）、`down`: 親（または人）→ 子。 */
  readonly dir: "up" | "down";
  /** ノードの ID か `UI_HUMAN`。 */
  readonly from: string;
  readonly to: string;
  readonly stage: UiFlowStage;
  readonly sentAt: string;
  readonly deliveredAt?: string;
  readonly doneAt?: string;
  /** 「届いた」の記録がない種類（子 → 親。#102 で足す）。画面は「届いたかは分からない」を示す。 */
  readonly deliveryUnknown?: true;
  /** 「済んだ」を推定で出した（届いたあとの、相手の最初の報告）。 */
  readonly doneInferred?: true;
  /** 短い本文（報告・判断の問い・範囲の頼みの理由だけ。`UI_FLOW_TEXT_MAX` で切る）。空なら、なし。 */
  readonly text?: string;
}

export interface UiView {
  readonly lastSeq: number;
  readonly nodes: readonly UiNode[];
  readonly inbox: readonly UiInboxItem[];
  /** 人が片付けた項目（新しい順。`UI_LIMITS.resolved` 件まで）。 */
  readonly resolved: readonly UiResolvedItem[];
  readonly decisions: readonly UiDecision[];
  readonly extensions: readonly UiExtension[];
  /** やり取り（新しい順。`UI_LIMITS.flows` 件まで）。 */
  readonly flows: readonly UiFlow[];
  /** 上限で切った種類（nodes・inbox・resolved・decisions・extensions・flows）。 */
  readonly truncated: readonly string[];
}

const isControl = (cp: number): boolean =>
  (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f);
const FORMAT_CHAR = /\p{Cf}/u;

/** 制御文字・書式制御文字を除き、`max` コードポイントに切る。`removed`: 文字を除いたか。`cut`: 切ったか（切ったら、末尾に `UI_CUT_MARK`）。 */
function sanitize(x: unknown, max: number): { text: string; removed: boolean; cut: boolean } {
  if (typeof x !== "string") return { text: "", removed: false, cut: false };
  const out: string[] = [];
  let removed = false;
  let cut = false;
  for (const ch of x) {
    if (isControl(ch.codePointAt(0) ?? 0) || FORMAT_CHAR.test(ch)) {
      removed = true;
      continue;
    }
    if (out.length >= max) {
      cut = true;
      break;
    }
    out.push(ch);
  }
  return { text: out.join("") + (cut ? UI_CUT_MARK : ""), removed, cut };
}

/** 制御文字・書式制御文字を除き、`max`（既定 `UI_TEXT_MAX`）コードポイントに切る。切ったら、末尾に `UI_CUT_MARK` を付ける。 */
export function uiText(x: unknown, max: number = UI_TEXT_MAX): string {
  return sanitize(x, max).text;
}

/** 選択肢。そのまま `choice` に送れるのは、切っても文字を除いてもいないものだけ。 */
function uiOption(x: unknown): UiOption {
  const r = sanitize(x, UI_OPTION_MAX);
  return { text: r.text, truncated: r.cut || r.removed };
}

const ABSOLUTE_PATH = /^(?:[/\\~]|[A-Za-z][A-Za-z0-9+.-]*:)/;
// command は許可リスト（これ以外の文字を含むものは隠す。`$`・バッククォート・`{}`・引用符・`~`・`\`・`;|&<>()` など）。
const COMMAND_ALLOWED = /^[A-Za-z0-9._:@%+=,/ -]+$/;
// 単語の先頭の `/`（先頭・空白・`=`・`,`・`:` の直後。絶対パス）と、`-I/usr/lib` のような、短いオプションに続く `/`
const COMMAND_ABSOLUTE_WORD = /(?:^|[\s=,:])\//;
const COMMAND_OPTION_SLASH = /(?:^|\s)-[A-Za-z]\//;
const PARENT_SEGMENT = /(?:^|[\s=,:/\\])\.\.(?:$|[\s,:/\\])/;

/**
 * 拡張要求の対象の表示。表示してよいのは、作業ツリー内の相対パス（write）と、絶対パス・`..` を含まないコマンド（command）だけ。
 * 絶対パス・`..`・制御文字（タブ・改行も）・書式制御文字・空・先頭か末尾に空白がある・長すぎる（`UI_TARGET_MAX` コードポイント超）ものは、**切らずに隠す**
 * （切った値を承認すると、別の対象を許可してしまう）。command は**許可リスト**（`COMMAND_ALLOWED`）に合うものだけを表示し、それ以外の文字を含むものは隠す。承認は、daemon が記録済みの対象をそのまま許可するので、画面の表示と実際の許可は一致する。
 */
export function uiTargetOf(t: unknown): Pick<UiExtension, "kind" | "target" | "targetHidden"> {
  if (typeof t !== "object" || t === null) return { targetHidden: true };
  const { kind, value } = t as { kind?: unknown; value?: unknown };
  if (kind !== "write" && kind !== "command") return { targetHidden: true };
  const hidden = { kind, targetHidden: true } as const;
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) return hidden;
  let length = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || FORMAT_CHAR.test(ch)) return hidden;
    length++;
  }
  if (length > UI_TARGET_MAX) return hidden;
  const bad =
    kind === "write"
      ? ABSOLUTE_PATH.test(value) || PARENT_SEGMENT.test(value)
      : !COMMAND_ALLOWED.test(value) ||
        COMMAND_ABSOLUTE_WORD.test(value) ||
        COMMAND_OPTION_SLASH.test(value) ||
        PARENT_SEGMENT.test(value);
  return bad ? hidden : { kind, target: value, targetHidden: false };
}

/** 識別子の形でなければ、空にする（画面に、形の崩れた文字列を出さない）。 */
const idOf = (x: unknown): string => (typeof x === "string" && ID_PATTERN.test(x) ? x : "");

export function uiViewOf(state: OrchState, options: UiViewOptions = {}): UiView {
  const truncated: string[] = [];
  const cap = <T>(name: string, xs: readonly T[], max: number): readonly T[] => {
    if (xs.length <= max) return xs;
    truncated.push(name);
    return xs.slice(0, max);
  };

  const unresolved = state.inbox.filter((i) => i.resolved === undefined);
  const counts = new Map<string, number>();
  for (const i of unresolved) {
    if (i.kind === "digest") continue;
    counts.set(i.nodeId, (counts.get(i.nodeId) ?? 0) + 1);
  }
  const human = humanCounts(state);
  const last = lastActivity(state);
  const failing = new Set(
    unresolved
      .filter((i) => priorityOf(i) === "failed" && !isStallSummary(i.summary))
      .map((i) => i.nodeId),
  );
  // CLI の子: 親が起動（launch）を done で報告した子（#136）
  const cliChildren = new Set(
    state.parentRequests
      .filter((r) => r.kind === "launch" && r.report?.outcome === "done")
      .map((r) => r.nodeId),
  );
  const nodes = cap("nodes", state.nodes, UI_LIMITS.nodes).map((n): UiNode => {
    const title = titleOf(n.objective);
    const needsHuman = human.get(n.id) ?? 0;
    const at = last.get(n.id);
    return {
      id: idOf(n.id),
      role: n.role,
      parentId: n.parentId === null ? null : idOf(n.parentId),
      state: n.state,
      dependsOn: n.dependsOn.map(idOf).filter((d) => d !== ""),
      openItems: counts.get(n.id) ?? 0,
      discarded: n.discarded !== undefined,
      ...(options.stopDelegated?.(n.id) === true ? { stopDelegated: true as const } : {}),
      ...(cliChildren.has(n.id) ? { cli: true as const } : {}),
      ...(title === "" ? {} : { title }),
      ...(at === undefined ? {} : { lastActivityAt: uiText(at) }),
      needsHuman,
      band: bandOf(n.state, needsHuman, failing.has(n.id)),
    };
  });

  const rank = (p: Priority): number => PRIORITIES.indexOf(p);
  const ranked = unresolved
    .map((i) => ({ i, p: priorityOf(i) }))
    .sort(
      (a, b) =>
        rank(a.p) - rank(b.p) || (a.i.at < b.i.at ? -1 : a.i.at > b.i.at ? 1 : a.i.seq - b.i.seq),
    );
  const inbox = cap("inbox", ranked, UI_LIMITS.inbox).map(({ i, p }): UiInboxItem => {
    const summary = uiText(i.summary);
    const ref = idOf(i.ref);
    return {
      id: idOf(i.id),
      kind: i.kind,
      nodeId: idOf(i.nodeId),
      at: uiText(i.at),
      priority: p,
      ...(summary === "" ? {} : { summary }),
      ...(ref === "" ? {} : { ref }),
      ...(i.kind === "info" && isStallSummary(i.summary) ? { stall: true as const } : {}),
      // 記録の検査を通った形（鍵の形・値の数と長さ・制御文字なし）。値は、画面が textContent で入れる
      ...(i.msg === undefined ? {} : { msg: copyInboxMessage(i.msg) }),
    };
  });

  const resolved = cap(
    "resolved",
    state.inbox
      .filter((i) => i.resolved !== undefined && isResolvedByHuman(i))
      .sort((a, b) => (b.resolved?.seq ?? 0) - (a.resolved?.seq ?? 0)),
    UI_LIMITS.resolved,
  ).map((i): UiResolvedItem => {
    const summary = uiText(i.summary);
    return {
      id: idOf(i.id),
      kind: i.kind,
      nodeId: idOf(i.nodeId),
      at: uiText(i.at),
      resolvedAt: uiText(i.resolved?.at),
      ...(summary === "" ? {} : { summary }),
      ...(i.msg === undefined ? {} : { msg: copyInboxMessage(i.msg) }),
    };
  });

  // open のほか、閉じた判断（止まった子・破棄を決めた子の未回答）も載せ、理由を示す。
  const decisions = cap(
    "decisions",
    state.decisions.filter((d) => d.status === "open" || d.status === "closed"),
    UI_LIMITS.decisions,
  ).map((d): UiDecision => {
    const question = uiText(d.question, UI_QUESTION_MAX);
    const options = d.options ?? [];
    return {
      id: idOf(d.decisionId),
      nodeId: idOf(d.nodeId),
      ...(question === "" ? {} : { question }),
      options: options.slice(0, UI_LIMITS.options).map((o) => uiOption(o)),
      optionsCut: options.length > UI_LIMITS.options,
      ...(d.status === "closed" && d.closedReason !== undefined
        ? { closedReason: d.closedReason }
        : {}),
    };
  });

  const extensions = cap(
    "extensions",
    state.extensions.filter((x) => x.status === "open"),
    UI_LIMITS.extensions,
  ).map(
    (x): UiExtension => ({
      id: idOf(x.extensionId),
      nodeId: idOf(x.nodeId),
      reason: uiText(x.reason),
      ...uiTargetOf(x.target),
      ...(x.requestedAt === undefined ? {} : { at: uiText(x.requestedAt) }),
    }),
  );

  const flows = cap("flows", flowsOf(state), UI_LIMITS.flows);

  return {
    lastSeq: state.lastSeq,
    nodes,
    inbox,
    resolved,
    decisions,
    extensions,
    flows,
    truncated,
  };
}

/** 題: 改行・タブ・続く空白を空白 1 つにまとめ、前後の空白を除いて 1 行にしてから、`UI_TITLE_MAX` で切る。 */
export function titleOf(objective: unknown): string {
  if (typeof objective !== "string") return "";
  return uiText(objective.replace(/\s+/gu, " ").trim(), UI_TITLE_MAX);
}

/** 終わった状態（人の決めが残らないもの）。停止（stopped）は、人の要対応がなければ終わった扱い。 */
const FINISHED_STATES: ReadonlySet<string> = new Set([
  "verified",
  "reclaimable",
  "archived",
  "stopped",
]);

function bandOf(state: NodeState, needsHuman: number, failing: boolean): UiBand {
  if (needsHuman > 0 || state === "stopIncomplete" || (failing && !FINISHED_STATES.has(state)))
    return "turn";
  return FINISHED_STATES.has(state) ? "finished" : "running";
}

/** ノードごとの、人の操作が要る数（`UiNode.needsHuman`）。 */
export function humanCounts(state: OrchState): Map<string, number> {
  const m = new Map<string, number>();
  const add = (id: string): void => {
    m.set(id, (m.get(id) ?? 0) + 1);
  };
  for (const d of state.decisions) if (d.status === "open") add(d.nodeId);
  for (const x of state.extensions) if (x.status === "open") add(x.nodeId);
  for (const i of state.inbox) {
    if (i.resolved !== undefined) continue;
    if (i.kind === "stopIncomplete" || (i.kind === "info" && isStallSummary(i.summary)))
      add(i.nodeId);
  }
  return m;
}

/** ノードごとの最後の動きの時刻。ISO 8601 UTC の文字列は、辞書順で時刻順になる。 */
function lastActivity(state: OrchState): Map<string, string> {
  const m = new Map<string, string>();
  const see = (id: string, at: string | undefined): void => {
    if (typeof at !== "string" || at === "") return;
    const cur = m.get(id);
    if (cur === undefined || at > cur) m.set(id, at);
  };
  for (const r of state.reports) see(r.nodeId, r.at);
  for (const i of state.inbox) see(i.nodeId, i.at);
  for (const i of state.instructions) {
    see(i.nodeId, i.at);
    see(i.nodeId, i.deliveredAt);
  }
  for (const d of state.decisions) see(d.nodeId, d.requestedAt);
  for (const x of state.extensions) see(x.nodeId, x.requestedAt);
  return m;
}

const actorOf = (a: Actor | undefined): string =>
  a !== undefined && "nodeId" in a ? idOf(a.nodeId) || UI_HUMAN : UI_HUMAN;

/**
 * やり取りの段（#89。research.md 9.3）。新しい順（送った時刻、同じなら記録の順）。
 * - 指示（親 → 子）: 受け取りの記録（`deliveredAt`）で `delivered`、そのあとの子の最初の報告で `done`（推定）。
 * - 報告（子 → 親）: 進み具合・範囲外・失敗は、答えを待たないので `done`（届いたかは分からない）。完了の報告は、受理か差し戻しまで `sent`。
 * - 判断・拡張の頼み（子 → 親）: 未回答・未判定は `sent`（届いたかは分からない）、答え・判定・閉じたら `done`。
 * - 答え（人か親 → 子）: そのあとの子の最初の報告で `done`（推定）。それまでは `sent`（届いたかは分からない）。
 */
export function flowsOf(state: OrchState): UiFlow[] {
  const parentOf = new Map<string, string>();
  for (const n of state.nodes)
    parentOf.set(n.id, n.parentId === null ? UI_HUMAN : idOf(n.parentId) || UI_HUMAN);
  const nodeOf = new Map(state.nodes.map((n) => [n.id, n] as const));
  // 子の報告（review は人・親の書いたものなので除く）を、ノードごとに記録の順で
  const reportsBy = new Map<string, { seq: number; at: string }[]>();
  for (const r of state.reports) {
    if (r.kind === "review") continue;
    const xs = reportsBy.get(r.nodeId) ?? [];
    xs.push({ seq: r.seq, at: r.at });
    reportsBy.set(r.nodeId, xs);
  }
  const firstReportAfter = (nodeId: string, seq: number): { seq: number; at: string } | undefined =>
    reportsBy.get(nodeId)?.find((r) => r.seq > seq);
  const lastDone = new Map<string, number>();
  for (const r of state.reports) if (r.kind === "done") lastDone.set(r.nodeId, r.seq);
  // ノードごとの、最後の受理・差し戻しより前の、最後の完了の報告の seq（記録の順に 1 回だけなめる）
  const reviewedDone = new Map<string, number>();
  for (const r of state.reports) {
    if (r.kind !== "done") continue;
    const reviewed = nodeOf.get(r.nodeId)?.reviewedSeq;
    if (reviewed !== undefined && r.seq < reviewed) reviewedDone.set(r.nodeId, r.seq);
  }

  const out: { flow: UiFlow; seq: number }[] = [];
  const push = (flow: UiFlow, seq: number): void => {
    if (flow.from === "" || flow.to === "" || flow.sentAt === "") return;
    out.push({ flow, seq });
  };
  const t = (x: string | undefined): string => uiText(x);
  const body = (x: string | undefined): { text?: string } => {
    const s = uiText(x, UI_FLOW_TEXT_MAX);
    return s.trim() === "" ? {} : { text: s };
  };

  for (const i of state.instructions) {
    const kind = instructionKind(i.kind);
    if (kind === null) continue;
    const to = idOf(i.nodeId);
    const reply =
      i.deliveredSeq === undefined ? undefined : firstReportAfter(i.nodeId, i.deliveredSeq);
    push(
      {
        id: `f-${i.seq}`,
        kind,
        dir: "down",
        from: actorOf(i.actor),
        to,
        stage: reply !== undefined ? "done" : i.deliveredSeq !== undefined ? "delivered" : "sent",
        sentAt: t(i.at),
        ...(i.deliveredAt === undefined ? {} : { deliveredAt: t(i.deliveredAt) }),
        ...(reply === undefined ? {} : { doneAt: t(reply.at), doneInferred: true as const }),
      },
      i.seq,
    );
  }
  for (const r of state.reports) {
    if (r.kind === "review") continue;
    const from = idOf(r.nodeId);
    const done = r.kind === "done";
    // 完了の報告は、最後のもので、ノードがまだ完了の報告の状態（受理・差し戻しの前）なら、返事を待っている
    const node = nodeOf.get(r.nodeId);
    const waiting = done && lastDone.get(r.nodeId) === r.seq && node?.state === "done";
    // 済んだ時刻: 進み具合などは送った時刻。完了の報告は、受理・差し戻しの時刻（記録は最後の 1 回だけなので、
    // その直前の完了の報告にだけ付ける。それより前の完了の報告は、済んだが時刻は分からない）。
    const lastDoneBeforeReview = done ? reviewedDone.get(r.nodeId) : undefined;
    const doneAt = !done ? r.at : lastDoneBeforeReview === r.seq ? node?.reviewedAt : undefined;
    push(
      {
        id: `f-${r.seq}`,
        kind: done ? "done" : "report",
        dir: "up",
        from,
        to: parentOf.get(r.nodeId) ?? UI_HUMAN,
        stage: waiting ? "sent" : "done",
        sentAt: t(r.at),
        ...(waiting || doneAt === undefined ? {} : { doneAt: t(doneAt) }),
        deliveryUnknown: true,
        ...body(r.text),
      },
      r.seq,
    );
  }
  for (const d of state.decisions) {
    const from = idOf(d.nodeId);
    const seq = d.requestedSeq ?? 0;
    if (d.requestedAt === undefined) continue;
    const doneAt =
      d.status === "answered" ? d.answeredAt : d.status === "closed" ? d.closedAt : undefined;
    push(
      {
        id: `f-${seq}`,
        kind: "decision",
        dir: "up",
        from,
        to: parentOf.get(d.nodeId) ?? UI_HUMAN,
        stage: d.status === "open" ? "sent" : "done",
        sentAt: t(d.requestedAt),
        ...(doneAt === undefined ? {} : { doneAt: t(doneAt) }),
        deliveryUnknown: true,
        ...body(d.question),
      },
      seq,
    );
    if (d.status === "answered" && d.answeredSeq !== undefined && d.answeredAt !== undefined) {
      const reply = firstReportAfter(d.nodeId, d.answeredSeq);
      push(
        {
          id: `f-${d.answeredSeq}`,
          kind: "answer",
          dir: "down",
          from: actorOf(d.answeredBy),
          to: from,
          stage: reply === undefined ? "sent" : "done",
          sentAt: t(d.answeredAt),
          ...(reply === undefined
            ? { deliveryUnknown: true as const }
            : { doneAt: t(reply.at), doneInferred: true as const }),
        },
        d.answeredSeq,
      );
    }
  }
  for (const x of state.extensions) {
    if (x.requestedAt === undefined) continue;
    push(
      {
        id: `f-${x.requestedSeq}`,
        kind: "extension",
        dir: "up",
        from: idOf(x.nodeId),
        to: parentOf.get(x.nodeId) ?? UI_HUMAN,
        stage: x.status === "open" ? "sent" : "done",
        sentAt: t(x.requestedAt),
        ...(x.decidedAt === undefined ? {} : { doneAt: t(x.decidedAt) }),
        deliveryUnknown: true,
        ...body(x.reason),
      },
      x.requestedSeq,
    );
  }
  out.sort((a, b) =>
    a.flow.sentAt < b.flow.sentAt ? 1 : a.flow.sentAt > b.flow.sentAt ? -1 : b.seq - a.seq,
  );
  return out.map((x) => x.flow);
}
