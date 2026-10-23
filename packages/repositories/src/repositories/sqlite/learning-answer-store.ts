/** One writer transaction owns answer facts, derived state, scheduling and the durable receipt. */
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { knowledgeItems, outboxEvents, practiceSessions, questionAttempts, questions, reviewItems, turns } from "@aervox/schema";
import type { AervoxDatabase } from "../../client.js";
import { assertPersonalDerivedDataSource } from "../../conversation-execution-policy.js";
import { assertPluginGeneration } from "../../plugin-generation-guard.js";
import type { LocalContext } from "../../local-context.js";
import type { AnswerNextStep, LearningAnswerCommand, LearningAnswerPolicy, LearningAnswerResult, QuestionAttemptModel } from "../types/index.js";

interface AnswerReceipt {
  payloadVersion: 1;
  requestDigest: string;
  questionId: string;
  attemptId: string;
  sessionId: string;
  judgement: string;
  nextStep: AnswerNextStep;
  reviewId: string | null;
}

export async function recordLearningAnswer(
  db: AervoxDatabase,
  _ctx: LocalContext,
  input: LearningAnswerCommand & { requestDigest: string },
  policy: LearningAnswerPolicy,
): Promise<LearningAnswerResult> {
  if (input.idempotencyKey !== undefined && !input.idempotencyKey.trim()) throw new Error("answer_idempotency_key_required");
  if (!/^[a-f0-9]{64}$/.test(input.requestDigest)) throw new Error("answer_request_digest_required");
  const scope = input.kind === "existing-question" ? [input.kind, input.questionId, input.idempotencyKey ?? randomUUID()] : [input.kind, input.idempotencyKey];
  const digest = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  // Keep the existing generated question identity so legacy facts are detected, never recreated.
  const judgedDigest = input.kind === "judged-question" ? createHash("sha256").update(input.idempotencyKey).digest("hex") : null;
  const questionId = input.kind === "existing-question" ? input.questionId : `q_judged_${judgedDigest}`;
  const attemptId = input.kind === "judged-question" ? `att_judged_${judgedDigest}` : `att_answer_${digest}`;
  const eventKey = `learning-answer:${digest}`;
  return db.transaction(async (tx) => {
    await assertPluginGeneration(tx, input.pluginGeneration);
    let sessionId = input.kind === "existing-question" ? input.sessionId ?? "ses_unknown" : "";
    if (input.kind === "judged-question") {
      await assertPersonalDerivedDataSource(tx, input.turnId);
      const [turn] = await tx.select({ sessionId: turns.sessionId }).from(turns).where(eq(turns.id, input.turnId));
      if (!turn) throw new Error("judged_answer_source_turn_unavailable");
      sessionId = turn.sessionId;
    }
    if (input.idempotencyKey !== undefined) {
      const [existing] = await tx.select().from(questionAttempts).where(and(eq(questionAttempts.questionId, questionId), eq(questionAttempts.idempotencyKey, input.idempotencyKey)));
      if (existing) {
        const [event] = await tx.select({ payload: outboxEvents.payload }).from(outboxEvents).where(eq(outboxEvents.idempotencyKey, eventKey));
        const receipt = event?.payload as AnswerReceipt | undefined;
        // A pre-command fact cannot prove that its separate derived writes committed.
        // Never invent a successful schedule or silently repair historical partial work.
        if (receipt?.payloadVersion !== 1 || receipt.attemptId !== existing.id || receipt.questionId !== existing.questionId || !["continue", "review_scheduled", "await_review"].includes(receipt.nextStep)) {
          throw new Error("answer_receipt_unavailable");
        }
        if (receipt.requestDigest !== input.requestDigest) throw new Error("idempotency_key_reused");
        return { attempt: existing as QuestionAttemptModel, nextStep: receipt.nextStep, created: false };
      }
    }
    if (input.kind === "judged-question" && input.legacyIdempotencyKey && input.legacyIdempotencyKey !== input.idempotencyKey) {
      const legacyDigest = createHash("sha256").update(input.legacyIdempotencyKey).digest("hex");
      const [legacy] = await tx.select({ id: questionAttempts.id }).from(questionAttempts).where(and(eq(questionAttempts.questionId, `q_judged_${legacyDigest}`), eq(questionAttempts.idempotencyKey, input.legacyIdempotencyKey)));
      if (legacy) throw new Error("answer_receipt_unavailable");
    }

    const now = new Date();
    const timestamp = now.toISOString();
    let question: typeof questions.$inferSelect;
    if (input.kind === "existing-question") {
      const [stored] = await tx.select().from(questions).where(eq(questions.id, questionId));
      if (!stored) throw new Error("question_not_found");
      question = stored;
      // Revalidate inside the writer transaction; a completion cannot race the fact.
      if (sessionId.startsWith("practice_")) {
        const [session] = await tx.select().from(practiceSessions).where(eq(practiceSessions.id, sessionId));
        if (!session || session.status !== "active") throw new Error("practice_session_not_active");
        if (!Array.isArray(session.questionIds) || !session.questionIds.includes(questionId)) throw new Error("question_not_in_practice_session");
      }
    } else {
      let knowledgeId: string | null = null;
      if (input.knowledgeConcept?.trim()) {
        // A generated question owns its concept identity; matching text never merges user data.
        knowledgeId = `ki_judged_${judgedDigest}`;
        await tx.insert(knowledgeItems).values({ id: knowledgeId, concept: input.knowledgeConcept, sourceStatus: "inferred", createdAt: timestamp, updatedAt: timestamp });
      }
      const [created] = await tx.insert(questions).values({ id: questionId, knowledgeId, prompt: input.prompt,
        answerSpec: { answer: input.correctAnswer, type: input.questionType ?? null, explanation: input.explanation ?? null },
        status: "active", createdAt: timestamp, updatedAt: timestamp }).returning();
      question = created!;
    }
    const judgement = input.kind === "existing-question" ? policy.judge(question.answerSpec, input.answer) : input.judgement;
    const [attempt] = await tx.insert(questionAttempts).values({ id: attemptId, sessionId, questionId,
      answer: input.kind === "existing-question" ? input.answer : input.userAnswer, judgement,
      idempotencyKey: input.idempotencyKey ?? null,
      evidence: input.kind === "existing-question" ? input.evidence ?? null : { source: input.source ?? "plugin", turnId: input.turnId, explanation: input.explanation ?? null, knowledgeConcept: input.knowledgeConcept ?? null },
      hintCount: input.hintCount ?? 0, timeSpentSec: input.timeSpentSec ?? null, createdAt: timestamp }).returning();

    let reviewId: string | null = null;
    if (question.knowledgeId && (judgement === "correct" || judgement === "incorrect")) {
      const [knowledge] = await tx.select().from(knowledgeItems).where(eq(knowledgeItems.id, question.knowledgeId));
      if (!knowledge) throw new Error("answer_knowledge_unavailable");
      const derived = policy.derive(knowledge, judgement === "correct", now, input.timeZone ?? "UTC");
      await tx.update(knowledgeItems).set({ ...derived.state, updatedAt: timestamp }).where(eq(knowledgeItems.id, knowledge.id));
      const [scheduled] = await tx.update(reviewItems).set({ ...derived.review, updatedAt: timestamp })
        .where(and(eq(reviewItems.knowledgeId, knowledge.id), eq(reviewItems.status, "active"))).returning({ id: reviewItems.id });
      reviewId = scheduled?.id ?? `review_answer_${digest}`;
      if (!scheduled) await tx.insert(reviewItems).values({ id: reviewId, knowledgeId: knowledge.id, ...derived.review, status: "active", createdAt: timestamp, updatedAt: timestamp });
    }
    const nextStep: AnswerNextStep = judgement === "correct" ? "continue" : judgement === "incorrect" && reviewId !== null ? "review_scheduled" : "await_review";
    const receipt: AnswerReceipt = { payloadVersion: 1, requestDigest: input.requestDigest, questionId, attemptId, sessionId, judgement, nextStep, reviewId };
    // This receipt is retained with the immutable attempt, including after publication.
    // No answer body is copied into the event, and a retry never derives from today's review state.
    await tx.insert(outboxEvents).values({ id: `out_answer_${digest}`, idempotencyKey: eventKey, eventType: "learning.answer.recorded", payload: receipt, createdAt: timestamp });
    return { attempt: attempt as QuestionAttemptModel, nextStep, created: true };
  });
}
