/**
 * Aervox｜思隅 @aervox/api — 契约骨架与 SQLite 持久化接入
 *
 * 暴露流式协议路由与 OpenAPI 文档，基于 @aervox/database (SQLite + Drizzle) 实现租户隔离与落库。
 * 规则依据：docs/contracts/STREAMING_PROTOCOL.md + @aervox/contracts + ADR-012。
 */
import Fastify from "fastify";
import {
  cancelTurnResponseSchema,
  createTurnRequestSchema,
  openApiDocument,
  type TurnStreamEvent,
} from "@aervox/contracts";
import {
  createDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type TenantContext,
} from "@aervox/database";

const app = Fastify({ logger: true });

// 初始化 SQLite 数据库与仓储层
const { db, client } = await createDatabase();
await initDatabaseSchema(client);
const convRepo = new SqliteConversationRepository(db);

let seq = 0;
const nextTurnId = (): string => `turn_${Date.now().toString(36)}_${(++seq).toString(36)}`;
const now = (): string => new Date().toISOString();

// 契约骨架：暴露由 @aervox/contracts 生成的 OpenAPI 3.1 文档
app.get("/openapi.json", async () => openApiDocument);

// POST /v1/sessions/{sessionId}/turns — 幂等创建 Turn 并原子写入 Outbox
app.post("/v1/sessions/:sessionId/turns", async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  const parsed = createTurnRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      code: "MODEL_TIMEOUT" as const,
      retryable: false,
      message: "Invalid create turn request",
      lastSequence: 0,
    });
  }

  // 从 Header 中提取 Idempotency-Key 与租户上下文
  const idempotencyKey =
    (req.headers["idempotency-key"] as string) ||
    `idem_${Date.now().toString(36)}_${(++seq).toString(36)}`;

  const tenant: TenantContext = {
    workspaceId: (req.headers["x-workspace-id"] as string) ?? "ws_default",
    subjectUserId: (req.headers["x-user-id"] as string) ?? "usr_default",
  };

  // 确保会话存在（turns.session_id 外键引用 sessions；客户端可能直接以任意 sessionId 发起首次 Turn）
  await convRepo.getOrCreateSession(tenant, sessionId, "Aervox 会话");

  // 检查幂等性
  const existingTurn = await convRepo.getTurnByIdempotencyKey(tenant, idempotencyKey);
  if (existingTurn) {
    return reply.code(200).send({
      turnId: existingTurn.id,
      status: existingTurn.status,
      eventsUrl: `/v1/turns/${existingTurn.id}/events`,
      cancelUrl: `/v1/turns/${existingTurn.id}/cancel`,
    });
  }

  const turnId = nextTurnId();
  const messageId = `msg_${Date.now().toString(36)}_${(++seq).toString(36)}`;

  await convRepo.createTurnWithOutbox(
    tenant,
    {
      id: turnId,
      sessionId,
      idempotencyKey,
      status: "Created",
    },
    {
      id: messageId,
      content: parsed.data.message.content,
    },
    {
      id: `outbox_${turnId}`,
      eventType: "turn.created",
      idempotencyKey: `idem_outbox_${turnId}`,
      payload: { turnId, sessionId },
    },
  );

  return reply.code(201).send({
    turnId,
    status: "Created" as const,
    eventsUrl: `/v1/turns/${turnId}/events`,
    cancelUrl: `/v1/turns/${turnId}/cancel`,
  });
});

// GET /v1/turns/{turnId}/events — SSE 事件流
app.get("/v1/turns/:turnId/events", async (req, reply) => {
  const { turnId } = req.params as { turnId: string };
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const done: TurnStreamEvent = {
    eventId: `tev_${Date.now().toString(36)}`,
    turnId,
    sequence: 1,
    eventType: "done",
    payloadVersion: 1,
    occurredAt: now(),
    data: { status: "Completed", isComplete: true, lastSequence: 1 },
  };
  reply.raw.write(`id: ${done.eventId}\n`);
  reply.raw.write(`data: ${JSON.stringify(done)}\n\n`);
  reply.raw.end();
});

// POST /v1/turns/{turnId}/cancel — 取消 Turn
app.post("/v1/turns/:turnId/cancel", async (req, reply) => {
  const { turnId } = req.params as { turnId: string };
  const tenant: TenantContext = {
    workspaceId: (req.headers["x-workspace-id"] as string) ?? "ws_default",
    subjectUserId: (req.headers["x-user-id"] as string) ?? "usr_default",
  };
  await convRepo.updateTurnStatus(tenant, turnId, "Cancelled");
  void cancelTurnResponseSchema;
  return reply.send({ turnId, status: "Cancelled" as const });
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
