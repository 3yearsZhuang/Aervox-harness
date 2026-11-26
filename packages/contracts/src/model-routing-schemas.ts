/**
 * Aervox｜思隅 @aervox/contracts — 本地模型降级阶梯与模型路由契约 (CR-034/CR-042)
 *
 * 规则依据：CR-034（已归档至归档库）
 * 三层降级阶梯：
 * - L0: 云端模型 (full capability)
 * - L1: 本地端点 (restricted capability: 收紧敏感写工具与主动上下文边界)
 * - L2: 规则回应 (minimal capability: 确定性话术通道)
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { llmProviderTypeSchema, type LLMProviderType } from "./llm-schemas.js";
import type { LocalContext } from "./local-context.js";

extendZodWithOpenApi(z);

/** 模型能力分级等级：full (L0) -> restricted (L1) -> minimal (L2) */
export const capabilityTierSchema = z.enum(["full", "restricted", "minimal"]);

/** 降级阶梯层级 */
export const modelRoutingTierSchema = z.enum(["L0", "L1", "L2"]);

/** 健康探测状态 */
export const healthStatusSchema = z.enum(["unknown", "healthy", "degraded", "unavailable"]);

/** 探测错误分类 */
export const probeErrorCategorySchema = z.enum([
  "timeout",
  "network_error",
  "http_error",
  "auth_error",
  "unsupported_protocol",
  "unknown",
]);

/** 预设级健康快照 */
export const healthSnapshotSchema = z.object({
  presetId: z.string().min(1),
  providerType: llmProviderTypeSchema,
  endpointIdentity: z.string().min(1),
  status: healthStatusSchema,
  consecutiveSuccesses: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative().nullable(),
  lastProbeAt: z.iso.datetime().nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  lastFailureAt: z.iso.datetime().nullable(),
  errorCategory: probeErrorCategorySchema.nullable(),
  errorMessage: z.string().nullable(),
  cooldownUntil: z.iso.datetime().nullable(),
});

/** 运行时生效路由快照 */
export const modelRoutingSnapshotSchema = z.object({
  tier: modelRoutingTierSchema,
  capabilityTier: capabilityTierSchema,
  presetId: z.string().nullable(),
  presetName: z.string().nullable(),
  providerType: llmProviderTypeSchema.nullable(),
  modelId: z.string().nullable(),
  baseUrl: z.string().nullable(),
  isLocal: z.boolean(),
  localAttestation: z.boolean(),
  reason: z.string().min(1),
  configRevision: z.string().min(1),
  healthRevision: z.string().min(1),
  stickySession: z.boolean(),
  evaluatedAt: z.iso.datetime(),
});

/** 切层审计事件 */
export const modelRoutingEventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().nullable(),
  turnId: z.string().nullable(),
  fromTier: modelRoutingTierSchema,
  toTier: modelRoutingTierSchema,
  fromPresetId: z.string().nullable(),
  toPresetId: z.string().nullable(),
  reason: z.string().min(1),
  occurredAt: z.iso.datetime(),
});

/** 模型路由策略配置 */
export const modelRoutingPolicySchema = z.object({
  probeIntervalMs: z.number().int().positive().default(30_000),
  failureThreshold: z.number().int().positive().default(3),
  successThreshold: z.number().int().positive().default(2),
  probeTimeoutMs: z.number().int().positive().default(5_000),
  manualLockTier: modelRoutingTierSchema.nullable().default(null),
  autoFallbackEnabled: z.boolean().default(true),
});

export type CapabilityTier = z.infer<typeof capabilityTierSchema>;
export type ModelRoutingTier = z.infer<typeof modelRoutingTierSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type ProbeErrorCategory = z.infer<typeof probeErrorCategorySchema>;
export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;
export type ModelRoutingSnapshot = z.infer<typeof modelRoutingSnapshotSchema>;
export type ModelRoutingEvent = z.infer<typeof modelRoutingEventSchema>;
export type ModelRoutingPolicy = z.infer<typeof modelRoutingPolicySchema>;

/** 跨进程共享模型路由端口（API / Worker / Diary / Proactive 统一契约） */
export interface ModelRoutingPort {
  getRoutingSnapshot(sessionContext?: {
    sessionId?: string;
    turnId?: string;
    requireLocalOnly?: boolean;
    localContext?: LocalContext;
  }): Promise<ModelRoutingSnapshot>;
}

/** 辅助函数：根据层级映射能力等级 */
export function mapTierToCapability(tier: ModelRoutingTier): CapabilityTier {
  switch (tier) {
    case "L0":
      return "full";
    case "L1":
      return "restricted";
    case "L2":
      return "minimal";
  }
}

/**
 * 校验 URL 是否字面指向本机回环地址（CR-023/ADR-018/ADR-035）。
 *
 * 这是本仓库对该问题的唯一实现；其他模块只消费，不另写副本。判定要求协议为
 * http/https 且主机名为 localhost、127.0.0.1、::1 或 [::1] 之一，任一条件不满足
 * 即返回 false。它不发起 DNS 解析，因此回答的是「URL 字面是否指向本机」，
 * 不是「请求实际是否只到达本机」。
 */
export function isLiteralLoopbackUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}
