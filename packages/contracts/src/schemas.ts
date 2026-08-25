/**
 * Aervox｜思隅 @aervox/contracts — 流式协议 Zod 模式
 *
 * 规则依据：docs/contracts/STREAMING_PROTOCOL.md（AVX-SPC-001）。
 * 模式是运行时校验与 OpenAPI 生成的事实源；类型经 z.infer 派生。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

// 必须在任何 schema 创建前调用：zod 4 的 .openapi 只对 extend 之后创建的 schema 生效
extendZodWithOpenApi(z);

/** Turn 状态机（§3） */
export const turnStatusSchema = z.enum([
  "Created",
  "InputChecking",
  "Running",
  "Finalizing",
  "Completed",
  "Rejected",
  "CancelRequested",
  "Cancelled",
  "Interrupted",
  "Failed",
]);

/** 公开业务 SSE 事件类型（§4） */
export const streamEventTypeSchema = z.enum([
  "message",
  "delta",
  "done",
  "error",
  "redacted",
]);

/** 标准错误码（§4.5） */
export const streamErrorCodeSchema = z.enum([
  "IDEMPOTENCY_KEY_REUSED",
  "TURN_NOT_FOUND",
  "STREAM_CURSOR_EXPIRED",
  "TURN_CANCELLED",
  "MODEL_TIMEOUT",
  "MODEL_UNAVAILABLE",
  "OUTPUT_SAFETY_BLOCKED",
  "PERMISSION_REVOKED",
]);

/** 业务事件统一 envelope（§4） */
export const turnStreamEventSchema = z.object({
  /** 全局稳定且不可复用 */
  eventId: z.string().min(1),
  turnId: z.string().min(1),
  /** Turn 内从 1 单调递增且唯一 */
  sequence: z.number().int().positive(),
  eventType: streamEventTypeSchema,
  payloadVersion: z.number().int(),
  /** ISO-8601 UTC */
  occurredAt: z.iso.datetime(),
  modelRunId: z.string().optional(),
  /** 各事件 payload（见 *_data_schema） */
  data: z.unknown(),
});

/** message：Assistant Message 身份/可见元数据已提交（§4.1） */
export const messageEventDataSchema = z.object({
  messageId: z.string().min(1),
  role: z.literal("assistant"),
  contentType: z.enum(["text", "markdown"]),
  isComplete: z.boolean(),
});

/** delta：已通过安全门且已持久化的可见正文（§4.2） */
export const deltaEventDataSchema = z.object({
  messageId: z.string().min(1),
  text: z.string(),
  isFinal: z.boolean(),
});

/** done：Turn 终态已提交（§4.3） */
export const doneEventDataSchema = z.object({
  status: turnStatusSchema,
  messageId: z.string().optional(),
  isComplete: z.boolean(),
  lastSequence: z.number().int().positive(),
  contextVersion: z.string().optional(),
});

/** error：已持久化的错误诊断（§4.4） */
export const errorEventDataSchema = z.object({
  code: streamErrorCodeSchema,
  retryable: z.boolean(),
  message: z.string().min(1),
  lastSequence: z.number().int().positive(),
});

/** redacted：正文因来源删除/同意撤销/权限变化不再可见（§4.5） */
export const redactedEventDataSchema = z.object({
  targetEventId: z.string().min(1),
  visibilityRevision: z.number().int(),
  reasonCode: z.enum(["revoked", "deleted", "policy_changed"]),
  replacement: z.string().optional(),
});

/** 创建 Turn 请求体最小字段（§2.1） */
export const createTurnRequestSchema = z.object({
  message: z.object({
    content: z.string().min(1),
    contentType: z.enum(["text", "markdown"]),
  }),
  clientVersion: z.string().min(1),
  references: z
    .array(
      z.object({
        sourceId: z.string().min(1),
        sourceVersion: z.string().min(1),
      }),
    )
    .optional(),
});

/** 创建 Turn 成功响应（§2.1） */
export const createTurnResponseSchema = z.object({
  turnId: z.string().min(1),
  status: z.literal("Created"),
  eventsUrl: z.string().min(1),
  cancelUrl: z.string().min(1),
});

/** 取消 Turn 响应（§2.3） */
export const cancelTurnResponseSchema = z.object({
  turnId: z.string().min(1),
  status: z.enum(["CancelRequested", "Cancelled"]),
});

/** 当前事件 payload 版本 */
export const STREAM_PAYLOAD_VERSION = 1;

/** 学习目标等级（与 packages/database src/schema/learning.ts 对齐） */
export const learningGoalLevelSchema = z.enum(["beginner", "intermediate", "advanced"]);

/** 创建学习目标请求体（FR-LRN-001 / CAP-002） */
export const createLearningGoalSchema = z.object({
  topic: z.string().trim().min(1, "topic is required"),
  level: learningGoalLevelSchema.optional(),
  availableMinutes: z
    .number({ error: "availableMinutes must be a positive integer" })
    .int("availableMinutes must be a positive integer")
    .positive("availableMinutes must be a positive integer")
    .optional(),
});

