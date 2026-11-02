/** Node compatibility wrapper; shared commands retain the sole SQL authority. */
import type { AervoxDatabase } from "../../client.js";
import { nodeConversationCrypto } from "../../conversation-crypto-node.js";
import { LearningRepository } from "./learning-repository-neutral.js";

export class SqliteLearningRepository extends LearningRepository {
  constructor(db: AervoxDatabase) { super(db, nodeConversationCrypto); }
}
