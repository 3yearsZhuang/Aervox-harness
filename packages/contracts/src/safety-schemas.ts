/**
 * Aervox｜思隅 @aervox/contracts — 安全与危机干预契约模式
 *
 * 规则依据：PRD §4.3、§6.5、SRS FR-SAFE-001、AI_QUALITY_SAFETY.md §7。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/** 安全风险等级 */
export const safetyRiskLevelSchema = z.enum([
  "crisis_high",
  "distress_moderate",
  "safe_normal",
]);
export type SafetyRiskLevel = z.infer<typeof safetyRiskLevelSchema>;

/** 安全分类类别 */
export const safetyCategorySchema = z.enum([
  "self_harm",
  "violence",
  "crisis",
  "burnout_distress",
  "normal",
]);
export type SafetyCategory = z.infer<typeof safetyCategorySchema>;

/** 安全事件处置方式 */
export const safetyDispositionSchema = z.enum([
  "blocked",
  "escalated",
  "guided",
  "logged",
  "monitored",
]);
export type SafetyDisposition = z.infer<typeof safetyDispositionSchema>;

/** 地区化求助热线资源 */
export const regionalHelplineSchema = z.object({
  name: z.string(),
  phone: z.string(),
  region: z.string(),
  description: z.string(),
  hours: z.string(),
});
export type RegionalHelpline = z.infer<typeof regionalHelplineSchema>;

/** 安全分类结果 */
export const safetyClassificationResultSchema = z.object({
  level: safetyRiskLevelSchema,
  category: safetyCategorySchema,
  matchedPatterns: z.array(z.string()).optional(),
  suggestedAction: z.enum(["crisis_intervention", "distress_guidance", "pass"]),
});
export type SafetyClassificationResult = z.infer<typeof safetyClassificationResultSchema>;

/** 安全事件记录实体 */
export const safetyIncidentSchema = z.object({
  id: z.string(),
  category: z.string(),
  severity: z.string(),
  disposition: z.string(),
  policyVersion: z.string(),
  createdAt: z.string(),
});
export type SafetyIncident = z.infer<typeof safetyIncidentSchema>;

/** 安全危机资源响应 */
export const safetyResourcesResponseSchema = z.object({
  policyVersion: z.string(),
  helplines: z.array(regionalHelplineSchema),
});
export type SafetyResourcesResponse = z.infer<typeof safetyResourcesResponseSchema>;
