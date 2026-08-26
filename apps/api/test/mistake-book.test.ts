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

const headers = { "x-workspace-id": "ws_mistakes", "x-user-id": "usr_mistakes" } as const;
const tenant = { workspaceId: "ws_mistakes", subjectUserId: "usr_mistakes" } as const;

describe("错题本与重练", () => {
  let app: ReturnType<typeof Fastify>;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let repo: SqliteLearningRepository;

  beforeEach(async () => {
    const memory = await createInMemoryDatabase();
    db = memory.db;
    client = memory.client;
    cleanup = memory.cleanup;
    await initDatabaseSchema(client);
    repo = new SqliteLearningRepository(db);
    app = Fastify();
    registerLearningRoutes(app, repo);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("聚合错误作答、保留历史并支持掌握状态与重练", async () => {
    const knowledge = await repo.createKnowledgeItem(tenant, {
      id: "know_binary_search",
      concept: "二分查找边界",
      sourceStatus: "verified",
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/questions",
      headers,
      payload: { prompt: "二分查找的时间复杂度？", answerSpec: { answer: "O(log n)" }, knowledgeId: knowledge.id },
    });
    const questionId = created.json().id as string;

    for (const answer of ["O(n)", "O(1)"]) {
      expect((await app.inject({
        method: "POST",
        url: `/v1/questions/${questionId}/attempts`,
        headers,
        payload: { sessionId: "ses_learning", answer },
      })).statusCode).toBe(201);
    }

    const listed = await app.inject({ method: "GET", url: "/v1/mistakes", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([
      expect.objectContaining({ questionId, wrongCount: 2, latestAnswer: "O(1)", status: "active" }),
    ]);

    const started = await app.inject({
      method: "POST",
      url: "/v1/mistakes/repractice",
      headers,
      payload: { questionIds: [questionId] },
    });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ items: [{ id: questionId }] });

    const mastered = await app.inject({
      method: "PATCH",
      url: `/v1/mistakes/${questionId}`,
      headers,
      payload: { status: "mastered" },
    });
    expect(mastered.statusCode).toBe(200);
    expect(mastered.json().status).toBe("mastered");

    expect((await app.inject({ method: "GET", url: "/v1/mistakes", headers })).json().items).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/v1/mistakes?status=mastered", headers })).json().items)
      .toEqual([expect.objectContaining({ questionId, wrongCount: 2, status: "mastered" })]);
    expect((await app.inject({ method: "GET", url: `/v1/questions/${questionId}/attempts`, headers })).json().items)
      .toHaveLength(2);
  });

  it("隔离其他租户并拒绝无效重练范围", async () => {
    const otherList = await app.inject({
      method: "GET",
      url: "/v1/mistakes?status=all",
      headers: { "x-workspace-id": "ws_other", "x-user-id": "usr_other" },
    });
    expect(otherList.json().items).toEqual([]);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/mistakes/repractice",
      headers,
      payload: { questionIds: ["q_not_a_mistake"] },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
