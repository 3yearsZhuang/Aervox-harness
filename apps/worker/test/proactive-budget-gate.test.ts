/**
 * CR-033 E2b 预算化裁决组合器测试。
 *
 * 覆盖：
 * - 静态底线优先：静音时段/冷却/硬上限抑制时预算不参与；
 * - 静态放行 + 预算充足 → 派发；
 * - 静态放行 + 预算不足 → 硬抑制或 advisory 放行；
 * - 回执数据完整（预算前后值、策略版本、抑制原因）。
 */
import { describe, expect, it } from "vitest";
import { initialBudgetState, DEFAULT_BUDGET_POLICY } from "@aervox/contracts";
import { arbitrateWithBudget } from "../src/proactive/budget-gate.js";

const baseInput = {
  now: new Date("2026-09-14T10:00:00"),
  cooldownSeconds: 0,
  quietHoursPolicy: "respect_global" as const,
  globalQuietHours: { start: "22:00", end: "07:00" },
  authorized: true,
  dispatchedInWindow: 0,
  maxDispatchesPerHour: 3,
  actionId: "action_1",
  receiptPluginId: "p1",
  ruleId: "rule_1",
  ruleVersion: "proactive_dsl_v1",
  evidenceDigest: "sha256:digest",
  receiptId: "receipt_1",
  idempotencyKey: "idem_1",
  budget: initialBudgetState({ scope: "plugin", pluginId: "p1" }),
  globalBudget: initialBudgetState({ scope: "global" }),
};

describe("CR-033 E2b arbitrateWithBudget", () => {
  it("静态放行 + 预算充足 → 派发，回执记录预算扣减", () => {
    const verdict = arbitrateWithBudget({ ...baseInput, budgetPolicy: { advisory: false } });
    expect(verdict.shouldDispatch).toBe(true);
    expect(verdict.budgetDecision).toBe("dispatch");
    expect(verdict.receipt.budgetBefore).toBe(DEFAULT_BUDGET_POLICY.initialUnits);
    expect(verdict.receipt.budgetAfter).toBe(DEFAULT_BUDGET_POLICY.initialUnits - DEFAULT_BUDGET_POLICY.reserveCost);
    expect(verdict.receipt.idempotencyKey).toBe("idem_1");
  });

  it("静态抑制（静音时段）优先于预算，预算原样记录", () => {
    const verdict = arbitrateWithBudget({
      ...baseInput,
      now: new Date("2026-09-14T23:00:00"),
      budgetPolicy: { advisory: false },
    });
    expect(verdict.staticVerdict.decision).toBe("suppressed_quiet_hours");
    expect(verdict.budgetDecision).toBe("suppressed_static");
    expect(verdict.shouldDispatch).toBe(false);
    expect(verdict.receipt.suppressionReason).toContain("quiet hours");
    expect(verdict.receipt.budgetAfter).toBe(verdict.receipt.budgetBefore);
  });

  it("静态放行 + 预算不足 + 硬模式 → 预算抑制", () => {
    const verdict = arbitrateWithBudget({
      ...baseInput,
      budget: { ...baseInput.budget, budgetUnits: 5 },
      budgetPolicy: { advisory: false },
    });
    expect(verdict.shouldDispatch).toBe(false);
    expect(verdict.budgetDecision).toBe("suppressed_budget");
    expect(verdict.receipt.suppressionReason).toContain("below reserve cost");
  });

  it("全局预算不足时即使插件预算充足也必须抑制", () => {
    const verdict = arbitrateWithBudget({
      ...baseInput,
      globalBudget: { ...baseInput.globalBudget, budgetUnits: 5 },
      budgetPolicy: { advisory: false },
    });
    expect(verdict.shouldDispatch).toBe(false);
    expect(verdict.budgetDecision).toBe("suppressed_budget");
    expect(verdict.receipt.globalBudgetAfter).toBe(5);
  });

  it("静态放行 + 预算不足 + advisory → 放行但标记 advisory（shadow 比较）", () => {
    const verdict = arbitrateWithBudget({
      ...baseInput,
      budget: { ...baseInput.budget, budgetUnits: 5 },
      budgetPolicy: { advisory: true },
    });
    expect(verdict.shouldDispatch).toBe(true);
    expect(verdict.budgetDecision).toBe("advisory_only");
  });

  it("感知源未授权 fail-closed 优先于一切", () => {
    const verdict = arbitrateWithBudget({ ...baseInput, authorized: false });
    expect(verdict.staticVerdict.decision).toBe("suppressed_unauthorized");
    expect(verdict.shouldDispatch).toBe(false);
  });
});
