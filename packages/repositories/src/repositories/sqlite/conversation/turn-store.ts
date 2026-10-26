/** Preserve the existing Node constructor and durable wakeup optimization. */
import type { AervoxDatabase } from "../../../client.js";
import { nodeConversationHost } from "../../../conversation-host-node.js";
import { ConversationTurnStore } from "./turn-store-neutral.js";
export class TurnStore extends ConversationTurnStore {
  constructor(db: AervoxDatabase) { super(db, nodeConversationHost); }
}
