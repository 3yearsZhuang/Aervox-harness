import { describe, expect, it } from "vitest";
import { getPracticeSessionProgress } from "../src/session.js";

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
