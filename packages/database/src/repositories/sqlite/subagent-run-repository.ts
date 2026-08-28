/**
 * Aervox｜思隅 @aervox/database — Subagent 运行关联（subagent_runs）SQLite 仓储
 *
 * 规则依据：AVX-HAR-001 §13 阶段 5c + ADR-017：高级能力经扩展点接入，不改 Loop 核心；
 * 子任务以独立 turn/attempt 落库审计，本表承载父子溯源与结果摘要：
 * - createRun 幂等：tenant + parentAttemptId + parentExecutionId 唯一（Host 幂等键语义），
 *   崩溃/重试回查既有行，不重复创建子任务；
 * - finalizeRun 仅 Running 可收口终态（CAS 式状态推进，防并发重复收口）；
 * - 查询一律绑定租户（assertTenantContext + workspace/subject 条件）。
 */
import { eq, and } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { subagentRuns } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  ISubagentRunRepository,
  SubagentRunCreateInput,
  SubagentRunModel,
} from "../types.js";

type RunRow = typeof subagentRuns.$inferSelect;

const toModel = (row: RunRow): SubagentRunModel => ({
  id: row.id,
  sessionId: row.sessionId,
  parentTurnId: row.parentTurnId,
  parentAttemptId: row.parentAttemptId,
  parentExecutionId: row.parentExecutionId,
  subTurnId: row.subTurnId,
  subAttemptId: row.subAttemptId,
  task: row.task,
  toolScope: row.toolScopeJson ?? null,
  status: row.status,
  resultText: row.resultText ?? null,
  error: row.error ?? null,
  finishedAt: row.finishedAt ?? null,
  workspaceId: row.workspaceId,
  subjectUserId: row.subjectUserId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class SqliteSubagentRunRepository implements ISubagentRunRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async createRun(tenant: TenantContext, input: SubagentRunCreateInput): Promise<SubagentRunModel> {
    assertTenantContext(tenant);
    const existing = await this.getRunByParentExecution(tenant, input.parentAttemptId, input.parentExecutionId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const [row] = await this.db
      .insert(subagentRuns)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        parentTurnId: input.parentTurnId,
        parentAttemptId: input.parentAttemptId,
        parentExecutionId: input.parentExecutionId,
        subTurnId: input.subTurnId,
        subAttemptId: input.subAttemptId,
        task: input.task,
        toolScopeJson: input.toolScope ?? null,
        status: "Running",
        resultText: null,
        error: null,
        finishedAt: null,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) {
      return this.getRunByParentExecution(tenant, input.parentAttemptId, input.parentExecutionId) as Promise<SubagentRunModel>;
    }
    return toModel(row);
  }

  async finalizeRun(
    tenant: TenantContext,
    runId: string,
    input: { status: string; resultText?: string | null; error?: string | null },
  ): Promise<SubagentRunModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [row] = await this.db
      .update(subagentRuns)
      .set({
        status: input.status,
        resultText: input.resultText ?? null,
        error: input.error ?? null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(subagentRuns.id, runId),
          eq(subagentRuns.workspaceId, tenant.workspaceId),
          eq(subagentRuns.subjectUserId, tenant.subjectUserId),
          eq(subagentRuns.status, "Running"),
        ),
      )
      .returning();
    return row ? toModel(row) : null;
  }

  async getRunByParentExecution(
    tenant: TenantContext,
    parentAttemptId: string,
    parentExecutionId: string,
  ): Promise<SubagentRunModel | null> {
    assertTenantContext(tenant);
    const [row] = await this.db
      .select()
      .from(subagentRuns)
      .where(
        and(
          eq(subagentRuns.workspaceId, tenant.workspaceId),
          eq(subagentRuns.subjectUserId, tenant.subjectUserId),
          eq(subagentRuns.parentAttemptId, parentAttemptId),
          eq(subagentRuns.parentExecutionId, parentExecutionId),
        ),
      )
      .limit(1);
    return row ? toModel(row) : null;
  }

  async listRunsByTurn(tenant: TenantContext, parentTurnId: string): Promise<SubagentRunModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(subagentRuns)
      .where(
        and(
          eq(subagentRuns.workspaceId, tenant.workspaceId),
          eq(subagentRuns.subjectUserId, tenant.subjectUserId),
          eq(subagentRuns.parentTurnId, parentTurnId),
        ),
      )
      .orderBy(subagentRuns.createdAt);
    return rows.map(toModel);
  }
}