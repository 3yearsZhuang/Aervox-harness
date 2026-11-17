import { eq, inArray } from "drizzle-orm";
import { contextManifests, messages, messageVersions, modelRuns, sessions, turnAttempts, turns } from "@aervox/schema";
import type { AervoxDatabase } from "../../../client.js";

/** Legacy snapshots can include earlier turns in the same session. Clear the
 * whole linked session's diagnostic bodies before its source identity is lost.
 * Keep ownership comparisons in SQL so SQLite's embedded NUL identities remain
 * exact; PostgreSQL uses the same bound identity queries for supported text.
 */
export async function clearConversationContextBodies(
  tx: Parameters<Parameters<AervoxDatabase["transaction"]>[0]>[0],
  target: { sessionId: string } | { messageId: string } | { versionId: string },
): Promise<void> {
  const sourceSessions = "sessionId" in target
    ? tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, target.sessionId))
    : "messageId" in target
      ? tx.select({ id: messages.sessionId }).from(messages).where(eq(messages.id, target.messageId))
      : tx.select({ id: turns.sessionId }).from(turns).innerJoin(messageVersions, eq(messageVersions.turnId, turns.id))
        .where(eq(messageVersions.id, target.versionId));
  const attempts = tx.select({ id: turnAttempts.id }).from(turnAttempts).innerJoin(turns, eq(turnAttempts.turnId, turns.id))
    .where(inArray(turns.sessionId, sourceSessions));
  const runs = tx.select({ id: modelRuns.id }).from(modelRuns).where(inArray(modelRuns.attemptId, attempts));
  await tx.update(contextManifests).set({ snapshotJson: null, permissionSnapshot: null, selectionReason: null })
    .where(inArray(contextManifests.modelRunId, runs));
}
