import { notifyWorkerWakeup } from "@aervox/process-coordination";
import type { ConversationHostPort } from "./conversation-host-port.js";
import { nodeConversationCrypto } from "./conversation-crypto-node.js";

export const nodeConversationHost: ConversationHostPort = Object.freeze({
  ...nodeConversationCrypto,
  wakeOutbox: () => notifyWorkerWakeup("outbox"),
});
