/** Node compatibility wrapper; source admission remains in the shared store. */
import type { AervoxDatabase } from "../../database.js";
import { nodeConversationCrypto } from "../../conversation-crypto-node.js";
import { MemoryEmbeddingRepository } from "./memory-embedding-repository-neutral.js";
export { SqliteMemoryVectorSearchAdapter } from "./memory-embedding-repository-neutral.js";
export class SqliteMemoryEmbeddingRepository extends MemoryEmbeddingRepository {
  constructor(db: AervoxDatabase) { super(db, nodeConversationCrypto); }
}
