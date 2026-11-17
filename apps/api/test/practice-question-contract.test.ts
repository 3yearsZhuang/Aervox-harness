import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteLearningRepository } from "@aervox/repositories";
import {
  createPracticeSessionResponseSchema, practiceQuestionSchema, practiceSessionResumeResponseSchema,
} from "@aervox/contracts";
import { registerLearningRoutes } from "@aervox/host-runtime-test/modules/learning/learning/routes";

describe("local practice question response contract", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    app = Fastify();
    registerLearningRoutes(app, new SqliteLearningRepository(database.db));
    await app.ready();
  });
  afterEach(async () => { await app.close(); await database.cleanup(); });

  const createQuestions = async () => {
    const questions = [];
    for (const [prompt, answer] of [["1 + 1 = ?", "2"], ["2 + 2 = ?", "4"], ["3 + 3 = ?", "6"]]) {
      const response = await app.inject({ method: "POST", url: "/v1/questions", payload: { prompt, answerSpec: { answer } } });
      expect(response.statusCode).toBe(201);
      questions.push(response.json());
    }
    return questions;
  };

  it("parses actual created, stored and listed questions without inventing owner fields", async () => {
    const questions = await createQuestions();
    for (const question of questions) {
      expect(question).not.toHaveProperty("workspaceId");
      expect(question).not.toHaveProperty("subjectUserId");
      expect(practiceQuestionSchema.parse(question)).toEqual(question);
      const response = await app.inject({ method: "GET", url: `/v1/questions/${encodeURIComponent(question.id)}` });
      expect(response.statusCode).toBe(200);
      expect(practiceQuestionSchema.parse(response.json())).toEqual(question);
    }
    const practice = await app.inject({ method: "GET", url: "/v1/practice/questions?count=3" });
    expect(practice.statusCode).toBe(200);
    expect(practice.json().items.map((question: unknown) => practiceQuestionSchema.parse(question))).toEqual(questions);
    const { prompt: _prompt, ...missingPrompt } = questions[0];
    expect(practiceQuestionSchema.safeParse(missingPrompt).success).toBe(false);
  });

  it("parses nested real create, active resume and mistake practice responses with the same local question shape", async () => {
    const questions = await createQuestions();
    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", payload: { count: 3 } });
    expect(started.statusCode).toBe(201);
    const session = practiceSessionResumeResponseSchema.parse(started.json());
    expect(session.items).toEqual(questions);
    expect(createPracticeSessionResponseSchema.parse(started.json())).toEqual({ sessionId: session.sessionId, items: questions });
    const answer = await app.inject({ method: "POST", url: `/v1/questions/${encodeURIComponent(questions[0].id)}/attempts`,
      payload: { sessionId: session.sessionId, answer: "wrong" }, headers: { "idempotency-key": "contract-answer" } });
    expect(answer.statusCode).toBe(201);
    const active = await app.inject({ method: "GET", url: "/v1/practice/sessions/active" });
    expect(active.statusCode).toBe(200);
    const resumed = practiceSessionResumeResponseSchema.parse(active.json());
    expect(resumed).toMatchObject({ sessionId: session.sessionId, items: questions, answeredQuestionIds: [questions[0].id], nextQuestionIndex: 1 });
    const retriedStart = await app.inject({ method: "POST", url: "/v1/practice/sessions", payload: { count: 5 } });
    expect(retriedStart.statusCode).toBe(200);
    expect(practiceSessionResumeResponseSchema.parse(retriedStart.json())).toEqual(resumed);
    expect((await app.inject({ method: "POST", url: `/v1/practice/sessions/${encodeURIComponent(session.sessionId)}/complete` })).statusCode).toBe(200);
    const repracticed = await app.inject({ method: "POST", url: "/v1/mistakes/repractice", payload: { questionIds: [questions[0].id] } });
    expect(repracticed.statusCode).toBe(201);
    expect(createPracticeSessionResponseSchema.parse(repracticed.json())).toEqual({ sessionId: repracticed.json().sessionId, items: [questions[0]] });
  });
});
