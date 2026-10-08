/**
 * Aervox｜思隅 @aervox/repositories — Turn 生命周期与 Outbox 伴随写入 Store
 */
import { eq, and, or, isNull, gt, inArray } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { turns, messageVersions, outboxEvents, turnAttempts, agentInboxItems } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import type { TurnModel, MessageVersionModel, TurnAcceptanceInput, TurnAcceptanceResult, TurnAttemptModel } from "../../types/index.js";
import { withSessionLock } from "../../../session-lock.js";
import { notifyWorkerWakeup } from "../../../worker-ipc.js";

export class TurnStore {
  constructor(private readonly db: AervoxDatabase) {}

  async createTurnWithOutbox(
    ctx: LocalContext,
    turnData: { id: string; sessionId: string; idempotencyKey: string; status?: string },
    userMessage: { id: string; content: string },
    outboxEventData?: { id: string; eventType: string; idempotencyKey: string; payload: unknown },
  ): Promise<{ turn: TurnModel; message: MessageVersionModel }> {
    const result = await this.db.transaction((tx) => this.insertTurn(tx, turnData, userMessage, outboxEventData));
    if (outboxEventData) void notifyWorkerWakeup("outbox");
    return result;
  }

  /** Acceptance is one writer commit: input consumption, Turn, Outbox and initial Attempt. */
  async acceptTurn(ctx: LocalContext, input: TurnAcceptanceInput): Promise<TurnAcceptanceResult> {
    const result = await withSessionLock(`turn-accept:${input.sessionId}`, () => this.db.transaction(async (tx): Promise<TurnAcceptanceResult> => {
      const [existing] = await tx.select().from(turns).where(eq(turns.idempotencyKey, input.idempotencyKey));
      if (existing) return { created: false, turn: existing as TurnModel };
      const now = new Date().toISOString();
      const inbox = input.consumeInbox ? await tx.select().from(agentInboxItems).where(and(
        eq(agentInboxItems.sessionId, input.sessionId), eq(agentInboxItems.consumeBoundary, "next-turn"),
        eq(agentInboxItems.status, "pending"),
        or(isNull(agentInboxItems.expiresAt), gt(agentInboxItems.expiresAt, now)),
      )).orderBy(agentInboxItems.createdAt, agentInboxItems.id).limit(20) : [];
      const content = [...inbox.map((item) => typeof item.payloadJson === "string"
        ? item.payloadJson : JSON.stringify(item.payloadJson)), input.message.content].join("\n\n");
      const accepted = await this.insertTurn(tx, {
        id: input.turnId, sessionId: input.sessionId, idempotencyKey: input.idempotencyKey,
      }, { ...input.message, content }, {
        id: `outbox_${input.turnId}`, eventType: "turn.created", idempotencyKey: `idem_outbox_${input.turnId}`,
        payload: { turnId: input.turnId, sessionId: input.sessionId },
      });
      const [attempt] = await tx.insert(turnAttempts).values({
        id: input.attemptId, turnId: input.turnId, attempt: 1, fencingToken: 0, status: "Running", startedAt: now,
      }).returning();
      if (inbox.length) {
        const consumed = await tx.update(agentInboxItems).set({
          status: "acknowledged", claimedAt: now, ackedAt: now, updatedAt: now, attemptId: input.attemptId,
        }).where(and(inArray(agentInboxItems.id, inbox.map((item) => item.id)), eq(agentInboxItems.status, "pending"))).returning();
        if (consumed.length !== inbox.length) throw new Error("inbox_acceptance_conflict");
      }
      return { created: true, ...accepted, attempt: attempt as TurnAttemptModel };
    }));
    if (result.created) void notifyWorkerWakeup("outbox");
    return result;
  }

  private async insertTurn(
    tx: Parameters<Parameters<AervoxDatabase["transaction"]>[0]>[0],
    turnData: { id: string; sessionId: string; idempotencyKey: string; status?: string },
    userMessage: { id: string; content: string },
    outboxEventData?: { id: string; eventType: string; idempotencyKey: string; payload: unknown },
  ): Promise<{ turn: TurnModel; message: MessageVersionModel }> {
    const now = new Date().toISOString();
    const [turn] = await tx.insert(turns).values({
      ...turnData, status: turnData.status ?? "Created", lastSequence: 0, acceptedAt: now, createdAt: now, updatedAt: now,
    }).returning();
    const [message] = await tx.insert(messageVersions).values({
      id: userMessage.id, turnId: turnData.id, role: "user", version: 1,
      content: userMessage.content, isRedacted: 0, createdAt: now,
    }).returning();
    if (outboxEventData) await tx.insert(outboxEvents).values({ ...outboxEventData, status: "pending", createdAt: now });
    return { turn: turn as TurnModel, message: message as MessageVersionModel };
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
