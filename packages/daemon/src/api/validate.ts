/**
 * 窓口への要求の検証。封筒（requestId・operation・params）と、操作ごとの引数の形を検査する。
 * 入力は信頼しない: 余計なキー・欠けたキー・型の違い・上限（`LIMITS`）超過・禁止文字（`isBoundedText`）は
 * `invalidRequest` で拒否する（フェイルクローズ）。例外は出さない。
 *
 * 封筒の `role`・`caller` は申告として読むだけで、判定には使わない（呼び出したロールとノードは、認証で決める）。
 */

import {
  type Brief,
  briefProblem,
  DAEMON_OPERATIONS,
  type DaemonOperation,
  failure,
  ID_MAX_LENGTH,
  isAgentState,
  isBoundedText,
  isCommitSha,
  isPrNumber,
  isSafeId,
  isSessionId,
  isSessionRef,
  isValidInboxTime,
  LIMITS,
  MAX_GRACE_MS,
  MAX_PR_NUMBER,
  MERGE_EVIDENCE_KINDS,
  NODE_ROLES,
  NODE_RUNTIMES,
  type OperationMap,
  pauseNodeIdsProblem,
  type Result,
} from "@touryou/core";
import { isEffort, isModelName } from "../sdk/launch-command.js";

/** `node.reclaimInstruct` の `expectTips` の件数の上限（対象と配下のノード数の上限）。 */
const EXPECT_TIPS_MAX = LIMITS.expectTips;

type Rec = Record<string, unknown>;
type Failure = ReturnType<typeof failure>;

export interface Envelope {
  readonly requestId: string;
  readonly operation: DaemonOperation;
  readonly params: unknown;
  /** 申告されたロール（判定には使わず、認証したロールと食い違えば拒否するために読む）。 */
  readonly claimedRole?: string;
  /** 申告された caller の nodeId（同上）。 */
  readonly claimedCaller?: string;
}

const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const OPERATIONS: ReadonlySet<string> = new Set(DAEMON_OPERATIONS);

const bad = (cause: string): Failure =>
  failure("invalidRequest", cause, "要求の形を確認する", "操作の引数の仕様を確認する");

const hasOnly = (o: Rec, allowed: readonly string[]): boolean =>
  Object.keys(o).every((k) => allowed.includes(k));

/** 要求の封筒を検査する。 */
export function parseEnvelope(body: unknown): Result<Envelope, Failure> {
  if (!isRec(body)) return { ok: false, error: bad("本文が JSON のオブジェクトでない") };
  if (!hasOnly(body, ["requestId", "operation", "params", "role", "caller"])) {
    return { ok: false, error: bad("封筒に未知のキーがある") };
  }
  const { requestId, operation, params, role, caller } = body;
  if (!isSafeId(requestId)) {
    return {
      ok: false,
      error: bad(
        `requestId が不正（英数字で始まり、英数字と . _ : - のみ、${ID_MAX_LENGTH} 文字以下）`,
      ),
    };
  }
  if (typeof operation !== "string" || !OPERATIONS.has(operation)) {
    return {
      ok: false,
      error: failure("unknownOperation", "未知の操作", "公開されている操作の一覧を確認する"),
    };
  }
  if (!isRec(params)) return { ok: false, error: bad("params が JSON のオブジェクトでない") };
  if (role !== undefined && typeof role !== "string") {
    return { ok: false, error: bad("role が文字列でない") };
  }
  if (
    caller !== undefined &&
    !(isRec(caller) && typeof caller.nodeId === "string" && hasOnly(caller, ["nodeId"]))
  ) {
    return { ok: false, error: bad("caller が { nodeId } でない") };
  }
  return {
    ok: true,
    value: {
      requestId,
      operation: operation as DaemonOperation,
      params,
      ...(role === undefined ? {} : { claimedRole: role }),
      ...(isRec(caller) ? { claimedCaller: caller.nodeId as string } : {}),
    },
  };
}

