import { eq, sql } from "drizzle-orm";
import { memoryRecords } from "@aervox/schema";
import type { AervoxDatabase } from "../../client.js";
import { assertPersonalDerivedDataSource } from "../../conversation-execution-policy.js";
import type { ConversationCryptoPort } from "../../conversation-host-port.js";

export const MEMORY_COMPACTION_EVENT_TYPE = "memory.compaction.requested";

export class MemoryCompactionUnavailableError extends Error {
  constructor() {
    super("memory_compaction_target_unavailable");
    this.name = "MemoryCompactionUnavailableError";
  }
}

/** Call inside the same writer transaction as the derived write. */
export async function assertMemoryCompactionAvailable(
  db: Pick<AervoxDatabase, "select">,
  memoryId: string,
  crypto?: Pick<ConversationCryptoPort, "sha256Utf8">,
): Promise<void> {
  const [memory] = await db.select({ isDeleted: memoryRecords.isDeleted, sourceTurnId: sql<string | null>`json_quote(${memoryRecords.sourceTurnId})`.mapWith(value => JSON.parse(value) as string | null) })
    .from(memoryRecords).where(eq(memoryRecords.id, memoryId));
  if (!memory || memory.isDeleted !== 0) throw new MemoryCompactionUnavailableError();
  try {
    await assertPersonalDerivedDataSource(db, memory.sourceTurnId, crypto);
  } catch (error) {
    if (error instanceof Error && /^(personal_derived_data_source_|conversation_execution_policy_)/.test(error.message)) {
      throw new MemoryCompactionUnavailableError();
    }
    throw error;
  }
}
