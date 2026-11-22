/**
 * daemon が窓口で返す失敗の、原因の文（#141）。種類（鍵）と値で返し、画面が言語（日本語・英語）を選んで文にする。
 *
 * - 受信箱の知らせ（`inbox-messages.ts`、#140）と同じ考え方。daemon は `failureMsg` で、日本語の `cause`
 *   （CLI・skill・MCP が読む。これまでと同じ文）と、画面のための `msg`（鍵と値）を作る。`cause` は残す。
 * - 文は `{名前}` の差し込みだけを持つ（関数・HTML は持たない）。画面は、差し込んだ文を `textContent` で入れる。
 * - 値の名前が `List` で終わるものは、ID を `,` で区切った並び。文にするとき、言語の区切り（ja「、」・en「, 」）でつなぐ
 *   （空なら、ja「なし」・en「none」）。
 * - 値の名前が `名前Key` で、値がこの表の鍵なら、`{名前}` をその鍵の文（同じ言語。1 段だけ）にする。
 * - `msg` のない失敗（古い daemon・未対応の失敗）は、画面が、英語では汎用の文と `code` を出す（日本語の画面は `cause`）。
 * - 次の操作（`nextActions`）は、画面の失敗の帯には出さない（日本語のまま CLI・skill・MCP が読む）。
 */

import { type Failure, type FailureMessage, failure } from "./contract.js";
import { fillMessage, type Lang } from "./inbox-messages.js";

/** 失敗の文の表。鍵は小文字で始まる英数字。ja は、これまでの `cause` と同じ文にする。 */
export const FAILURE_MESSAGES = {
  // ── 取り消せない操作の確認（confirmation-gate.ts）
  confirmationRequired: {
    ja: "取り消せない操作なので、確認待ちにした（まだ実行していない。確認 {short}…）",
    en: "This operation cannot be undone, so it is waiting for confirmation (not run yet; confirmation {short}…)",
  },
  confirmationTooManyFailures: {
    ja: "確認の失敗が多すぎる（少し待つ）",
    en: "Too many failed confirmations (wait a little)",
  },
  confirmationGone: {
    ja: "確認待ちがない（確認済み・取り消し・試行の上限・daemon の再起動で消えた）",
    en: "There is no pending confirmation (it was confirmed, cancelled, used up its attempts, or lost when the daemon restarted)",
  },
  confirmationGoneOnCancel: {
    ja: "確認待ちがない（確認済み・取り消し・期限切れ・daemon の再起動で消えた）",
    en: "There is no pending confirmation (it was confirmed, cancelled, expired, or lost when the daemon restarted)",
  },
  confirmationLocked: {
    ja: "コードが違う。試行の上限に達したので、確認待ちを捨てた（実行していない）",
    en: "Wrong code. The attempt limit was reached, so the pending confirmation was discarded (not run)",
  },
  confirmationWrongCode: {
    ja: "コードが違う（残り {left} 回）",
    en: "Wrong code ({left} attempts left)",
  },
  confirmationExpired: {
    ja: "確認待ちの期限が過ぎた（実行していない）",
    en: "The pending confirmation has expired (not run)",
  },
  confirmationLimit: {
    ja: "確認待ちが多すぎる（{max} 件まで）",
    en: "Too many pending confirmations (up to {max})",
  },
  confirmationUnavailable: {
    ja: "daemon に端末がない（launchd などで動いている）ため、確認のコードを出せない。取り消せない操作は実行していない",
    en: "The daemon has no terminal (it runs under launchd or similar), so it cannot show a confirmation code. The irreversible operation was not run",
  },
  confirmationHumanOnly: {
    ja: "確認は人間だけができる",
    en: "Only a person can confirm",
  },
  requestIdConflict: {
    ja: "同じ requestId が、別の内容の要求に使われている",
    en: "The same requestId was used for a request with different content",
  },
  requestInProgress: {
    ja: "同じ要求を、確認して実行している最中",
    en: "The same request is being confirmed and run right now",
  },
  operationNotImplemented: {
    ja: "操作 {op} は未実装",
    en: "Operation {op} is not implemented",
  },
  // ── 認可（authorize.ts）
  nodeNotInTree: {
    ja: "ノード {node} は木にない",
    en: "Node {node} is not in the tree",
  },
  tokenRoleMismatch: {
    ja: "トークンのロールが、ノードのロールと一致しない",
    en: "The token's role does not match the node's role",
  },
  nodeStateInvalid: {
    ja: "状態 {state} のノードの資格情報は無効",
    en: "Credentials of a node in state {state} are not valid",
  },
  claimedRoleMismatch: {
    ja: "申告のロールが、認証したロールと一致しない",
    en: "The claimed role does not match the authenticated role",
  },
  claimedCallerMismatch: {
    ja: "申告の caller が、認証したノードと一致しない",
    en: "The claimed caller does not match the authenticated node",
  },
  roleLacksOperation: {
    ja: "ロール {role} は操作 {op} を持たない",
    en: "Role {role} does not have operation {op}",
  },
  integratorOperationUnavailable: {
    ja: "操作 {op} は、統合ロールからは（発生元の記録ができるまで）使えない",
    en: "Operation {op} cannot be used from the integrator role (until its origin is recorded)",
  },
  outsideSubtree: {
    ja: "対象のノードが、自分の部分木の規則を満たさない",
    en: "The target node does not satisfy the rules for your own subtree",
  },
  decisionNotFound: { ja: "判断要求が見つからない", en: "The decision request was not found" },
  extensionNotFound: { ja: "拡張要求が見つからない", en: "The scope request was not found" },
  reportNotFound: { ja: "報告が見つからない", en: "The report was not found" },
  // ── 回収（reclaim-handlers.ts）。{when} は whenKey の文
  tipUnknown: {
    ja: "{when}、ブランチの先端を取得できない（不明）ノード: {idsList}",
    en: "{when}, the branch tip could not be read (unknown) for node(s): {idsList}",
  },
  tipMismatch: {
    ja: "{when}、ブランチの先端が、表示した内容（判断のときに確かめた内容）と違う（または、表示になかった）ノード: {idsList}",
    en: "{when}, the branch tip differs from what was shown (what was checked at the decision), or was not shown, for node(s): {idsList}",
  },
  tipUnknownDone: {
    ja: "{when}、ブランチの先端を取得できない（不明）ノード: {idsList}（回収済み: {doneList}）",
    en: "{when}, the branch tip could not be read (unknown) for node(s): {idsList} (already reclaimed: {doneList})",
  },
  tipMismatchDone: {
    ja: "{when}、ブランチの先端が、表示した内容（判断のときに確かめた内容）と違う（または、表示になかった）ノード: {idsList}（回収済み: {doneList}）",
    en: "{when}, the branch tip differs from what was shown (what was checked at the decision), or was not shown, for node(s): {idsList} (already reclaimed: {doneList})",
  },
  whenBeforeReclaim: { ja: "回収の前に", en: "Before reclaiming" },
  whenJustBeforeReclaim: { ja: "回収の直前に", en: "Just before reclaiming" },
  whenBeforeRecordDecision: { ja: "判断の記録の前に", en: "Before recording the decision" },
} as const satisfies Readonly<Record<string, { readonly ja: string; readonly en: string }>>;

