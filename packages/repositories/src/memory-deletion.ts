import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AervoxDatabase } from "./client.js";

/** Clear only the explicitly named memory and its owned copies. Keep its tombstone. */
export async function clearMemoryForDeletion(db: AervoxDatabase, memoryId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run(sql`UPDATE memory_records SET content = '', keywords_json = NULL, is_deleted = 1,
      verification_status = 'invalidated', updated_at = ${new Date().toISOString()} WHERE id = ${memoryId}`);
    await tx.run(sql`UPDATE memory_revisions SET content = '' WHERE memory_id = ${memoryId}`);
    await tx.run(sql`UPDATE memory_compaction_markers SET summary_text = NULL WHERE memory_id = ${memoryId}`);
    await tx.run(sql`UPDATE memory_events SET reason = NULL WHERE memory_id = ${memoryId}`);
    await tx.run(sql`UPDATE memory_evidence SET source_range = NULL, status = 'tombstoned'
      WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id = ${memoryId})`);
    await tx.run(sql`UPDATE memory_edge_evidence SET status = 'superseded'
      WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id = ${memoryId})`);
    await tx.run(sql`UPDATE memory_edges SET status = 'superseded'
      WHERE id IN (SELECT edge_id FROM memory_edge_evidence WHERE memory_revision_id IN
        (SELECT id FROM memory_revisions WHERE memory_id = ${memoryId}))
      AND NOT EXISTS (SELECT 1 FROM memory_edge_evidence e WHERE e.edge_id = memory_edges.id AND e.status = 'active')`);
    await tx.run(sql`DELETE FROM memory_embeddings WHERE memory_id = ${memoryId}`);
    await tx.run(sql`DELETE FROM memories_fts WHERE id = ${memoryId}`);
  });
}

/** A separate writer-side read verifies effects; a successful write is not evidence. */
export async function verifyMemoryDeletion(db: AervoxDatabase, memoryId: string): Promise<string | null> {
  const [row] = await db.all<{ remaining: number }>(sql`SELECT (
    (SELECT count(*) FROM memory_records WHERE id = ${memoryId}
      AND (is_deleted <> 1 OR content <> '' OR keywords_json IS NOT NULL OR verification_status <> 'invalidated')) +
    (SELECT count(*) FROM memory_revisions WHERE memory_id = ${memoryId} AND content <> '') +
    (SELECT count(*) FROM memory_compaction_markers WHERE memory_id = ${memoryId} AND summary_text IS NOT NULL) +
    (SELECT count(*) FROM memory_events WHERE memory_id = ${memoryId} AND reason IS NOT NULL) +
    (SELECT count(*) FROM memory_evidence WHERE memory_revision_id IN
      (SELECT id FROM memory_revisions WHERE memory_id = ${memoryId}) AND (source_range IS NOT NULL OR status <> 'tombstoned')) +
    (SELECT count(*) FROM memory_edge_evidence WHERE memory_revision_id IN
      (SELECT id FROM memory_revisions WHERE memory_id = ${memoryId}) AND status = 'active') +
    (SELECT count(*) FROM memory_edges WHERE status <> 'superseded'
      AND id IN (SELECT edge_id FROM memory_edge_evidence WHERE memory_revision_id IN
        (SELECT id FROM memory_revisions WHERE memory_id = ${memoryId}))
      AND NOT EXISTS (SELECT 1 FROM memory_edge_evidence e WHERE e.edge_id = memory_edges.id AND e.status = 'active')) +
    (SELECT count(*) FROM memory_embeddings WHERE memory_id = ${memoryId}) +
    (SELECT count(*) FROM memories_fts WHERE id = ${memoryId})
  ) AS remaining`);
  if (!row || Number(row.remaining) !== 0) return null;
  return `memory-clear-v1:${createHash("sha256").update(memoryId).digest("hex")}`;
}
