/**
 * Aervox｜思隅 @aervox/repositories — ledger 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createLedgerTables(client: Client): Promise<void> {
  await client.execute(`
      CREATE TABLE IF NOT EXISTS recovery_control_ledger (
        event_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        workspace_ref TEXT,
        subject_ref TEXT,
        target_ref TEXT,
        occurred_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        tamper_evidence TEXT
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS recovery_ledger_idempotency_idx ON recovery_control_ledger(idempotency_key);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS recovery_ledger_sequence_idx ON recovery_control_ledger(sequence);
    `);
}
