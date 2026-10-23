import Fastify from "fastify";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteExtensionRepository, SqliteLearningRepository } from "@aervox/repositories";
import { registerLearningRoutes } from "@aervox/host-runtime-test/modules/learning/learning/routes";
import { createPluginHostServicesFactory } from "@aervox/host-runtime-test/plugin-host-services";

const ctx = { workspaceId: "local", subjectUserId: "local" };
const headers = { "idempotency-key": "answer-command" };
const payload = { sessionId: "session", answer: "3", timeZone: "Asia/Shanghai", elapsedSeconds: 20, hintsUsed: 1, evidence: { observation: "submitted" } };
type Database = Awaited<ReturnType<typeof createInMemoryDatabase>>;

describe("shared learning answer transaction through HTTP and plugin ports", () => {
  let database: Database;
  let app: ReturnType<typeof Fastify>;
  let learning: SqliteLearningRepository;

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    learning = new SqliteLearningRepository(database.db);
    await learning.createKnowledgeItem(ctx, { id: "knowledge", concept: "addition" });
    await learning.createQuestion(ctx, { id: "question", knowledgeId: "knowledge", prompt: "2 + 2", answerSpec: { answer: "4" } });
    app = Fastify();
    registerLearningRoutes(app, learning);
    await app.ready();
  });

  afterEach(async () => { await app.close(); await database.cleanup(); });

  const state = async (source: Database) => ({
    attempts: (await source.client.execute("SELECT * FROM question_attempts ORDER BY id")).rows,
    knowledge: (await source.client.execute("SELECT * FROM knowledge_items ORDER BY id")).rows,
    questions: (await source.client.execute("SELECT * FROM questions ORDER BY id")).rows,
    reviews: (await source.client.execute("SELECT * FROM review_items ORDER BY id")).rows,
    outbox: (await source.client.execute("SELECT * FROM outbox_events ORDER BY id")).rows,
  });
  const submit = () => app.inject({ method: "POST", url: "/v1/questions/question/attempts", headers, payload });

  it.each([
    ["attempt", "BEFORE INSERT ON question_attempts"],
    ["mastery", "BEFORE UPDATE ON knowledge_items"],
    ["new review", "BEFORE INSERT ON review_items"],
    ["Outbox", "BEFORE INSERT ON outbox_events"],
  ])("rolls back every HTTP write when %s fails, and retries the original key completely", async (_step, clause) => {
    const before = await state(database);
    await database.client.execute(`CREATE TRIGGER fail_answer ${clause} BEGIN SELECT RAISE(ABORT, 'injected_answer_failure'); END`);
    expect((await submit()).statusCode).toBe(500);
    expect(await state(database)).toEqual(before);
    await database.client.execute("DROP TRIGGER fail_answer");
    const first = await submit();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ sessionId: "session", questionId: "question", answer: "3", judgement: "incorrect", nextStep: "review_scheduled", hintCount: 1, timeSpentSec: 20, evidence: payload.evidence });
    const retry = await submit();
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(await learning.getKnowledgeItem(ctx, "knowledge")).toMatchObject({ wrongCount: 1, correctCount: 0, correctStreak: 0 });
    const after = await state(database);
    expect(after.attempts).toHaveLength(1);
    expect(after.reviews).toHaveLength(1);
    expect(after.reviews[0]).toMatchObject({ knowledge_id: "knowledge", interval_days: 1, timezone_snapshot: "Asia/Shanghai", scheduler_version: 2 });
    expect(after.outbox).toHaveLength(1);
    const receipt = JSON.parse(String(after.outbox[0]!.payload));
    expect(receipt).toMatchObject({ payloadVersion: 1, attemptId: first.json().id, nextStep: "review_scheduled", reviewId: after.reviews[0]!.id });
    expect(receipt).not.toHaveProperty("answer");
  });

  it("rolls back an existing active review update and mastery together", async () => {
    await learning.createReviewItem(ctx, { id: "original-review", knowledgeId: "knowledge", dueAt: "2025-01-01T00:00:00.000Z" });
    const before = await state(database);
    await database.client.execute("CREATE TRIGGER fail_review_update BEFORE UPDATE ON review_items BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect((await submit()).statusCode).toBe(500);
    expect(await state(database)).toEqual(before);
    await database.client.execute("DROP TRIGGER fail_review_update");
    expect((await submit()).statusCode).toBe(201);
    expect((await state(database)).reviews).toEqual([expect.objectContaining({ id: "original-review", interval_days: 1 })]);
  });

  it("converges concurrent same-key requests to one complete fact, schedule and receipt", async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, submit));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    for (const response of responses) expect(response.json()).toEqual(responses[0]!.json());
    const after = await state(database);
    expect(after.attempts).toHaveLength(1);
    expect(after.reviews).toHaveLength(1);
    expect(after.outbox).toHaveLength(1);
    expect(await learning.getKnowledgeItem(ctx, "knowledge")).toMatchObject({ wrongCount: 1 });
  });

  it("uses current transactional knowledge state for concurrent different answers", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, (_, index) => app.inject({ method: "POST", url: "/v1/questions/question/attempts", headers: { "idempotency-key": `different-${index}` }, payload: { answer: "4" } })));
    expect(responses.every(response => response.statusCode === 201)).toBe(true);
    expect(await learning.getKnowledgeItem(ctx, "knowledge")).toMatchObject({ correctCount: 5, wrongCount: 0, correctStreak: 5, mastery: 0.5 });
    const after = await state(database);
    expect(after.attempts).toHaveLength(5);
    expect(after.outbox).toHaveLength(5);
    expect(after.reviews).toEqual([expect.objectContaining({ interval_days: 15 })]);
  });

  it("keeps answer progress committed between review preparation and its writer transaction", async () => {
    await learning.createReviewItem(ctx, { id: "review", knowledgeId: "knowledge", dueAt: "2025-01-01T00:00:00.000Z" });
    const complete = learning.completeReviewAndSchedule.bind(learning);
    learning.completeReviewAndSchedule = async (...args) => {
      const answer = await app.inject({ method: "POST", url: "/v1/questions/question/attempts", payload: { answer: "4" } });
      expect(answer.statusCode).toBe(201);
      return complete(...args);
    };
    const response = await app.inject({ method: "POST", url: "/v1/review-items/review/complete", payload: { isCorrect: true } });
    expect(response.statusCode).toBe(200);
    expect(await learning.getKnowledgeItem(ctx, "knowledge")).toMatchObject({ correctCount: 2, correctStreak: 2, mastery: 0.2 });
  });

  it("reports the persisted answer outcome rather than inferring a review from an incorrect answer", async () => {
    await learning.createQuestion(ctx, { id: "unlinked", prompt: "test", answerSpec: { answer: "correct" } });
    await learning.createPracticeSession(ctx, { id: "practice_report", questionCount: 1, questionIds: ["unlinked"] });
    const response = await app.inject({ method: "POST", url: "/v1/questions/unlinked/attempts", payload: { sessionId: "practice_report", answer: "wrong" } });
    expect(response.json().nextStep).toBe("await_review");
    const report = await app.inject({ method: "GET", url: "/v1/practice/sessions/practice_report/report" });
    expect(report.json().nextStep).toBe("await_review");
    expect((await database.client.execute("SELECT count(*) n FROM review_items")).rows[0]!.n).toBe(0);
  });

  it.each(["BEFORE UPDATE ON knowledge_items", "BEFORE INSERT ON review_items", "BEFORE INSERT ON outbox_events"])("rolls back review completion and scheduling when %s fails", async (clause) => {
    await learning.createReviewItem(ctx, { id: "review", knowledgeId: "knowledge", dueAt: "2025-01-01T00:00:00.000Z" });
    const before = await state(database);
    await database.client.execute(`CREATE TRIGGER fail_completion ${clause} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    expect((await app.inject({ method: "POST", url: "/v1/review-items/review/complete", payload: { isCorrect: true } })).statusCode).toBe(500);
    expect(await state(database)).toEqual(before);
  });

  it("counts a concurrent review once and validates replay against the durable completion receipt", async () => {
    await learning.createReviewItem(ctx, { id: "review-a", knowledgeId: "knowledge", dueAt: "2025-01-01T00:00:00.000Z" });
    const complete = (reviewId: string, timeZone = "UTC", isCorrect = true) => app.inject({ method: "POST", url: `/v1/review-items/${reviewId}/complete`, payload: { isCorrect, timeZone } });
    expect((await Promise.all([complete("review-a"), complete("review-a"), complete("review-a")])).every(response => response.statusCode === 200)).toBe(true);
    expect(await learning.getKnowledgeItem(ctx, "knowledge")).toMatchObject({ correctCount: 1, mastery: 0.1 });
    await app.inject({ method: "POST", url: "/v1/questions/question/attempts", payload: { answer: "4", timeZone: "Asia/Shanghai" } });
    expect((await complete("review-a")).statusCode).toBe(200);
    expect((await complete("review-a", "Asia/Shanghai")).statusCode).toBe(409);
    expect((await complete("review-a", "UTC", false)).statusCode).toBe(409);
  });

  it("keeps scheduled outcomes after the review changes, and refuses to invent outcomes for missing receipts", async () => {
    await learning.createPracticeSession(ctx, { id: "practice_receipt", questionCount: 1, questionIds: ["question"] });
    const answer = await app.inject({ method: "POST", url: "/v1/questions/question/attempts", payload: { sessionId: "practice_receipt", answer: "wrong" } });
    expect(answer.json().nextStep).toBe("review_scheduled");
    await database.client.execute("UPDATE review_items SET status='completed'");
    const report = () => app.inject({ method: "GET", url: "/v1/practice/sessions/practice_receipt/report" });
    expect((await report()).json().nextStep).toBe("review_scheduled");
    await database.client.execute("DELETE FROM outbox_events WHERE event_type='learning.answer.recorded'");
    expect((await report()).json().nextStep).toBe("await_review");
  });

  it("does not reconstruct historical or damaged review completion receipts", async () => {
    await learning.createReviewItem(ctx, { id: "review-legacy", knowledgeId: "knowledge", dueAt: "2025-01-01T00:00:00.000Z" });
    const complete = () => app.inject({ method: "POST", url: "/v1/review-items/review-legacy/complete", payload: { isCorrect: true } });
    expect((await complete()).statusCode).toBe(200);
    await database.client.execute("DELETE FROM outbox_events WHERE event_type='learning.review.completed'");
    const before = await state(database);
    const replay = await complete();
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toBe("review_completion_receipt_unavailable");
    expect(await state(database)).toEqual(before);
  });

  it("sums mixed committed outcomes conservatively and rejects mismatched answer receipts", async () => {
    await learning.createQuestion(ctx, { id: "unlinked", prompt: "test", answerSpec: { answer: "correct" } });
    await learning.createPracticeSession(ctx, { id: "practice_mixed", questionCount: 2, questionIds: ["question", "unlinked"] });
    const submitQuestion = (questionId: string) => app.inject({ method: "POST", url: `/v1/questions/${questionId}/attempts`, payload: { sessionId: "practice_mixed", answer: "wrong" } });
    expect((await submitQuestion("question")).json().nextStep).toBe("review_scheduled");
    expect((await submitQuestion("unlinked")).json().nextStep).toBe("await_review");
    const report = () => app.inject({ method: "GET", url: "/v1/practice/sessions/practice_mixed/report" });
    expect((await report()).json()).toMatchObject({ answeredCount: 2, nextStep: "await_review" });
    await database.client.execute("UPDATE outbox_events SET payload=json_set(payload,'$.sessionId','wrong-session') WHERE event_type='learning.answer.recorded'");
    expect((await report()).json()).toMatchObject({ answeredCount: 2, nextStep: "await_review" });
  });

  it("allows exactly one concurrent same-key differing request to commit", async () => {
    const responses = await Promise.all(["3", "4"].map(answer => app.inject({ method: "POST", url: "/v1/questions/question/attempts", headers, payload: { answer } })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const winner = responses.find(response => response.statusCode === 201)!.json();
    const after = await state(database);
    expect(after.attempts).toEqual([expect.objectContaining({ answer: winner.answer })]);
    expect(after.outbox).toHaveLength(1);
    expect(after.reviews).toHaveLength(1);
    expect(await learning.getKnowledgeItem(ctx, "knowledge")).toMatchObject({ correctCount: winner.judgement === "correct" ? 1 : 0, wrongCount: winner.judgement === "incorrect" ? 1 : 0 });
  });

  it.each([
    { answer: "4" }, { sessionId: "another-session" }, { timeZone: "UTC" }, { elapsedSeconds: 21 }, { hintsUsed: 2 }, { evidence: { observation: "changed" } },
  ])("rejects same-key changed effective input %j without additional writes", async (change) => {
    expect((await submit()).statusCode).toBe(201);
    const before = await state(database);
    const conflict = await app.inject({ method: "POST", url: "/v1/questions/question/attempts", headers, payload: { ...payload, ...change } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "idempotency_key_reused" });
    expect(await state(database)).toEqual(before);
  });

  it("canonicalizes defaults and evidence key order, retaining the original result after later changes", async () => {
    const first = await app.inject({ method: "POST", url: "/v1/questions/question/attempts", headers, payload: { answer: "3", evidence: { a: 1, b: 2 } } });
    expect(first.statusCode).toBe(201);
    await database.client.execute("UPDATE questions SET answer_spec = '{\"answer\":\"3\"}' WHERE id='question'");
    await database.client.execute("UPDATE review_items SET status='completed' WHERE knowledge_id='knowledge'");
    await database.client.execute("UPDATE outbox_events SET status='published'");
    const before = await state(database);
    const retry = await app.inject({ method: "POST", url: "/v1/questions/question/attempts", headers, payload: { answer: "3", timeZone: "UTC", hintsUsed: 0, sessionId: "ses_unknown", evidence: { b: 2, a: 1 } } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(await state(database)).toEqual(before);
  });

  it("fails closed for legacy facts or missing receipts instead of inventing a successful schedule", async () => {
    expect((await submit()).statusCode).toBe(201);
    await database.client.execute("DELETE FROM outbox_events WHERE event_type='learning.answer.recorded'");
    const before = await state(database);
    const response = await submit();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "answer_receipt_unavailable" });
    expect(await state(database)).toEqual(before);
  });

  it("does not claim a review for incorrect unlinked or unverifiable questions", async () => {
    await learning.createQuestion(ctx, { id: "unlinked", prompt: "standalone", answerSpec: { answer: "4" } });
    await learning.createQuestion(ctx, { id: "unverifiable", knowledgeId: "knowledge", prompt: "explain", answerSpec: {} });
    for (const questionId of ["unlinked", "unverifiable"]) {
      const response = await app.inject({ method: "POST", url: `/v1/questions/${questionId}/attempts`, headers, payload: { answer: "3" } });
      expect(response.statusCode).toBe(201);
      expect(response.json().nextStep).toBe("await_review");
    }
    expect(await learning.getKnowledgeItem(ctx, "knowledge")).toMatchObject({ correctCount: 0, wrongCount: 0 });
    expect((await state(database)).reviews).toHaveLength(0);
  });

  it("replays an accepted practice answer after completion, but prevents new facts in a completed or unrelated session", async () => {
    await learning.createPracticeSession(ctx, { id: "practice_one", questionCount: 1, questionIds: ["question"] });
    const request = { method: "POST" as const, url: "/v1/questions/question/attempts", headers, payload: { answer: "4", sessionId: "practice_one" } };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(201);
    await learning.completePracticeSession(ctx, "practice_one");
    expect((await app.inject(request)).json()).toEqual(first.json());
    expect((await app.inject({ ...request, headers: { "idempotency-key": "new-key" } })).statusCode).toBe(409);
    await learning.createPracticeSession(ctx, { id: "practice_other", questionCount: 1, questionIds: ["other"] });
    expect((await app.inject({ ...request, headers: { "idempotency-key": "another-key" }, payload: { answer: "4", sessionId: "practice_other" } })).statusCode).toBe(400);
    expect((await state(database)).attempts).toHaveLength(1);
  });

  it.each([
    ["knowledge", "BEFORE INSERT ON knowledge_items"], ["question", "BEFORE INSERT ON questions"],
    ["attempt", "BEFORE INSERT ON question_attempts"], ["mastery", "BEFORE UPDATE ON knowledge_items"],
    ["review", "BEFORE INSERT ON review_items"], ["Outbox", "BEFORE INSERT ON outbox_events"],
  ])("rolls back generated plugin answer at %s and retries through the same application command", async (_step, clause) => {
    const conversations = new SqliteConversationRepository(database.db);
    await conversations.createSession(ctx, "source", { id: "real-session" });
    await conversations.createTurnWithAttempt(ctx, { turnId: "source-turn", sessionId: "real-session", idempotencyKey: "source", message: { id: "message", content: "answer" }, attemptId: "source-attempt" });
    const services = createPluginHostServicesFactory(database.db)(ctx);
    const input = { idempotencyKey: "plugin-answer", turnId: "source-turn", prompt: "2 + 2", userAnswer: "3", correctAnswer: "4", judgement: "incorrect" as const, knowledgeConcept: "addition" };
    const before = await state(database);
    await database.client.execute(`CREATE TRIGGER fail_plugin ${clause} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await expect(services.learningFacts.recordJudgedAnswer(input)).rejects.toThrow();
    expect(await state(database)).toEqual(before);
    await database.client.execute("DROP TRIGGER fail_plugin");
    const receipt = await services.learningFacts.recordJudgedAnswer(input);
    expect(await services.learningFacts.recordJudgedAnswer(input)).toEqual(receipt);
    expect(await learning.listAttemptsBySession(ctx, "real-session")).toEqual([expect.objectContaining({ id: receipt.attemptId, questionId: receipt.questionId, evidence: expect.objectContaining({ turnId: "source-turn" }) })]);
    expect(await learning.listAttemptsBySession(ctx, "source-turn")).toEqual([]);
    const after = await state(database);
    expect(after.questions).toHaveLength(before.questions.length + 1);
    expect(after.knowledge).toHaveLength(before.knowledge.length + 1);
    expect(after.knowledge.find(row => row.id !== "knowledge")).toMatchObject({ wrong_count: 1, correct_count: 0 });
    expect(after.reviews).toHaveLength(1);
    expect(after.outbox.filter(row => row.event_type === "learning.answer.recorded")).toHaveLength(1);
    await expect(services.learningFacts.recordJudgedAnswer({ ...input, explanation: "changed" })).rejects.toThrow("idempotency_key_reused");
    expect(await state(database)).toEqual(after);
  });

  it("records partial plugin judgements without mastery or review and rejects stale plugin or forbidden source generations", async () => {
    const conversations = new SqliteConversationRepository(database.db);
    const extensions = new SqliteExtensionRepository(database.db);
    const plugin = await extensions.createPlugin({ id: "learning-test", publisher: "test", version: "1", checksum: "test" });
    await conversations.createSession(ctx, "source", { id: "source-session" });
    await conversations.createTurnWithAttempt(ctx, { turnId: "partial-turn", sessionId: "source-session", idempotencyKey: "partial", message: { id: "partial-message", content: "answer" }, attemptId: "partial-attempt" });
    const control = { checkActive: async () => {}, pluginGeneration: { pluginId: plugin.id, generation: plugin.lifecycleGeneration } };
    const services = createPluginHostServicesFactory(database.db)(ctx, control);
    const input = { idempotencyKey: "partial-answer", turnId: "partial-turn", prompt: "explain", userAnswer: "some", correctAnswer: "full", judgement: "partial" as const, knowledgeConcept: "addition" };
    expect((await services.learningFacts.recordJudgedAnswer(input)).enteredMistakeNotebook).toBe(false);
    expect((await state(database)).reviews).toHaveLength(0);
    expect((await state(database)).knowledge.every(row => row.correct_count === 0 && row.wrong_count === 0)).toBe(true);
    await extensions.setPluginEnabled(plugin.id, false);
    await extensions.setPluginEnabled(plugin.id, true);
    const before = await state(database);
    await expect(services.learningFacts.recordJudgedAnswer({ ...input, idempotencyKey: "stale" })).rejects.toThrow("plugin_generation_changed");
    expect(await state(database)).toEqual(before);
    await conversations.createSession(ctx, "group", { id: "group", executionPolicy: "bot-group-member-v1" });
    await conversations.createTurnWithAttempt(ctx, { turnId: "group-turn", sessionId: "group", idempotencyKey: "group", message: { id: "group-message", content: "answer" }, attemptId: "group-attempt" });
    const unrestricted = createPluginHostServicesFactory(database.db)(ctx);
    await expect(unrestricted.learningFacts.recordJudgedAnswer({ ...input, idempotencyKey: "group", turnId: "group-turn" })).rejects.toThrow("personal_derived_data_source_forbidden");
    expect((await state(database)).attempts).toHaveLength(1);
  });

  it("scopes host call identity by trusted owner, treating a self-declared source change as conflicting input", async () => {
    const conversations = new SqliteConversationRepository(database.db);
    await conversations.createSession(ctx, "source", { id: "source-session" });
    await conversations.createTurnWithAttempt(ctx, { turnId: "source-turn", sessionId: "source-session", idempotencyKey: "source", message: { id: "message", content: "answer" }, attemptId: "source-attempt" });
    const services = createPluginHostServicesFactory(database.db)(ctx);
    const input = { idempotencyKey: "host-answer", source: "self-declared-source", turnId: "source-turn", prompt: "2 + 2", userAnswer: "3", correctAnswer: "4", judgement: "incorrect" as const, knowledgeConcept: "addition" };
    await services.learningFacts.recordJudgedAnswer(input);
    const before = await state(database);
    await expect(services.learningFacts.recordJudgedAnswer({ ...input, source: "another-source" })).rejects.toThrow("idempotency_key_reused");
    expect(await state(database)).toEqual(before);
  });

  it("rejects new plugin facts when the source is missing or its session was deleted first", async () => {
    const conversations = new SqliteConversationRepository(database.db);
    const services = createPluginHostServicesFactory(database.db)(ctx);
    const input = { idempotencyKey: "deleted-source", turnId: "source-turn", prompt: "2 + 2", userAnswer: "3", correctAnswer: "4", judgement: "incorrect" as const, knowledgeConcept: "addition" };
    const before = await state(database);
    await expect(services.learningFacts.recordJudgedAnswer(input)).rejects.toThrow("personal_derived_data_source_unavailable");
    expect(await state(database)).toEqual(before);
    await conversations.createSession(ctx, "source", { id: "source-session" });
    await conversations.createTurnWithAttempt(ctx, { turnId: "source-turn", sessionId: "source-session", idempotencyKey: "source", message: { id: "message", content: "answer" }, attemptId: "source-attempt" });
    expect(await conversations.deleteSession(ctx, "source-session")).toBe(true);
    await expect(services.learningFacts.recordJudgedAnswer(input)).rejects.toThrow("personal_derived_data_source_unavailable");
    expect(await state(database)).toEqual(before);
  });

  it("retains committed immutable learning facts and receipts after source deletion without admitting further derived writes", async () => {
    const conversations = new SqliteConversationRepository(database.db);
    await conversations.createSession(ctx, "source", { id: "source-session" });
    await conversations.createTurnWithAttempt(ctx, { turnId: "source-turn", sessionId: "source-session", idempotencyKey: "source", message: { id: "message", content: "answer" }, attemptId: "source-attempt" });
    const services = createPluginHostServicesFactory(database.db)(ctx);
    const input = { idempotencyKey: "committed-source", turnId: "source-turn", prompt: "2 + 2", userAnswer: "3", correctAnswer: "4", judgement: "incorrect" as const, knowledgeConcept: "addition" };
    const receipt = await services.learningFacts.recordJudgedAnswer(input);
    const committed = await state(database);
    expect(await conversations.deleteSession(ctx, "source-session")).toBe(true);
    expect(await state(database)).toEqual(committed);
    expect(await learning.listAttemptsBySession(ctx, "source-session")).toEqual([expect.objectContaining({ id: receipt.attemptId })]);
    for (const idempotencyKey of [input.idempotencyKey, "new-after-deletion"]) {
      await expect(services.learningFacts.recordJudgedAnswer({ ...input, idempotencyKey })).rejects.toThrow("personal_derived_data_source_unavailable");
      expect(await state(database)).toEqual(committed);
    }
  });

  it("detects old host source-scoped identities and refuses to recreate incomplete historical work", async () => {
    const conversations = new SqliteConversationRepository(database.db);
    await conversations.createSession(ctx, "source", { id: "source-session" });
    await conversations.createTurnWithAttempt(ctx, { turnId: "source-turn", sessionId: "source-session", idempotencyKey: "source", message: { id: "message", content: "answer" }, attemptId: "source-attempt" });
    const legacyKey = "legacy-source:source-turn:legacy-key";
    const digest = createHash("sha256").update(legacyKey).digest("hex");
    await learning.createQuestion(ctx, { id: `q_judged_${digest}`, prompt: "2 + 2", answerSpec: { answer: "4" } });
    await database.client.execute({ sql: "INSERT INTO question_attempts(id,session_id,question_id,answer,judgement,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)", args: [`att_judged_${digest}`, "source-session", `q_judged_${digest}`, "3", "incorrect", legacyKey, new Date().toISOString()] });
    const before = await state(database);
    const services = createPluginHostServicesFactory(database.db)(ctx);
    await expect(services.learningFacts.recordJudgedAnswer({ idempotencyKey: "legacy-key", source: "legacy-source", turnId: "source-turn", prompt: "2 + 2", userAnswer: "3", correctAnswer: "4", judgement: "incorrect" })).rejects.toThrow("answer_receipt_unavailable");
    expect(await state(database)).toEqual(before);
  });
});
