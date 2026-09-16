/**
 * CR-033 E2b 注意力预算与回执契约。
 *
 * 规则依据：CR-033（已归档至归档库）
 * - P4 预算化干预：全局 + 插件各持注意力预算，干预消耗、回应回升、连续忽略收缩；
 * - 预算执行权永远在内核：插件可建议参数，扣减与拦截只能由裁决器执行；
 * - reserve → dispatch → settle/refund 在同一写者事务内完成，幂等键/CAS 防并发超发；
 * - 回执只保存必要证据摘要、规则/策略版本、抑制原因、预算变化与审计引用；
 * - 静态冷却、静音时段与全局硬上限永远是安全底线，不因预算模型移除。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/** 预算与回执契约版本。 */
export const PROACTIVE_BUDGET_VERSION = "proactive_budget_v1" as const;

/** 预算作用域：全局或单插件。 */
export const budgetScopeSchema = z.enum(["global", "plugin"]);

/** 预算事务阶段（reserve → dispatch → settle/refund）。 */
export const budgetPhaseSchema = z.enum(["reserve", "dispatch", "settled", "refunded"]);

/** 反馈事件类型：来自打开、回复、忽略和操作生命周期。 */
export const proactiveFeedbackKindSchema = z.enum([
  "opened",
  "replied",
  "ignored",
  "operation_completed",
  "operation_rejected",
]);

/** 反馈事件（预算回升/收缩的输入）。 */
export const proactiveFeedbackEventSchema = z
  .object({
    id: z.string().min(1),
    actionId: z.string().min(1),
    kind: proactiveFeedbackKindSchema,
    /** 反馈权重（-1..1，负值为负反馈） */
    weight: z.number().min(-1).max(1),
    occurredAt: z.string().datetime(),
    /** 幂等键：同一反馈事件重复送达只计一次 */
    idempotencyKey: z.string().min(1),
  })
  .strict();

/**
 * 预算状态（可复现模型）。
 *
 * - budgetUnits：当前可用预算（0..maxUnits）；
 * - maxUnits：动态上限（连续忽略收缩后变小，回应后回归初始值）；
 * - consecutiveIgnores：连续忽略计数（驱动收缩）；
 * - reserveVersion：CAS 版本（并发扣减防超发）。
 */
