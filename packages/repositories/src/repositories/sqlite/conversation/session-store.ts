/** Preserve the existing Node constructor; all SQL lives in the shared store. */
import type { AervoxDatabase } from "../../../client.js";
import { nodeConversationCrypto } from "../../../conversation-crypto-node.js";
import { ConversationSessionStore } from "./session-store-neutral.js";
export class SessionStore extends ConversationSessionStore {
  constructor(db: AervoxDatabase) { super(db, nodeConversationCrypto); }
}
