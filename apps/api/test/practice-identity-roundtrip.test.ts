import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, createInMemoryDatabase, SqliteLearningRepository } from "@aervox/repositories";
import { registerLearningRoutes } from "@aervox/host-runtime-test/modules/learning/learning/routes";

const ctx = { workspaceId: "local", subjectUserId: "local" };
const questionIds = ["question\0一", "question\0二"], sessionId = "practice_http\0完整";

describe("complete practice identities through HTTP persistence and recovery", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let learning: SqliteLearningRepository;
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    learning = new SqliteLearningRepository(database.db);
    for (const [index, id] of questionIds.entries()) {
      await learning.createQuestion(ctx, { id, prompt: `题干\0${index}`, answerSpec: { answer: "4\0完整" } });
    }
    await learning.createPracticeSession(ctx, { id: sessionId, questionCount: 2, questionIds });
    app = Fastify();
    registerLearningRoutes(app, learning);
    await app.ready();
  });
  afterEach(async () => { await app.close(); await database.cleanup(); });

  it("returns full questions and answer receipts, resumes the next actual question, and replays after completion", async () => {
    const before = await app.inject({ method: "GET", url: "/v1/practice/sessions/active" });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ sessionId, answeredQuestionIds: [], nextQuestionIndex: 0 });
    expect(before.json().items.map((item: { id: string; prompt: string }) => [item.id, item.prompt]))
      .toEqual(questionIds.map((id, index) => [id, `题干\0${index}`]));
    const request = { method: "POST" as const, url: `/v1/questions/${encodeURIComponent(questionIds[0]!)}/attempts`,
      headers: { "idempotency-key": "http-original-key" }, payload: { sessionId, answer: "4\0完整", evidence: { observation: "提交\0完整" }, hintsUsed: 1, elapsedSeconds: 9 } };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ sessionId, questionId: questionIds[0], answer: request.payload.answer, evidence: request.payload.evidence, nextStep: "continue", hintCount: 1, timeSpentSec: 9 });
    const retry = await app.inject(request);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    const file = String((await database.client.execute("PRAGMA database_list")).rows.find(row => row.name === "main")!.file);
    await app.close();
    const previous = database;
    previous.client.close();
    const reopened = await createDatabase({ url: file });
    database = { db: reopened.db, client: reopened.client, cleanup: async () => { reopened.client.close(); await previous.cleanup(); } };
    learning = new SqliteLearningRepository(database.db);
    app = Fastify();
    registerLearningRoutes(app, learning);
    await app.ready();
    const recovered = await app.inject({ method: "GET", url: "/v1/practice/sessions/active" });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ sessionId, answeredQuestionIds: [questionIds[0]], nextQuestionIndex: 1 });
    expect(recovered.json().items.map((item: { id: string }) => item.id)).toEqual(questionIds);
    const attempts = await app.inject({ method: "GET", url: `/v1/questions/${encodeURIComponent(questionIds[0]!)}/attempts` });
    const { nextStep: _nextStep, ...fact } = first.json();
    expect(attempts.json().items).toEqual([fact]);
    const reportUrl = `/v1/practice/sessions/${encodeURIComponent(sessionId)}`;
    const report = await app.inject({ method: "GET", url: `${reportUrl}/report` });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ sessionId, answeredCount: 1, remainingCount: 1, correctCount: 1, nextStep: "continue" });
    const completed = await app.inject({ method: "POST", url: `${reportUrl}/complete` });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual(report.json());
    const endedAt = (await learning.getPracticeSession(ctx, sessionId))?.endedAt;
    expect((await app.inject({ method: "POST", url: `${reportUrl}/complete` })).json()).toEqual(completed.json());
    expect((await learning.getPracticeSession(ctx, sessionId))?.endedAt).toBe(endedAt);
    const afterCompletion = await app.inject(request);
    expect(afterCompletion.statusCode).toBe(200);
    expect(afterCompletion.json()).toEqual(first.json());
    expect((await app.inject({ ...request, headers: { "idempotency-key": "http-new-key" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/v1/practice/sessions/active" })).statusCode).toBe(404);
    expect((await database.client.execute("SELECT count(*) n FROM question_attempts")).rows[0]!.n).toBe(1);
    expect((await database.client.execute("SELECT count(*) n FROM outbox_events WHERE event_type='learning.answer.recorded'")).rows[0]!.n).toBe(1);
  });

  it("keeps same-prefix mistakes separate and refuses a damaged receipt on replay", async () => {
    for (const [index, questionId] of questionIds.entries()) {
      const response = await app.inject({ method: "POST", url: `/v1/questions/${encodeURIComponent(questionId)}/attempts`,
        headers: { "idempotency-key": "same-key-for-different-questions" }, payload: { sessionId, answer: `wrong\0${index}` } });
      expect(response.statusCode).toBe(201);
    }
    const mistakes = await app.inject({ method: "GET", url: "/v1/mistakes" });
    expect(mistakes.statusCode).toBe(200);
    expect(mistakes.json().items).toHaveLength(2);
    for (const [index, questionId] of questionIds.entries()) {
      expect(mistakes.json().items.find((item: { questionId: string }) => item.questionId === questionId))
        .toMatchObject({ prompt: `题干\0${index}`, latestAnswer: `wrong\0${index}`, wrongCount: 1 });
    }
    await database.client.execute("UPDATE outbox_events SET payload=json_set(payload,'$.questionId','question') WHERE event_type='learning.answer.recorded'");
    const replay = await app.inject({ method: "POST", url: `/v1/questions/${encodeURIComponent(questionIds[0]!)}/attempts`,
      headers: { "idempotency-key": "same-key-for-different-questions" }, payload: { sessionId, answer: "wrong\0" + "0" } });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: "answer_receipt_unavailable" });
    expect((await database.client.execute("SELECT count(*) n FROM question_attempts")).rows[0]!.n).toBe(2);
  });
});