// ---- 引数の検査 ----

class Invalid extends Error {}
const fail = (cause: string): never => {
  throw new Invalid(cause);
};

const id = (o: Rec, key: string): string => {
  const v = o[key];
  if (!isSafeId(v))
    fail(`${key} が不正（英数字で始まり、英数字と . _ : - だけの ${ID_MAX_LENGTH} 文字以下）`);
  return v as string;
};
const text = (o: Rec, key: string, max: number): string => {
  const v = o[key];
  if (!isBoundedText(v, max)) fail(`${key} が不正（${max} 文字以下の文字列。制御文字なし）`);
  return v as string;
};
/** 空白だけの文字列を許さない（core の `report.added` の検査と同じ規則）。 */
const nonBlank = (o: Rec, key: string, max: number): string => {
  const v = text(o, key, max);
  if (v.trim() === "") fail(`${key} が空（空白だけは不可）`);
  return v;
};
/** ISO 8601 UTC（`...Z`）の日時。範囲（現在より後・上限）は、core の fold が検査する。 */
const isoUtc = (o: Rec, key: string): string => {
  const v = o[key];
  if (typeof v !== "string" || !isValidInboxTime(v))
    fail(`${key} が不正（ISO 8601 UTC。例: 2026-12-01T00:00:00Z）`);
  return v as string;
};
/** 保留の日数（1〜`LIMITS.purgeHoldMaxDays` の整数）。 */
const holdDays = (o: Rec): number => {
  const v = o.days;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > LIMITS.purgeHoldMaxDays)
    fail(`days は 1〜${LIMITS.purgeHoldMaxDays} の整数`);
  return v as number;
};
const oneOf = <T extends string>(o: Rec, key: string, values: readonly T[]): T => {
  const v = o[key];
  if (typeof v !== "string" || !values.includes(v as T))
    fail(`${key} は ${values.join("・")} のいずれか`);
  return v as T;
};
const options = (o: Rec, key: string): string[] => {
  const v = o[key];
  if (
    !Array.isArray(v) ||
    v.length < 1 ||
    v.length > LIMITS.optionCount ||
    !v.every((x) => isBoundedText(x, LIMITS.optionLength) && x !== "") ||
    new Set(v).size !== v.length
  ) {
    fail(
      `${key} が不正（重複なし、1〜${LIMITS.optionCount} 件、各 ${LIMITS.optionLength} 文字以下）`,
    );
  }
  return [...(v as string[])];
};
const strict = (o: unknown, allowed: readonly string[]): Rec => {
  if (!isRec(o)) return fail("params が JSON のオブジェクトでない");
  if (!hasOnly(o, allowed)) fail(`未知のキーがある（許可: ${allowed.join("・") || "なし"}）`);
  return o;
};
const nodeIdOnly = (p: unknown) => {
  const o = strict(p, ["nodeId"]);
  return { nodeId: id(o, "nodeId") };
};

/** 受信箱の項目の ID の一覧（`inbox.resolve`・`inbox.reopen`）。1〜`LIMITS.inboxResolveItems` 件で、重複なし。 */
const itemIds = (p: unknown): string[] => {
  const o = strict(p, ["itemIds"]);
  const v = o.itemIds;
  if (
    !Array.isArray(v) ||
    v.length < 1 ||
    v.length > LIMITS.inboxResolveItems ||
    !v.every((x) => isSafeId(x)) ||
    new Set(v).size !== v.length
  ) {
    fail(`itemIds が不正（受信箱の項目の ID の配列。重複なし、1〜${LIMITS.inboxResolveItems} 件）`);
  }
  return [...(v as string[])];
};

