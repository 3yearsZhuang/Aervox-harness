/**
 * Aervox｜思隅 @aervox/repositories — Turn 生命周期与 Outbox 伴随写入 Store
 */
import { eq, and } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { turns, messageVersions, outboxEvents } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import type { TurnModel, MessageVersionModel } from "../../types/index.js";

export class TurnStore {
  constructor(private readonly db: AervoxDatabase) {}

  async createTurnWithOutbox(
    ctx: LocalContext,
    turnData: { id: string; sessionId: string; idempotencyKey: string; status?: string },
    userMessage: { id: string; content: string },
    outboxEventData?: { id: string; eventType: string; idempotencyKey: string; payload: unknown },
  ): Promise<{ turn: TurnModel; message: MessageVersionModel }> {
    const now = new Date().toISOString();

    return await this.db.transaction(async (tx) => {
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
