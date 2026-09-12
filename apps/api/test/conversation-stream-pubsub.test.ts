/**
 * Aervox｜思隅 @aervox/api — CR-031 Turn 流式推送 Pub/Sub 与轮询解耦集成测试
 *
 * 验证 CR-031 核心契约：
 * 1. turnStreamHub 广播与订阅通道隔离，支持注销防泄漏；
 * 2. GET /v1/turns/:turnId/events 先重放 SQLite 存量事件，再无缝承接 turnStreamHub 增量直推；
 * 3. 终态发布后连接优雅排空并关闭；
 * 4. 已终态历史回合立即返回存量并关闭连接，零挂起。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  SqliteConversationRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { turnStreamHub } from "../src/modules/conversation/stream-hub.js";

const tenant: LocalContext = { workspaceId: "local", subjectUserId: "local" };

describe("CR-031 Turn 流式推送 Pub/Sub 解耦", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let cleanup: () => Promise<void>;
  let repo: SqliteConversationRepository;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "replay";
    const res = await createInMemoryDatabase();
    db = res.db;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client: res.client });
    app = built.app;
    repo = new SqliteConversationRepository(db);
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  it("turnStreamHub: 隔离订阅与生命周期管理", () => {
    const turnA = "turn_test_hub_a";
    const turnB = "turn_test_hub_b";
    const receivedA: any[] = [];
    const receivedB: any[] = [];
    let settledA = "";

    const unsubA = turnStreamHub.subscribe(turnA, {
      onEvent: (ev) => receivedA.push(ev),
      onSettled: (s) => {
        settledA = s;
      },
    });

    const unsubB = turnStreamHub.subscribe(turnB, {
      onEvent: (ev) => receivedB.push(ev),
      onSettled: () => undefined,
    });

    turnStreamHub.publishEvent(turnA, {
      id: "ev_1",
      turnId: turnA,
      sequence: 1,
      eventType: "delta",
      payloadVersion: 1,
      occurredAt: new Date().toISOString(),
      data: { text: "hello" },
    });

    turnStreamHub.publishEvent(turnB, {
      id: "ev_2",
      turnId: turnB,
      sequence: 1,
      eventType: "delta",
      payloadVersion: 1,
      occurredAt: new Date().toISOString(),
      data: { text: "world" },
    });

    turnStreamHub.publishSettled(turnA, "Completed");

    expect(receivedA).toHaveLength(1);
    expect(receivedA[0].id).toBe("ev_1");
    expect(settledA).toBe("Completed");

    expect(receivedB).toHaveLength(1);
    expect(receivedB[0].id).toBe("ev_2");

    unsubA();
    unsubB();

    // 注销后不再接收
    turnStreamHub.publishEvent(turnA, {
      id: "ev_3",
      turnId: turnA,
      sequence: 2,
      eventType: "delta",
      payloadVersion: 1,
      occurredAt: new Date().toISOString(),
      data: { text: "after unsub" },
    });
    expect(receivedA).toHaveLength(1);
  });

  it("GET /v1/turns/:id/events: 存量重放 + Pub/Sub 增量直推", async () => {
    const sessionId = "sess_sse_pubsub";
    const turnId = "turn_sse_pubsub_1";
    await repo.getOrCreateSession(tenant, sessionId, "SSE PubSub Test");
    await repo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId, idempotencyKey: `idem_${turnId}`, status: "Created" },
      { id: `msg_${turnId}`, content: "test user input" },
      { id: `ob_${turnId}`, eventType: "turn.created", idempotencyKey: `idem_ob_${turnId}`, payload: { turnId, sessionId } },
    );
    await repo.createTurnAttempt(tenant, turnId, {
      id: "att_1",
      attempt: 1,
    });

    // 预置存量事件 (sequence 1)
    await repo.appendStreamEvent(tenant, {
      id: "ev_init",
      turnId,
      sequence: 1,
      eventType: "turn.created",
      payloadVersion: 1,
      data: { turnId },
    });

    // 启动异步获取 SSE 响应
    const responsePromise = app.inject({
      method: "GET",
      url: `/v1/turns/${turnId}/events`,
    });

    // 稍微等待客户端连接挂载并重放完毕
    await new Promise((r) => setTimeout(r, 50));

    // 通过 turnStreamHub 实时推流增量事件 (sequence 2)
    turnStreamHub.publishEvent(turnId, {
      id: "ev_live_delta",
      turnId,
      sequence: 2,
      eventType: "delta",
      payloadVersion: 1,
      occurredAt: new Date().toISOString(),
      data: { text: "实时内容" },
    });

    // 终态持久化并广播
    await repo.finalizeTurnAttempt(tenant, {
      turnId,
      attemptId: "att_1",
      status: "Completed",
    });
    turnStreamHub.publishSettled(turnId, "Completed");

    const res = await responsePromise;
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const payload = res.body;
    // 包含存量事件
    expect(payload).toContain("turn.created");
    // 包含实时直推事件
    expect(payload).toContain("实时内容");
    expect(payload).toContain("ev_live_delta");
  });

  it("GET /v1/turns/:id/events: 历史已终态回合立即结束", async () => {
    const sessionId = "sess_sse_history";
    const turnId = "turn_sse_history_1";
    await repo.getOrCreateSession(tenant, sessionId, "SSE History Test");
    await repo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId, idempotencyKey: `idem_${turnId}`, status: "Completed" },
      { id: `msg_${turnId}`, content: "completed turn" },
      { id: `ob_${turnId}`, eventType: "turn.created", idempotencyKey: `idem_ob_${turnId}`, payload: { turnId, sessionId } },
    );
    await repo.createTurnAttempt(tenant, turnId, {
      id: "att_hist",
      attempt: 1,
    });
    await repo.finalizeTurnAttempt(tenant, {
      turnId,
      attemptId: "att_hist",
      status: "Completed",
    });

    await repo.appendStreamEvent(tenant, {
      id: "ev_done",
      turnId,
      sequence: 1,
      eventType: "done",
      payloadVersion: 1,
      data: { reason: "normal" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/turns/${turnId}/events`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("done");
  });
});
