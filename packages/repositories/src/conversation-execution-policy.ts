import { eq } from "drizzle-orm";
import { sessions, turns } from "@aervox/schema";
import type { AervoxDatabase } from "./client.js";
import { admitsSourceTurn, unverifiedAttachmentTurn } from "./attachment-source-admission.js";
import type { ConversationCryptoPort } from "./conversation-host-port.js";
import { assertConversationExecutionPolicy, canUsePersonalDerivedData } from "./conversation-policy.js";
export { assertConversationExecutionPolicy, conversationDispatchTarget, canUsePersonalDerivedData } from "./conversation-policy.js";

/** Read the source within the writer transaction that creates personal derived data. */
export async function assertPersonalDerivedDataSource(
  db: Pick<AervoxDatabase, "select">,
  sourceTurnId: string | null | undefined,
  crypto?: Pick<ConversationCryptoPort, "sha256Utf8">,
): Promise<void> {
  if (!sourceTurnId) return;
  const [source] = await db.select({
    turnPolicy: turns.executionPolicy,
    sessionPolicy: sessions.executionPolicy,
    unverifiedAttachments: unverifiedAttachmentTurn(db, turns.id),
  }).from(turns).innerJoin(sessions, eq(turns.sessionId, sessions.id)).where(eq(turns.id, sourceTurnId));
  if (!source) throw new Error("personal_derived_data_source_unavailable");
  assertConversationExecutionPolicy(source.turnPolicy);
  assertConversationExecutionPolicy(source.sessionPolicy);
  if (source.turnPolicy !== source.sessionPolicy || !canUsePersonalDerivedData(source.turnPolicy) || source.unverifiedAttachments !== 0
    || !await admitsSourceTurn(db, sourceTurnId, crypto)) {
    throw new Error("personal_derived_data_source_forbidden");
  }
}
