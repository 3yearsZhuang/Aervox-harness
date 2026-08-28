import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const personaSourceSchema = z.enum(["builtin", "user_created", "imported"]);
export const personaStatusSchema = z.enum(["active", "archived"]);
export const personaReviewStatusSchema = z.enum(["draft", "pending_review", "approved", "rejected"]);
export const memoryPolicySchema = z.enum(["isolated", "shared"]);
export const memoryCategorySchema = z.enum(["learning", "preference", "diary", "fact"]);
export const switchReasonSchema = z.enum(["user_initiated", "rollback", "system_default"]);
export const voiceSelectionSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  speakerId: z.string().min(1).optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export const personaRevisionConfigSchema = z.object({
  systemPromptAppend: z.string().min(1).max(32_000),
  allowedSkillNames: z.array(z.string().min(1)).optional(),
  allowedMcpToolIds: z.array(z.string().min(1)).optional(),
  voice: voiceSelectionSchema.optional(),
});
export const personaSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  subjectUserId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  source: personaSourceSchema,
  status: personaStatusSchema,
  reviewStatus: personaReviewStatusSchema,
  reviewNotes: z.string(),
  reviewedAt: z.iso.datetime().nullable(),
  currentRevisionId: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const personaRevisionSchema = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  revision: z.number().int().positive(),
  config: personaRevisionConfigSchema,
  checksum: z.string().length(64),
  createdAt: z.iso.datetime(),
});
export const activePersonaSelectionSchema = z.object({
  workspaceId: z.string().min(1),
  subjectUserId: z.string().min(1),
  personaId: z.string().min(1),
  revisionId: z.string().min(1),
  selectedAt: z.iso.datetime(),
});
export const skillSummarySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  allowedTools: z.array(z.string()).optional(),
  source: z.enum(["active", "workspace", "imported"]),
  version: z.number().int().positive(),
  checksum: z.string().length(64),
  enabled: z.boolean(),
  valid: z.boolean(),
  validationErrors: z.array(z.string()),
  importedAt: z.iso.datetime(),
});
export const mcpToolSchema = z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.unknown(),
  scopes: z.array(z.string()),
  healthy: z.boolean(),
  authorized: z.boolean(),
  revoked: z.boolean(),
  killSwitch: z.boolean(),
});
export const voiceSynthesisRequestSchema = z.object({
  providerId: z.string().min(1),
  text: z.string().min(1).max(20_000),
  modelId: z.string().min(1),
  speakerId: z.string().min(1).optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export const voiceSynthesisResponseSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  contentType: z.string().min(1),
  audioBase64: z.string().min(1),
});

export const voiceModelSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  speakerIds: z.array(z.string()),
  available: z.boolean(),
  source: z.enum(["local", "remote"]),
});

/** 本地语音模型配置（WebUI 设置「语音」读写；CR-011 阶段 1） */
export const localVoiceConfigSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().min(1),
  modelPath: z.string().min(1).optional(),
  modelId: z.string().min(1),
  speakerId: z.string().min(1).optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
/** 本地语音模型配置读取响应（缺省时按 env 给出默认值） */
export const localVoiceConfigResponseSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().min(1),
  modelPath: z.string().optional(),
  modelId: z.string().min(1),
  speakerId: z.string().optional(),
  settings: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({}),
});

export const createPersonaRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  config: personaRevisionConfigSchema,
});
export const updatePersonaRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  config: personaRevisionConfigSchema,
});
export const activatePersonaRequestSchema = z.object({ revisionId: z.string().min(1).optional() });
export const importPersonaRequestSchema = z.object({
  bundleBase64: z.string().min(1),
  conflictResolution: z.enum(["error", "replace"]).default("error"),
});
export const importSkillsRequestSchema = z.object({
  zipBase64: z.string().min(1),
  conflictResolution: z.enum(["error", "replace"]).default("error"),
});
export const exportSkillsRequestSchema = z.object({ names: z.array(z.string().min(1)).optional() });

export const personaBundleResponseSchema = z.object({
  bundleBase64: z.string().min(1),
  fileName: z.string().min(1),
  skillNames: z.array(z.string()),
  missingDependencies: z.array(z.string()),
});
export const skillZipResponseSchema = z.object({
  bundleBase64: z.string().min(1),
  fileName: z.string().min(1),
  skillNames: z.array(z.string()),
});

// ---- CAP-019: 模板审核、回滚、切换历史、记忆范围 ----

/** 提交人格审核请求 */
export const reviewPersonaRequestSchema = z.object({
  reviewStatus: z.enum(["pending_review", "approved", "rejected"]),
  reviewNotes: z.string().max(2000).optional(),
});

/** 人格回滚请求 */
export const rollbackPersonaRequestSchema = z.object({
  revisionId: z.string().min(1),
  /** 回滚时的回归评估备注 */
  regressionNotes: z.string().max(2000).optional(),
});

/** 更新人格记忆范围请求 */
export const updateMemoryScopeRequestSchema = z.object({
  memoryPolicy: memoryPolicySchema,
  /** 共享目标人格 ID 列表 */
  sharedPersonaIds: z.array(z.string().min(1)).optional(),
  /** 共享的记忆类别 */
  sharedCategories: z.array(memoryCategorySchema).optional(),
  /** 用户确认共享范围 */
  confirmed: z.boolean().default(false),
});

/** 人格切换日志响应 */
export const personaSwitchLogSchema = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  revisionId: z.string().min(1),
  previousPersonaId: z.string().nullable(),
  previousRevisionId: z.string().nullable(),
  switchReason: switchReasonSchema,
  regressionNotes: z.string().nullable(),
  switchedAt: z.iso.datetime(),
});

/** 人格记忆范围响应 */
export const personaMemoryScopeSchema = z.object({
  personaId: z.string().min(1),
  memoryPolicy: memoryPolicySchema,
  sharedPersonaIds: z.array(z.string()),
  sharedCategories: z.array(z.string()),
  confirmedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
