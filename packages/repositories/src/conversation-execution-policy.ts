import { eq } from "drizzle-orm";
import { sessions, turns, type ConversationExecutionPolicy, type TurnDispatchTarget } from "@aervox/schema";
import type { AervoxDatabase } from "./client.js";

/** A missing or future persisted policy is never interpreted as a local conversation. */
export function assertConversationExecutionPolicy(value: unknown): asserts value is ConversationExecutionPolicy {
  if (value !== "local-v1" && value !== "bot-owner-v1" && value !== "bot-group-member-v1") {
    throw new Error("conversation_execution_policy_unknown");
  }
}

export function conversationDispatchTarget(policy: ConversationExecutionPolicy): TurnDispatchTarget {
  assertConversationExecutionPolicy(policy);
  return policy === "local-v1" ? "default" : "api";
}

export function canUsePersonalDerivedData(policy: ConversationExecutionPolicy): boolean {
  assertConversationExecutionPolicy(policy);
  return policy !== "bot-group-member-v1";
}

/** Read the source within the writer transaction that creates personal derived data. */
export async function assertPersonalDerivedDataSource(
  db: Pick<AervoxDatabase, "select">,
  sourceTurnId: string | null | undefined,
): Promise<void> {
  if (!sourceTurnId) return;
  const [source] = await db.select({
    turnPolicy: turns.executionPolicy,
    sessionPolicy: sessions.executionPolicy,
  }).from(turns).innerJoin(sessions, eq(turns.sessionId, sessions.id)).where(eq(turns.id, sourceTurnId));
  if (!source) throw new Error("personal_derived_data_source_unavailable");
  assertConversationExecutionPolicy(source.turnPolicy);
  assertConversationExecutionPolicy(source.sessionPolicy);
  if (source.turnPolicy !== source.sessionPolicy || !canUsePersonalDerivedData(source.turnPolicy)) {
    throw new Error("personal_derived_data_source_forbidden");
  }
}
