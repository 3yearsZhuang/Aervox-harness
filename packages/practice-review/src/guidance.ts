export type PracticeGuidance = {
  difficulty: "ease" | "maintain" | "increase";
  reasonCode: "insufficient_judged_answers" | "low_accuracy" | "high_accuracy_fast_no_hints" | "steady_progress";
  message: string;
};

export type PracticeGuidanceInput = {
  correctCount: number;
  incorrectCount: number;
  unverifiableCount: number;
  avgTimeSpentSec?: number | null;
  totalHintsUsed?: number | null;
};

/**
 * Produce an explainable, deterministic suggestion for the next practice set.
 * Unknown timing or hint data never qualifies a session for a difficulty increase.
 */
export function getPracticeGuidance(input: PracticeGuidanceInput): PracticeGuidance {
  const judgedCount = input.correctCount + input.incorrectCount;
  if (judgedCount === 0 || input.unverifiableCount > 0) {
    return {
      difficulty: "maintain",
      reasonCode: "insufficient_judged_answers",
      message: "本次可判定作答不足，先保持当前难度并继续积累结果。",
    };
  }

  const accuracy = input.correctCount / judgedCount;
  if (accuracy < 0.5) {
    return {
      difficulty: "ease",
      reasonCode: "low_accuracy",
      message: "本次正确率低于 50%，下一轮先降低难度并巩固基础。",
    };
  }

  if (accuracy >= 0.8 && input.avgTimeSpentSec !== undefined && input.avgTimeSpentSec !== null && input.avgTimeSpentSec <= 60 && input.totalHintsUsed === 0) {
    return {
      difficulty: "increase",
      reasonCode: "high_accuracy_fast_no_hints",
      message: "本次正确率较高、用时稳定且未使用提示，下一轮可以提高难度。",
    };
  }

  return {
    difficulty: "maintain",
    reasonCode: "steady_progress",
    message: "本次表现稳定，下一轮保持当前难度并持续练习。",
  };
}