const BRIEF_KEYS = ["objective", "acceptanceCriteria", "scope", "dependsOn"] as const;
/** ブリーフ（spec 5.2）の検査は core の `briefProblem` を使う（作業ツリー・ブランチは受けない）。 */
const brief = (o: Rec): Brief => {
  const problem = briefProblem(o);
  if (problem !== undefined) fail(problem);
  const b = o as unknown as Brief;
  return {
    objective: b.objective,
    acceptanceCriteria: [...b.acceptanceCriteria],
    scope: {
      writableLocations: [...b.scope.writableLocations],
      forbiddenLocations: [...b.scope.forbiddenLocations],
      allowedCommands: [...b.scope.allowedCommands],
    },
    ...(b.dependsOn === undefined ? {} : { dependsOn: [...b.dependsOn] }),
  };
};

type Validators = { [Op in DaemonOperation]: (p: unknown) => OperationMap[Op]["params"] };

const VALIDATORS: Validators = {
  "node.spawn": (p) => {
    const o = strict(p, ["parentId", "role", "runtime", "parentSessionId", ...BRIEF_KEYS]);
    if (o.parentSessionId !== undefined && !isSessionId(o.parentSessionId))
      fail("parentSessionId が不正");
    return {
      parentId: id(o, "parentId"),
      role: oneOf(o, "role", NODE_ROLES),
      ...(o.runtime === undefined ? {} : { runtime: oneOf(o, "runtime", NODE_RUNTIMES) }),
      ...brief(o),
      ...(o.parentSessionId === undefined ? {} : { parentSessionId: o.parentSessionId as string }),
    };
  },
  "node.adopt": (p) => {
    const o = strict(p, [
      "parentId",
      "role",
      "worktree",
      "branch",
      "sessionRef",
      "parentSessionId",
      "objective",
      "acceptanceCriteria",
      "scope",
    ]);
    if (o.parentSessionId !== undefined && !isSessionId(o.parentSessionId))
      fail("parentSessionId が不正");
    if (o.sessionRef !== undefined && !isSessionRef(o.sessionRef)) fail("sessionRef が不正");
    const worktree = nonBlank(o, "worktree", 4096);
    if (!worktree.startsWith("/")) fail("worktree は絶対パス");
    // ブリーフ（目的・受け入れ基準・範囲）の検査は spawn と同じ（dependsOn は受けない）
    return {
      parentId: id(o, "parentId"),
      role: oneOf(o, "role", NODE_ROLES),
      worktree,
      branch: nonBlank(o, "branch", LIMITS.reason),
      ...brief({
        objective: o.objective,
        acceptanceCriteria: o.acceptanceCriteria,
        scope: o.scope,
      }),
      ...(o.sessionRef === undefined ? {} : { sessionRef: o.sessionRef as string }),
      ...(o.parentSessionId === undefined ? {} : { parentSessionId: o.parentSessionId as string }),
    };
  },
  "node.send": (p) => {
    const o = strict(p, ["nodeId", "text"]);
    return { nodeId: id(o, "nodeId"), text: text(o, "text", LIMITS.reportText) };
  },
  "node.stop": (p) => {
    const o = strict(p, ["nodeId", "mode", "graceMs"]);
    const nodeId = id(o, "nodeId");
    const mode = oneOf(o, "mode", ["graceful", "immediate"] as const);
    if (o.graceMs === undefined) {
      return mode === "graceful" ? { nodeId, mode: "graceful" } : { nodeId, mode: "immediate" };
    }
    // 猶予時間は穏当な停止（graceful）のときだけ。即時停止に猶予はない。
    if (mode !== "graceful") fail("graceMs は mode が graceful のときだけ指定できる");
    const g = o.graceMs;
    if (typeof g !== "number" || !Number.isInteger(g) || g < 1 || g > MAX_GRACE_MS) {
      fail(`graceMs が不正（1〜${MAX_GRACE_MS} の整数）`);
    }
    return { nodeId, mode, graceMs: g as number };
  },
  "node.bindCode": (p) => {
    const o = strict(p, ["nodeId", "parentSessionId"]);
    const nodeId = id(o, "nodeId");
    if (o.parentSessionId === undefined) return { nodeId };
    // 親の Claude Code の session_id（知らせの宛先）。形が違えば拒否する。
    if (!isSessionId(o.parentSessionId)) fail("parentSessionId が不正");
    return { nodeId, parentSessionId: o.parentSessionId as string };
  },
  "node.confirmStopped": (p) => {
    const o = strict(p, ["nodeId", "note"]);
    const nodeId = id(o, "nodeId");
    return o.note === undefined ? { nodeId } : { nodeId, note: text(o, "note", LIMITS.summary) };
  },
  "inbox.fetch": (p) => {
    const o = strict(p, ["sinceSeq", "ackItemIds"]);
    const s = o.sinceSeq;
    if (s !== undefined && (typeof s !== "number" || !Number.isInteger(s) || s < 0))
      fail("sinceSeq が 0 以上の整数でない");
    const a = o.ackItemIds;
    if (
      a !== undefined &&
      (!Array.isArray(a) || a.length > 100 || !a.every((x) => typeof x === "string" && isSafeId(x)))
    ) {
      fail("ackItemIds は、項目の ID の配列（100 件まで）");
    }
    return {
      ...(s === undefined ? {} : { sinceSeq: s as number }),
      ...(a === undefined ? {} : { ackItemIds: a as string[] }),
    };
  },
  "inbox.resolve": (p) => ({ itemIds: itemIds(p) }),
  "inbox.reopen": (p) => ({ itemIds: itemIds(p) }),
  "tree.list": (p) => {
    strict(p, []);
    return {};
  },
  "decision.present": (p) => {
    const o = strict(p, ["question", "options", "pauseNodeIds"]);
    const base = { question: text(o, "question", LIMITS.question), options: options(o, "options") };
    if (o.pauseNodeIds === undefined) return base;
    const problem = pauseNodeIdsProblem(o.pauseNodeIds);
    if (problem !== undefined) fail(problem);
    const ids = [...(o.pauseNodeIds as string[])];
    return { ...base, pauseNodeIds: ids };
  },
  "node.split": (p) => {
    const o = strict(p, ["nodeId", "keep", ...BRIEF_KEYS]);
    return {
      nodeId: id(o, "nodeId"),
      keep: oneOf(o, "keep", ["mainline", "stop"] as const),
      ...brief(o),
    };
  },
  "scope.decide": (p) => {
    const o = strict(p, ["extensionId", "decision", "alsoLimit"]);
    const decision = oneOf(o, "decision", ["approve", "reject", "split"] as const);
    const base = { extensionId: id(o, "extensionId"), decision };
    if (o.alsoLimit === undefined) return base;
    if (typeof o.alsoLimit !== "boolean") fail("alsoLimit は真偽値");
    if (o.alsoLimit && decision !== "approve") fail("alsoLimit は approve のときだけ付けられる");
    return { ...base, alsoLimit: o.alsoLimit as boolean };
  },
  "config.reload": (p) => {
    strict(p, []);
    return {};
  },
  "policy.ruleChange": (p) => {
    const o = strict(p, ["list", "rule", "op"]);
    const rule = text(o, "rule", LIMITS.policyRule);
    if (rule.trim() === "") fail("rule は空にできない");
    return {
      list: oneOf(o, "list", ["allow", "deny", "ask", "autoApprove"] as const),
      rule,
      op: oneOf(o, "op", ["add", "remove"] as const),
    };
  },
  "node.review": (p) => {
    const o = strict(p, ["nodeId", "verdict", "feedback"]);
    const nodeId = id(o, "nodeId");
    const verdict = oneOf(o, "verdict", ["accept", "reject"] as const);
    if (verdict === "reject") {
      // 差し戻しには理由が要る（子が直す手がかり）。
      const feedback = text(o, "feedback", LIMITS.feedback);
      if (feedback.trim() === "") fail("reject には feedback（差し戻しの理由）が必要");
      return { nodeId, verdict, feedback };
    }
    if (o.feedback === undefined) return { nodeId, verdict };
    return { nodeId, verdict, feedback: text(o, "feedback", LIMITS.feedback) };
  },
  "node.reclaimPreview": nodeIdOnly,
  "node.reclaim": nodeIdOnly,
  "node.reclaimBatchPreview": (p) => {
    const o = strict(p, ["assumeEvidence"]);
    const v = o.assumeEvidence;
    if (v === undefined) return {};
    if (!Array.isArray(v) || v.length > LIMITS.expectNodeIds) {
      fail(`assumeEvidence は、{nodeId, tip} の配列（${LIMITS.expectNodeIds} 件以下）`);
    }
    const list = (v as unknown[]).map((e) => {
      const r = strict(e, ["nodeId", "tip"]);
      if (!isCommitSha(r.tip)) fail("tip が不正（40 桁の 16 進のコミット SHA）");
      return { nodeId: id(r, "nodeId"), tip: r.tip as string };
    });
    if (new Set(list.map((e) => e.nodeId)).size !== list.length)
      fail("assumeEvidence に重複がある");
    return { assumeEvidence: list };
  },
  "node.reclaimBatch": (p) => {
    const o = strict(p, ["expectDigest"]);
    return { expectDigest: id(o, "expectDigest") };
  },
  "node.mergeEvidence": (p) => {
    const o = strict(p, ["nodeId", "evidenceKind", "tip", "prNumber"]);
    const tip = o.tip;
    if (!isCommitSha(tip)) fail("tip が不正（40 桁の 16 進のコミット SHA）");
    const out: OperationMap["node.mergeEvidence"]["params"] = {
      nodeId: id(o, "nodeId"),
      evidenceKind: oneOf(o, "evidenceKind", MERGE_EVIDENCE_KINDS),
      tip: tip as string,
    };
    if (o.prNumber !== undefined) {
      if (!isPrNumber(o.prNumber)) fail(`prNumber が不正（1〜${MAX_PR_NUMBER} の整数）`);
      return { ...out, prNumber: o.prNumber as number };
    }
    return out;
  },
  "node.integrate": nodeIdOnly,
  "node.capabilities": nodeIdOnly,
  "decision.get": (p) => {
    const o = strict(p, ["decisionId"]);
    return { decisionId: id(o, "decisionId") };
  },
  "report.get": (p) => {
    const o = strict(p, ["reportId"]);
    return { reportId: id(o, "reportId") };
  },
  "report.progress": (p) => {
    const o = strict(p, ["text"]);
    return { text: text(o, "text", LIMITS.reportText) };
  },
  "report.decision": (p) => {
    const o = strict(p, ["question", "options"]);
    return { question: text(o, "question", LIMITS.question), options: options(o, "options") };
  },
  "decision.withdraw": (p) => {
    const o = strict(p, ["decisionId"]);
    return { decisionId: id(o, "decisionId") };
  },
  "report.outOfScope": (p) => {
    const o = strict(p, ["text"]);
    return { text: text(o, "text", LIMITS.reportText) };
  },
  "report.done": (p) => {
    const o = strict(p, ["evidence"]);
    const v = o.evidence;
    if (!Array.isArray(v) || v.length > LIMITS.evidenceCount)
      fail(`evidence が不正（${LIMITS.evidenceCount} 件以下の配列）`);
    const evidence = (v as unknown[]).map((x) => {
      const e = strict(x, ["criterion", "evidence"]);
      return {
        criterion: nonBlank(e, "criterion", LIMITS.evidenceLength),
        evidence: nonBlank(e, "evidence", LIMITS.evidenceLength),
      };
    });
    return { evidence };
  },
  "scope.extend": (p) => {
    const o = strict(p, ["target", "reason"]);
    const t = strict(o.target, ["kind", "value"]);
    const value = text(t, "value", LIMITS.extensionTarget);
    if (value.trim() === "") fail("target.value が空");
    const reason = text(o, "reason", LIMITS.extensionReason);
    if (reason.trim() === "") fail("reason が空");
    return {
      target: { kind: oneOf(t, "kind", ["write", "command", "mcp"] as const), value },
      reason,
    };
  },
  "decision.answer": (p) => {
    const o = strict(p, ["decisionId", "choice", "text"]);
    const decisionId = id(o, "decisionId");
    const hasChoice = o.choice !== undefined;
    const hasText = o.text !== undefined;
    if (hasChoice === hasText) fail("choice か text のどちらか一方を指定する");
    return hasChoice
      ? { decisionId, choice: text(o, "choice", LIMITS.optionLength) }
      : { decisionId, text: text(o, "text", LIMITS.reportText) };
  },
  "node.reclaimInstruct": (p) => {
    const o = strict(p, ["nodeId", "expectTips"]);
    const nodeId = id(o, "nodeId");
    const tips = o.expectTips;
    if (!isRec(tips)) fail("expectTips（ノード ID から先端への対応）が必要");
    const entries = Object.entries(tips as Rec);
    if (entries.length > EXPECT_TIPS_MAX) fail(`expectTips は ${EXPECT_TIPS_MAX} 件まで`);
    const out: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (!isSafeId(k)) fail("expectTips のキーが、ノード ID の形式でない");
      if (!isCommitSha(v)) fail("expectTips の値が不正（小文字の 16 進で 40 桁か 64 桁）");
      out[k] = v as string;
    }
    return { nodeId, expectTips: out };
  },
  "node.purge": (p) => {
    const o = strict(p, ["nodeId", "tombstone", "expectNodeIds"]);
    const nodeId = id(o, "nodeId");
    if (o.tombstone !== undefined && typeof o.tombstone !== "boolean") {
      fail("tombstone が真偽値でない");
    }
    let expectNodeIds: string[] | undefined;
    if (o.expectNodeIds !== undefined) {
      const ids = o.expectNodeIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > LIMITS.expectNodeIds) {
        fail(`expectNodeIds は、ノード ID の配列（1〜${LIMITS.expectNodeIds} 件）`);
      }
      const list = ids as unknown[];
      if (!list.every((x) => isSafeId(x)) || new Set(list).size !== list.length) {
        fail("expectNodeIds の要素が、ノード ID の形式でない（または重複している）");
      }
      expectNodeIds = [...(list as string[])];
    }
    return {
      nodeId,
      ...(o.tombstone === undefined ? {} : { tombstone: o.tombstone as boolean }),
      ...(expectNodeIds === undefined ? {} : { expectNodeIds }),
    };
  },
  "node.purgePreview": nodeIdOnly,
  "node.purgeHold": (p) => {
    const o = strict(p, ["nodeId", "until", "days", "reason"]);
    const nodeId = id(o, "nodeId");
    if (o.until !== undefined && o.days !== undefined) fail("until と days は同時に指定できない");
    const until = o.until === undefined ? undefined : isoUtc(o, "until");
    const days = o.days === undefined ? undefined : holdDays(o);
    const reason =
      o.reason === undefined ? undefined : nonBlank(o, "reason", LIMITS.purgeHoldReason);
    return {
      nodeId,
      ...(until === undefined ? {} : { until }),
      ...(days === undefined ? {} : { days }),
      ...(reason === undefined ? {} : { reason }),
    };
  },
  "node.purgeRelease": nodeIdOnly,
  "node.hookUnbind": nodeIdOnly,
  "node.hookToken": nodeIdOnly,
  "child.inbox": (p) => {
    const o = strict(p, ["all", "ackThrough"]);
    if (o.all !== undefined && typeof o.all !== "boolean") fail("all は真偽値");
    if (
      o.ackThrough !== undefined &&
      (!Number.isSafeInteger(o.ackThrough) || (o.ackThrough as number) < 0)
    )
      fail("ackThrough は 0 以上の整数");
    return {
      ...(o.all === undefined ? {} : { all: o.all as boolean }),
      ...(o.ackThrough === undefined ? {} : { ackThrough: o.ackThrough as number }),
    };
  },
  "parent.request": (p) => {
    const o = strict(p, ["nodeId", "model", "effort", "forkSessionRef", "pluginRoot"]);
    const nodeId = id(o, "nodeId");
    if (o.model !== undefined && !isModelName(o.model)) fail("model が不正");
    if (o.effort !== undefined && !isEffort(o.effort)) fail("effort が不正");
    if (o.forkSessionRef !== undefined && !isSessionRef(o.forkSessionRef))
      fail("forkSessionRef が不正");
    return {
      nodeId,
      ...(o.model === undefined ? {} : { model: o.model as string }),
      ...(o.effort === undefined ? {} : { effort: o.effort as string }),
      ...(o.forkSessionRef === undefined ? {} : { forkSessionRef: o.forkSessionRef as string }),
      // 形の確かめ（絶対・引用できる文字）は、起動の文を作るときに行い、合わなければ --plugin-dir を付けずに受信箱で知らせる
      ...(typeof o.pluginRoot === "string" && o.pluginRoot.length <= 4096
        ? { pluginRoot: o.pluginRoot }
        : {}),
    };
  },
  "parent.report": (p) => {
    const o = strict(p, ["nodeId", "requestRef", "outcome", "sessionRef", "reason", "agentState"]);
    const nodeId = id(o, "nodeId");
    const requestRef = id(o, "requestRef");
    const outcome = oneOf(o, "outcome", ["done", "failed"] as const);
    if (o.sessionRef !== undefined && !isSessionRef(o.sessionRef)) fail("sessionRef が不正");
    if (o.agentState !== undefined && !isAgentState(o.agentState)) fail("agentState が不正");
    return {
      nodeId,
      requestRef,
      outcome,
      ...(o.sessionRef === undefined ? {} : { sessionRef: o.sessionRef as string }),
      ...(o.reason === undefined ? {} : { reason: text(o, "reason", LIMITS.reason) }),
      ...(o.agentState === undefined ? {} : { agentState: o.agentState as string }),
    };
  },
  "node.discardedList": (p) => {
    strict(p, []);
    return {};
  },
  "node.discardedRestore": (p) => {
    const o = strict(p, ["target", "branch"]);
    const target = id(o, "target");
    if (o.branch === undefined) return { target };
    const branch = text(o, "branch", 200);
    if (branch === "" || branch.startsWith("-")) fail("branch が不正（空・先頭が - は不可）");
    return { target, branch };
  },
  "node.discardedDrop": (p) => {
    const o = strict(p, ["target", "expectTip"]);
    const expectTip = o.expectTip;
    if (!isCommitSha(expectTip)) fail("expectTip が不正（小文字の 16 進で 40 桁か 64 桁）");
    return { target: id(o, "target"), expectTip: expectTip as string };
  },
  "confirm.approve": (p) => {
    const o = strict(p, ["confirmationId", "code"]);
    const code = text(o, "code", 32);
    if (code.trim() === "") fail("code が空");
    return { confirmationId: id(o, "confirmationId"), code };
  },
  "confirm.cancel": (p) => {
    const o = strict(p, ["confirmationId"]);
    return { confirmationId: id(o, "confirmationId") };
  },
};

/** 操作ごとの引数を検査し、新しいオブジェクトに写して返す。 */
export function validateParams<Op extends DaemonOperation>(
  operation: Op,
  params: unknown,
): Result<OperationMap[Op]["params"], Failure> {
  try {
    const validator = Object.hasOwn(VALIDATORS, operation) ? VALIDATORS[operation] : undefined;
    if (validator === undefined) return { ok: false, error: bad("未知の操作") };
    return { ok: true, value: validator(params) as OperationMap[Op]["params"] };
  } catch (e) {
    return { ok: false, error: bad(e instanceof Invalid ? e.message : "引数を検査できない") };
  }
}
