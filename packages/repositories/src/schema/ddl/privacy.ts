/**
 * Aervox｜思隅 @aervox/repositories — privacy 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createPrivacyTables(client: Client): Promise<void> {
  // 11. 隐私/删除域（PRD §8）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS consent_grants (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        scope TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS consent_grants_local_purpose_scope_idx ON consent_grants(purpose, scope) WHERE revoked_at IS NULL;
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS deletion_requests (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        effective_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        owner_module TEXT NOT NULL,
        last_verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS deletion_requests_local_idempotency_idx ON deletion_requests(idempotency_key);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS deletion_targets (
        request_id TEXT NOT NULL REFERENCES deletion_requests(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        owner_module TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        verified_at TEXT,
        evidence_ref TEXT,
        PRIMARY KEY (request_id, target_type, target_id)
      );
    `);
}
