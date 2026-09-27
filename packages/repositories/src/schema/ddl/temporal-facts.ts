/** 已确认事实的可重建时态投影。 */
import type { Client } from "@libsql/client";

export async function createTemporalFactTables(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS temporal_facts (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      value TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      memory_revision_id TEXT NOT NULL REFERENCES memory_revisions(id) ON DELETE CASCADE,
      source_revision_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS temporal_facts_open_idx
    ON temporal_facts(subject_id, predicate) WHERE valid_to IS NULL
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS temporal_facts_interval_idx
    ON temporal_facts(subject_id, predicate, valid_from)
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS temporal_fact_evidence (
      fact_id TEXT NOT NULL REFERENCES temporal_facts(id) ON DELETE CASCADE,
      memory_evidence_id TEXT NOT NULL REFERENCES memory_evidence(id) ON DELETE CASCADE
    )
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS temporal_fact_evidence_pair_idx
    ON temporal_fact_evidence(fact_id, memory_evidence_id)
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS temporal_fact_evidence_evidence_idx
    ON temporal_fact_evidence(memory_evidence_id)
  `);
}
