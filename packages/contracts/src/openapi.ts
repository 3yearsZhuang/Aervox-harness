/**
 * Aervox｜思隅 @aervox/contracts — OpenAPI 3.1 文档生成
 *
 * 由 Zod 模式（schemas.ts）生成，作为流式协议机器可验证契约。
 * 规则依据：docs/reference/STREAMING_PROTOCOL.md（AVX-SPC-001）。
 */
import { z } from "zod";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import {
  cancelTurnResponseSchema,
  createLearningGoalSchema,
  createTurnRequestSchema,
  createTurnResponseSchema,
  deltaEventDataSchema,
  doneEventDataSchema,
  emoteEventDataSchema,
  errorEventDataSchema,
  memoryStoreToolInputSchema,
  memoryStoreToolOutputSchema,
  messageEventDataSchema,
  petCommandSchema,
  petManifestSchema,
  petSheetLayoutSchema,
  petSheetStateSchema,
  redactedEventDataSchema,
  streamErrorCodeSchema,
  toolMetadataSchema,
  toolRegistryEntrySchema,
  toolRegistryExportSchema,
  turnStreamEventSchema,
  updateLearningGoalSchema,
} from "./schemas.js";

const registry = new OpenAPIRegistry();

registry.register("CreateLearningGoal", createLearningGoalSchema);
registry.register("UpdateLearningGoal", updateLearningGoalSchema);
registry.register("CreateTurnRequest", createTurnRequestSchema);
registry.register("CreateTurnResponse", createTurnResponseSchema);
registry.register("CancelTurnResponse", cancelTurnResponseSchema);
registry.register("TurnStreamEvent", turnStreamEventSchema);
registry.register("MessageEventData", messageEventDataSchema);
registry.register("DeltaEventData", deltaEventDataSchema);
registry.register("DoneEventData", doneEventDataSchema);
registry.register("ErrorEventData", errorEventDataSchema);
registry.register("RedactedEventData", redactedEventDataSchema);
registry.register("PetCommand", petCommandSchema);
registry.register("EmoteEventData", emoteEventDataSchema);
registry.register("StreamErrorCode", streamErrorCodeSchema);
registry.register("ToolMetadata", toolMetadataSchema);
registry.register("ToolRegistryEntry", toolRegistryEntrySchema);
registry.register("ToolRegistryExport", toolRegistryExportSchema);
registry.register("MemoryStoreToolInput", memoryStoreToolInputSchema);
registry.register("MemoryStoreToolOutput", memoryStoreToolOutputSchema);
registry.register("PetSheetState", petSheetStateSchema);
registry.register("PetSheetLayout", petSheetLayoutSchema);
registry.register("PetManifest", petManifestSchema);

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

registry.registerPath({
  method: "post",
  path: "/v1/learning/goals",
  summary: "创建学习目标（FR-LRN-001）",
  tags: ["Learning"],
  request: {
    headers: z.object({ "Idempotency-Key": z.string().min(1).optional() }),
    body: { content: { "application/json": { schema: createLearningGoalSchema } } },
  },
  responses: {
    201: { description: "Created" },
    200: { description: "Existing idempotent result" },
    400: { description: "Invalid request（topic/availableMinutes 非法）" },
  },
});

const learningGoalIdParam = z.object({ goalId: z.string().min(1) });
const learningGoalListQuery = z.object({ includeArchived: z.enum(["true", "false"]).optional() });

registry.registerPath({
  method: "get",
  path: "/v1/learning/goals",
  summary: "列出学习目标",
  tags: ["Learning"],
  request: { query: learningGoalListQuery },
  responses: { 200: { description: "Learning goals" } },
});

registry.registerPath({
  method: "get",
  path: "/v1/learning/goals/{goalId}",
  summary: "读取学习目标",
  tags: ["Learning"],
  request: { params: learningGoalIdParam },
  responses: {
    200: { description: "Learning goal" },
    404: { description: "Goal not found" },
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/learning/goals/{goalId}",
  summary: "更新学习目标",
  tags: ["Learning"],
  request: {
    params: learningGoalIdParam,
    body: { content: { "application/json": { schema: updateLearningGoalSchema } } },
  },
  responses: {
    200: { description: "Updated" },
    400: { description: "Invalid request" },
    404: { description: "Goal not found" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/learning/goals/{goalId}",
  summary: "归档学习目标",
  tags: ["Learning"],
  request: { params: learningGoalIdParam },
  responses: {
    204: { description: "Archived" },
    404: { description: "Goal not found" },
  },
});

const generator = new OpenApiGeneratorV31(registry.definitions);

export const openApiDocument: OpenAPIObject = generator.generateDocument({
  openapi: "3.1.0",
  info: {
    title: "Aervox｜思隅 Turn Streaming API",
    version: "0.1.0",
    description:
      "对话流式协议（Turn/SSE）机器可验证契约。规则见 docs/reference/STREAMING_PROTOCOL.md（AVX-SPC-001）。",
  },
  servers: [{ url: "http://localhost:3000" }],
});
