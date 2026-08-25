import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  SqliteLearningRepository,
  type AervoxDatabase,
} from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_it",
  "x-user-id": "usr_it",
} as const;

const turnPayload = {
  message: { content: "hello", contentType: "text" },
  clientVersion: "it-test",
  references: [],
};

describe("API 集成测试：用户侧域路由", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("学习目标：创建 + 列表 + 租户隔离", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/learning/goals",
      headers,
      payload: { topic: "三角函数", level: "intermediate", availableMinutes: 20 },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().topic).toBe("三角函数");

    const list = await app.inject({ method: "GET", url: "/v1/learning/goals", headers });
    expect(list.json().items).toHaveLength(1);

    const otherList = await app.inject({
      method: "GET",
      url: "/v1/learning/goals",
      headers: { "x-workspace-id": "ws_other", "x-user-id": "usr_other" },
    });
    expect(otherList.json().items).toHaveLength(0);
  });

  it("题目与作答：创建题目 → 提交作答 → 查询作答列表", async () => {
    const learning = new SqliteLearningRepository(db);
    const tenant = { workspaceId: "ws_it", subjectUserId: "usr_it" };
    await learning.createKnowledgeItem(tenant, { id: "ki_trig", concept: "正弦" });
    const q = await app.inject({
      method: "POST",
      url: "/v1/questions",
      headers,
      payload: { prompt: "sin(30°)=?", answerSpec: { answer: "1/2" }, knowledgeId: "ki_trig" },
    });
    expect(q.statusCode).toBe(201);
    const questionId = q.json().id as string;

    const attempt = await app.inject({
      method: "POST",
      url: `/v1/questions/${questionId}/attempts`,
      headers,
      payload: { sessionId: "ses_1", answer: "1/2", judgement: "correct" },
    });
    expect(attempt.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: `/v1/questions/${questionId}/attempts`,
      headers,
    });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].judgement).toBe("correct");

    const knowledge = await app.inject({ method: "GET", url: "/v1/knowledge-items/ki_trig", headers });
    expect(knowledge.json()).toMatchObject({ correctCount: 1, wrongCount: 0, correctStreak: 1, mastery: 0.1 });

    const reviews = await app.inject({
      method: "GET",
      url: "/v1/review-items?dueBefore=2100-01-01T00:00:00.000Z",
      headers,
    });
    expect(reviews.json().items).toHaveLength(1);
    expect(reviews.json().items[0]).toMatchObject({ knowledgeId: "ki_trig", intervalDays: 2 });
  });

  it("作答：幂等重试只记录一次，部分正确不改变掌握度", async () => {
    const learning = new SqliteLearningRepository(db);
    const tenant = { workspaceId: "ws_it", subjectUserId: "usr_it" };
    await learning.createKnowledgeItem(tenant, { id: "ki_idem", concept: "余弦" });
    const question = await app.inject({
      method: "POST",
      url: "/v1/questions",
      headers,
      payload: { prompt: "cos(0)=?", answerSpec: { answer: "1" }, knowledgeId: "ki_idem" },
    });
    const questionId = question.json().id as string;
    const attemptHeaders = { ...headers, "idempotency-key": "attempt_idem_1" };
    const payload = { sessionId: "ses_2", answer: "1", judgement: "correct" };

    expect(
      (await app.inject({ method: "POST", url: `/v1/questions/${questionId}/attempts`, headers: attemptHeaders, payload })).statusCode,
    ).toBe(201);
    expect(
      (await app.inject({ method: "POST", url: `/v1/questions/${questionId}/attempts`, headers: attemptHeaders, payload })).statusCode,
    ).toBe(200);

    const partial = await app.inject({
      method: "POST",
      url: `/v1/questions/${questionId}/attempts`,
      headers,
      payload: { sessionId: "ses_2", answer: "0.5", judgement: "partial" },
    });
    expect(partial.statusCode).toBe(201);

    const attempts = await app.inject({ method: "GET", url: `/v1/questions/${questionId}/attempts`, headers });
    expect(attempts.json().items).toHaveLength(2);
    const knowledge = await app.inject({ method: "GET", url: "/v1/knowledge-items/ki_idem", headers });
    expect(knowledge.json()).toMatchObject({ correctCount: 1, wrongCount: 0, correctStreak: 1, mastery: 0.1 });
  });

  it("复习项：到期列表（先经仓储创建到期项）", async () => {
    const learning = new SqliteLearningRepository(db);
    const tenant = { workspaceId: "ws_it", subjectUserId: "usr_it" };
    await learning.createKnowledgeItem(tenant, { id: "ki_1", concept: "加法" });
    await learning.createReviewItem(tenant, { id: "ri_1", knowledgeId: "ki_1", dueAt: "2026-01-01T00:00:00.000Z" });

    const list = await app.inject({
      method: "GET",
      url: "/v1/review-items?dueBefore=2026-12-31T00:00:00.000Z",
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
  });

  it("反馈：提交 + 列表", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers,
      payload: { subjectType: "message", subjectId: "m_1", type: "inaccurate" },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/v1/feedback", headers });
    expect(list.json().items).toHaveLength(1);
  });

  it("同意授权：授予 → 查询 → 撤销 → 不再 active", async () => {
    const grant = await app.inject({
      method: "POST",
      url: "/v1/consent",
      headers,
      payload: { purpose: "diary", scope: "auto_generate", policyVersion: "v1" },
    });
    expect(grant.statusCode).toBe(201);
    const grantId = grant.json().id as string;

    const active = await app.inject({
      method: "GET",
      url: "/v1/consent?purpose=diary&scope=auto_generate",
      headers,
    });
    expect(active.json().active).toBe(true);

    const revoke = await app.inject({
      method: "POST",
      url: `/v1/consent/${grantId}/revoke`,
      headers,
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revokedAt).toBeTruthy();

    const inactive = await app.inject({
      method: "GET",
      url: "/v1/consent?purpose=diary&scope=auto_generate",
      headers,
    });
    expect(inactive.json().active).toBe(false);
  });

  it("埋点：提交事件并持久化", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/analytics/events",
      headers,
      payload: { eventName: "app_opened", analyticsSubjectId: "pseudo_1" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().eventName).toBe("app_opened");
  });

  it("消息身份：POST /v1/messages 写入 message 表", async () => {
    const session = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_msg/turns",
      headers,
      payload: turnPayload,
    });
    expect(session.statusCode).toBe(201);

    const msg = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers,
      payload: { sessionId: "ses_msg", role: "user", label: "首问" },
    });
    expect(msg.statusCode).toBe(201);
    expect(msg.json().role).toBe("user");
  });

  it("附件：创建元数据 + 查询", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/attachments",
      headers,
      payload: { objectKey: "obj/it1", mediaType: "image/png", size: 2048 },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;

    const get = await app.inject({ method: "GET", url: `/v1/attachments/${id}`, headers });
    expect(get.statusCode).toBe(200);
    expect(get.json().objectKey).toBe("obj/it1");
  });

  it("会话/Turn 回归：同一 Idempotency-Key 幂等返回同一 Turn", async () => {
    const withIdem = { ...headers, "idempotency-key": "idem_it_1" };
    const first = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_turn/turns",
      headers: withIdem,
      payload: turnPayload,
    });
    expect(first.statusCode).toBe(201);
    const firstTurnId = first.json().turnId as string;

    const second = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_turn/turns",
      headers: withIdem,
      payload: turnPayload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().turnId).toBe(firstTurnId);
  });

  it("通知列表：经仓储创建后经 API 可见", async () => {
    // 通过仓储直插一条通知，验证 GET /v1/notifications 可见
    const { SqlitePlatformRepository } = await import("@aervox/database");
    const platform = new SqlitePlatformRepository(db);
    await platform.createNotification(
      { workspaceId: "ws_it", subjectUserId: "usr_it" },
      { id: "ntf_1", type: "review", scheduledAt: "2026-01-01T00:00:00.000Z", channel: "in_app" },
    );

    const list = await app.inject({ method: "GET", url: "/v1/notifications", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
  });
});
