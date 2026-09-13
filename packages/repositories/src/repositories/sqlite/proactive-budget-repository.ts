/**
 * CR-033 E2b 注意力预算与回执 Port。
 *
 * 规则依据：docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
 * - 预算扣减、派发、结算和失败退款在同一写者事务内完成；
 * - reserve 使用 CAS（reserveVersion 比对 + 单条原子 UPDATE）防止并发超发；
 * - 回执追加式账本：仅内核写入，幂等键防重复；
 * - 预算模型纯函数（applyBudgetFeedback/decideByBudget）在 @aervox/contracts。
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  proactiveAttentionBudgets,
  proactiveInterventionReceipts,
} from "@aervox/schema";
import {
  applyBudgetFeedback,
  initialBudgetState,
  DEFAULT_BUDGET_POLICY,
  type BudgetPolicy,
  type BudgetScope,
  type ProactiveBudgetState,
  type ProactiveFeedbackEvent,
  type ProactiveReceipt,
} from "@aervox/contracts";
import type { LocalContext } from "../../local-context.js";

export interface BudgetRow {
  id: string;
  scope: string;
  pluginId: string | null;
  budgetUnits: number;
  maxUnits: number;
  consecutiveIgnores: number;
  reserveVersion: number;
  policyVersion: string;
  updatedAt: string;
}

export interface ReserveOutcome {
  ok: boolean;
  budget: BudgetRow | null;
  reason?: string;
}

function budgetIdOf(scope: BudgetScope, pluginId: string | null): string {
  return scope === "global" ? "budget_global" : `budget_plugin_${pluginId}`;
}

function rowToState(row: BudgetRow): ProactiveBudgetState {
  return {
    version: "proactive_budget_v1",
    scope: row.scope as BudgetScope,
    pluginId: row.pluginId,
    budgetUnits: row.budgetUnits,
    maxUnits: row.maxUnits,
    consecutiveIgnores: row.consecutiveIgnores,
    reserveVersion: row.reserveVersion,
    policyVersion: row.policyVersion,
    updatedAt: row.updatedAt,
  };
}

function stateToRowPatch(state: ProactiveBudgetState) {
  return {
    budgetUnits: state.budgetUnits,
    maxUnits: state.maxUnits,
    consecutiveIgnores: state.consecutiveIgnores,
    policyVersion: state.policyVersion,
    updatedAt: state.updatedAt,
  };
}

export class SqliteProactiveBudgetRepository {
  constructor(private readonly db: AervoxDatabase) {}

  /** 读取或初始化预算行（幂等；不存在时按初始状态创建）。 */
  async getOrInitBudget(
    _tenant: LocalContext,
    scope: BudgetScope,
    pluginId: string | null,
    policy?: Partial<BudgetPolicy>,
  ): Promise<BudgetRow> {
    const id = budgetIdOf(scope, pluginId);
    const [existing] = await this.db
      .select()
      .from(proactiveAttentionBudgets)
      .where(eq(proactiveAttentionBudgets.id, id))
      .limit(1);
    if (existing) return this.toRow(existing);

    const state = initialBudgetState({ scope, pluginId, policy });
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(proactiveAttentionBudgets)
      .values({
        id,
        scope,
        pluginId,
        budgetUnits: state.budgetUnits,
        maxUnits: state.maxUnits,
        consecutiveIgnores: 0,
        reserveVersion: 0,
        policyVersion: state.policyVersion,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return this.toRow(created);
    // 并发初始化兜底：重读
    const [reread] = await this.db
      .select()
      .from(proactiveAttentionBudgets)
      .where(eq(proactiveAttentionBudgets.id, id))
      .limit(1);
    return this.toRow(reread!);
  }

  /**
   * CAS 预算扣减（reserve）：单条原子 UPDATE，版本比对 + 余额下限双条件。
   * 并发争用或余额不足时返回 ok=false（不重试、不超发）。
   */
  async reserveBudget(
    _tenant: LocalContext,
    scope: BudgetScope,
    pluginId: string | null,
    expectedVersion: number,
    cost: number,
  ): Promise<ReserveOutcome> {
    const id = budgetIdOf(scope, pluginId);
    const updated = await this.db
      .update(proactiveAttentionBudgets)
      .set({
        budgetUnits: sql`${proactiveAttentionBudgets.budgetUnits} - ${cost}`,
        reserveVersion: sql`${proactiveAttentionBudgets.reserveVersion} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(proactiveAttentionBudgets.id, id),
        eq(proactiveAttentionBudgets.reserveVersion, expectedVersion),
        sql`${proactiveAttentionBudgets.budgetUnits} >= ${cost}`,
      ))
      .returning();
    if (updated.length === 0) {
      const [current] = await this.db
        .select()
        .from(proactiveAttentionBudgets)
        .where(eq(proactiveAttentionBudgets.id, id))
        .limit(1);
      return {
        ok: false,
        budget: current ? this.toRow(current) : null,
        reason: current
          ? `cas conflict (expected version ${expectedVersion}, actual ${current.reserveVersion}) or insufficient balance`
          : "budget row missing",
      };
    }
    return { ok: true, budget: this.toRow(updated[0]!) };
  }

  /** 失败退款（refund）：回补预算（上限封顶），版本递增。 */
  async refundBudget(
    _tenant: LocalContext,
    scope: BudgetScope,
    pluginId: string | null,
    expectedVersion: number,
    amount: number,
  ): Promise<ReserveOutcome> {
    const id = budgetIdOf(scope, pluginId);
    const updated = await this.db
      .update(proactiveAttentionBudgets)
      .set({
        budgetUnits: sql`MIN(${proactiveAttentionBudgets.maxUnits}, ${proactiveAttentionBudgets.budgetUnits} + ${amount})`,
        reserveVersion: sql`${proactiveAttentionBudgets.reserveVersion} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(proactiveAttentionBudgets.id, id),
        eq(proactiveAttentionBudgets.reserveVersion, expectedVersion),
      ))
      .returning();
    if (updated.length === 0) {
      return { ok: false, budget: null, reason: `cas conflict on refund (expected ${expectedVersion})` };
    }
    return { ok: true, budget: this.toRow(updated[0]!) };
  }

  /** 应用反馈事件（读-改-写，CAS 重试至多 3 次）。 */
  async applyFeedback(
    tenant: LocalContext,
    scope: BudgetScope,
    pluginId: string | null,
    feedback: ProactiveFeedbackEvent,
    policy?: Partial<BudgetPolicy>,
  ): Promise<BudgetRow | ReserveOutcome> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await this.getOrInitBudget(tenant, scope, pluginId, policy);
      const state = rowToState(row);
      const next = applyBudgetFeedback(state, feedback, policy ?? DEFAULT_BUDGET_POLICY);
      const id = budgetIdOf(scope, pluginId);
      const updated = await this.db
        .update(proactiveAttentionBudgets)
        .set({ ...stateToRowPatch(next), reserveVersion: sql`${proactiveAttentionBudgets.reserveVersion} + 1` })
        .where(and(
          eq(proactiveAttentionBudgets.id, id),
          eq(proactiveAttentionBudgets.reserveVersion, row.reserveVersion),
        ))
        .returning();
      if (updated.length > 0) return this.toRow(updated[0]!);
    }
    return { ok: false, budget: null, reason: "feedback cas retries exhausted" };
  }

  /** 幂等写入干预回执（追加式账本；重复幂等键返回既有记录）。 */
  async saveReceipt(_tenant: LocalContext, receipt: ProactiveReceipt): Promise<{created: boolean; receipt: ProactiveReceipt}> {
    const [existing] = await this.db
      .select()
      .from(proactiveInterventionReceipts)
      .where(eq(proactiveInterventionReceipts.idempotencyKey, receipt.idempotencyKey))
      .limit(1);
    if (existing) return { created: false, receipt: this.receiptModel(existing) };

    const [created] = await this.db
      .insert(proactiveInterventionReceipts)
      .values({
        id: receipt.id,
        actionId: receipt.actionId,
        ruleId: receipt.ruleId,
        pluginId: receipt.pluginId,
        decision: receipt.decision,
        suppressionReason: receipt.suppressionReason,
        ruleVersion: receipt.ruleVersion,
        policyVersion: receipt.policyVersion,
        evidenceDigest: receipt.evidenceDigest,
        budgetBefore: receipt.budgetBefore,
        budgetAfter: receipt.budgetAfter,
        globalBudgetAfter: receipt.globalBudgetAfter,
        auditRef: receipt.auditRef,
        idempotencyKey: receipt.idempotencyKey,
        issuedAt: receipt.issuedAt,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .returning();
    if (created) return { created: true, receipt: this.receiptModel(created) };
    const [reread] = await this.db
      .select()
      .from(proactiveInterventionReceipts)
      .where(eq(proactiveInterventionReceipts.idempotencyKey, receipt.idempotencyKey))
      .limit(1);
    return { created: false, receipt: this.receiptModel(reread!) };
  }

  /** 按动作查回执（用户可完整追溯"它为什么做这个决定"）。 */
  async listReceiptsByAction(_tenant: LocalContext, actionId: string): Promise<ProactiveReceipt[]> {
    const rows = await this.db
      .select()
      .from(proactiveInterventionReceipts)
      .where(eq(proactiveInterventionReceipts.actionId, actionId))
      .orderBy(desc(proactiveInterventionReceipts.issuedAt))
      .limit(100);
    return rows.map((row) => this.receiptModel(row));
  }

  private toRow(row: typeof proactiveAttentionBudgets.$inferSelect): BudgetRow {
    return {
      id: row.id,
      scope: row.scope,
      pluginId: row.pluginId,
      budgetUnits: row.budgetUnits,
      maxUnits: row.maxUnits,
      consecutiveIgnores: row.consecutiveIgnores,
      reserveVersion: row.reserveVersion,
      policyVersion: row.policyVersion,
      updatedAt: row.updatedAt,
    };
  }

  private receiptModel(row: typeof proactiveInterventionReceipts.$inferSelect): ProactiveReceipt {
    return {
      id: row.id,
      actionId: row.actionId,
      ruleId: row.ruleId,
      pluginId: row.pluginId,
      decision: row.decision as ProactiveReceipt["decision"],
      suppressionReason: row.suppressionReason,
      ruleVersion: row.ruleVersion,
      policyVersion: row.policyVersion,
      evidenceDigest: row.evidenceDigest,
      budgetBefore: row.budgetBefore,
      budgetAfter: row.budgetAfter,
      globalBudgetAfter: row.globalBudgetAfter,
      auditRef: row.auditRef,
      idempotencyKey: row.idempotencyKey,
      issuedAt: row.issuedAt,
    };
  }
}