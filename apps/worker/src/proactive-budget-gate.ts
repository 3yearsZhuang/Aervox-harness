/**
 * CR-033 E2b 预算化裁决组合器。
 *
 * 规则依据：docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
 * - 静态冷却、静音时段和全局硬上限永远是安全底线：静态裁决（arbitrate）先行，
 *   预算裁决只在静态放行后叠加；
 * - advisory 模式与 CR-032 静态裁决器 shadow 比较（只观测不实际抑制）；
 * - 每次裁决产出回执数据（决策、抑制原因、预算前后值、策略版本）。
 */
import {
  decideByBudget,
  DEFAULT_BUDGET_POLICY,
  type BudgetDecision,
  type BudgetPolicy,
  type ProactiveBudgetState,
  type ProactiveReceipt,
} from "@aervox/contracts";
import {
  arbitrate,
  type ArbitrationInput,
  type ArbitrationVerdict,
} from "./proactive-arbitrator.js";

export interface BudgetGateInput extends ArbitrationInput {
  /** 插件（或全局）预算当前状态 */
  budget: ProactiveBudgetState;
  /** 全局预算当前状态 */
  globalBudget: ProactiveBudgetState;
  budgetPolicy?: Partial<BudgetPolicy>;
  /** 回执关联字段 */
  actionId: string;
  /** 回执归属插件；内置规则必须显式传 null，预算主体仍可使用 builtin。 */
  receiptPluginId: string | null;
  ruleId: string;
  ruleVersion: string;
  evidenceDigest: string;
  auditRef?: string | null;
  /** 回执 id（调用方生成，如 receipt_<hash>） */
  receiptId: string;
  /** 回执幂等键（同决策重复裁决只留一条） */
  idempotencyKey: string;
}

export interface BudgetGateVerdict {
  /** 静态裁决结果（安全底线，不受预算影响） */
  staticVerdict: ArbitrationVerdict;
  /** 预算裁决结果（静态放行后才有意义） */
  budgetDecision: BudgetDecision;
  /** 最终是否派发：静态放行 且 （预算放行 或 advisory） */
  shouldDispatch: boolean;
  reason: string;
  /** 回执数据（落账本用） */
  receipt: ProactiveReceipt;
}

/**
 * 组合裁决：授权 → 冷却 → 静音 → 硬上限（CR-032 底线）→ 注意力预算（E2b 增量）。
 * 纯函数：不触库；预算扣减由调用方在拿到 shouldDispatch 后经 repo CAS 执行。
 */
export function arbitrateWithBudget(input: BudgetGateInput): BudgetGateVerdict {
  const policy = { ...DEFAULT_BUDGET_POLICY, ...input.budgetPolicy };
  const staticVerdict = arbitrate(input);

  const buildReceipt = (
    decision: BudgetDecision,
    suppressionReason: string | null,
    budgetAfter: number,
    globalBudgetAfter = input.globalBudget.budgetUnits,
  ): ProactiveReceipt => ({
    id: input.receiptId,
    actionId: input.actionId,
    ruleId: input.ruleId,
    pluginId: input.receiptPluginId,
    decision,
    suppressionReason,
    ruleVersion: input.ruleVersion,
    policyVersion: input.budget.policyVersion,
    evidenceDigest: input.evidenceDigest,
    budgetBefore: input.budget.budgetUnits,
    budgetAfter,
    globalBudgetAfter,
    auditRef: input.auditRef ?? null,
    idempotencyKey: input.idempotencyKey,
    issuedAt: input.now.toISOString(),
  });

  // 静态裁决未放行：安全底线优先，预算原样记录
  if (staticVerdict.decision !== "dispatch") {
    return {
      staticVerdict,
      budgetDecision: "suppressed_static",
      shouldDispatch: false,
      reason: staticVerdict.reason,
      receipt: buildReceipt("suppressed_static", staticVerdict.reason, input.budget.budgetUnits),
    };
  }

  // 静态放行 → 插件预算与全局预算必须同时通过。
  const budgetVerdict = decideByBudget(input.budget, policy);
  const globalBudgetVerdict = decideByBudget(input.globalBudget, policy);
  const suppressedVerdict = budgetVerdict.decision === "suppressed_budget"
    ? budgetVerdict
    : globalBudgetVerdict.decision === "suppressed_budget"
      ? globalBudgetVerdict
      : null;
  const advisory = budgetVerdict.decision === "advisory_only" ||
    globalBudgetVerdict.decision === "advisory_only";
  const decision: BudgetDecision = suppressedVerdict
    ? "suppressed_budget"
    : advisory
      ? "advisory_only"
      : "dispatch";
  const shouldDispatch = decision !== "suppressed_budget";
  const reason = suppressedVerdict
    ? suppressedVerdict.reason
    : `${staticVerdict.reason}; plugin: ${budgetVerdict.reason}; global: ${globalBudgetVerdict.reason}`;

  return {
    staticVerdict,
    budgetDecision: decision,
    shouldDispatch,
    reason,
    receipt: buildReceipt(
      decision,
      suppressedVerdict?.reason ?? null,
      budgetVerdict.budgetAfter,
      globalBudgetVerdict.budgetAfter,
    ),
  };
}
