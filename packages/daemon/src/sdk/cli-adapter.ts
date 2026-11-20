/**
 * CLI の子のアダプタ（設計 6.1・6.2）。daemon は子のセッションを起動しない（NFR_014）。起動は、親のセッションへの依頼
 * （ParentRequest）として記録し、中身は受信箱と `parent.request` で親に渡す。親の skill が Bash で `claude --bg` を実行し、
 * 結果を `parent.report` で報告する。
 *
 * - `start`: 紐付けのコードを発行し、作業ツリーの git のディレクトリに `touryou-bind-code`（0600）を書き、起動の依頼
 *   （`node.parentRequested`）と受信箱の項目を 1 つのトランザクションで記録する。コードは記録にも依頼の文にも入れない。
 *   コードの期限が来たら、ファイルを消す。
 * - `has`: 起動の依頼の記録があるノード（daemon の外で動く子。再起動の後の整合〔reconcile〕で、プロセスがないことを理由に
 *   止めない）。
 * - `send`: 追加の指示は記録（`node.instructed`）に置き、知らせ（Pub/Sub）で読ませる（能力表は `delayed`。`node.send` は
 *   この関数を呼ばない）。子は `child.inbox` で読む。
 * - `stop`（設計 6.2 の 2 段の停止）:
 *   - 親がまだ起動していない（成功の起動の報告がない）子: コードとファイルを片付けて、止めたものとして記録する。
 *   - 穏当（graceful）: (1) 停止の指示は、記録（停止の要求）から子の購読に知らせとして流れる。猶予（既定 60 秒）の間、作業ツリーを
 *     使うプロセス（`lsof-probe`）を調べ、なくなった時点で待つのをやめる（それだけでは stopped にしない。番の間にプロセスを持たない
 *     `--bg` の子は、生きていても lsof に出ないかもしれないため。推測）。(2) 猶予を過ぎたか、プロセスがなくなったら、親に
 *     `claude stop <id>` を依頼し（`node.parentRequested` の stop）、停止未完了（stopIncomplete）にする。
 *   - 即時（immediate）: (2) だけ。
 *   - 親の「止めた」の報告のあとも、`lsof-probe` で作業ツリーを使うプロセスがないことを確かめてから stopped にする
 *     （`parent-request-handlers.ts`）。
 */

import {
  type Failure,
  failure,
  findRunningProcesses,
  type OrchState,
  ok,
  type Result,
  type Scope,
} from "@touryou/core";
import type { BindCodes } from "../api/bind.js";
import { appendAtomically, deriveId, type LogPort, notice } from "../api/handlers/context.js";
import type { ProcessProbe } from "./lsof-probe.js";
import type {
  Capabilities,
  DeliveryValue,
  RuntimeAdapter,
  StartRequest,
  StartValue,
  StopRequest,
  StopValue,
  Timers,
} from "./runtime.js";

const CAPABILITIES: Capabilities = {
  // 追加の指示は記録に置き、知らせ（Pub/Sub）で読ませる。届くのは子の番の区切り（設計 6.3）。
  send: "delayed",
  stopGraceful: true,
  stopImmediate: true,
  // 親が止めたと報告しても確かめられないとき（lsof が使えないなど）、人か親が node.confirmStopped で宣言できる
  stopDelegated: true,
  // plugin の hooks.json。--bg の子でフックが動くかは、まだ確かめていない。
  hooks: "unverified",
  sessionId: false,
};

export const cliUnsupported = (what: string): Failure =>
  failure(
    "notSupported",
    `CLI の子の${what}は、いまの版では使えない（親への依頼の形に置き換える途中。停止・削除は次の版）`,
    "親のセッションで、claude stop <子のセッション> を実行し、node_confirmStopped で止めたと宣言する",
    "Desktop の子（設定 childRuntime: desktop）を使う",
  );

/** 起動の依頼の受信箱の要約（親が読んで、次の操作をする）。 */
export const launchSummary = (nodeId: string): string => launchNotice(nodeId).summary;
/** 起動の依頼の知らせ（#140。日本語の要約と、画面のための鍵と値）。 */
export const launchNotice = (nodeId: string) => notice("launchRequest", { node: nodeId });

export interface ParentRequestCliAdapterDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  readonly bind: Pick<BindCodes, "issueWithExpiry" | "revoke">;
  /** コードのファイルを書く（`bind-code-file.ts`）。失敗は例外。 */
  readonly writeCodeFile: (worktree: string, code: string) => void;
  /** コードのファイルを消す（なければ何もしない）。 */
  readonly removeCodeFile: (worktree: string) => void;
  /** 期限でファイルを消すためのタイマー（試験で差し替える）。 */
  readonly after?: (ms: number, fn: () => void) => { cancel(): void };
  /** 依頼の参照の乱数（試験で固定する）。 */
  readonly newRef?: () => string;
  readonly nowMs?: () => number;
  /** 作業ツリーを使うプロセスの調査（`lsof-probe`）。ないと、穏当な停止は猶予を待たずに (2) に進む。 */
  readonly probe?: ProcessProbe;
  /** 猶予の間の待ち（試験で差し替える）。 */
  readonly timers?: Pick<Timers, "now" | "sleep">;
  /** 穏当な停止の猶予の既定（ミリ秒）。既定 60 秒。 */
  readonly graceMs?: number;
  /** 猶予の間の、プロセスの調べ直しの間隔（ミリ秒）。既定 5 秒。 */
  readonly pollMs?: number;
}

