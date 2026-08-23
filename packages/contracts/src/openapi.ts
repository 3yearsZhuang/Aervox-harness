/**
 * Aervox｜思隅 @aervox/contracts — OpenAPI 3.1 文档生成
 *
 * 由 Zod 模式（schemas.ts）生成，作为流式协议机器可验证契约。
 * 规则依据：docs/contracts/STREAMING_PROTOCOL.md（AVX-SPC-001）。
 */
import { z } from "zod";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import {
  cancelTurnResponseSchema,
  createTurnRequestSchema,
  createTurnResponseSchema,
  deltaEventDataSchema,
  doneEventDataSchema,
  errorEventDataSchema,
  messageEventDataSchema,
  redactedEventDataSchema,
  streamErrorCodeSchema,
  turnStreamEventSchema,
} from "./schemas.js";

const registry = new OpenAPIRegistry();

registry.register("CreateTurnRequest", createTurnRequestSchema);
registry.register("CreateTurnResponse", createTurnResponseSchema);
registry.register("CancelTurnResponse", cancelTurnResponseSchema);
registry.register("TurnStreamEvent", turnStreamEventSchema);
registry.register("MessageEventData", messageEventDataSchema);
registry.register("DeltaEventData", deltaEventDataSchema);
registry.register("DoneEventData", doneEventDataSchema);
registry.register("ErrorEventData", errorEventDataSchema);
registry.register("RedactedEventData", redactedEventDataSchema);
registry.register("StreamErrorCode", streamErrorCodeSchema);

const sessionIdParam = z.object({ sessionId: z.string().min(1) });
const turnIdParam = z.object({ turnId: z.string().min(1) });

registry.registerPath({
  method: "post",
  path: "/v1/sessions/{sessionId}/turns",
  summary: "创建 Turn（幂等）",
  tags: ["Turn"],
  request: {
    params: sessionIdParam,
    headers: z.object({ "Idempotency-Key": z.string().min(1) }),
    body: {
      content: {
        "application/json": { schema: createTurnRequestSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: createTurnResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: errorEventDataSchema } },
    },
    409: {
      description: "IDEMPOTENCY_KEY_REUSED",
      content: { "application/json": { schema: errorEventDataSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/turns/{turnId}/events",
  summary: "读取 Turn SSE 事件流",
  tags: ["Turn"],
  request: { params: turnIdParam },
  responses: {
    200: {
      description: "SSE event stream",
      content: { "text/event-stream": { schema: turnStreamEventSchema } },
    },
    404: { description: "TURN_NOT_FOUND" },
    410: { description: "STREAM_CURSOR_EXPIRED" },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/turns/{turnId}/cancel",
  summary: "取消 Turn",
  tags: ["Turn"],
  request: { params: turnIdParam },
  responses: {
    200: {
      description: "Cancelled",
      content: { "application/json": { schema: cancelTurnResponseSchema } },
    },
    404: { description: "TURN_NOT_FOUND" },
  },
});

const generator = new OpenApiGeneratorV31(registry.definitions);

export const openApiDocument: OpenAPIObject = generator.generateDocument({
  openapi: "3.1.0",
  info: {
    title: "Aervox｜思隅 Turn Streaming API",
    version: "0.1.0",
    description:
      "对话流式协议（Turn/SSE）机器可验证契约。规则见 docs/contracts/STREAMING_PROTOCOL.md（AVX-SPC-001）。",
  },
  servers: [{ url: "http://localhost:3000" }],
});
