import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pendingUserQuestions } from "@aervox/schema";
import { createPostgresqlDatabase, type OpenedPostgresqlDatabase } from "../src/driver/create-postgresql-database.js";
import { SqliteConversationRepository } from "../src/repositories/sqlite/conversation-repository.js";
import { SqliteLearningRepository } from "../src/repositories/sqlite/learning-repository.js";
import { SqlitePrivacyRepository } from "../src/repositories/sqlite/privacy-repository.js";
import { canonicalAnswerRequest } from "../src/repositories/sqlite/learning-answer-store.js";
import { MEMORY_DELETION_VERIFIER } from "../src/memory-deletion-protocol.js";
import type { LearningAnswerCommand, LearningAnswerPolicy } from "../src/repositories/types/index.js";

const connectionString = process.env.AERVOX_PG_TEST_URL ?? process.env.AERVOX_TEST_POSTGRES_URL;
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const ctx = { workspaceId: "local", subjectUserId: "local" };
const policy: LearningAnswerPolicy = {
  judge: (spec, answer) => (spec as { answer: string }).answer === answer ? "correct" : "incorrect",
  derive: (item, correct, now, timeZone) => ({
    state: { correctCount: item.correctCount + Number(correct), wrongCount: item.wrongCount + Number(!correct),
      correctStreak: correct ? item.correctStreak + 1 : 0, mastery: item.mastery, masteryState: "reviewing", masteryBasis: null },
    review: { dueAt: now.toISOString(), intervalDays: 1, schedulerVersion: 2, timezoneSnapshot: timeZone },
  }),
};

