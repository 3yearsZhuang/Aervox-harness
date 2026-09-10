/**
 * Aervox｜思隅 @aervox/database — 挂起提问会话（pending_user_questions）SQLite 仓储
 *
 * 缺陷 C：UserQuestionCoordinator 的挂起提问原先只在进程内存，进程重启后内存态
 * 丢失、客户端回答 409、Turn 永久悬挂。本仓储提供持久化真源：
 * - upsert 幂等（turnId 主键，ON CONFLICT DO UPDATE 覆盖为同一次提问的最新状态）；
 * - turnId 主键保证本地实例内幂等；数据库不再承载租户条件。
 */
import { eq, and } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { pendingUserQuestions } from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";
import type {
  IUserQuestionRepository,
  PendingUserQuestionModel,
  PendingUserQuestionUpsertInput,
} from "../types/index.js";

type PendingRow = typeof pendingUserQuestions.$inferSelect;

const toModel = (row: PendingRow): PendingUserQuestionModel => ({
  turnId: row.turnId,
  attemptId: row.attemptId,
  step: row.step,
  questions: row.questionsJson,
  timeoutMs: row.timeoutMs,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
});

export class SqliteUserQuestionRepository implements IUserQuestionRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async upsertPending(tenant: LocalContext, input: PendingUserQuestionUpsertInput): Promise<void> {
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
        },
      });
  }

  async getPending(tenant: LocalContext, turnId: string): Promise<PendingUserQuestionModel | null> {
    const [row] = await this.db
      .select()
      .from(pendingUserQuestions)
      .where(
        and(
          eq(pendingUserQuestions.turnId, turnId),
        ),
      );
    return row ? toModel(row) : null;
  }

  async deletePending(tenant: LocalContext, turnId: string): Promise<void> {
    await this.db
      .delete(pendingUserQuestions)
      .where(
        and(
          eq(pendingUserQuestions.turnId, turnId),
        ),
      );
  }
}
