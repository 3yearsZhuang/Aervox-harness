/**
 * CR-033 E2b 注意力预算与回执测试。
 *
 * 覆盖：
 * - 纯函数模型：初始状态、反馈回升、连续忽略收缩、裁决（预算充足/不足/advisory）；
 * - repo：初始化幂等、CAS 扣减、余额不足拒绝、版本冲突拒绝、退款封顶、回执幂等。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  applyBudgetFeedback,
  decideByBudget,
  initialBudgetState,
  DEFAULT_BUDGET_POLICY,
  type ProactiveFeedbackEvent,
} from "@aervox/contracts";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteProactiveBudgetRepository,
  type AervoxDatabase,
} from "../src/index.js";

const tenant = { workspaceId: "ws_budget", subjectUserId: "usr_budget" } as const;

const feedback = (kind: ProactiveFeedbackEvent["kind"], weight = 1, id = "fb_1"): ProactiveFeedbackEvent => ({
  id,
  actionId: "action_1",
  kind,
  weight,
  occurredAt: "2026-09-14T05:00:00.000Z",
  idempotencyKey: `idem_${id}`,
});

describe("CR-033 E2b 预算纯函数模型", () => {
  it("初始状态：满预算、零忽略", () => {
    const state = initialBudgetState({ scope: "plugin", pluginId: "health-guard" });
    expect(state.budgetUnits).toBe(DEFAULT_BUDGET_POLICY.initialUnits);
    expect(state.consecutiveIgnores).toBe(0);
  });

  it("正向反馈回升预算并清零连续忽略", () => {
    let state = initialBudgetState({ scope: "plugin", pluginId: "p1" });
    state = { ...state, budgetUnits: 40, consecutiveIgnores: 2 };
    const next = applyBudgetFeedback(state, feedback("opened", 1));
    expect(next.budgetUnits).toBe(40 + DEFAULT_BUDGET_POLICY.positiveRefund);
    expect(next.consecutiveIgnores).toBe(0);
  });

  it("连续忽略达到阈值收缩上限", () => {
    let state = initialBudgetState({ scope: "plugin", pluginId: "p1" });
    state = { ...state, budgetUnits: 80, maxUnits: 100, consecutiveIgnores: 2 };
    const next = applyBudgetFeedback(state, feedback("ignored"));
    expect(next.consecutiveIgnores).toBe(3);
    expect(next.maxUnits).toBe(80); // 100 * 80%
    expect(next.budgetUnits).toBe(80); // 封顶
  });

  it("预算充足时裁决放行并扣减 reserve", () => {
    const state = initialBudgetState({ scope: "global" });
    const verdict = decideByBudget(state, { advisory: false });
    expect(verdict.decision).toBe("dispatch");
    expect(verdict.budgetAfter).toBe(100 - DEFAULT_BUDGET_POLICY.reserveCost);
  });

  it("预算不足时硬抑制；advisory 模式只建议", () => {
    const low = { ...initialBudgetState({ scope: "global" }), budgetUnits: 5 };
    expect(decideByBudget(low, { advisory: false }).decision).toBe("suppressed_budget");
    expect(decideByBudget(low, { advisory: true }).decision).toBe("advisory_only");
  });
});

describe("CR-033 E2b 预算 repo（CAS / 幂等）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteProactiveBudgetRepository;

  beforeEach(async () => {
    const database = await createInMemoryDatabase();
    db = database.db;
    client = database.client;
    await initDatabaseSchema(client);
    repo = new SqliteProactiveBudgetRepository(db);
  });

  it("初始化幂等：重复 getOrInit 不重复创建", async () => {
    const first = await repo.getOrInitBudget(tenant, "plugin", "health-guard");
    const second = await repo.getOrInitBudget(tenant, "plugin", "health-guard");
    expect(second.id).toBe(first.id);
    expect(second.budgetUnits).toBe(first.budgetUnits);
  });

  it("CAS 扣减成功递减余额并递增版本", async () => {
    const row = await repo.getOrInitBudget(tenant, "global", null);
    const outcome = await repo.reserveBudget(tenant, "global", null, row.reserveVersion, 20);
    expect(outcome.ok).toBe(true);
    expect(outcome.budget?.budgetUnits).toBe(80);
    expect(outcome.budget?.reserveVersion).toBe(row.reserveVersion + 1);
  });

  it("版本冲突拒绝（并发防超发）", async () => {
    const row = await repo.getOrInitBudget(tenant, "global", null);
    await repo.reserveBudget(tenant, "global", null, row.reserveVersion, 20);
    // 用旧版本再扣 → CAS 冲突
    const stale = await repo.reserveBudget(tenant, "global", null, row.reserveVersion, 20);
    expect(stale.ok).toBe(false);
    expect(stale.budget?.budgetUnits).toBe(80);
  });

  it("余额不足拒绝（不透支）", async () => {
    const row = await repo.getOrInitBudget(tenant, "plugin", "p1");
    const outcome = await repo.reserveBudget(tenant, "plugin", "p1", row.reserveVersion, row.budgetUnits + 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.budget?.budgetUnits).toBe(row.budgetUnits);
  });

  it("退款回补且封顶上限", async () => {
    const row = await repo.getOrInitBudget(tenant, "global", null);
    const reserved = await repo.reserveBudget(tenant, "global", null, row.reserveVersion, 20);
    const refunded = await repo.refundBudget(tenant, "global", null, reserved.budget!.reserveVersion, 500);
    expect(refunded.ok).toBe(true);
    expect(refunded.budget?.budgetUnits).toBe(100); // maxUnits 封顶
  });

  it("全局与插件预算同一事务原子预留并原子退款", async () => {
    const global = await repo.getOrInitBudget(tenant, "global", null);
    const plugin = await repo.getOrInitBudget(tenant, "plugin", "p-pair");
    const reserved = await repo.reserveBudgetPair(tenant, "p-pair", {
      globalVersion: global.reserveVersion,
      pluginVersion: plugin.reserveVersion,
    }, 20);
    expect(reserved).toMatchObject({
      ok: true,
      globalBudget: {budgetUnits: 80, reserveVersion: 1},
      pluginBudget: {budgetUnits: 80, reserveVersion: 1},
    });
    const refunded = await repo.refundBudgetPair(tenant, "p-pair", {
      globalVersion: reserved.globalBudget!.reserveVersion,
      pluginVersion: reserved.pluginBudget!.reserveVersion,
    }, 20);
    expect(refunded).toMatchObject({
      ok: true,
      globalBudget: {budgetUnits: 100, reserveVersion: 2},
      pluginBudget: {budgetUnits: 100, reserveVersion: 2},
    });
  });

  it("双预算任一 CAS 冲突时全部回滚", async () => {
    const global = await repo.getOrInitBudget(tenant, "global", null);
    const plugin = await repo.getOrInitBudget(tenant, "plugin", "p-rollback");
    const failed = await repo.reserveBudgetPair(tenant, "p-rollback", {
      globalVersion: global.reserveVersion + 1,
      pluginVersion: plugin.reserveVersion,
    }, 20);
    expect(failed.ok).toBe(false);
    expect(failed.globalBudget?.budgetUnits).toBe(100);
    expect(failed.pluginBudget?.budgetUnits).toBe(100);
  });

  it("反馈应用：忽略收缩持久化", async () => {
    await repo.getOrInitBudget(tenant, "plugin", "p2", { ignoreThreshold: 1 });
    const result = await repo.applyFeedback(tenant, "plugin", "p2", feedback("ignored"), { ignoreThreshold: 1 });
    const row = result as Awaited<ReturnType<SqliteProactiveBudgetRepository["getOrInitBudget"]>>;
    expect(row.maxUnits).toBe(80);
  });

  it("反馈幂等：重复事件只影响预算一次", async () => {
    await repo.getOrInitBudget(tenant, "plugin", "p3", { ignoreThreshold: 1 });
    const event = feedback("ignored", 1, "fb_idempotent");
    const first = await repo.applyFeedback(tenant, "plugin", "p3", event, { ignoreThreshold: 1 });
    const second = await repo.applyFeedback(tenant, "plugin", "p3", event, { ignoreThreshold: 1 });
    expect((first as { maxUnits: number }).maxUnits).toBe(80);
    expect((second as { maxUnits: number }).maxUnits).toBe(80);
  });

  it("回执幂等：同幂等键重复写入只保留一条", async () => {
    const base = {
      id: "receipt_1",
      actionId: "action_1",
      ruleId: "rule_1",
      pluginId: "p1",
      decision: "dispatch" as const,
      suppressionReason: null,
      ruleVersion: "proactive_dsl_v1",
      policyVersion: "budget-policy-v1",
      evidenceDigest: "sha256:abc",
      budgetBefore: 100,
      budgetAfter: 80,
      globalBudgetAfter: 80,
      auditRef: "trigger_event_1",
      idempotencyKey: "idem_receipt_1",
      issuedAt: "2026-09-14T05:00:00.000Z",
    };
    const first = await repo.saveReceipt(tenant, base);
    const second = await repo.saveReceipt(tenant, { ...base, budgetAfter: 999 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.receipt.budgetAfter).toBe(80);
    const listed = await repo.listReceiptsByAction(tenant, "action_1");
    expect(listed).toHaveLength(1);
  });
});