describe.skipIf(!connectionString)("PostgreSQL current conversation, learning and deletion contracts", () => {
  let admin: Pool;
  const schemas: string[] = [];
  const owned: OpenedPostgresqlDatabase[] = [];
  beforeAll(() => { admin = new Pool({ connectionString }); });
  afterAll(async () => {
    for (const database of owned) await database.closeAsync();
    for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await admin.end();
  });
  async function fresh() {
    const schema = `aervox_current_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    const config = { connectionString: connectionString!, schema, instanceId: `owner-${randomUUID()}` };
    const database = await createPostgresqlDatabase({ ...config, initializeEmpty: true }); owned.push(database);
    return { database, config };
  }
  const record = (repo: SqliteLearningRepository, input: LearningAnswerCommand) => repo.recordAnswer(ctx, {
    ...input, requestDigest: createHash("sha256").update(JSON.stringify(canonicalAnswerRequest(input))).digest("hex"),
  }, policy);

  it("persists invocation identity and legacy NULL through schema-verified reopening", async () => {
    const { database, config } = await fresh();
    const values = { attemptId: "attempt", step: 1, questionsJson: [{ id: "question", question: "选择 🌙" }], timeoutMs: 30_000,
      expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" };
    const invocationId = 'tool-"\\🌙';
    await database.db.insert(pendingUserQuestions).values([
      { ...values, turnId: "current", invocationId }, { ...values, turnId: "legacy", invocationId: null },
    ]);
    await database.closeAsync();
    const reopened = await createPostgresqlDatabase(config); owned.push(reopened);
    expect(await reopened.db.select().from(pendingUserQuestions).where(eq(pendingUserQuestions.turnId, "current")))
      .toEqual([{ ...values, turnId: "current", invocationId }]);
    expect((await reopened.db.select().from(pendingUserQuestions).where(eq(pendingUserQuestions.turnId, "legacy")))[0]?.invocationId).toBeNull();
  });

  it("binds durable question answers and replay to the exact invocation after reopening", async () => {
    const { database, config } = await fresh();
    const repo = new SqliteConversationRepository(database.db);
    const identity = { turnId: "turn", attemptId: "attempt", invocationId: 'tool-"🌙:1', step: 1 };
    await repo.getOrCreateSession(ctx, "question-session");
    await repo.acceptTurn(ctx, { turnId: identity.turnId, sessionId: "question-session", idempotencyKey: "turn-key",
      attemptId: identity.attemptId, message: { id: "user", content: "Question source" }, consumeInbox: false });
    const claim = await repo.claimTurnAttempt(ctx, { turnId: identity.turnId, attemptId: identity.attemptId,
      expectedFencingToken: 0, leaseId: "lease" });
    expect(claim.ok).toBe(true);
    const questions = [{ id: "choice", question: "选择?", options: [{ label: "A" }, { label: "B" }] }];
    const request = { ...identity, expectedFencingToken: claim.fencingToken, leaseId: claim.leaseId, questions, timeoutMs: 60_000 };
    const required = await repo.requireUserQuestion(ctx, request);
    expect(await repo.requireUserQuestion(ctx, request)).toEqual(required);
    await database.closeAsync();
    const reopened = await createPostgresqlDatabase(config); owned.push(reopened);
    const reread = new SqliteConversationRepository(reopened.db);
    expect(await reread.getPendingUserQuestion(ctx, identity.turnId)).toEqual(required.pending);
    const answers = [{ id: "choice", selected: ["A"] }];
    const receipt = await reread.answerUserQuestion(ctx, identity, answers);
    expect(await reread.getUserQuestionAnswerReceipt(ctx, identity)).toEqual(receipt);
    expect(await reread.getUserQuestionAnswerReceipt(ctx, { ...identity, invocationId: 'tool-"🌙' })).toBeNull();
    expect(await reread.answerUserQuestion(ctx, identity, answers)).toEqual(receipt);
    expect(await reread.getPendingUserQuestion(ctx, identity.turnId)).toBeNull();
    const next = { ...request, invocationId: 'tool-"🌙:2' };
    await reread.requireUserQuestion(ctx, next);
    expect(await reread.answerUserQuestion(ctx, identity, answers)).toEqual(receipt);
    expect(await reread.getPendingUserQuestion(ctx, identity.turnId)).toMatchObject({ invocationId: next.invocationId });
    await new SqlitePrivacyRepository(reopened.db).createDeletionRequest(ctx, { id: "deletion", scope: "memory", ownerModule: "memory", idempotencyKey: "delete" });
    expect(await reread.getPendingUserQuestion(ctx, identity.turnId)).toBeNull();
    expect(await reread.getUserQuestionAnswerReceipt(ctx, identity)).toBeNull();
    await expect(reread.answerUserQuestion(ctx, identity, answers)).rejects.toThrow("deletion_blocked");
  });

  it("retains typed practice receipts, mistakes and linked completed reviews after a real reopen", async () => {
    const { database, config } = await fresh();
    const repo = new SqliteLearningRepository(database.db);
    const knowledgeId = 'knowledge-"\\🌙', questionId = 'question-"\\🌙', sessionId = 'practice_"\\🌙';
    const concept = '二次方程 "引用"\nα + β';
    await repo.createKnowledgeItem(ctx, { id: knowledgeId, concept, sourceStatus: "observed" });
    const question = await repo.createQuestion(ctx, { id: questionId, knowledgeId, prompt: concept,
      answerSpec: { answer: "4", nested: [null, true, 3] } });
    const session = await repo.createPracticeSession(ctx, { id: sessionId, questionCount: 1, questionIds: [questionId] });
    expect(question.answerSpec).toEqual({ answer: "4", nested: [null, true, 3] });
    expect(session.questionIds).toEqual([questionId]);
    const input: LearningAnswerCommand = { kind: "existing-question", questionId, sessionId, answer: 'wrong-"🌙',
      evidence: { observed: true, nested: [1, null] }, idempotencyKey: 'key-"🌙' };
    const first = await record(repo, input);
    expect(first).toMatchObject({ created: true, nextStep: "review_scheduled", attempt: { evidence: input.evidence, answer: input.answer } });
    expect(await repo.listMistakes(ctx)).toMatchObject([{ questionId, knowledgeId, prompt: concept, latestAnswer: input.answer, wrongCount: 1 }]);
    const due = await repo.listDueReviewItems(ctx, "2999-01-01T00:00:00.000Z");
    expect(due).toHaveLength(1);
    const completion = { reviewId: due[0]!.id, isCorrect: true, timeZone: "Asia/Shanghai" };
    const completed = await repo.completeReviewAndSchedule(ctx, completion, policy.derive);
    expect(completed?.completed.completionIsCorrect).toBe(true);
    expect(completed?.knowledge).toMatchObject({ id: knowledgeId, concept, correctCount: 1, wrongCount: 1, masteryBasis: null });
    await repo.completePracticeSession(ctx, sessionId);
    await database.closeAsync();
    const reopened = await createPostgresqlDatabase(config); owned.push(reopened);
    const reread = new SqliteLearningRepository(reopened.db);
    expect(await reread.getQuestion(ctx, questionId)).toEqual(question);
    expect(await record(reread, input)).toEqual({ ...first, created: false });
    expect(await reread.listPracticeAnswerOutcomes(ctx, sessionId)).toEqual([{ ...first.attempt, nextStep: "review_scheduled" }]);
    expect(await reread.completeReviewAndSchedule(ctx, completion, policy.derive)).toEqual(completed);
    expect(await reread.listCompletedReviewItems(ctx)).toEqual([{ ...completed!.completed, nextReview: completed!.nextReview }]);
    await expect(reread.completeReviewAndSchedule(ctx, { ...completion, isCorrect: false }, policy.derive)).rejects.toThrow("review_completion_payload_mismatch");
    // A missing linked review is represented as JSON null, never a string or a fabricated schedule.
    await reopened.client.execute({ sql: "DELETE FROM review_items WHERE id=?", args: [completed!.nextReview.id] });
    expect((await reread.listCompletedReviewItems(ctx))[0]?.nextReview).toBeNull();
  });

  it("uses the actual source session when recording judged question answers", async () => {
    const { database } = await fresh();
    const conversation = new SqliteConversationRepository(database.db), learning = new SqliteLearningRepository(database.db);
    const sessionId = 'session-"\\🌙';
    await conversation.createSession(ctx, "source", { id: sessionId });
    await conversation.createTurnWithAttempt(ctx, { turnId: "source-turn", sessionId, idempotencyKey: "source-turn",
      message: { id: "source-message", content: "question" }, attemptId: "source-attempt" });
    const input: LearningAnswerCommand = { kind: "judged-question", turnId: "source-turn", prompt: '题干-"🌙',
      userAnswer: "3", correctAnswer: "4", judgement: "incorrect", idempotencyKey: "judged-key", knowledgeConcept: "addition" };
    const first = await record(learning, input);
    expect(first.attempt.sessionId).toBe(sessionId);
    expect(await learning.getQuestion(ctx, first.attempt.questionId)).toMatchObject({ prompt: input.prompt, answerSpec: { answer: "4" } });
    expect(await record(learning, input)).toEqual({ ...first, created: false });
  });

  async function deletionFixture() {
    const { database, config } = await fresh();
    const repo = new SqlitePrivacyRepository(database.db), requestId = 'request-"🌙', targetId = 'target-"🌙';
    await repo.createDeletionRequest(ctx, { id: requestId, idempotencyKey: requestId, scope: "memory", ownerModule: "memory",
      targets: [{ targetType: "memory", targetId, ownerModule: "memory" }] });
    const first = await repo.beginDeletionRequestAttempt(requestId);
    const key = { requestId, requestAttemptCount: first!.attemptCount, targetId, targetType: "memory" };
    const evidenceRef = JSON.stringify({ verifier: MEMORY_DELETION_VERIFIER });
    return { database, config, repo, key, evidenceRef };
  }

  it("fences stale target receipts, request failure and finalization by the current request epoch", async () => {
    const { database, repo, key, evidenceRef } = await deletionFixture();
    await repo.beginDeletionTargetAttempt(key);
    const next = await repo.beginDeletionRequestAttempt(key.requestId);
    expect(next?.attemptCount).toBe(key.requestAttemptCount + 1);
    expect(await repo.beginDeletionTargetAttempt(key)).toBeNull();
    expect(await repo.updateDeletionTargetAttemptStatus(key, { status: "completed", evidenceRef })).toBeNull();
    expect(await repo.failDeletionRequestAttempt(key, "stale")).toBeNull();
    expect(await repo.finalizeDeletionRequestAttempt(key, "stale")).toBeNull();
    const current = { ...key, requestAttemptCount: next!.attemptCount };
    expect(await repo.beginDeletionTargetAttempt(current)).toMatchObject({ status: "in_progress", attemptCount: 2 });
    expect(await repo.updateDeletionTargetAttemptStatus(current, { status: "completed", evidenceRef })).toMatchObject({ status: "completed", evidenceRef });
    expect(await repo.finalizeDeletionRequestAttempt(current, "current")).toMatchObject({ status: "completed", attemptCount: current.requestAttemptCount });
    expect(await repo.finalizeDeletionRequestAttempt(current, "duplicate")).toBeNull();
    // An unrelated queued request must not cause a completed identity to reopen through an ungrouped OR.
    await repo.createDeletionRequest(ctx, { id: "other", idempotencyKey: "other", scope: "memory", ownerModule: "memory" });
    expect(await repo.beginDeletionRequestAttempt(key.requestId)).toBeNull();
    const audits = await database.client.execute("SELECT actor_id,metadata FROM audit_records WHERE action='deletion.completed'");
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.actor_id).toBe("deletion:current");
    expect(JSON.parse(String(audits.rows[0]?.metadata))).toMatchObject({ verifier: MEMORY_DELETION_VERIFIER, targetCount: 1 });
  });

  it.each(["scope", "verifier"] as const)("refuses atomic finalization with an unsupported %s and creates no completion audit", async unsupported => {
    const { database, repo, key, evidenceRef } = await deletionFixture();
    await repo.beginDeletionTargetAttempt(key);
    await repo.updateDeletionTargetAttemptStatus(key, { status: "completed", evidenceRef: unsupported === "verifier" ? '{}' : evidenceRef });
    if (unsupported === "scope") await database.client.execute({ sql: "UPDATE deletion_requests SET scope='account' WHERE id=?", args: [key.requestId] });
    expect(await repo.finalizeDeletionRequestAttempt(key, "worker")).toBeNull();
    expect(await repo.getDeletionRequest(ctx, key.requestId)).toMatchObject({ status: "in_progress", lastVerifiedAt: null });
    expect((await database.client.execute("SELECT id FROM audit_records WHERE action='deletion.completed'")).rows).toEqual([]);
  });

  it("atomically rolls back completion when the audit insert fails, then completes once", async () => {
    const { database, config, repo, key, evidenceRef } = await deletionFixture();
    await repo.beginDeletionTargetAttempt(key);
    await repo.updateDeletionTargetAttemptStatus(key, { status: "completed", evidenceRef });
    await admin.query(`ALTER TABLE ${quote(config.schema)}.audit_records ADD CONSTRAINT reject_completion CHECK (action <> 'deletion.completed')`);
    await expect(repo.finalizeDeletionRequestAttempt(key, "worker")).rejects.toMatchObject({ code: "23514" });
    expect(await repo.getDeletionRequest(ctx, key.requestId)).toMatchObject({ status: "in_progress", lastVerifiedAt: null, attemptCount: key.requestAttemptCount });
    expect((await database.client.execute("SELECT id FROM audit_records WHERE action='deletion.completed'")).rows).toEqual([]);
    await admin.query(`ALTER TABLE ${quote(config.schema)}.audit_records DROP CONSTRAINT reject_completion`);
    expect(await repo.finalizeDeletionRequestAttempt(key, "worker")).toMatchObject({ status: "completed" });
    expect(await repo.hasPendingDeletionRequest(ctx)).toBe(false);
    expect((await database.client.execute("SELECT id FROM audit_records WHERE action='deletion.completed'")).rows).toHaveLength(1);
  });
});
