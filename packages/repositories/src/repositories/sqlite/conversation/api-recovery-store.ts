import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { toolExecutions, turnAttempts, turns, turnStreamEvents } from "@aervox/schema";
import type { AervoxDatabase } from "../../../client.js";

const terminal = ["Completed", "Failed", "Interrupted", "Cancelled"];
// An inbox row exists before platform Turn acceptance. Match its idempotency key too,
// including the crash window before the inbox's turn_id has been updated.
const unmanaged = sql`NOT EXISTS (SELECT 1 FROM bot_inbox b
  WHERE b.turn_id = ${turns.id} OR ${turns.idempotencyKey} = 'bot:' || b.id)`;
const apiPolicy = and(eq(turns.dispatchTarget, "api"), inArray(turns.executionPolicy, ["bot-owner-v1", "bot-group-member-v1"]),
  sql`EXISTS (SELECT 1 FROM sessions s WHERE s.id = ${turns.sessionId} AND s.execution_policy = ${turns.executionPolicy})`);

/** Recovery for workbench turns on Bot sessions; platform queue ownership remains with BotManager. */
export class ApiRecoveryStore {
  constructor(private readonly db: AervoxDatabase) {}

  list(before: string, limit = 100) {
    return this.db.select().from(turns).where(and(apiPolicy, unmanaged,
      sql`${turns.createdAt} < ${before}`,
      inArray(turns.status, ["Created", "Running", "Cancelled"]),
      sql`EXISTS (SELECT 1 FROM turn_attempts a WHERE a.turn_id = ${turns.id}
        AND (${turns.status} != 'Cancelled' OR a.status IN ('Running', 'CancelRequested')))`))
      .orderBy(turns.createdAt, turns.id).limit(Math.min(100, Math.max(0, limit)));
  }

  /** Mirror only the latest terminal Attempt, preserving a Turn already finalized by another path. */
  async synchronize(turnId: string) {
    return this.db.transaction(async tx => {
      const [attempt] = await tx.select().from(turnAttempts).where(eq(turnAttempts.turnId, turnId)).orderBy(desc(turnAttempts.attempt)).limit(1);
      if (!attempt || !terminal.includes(attempt.status)) return null;
      const [last] = await tx.select({ sequence: turnStreamEvents.sequence }).from(turnStreamEvents)
        .where(eq(turnStreamEvents.turnId, turnId)).orderBy(desc(turnStreamEvents.sequence)).limit(1);
      return (await tx.update(turns).set({ status: attempt.status, updatedAt: new Date().toISOString(),
        ...(last ? { lastSequence: last.sequence } : {}) }).where(and(eq(turns.id, turnId),
        inArray(turns.status, ["Created", "Running"]))).returning())[0] ?? null;
    });
  }

  /** Fence an expired, already claimed attempt without replaying any model or tool work. */
  async retireExpired(turnId: string, attemptId: string, expectedFencingToken: number) {
    const now = new Date().toISOString();
    return this.db.transaction(async tx => {
      const [turn] = await tx.select().from(turns).where(and(eq(turns.id, turnId), apiPolicy, unmanaged));
      if (!turn) return false;
      const [latest] = await tx.select().from(turnAttempts).where(eq(turnAttempts.turnId, turnId)).orderBy(desc(turnAttempts.attempt)).limit(1);
      if (latest?.id !== attemptId) return false;
      const [attempt] = await tx.update(turnAttempts).set({
        status: sql`CASE WHEN ${turnAttempts.status} = 'CancelRequested' THEN 'Cancelled' ELSE 'Interrupted' END`,
        fencingToken: expectedFencingToken + 1, finishedAt: now,
      }).where(and(eq(turnAttempts.id, attemptId), eq(turnAttempts.turnId, turnId),
        eq(turnAttempts.fencingToken, expectedFencingToken), inArray(turnAttempts.status, ["Running", "CancelRequested"]),
        sql`(${turnAttempts.leaseExpiresAt} < ${now} OR
          (${turnAttempts.leaseExpiresAt} IS NULL AND ${turnAttempts.status} = 'CancelRequested'))`)).returning();
      if (!attempt) return false;
      await tx.update(toolExecutions).set({ status: "outcome_unknown", error: "recovery_outcome_unknown", finishedAt: now })
        .where(and(eq(toolExecutions.attemptId, attemptId), eq(toolExecutions.status, "pending")));
      if (terminal.includes(turn.status) && turn.status !== "Cancelled") return true;
      const [last] = await tx.select({ sequence: turnStreamEvents.sequence }).from(turnStreamEvents)
        .where(eq(turnStreamEvents.turnId, turnId)).orderBy(desc(turnStreamEvents.sequence)).limit(1);
      const sequence = Math.max(turn.lastSequence, last?.sequence ?? 0) + 1;
      await tx.insert(turnStreamEvents).values({ id: `tev_${turnId}_${sequence}`, turnId, attemptId, sequence,
        eventType: "done", occurredAt: now, committedAt: now, safetyDecision: "approved",
        data: { status: attempt.status, isComplete: false, lastSequence: sequence, reason: "execution_recovered" } });
      await tx.update(turns).set({ status: attempt.status, updatedAt: now, lastSequence: sequence }).where(eq(turns.id, turnId));
      return true;
    }, { behavior: "immediate" });
  }
}
