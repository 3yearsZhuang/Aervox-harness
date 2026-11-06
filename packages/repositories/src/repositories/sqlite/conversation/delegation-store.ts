import { eq, and, sql } from "drizzle-orm";
import { outboxEvents, turns, sessions } from "@aervox/schema";
import type { AervoxDatabase } from "../../../client.js";
import { jsonKind, jsonText, validJson } from "../../../sql-dialect.js";

/** Shared receipt binding for observation and atomic recovery decisions. */
export function workerDelegationBinding(db: object) {
  return and(
    eq(outboxEvents.id, sql`'outbox_' || ${turns.id}`),
    eq(outboxEvents.eventType, "agent.turn.requested"),
    eq(turns.executionPolicy, "local-v1"), eq(turns.dispatchTarget, "default"),
    // A still-matching receipt cannot delegate a Session whose current policy
    // changed or disappeared. Share this admission with queue recovery.
    sql`EXISTS (SELECT 1 FROM ${sessions}
      WHERE ${sessions.id} = ${turns.sessionId} AND ${sessions.executionPolicy} = 'local-v1')`,
    // A malformed or partial receipt is not a delegation. CASE guards JSON
    // extraction so corrupt receipt text cannot abort the recovery transaction.
    sql`CASE WHEN ${validJson(db, outboxEvents.payload)} THEN
      ${jsonKind(db, outboxEvents.payload)} = 'object'
      AND ${jsonKind(db, outboxEvents.payload, '$.execution')} = 'text'
      AND ${jsonText(db, outboxEvents.payload, '$.execution')} = 'worker'
      AND ${jsonKind(db, outboxEvents.payload, '$.turnId')} = 'text'
      AND ${jsonText(db, outboxEvents.payload, '$.turnId')} = ${turns.id}
      AND ${jsonKind(db, outboxEvents.payload, '$.sessionId')} = 'text'
      AND ${jsonText(db, outboxEvents.payload, '$.sessionId')} = ${turns.sessionId}
      AND ${jsonKind(db, outboxEvents.payload, '$.requestHash')} = 'text'
      AND ${turns.requestHash} IS NOT NULL AND ${turns.requestHash} != ''
      AND ${jsonText(db, outboxEvents.payload, '$.requestHash')} = ${turns.requestHash}
      ELSE false END`,
  );
}

/** Delivery is a locator; only the original durable acceptance delegates execution. */
export async function hasWorkerDelegation(db: AervoxDatabase, turnId: string, eventId?: string): Promise<boolean> {
  const id = `outbox_${turnId}`;
  if (eventId !== undefined && eventId !== id) return false;
  const [row] = await db.select({ id: outboxEvents.id }).from(outboxEvents)
    .innerJoin(turns, eq(turns.id, turnId)).where(workerDelegationBinding(db));
  return !!row;
}
