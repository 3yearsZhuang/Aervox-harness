/** Node compatibility wrapper; shared commands retain the sole SQL authority. */
import type { AervoxDatabase } from "../../client.js";
import { nodeConversationHost } from "../../conversation-host-node.js";
import { ConversationRepository } from "./conversation-repository-neutral.js";
export { MAX_RESUME_CANDIDATE_LIMIT, MAX_STREAM_EVENT_PAGE_ROWS, MAX_STREAM_EVENT_PAGE_DATA_BYTES } from "./conversation-repository-neutral.js";
export class SqliteConversationRepository extends ConversationRepository {
  constructor(db: AervoxDatabase) { super(db, nodeConversationHost); }
}
