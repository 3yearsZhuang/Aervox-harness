/**
 * Aervox｜思隅 @aervox/api — 契约骨架
 *
 * 仅暴露流式协议的路由形态与 OpenAPI 文档，业务逻辑后续按 SRS 逐 AC 实现。
 * 规则依据：docs/contracts/STREAMING_PROTOCOL.md + @aervox/contracts。
 */
import Fastify from "fastify";
import {
  cancelTurnResponseSchema,
  createTurnRequestSchema,
  openApiDocument,
  type TurnStreamEvent,
} from "@aervox/contracts";

const app = Fastify({ logger: true });

let seq = 0;
const nextTurnId = (): string => `turn_${Date.now().toString(36)}_${(++seq).toString(36)}`;
const now = (): string => new Date().toISOString();

// 契约骨架：暴露由 @aervox/contracts 生成的 OpenAPI 3.1 文档
app.get("/openapi.json", async () => openApiDocument);

// POST /v1/sessions/{sessionId}/turns — 幂等创建 Turn（骨架：校验后返回 201 占位）
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
  void sessionId;
  const turnId = nextTurnId();
  return reply.code(201).send({
    turnId,
    status: "Created" as const,
    eventsUrl: `/v1/turns/${turnId}/events`,
    cancelUrl: `/v1/turns/${turnId}/cancel`,
  });
});

// GET /v1/turns/{turnId}/events — SSE 事件流（骨架：输出一个 done 终态占位）
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

// POST /v1/turns/{turnId}/cancel — 取消 Turn（骨架占位）
app.post("/v1/turns/:turnId/cancel", async (req, reply) => {
  const { turnId } = req.params as { turnId: string };
  void cancelTurnResponseSchema;
  return reply.send({ turnId, status: "Cancelled" as const });
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
