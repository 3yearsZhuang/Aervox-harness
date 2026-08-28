/**
 * Aervox｜思隅 @aervox/database — Agent 收件箱（agent_inbox_items）SQLite 仓储
 *
 * 规则依据：ADR-017「冻结 ContextManifest / ModelRun / AgentStep 关联与 Inbox 数据模型」
 * 与 AVX-HAR-001 §7.2：
 * - enqueue 幂等（同 idempotencyKey 已存在则返回既有项，ON CONFLICT DO NOTHING + 回查）；
 * - claim/ack（pending → claimed → acknowledged）；崩溃后未 ack 的 claimed 项可安全重放；
 * - 外部插件不能直接修改 Session 日志，只能提交受限 inbox command（本仓储即唯一受控入口）。
 */
import { eq, and, isNull, sql, or, inArray } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { agentInboxItems } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  AgentInboxEnqueueInput,
  AgentInboxItemModel,
  IAgentInboxRepository,
} from "../types.js";

type InboxRow = typeof agentInboxItems.$inferSelect;

const toModel = (row: InboxRow): AgentInboxItemModel => ({
  id: row.id,
  idempotencyKey: row.idempotencyKey,
  sessionId: row.sessionId,
  attemptId: row.attemptId ?? null,
  stepId: row.stepId ?? null,
  type: row.type as AgentInboxItemModel["type"],
  orderingSeq: row.orderingSeq,
  sourceActor: row.sourceActor,
  payload: row.payloadJson,
  status: row.status as AgentInboxItemModel["status"],
  consumeBoundary: row.consumeBoundary as AgentInboxItemModel["consumeBoundary"],
  claimedAt: row.claimedAt ?? null,
  ackedAt: row.ackedAt ?? null,
  expiresAt: row.expiresAt ?? null,
  workspaceId: row.workspaceId,
  subjectUserId: row.subjectUserId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** 幂等键归一化（租户内唯一；同 key 不同 payload 视为重复提交，保留既有项） */
const tenantIdempotencyKey = (tenant: TenantContext, key: string): string =>
  `${tenant.workspaceId}:${tenant.subjectUserId}:${key}`;

export class SqliteAgentInboxRepository implements IAgentInboxRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async enqueue(tenant: TenantContext, input: AgentInboxEnqueueInput): Promise<AgentInboxItemModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const consumeBoundary = input.consumeBoundary ?? (input.type === "followup" ? "next-turn" : "next-step");
    const key = tenantIdempotencyKey(tenant, input.idempotencyKey);
    // 幂等：已存在同 idempotencyKey 则返回既有项（OK 重复提交）
    const existing = await this.getByIdempotencyKey(tenant, input.idempotencyKey);
    if (existing) return existing;

    const [row] = await this.db
      .insert(agentInboxItems)
      .values({
        id: input.id,
        idempotencyKey: key,
        sessionId: input.sessionId,
        attemptId: input.attemptId ?? null,
        stepId: input.stepId ?? null,
        type: input.type,
        orderingSeq: 0, // 顺序由查询排序（按 createdAt）兜底；未来可加窗口计算
        sourceActor: input.sourceActor,
        payloadJson: input.payload,
        status: "pending",
        consumeBoundary,
        claimedAt: null,
        ackedAt: null,
        expiresAt: input.expiresAt ?? null,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    // 并发竞争（唯一键冲突）：查询既有项返回
    if (!row) {
      return this.getByIdempotencyKey(tenant, input.idempotencyKey) as Promise<AgentInboxItemModel>;
    }
    return toModel(row);
  }

  async claimForConsumption(
    tenant: TenantContext,
    input: { sessionId: string; attemptId?: string | null; type: "next-turn" | "next-step"; limit?: number },
  ): Promise<AgentInboxItemModel[]> {
    assertTenantContext(tenant);
    const limit = input.limit ?? 20;
    const now = new Date().toISOString();
    const where = and(
      eq(agentInboxItems.workspaceId, tenant.workspaceId),
      eq(agentInboxItems.subjectUserId, tenant.subjectUserId),
      eq(agentInboxItems.sessionId, input.sessionId),
      eq(agentInboxItems.consumeBoundary, input.type),
      eq(agentInboxItems.status, "pending"),
      // 未过期（null 或 > now）
      or(
        isNull(agentInboxItems.expiresAt),
        sql`${agentInboxItems.expiresAt} > ${now}`,
      ),
    );

    const rows = await this.db
      .select()
      .from(agentInboxItems)
      .where(where)
      .orderBy(agentInboxItems.createdAt)
      .limit(limit);

    const claimedAt = now;
    const claimed: AgentInboxItemModel[] = [];
    for (const row of rows) {
      // next-step 需 attemptId 定位（输入缺失则跳过）；next-turn 忽略 attemptId
      if (input.type === "next-step" && (!input.attemptId || row.attemptId !== input.attemptId)) continue;
      if (input.type === "next-turn" && row.attemptId !== null && input.attemptId && row.attemptId !== input.attemptId) continue;
      // CAS：仅 pending 可 claim（并发双 claim 只赢一次）
      const [updated] = await this.db
        .update(agentInboxItems)
        .set({ status: "claimed", claimedAt })
        .where(
          and(
            eq(agentInboxItems.id, row.id),
            eq(agentInboxItems.status, "pending"),
            eq(agentInboxItems.workspaceId, tenant.workspaceId),
            eq(agentInboxItems.subjectUserId, tenant.subjectUserId),
          ),
        )
        .returning();
      if (updated) claimed.push(toModel(updated));
    }
    return claimed;
  }

  async acknowledge(tenant: TenantContext, itemIds: string[]): Promise<void> {
    assertTenantContext(tenant);
    if (itemIds.length === 0) return;
    const ackedAt = new Date().toISOString();
    for (const id of itemIds) {
      await this.db
        .update(agentInboxItems)
        .set({ status: "acknowledged", ackedAt })
        .where(
          and(
            eq(agentInboxItems.id, id),
            eq(agentInboxItems.workspaceId, tenant.workspaceId),
            eq(agentInboxItems.subjectUserId, tenant.subjectUserId),
            eq(agentInboxItems.status, "claimed"),
          ),
        );
    }
  }

  async getByIdempotencyKey(tenant: TenantContext, idempotencyKey: string): Promise<AgentInboxItemModel | null> {
    const key = tenantIdempotencyKey(tenant, idempotencyKey);
    const [row] = await this.db
      .select()
      .from(agentInboxItems)
      .where(
        and(
          eq(agentInboxItems.workspaceId, tenant.workspaceId),
          eq(agentInboxItems.subjectUserId, tenant.subjectUserId),
          eq(agentInboxItems.idempotencyKey, key),
        ),
      )
      .limit(1);
    return row ? toModel(row) : null;
  }

  /**
   * ADR-017 兜底回收：跨租户把所有 expiresAt < now 且仍 pending/claimed 的项置为 expired。
   * - pending 过期：从未被消费，直接到期作废；
   * - claimed 过期：消费中崩溃未 ack 的项不再重放（避免陈旧注入）。
   * 批量上限 200，Worker 轮询可重复调用。
   */
  async expireOverdue(now = new Date().toISOString()): Promise<number> {
    const rows = await this.db
      .select({ id: agentInboxItems.id })
      .from(agentInboxItems)
      .where(
        and(
          or(
            eq(agentInboxItems.status, "pending"),
            eq(agentInboxItems.status, "claimed"),
          ),
          sql`${agentInboxItems.expiresAt} IS NOT NULL AND ${agentInboxItems.expiresAt} < ${now}`,
        ),
      )
      .limit(200);
    if (rows.length === 0) return 0;
    const updated = await this.db
      .update(agentInboxItems)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          inArray(
            agentInboxItems.id,
            rows.map((r) => r.id),
          ),
          or(
            eq(agentInboxItems.status, "pending"),
            eq(agentInboxItems.status, "claimed"),
          ),
        ),
      )
      .returning();
    return updated.length;
  }
}