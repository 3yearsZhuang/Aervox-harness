import { eq } from "drizzle-orm";
import { memoryRecords, memoryRevisions } from "@aervox/schema";
import type { AervoxDatabase } from "../../client.js";
import { DomainConflictError, RepositoryNotFoundError } from "../../errors.js";

/** A stale producer must not attach content or projections to a deletion tombstone. */
export class MemoryWriteUnavailableError extends DomainConflictError {
  constructor() {
    super("memory_write_target_unavailable");
    this.name = "MemoryWriteUnavailableError";
  }
}

/** All guards must run inside the same writer transaction as the dependent insert. */
export async function assertMemoryWriteAvailable(
  db: Pick<AervoxDatabase, "select">,
  memoryId: string,
): Promise<void> {
  const [memory] = await db.select({ isDeleted: memoryRecords.isDeleted })
    .from(memoryRecords).where(eq(memoryRecords.id, memoryId));
  if (!memory) throw new RepositoryNotFoundError(`Memory ${memoryId} not found`);
  if (memory.isDeleted !== 0) throw new MemoryWriteUnavailableError();
}

export async function assertMemoryRevisionWriteAvailable(
  db: Pick<AervoxDatabase, "select">,
  revisionId: string,
): Promise<void> {
  const [revision] = await db.select({ memoryId: memoryRevisions.memoryId })
    .from(memoryRevisions).where(eq(memoryRevisions.id, revisionId));
  if (!revision) throw new RepositoryNotFoundError(`Memory revision ${revisionId} not found`);
  await assertMemoryWriteAvailable(db, revision.memoryId);
}

/** Legacy parent/Skill references may be external; existing tombstones still deny new links. */
export async function assertMemoryReferenceNotDeleted(
  db: Pick<AervoxDatabase, "select">,
  memoryId: string,
): Promise<void> {
  const [memory] = await db.select({ isDeleted: memoryRecords.isDeleted })
    .from(memoryRecords).where(eq(memoryRecords.id, memoryId));
  if (memory && memory.isDeleted !== 0) throw new MemoryWriteUnavailableError();
}
