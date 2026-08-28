/**
 * Aervox｜思隅 @aervox/contracts — 受控收件箱（Agent Inbox）Zod 模式
 *
 * 规则依据：docs/reference/agent-harness-loop.md §7.2 + ADR-017。
 * 对应阶段 5a-2 HTTP 入口（POST /v1/sessions/:sessionId/inbox）：
 * - followup → next-turn（排队为新 Turn 输入）
 * - steer → next-step（修改下一 Step 输入；不能改写已提交事件）
 * - inject → next-step 或 next-turn（添加上下文）
 * sourceActor 由服务端按调用方身份注入（user / plugin），不由客户端自报。
 */
import { z } from "zod";

/** inbox 项类型（§7.2） */
export const inboxItemTypeSchema = z.enum(["followup", "steer", "inject"]);

/** 来源 actor（user=终端用户 / plugin=已授权插件 / agent=系统内部；HTTP 端点只暴露 user/plugin） */
export const inboxSourceActorSchema = z.enum(["user", "agent", "plugin"]);

/** 消费边界（next-turn=新 Turn 输入；next-step=下一 Step 输入） */
export const inboxConsumeBoundarySchema = z.enum(["next-turn", "next-step"]);

/** 状态机（pending → claimed → acknowledged；expired 兜底回收） */
export const inboxItemStatusSchema = z.enum(["pending", "claimed", "acknowledged", "expired"]);

/** 提交一条受控 inbox command（统一端点请求体） */
export const createInboxItemRequestSchema = z
  .object({
    /** 幂等键（租户内唯一；重复提交返回既有项） */
    idempotencyKey: z.string().min(1),
    /**
     * 目标 Session。路径参数 `/v1/sessions/:sessionId/inbox` 已承载目标，
     * body 中的 sessionId 仅用于一致性校验（可选：提供时必须与路径一致）。
     */
    sessionId: z.string().min(1).optional(),
    /** 消费目标 Attempt（next-step 定位用；缺省 null 表示不绑定） */
    attemptId: z.string().min(1).optional(),
    type: inboxItemTypeSchema,
    /** 内容载荷（compact 编码，含来源与用途标注） */
    payload: z.unknown(),
    /** 消费边界；缺省按类型推定（followup→next-turn；steer→next-step；inject 可显式指定） */
    consumeBoundary: inboxConsumeBoundarySchema.optional(),
    /** 过期时间（ISO-8601 UTC）；缺省不自动过期 */
    expiresAt: z.iso.datetime().optional(),
  })
  .refine(
    (v) => {
      // 类型与消费边界一致性（§7.2）：followup 只能 next-turn；steer 只能 next-step
      if (v.type === "followup") return !v.consumeBoundary || v.consumeBoundary === "next-turn";
      if (v.type === "steer") return !v.consumeBoundary || v.consumeBoundary === "next-step";
      return true; // inject 两者皆可
    },
    { message: "consumeBoundary 与 type 不匹配（followup→next-turn；steer→next-step）" },
  );

/** 提交结果（对齐数据库 AgentInboxItemModel；幂等命中返回既有项） */
export const inboxItemResponseSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  sessionId: z.string().min(1),
  attemptId: z.string().nullable().optional(),
  stepId: z.string().nullable().optional(),
  type: inboxItemTypeSchema,
  orderingSeq: z.number().int(),
  sourceActor: inboxSourceActorSchema,
  payload: z.unknown(),
  status: inboxItemStatusSchema,
  consumeBoundary: inboxConsumeBoundarySchema,
  claimedAt: z.iso.datetime().nullable().optional(),
  ackedAt: z.iso.datetime().nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  workspaceId: z.string().min(1),
  subjectUserId: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});