/** Node compatibility wrapper; source admission remains in the shared store. */
import type { FtsConnection } from "../../search/fts.js";
import type { AervoxDatabase } from "../../database.js";
import { nodeConversationCrypto } from "../../conversation-crypto-node.js";
import { MemoryRepository } from "./memory-repository-neutral.js";
export class SqliteMemoryRepository extends MemoryRepository {
  constructor(db: AervoxDatabase, client: Pick<FtsConnection, "execute">) { super(db, client, nodeConversationCrypto); }
}
