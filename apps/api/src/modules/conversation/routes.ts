/**
 * Aervox｜思隅 @aervox/api — 会话/流式协议路由
 *
 * 规则依据：docs/reference/STREAMING_PROTOCOL.md + @aervox/contracts + AVX-HAR-001（阶段 1）。
 * 迁移自原单文件 index.ts，并补充 Message 身份写链路；SSE 事件来自持久 turn_stream_events，
 * Turn 创建后由 Agent Loop（Replay Provider）执行并写事件。
 */
import type { FastifyInstance } from "fastify";
import { createTurnRequestSchema } from "@aervox/contracts";
import type { SqliteConversationRepository } from "@aervox/database";
import { resolveTenant } from "../../shared/tenant.js";
import { runReplayTurnOnce } from "./agent-executor.js";

let seq = 0;
const nextTurnId = (): string => `turn_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerConversationRoutes(
  app: FastifyInstance,
  conversationRepo: SqliteConversationRepository,
): void {
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

    const idempotencyKey =
      (req.headers["idempotency-key"] as string) ||
      `idem_${Date.now().toString(36)}_${(++seq).toString(36)}`;

    const tenant = resolveTenant(req);

    // 确保会话存在（turns.session_id 外键引用 sessions）
    await conversationRepo.getOrCreateSession(tenant, sessionId, "Aervox 会话");

    // 检查幂等性
    const existingTurn = await conversationRepo.getTurnByIdempotencyKey(tenant, idempotencyKey);
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

    await conversationRepo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId, idempotencyKey, status: "Created" },
      { id: messageId, content: parsed.data.message.content },
      {
        id: `outbox_${turnId}`,
        eventType: "turn.created",
        idempotencyKey: `idem_outbox_${turnId}`,
        payload: { turnId, sessionId },
      },
    );

    // 阶段 1（AVX-HAR-001 §15）：创建 Attempt 并由 Agent Loop 执行一次
    const attemptId = `atp_${turnId}`;
    await conversationRepo.createTurnAttempt(tenant, turnId, { id: attemptId, attempt: 1 });
    await runReplayTurnOnce(conversationRepo, tenant, {
      turnId,
      sessionId,
      attemptId,
      userMessage: parsed.data.message.content,
    });

    return reply.code(201).send({
      turnId,
      status: "Created" as const,
      eventsUrl: `/v1/turns/${turnId}/events`,
      cancelUrl: `/v1/turns/${turnId}/cancel`,
    });
  });

  // GET /v1/turns/{turnId}/events — SSE 事件流（重放持久 turn_stream_events，AVX-HAR-001 阶段 1）
  app.get("/v1/turns/:turnId/events", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveTenant(req);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
    });
    const events = await conversationRepo.getStreamEvents(tenant, turnId, 0);
    for (const ev of events) {
      const body = {
        eventId: ev.id,
        turnId: ev.turnId,
        sequence: ev.sequence,
        eventType: ev.eventType,
        payloadVersion: ev.payloadVersion,
        occurredAt: ev.occurredAt,
        data: ev.data,
      };
      reply.raw.write(`id: ${ev.id}\n`);
      reply.raw.write(`data: ${JSON.stringify(body)}\n\n`);
    }
    reply.raw.end();
  });

  // POST /v1/turns/{turnId}/cancel — 取消 Turn
  app.post("/v1/turns/:turnId/cancel", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveTenant(req);
    await conversationRepo.updateTurnStatus(tenant, turnId, "Cancelled");
    return reply.send({ turnId, status: "Cancelled" as const });
  });

  // POST /v1/messages — 创建消息身份（身份与版本分离的写链路）
  app.post("/v1/messages", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as { sessionId?: string; role?: string; label?: string };
    if (!body.sessionId || !body.role) {
      return reply.code(400).send({ error: "sessionId and role are required" });
    }
    const message = await conversationRepo.createMessage(tenant, {
      id: `msg_${Date.now().toString(36)}_${(++seq).toString(36)}`,
      sessionId: body.sessionId,
      role: body.role,
      label: body.label,
    });
    return reply.code(201).send(message);
  });
}