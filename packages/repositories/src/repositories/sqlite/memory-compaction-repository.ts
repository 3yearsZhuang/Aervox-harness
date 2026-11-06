/** Node compatibility wrapper; source admission remains in the shared store. */
import type { AervoxDatabase } from "../../database.js";
import { nodeConversationCrypto } from "../../conversation-crypto-node.js";
import { MemoryCompactionRepository } from "./memory-compaction-repository-neutral.js";
export { MemoryCompactionUnavailableError, MEMORY_COMPACTION_EVENT_TYPE } from "./memory-compaction-guard.js";
export class SqliteMemoryCompactionRepository extends MemoryCompactionRepository {
  constructor(db: AervoxDatabase) { super(db, nodeConversationCrypto); }
}
