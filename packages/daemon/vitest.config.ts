import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// テストは core のソースを直接参照する（core を先にビルドしなくても `pnpm test` が動く）。
// 本番の解決（dist）は scripts/check-core-resolution.mjs で確かめる。
export default defineConfig({
  // 実物の git を使う試験（reclaim-real-git・integrate-real-git・startup-real-git）は、負荷が高いと 5 秒（既定）を超えて落ちる（#201）。
  // 時間切れの上限だけを延ばす（試験の中身・並列度は変えない）
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: [
      {
        find: /^@touryou\/core\/fs$/,
        replacement: fileURLToPath(new URL("../core/src/fs.ts", import.meta.url)),
      },
      {
        find: /^@touryou\/core$/,
        replacement: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      },
    ],
  },
});
