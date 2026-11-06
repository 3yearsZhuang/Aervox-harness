/** Shared application command for HTTP answers and host-adapted judged answers. */
import { createHash } from "node:crypto";
import { stableSerialize } from "@aervox/core";
import { deriveAnswerOutcome, judgeAnswer } from "@aervox/practice-review";
import { canonicalAnswerRequest } from "@aervox/repositories";
import type { LearningAnswerCommand, LearningAnswerCommandPort, LearningAnswerPolicy, ReviewSchedulePort, LocalContext } from "@aervox/repositories";

const answerPolicy: LearningAnswerPolicy = {
  // Judgement, mastery thresholds and review scheduling live in
  // @aervox/practice-review so every host derives identical outcomes.
  judge: judgeAnswer,
  derive: deriveAnswerOutcome,
};

export function createLearningAnswerService(port: LearningAnswerCommandPort) {
  return {
    recordAnswer(ctx: LocalContext, input: LearningAnswerCommand) {
      // Hash effective defaults, not incidental omitted properties or JSON key order.
      const requestDigest = createHash("sha256").update(stableSerialize(canonicalAnswerRequest(input))).digest("hex");
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
