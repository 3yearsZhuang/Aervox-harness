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

  // ============ CR-019 确定性练习反馈 ============

  it("CR-019：作答用时和提示数输入校验", async () => {
    for (const [prompt, answer] of [["q1", "a1"], ["q2", "a2"], ["q3", "a3"]]) {
      await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } });
    }
    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 3 } });
    expect(started.statusCode).toBe(201);
    const { items } = started.json() as { items: Array<{ id: string }> };
    const qid = items[0]!.id;
    const sid = started.json().sessionId;

    const negTime = await app.inject({
      method: "POST",
      url: `/v1/questions/${qid}/attempts`,
      headers,
      payload: { sessionId: sid, answer: "a1", elapsedSeconds: -1 },
    });
    expect(negTime.statusCode).toBe(400);
    expect(negTime.json().error).toContain("elapsedSeconds");

    const negHints = await app.inject({
      method: "POST",
      url: `/v1/questions/${qid}/attempts`,
      headers,
      payload: { sessionId: sid, answer: "a1", hintsUsed: -2 },
    });
    expect(negHints.statusCode).toBe(400);
    expect(negHints.json().error).toContain("hintsUsed");

    const floatTime = await app.inject({
      method: "POST",
      url: `/v1/questions/${qid}/attempts`,
      headers,
      payload: { sessionId: sid, answer: "a1", elapsedSeconds: 1.5 },
    });
    expect(floatTime.statusCode).toBe(400);
  });

  it("CR-019：低正确率会话报告建议降低难度", async () => {
    for (const [prompt, answer] of [["q1", "a1"], ["q2", "a2"], ["q3", "a3"]]) {
      await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } });
    }
    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 3 } });
    const { sessionId, items } = started.json() as { sessionId: string; items: Array<{ id: string }> };

    await app.inject({ method: "POST", url: `/v1/questions/${items[0]!.id}/attempts`, headers, payload: { sessionId, answer: "wrong" } });
    await app.inject({ method: "POST", url: `/v1/questions/${items[1]!.id}/attempts`, headers, payload: { sessionId, answer: "wrong" } });
    await app.inject({ method: "POST", url: `/v1/questions/${items[2]!.id}/attempts`, headers, payload: { sessionId, answer: items[2] ? "a3" : "" } });

    const report = await app.inject({ method: "POST", url: `/v1/practice/sessions/${sessionId}/complete`, headers });
    expect(report.statusCode).toBe(200);
    expect(report.json().guidance).toMatchObject({
      difficulty: "ease",
      reasonCode: "low_accuracy",
    });
    expect(typeof report.json().guidance.message).toBe("string");
    expect(report.json().avgTimeSpentSec).toBeNull();
    expect(report.json().totalHintsUsed).toBe(0);
  });

  it("CR-019：高正确率、快速、无提示会话建议提高难度", async () => {
    for (const [prompt, answer] of [["q1", "a1"], ["q2", "a2"], ["q3", "a3"], ["q4", "a4"], ["q5", "a5"]]) {
      await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } });
    }
    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 5 } });
    const { sessionId, items } = started.json() as { sessionId: string; items: Array<{ id: string; answer?: string }> };

    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: `/v1/questions/${items[i]!.id}/attempts`,
        headers,
        payload: { sessionId, answer: `a${i + 1}`, elapsedSeconds: 45, hintsUsed: 0 },
      });
    }

    const report = await app.inject({ method: "GET", url: `/v1/practice/sessions/${sessionId}/report`, headers });
    expect(report.statusCode).toBe(200);
    expect(report.json().guidance).toMatchObject({
      difficulty: "increase",
      reasonCode: "high_accuracy_fast_no_hints",
    });
    expect(report.json().avgTimeSpentSec).toBe(45);
    expect(report.json().totalHintsUsed).toBe(0);
  });

  it("CR-019：稳定表现保持当前难度", async () => {
    for (const [prompt, answer] of [["q1", "a1"], ["q2", "a2"], ["q3", "a3"], ["q4", "a4"]]) {
      await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } });
    }
    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 4 } });
    const { sessionId, items } = started.json() as { sessionId: string; items: Array<{ id: string }> };

    await app.inject({ method: "POST", url: `/v1/questions/${items[0]!.id}/attempts`, headers, payload: { sessionId, answer: "a1", elapsedSeconds: 30 } });
    await app.inject({ method: "POST", url: `/v1/questions/${items[1]!.id}/attempts`, headers, payload: { sessionId, answer: "a2", elapsedSeconds: 30 } });
    await app.inject({ method: "POST", url: `/v1/questions/${items[2]!.id}/attempts`, headers, payload: { sessionId, answer: "a3", elapsedSeconds: 30 } });
    await app.inject({ method: "POST", url: `/v1/questions/${items[3]!.id}/attempts`, headers, payload: { sessionId, answer: "wrong", elapsedSeconds: 30, hintsUsed: 1 } });

    const report = await app.inject({ method: "GET", url: `/v1/practice/sessions/${sessionId}/report`, headers });
    expect(report.statusCode).toBe(200);
    expect(report.json().guidance).toMatchObject({
      difficulty: "maintain",
      reasonCode: "steady_progress",
    });
    expect(report.json().totalHintsUsed).toBe(1);
  });

  it("CR-019：无可用用时数据时不触发提高难度建议", async () => {
    for (const [prompt, answer] of [["q1", "a1"], ["q2", "a2"], ["q3", "a3"]]) {
      await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } });
    }
    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 3 } });
    const { sessionId, items } = started.json() as { sessionId: string; items: Array<{ id: string }> };

    await app.inject({ method: "POST", url: `/v1/questions/${items[0]!.id}/attempts`, headers, payload: { sessionId, answer: "a1", hintsUsed: 0 } });
    await app.inject({ method: "POST", url: `/v1/questions/${items[1]!.id}/attempts`, headers, payload: { sessionId, answer: "a2", hintsUsed: 0 } });
    await app.inject({ method: "POST", url: `/v1/questions/${items[2]!.id}/attempts`, headers, payload: { sessionId, answer: "a3", hintsUsed: 0 } });

    const report = await app.inject({ method: "POST", url: `/v1/practice/sessions/${sessionId}/complete`, headers });
    expect(report.json().guidance.difficulty).toBe("maintain");
    expect(report.json().avgTimeSpentSec).toBeNull();
  });

  it("CR-019：幂等重试保留首次用时和提示数，不重复统计", async () => {
    for (const [prompt, answer] of [["q1", "a1"], ["q2", "a2"], ["q3", "a3"]]) {
      await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } });
    }
    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 3 } });
    const { sessionId, items } = started.json() as { sessionId: string; items: Array<{ id: string }> };
    const qid = items[0]!.id;

    const idemHeaders = { ...headers, "idempotency-key": "guidance_idem_1" };
    const first = await app.inject({
      method: "POST",
      url: `/v1/questions/${qid}/attempts`,
      headers: idemHeaders,
      payload: { sessionId, answer: "a1", elapsedSeconds: 25, hintsUsed: 1 },
    });
    expect(first.statusCode).toBe(201);

    const retry = await app.inject({
      method: "POST",
      url: `/v1/questions/${qid}/attempts`,
      headers: idemHeaders,
      payload: { sessionId, answer: "a1", elapsedSeconds: 999, hintsUsed: 999 },
    });
    expect(retry.statusCode).toBe(200);

    const report = await app.inject({ method: "GET", url: `/v1/practice/sessions/${sessionId}/report`, headers });
    expect(report.json().answeredCount).toBe(1);
    expect(report.json().avgTimeSpentSec).toBe(25);
    expect(report.json().totalHintsUsed).toBe(1);
  });

  it("CR-019：同一会话重复结束返回相同报告和 guidance", async () => {
    for (const [prompt, answer] of [["q1", "a1"], ["q2", "a2"], ["q3", "a3"]]) {
      await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } });
    }
    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 3 } });
    const { sessionId, items } = started.json() as { sessionId: string; items: Array<{ id: string }> };

    await app.inject({ method: "POST", url: `/v1/questions/${items[0]!.id}/attempts`, headers, payload: { sessionId, answer: "a1", elapsedSeconds: 40, hintsUsed: 0 } });
    await app.inject({ method: "POST", url: `/v1/questions/${items[1]!.id}/attempts`, headers, payload: { sessionId, answer: "a2", elapsedSeconds: 50, hintsUsed: 0 } });

    const first = await app.inject({ method: "POST", url: `/v1/practice/sessions/${sessionId}/complete`, headers });
    const second = await app.inject({ method: "POST", url: `/v1/practice/sessions/${sessionId}/complete`, headers });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().guidance).toEqual(first.json().guidance);
    expect(second.json().avgTimeSpentSec).toBe(first.json().avgTimeSpentSec);
    expect(second.json().totalHintsUsed).toBe(first.json().totalHintsUsed);
  });

  it("CR-019：租户隔离：其他租户无法读取会话报告与 guidance", async () => {
    for (const [prompt, answer] of [["q1", "a1"], ["q2", "a2"], ["q3", "a3"]]) {
      await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } });
    }
    const started = await app.inject({ method: "POST", url: "/v1/practice/sessions", headers, payload: { count: 3 } });
    const { sessionId } = started.json() as { sessionId: string };

    const otherTenant = await app.inject({
      method: "GET",
      url: `/v1/practice/sessions/${sessionId}/report`,
      headers: { "x-workspace-id": "ws_other", "x-user-id": "usr_other" },
    });
    expect(otherTenant.statusCode).toBe(404);
  });
});
