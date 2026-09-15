/**
 * Aervox｜思隅 @aervox/contracts — 项目管理与会话导入模式（CR-048 / W3）
 *
 * 支撑标准工作台的项目上下文聚合、会话归属与外部会话安全导入。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { sessionItemSchema } from "./session-schemas.js";

extendZodWithOpenApi(z);

/** 项目概要项模式 */
export const projectItemSchema = z
  .object({
    id: z.string().min(1).openapi({ description: "项目唯一标识符", example: "proj_math_01" }),
    name: z.string().min(1).max(100).openapi({ description: "项目名称", example: "微积分与线性代数" }),
    description: z.string().max(500).optional().openapi({ description: "项目描述", example: "高等数学复习与例题巩固" }),
    color: z.string().optional().openapi({ description: "项目强调色（十六进制或预设名称）", example: "#4f46e5" }),
    icon: z.string().optional().openapi({ description: "项目图标标识", example: "book-open" }),
    createdAt: z.string().openapi({ description: "创建时间（ISO 8601）", example: "2026-09-14T10:00:00.000Z" }),
    updatedAt: z.string().openapi({ description: "更新时间（ISO 8601）", example: "2026-09-14T10:00:00.000Z" }),
    archivedAt: z.string().nullable().optional().openapi({ description: "归档时间（ISO 8601，未归档为 null）", example: null }),
  })
  .openapi("ProjectItem");

export type ProjectItem = z.infer<typeof projectItemSchema>;

/** 项目列表响应模式 */
export const listProjectsResponseSchema = z
  .object({
    items: z.array(projectItemSchema).openapi({ description: "项目列表" }),
  })
  .openapi("ListProjectsResponse");

export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;

/** 创建项目请求模式 */
export const createProjectRequestSchema = z
  .object({
    id: z.string().min(1).max(128).optional().openapi({ description: "可选客户端指定的项目 ID", example: "proj_custom_001" }),
    name: z.string().min(1).max(100).openapi({ description: "项目名称", example: "机器学习实战" }),
    description: z.string().max(500).optional().openapi({ description: "项目描述", example: "深度学习与强化学习项目" }),
    color: z.string().optional().openapi({ description: "项目颜色", example: "#10b981" }),
    icon: z.string().optional().openapi({ description: "项目图标", example: "cpu" }),
  })
  .openapi("CreateProjectRequest");

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/** 更新项目请求模式 */
export const updateProjectRequestSchema = z
  .object({
    name: z.string().min(1).max(100).optional().openapi({ description: "项目名称", example: "高等数学精进" }),
    description: z.string().max(500).optional().openapi({ description: "项目描述", example: "例题与期末复习" }),
    color: z.string().optional().openapi({ description: "项目颜色", example: "#6366f1" }),
    icon: z.string().optional().openapi({ description: "项目图标", example: "sparkles" }),
    archived: z.boolean().optional().openapi({ description: "是否归档", example: false }),
  })
  .openapi("UpdateProjectRequest");

export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

/** 外部导入消息单条模式 */
export const importSessionMessageSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]).openapi({ description: "消息角色", example: "user" }),
    content: z.string().min(1).openapi({ description: "消息文本内容", example: "请讲解一下傅里叶变换的直观含义" }),
    createdAt: z.string().optional().openapi({ description: "可选原始时间戳（ISO 8601）", example: "2026-09-14T10:00:00.000Z" }),
  })
  .openapi("ImportSessionMessage");

export type ImportSessionMessage = z.infer<typeof importSessionMessageSchema>;

/** 外部会话导入请求模式 */
export const importSessionRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional().openapi({ description: "可选导入会话标题", example: "傅里叶变换探讨（导入）" }),
    projectId: z.string().min(1).optional().openapi({ description: "可选关联项目 ID", example: "proj_math_01" }),
    messages: z
      .array(importSessionMessageSchema)
      .min(1)
      .max(500)
      .openapi({ description: "待导入的历史消息序列（上限 500 条）" }),
  })
  .openapi("ImportSessionRequest");

export type ImportSessionRequest = z.infer<typeof importSessionRequestSchema>;

/** 外部会话导入结果模式 */
export const importSessionResponseSchema = z
  .object({
    session: sessionItemSchema.openapi({ description: "创建成功的会话概要" }),
    turnsCount: z.number().int().nonnegative().openapi({ description: "导入并生成的 Turn 轮数", example: 3 }),
    messagesCount: z.number().int().nonnegative().openapi({ description: "导入的消息总数", example: 6 }),
  })
  .openapi("ImportSessionResponse");

export type ImportSessionResponse = z.infer<typeof importSessionResponseSchema>;
