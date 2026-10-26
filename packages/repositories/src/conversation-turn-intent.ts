/** Node compatibility entry. Canonical intent and error identity are shared. */
import { nodeConversationCrypto } from "./conversation-crypto-node.js";
import { turnIntentHashWithHost, type NormalizedTurnIntent } from "./conversation-turn-intent-neutral.js";
export * from "./conversation-turn-intent-neutral.js";
export function turnIntentHash(intent: NormalizedTurnIntent): string {
  return turnIntentHashWithHost(intent, nodeConversationCrypto);
}
