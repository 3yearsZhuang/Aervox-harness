/**
 * Aervox｜思隅 @aervox/database — 挂起提问会话（pending_user_questions）SQLite 仓储
 *
 * 缺陷 C：UserQuestionCoordinator 的挂起提问原先只在进程内存，进程重启后内存态
 * 丢失、客户端回答 409、Turn 永久悬挂。本仓储提供持久化真源：
 * - upsert 幂等（turnId 主键，ON CONFLICT DO UPDATE 覆盖为同一次提问的最新状态）；
 * - 租户隔离（workpsace/subject 条件 + assertTenantContext）；
 * - delete 只允许删除属于本租户的行（防止跨租户驱动数据）。
 */
import { eq, and } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { pendingUserQuestions } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IUserQuestionRepository,
  PendingUserQuestionModel,
  PendingUserQuestionUpsertInput,
} from "../types.js";

type PendingRow = typeof pendingUserQuestions.$inferSelect;

const toModel = (row: PendingRow): PendingUserQuestionModel => ({
  turnId: row.turnId,
  attemptId: row.attemptId,
  step: row.step,
  questions: row.questionsJson,
  timeoutMs: row.timeoutMs,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
  workspaceId: row.workspaceId,
  subjectUserId: row.subjectUserId,
});

export class SqliteUserQuestionRepository implements IUserQuestionRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async upsertPending(tenant: TenantContext, input: PendingUserQuestionUpsertInput): Promise<void> {
    assertTenantContext(tenant);
    await this.db
      .insert(pendingUserQuestions)
      .values({
        turnId: input.turnId,
        attemptId: input.attemptId,
        step: input.step,
        questionsJson: input.questions,
        timeoutMs: input.timeoutMs,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
      })
      .onConflictDoUpdate({
        target: pendingUserQuestions.turnId,
        set: {
          attemptId: input.attemptId,
          step: input.step,
          questionsJson: input.questions,
          timeoutMs: input.timeoutMs,
          expiresAt: input.expiresAt,
          createdAt: input.createdAt,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
        },
      });
  }

  async getPending(tenant: TenantContext, turnId: string): Promise<PendingUserQuestionModel | null> {
    assertTenantContext(tenant);
    const [row] = await this.db
      .select()
      .from(pendingUserQuestions)
      .where(
        and(
          eq(pendingUserQuestions.turnId, turnId),
          eq(pendingUserQuestions.workspaceId, tenant.workspaceId),
          eq(pendingUserQuestions.subjectUserId, tenant.subjectUserId),
        ),
      );
    return row ? toModel(row) : null;
  }

  async deletePending(tenant: TenantContext, turnId: string): Promise<void> {
    assertTenantContext(tenant);
    await this.db
      .delete(pendingUserQuestions)
      .where(
        and(
          eq(pendingUserQuestions.turnId, turnId),
          eq(pendingUserQuestions.workspaceId, tenant.workspaceId),
          eq(pendingUserQuestions.subjectUserId, tenant.subjectUserId),
        ),
      );
  }
}