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

  it("忽略错题不删除作答历史，恢复后可再次重练", async () => {
    const question = await app.inject({
      method: "POST",
      url: "/v1/questions",
      headers,
      payload: { prompt: "1 + 1 = ?", answerSpec: { answer: "2" } },
    });
    const questionId = question.json().id as string;
    await app.inject({
      method: "POST",
      url: `/v1/questions/${questionId}/attempts`,
      headers,
      payload: { sessionId: "ses_dismiss", answer: "3" },
    });

    expect((await app.inject({ method: "PATCH", url: `/v1/mistakes/${questionId}`, headers, payload: { status: "dismissed" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/mistakes", headers })).json().items).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/v1/mistakes?status=dismissed", headers })).json().items).toEqual([expect.objectContaining({ questionId, status: "dismissed" })]);
    expect((await app.inject({ method: "GET", url: `/v1/questions/${questionId}/attempts`, headers })).json().items).toHaveLength(1);

    expect((await app.inject({ method: "PATCH", url: `/v1/mistakes/${questionId}`, headers, payload: { status: "active" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/mistakes/repractice", headers, payload: { questionIds: [questionId] } })).statusCode).toBe(201);
  });

it("保存错因说明并支持错因筛选，不改变作答历史或租户边界", async () => {
    const question = await app.inject({
      method: "POST",
      url: "/v1/questions",
      headers,
      payload: { prompt: "循环条件是什么？", answerSpec: { answer: "i < n" } },
    });
    const questionId = question.json().id as string;
    await app.inject({
      method: "POST",
      url: `/v1/questions/${questionId}/attempts`,
      headers,
      payload: { sessionId: "ses_insight", answer: "i <= n" },
    });

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/mistakes/${questionId}`,
      headers,
      payload: { reasonCode: "careless", note: "  少考虑一次边界  " },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ questionId, reasonCode: "careless", note: "少考虑一次边界", status: "active" });

    const filtered = await app.inject({ method: "GET", url: "/v1/mistakes?reasonCode=careless", headers });
    expect(filtered.json().items).toEqual([expect.objectContaining({ questionId, reasonCode: "careless" })]);
    expect((await app.inject({ method: "GET", url: `/v1/questions/${questionId}/attempts`, headers })).json().items).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/v1/mistakes?reasonCode=careless", headers: { "x-workspace-id": "ws_other", "x-user-id": "usr_other" } })).json().items).toEqual([]);

    const cleared = await app.inject({
      method: "PATCH",
      url: `/v1/mistakes/${questionId}`,
      headers,
      payload: { reasonCode: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ questionId, reasonCode: null, note: null });
  });

  it("按知识点筛选错题列表", async () => {
    const ki1 = await repo.createKnowledgeItem(tenant, { id: "know_a", concept: "知识点A" });
    const ki2 = await repo.createKnowledgeItem(tenant, { id: "know_b", concept: "知识点B" });

    for (const [prompt, answer, knowledgeId] of [
      ["题A1", "a1", ki1.id],
      ["题B1", "b1", ki2.id],
    ] as const) {
      const q = await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer }, knowledgeId } });
      await app.inject({ method: "POST", url: `/v1/questions/${q.json().id}/attempts`, headers, payload: { sessionId: "ses_filter", answer: "wrong" } });
    }

    const filtered = await app.inject({ method: "GET", url: `/v1/mistakes?knowledgeId=${ki1.id}`, headers });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items).toHaveLength(1);
    expect(filtered.json().items[0].knowledgeId).toBe(ki1.id);
  });

  it("按最小错误次数筛选错题列表", async () => {
    for (const [prompt, answer] of [["题1", "1"], ["题2", "2"]] as const) {
      const q = await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt, answerSpec: { answer } } });
      await app.inject({ method: "POST", url: `/v1/questions/${q.json().id}/attempts`, headers, payload: { sessionId: "ses_min", answer: "wrong" } });
    }
    const q1 = (await app.inject({ method: "GET", url: "/v1/mistakes", headers })).json().items[0];
    await app.inject({ method: "POST", url: `/v1/questions/${q1.questionId}/attempts`, headers, payload: { sessionId: "ses_min2", answer: "wrong2" } });

    const allMistakes = await app.inject({ method: "GET", url: "/v1/mistakes", headers });
    expect(allMistakes.json().items).toHaveLength(2);

    const filtered = await app.inject({ method: "GET", url: "/v1/mistakes?minWrongCount=2", headers });
    expect(filtered.json().items).toHaveLength(1);
    expect(filtered.json().items[0].wrongCount).toBe(2);
  });

  it("按错误次数排序错题列表（frequent）", async () => {
    const q1 = await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt: "少错", answerSpec: { answer: "a" } } });
    const q2 = await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt: "多错", answerSpec: { answer: "b" } } });
    await app.inject({ method: "POST", url: `/v1/questions/${q1.json().id}/attempts`, headers, payload: { sessionId: "ses_sort", answer: "x" } });
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "POST", url: `/v1/questions/${q2.json().id}/attempts`, headers, payload: { sessionId: `ses_sort_${i}`, answer: `x${i}` } });
    }

    const sorted = await app.inject({ method: "GET", url: "/v1/mistakes?sortBy=frequent", headers });
    expect(sorted.json().items[0].wrongCount).toBe(3);
    expect(sorted.json().items[1].wrongCount).toBe(1);
  });

  it("默认排序为 recent（按最近作答时间降序）", async () => {
    const q1 = await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt: "较早错题", answerSpec: { answer: "a" } } });
    const q2 = await app.inject({ method: "POST", url: "/v1/questions", headers, payload: { prompt: "较晚错题", answerSpec: { answer: "b" } } });
    await app.inject({ method: "POST", url: `/v1/questions/${q1.json().id}/attempts`, headers, payload: { sessionId: "ses_recent_1", answer: "x" } });
    await new Promise((r) => setTimeout(r, 10));
    await app.inject({ method: "POST", url: `/v1/questions/${q2.json().id}/attempts`, headers, payload: { sessionId: "ses_recent_2", answer: "y" } });

    const items = (await app.inject({ method: "GET", url: "/v1/mistakes", headers })).json().items;
    expect(items).toHaveLength(2);
    expect(items[0].questionId).toBe(q2.json().id);
    expect(items[1].questionId).toBe(q1.json().id);
  });

  it("没有错题时返回空列表", async () => {
    const empty = await app.inject({ method: "GET", url: "/v1/mistakes", headers });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().items).toEqual([]);
  });

  it("忽略不存在的错题返回 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/mistakes/q_nonexistent",
      headers,
      payload: { status: "dismissed" },
    });
    expect(res.statusCode).toBe(404);
  });
});
