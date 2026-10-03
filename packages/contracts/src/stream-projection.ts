/**
 * Aervox｜思隅 @aervox/contracts — 对外事件负载安全投影（Safety Projection）
 *
 * 投影白名单对活流事件与持久化重放事件**同一套判据**，目的有二：
 * 1. 逐事件类型收敛对外字段，避免工具实现细节与内部账本外泄；
 * 2. fail-closed：未登记投影的事件一律投影为空对象，而不是原样透传。
 *
 * CR-060：内核不得为具体插件工具开后门。插件事件与插件工具结果的投影经
 * `registerPluginApiContribution` 显式登记，由本文件泛化查表；
 * 内核源码不含任何插件事件类型或工具名。
 */
import { z } from "zod";
import { messageEventDataSchema, deltaEventDataSchema, reasoningDeltaEventDataSchema,
  doneEventDataSchema, errorEventDataSchema, redactedEventDataSchema, emoteEventDataSchema,
  userQuestionRequiredEventDataSchema, userQuestionAnsweredEventDataSchema,
  toolApprovalRequiredEventDataSchema } from "./schemas.js";
import { getPluginEventProjection, getPluginToolResultProjection } from "./plugin-api-registry.js";

/** 内核内建事件投影白名单（键集即 `KERNEL_STREAM_EVENT_TYPES`，由单测断言一致） */
const kernelEventSchemas: Record<string, z.ZodType> = {
  message: messageEventDataSchema.partial(), delta: deltaEventDataSchema.partial(),
  reasoning_delta: reasoningDeltaEventDataSchema.partial(),
  done: doneEventDataSchema.partial().extend({ status: z.string().optional(), reason: z.string().optional() }),
  error: errorEventDataSchema.partial().extend({ code: z.string().optional() }),
  redacted: redactedEventDataSchema.partial(), emote: emoteEventDataSchema,
  user_question_required: userQuestionRequiredEventDataSchema,
  user_question_answered: userQuestionAnsweredEventDataSchema,
  tool_approval_required: toolApprovalRequiredEventDataSchema,
  // Tool implementation payloads stay in the owner ledger; public progress is minimal.
  tool_request: z.object({ invocationId: z.string(), executionId: z.string().optional(), name: z.string() }),
  tool_result: z.object({ invocationId: z.string(), executionId: z.string().optional(), name: z.string(), ok: z.boolean(), error: z.string().optional() }),
};

/** 内核投影白名单覆盖的事件类型（键集）；须与 `KERNEL_STREAM_EVENT_TYPES` 一致，由单测断言 */
export const KERNEL_PROJECTION_EVENT_TYPES: readonly string[] = Object.keys(kernelEventSchemas);

/** 解析事件类型的投影模式：内核白名单优先，其次插件登记；均无则为未登记（投影为空） */
function resolveEventSchema(eventType: string): z.ZodType | undefined {
  return Object.hasOwn(kernelEventSchemas, eventType)
    ? kernelEventSchemas[eventType]
    : getPluginEventProjection(eventType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Schema allowlists apply identically to live events and persisted replay, including nested DTOs. */
export function projectSafeEventData(eventType: string, data: unknown): unknown {
  const schema = resolveEventSchema(eventType);
  const result = schema ? schema.safeParse(data) : undefined;
  if (!result?.success) return {};
  if (eventType === "tool_result" && isRecord(data)) {
    // 工具结果载荷默认不对外；只有登记了投影模式的插件工具才暴露其白名单字段
    const toolName = typeof data.name === "string" ? data.name : undefined;
    const projection = toolName ? getPluginToolResultProjection(toolName) : undefined;
    if (projection) {
      const output = projection.safeParse(data.output);
      if (output.success) return { ...(result.data as object), output: output.data };
    }
  }
  return result.data;
}
