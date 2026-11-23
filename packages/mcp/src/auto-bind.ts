/**
 * 紐付け待ちの間の、自動の紐付け（#255 案 1-A）。子の AI にも人にも `child_bind` を打たせず、MCP が自分で戻す。
 *
 * - 起動直後（と、紐付いていたのが外れた直後）と、`intervalMs`（既定 60 秒）ごとに、コードのファイルを確かめる。
 *   - ファイルがある: 使う（`child_bind` を引数なしで呼んだときと同じ処理）。
 *   - ファイルがない: コードなしの結び直しを試す。最初の起動はコードのファイルがあるので、ここには来ない
 *     （来ると、記録のない結び直しが断られて、偽の「紐付けをやり直して」が親に出る）。
 *   - ファイルはあるが安全でない・読めない: 何もしない（子の AI の `child_bind` が理由を返す）。
 * - daemon を叩く試行は、失敗のたびに間隔を倍にする（上限 `maxIntervalMs`。既定 10 分）。429（`rate_limited`）なら上限まで待つ。
 *   本物のコードでの紐付けを、この定期の確かめが 429 にしないため。ファイルの有無を見るだけの確かめは、daemon を叩かない。
 * - 通ったら `onBound`（セッションの道具の切り替えと、受信箱への 1 行）を呼ぶ。
 *
 * コード・トークンは、ここでは扱わない（呼び出し側の関数の中だけ）。ログに出すのは、固定の記号と失敗の記号だけ。
 */
import type { Result } from "@touryou/core";

/** 定期の確かめの間隔（ミリ秒）。 */
export const AUTO_BIND_INTERVAL_MS = 60_000;
/** 失敗が続いたときの、daemon を叩く間隔の上限（ミリ秒）。 */
export const AUTO_BIND_MAX_INTERVAL_MS = 600_000;

export interface AutoBindOptions {
  /** 入れ物に値が入っているか（入っている間は何もしない）。 */
  readonly isBound: () => boolean;
  /** コードのファイルの状態。 */
  readonly codeFile: () => "present" | "missing" | "unusable";
  /** コードなしの結び直しを試せるか（印とセッションの ID があるか）。 */
  readonly canRebind: boolean;
  /** コードのファイルを使って紐付ける（`child_bind` の本体）。 */
  readonly bindFromFile: () => Promise<Result<unknown>>;
  /** コードなしの結び直し。試せなかったときは `undefined`。 */
  readonly rebind: () => Promise<Result<unknown> | undefined>;
  /** 紐付いたあとの処理（道具の切り替え・受信箱への 1 行）。失敗は、ここで握りつぶす。 */
  readonly onBound: () => Promise<void>;
  readonly log: (e: Record<string, unknown>) => void;
  readonly intervalMs?: number;
  readonly maxIntervalMs?: number;
  /** 差し替えられる待ち（試験用）。既定は、プロセスを止めないタイマー。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 中止の合図（MCP の接続が閉じたとき）。 */
  readonly signal?: AbortSignal;
}

/** 失敗のたびに間隔を倍にする、daemon を叩く試行の間隔。 */
function createBackoff(baseMs: number, maxMs: number) {
  let wait = 0;
  let since = 0;
  return {
    due: () => since >= wait,
    elapse: (ms: number) => {
      since += ms;
    },
    /** 通った・状態が変わった: 次の試行まで `nextWait` 待つ（0 ならすぐ試す）。 */
    reset: (nextWait: number) => {
      wait = nextWait;
      since = 0;
    },
    /** 失敗した: 間隔を倍に（上限まで）。429 は上限まで待つ。待ちの長さを返す。 */
    fail: (code: string | undefined) => {
      wait = code === "rate_limited" ? maxMs : Math.min(wait === 0 ? baseMs : wait * 2, maxMs);
      since = 0;
      return wait;
    },
  };
}

const codeOf = (r: Result<unknown> | undefined): string | undefined =>
  r === undefined || r.ok ? undefined : r.error.code;

/** 紐付け待ちの間の自動の紐付けを始める。返す Promise は、`signal` が中止されて終わったとき解決する（試験用）。 */
export function startAutoBind(o: AutoBindOptions): Promise<void> {
  const base = o.intervalMs ?? AUTO_BIND_INTERVAL_MS;
  const max = o.maxIntervalMs ?? AUTO_BIND_MAX_INTERVAL_MS;
  const sleep =
    o.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
      }));
  const file = createBackoff(base, max);
  const rebind = createBackoff(base, max);
  const aborted = new Promise<void>((resolve) => {
    if (o.signal?.aborted) resolve();
    o.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  const finish = async (via: "codeFile" | "rebind"): Promise<void> => {
    o.log({ event: "autoBound", via, at: new Date().toISOString() });
    try {
      await o.onBound();
    } catch {
      o.log({ event: "autoBindFinishFailed", at: new Date().toISOString() });
    }
  };
  const failed = (via: "codeFile" | "rebind", code: string | undefined, nextWaitMs: number) =>
    o.log({
      event: "autoBindFailed",
      via,
      ...(code === undefined ? {} : { code }),
      nextWaitMs,
      at: new Date().toISOString(),
    });
  const step = async (): Promise<void> => {
    const state = o.codeFile();
    if (state === "present") {
      if (!file.due()) return;
      const r = await o.bindFromFile();
      if (r.ok) {
        file.reset(0);
        await finish("codeFile");
        return;
      }
      failed("codeFile", codeOf(r), file.fail(codeOf(r)));
      return;
    }
    if (state === "missing" && o.canRebind && rebind.due()) {
      const r = await o.rebind();
      if (r?.ok === true) {
        rebind.reset(0);
        await finish("rebind");
        return;
      }
      failed("rebind", codeOf(r), rebind.fail(codeOf(r)));
    }
  };
  const run = async (): Promise<void> => {
    let wasBound = false;
    while (o.signal?.aborted !== true) {
      if (o.isBound()) {
        wasBound = true;
      } else {
        // 紐付いていたのが外れた直後: 道具の 401 の復旧が、いま試したばかり。すぐには試さず、1 間隔あとにする
        if (wasBound) {
          wasBound = false;
          file.reset(0);
          rebind.reset(base);
        }
        try {
          await step();
        } catch {
          o.log({ event: "autoBindStepFailed", at: new Date().toISOString() });
        }
      }
      await Promise.race([sleep(base), aborted]);
      file.elapse(base);
      rebind.elapse(base);
    }
  };
  return run();
}
