/** Explicit Memory deletion slice. Shared projections require their own owner cleanup. */
import { eq, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { memoryRecords } from "@aervox/schema";

type Writer = Parameters<Parameters<AervoxDatabase["transaction"]>[0]>[0];
export class SqliteMemoryDeletionStore {
  constructor(private readonly db: AervoxDatabase) {}

  private async assertSupported(db: Writer, memoryId: string): Promise<void> {
    const [record] = await db.select({ id: memoryRecords.id }).from(memoryRecords).where(eq(memoryRecords.id, memoryId));
    if (!record) throw new Error("deletion_memory_target_unknown");
    // Never silently remove a shared fact or a projection owned by another lifecycle.
    const [projection] = await db.all(sql`
      SELECT 1 FROM memory_records WHERE canonical_parent_id = ${memoryId}
      UNION ALL SELECT 1 FROM memory_edge_evidence WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id = ${memoryId})
      UNION ALL SELECT 1 FROM temporal_facts WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id = ${memoryId})
      UNION ALL SELECT 1 FROM temporal_fact_evidence WHERE memory_evidence_id IN (
        SELECT id FROM memory_evidence WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id = ${memoryId}))
      UNION ALL SELECT 1 FROM skill_candidates, json_each(source_evidence_json, '$.memoryIds') WHERE json_each.value = ${memoryId}
      LIMIT 1`);
    if (projection) throw new Error("deletion_memory_projection_requires_owner_cleanup");
  }

  async clean(memoryId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.assertSupported(tx, memoryId);
      await tx.update(memoryRecords).set({
        isDeleted: 1, content: "", keywordsJson: null, canonicalParentId: null,
        sourceTurnId: null, currentRevisionId: null, verificationStatus: "invalidated",
        updatedAt: new Date().toISOString(),
      }).where(eq(memoryRecords.id, memoryId));
      await tx.run(sql`UPDATE memory_revisions SET content = '' WHERE memory_id = ${memoryId}`);
      await tx.run(sql`UPDATE memory_evidence SET status = 'tombstoned', source_range = NULL
        WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id = ${memoryId})`);
      await tx.run(sql`UPDATE memory_compaction_markers SET summary_text = NULL, status = 'tombstoned' WHERE memory_id = ${memoryId}`);
      await tx.run(sql`UPDATE memory_events SET reason = NULL WHERE memory_id = ${memoryId}`);
      await tx.run(sql`DELETE FROM memory_embeddings WHERE memory_id = ${memoryId}`);
      await tx.run(sql`DELETE FROM memories_fts WHERE id = ${memoryId}`);
    });
  }

  /** Fresh database observations, independent of clean()'s update counts. No content in proof. */
  async verify(memoryId: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      await this.assertSupported(tx, memoryId);
      const [residue] = await tx.all(sql`
        SELECT 1 FROM memory_records WHERE id = ${memoryId} AND (is_deleted != 1 OR content != '' OR keywords_json IS NOT NULL OR verification_status != 'invalidated')
        UNION ALL SELECT 1 FROM memory_revisions WHERE memory_id = ${memoryId} AND content != ''
        UNION ALL SELECT 1 FROM memory_evidence WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id = ${memoryId}) AND (status != 'tombstoned' OR source_range IS NOT NULL)
        UNION ALL SELECT 1 FROM memory_compaction_markers WHERE memory_id = ${memoryId} AND summary_text IS NOT NULL
        UNION ALL SELECT 1 FROM memory_events WHERE memory_id = ${memoryId} AND reason IS NOT NULL
        UNION ALL SELECT 1 FROM memory_embeddings WHERE memory_id = ${memoryId}
        UNION ALL SELECT 1 FROM memories_fts WHERE id = ${memoryId}
        LIMIT 1`);
      if (residue) throw new Error("deletion_memory_verification_failed");
      return JSON.stringify({ verifier: "memory-local-v1", verifiedAt: new Date().toISOString(), contentRows: 0, ftsRows: 0, vectorRows: 0 });
    });
  }
}
