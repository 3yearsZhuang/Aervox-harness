import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { questionAttempts } from "@aervox/schema";
import {
  createInMemoryDatabase, SqliteConversationRepository, SqliteLearningRepository,
  type LearningAnswerCommand, type LearningAnswerPolicy,
} from "../src/index.js";
import { canonicalAnswerRequest } from "../src/repositories/sqlite/learning-answer-store.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
const policy: LearningAnswerPolicy = {
  judge: (spec, answer) => (spec as { answer: string }).answer === answer ? "correct" : "incorrect",
  derive: (item, correct, now, timeZone) => ({
    state: { correctCount: item.correctCount + Number(correct), wrongCount: item.wrongCount + Number(!correct),
      correctStreak: correct ? item.correctStreak + 1 : 0, mastery: item.mastery, masteryState: "reviewing", masteryBasis: null },
    review: { dueAt: now.toISOString(), intervalDays: 1, schedulerVersion: 2, timezoneSnapshot: timeZone },
  }),
};

describe("practice identities survive SQLite text reads without prefix substitution", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let learning: SqliteLearningRepository;
  beforeEach(async () => { database = await createInMemoryDatabase(); learning = new SqliteLearningRepository(database.db); });
  afterEach(async () => { await database.cleanup(); });
  const record = (input: LearningAnswerCommand) => learning.recordAnswer(ctx, {
    ...input, requestDigest: createHash("sha256").update(JSON.stringify(canonicalAnswerRequest(input))).digest("hex"),
  }, policy);
  const receipts = async () => (await database.client.execute("SELECT payload FROM outbox_events WHERE event_type='learning.answer.recorded' ORDER BY id"))
    .rows.map(row => JSON.parse(String(row.payload)));

  it("returns complete question IDs, prompts and references from create/get/list", async () => {
    const knowledgeId = "knowledge\0后半段", sourceArtifactId = "source\0suffix";
    await learning.createKnowledgeItem(ctx, { id: knowledgeId, concept: "addition" });
    const input = { id: "question\0一", prompt: "题干\0后半段", knowledgeId, sourceArtifactId, answerSpec: { answer: "4\0完整", nested: [null, true] } };
    const created = await learning.createQuestion(ctx, input);
    const sibling = await learning.createQuestion(ctx, { ...input, id: "question\0二", prompt: "另一题\0完整" });
    const stored = JSON.parse(String((await database.client.execute({ sql: "SELECT json_object('id',id,'prompt',prompt,'knowledgeId',knowledge_id,'sourceArtifactId',source_artifact_id) value FROM questions WHERE id=?", args: [input.id] })).rows[0]!.value));
    expect(stored).toEqual({ id: input.id, prompt: input.prompt, knowledgeId, sourceArtifactId });
    expect(created).toMatchObject(input);
    expect(await learning.getQuestion(ctx, input.id)).toEqual(created);
    expect(await learning.getQuestion(ctx, "question")).toBeNull();
    expect(await learning.listActiveQuestions(ctx, 10)).toEqual([created, sibling]);
    expect(sibling.id).not.toBe(created.id);
  });

  it("preserves a fixed session identity and question group across reads and repeated completion", async () => {
    const input = { id: "practice_session\0suffix", questionCount: 2, questionIds: ["question\0一", "question\0二"] };
    const siblingId = "practice_session\0other";
    await learning.createPracticeSession(ctx, { ...input, id: siblingId });
    await database.client.execute({ sql: "UPDATE practice_sessions SET started_at=? WHERE id=?", args: ["2020-01-01T00:00:00.000Z", siblingId] });
    const created = await learning.createPracticeSession(ctx, input);
    expect(created).toMatchObject({ ...input, status: "active", endedAt: null });
    expect(await learning.getPracticeSession(ctx, input.id)).toEqual(created);
    expect(await learning.getLatestActivePracticeSession(ctx)).toEqual(created);
    expect(await learning.getPracticeSession(ctx, "practice_session")).toBeNull();
    const completed = await learning.completePracticeSession(ctx, input.id);
    expect(completed).toMatchObject({ ...input, status: "completed" });
    expect(completed?.endedAt).toEqual(expect.any(String));
    expect(await learning.completePracticeSession(ctx, input.id)).toEqual(completed);
    expect(await learning.getLatestActivePracticeSession(ctx)).toMatchObject({ id: siblingId, status: "active", endedAt: null });
    expect(await learning.getPracticeSession(ctx, siblingId)).toMatchObject({ id: siblingId, status: "active", endedAt: null });
    await learning.completePracticeSession(ctx, siblingId);
    expect(await learning.getLatestActivePracticeSession(ctx)).toBeNull();
  });

  it("keeps complete answer facts, progress identities and the original replay after completion", async () => {
    const questionId = "question\0一", sessionId = "practice_answer\0suffix";
    await learning.createQuestion(ctx, { id: questionId, prompt: "题干\0完整", answerSpec: { answer: "4\0完整" } });
    await learning.createPracticeSession(ctx, { id: sessionId, questionCount: 1, questionIds: [questionId] });
    const input: LearningAnswerCommand = { kind: "existing-question", questionId, sessionId, answer: "4\0完整", idempotencyKey: "answer-key\0一", evidence: { observation: "实测\0完整" }, hintCount: 2, timeSpentSec: 7 };
    const first = await record(input);
    expect(first).toMatchObject({ created: true, nextStep: "continue", attempt: { questionId, sessionId, answer: input.answer, idempotencyKey: input.idempotencyKey, evidence: input.evidence, hintCount: 2, timeSpentSec: 7 } });
    expect(await record(input)).toEqual({ ...first, created: false });
    expect(await learning.listAttemptsByQuestion(ctx, questionId)).toEqual([first.attempt]);
    expect(await learning.listAttemptsBySession(ctx, sessionId)).toEqual([first.attempt]);
    expect(await learning.listAttemptsBySession(ctx, "practice_answer")).toEqual([]);
    expect(await learning.listPracticeAnswerOutcomes(ctx, sessionId)).toEqual([{ ...first.attempt, nextStep: "continue" }]);
    const saved = await receipts();
    expect(saved).toEqual([expect.objectContaining({ questionId, sessionId, attemptId: first.attempt.id, nextStep: "continue" })]);
    expect(saved[0]).not.toHaveProperty("answer");
    await expect(record({ ...input, answer: "4" })).rejects.toThrow("idempotency_key_reused");
    await learning.completePracticeSession(ctx, sessionId);
    expect(await record(input)).toEqual({ ...first, created: false });
    await expect(record({ ...input, idempotencyKey: "answer-key\0二" })).rejects.toThrow("practice_session_not_active");
    expect(await learning.listAttemptsBySession(ctx, sessionId)).toEqual([first.attempt]);
    expect(await receipts()).toEqual(saved);
  });

  it("does not merge same-prefix questions or idempotency keys in attempts or mistakes", async () => {
    const ids = ["question\0一", "question\0二"], sessionId = "practice_siblings";
    for (const id of ids) await learning.createQuestion(ctx, { id, prompt: `题干 ${id}`, answerSpec: { answer: "correct" } });
    await learning.createPracticeSession(ctx, { id: sessionId, questionCount: 2, questionIds: ids });
    for (const [index, questionId] of ids.entries()) {
      const input: LearningAnswerCommand = { kind: "existing-question", questionId, sessionId, answer: `wrong\0${index}`, idempotencyKey: "shared\0key" };
      const first = await record(input);
      expect(await record(input)).toEqual({ ...first, created: false });
    }
    await record({ kind: "existing-question", questionId: ids[0]!, sessionId, answer: "wrong\0another", idempotencyKey: "shared\0different" });
    expect((await learning.listAttemptsBySession(ctx, sessionId)).map(attempt => attempt.questionId)).toEqual([ids[0], ids[1], ids[0]]);
    const mistakes = await learning.listMistakes(ctx);
    expect(mistakes).toHaveLength(2);
    expect(mistakes.find(item => item.questionId === ids[0])).toMatchObject({ prompt: `题干 ${ids[0]}`, latestAnswer: "wrong\0another", wrongCount: 2 });
    expect(mistakes.find(item => item.questionId === ids[1])).toMatchObject({ prompt: `题干 ${ids[1]}`, latestAnswer: "wrong\0" + "1", wrongCount: 1 });
  });

  it("retains all existing attempt fields, including difficulty, without manufacturing legacy receipts", async () => {
    const questionId = "legacy-question\0suffix", sessionId = "legacy-session\0suffix";
    await learning.createQuestion(ctx, { id: questionId, prompt: "legacy", answerSpec: {} });
    const attempt = { id: "legacy-attempt\0suffix", questionId, sessionId, answer: "legacy-answer\0suffix", judgement: "incorrect", evidence: { source: "legacy\0suffix" }, idempotencyKey: "legacy-key\0suffix", difficulty: 4, hintCount: 3, timeSpentSec: 8, createdAt: "2026-11-07T00:00:00.000Z" };
    await database.db.insert(questionAttempts).values(attempt);
    expect(await learning.listAttemptsByQuestion(ctx, questionId)).toEqual([attempt]);
    expect(await learning.listAttemptsBySession(ctx, sessionId)).toEqual([attempt]);
    expect(await learning.listPracticeAnswerOutcomes(ctx, sessionId)).toEqual([{ ...attempt, nextStep: "await_review" }]);
    await expect(record({ kind: "existing-question", questionId, sessionId, answer: attempt.answer, idempotencyKey: attempt.idempotencyKey })).rejects.toThrow("answer_receipt_unavailable");
    expect(await receipts()).toEqual([]);
  });

  it("updates only the full linked knowledge identity and leaves its prefix and sibling untouched", async () => {
    const knowledgeId = "knowledge\0一";
    for (const id of ["knowledge", knowledgeId, "knowledge\0二"]) await learning.createKnowledgeItem(ctx, { id, concept: id });
    await learning.createQuestion(ctx, { id: "linked-question", knowledgeId, prompt: "2+2", answerSpec: { answer: "4" } });
    await record({ kind: "existing-question", questionId: "linked-question", sessionId: "linked-session", answer: "3", idempotencyKey: "linked-key" });
    for (const id of ["knowledge", knowledgeId, "knowledge\0二"]) {
      const row = (await database.client.execute({ sql: "SELECT wrong_count FROM knowledge_items WHERE id=?", args: [id] })).rows[0]!;
      expect(row.wrong_count).toBe(Number(id === knowledgeId));
    }
    const linked = JSON.parse(String((await database.client.execute("SELECT json_object('knowledgeId',knowledge_id) value FROM review_items")).rows[0]!.value));
    expect(linked.knowledgeId).toBe(knowledgeId);
    expect((await learning.listMistakes(ctx))[0]?.knowledgeId).toBe(knowledgeId);
  });

  it("retains an existing full review identity in the committed receipt", async () => {
    await learning.createKnowledgeItem(ctx, { id: "knowledge", concept: "addition" });
    await learning.createQuestion(ctx, { id: "question", knowledgeId: "knowledge", prompt: "2+2", answerSpec: { answer: "4" } });
    const reviewId = "review\0suffix";
    await learning.createReviewItem(ctx, { id: reviewId, knowledgeId: "knowledge", dueAt: "2025-01-01T00:00:00.000Z" });
    const input: LearningAnswerCommand = { kind: "existing-question", questionId: "question", answer: "3", idempotencyKey: "review-key" };
    const first = await record(input);
    expect(first.nextStep).toBe("review_scheduled");
    expect((await receipts())[0].reviewId).toBe(reviewId);
    expect((await database.client.execute("SELECT count(*) n FROM review_items")).rows[0]!.n).toBe(1);
    expect(await record(input)).toEqual({ ...first, created: false });
  });

  it("resolves a judged source to its full actual session and returns full generated question/answer text", async () => {
    const conversation = new SqliteConversationRepository(database.db), sessionId = "source-session\0suffix";
    await conversation.createSession(ctx, "source", { id: sessionId });
    await conversation.createTurnWithAttempt(ctx, { turnId: "source-turn", sessionId, idempotencyKey: "source-turn", message: { id: "source-message", content: "question" }, attemptId: "source-attempt" });
    const input: LearningAnswerCommand = { kind: "judged-question", turnId: "source-turn", prompt: "题干\0完整", userAnswer: "3\0完整", correctAnswer: "4\0完整", judgement: "incorrect", idempotencyKey: "judged-key\0suffix" };
    const first = await record(input);
    expect(first.attempt).toMatchObject({ sessionId, answer: input.userAnswer });
    expect(await learning.getQuestion(ctx, first.attempt.questionId)).toMatchObject({ prompt: input.prompt, answerSpec: { answer: input.correctAnswer } });
    expect((await receipts())[0].sessionId).toBe(sessionId);
    expect(await learning.listAttemptsBySession(ctx, "source-session")).toEqual([]);
    expect(await record(input)).toEqual({ ...first, created: false });
  });

  it("keeps damaged receipts unavailable instead of guessing a prefix match", async () => {
    const questionId = "question\0suffix", input: LearningAnswerCommand = { kind: "existing-question", questionId, sessionId: "practice_damaged", answer: "4", idempotencyKey: "key" };
    await learning.createQuestion(ctx, { id: questionId, prompt: "test", answerSpec: { answer: "4" } });
    await learning.createPracticeSession(ctx, { id: input.sessionId!, questionCount: 1, questionIds: [questionId] });
    const first = await record(input);
    await database.client.execute("UPDATE outbox_events SET payload=json_set(payload,'$.questionId','question') WHERE event_type='learning.answer.recorded'");
    const saved = await receipts();
    await expect(record(input)).rejects.toThrow("answer_receipt_unavailable");
    expect(await learning.listPracticeAnswerOutcomes(ctx, input.sessionId!)).toEqual([{ ...first.attempt, nextStep: "await_review" }]);
    expect(await receipts()).toEqual(saved);
    expect(await learning.listAttemptsByQuestion(ctx, questionId)).toEqual([first.attempt]);
  });
});
