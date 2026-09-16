/**
 * CR-033 F1 共享契约：ProactiveTurnContextPort。
 *
 * 规则依据：CR-033（已归档至归档库）
 * - P5 人格同源：主动回合复用对话侧 persona revision、记忆召回引用、safety policy；
 * - 插件 SKILL.md 只作为不可信场景叠加层，不能覆盖系统指令、身份、授权或安全策略；
 * - Worker 不直接导入 apps/api，Port 由 API 与 Worker 共享的 contracts 层承载。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/** ProactiveTurnContextPort 契约版本。 */
export const PROACTIVE_TURN_CONTEXT_VERSION = "proactive_turn_context_v1" as const;

/** 获准记忆引用：仅携带引用 id 与召回作用域，不携带记忆原文。 */
export const proactiveMemoryReferenceSchema = z
  .object({
    memoryId: z.string().min(1),
    scope: z.enum(["context", "evidence"]),
    policyVersion: z.string().min(1),
  })
  .strict();

/** 安全策略版本与处置级别：主动回合复用对话侧门禁语义。 */
export const proactiveSafetyPolicySchema = z
  .object({
    policyVersion: z.string().min(1),
    classificationLevel: z.enum(["normal", "sensitive", "crisis"]),
    crisisResponse: z.enum(["block", "fixed_response"]).optional(),
  })
  .strict();

/**
 * 主动回合上下文 Port：persona revision、允许技能、获准记忆引用、
 * safety policy 与不可信插件叠加层。
 *
 * 不可信插件层是插件 SKILL.md 的场景叠加声明，任何情况下不得覆盖
 * 系统指令、身份、授权或安全策略（fail-closed）。
 */
export const proactiveTurnContextSchema = z
  .object({
    version: z.literal(PROACTIVE_TURN_CONTEXT_VERSION),
    personaRevisionId: z.string().min(1),
    personaId: z.string().min(1),
    /** 由对话侧人格管线按 personaRevisionId 解析出的受信系统提示词。 */
    personaSystemPrompt: z.string().min(1).max(32_768),
    allowedSkills: z.array(z.string().min(1)).max(256).default([]),
    memoryReferences: z.array(proactiveMemoryReferenceSchema).max(64).default([]),
    safety: proactiveSafetyPolicySchema,
    untrustedPluginLayer: z
      .object({
        pluginId: z.string().min(1),
        skillOverlayJson: z.string().max(16_384).default("{}"),
        personaOverlayEnabled: z.boolean().default(false),
      })
      .strict()
      .nullable()
      .default(null),
    localOnly: z.literal(true),
  })
  .strict();

export type ProactiveTurnContext = z.infer<typeof proactiveTurnContextSchema>;
export type ProactiveMemoryReference = z.infer<typeof proactiveMemoryReferenceSchema>;
export type ProactiveSafetyPolicy = z.infer<typeof proactiveSafetyPolicySchema>;
