/** Shared application command for HTTP answers and host-adapted judged answers. */
import { createHash } from "node:crypto";
import { stableSerialize } from "@aervox/core";
import { deriveAnswerOutcome } from "@aervox/practice-review";
import type { LearningAnswerCommand, LearningAnswerCommandPort, LearningAnswerPolicy, ReviewSchedulePort, LocalContext } from "@aervox/repositories";

const answerPolicy: LearningAnswerPolicy = {
  judge(answerSpec, answer) {
    if (!answerSpec || typeof answerSpec !== "object" || !("answer" in answerSpec) || typeof answerSpec.answer !== "string") return "unverifiable";
    return answer.trim().toLocaleLowerCase() === answerSpec.answer.trim().toLocaleLowerCase() ? "correct" : "incorrect";
  },
  // Mastery thresholds and review scheduling live in @aervox/practice-review so
  // every host (desktop API, mobile composition) derives identical outcomes.
  derive: deriveAnswerOutcome,
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
