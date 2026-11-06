/** Node compatibility wrapper; source admission remains in the shared store. */
import type { Client } from "@libsql/client";
import type { AervoxDatabase } from "../../database.js";
import { nodeConversationCrypto } from "../../conversation-crypto-node.js";
import { MemoryRepository } from "./memory-repository-neutral.js";
export class SqliteMemoryRepository extends MemoryRepository {
  constructor(db: AervoxDatabase, client: Client) { super(db, client, nodeConversationCrypto); }
}