export const proactiveBudgetStateSchema = z
  .object({
    version: z.literal(PROACTIVE_BUDGET_VERSION),
    scope: budgetScopeSchema,
    pluginId: z.string().min(1).nullable(),
    budgetUnits: z.number().int().min(0),
    maxUnits: z.number().int().min(1),
    consecutiveIgnores: z.number().int().min(0),
    reserveVersion: z.number().int().nonnegative(),
    policyVersion: z.string().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

/** 预算裁决决定（在静态裁决器决定之上叠加）。 */
export const budgetDecisionSchema = z.enum([
  "dispatch",
  "suppressed_static",
  "suppressed_budget",
  "advisory_only",
]);

/**
 * 干预回执：为什么现在提醒、引用哪些证据、消耗多少预算。
 * 只保存必要证据摘要（evidenceDigest 为摘要哈希，不是原文）。
 */
export const proactiveReceiptSchema = z
  .object({
    id: z.string().min(1),
    actionId: z.string().min(1),
    ruleId: z.string().min(1),
    pluginId: z.string().min(1).nullable(),
    decision: budgetDecisionSchema,
    suppressionReason: z.string().max(512).nullable(),
    ruleVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    /** 消息/证据摘要（哈希或简短人读摘要，不含原始敏感内容） */
    evidenceDigest: z.string().max(1024),
    budgetBefore: z.number().int().min(0),
    budgetAfter: z.number().int().min(0),
    globalBudgetAfter: z.number().int().min(0),
    /** 审计引用：关联 trigger event / 决策账本条目 */
    auditRef: z.string().min(1).nullable(),
    /** 幂等键：同一干预决策重复写入只保留一条 */
    idempotencyKey: z.string().min(1),
    issuedAt: z.string().datetime(),
  })
  .strict();

/** 预算模型参数（插件可建议，执行权在内核）。 */
export const budgetPolicySchema = z
  .object({
    initialUnits: z.number().int().min(1).max(1000).default(100),
    reserveCost: z.number().int().min(1).max(1000).default(20),
    positiveRefund: z.number().int().min(0).max(1000).default(15),
    /** 连续忽略触发收缩的阈值 */
    ignoreThreshold: z.number().int().min(1).max(100).default(3),
    /** 收缩系数（百分点，如 80 = 上限降为 80%） */
    shrinkPercent: z.number().int().min(1).max(100).default(80),
    /** 低于此值不再派发（静默） */
    minDispatchUnits: z.number().int().min(0).max(1000).default(1),
    /** advisory 模式：只观测不实际抑制（与静态裁决器 shadow 比较） */
    advisory: z.boolean().default(true),
  })
  .strict();

export const DEFAULT_BUDGET_POLICY = {
  initialUnits: 100,
  reserveCost: 20,
  positiveRefund: 15,
  ignoreThreshold: 3,
  shrinkPercent: 80,
  minDispatchUnits: 1,
  advisory: true,
} as const;

export type BudgetScope = z.infer<typeof budgetScopeSchema>;
export type BudgetPhase = z.infer<typeof budgetPhaseSchema>;
export type ProactiveFeedbackKind = z.infer<typeof proactiveFeedbackKindSchema>;
export type ProactiveFeedbackEvent = z.infer<typeof proactiveFeedbackEventSchema>;
export type ProactiveBudgetState = z.infer<typeof proactiveBudgetStateSchema>;
export type BudgetDecision = z.infer<typeof budgetDecisionSchema>;
export type ProactiveReceipt = z.infer<typeof proactiveReceiptSchema>;
export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;

/** 初始预算状态（纯函数，可复现）。 */
export function initialBudgetState(input: {
  scope: BudgetScope;
  pluginId?: string | null;
  policy?: Partial<BudgetPolicy>;
  policyVersion?: string;
  now?: string;
}): ProactiveBudgetState {
  const policy = { ...DEFAULT_BUDGET_POLICY, ...input.policy };
  return {
    version: PROACTIVE_BUDGET_VERSION,
    scope: input.scope,
    pluginId: input.pluginId ?? null,
    budgetUnits: policy.initialUnits,
    maxUnits: policy.initialUnits,
    consecutiveIgnores: 0,
    reserveVersion: 0,
    policyVersion: input.policyVersion ?? "budget-policy-v1",
    updatedAt: input.now ?? new Date().toISOString(),
  };
}

/**
 * 应用反馈事件（纯函数，可复现）。
 * - opened/replied/operation_completed：预算回升，连续忽略计数清零；
 * - ignored：连续忽略累加，达到阈值时收缩 maxUnits（budgetUnits 同步封顶）；
 * - operation_rejected：轻度负反馈（不回升）。
 */
export function applyBudgetFeedback(
  state: ProactiveBudgetState,
  feedback: ProactiveFeedbackEvent,
  policyInput?: Partial<BudgetPolicy>,
): ProactiveBudgetState {
  const policy = { ...DEFAULT_BUDGET_POLICY, ...policyInput };
  const now = feedback.occurredAt;
  if (feedback.kind === "ignored") {
    const consecutiveIgnores = state.consecutiveIgnores + 1;
    const shouldShrink = consecutiveIgnores >= policy.ignoreThreshold;
    const maxUnits = shouldShrink
      ? Math.max(1, Math.floor((state.maxUnits * policy.shrinkPercent) / 100))
      : state.maxUnits;
    return {
      ...state,
      budgetUnits: Math.min(state.budgetUnits, maxUnits),
      maxUnits,
      consecutiveIgnores,
      updatedAt: now,
    };
  }
  if (feedback.kind === "operation_rejected") {
    return { ...state, updatedAt: now };
  }
  // 正向反馈：回升（权重缩放），连续忽略清零，上限回归初始值
  const refund = Math.round(policy.positiveRefund * Math.max(0, feedback.weight));
  const restoredMaxUnits = Math.max(state.maxUnits, policy.initialUnits);
  return {
    ...state,
    budgetUnits: Math.min(restoredMaxUnits, state.budgetUnits + refund),
    consecutiveIgnores: 0,
    maxUnits: restoredMaxUnits,
    updatedAt: now,
  };
}

/**
 * 预算裁决（纯函数）：在静态裁决通过后，判断预算是否放行。
 * advisory 模式只给建议（不实际抑制），用于与 CR-032 静态裁决器 shadow 比较。
 */
export function decideByBudget(
  state: ProactiveBudgetState,
  policyInput?: Partial<BudgetPolicy>,
): { decision: BudgetDecision; budgetAfter: number; reason: string } {
  const policy = { ...DEFAULT_BUDGET_POLICY, ...policyInput };
  if (state.budgetUnits < policy.reserveCost) {
    if (policy.advisory) {
      return {
        decision: "advisory_only",
        budgetAfter: state.budgetUnits,
        reason: `budget ${state.budgetUnits} below reserve cost ${policy.reserveCost} (advisory)`,
      };
    }
    return {
      decision: "suppressed_budget",
      budgetAfter: state.budgetUnits,
      reason: `budget ${state.budgetUnits} below reserve cost ${policy.reserveCost}`,
    };
  }
  if (state.budgetUnits - policy.reserveCost < policy.minDispatchUnits && !policy.advisory) {
    return {
      decision: "suppressed_budget",
      budgetAfter: state.budgetUnits,
      reason: `post-reserve budget below minimum (${state.budgetUnits} - ${policy.reserveCost})`,
    };
  }
  return {
    decision: "dispatch",
    budgetAfter: Math.max(0, state.budgetUnits - policy.reserveCost),
    reason: `budget reserved ${policy.reserveCost} of ${state.budgetUnits}`,
  };
}
