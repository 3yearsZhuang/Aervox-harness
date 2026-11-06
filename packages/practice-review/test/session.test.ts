import { describe, expect, it } from "vitest";
import { buildPracticeReport, getPracticeSessionProgress } from "../src/session.js";

describe("getPracticeSessionProgress", () => {
  it("从固定题组快照定位首个未答题，并忽略重复作答", () => {
    expect(getPracticeSessionProgress(
      ["q_1", "q_2", "q_3"],
      [{ questionId: "q_1" }, { questionId: "q_1" }, { questionId: "q_2" }],
    )).toEqual({ answeredQuestionIds: ["q_1", "q_2"], nextQuestionIndex: 2 });
  });

  it("全部题目已答时，将下一题索引设为题组长度", () => {
    expect(getPracticeSessionProgress(
      ["q_1", "q_2"],
      [{ questionId: "q_2" }, { questionId: "q_1" }],
    )).toEqual({ answeredQuestionIds: ["q_2", "q_1"], nextQuestionIndex: 2 });
  });

  it("没有作答时从第一题继续，题组为空时不产生非法索引", () => {
    expect(getPracticeSessionProgress(["q_1"], [])).toEqual({ answeredQuestionIds: [], nextQuestionIndex: 0 });
    expect(getPracticeSessionProgress([], [])).toEqual({ answeredQuestionIds: [], nextQuestionIndex: 0 });
  });
});

describe("buildPracticeReport", () => {
  it("汇总判分、用时、提示并给出下一步", () => {
    const report = buildPracticeReport("practice_1", [
      { judgement: "correct", hintCount: 0, timeSpentSec: 30, nextStep: "continue" },
      { judgement: "incorrect", hintCount: 2, timeSpentSec: 90, nextStep: "review_scheduled" },
      { judgement: "unverifiable", hintCount: null, timeSpentSec: null, nextStep: "await_review" },
    ], 5);
    expect(report).toMatchObject({
      sessionId: "practice_1", questionCount: 5, answeredCount: 3, remainingCount: 2,
      correctCount: 1, incorrectCount: 1, unverifiableCount: 1, accuracy: 0.5,
      avgTimeSpentSec: 60, totalHintsUsed: 2, nextStep: "await_review",
    });
    expect(report.guidance).toBeTruthy();
  });

  it("无作答时准确率与平均用时为空，下一步为 continue", () => {
    const report = buildPracticeReport("practice_2", [], 3);
    expect(report).toMatchObject({ accuracy: null, avgTimeSpentSec: null, totalHintsUsed: 0, nextStep: "continue" });
  });
});