/** 停止の依頼の受信箱の要約・代行の文面（手順を先に、ID を後ろに置く）。 */
export const stopDelegation = (nodeId: string): string =>
  notice("stopDelegated", { node: nodeId }).summary;

const defaultAfter = (ms: number, fn: () => void): { cancel(): void } => {
  const t = setTimeout(fn, Math.max(0, ms));
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

/** ノードの、最も新しい起動の依頼。 */
export const latestLaunch = (state: OrchState, nodeId: string) =>
  [...state.parentRequests].reverse().find((r) => r.nodeId === nodeId && r.kind === "launch");

export class ParentRequestCliAdapter implements RuntimeAdapter {
  readonly kind = "cli" as const;
  private readonly expiry = new Map<string, { cancel(): void }>();

  constructor(private readonly deps: ParentRequestCliAdapterDeps) {}

  has(nodeId: string): boolean {
    // 親が起動の失敗を報告した子は、動いていない（管理していない）
    const state = this.deps.log.state();
    // 採用した既存の作業ツリー（#163）は、起動の依頼がなくても、daemon の外で動く子として管理する
    if (state.nodes.find((n) => n.id === nodeId)?.adopted !== undefined) return true;
    const launch = latestLaunch(state, nodeId);
    return launch !== undefined && launch.report?.outcome !== "failed";
  }

  capabilities(_nodeId: string): Capabilities {
    return CAPABILITIES;
  }

  /**
   * コードを発行し、ファイルに書く（`start` と、`node.bindCode` の出し直し）。期限が来たらファイルを消す。
   * 書けなければ、コードを無効にして例外。
   */
  issueCodeFile(nodeId: string, worktree: string): { readonly expiresAtMs: number } {
    const issued = this.deps.bind.issueWithExpiry(nodeId);
    try {
      this.deps.writeCodeFile(worktree, issued.code);
    } catch (e) {
      this.deps.bind.revoke(nodeId);
      throw e;
    }
    this.expiry.get(nodeId)?.cancel();
    const now = (this.deps.nowMs ?? Date.now)();
    this.expiry.set(
      nodeId,
      (this.deps.after ?? defaultAfter)(issued.expiresAtMs - now, () => {
        this.expiry.delete(nodeId);
        this.deps.removeCodeFile(worktree);
      }),
    );
    return { expiresAtMs: issued.expiresAtMs };
  }

  /** コードとファイルを片付ける（使われた・止めた）。 */
  discardCode(nodeId: string, worktree: string | undefined, revoke: boolean): void {
    if (revoke) this.deps.bind.revoke(nodeId);
    this.expiry.get(nodeId)?.cancel();
    this.expiry.delete(nodeId);
    if (worktree !== undefined) this.deps.removeCodeFile(worktree);
  }

  async start(request: StartRequest): Promise<Result<StartValue, Failure>> {
    const { nodeId, worktreePath } = request;
    try {
      this.issueCodeFile(nodeId, worktreePath);
    } catch {
      return {
        ok: false,
        error: failure(
          "bindCodeFileFailed",
          "紐付けのコードのファイルを、作業ツリーの git のディレクトリに書けなかった",
          "git の状態と、ディスクの空きを確かめてから、もう一度試す",
        ),
      };
    }
    const requestRef = (
      this.deps.newRef ?? (() => deriveId("preq", nodeId, `${Date.now()}`, String(Math.random())))
    )();
    const recorded = appendAtomically(
      this.deps.log,
      this.deps.clock,
      `${requestRef}/launch`,
      { system: true },
      [
        {
          type: "node.parentRequested",
          payload: { nodeId, requestRef, kind: "launch", worktree: worktreePath },
        },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", "system", requestRef, "parent-request"),
            kind: "info",
            nodeId,
            ...launchNotice(nodeId),
          },
        },
      ],
    );
    if (!recorded.ok) {
      this.discardCode(nodeId, worktreePath, true);
      return { ok: false, error: recorded.error };
    }
    // 子のセッションの参照は、親の報告（parent.report）で分かる。それまでは、ノードの ID で代える。
    return ok({ sessionId: nodeId, cwd: worktreePath, removedEnv: [] });
  }

  async send(_nodeId: string, _text: string): Promise<Result<DeliveryValue, Failure>> {
    return { ok: false, error: cliUnsupported("指示の直接の送信") };
  }

  async stop(nodeId: string, request: StopRequest): Promise<Result<StopValue, Failure>> {
    const state = this.deps.log.state();
    // 採用した既存の作業ツリー（#163）は、起動の依頼がない。動いているセッションがあるとみなし、起動の報告を受けた子と同じに扱う
    // （親に claude stop を依頼する。止めたとは、自分では記録しない）。
    const adopted = state.nodes.find((n) => n.id === nodeId)?.adopted;
    const launch =
      latestLaunch(state, nodeId) ??
      (adopted === undefined
        ? undefined
        : { worktree: adopted.worktree, report: { outcome: "done" as const } });
    const record = (key: string, bodies: Parameters<typeof appendAtomically>[4]) =>
      appendAtomically(
        this.deps.log,
        this.deps.clock,
        `${key}-${request.stopSeq}`,
        { system: true },
        bodies,
      );
    // 起動の依頼がない・親が起動の失敗を報告した子は、動いているセッションがない。コードを片付けて、止めたと記録する。
    if (launch === undefined || launch.report?.outcome === "failed") {
      this.discardCode(nodeId, launch?.worktree, true);
      const nodeState = state.nodes.find((n) => n.id === nodeId)?.state;
      // 停止の途中（node.stop のあと）なら、ほかのアダプタと同じく、自分で stopped を記録する（生成の後始末では記録しない）
      if (nodeState === "stopping" || nodeState === "stopIncomplete") {
        const r = appendAtomically(
          this.deps.log,
          this.deps.clock,
          `cli-stopped-${request.stopSeq}`,
          { system: true },
          [
            {
              type: "node.stopObserved",
              payload: { nodeId, outcome: "aborted", stopSeq: request.stopSeq },
            },
            { type: "node.stateChanged", payload: { nodeId, event: { type: "confirmStopped" } } },
          ],
        );
        if (!r.ok) return { ok: false, error: r.error };
      }
      return ok({ state: "stopped", outcome: "aborted", blockers: [] });
    }
    // 起動を依頼したが、親の報告がまだない: 親が claude --bg を実行したあとかもしれないので、止めたとは記録しない。
    // 受信箱（停止未完了）で、親に確かめてもらう。
    if (launch.report === undefined) {
      return {
        ok: false,
        error: failure(
          "notSupported",
          `起動の報告がまだない（親が claude --bg を実行したあとかもしれない）。親に claude agents --json で確かめてもらう。対象ノード: ${nodeId}`,
          "動いていれば、親が claude stop で止め、起動の依頼に parent_report（outcome: done と sessionRef）を報告し、node_confirmStopped で宣言する",
          "動いていなければ、起動の依頼に parent_report（outcome: failed）を報告してから、node_stop で止め直す",
        ),
      };
    }
    // (1) 穏当な停止: 停止の指示は、記録から子に知らせとして流れる。猶予の間、作業ツリーのプロセスがなくなるのを待つ。
    if (request.mode === "graceful" && this.deps.probe !== undefined) {
      const timers = this.deps.timers ?? {
        now: Date.now,
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      };
      const grace = request.graceMs ?? this.deps.graceMs ?? 60_000;
      const poll = Math.max(1, this.deps.pollMs ?? 5_000);
      const until = timers.now() + grace;
      for (;;) {
        const procs = await this.deps.probe(launch.worktree).catch(() => null);
        // 止まって見えても、stopped にはしない: 番の間にプロセスを持たない `--bg` の子は、lsof に出なくても
        // 生きていて、あとで再開しうる（推測。まだ確かめていない）。猶予を待つのをやめて、(2) の親への claude stop の依頼に進む。
        // 親の報告のあと、もう一度 lsof で確かめてから stopped にし、claude rm を依頼する（親の報告の道と同じ順）。
        if (procs !== null && findRunningProcesses(launch.worktree, procs).length === 0) break;
        const left = until - timers.now();
        if (left <= 0) break;
        await timers.sleep(Math.min(poll, left));
      }
    }
    // (2) 親に claude stop を依頼する。停止未完了にし、受信箱には代行の文面が出る（runtime-handlers の settle）。
    const requestRef = (
      this.deps.newRef ?? (() => deriveId("preq", nodeId, `${Date.now()}`, String(Math.random())))
    )();
    const r = record("cli-stop-request", [
      {
        type: "node.parentRequested",
        payload: { nodeId, requestRef, kind: "stop", worktree: launch.worktree },
      },
      { type: "node.stateChanged", payload: { nodeId, event: { type: "stopTimeout" } } },
    ]);
    if (!r.ok) return { ok: false, error: r.error };
    return ok({ state: "stopIncomplete", blockers: [], delegation: stopDelegation(nodeId) });
  }

  release(nodeId: string): void {
    const state = this.deps.log.state();
    this.discardCode(
      nodeId,
      latestLaunch(state, nodeId)?.worktree ??
        state.nodes.find((n) => n.id === nodeId)?.adopted?.worktree,
      true,
    );
  }

  updateScope(_nodeId: string, _scope: Scope): Result<undefined, Failure> {
    return { ok: true, value: undefined };
  }
}
