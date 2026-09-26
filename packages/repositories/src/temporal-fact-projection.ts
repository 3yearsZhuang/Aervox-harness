/** SQLite 时态事实实验投影；不参与当前对话召回。 */
import type { Client, Transaction } from "@libsql/client";
import { decideTemporalFact } from "./temporal-fact-policy.js";
import type { TemporalFact, TemporalFactDecision } from "./temporal-fact-policy.js";

export interface TemporalFactEvidence {
  memoryEvidenceId: string;
  sourceArtifactId: string;
  sourceRevisionId: string;
  active: boolean;
}

/** 调用方须另行核验结构化事实本身；记忆状态只验证来源链，不证明抽取语义。 */
export interface VerifiedFactProjectionInput {
  id: string;
  subjectId: string;
  predicate: string;
  value: string;
  validFrom: string;
  memoryEvidenceId: string;
}

const liveEvidence = `
  JOIN memory_revisions mr ON mr.id = me.memory_revision_id
  JOIN memory_records m ON m.id = mr.memory_id
  JOIN source_artifacts sa ON sa.id = me.source_artifact_id
  JOIN source_revisions sr ON sr.id = me.source_revision_id AND sr.artifact_id = sa.id
  WHERE me.status = 'active'
    AND m.verification_status = 'verified' AND m.is_deleted = 0
    AND m.current_revision_id = mr.id
    AND sa.status = 'active' AND sa.deleted_at IS NULL
    AND sa.current_revision_id = sr.id AND sr.superseded_at IS NULL
`;

function parseFact(row: Record<string, unknown>): TemporalFact {
  return {
    id: String(row.id),
    subjectId: String(row.subject_id),
    predicate: String(row.predicate),
    value: String(row.value),
    validFrom: String(row.valid_from),
    validTo: row.valid_to === null ? null : String(row.valid_to),
    sourceRevisionId: String(row.source_revision_id),
    recordedAt: String(row.recorded_at),
  };
}

/**
 * 把已确认记忆证据投影为时间区间。事务同时保护“读当前事实 → 判定 → 关闭/新增 → 关联证据”。
 * 来源失效无需先清理投影：所有读取都实时复核证据、记忆版本和来源状态。
 * 此模块尚未接入生产写入或召回；调用方负责核验结构化事实的语义。
 */
export class SqliteTemporalFactProjection {
  constructor(private readonly client: Client) {}

  async apply(input: VerifiedFactProjectionInput): Promise<TemporalFactDecision> {
    const tx = await this.client.transaction("write");
    try {
      const source = await tx.execute({
        sql: `SELECT me.memory_revision_id, me.source_revision_id, sa.ingested_at
          FROM memory_evidence me ${liveEvidence} AND me.id = ?`,
        args: [input.memoryEvidenceId],
      });
      const evidence = source.rows[0];
      if (!evidence) throw new Error("temporal fact requires active evidence from a current verified memory revision");

      const currentRows = await tx.execute({
        sql: `SELECT id, subject_id, predicate, value, valid_from, valid_to,
                     source_revision_id, recorded_at
              FROM temporal_facts
              WHERE subject_id = ? AND predicate = ? AND valid_to IS NULL`,
        args: [input.subjectId, input.predicate],
      });
      const current = currentRows.rows[0] ? parseFact(currentRows.rows[0]) : null;
      const decision = decideTemporalFact(current, {
        id: input.id,
        subjectId: input.subjectId,
        predicate: input.predicate,
        value: input.value,
        validFrom: input.validFrom,
        sourceRevisionId: String(evidence.source_revision_id),
        recordedAt: String(evidence.ingested_at),
        verificationStatus: "verified",
      });
      if (decision.kind === "review") {
        await tx.rollback();
        return decision;
      }
      if (decision.kind === "replace") {
        await tx.execute({
          sql: "UPDATE temporal_facts SET valid_to = ? WHERE id = ? AND valid_to IS NULL",
          args: [decision.validTo, decision.closeFactId],
        });
      }
      if (decision.kind === "insert" || decision.kind === "replace") {
        await this.insertFact(tx, decision.fact, String(evidence.memory_revision_id));
      }
      const factId = decision.kind === "corroborate" ? decision.factId : decision.fact.id;
      await tx.execute({
        sql: `INSERT OR IGNORE INTO temporal_fact_evidence(fact_id, memory_evidence_id)
              VALUES (?, ?)`,
        args: [factId, input.memoryEvidenceId],
      });
      await tx.commit();
      return decision;
    } finally {
      tx.close();
    }
  }

  private async insertFact(tx: Transaction, fact: TemporalFact, memoryRevisionId: string): Promise<void> {
    await tx.execute({
      sql: `INSERT INTO temporal_facts
            (id, subject_id, predicate, value, valid_from, valid_to,
             memory_revision_id, source_revision_id, recorded_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      args: [fact.id, fact.subjectId, fact.predicate, fact.value, fact.validFrom,
        memoryRevisionId, fact.sourceRevisionId, fact.recordedAt],
    });
  }

  async listCurrent(subjectId: string, predicate: string, now = new Date().toISOString()): Promise<TemporalFact[]> {
    return this.listAt(subjectId, predicate, now);
  }

  async listAt(subjectId: string, predicate: string, at: string): Promise<TemporalFact[]> {
    if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
      throw new Error("at must be a canonical UTC timestamp");
    }
    const result = await this.client.execute({
      sql: `SELECT f.id, f.subject_id, f.predicate, f.value, f.valid_from, f.valid_to,
                   f.source_revision_id, f.recorded_at
            FROM temporal_facts f
            WHERE f.subject_id = ? AND f.predicate = ?
              AND f.valid_from <= ? AND (f.valid_to IS NULL OR ? < f.valid_to)
              AND EXISTS (
                SELECT 1 FROM temporal_fact_evidence tfe
                JOIN memory_evidence me ON me.id = tfe.memory_evidence_id
                ${liveEvidence} AND tfe.fact_id = f.id
              )
            ORDER BY f.valid_from DESC`,
      args: [subjectId, predicate, at, at],
    });
    return result.rows.map((row) => parseFact(row));
  }

  async listEvidence(factId: string): Promise<TemporalFactEvidence[]> {
    const result = await this.client.execute({
      sql: `SELECT me.id, me.source_artifact_id, me.source_revision_id,
                   CASE WHEN me.status = 'active'
                     AND m.verification_status = 'verified' AND m.is_deleted = 0
                     AND m.current_revision_id = mr.id
                     AND sa.status = 'active' AND sa.deleted_at IS NULL
                     AND sa.current_revision_id = sr.id AND sr.superseded_at IS NULL
                   THEN 1 ELSE 0 END AS active
            FROM temporal_fact_evidence tfe
            JOIN memory_evidence me ON me.id = tfe.memory_evidence_id
            JOIN memory_revisions mr ON mr.id = me.memory_revision_id
            JOIN memory_records m ON m.id = mr.memory_id
            LEFT JOIN source_artifacts sa ON sa.id = me.source_artifact_id
            LEFT JOIN source_revisions sr ON sr.id = me.source_revision_id AND sr.artifact_id = sa.id
            WHERE tfe.fact_id = ? ORDER BY me.id`,
      args: [factId],
    });
    return result.rows.map((row) => ({
      memoryEvidenceId: String(row.id),
      sourceArtifactId: String(row.source_artifact_id),
      sourceRevisionId: String(row.source_revision_id),
      active: Number(row.active) === 1,
    }));
  }
}
