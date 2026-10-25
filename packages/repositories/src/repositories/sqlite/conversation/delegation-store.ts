import { eq, and } from "drizzle-orm";
import { outboxEvents, turns } from "@aervox/schema";
import type { AervoxDatabase } from "../../../client.js";

/** Delivery is a locator; only the original durable acceptance delegates execution. */
export async function hasWorkerDelegation(db: AervoxDatabase, turnId: string, eventId?: string): Promise<boolean> {
  const id = `outbox_${turnId}`;
  if (eventId !== undefined && eventId !== id) return false;
  const [row] = await db.select({ event: outboxEvents, turn: turns }).from(outboxEvents)
    .innerJoin(turns, eq(turns.id, turnId)).where(and(eq(outboxEvents.id, id), eq(outboxEvents.eventType, "agent.turn.requested")));
  const payload = row?.event.payload as { turnId?: string; sessionId?: string; execution?: string; requestHash?: string } | undefined;
  return !!row && payload?.execution === "worker" && payload.turnId === row.turn.id
    && payload.sessionId === row.turn.sessionId && !!row.turn.requestHash && payload.requestHash === row.turn.requestHash;
}
