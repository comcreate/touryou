/**
 * 試験用の、手で進める待ち。`sleep` を差し替えると、`tick()` を呼ぶまで、待ちが終わらない
 * （自動の紐付けの定期の確かめを、実時間なしで 1 間隔ずつ進める）。
 */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

export function manualClock() {
  const waiting: (() => void)[] = [];
  const waits: number[] = [];
  return {
    /** 待った時間（ミリ秒）の記録。 */
    waits,
    sleep: (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        waits.push(ms);
        waiting.push(resolve);
      }),
    /** 1 間隔進める（待ちを終わらせ、そのあとの処理が落ち着くまで待つ）。 */
    tick: async (): Promise<void> => {
      await flush();
      waiting.shift()?.();
      await flush();
    },
  };
}
