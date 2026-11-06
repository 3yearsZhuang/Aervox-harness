import type { ConversationExecutionPolicy, TurnDispatchTarget } from "@aervox/schema";

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
