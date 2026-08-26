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
});
