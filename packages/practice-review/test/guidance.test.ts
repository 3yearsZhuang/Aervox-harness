import { describe, expect, it } from "vitest";
import { getPracticeGuidance } from "../src/guidance.js";

describe("getPracticeGuidance", () => {
  it("冷启动和待确认作答保持当前难度，且明确数据不足", () => {
    expect(getPracticeGuidance({ correctCount: 0, incorrectCount: 0, unverifiableCount: 1 })).toEqual({
      difficulty: "maintain",
      reasonCode: "insufficient_judged_answers",
      message: "本次可判定作答不足，先保持当前难度并继续积累结果。",
    });
  });

  it("正确率低于一半时建议降低难度", () => {
    expect(getPracticeGuidance({ correctCount: 1, incorrectCount: 2, unverifiableCount: 0 })).toEqual({
      difficulty: "ease",
      reasonCode: "low_accuracy",
      message: "本次正确率低于 50%，下一轮先降低难度并巩固基础。",
    });
  });

  it("高正确率、无提示且快速完成时建议提高难度", () => {
    expect(getPracticeGuidance({ correctCount: 4, incorrectCount: 1, unverifiableCount: 0, avgTimeSpentSec: 45, totalHintsUsed: 0 })).toEqual({
      difficulty: "increase",
      reasonCode: "high_accuracy_fast_no_hints",
      message: "本次正确率较高、用时稳定且未使用提示，下一轮可以提高难度。",
    });
  });

  it("其余情况保持当前难度", () => {
    expect(getPracticeGuidance({ correctCount: 4, incorrectCount: 1, unverifiableCount: 0, avgTimeSpentSec: 45, totalHintsUsed: 1 })).toEqual({
      difficulty: "maintain",
      reasonCode: "steady_progress",
      message: "本次表现稳定，下一轮保持当前难度并持续练习。",
    });
  });

  it("零作答且无待确认时仍判定为数据不足", () => {
    expect(getPracticeGuidance({ correctCount: 0, incorrectCount: 0, unverifiableCount: 0 })).toEqual({
      difficulty: "maintain",
      reasonCode: "insufficient_judged_answers",
      message: "本次可判定作答不足，先保持当前难度并继续积累结果。",
    });
  });

  it("正确率恰好 50% 时不降低难度（低于 50% 才降低）", () => {
    const result = getPracticeGuidance({ correctCount: 2, incorrectCount: 2, unverifiableCount: 0 });
    expect(result.difficulty).not.toBe("ease");
    expect(result.reasonCode).toBe("steady_progress");
  });

  it("正确率恰好 80% 且快速无提示时提高难度", () => {
    const result = getPracticeGuidance({ correctCount: 4, incorrectCount: 1, unverifiableCount: 0, avgTimeSpentSec: 60, totalHintsUsed: 0 });
    expect(result.difficulty).toBe("increase");
    expect(result.reasonCode).toBe("high_accuracy_fast_no_hints");
  });

  it("平均用时未知时即使高正确率也不提高难度", () => {
    const result = getPracticeGuidance({ correctCount: 5, incorrectCount: 0, unverifiableCount: 0, avgTimeSpentSec: null, totalHintsUsed: 0 });
    expect(result.difficulty).toBe("maintain");
    expect(result.reasonCode).toBe("steady_progress");
  });

  it("提示次数未知时即使高正确率也不提高难度", () => {
    const result = getPracticeGuidance({ correctCount: 5, incorrectCount: 0, unverifiableCount: 0, avgTimeSpentSec: 30, totalHintsUsed: null });
    expect(result.difficulty).toBe("maintain");
    expect(result.reasonCode).toBe("steady_progress");
  });

  it("有 1 道待确认时即使全对也保持当前难度", () => {
    const result = getPracticeGuidance({ correctCount: 3, incorrectCount: 0, unverifiableCount: 1, avgTimeSpentSec: 20, totalHintsUsed: 0 });
    expect(result.difficulty).toBe("maintain");
    expect(result.reasonCode).toBe("insufficient_judged_answers");
  });

  it("平均用时超过 60 秒时即使全对无提示也不提高难度", () => {
    const result = getPracticeGuidance({ correctCount: 5, incorrectCount: 0, unverifiableCount: 0, avgTimeSpentSec: 61, totalHintsUsed: 0 });
    expect(result.difficulty).toBe("maintain");
    expect(result.reasonCode).toBe("steady_progress");
  });
});
