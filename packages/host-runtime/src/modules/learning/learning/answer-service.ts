/** Shared application command for HTTP answers and host-adapted judged answers. */
import { createHash } from "node:crypto";
import { stableSerialize } from "@aervox/core";
import { createReviewItem, updateAfterAnswer } from "@aervox/practice-review";
import type { LearningAnswerCommand, LearningAnswerCommandPort, LearningAnswerPolicy, ReviewSchedulePort, LocalContext } from "@aervox/repositories";

const answerPolicy: LearningAnswerPolicy = {
  judge(answerSpec, answer) {
    if (!answerSpec || typeof answerSpec !== "object" || !("answer" in answerSpec) || typeof answerSpec.answer !== "string") return "unverifiable";
    return answer.trim().toLocaleLowerCase() === answerSpec.answer.trim().toLocaleLowerCase() ? "correct" : "incorrect";
  },
  derive(stored, isCorrect, now, timeZone) {
    const item = { id: stored.id, name: stored.concept, correctCount: stored.correctCount, wrongCount: stored.wrongCount, correctStreak: stored.correctStreak, mastery: stored.mastery };
    updateAfterAnswer(item, isCorrect);
    const review = createReviewItem(item, isCorrect, { now, timeZone });
    return {
      state: {
        correctCount: item.correctCount, wrongCount: item.wrongCount, correctStreak: item.correctStreak, mastery: item.mastery,
        masteryState: item.mastery >= 0.8 ? "mastered" : "learning",
        masteryBasis: { correctCount: item.correctCount, wrongCount: item.wrongCount, correctStreak: item.correctStreak, schedulerVersion: review.schedulerVersion },
      },
      review: { dueAt: review.dueAt.toISOString(), intervalDays: review.intervalDays, schedulerVersion: review.schedulerVersion, timezoneSnapshot: timeZone },
    };
  },
};

export function createLearningAnswerService(port: LearningAnswerCommandPort) {
  return {
    recordAnswer(ctx: LocalContext, input: LearningAnswerCommand) {
      // Hash effective defaults, not incidental omitted properties or JSON key order.
      const common = { kind: input.kind, timeZone: input.timeZone ?? "UTC", hintCount: input.hintCount ?? 0, timeSpentSec: input.timeSpentSec ?? null, pluginGeneration: input.pluginGeneration ?? null };
      const request = input.kind === "existing-question"
        ? { ...common, questionId: input.questionId, sessionId: input.sessionId ?? "ses_unknown", answer: input.answer, evidence: input.evidence ?? null }
        : { ...common, turnId: input.turnId, prompt: input.prompt, questionType: input.questionType ?? null, userAnswer: input.userAnswer,
            correctAnswer: input.correctAnswer, judgement: input.judgement, explanation: input.explanation ?? null, knowledgeConcept: input.knowledgeConcept ?? null, source: input.source ?? "plugin" };
      const requestDigest = createHash("sha256").update(stableSerialize(request)).digest("hex");
      return port.recordAnswer(ctx, { ...input, requestDigest }, answerPolicy);
    },
  };
}

/** Review self-assessment shares answer derivation, evaluated under the writer lock. */
export function createLearningReviewService(port: Pick<ReviewSchedulePort, "completeReviewAndSchedule">) {
  return {
    completeReview(ctx: LocalContext, input: { reviewId: string; isCorrect: boolean; timeZone?: string }) {
      return port.completeReviewAndSchedule(ctx, input, answerPolicy.derive);
    },
  };
}