export type FailureMessageKey = keyof typeof FAILURE_MESSAGES;

/** 並びが空のときの文字。 */
export const FAILURE_NONE = { ja: "なし", en: "none" } as const satisfies Readonly<Record<Lang, string>>;
/** 並びの区切り（`inbox-messages.ts` の `LIST_SEPS.comma` と同じ）。 */
export const FAILURE_LIST_SEP = { ja: "、", en: ", " } as const satisfies Readonly<Record<Lang, string>>;

/** 値の上限（記録の検査と違い、窓口の応答だけなので、並びのために少し広げる）。 */
export const FAILURE_MESSAGE_LIMITS = { args: 8, value: 1000 } as const;

export const isFailureMessageKey = (k: unknown): k is FailureMessageKey =>
  typeof k === "string" && Object.hasOwn(FAILURE_MESSAGES, k);

const isControl = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return n < 0x20 || n === 0x7f;
};

/** 値を整える（制御文字は空白にし、長ければ切る）。 */
const safeArgs = (args: FailureMessage["args"]): FailureMessage["args"] => {
  const safe: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(args).slice(0, FAILURE_MESSAGE_LIMITS.args)) {
    safe[k] =
      typeof v === "number"
        ? v
        : [...v]
            .map((c) => (isControl(c) ? " " : c))
            .join("")
            .slice(0, FAILURE_MESSAGE_LIMITS.value);
  }
  return safe;
};

/** 並びの値（`,` 区切り）を、言語の区切りでつなぐ。 */
const listText = (lang: Lang, v: string): string => {
  const items = v.split(",").filter((s) => s !== "");
  return items.length === 0 ? FAILURE_NONE[lang] : items.join(FAILURE_LIST_SEP[lang]);
};

/** 言語ごとの文。鍵が表になければ undefined。 */
export function failureMessageText(lang: Lang, m: FailureMessage): string | undefined {
  if (!isFailureMessageKey(m.key)) return undefined;
  const args: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(m.args)) {
    if (k.endsWith("List") && typeof v === "string") args[k] = listText(lang, v);
    else if (k.endsWith("Key") && typeof v === "string" && isFailureMessageKey(v)) {
      args[k.slice(0, -3)] = FAILURE_MESSAGES[v][lang];
    } else args[k] = v;
  }
  return fillMessage(FAILURE_MESSAGES[m.key][lang], args);
}

/**
 * daemon が失敗を返すときの入口。日本語の `cause`（これまでと同じ文）と、画面のための `msg` を作る。
 * 値は、制御文字を除き、長すぎれば切る。
 */
export function failureMsg<K extends FailureMessageKey>(
  code: string,
  key: K,
  args: FailureMessage["args"],
  ...nextActions: readonly [string, ...string[]]
): Failure {
  const msg: FailureMessage = { key, args: safeArgs(args) };
  return { ...failure(code, failureMessageText("ja", msg) ?? "", ...nextActions), msg };
}

/** 窓口から受け取った `msg` の形が正しいか（境界での実行時検査）。 */
export function isFailureMessage(x: unknown): x is FailureMessage {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  const a = m.args;
  return (
    typeof m.key === "string" &&
    typeof a === "object" &&
    a !== null &&
    !Array.isArray(a) &&
    Object.values(a).every((v) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))
  );
}
