import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteLearningRepository,
  type AervoxDatabase,
} from "@aervox/database";
import type { Client } from "@libsql/client";
import { registerLearningRoutes } from "../src/modules/learning/routes.js";

const headers = { "x-workspace-id": "ws_practice", "x-user-id": "usr_practice" } as const;

describe("练习会话报告", () => {
  let app: ReturnType<typeof Fastify>;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const memory = await createInMemoryDatabase();
    db = memory.db;
    client = memory.client;
    cleanup = memory.cleanup;
    await initDatabaseSchema(client);
    app = Fastify();
    registerLearningRoutes(app, new SqliteLearningRepository(db));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("按会话汇总已答、未答、正确率和后续动作，并隔离其他租户", async () => {
    for (const [prompt, answer] of [["1 + 1 = ?", "2"], ["2 + 2 = ?", "4"], ["3 + 3 = ?", "6"]]) {
      expect(
        (await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } })).statusCode,
      ).toBe(201);
    }

    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 3 } });
    expect(started.statusCode).toBe(201);
    const { sessionId, items } = started.json() as { sessionId: string; items: Array<{ id: string }> };

    await app.inject({ method: "POST", url: `/v1/questions/${items[0]?.id}/attempts`, headers, payload: { sessionId, answer: "2" } });
    await app.inject({ method: "POST", url: `/v1/questions/${items[1]?.id}/attempts`, headers, payload: { sessionId, answer: "wrong" } });

    const report = await app.inject({ method: "POST", url: `/v1/practice/sessions/${sessionId}/complete`, headers });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({
      sessionId,
      questionCount: 3,
      answeredCount: 2,
      remainingCount: 1,
      correctCount: 1,
      incorrectCount: 1,
      accuracy: 0.5,
      nextStep: "review_scheduled",
    });

    const retriedCompletion = await app.inject({ method: "POST", url: `/v1/practice/sessions/${sessionId}/complete`, headers });
    expect(retriedCompletion.statusCode).toBe(200);
    expect(retriedCompletion.json()).toMatchObject({ answeredCount: 2, remainingCount: 1 });

    const afterCompletion = await app.inject({
      method: "POST",
      url: `/v1/questions/${items[2]?.id}/attempts`,
      headers,
      payload: { sessionId, answer: "6" },
    });
    expect(afterCompletion.statusCode).toBe(409);

    const otherTenant = await app.inject({
      method: "GET",
      url: `/v1/practice/sessions/${sessionId}/report`,
      headers: { "x-workspace-id": "ws_other", "x-user-id": "usr_other" },
    });
    expect(otherTenant.statusCode).toBe(404);
  });

  it("题目不足时不创建不完整的练习会话", async () => {
    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 3 } });
    expect(started.statusCode).toBe(409);
  });

  it("恢复活跃会话的固定题组快照与未答进度，不重复创建会话", async () => {
    for (const [prompt, answer] of [["1 + 1 = ?", "2"], ["2 + 2 = ?", "4"], ["3 + 3 = ?", "6"]]) {
      expect(
        (await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } })).statusCode,
      ).toBe(201);
    }

    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 3 } });
    expect(started.statusCode).toBe(201);
    const { sessionId, items } = started.json() as { sessionId: string; items: Array<{ id: string }> };
    expect(
      (await app.inject({ method: "POST", url: `/v1/questions/${items[0]?.id}/attempts`, headers, payload: { sessionId, answer: "2" } })).statusCode,
    ).toBe(201);

    const recovered = await app.inject({ method: "GET", url: "/v1/practice/sessions/active", headers });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ sessionId, answeredQuestionIds: [items[0]?.id], nextQuestionIndex: 1 });
    expect(recovered.json().items.map((item: { id: string }) => item.id)).toEqual(items.map((item) => item.id));

    const retriedStart = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 5 } });
    expect(retriedStart.statusCode).toBe(200);
    expect(retriedStart.json()).toMatchObject({ sessionId, nextQuestionIndex: 1 });

    const otherTenant = await app.inject({
      method: "GET",
      url: "/v1/practice/sessions/active",
      headers: { "x-workspace-id": "ws_other", "x-user-id": "usr_other" },
    });
    expect(otherTenant.statusCode).toBe(404);

    expect((await app.inject({ method: "POST", url: `/v1/practice/sessions/${sessionId}/complete`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/practice/sessions/active", headers })).statusCode).toBe(404);
  });

  it("网络失败后使用幂等键安全重试，已提交题目不重复计入统计", async () => {
    for (const [prompt, answer] of [["1 + 1 = ?", "2"], ["2 + 2 = ?", "4"], ["3 + 3 = ?", "6"]]) {
      expect(
        (await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } })).statusCode,
      ).toBe(201);
    }

    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 3 } });
    const { sessionId, items } = started.json() as { sessionId: string; items: Array<{ id: string }> };
    const firstQuestionId = items[0]!.id;

    const idempotencyHeaders = { ...headers, "idempotency-key": "practice_retry_1" };
    const payload = { sessionId, answer: "2" };

    const first = await app.inject({ method: "POST", url: `/v1/questions/${firstQuestionId}/attempts`, headers: idempotencyHeaders, payload });
    expect(first.statusCode).toBe(201);

    const retry = await app.inject({ method: "POST", url: `/v1/questions/${firstQuestionId}/attempts`, headers: idempotencyHeaders, payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().judgement).toBe(first.json().judgement);

    const attempts = await app.inject({ method: "GET", url: `/v1/questions/${firstQuestionId}/attempts`, headers });
    expect(attempts.json().items).toHaveLength(1);

    const report = await app.inject({ method: "GET", url: `/v1/practice/sessions/${sessionId}/report`, headers });
    expect(report.json().answeredCount).toBe(1);
    expect(report.json().correctCount).toBe(1);
  });

  it("不同答案使用相同幂等键仍返回首次结果，不创建第二条作答", async () => {
    for (const [prompt, answer] of [["5 + 5 = ?", "10"], ["6 + 6 = ?", "12"], ["7 + 7 = ?", "14"]]) {
      await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } });
    }

    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 3 } });
    const { sessionId, items } = started.json() as { sessionId: string; items: Array<{ id: string }> };
    const questionId = items[0]!.id;

    const idempotencyHeaders = { ...headers, "idempotency-key": "practice_conflict_1" };
    await app.inject({ method: "POST", url: `/v1/questions/${questionId}/attempts`, headers: idempotencyHeaders, payload: { sessionId, answer: "10" } });

    const conflictRetry = await app.inject({ method: "POST", url: `/v1/questions/${questionId}/attempts`, headers: idempotencyHeaders, payload: { sessionId, answer: "wrong" } });
    expect(conflictRetry.statusCode).toBe(200);
    expect(conflictRetry.json().answer).toBe("10");

    const attempts = await app.inject({ method: "GET", url: `/v1/questions/${questionId}/attempts`, headers });
    expect(attempts.json().items).toHaveLength(1);
    expect(attempts.json().items[0].answer).toBe("10");
  });

  it("不存在的会话恢复返回 404", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/practice/sessions/active", headers: { "x-workspace-id": "ws_other", "x-user-id": "usr_other" } });
    expect(res.statusCode).toBe(404);
  });

  it("不存在的会话报告返回 404", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/practice/sessions/ses_nonexistent/report", headers });
    expect(res.statusCode).toBe(404);
  });
});
