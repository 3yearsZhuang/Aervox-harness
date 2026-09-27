/** 已确认记忆的时态事实投影；来源和记忆记录仍是事实真源。 */
import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { memoryEvidence, memoryRevisions } from "./provenance.js";

export const temporalFacts = sqliteTable(
  "temporal_facts",
  {
    id: text("id").primaryKey(),
    subjectId: text("subject_id").notNull(),
    predicate: text("predicate").notNull(),
    value: text("value").notNull(),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to"),
    memoryRevisionId: text("memory_revision_id")
      .notNull()
      .references(() => memoryRevisions.id, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => ({
    openIdx: uniqueIndex("temporal_facts_open_idx")
      .on(table.subjectId, table.predicate)
      .where(sql`${table.validTo} IS NULL`),
    intervalIdx: index("temporal_facts_interval_idx")
      .on(table.subjectId, table.predicate, table.validFrom),
  }),
);

export const temporalFactEvidence = sqliteTable(
  "temporal_fact_evidence",
  {
    factId: text("fact_id")
      .notNull()
      .references(() => temporalFacts.id, { onDelete: "cascade" }),
    memoryEvidenceId: text("memory_evidence_id")
      .notNull()
      .references(() => memoryEvidence.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pairIdx: uniqueIndex("temporal_fact_evidence_pair_idx")
      .on(table.factId, table.memoryEvidenceId),
    evidenceIdx: index("temporal_fact_evidence_evidence_idx")
      .on(table.memoryEvidenceId),
  }),
);
