/**
 * Aervox｜思隅 @aervox/contracts — 会话管理模式（CR-035 / W1）
 *
 * 支撑标准工作台形态的会话枚举、创建、重命名与删除。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/** 会话概要项模式 */
export const sessionItemSchema = z
  .object({
    id: z.string().min(1).openapi({ description: "会话唯一标识符", example: "ses_m1234_abc" }),
    title: z.string().openapi({ description: "会话标题", example: "关于微积分极限的讨论" }),
    createdAt: z.string().openapi({ description: "会话创建时间（ISO 8601）", example: "2026-09-14T10:00:00.000Z" }),
    updatedAt: z.string().openapi({ description: "会话最近更新时间（ISO 8601）", example: "2026-09-14T10:00:00.000Z" }),
    isPinned: z.boolean().optional().openapi({ description: "是否置顶", example: false }),
    group: z.string().optional().openapi({ description: "可选分组归类标签", example: "微积分学习" }),
    projectId: z.string().nullable().optional().openapi({ description: "关联项目唯一标识符", example: "proj_math_01" }),
  })
  .openapi("SessionItem");

export type SessionItem = z.infer<typeof sessionItemSchema>;

/** 会话列表响应模式 */
export const listSessionsResponseSchema = z
  .object({
    items: z.array(sessionItemSchema).openapi({ description: "会话列表" }),
  })
  .openapi("ListSessionsResponse");

export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

/** 创建会话请求模式 */
export const createSessionRequestSchema = z
  .object({
    id: z.string().min(1).max(128).optional().openapi({ description: "可选客户端指定的会话 ID", example: "ses_custom_001" }),
    title: z.string().min(1).max(200).optional().openapi({ description: "会话标题（缺省自动生成）", example: "新对话" }),
    projectId: z.string().nullable().optional().openapi({ description: "关联项目唯一标识符", example: "proj_math_01" }),
  })
  .openapi("CreateSessionRequest");

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

/** 重命名或更新会话请求模式 */
export const renameSessionRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional().openapi({ description: "新的会话标题", example: "线性代数矩阵论" }),
    projectId: z.string().nullable().optional().openapi({ description: "关联项目唯一标识符（传 null 解绑）", example: "proj_math_01" }),
    isPinned: z.boolean().optional().openapi({ description: "是否置顶", example: true }),
  })
  .openapi("RenameSessionRequest");

export type RenameSessionRequest = z.infer<typeof renameSessionRequestSchema>;
export const updateSessionRequestSchema = renameSessionRequestSchema;
export type UpdateSessionRequest = RenameSessionRequest;
