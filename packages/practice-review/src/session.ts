/**
 * 根据创建时固定的题组快照，计算恢复练习时的已答进度。
 * 重复作答只计为同一题已答，保持首次出现顺序以便向客户端展示。
 */
import { getPracticeGuidance } from "./guidance.js";

export function getPracticeSessionProgress(
  questionIds: string[],
  attempts: Array<{ questionId: string }>,
): { answeredQuestionIds: string[]; nextQuestionIndex: number } {
  const answeredQuestionIds = [...new Set(attempts.map((attempt) => attempt.questionId))];
  const answeredIds = new Set(answeredQuestionIds);
  const nextQuestionIndex = questionIds.findIndex((questionId) => !answeredIds.has(questionId));
  return {
    answeredQuestionIds,
    nextQuestionIndex: nextQuestionIndex === -1 ? questionIds.length : nextQuestionIndex,
  };
}

export type PracticeAnswerOutcome = {
  judgement: string;
  hintCount?: number | null;
  timeSpentSec?: number | null;
  nextStep: "continue" | "review_scheduled" | "await_review";
};

/** Shared practice report assembly so every host counts and guides alike. */
export function buildPracticeReport(
  sessionId: string,
  attempted: PracticeAnswerOutcome[],
  questionCount: number,
) {
  const correctCount = attempted.filter((attempt) => attempt.judgement === "correct").length;
  const incorrectCount = attempted.filter((attempt) => attempt.judgement === "incorrect").length;
  const unverifiableCount = attempted.filter((attempt) => attempt.judgement === "unverifiable").length;
  const judgedCount = correctCount + incorrectCount;
  const timedAttempts = attempted.filter((attempt) => attempt.timeSpentSec !== undefined && attempt.timeSpentSec !== null);
  const avgTimeSpentSec = timedAttempts.length === 0
    ? null
    : Math.round(timedAttempts.reduce((total, attempt) => total + (attempt.timeSpentSec ?? 0), 0) / timedAttempts.length);
  const totalHintsUsed = attempted.reduce((total, attempt) => total + (attempt.hintCount ?? 0), 0);
  return {
    sessionId,
    questionCount,
    answeredCount: attempted.length,
    remainingCount: Math.max(questionCount - attempted.length, 0),
    correctCount,
    incorrectCount,
    unverifiableCount,
    accuracy: judgedCount === 0 ? null : correctCount / judgedCount,
    avgTimeSpentSec,
    totalHintsUsed,
    guidance: getPracticeGuidance({ correctCount, incorrectCount, unverifiableCount, avgTimeSpentSec, totalHintsUsed }),
    nextStep:
      attempted.some(attempt => attempt.nextStep === "await_review") ? "await_review" as const
        : attempted.some(attempt => attempt.nextStep === "review_scheduled") ? "review_scheduled" as const
          : "continue" as const,
  };
}
