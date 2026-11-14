import { describe, expect, it } from "vitest";
import { VIOLATION_OVERFLOW_SUMMARY, violationSummary } from "../src/compose.js";

// 範囲違反は、フックが拒んだときだけ記録する。受信箱の要約は、そのことをはっきり言う（Issue #6）
describe("範囲違反の受信箱の要約", () => {
  it("1 件ごとの要約は「フックが拒んだ」と理由・対象を言う", () => {
    const s = violationSummary("commandNotAllowed", "cat x");
    expect(s).toContain("フックが拒んだ");
    expect(s).toContain("commandNotAllowed");
    expect(s).toContain("cat x");
  });
  it("上限を超えたときの要約も、どれもフックが拒んだと言う", () => {
    expect(VIOLATION_OVERFLOW_SUMMARY).toContain("どれもフックが拒んだ");
  });
});
