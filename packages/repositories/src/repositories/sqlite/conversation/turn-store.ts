/**
 * Aervox｜思隅 @aervox/repositories — Turn 生命周期与 Outbox 伴随写入 Store
 */
import { eq, and } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { turns, messageVersions, outboxEvents } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import type { TurnModel, MessageVersionModel } from "../../types/index.js";
import { notifyWorkerWakeup } from "../../../worker-ipc.js";

export class TurnStore {
  constructor(private readonly db: AervoxDatabase) {}

  async createTurnWithOutbox(
    ctx: LocalContext,
    turnData: { id: string; sessionId: string; idempotencyKey: string; status?: string },
    userMessage: { id: string; content: string },
    outboxEventData?: { id: string; eventType: string; idempotencyKey: string; payload: unknown },
  ): Promise<{ turn: TurnModel; message: MessageVersionModel }> {
    const now = new Date().toISOString();

    // 说明：此处**不得**再包一层 runWithBusyRetry。client 边界的 withBusyRetry 代理已在
    // `transaction()` 内部对 tx.execute/commit/rollback 做 busy 重试，并刻意**不重试 BEGIN**
    // （libsql@0.4.7 在 BEGIN 竞争失败后会残留语句状态，重试反而破坏后续 commit，见
    // write-retry.ts 的边界说明与 test/write-retry.test.ts 的回归用例）。若在外层再包一层，
    // 就会重新引入被禁止的 BEGIN 重试：每次尝试都会耗尽 busy_timeout（默认 5s），把同步
    // POST /v1/sessions/:id/turns 路径的最坏等待从一次 5s 放大到数十秒，并把已经损坏的
    // 连接（"SQL statements in progress"）误判为可重试的写锁竞争。
    const result = await this.db.transaction(async (tx) => {
      // 1. 插入 Turn 记录
      const [createdTurn] = await tx
        .insert(turns)
        .values({
          id: turnData.id,
          sessionId: turnData.sessionId,
          idempotencyKey: turnData.idempotencyKey,
          status: turnData.status ?? "Created",
          lastSequence: 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      // 2. 插入首条用户输入消息版本
      const [createdMessage] = await tx
        .insert(messageVersions)
        .values({
          id: userMessage.id,
          turnId: turnData.id,
          role: "user",
          version: 1,
          content: userMessage.content,
          isRedacted: 0,
          createdAt: now,
        })
        .returning();

      // 3. 伴随写入 Outbox 事件（若提供）
      if (outboxEventData) {
        await tx.insert(outboxEvents).values({
          id: outboxEventData.id,
          idempotencyKey: outboxEventData.idempotencyKey,
          eventType: outboxEventData.eventType,
          payload: outboxEventData.payload,
          status: "pending",
          createdAt: now,
        });
      }

      return {
        turn: createdTurn as TurnModel,
        message: createdMessage as MessageVersionModel,
      };
    });

    if (outboxEventData) {
      // 事务已提交后再唤醒，避免 Worker 读到未提交数据；尽力而为，失败由轮询兜底。
      void notifyWorkerWakeup("outbox");
    }

    return result;
  }

  async getTurn(ctx: LocalContext, turnId: string): Promise<TurnModel | null> {
    const [found] = await this.db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.id, turnId),
        ),
      );
    return (found as TurnModel) ?? null;
  }

  async getTurnByIdempotencyKey(
    ctx: LocalContext,
    idempotencyKey: string,
  ): Promise<TurnModel | null> {
    const [found] = await this.db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.idempotencyKey, idempotencyKey),
        ),
      );
    return (found as TurnModel) ?? null;
  }

  async updateTurnStatus(
    ctx: LocalContext,
    turnId: string,
    status: string,
    lastSequence?: number,
    error?: unknown,
  ): Promise<TurnModel | null> {
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = {
      status,
      updatedAt: now,
    };
    if (lastSequence !== undefined) {
      updateData.lastSequence = lastSequence;
    }
    if (error !== undefined) {
      updateData.error = error;
    }

    const [updated] = await this.db
      .update(turns)
      .set(updateData)
      .where(
        and(
          eq(turns.id, turnId),
        ),
      )
      .returning();
    return (updated as TurnModel) ?? null;
  }
}
