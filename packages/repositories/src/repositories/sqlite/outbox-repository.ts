/** Node compatibility wrapper; source admission remains in the existing store. */
import type { AervoxDatabase } from "../../database.js";
import { nodeConversationCrypto } from "../../conversation-crypto-node.js";
import { OutboxRepository } from "./outbox-repository-store.js";
export class SqliteOutboxRepository extends OutboxRepository {
  constructor(db: AervoxDatabase) { super(db, nodeConversationCrypto); }
}
