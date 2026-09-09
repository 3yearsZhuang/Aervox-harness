/**
 * Aervox｜思隅 @aervox/repositories — proactive 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";
import { addColumnIfMissing } from "./common.js";

export async function createProactiveTables(client: Client): Promise<void> {
  // CAP-033 主动智能模式：版本化全量画像授权与本地处理数据面。
    // 所有正文/派生表均显式带 processing_boundary，且不接入 outbox/远程同步表。
    await client.execute(`
      CREATE TABLE IF NOT EXISTS proactive_profile_revisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        profile_version TEXT NOT NULL DEFAULT 'full_profile_v1',
        revision INTEGER NOT NULL DEFAULT 1,
        device_id TEXT NOT NULL,
        desired_state TEXT NOT NULL DEFAULT 'none',
        status TEXT NOT NULL DEFAULT 'draft',
        full_access_required INTEGER NOT NULL DEFAULT 1,
        processing_boundary TEXT NOT NULL DEFAULT 'local_only',
        manifest_json TEXT NOT NULL DEFAULT '{}',
        grant_set_hash TEXT,
        confirmed_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  // 设备级修订号允许不同设备各自从 1 开始；旧试验版索引缺少 device_id，先幂等重建。
    await client.execute(`DROP INDEX IF EXISTS proactive_profile_tenant_version_revision_idx;`);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS proactive_profile_tenant_version_revision_idx
      ON proactive_profile_revisions(workspace_id, subject_user_id, profile_version, device_id, revision);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_profile_tenant_device_idx
      ON proactive_profile_revisions(workspace_id, subject_user_id, device_id, status);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_profile_active_idx
      ON proactive_profile_revisions(workspace_id, subject_user_id, status);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS proactive_source_grants (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        purpose TEXT NOT NULL,
        scope TEXT NOT NULL,
        os_capability TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'requested',
        mandatory INTEGER NOT NULL DEFAULT 1,
        processing_boundary TEXT NOT NULL DEFAULT 'local_only',
        grant_version INTEGER NOT NULL DEFAULT 1,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        granted_at TEXT,
        revoked_at TEXT,
        last_verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS proactive_source_revision_source_purpose_idx
      ON proactive_source_grants(revision_id, source_key, purpose);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_source_tenant_state_idx
      ON proactive_source_grants(workspace_id, subject_user_id, state);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_source_tenant_source_idx
      ON proactive_source_grants(workspace_id, subject_user_id, source_key);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS proactive_activation_leases (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        epoch TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        local_ready INTEGER NOT NULL DEFAULT 0,
        full_access_snapshot INTEGER NOT NULL DEFAULT 0,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS proactive_activation_tenant_device_epoch_idx
      ON proactive_activation_leases(workspace_id, subject_user_id, device_id, epoch);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_activation_tenant_active_idx
      ON proactive_activation_leases(workspace_id, subject_user_id, device_id, status);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS proactive_captures (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
        source_grant_id TEXT NOT NULL REFERENCES proactive_source_grants(id) ON DELETE RESTRICT,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        content_type TEXT NOT NULL,
        payload_text TEXT,
        payload_json TEXT,
        checksum TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0,
        processing_boundary TEXT NOT NULL DEFAULT 'local_only',
        observed_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        retention_until TEXT NOT NULL,
        distillation_status TEXT NOT NULL DEFAULT 'pending',
        distillation_attempt_count INTEGER NOT NULL DEFAULT 0,
        last_distillation_error TEXT,
        retention_blocked_at TEXT,
        distilled_at TEXT,
        distilled_memory_ids_json TEXT NOT NULL DEFAULT '[]',
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_capture_tenant_observed_idx
      ON proactive_captures(workspace_id, subject_user_id, observed_at);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_capture_tenant_retention_idx
      ON proactive_captures(workspace_id, subject_user_id, retention_until, distillation_status);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_capture_revision_idx ON proactive_captures(revision_id);
    `);
  // CAP-033 增量迁移：允许从早期试验版主动表升级到带 retention blocked / attempt 账本的版本。
    await addColumnIfMissing(client, "proactive_captures", "distillation_attempt_count", "distillation_attempt_count INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "proactive_captures", "last_distillation_error", "last_distillation_error TEXT");
  await addColumnIfMissing(client, "proactive_captures", "retention_blocked_at", "retention_blocked_at TEXT");
  await client.execute(`
      CREATE TABLE IF NOT EXISTS proactive_observations (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
        source_grant_id TEXT NOT NULL REFERENCES proactive_source_grants(id) ON DELETE RESTRICT,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        observation_type TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        checksum TEXT NOT NULL,
        processing_boundary TEXT NOT NULL DEFAULT 'local_only',
        algorithm_version TEXT NOT NULL DEFAULT 'local-observation-v1',
        observed_at TEXT NOT NULL,
        normalized_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_observation_tenant_observed_idx
      ON proactive_observations(workspace_id, subject_user_id, observed_at);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_observation_revision_idx ON proactive_observations(revision_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_observation_source_idx ON proactive_observations(source_grant_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS proactive_profile_claims (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        claim_type TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        content TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'inferred',
        confidence INTEGER NOT NULL DEFAULT 0,
        algorithm_version TEXT NOT NULL DEFAULT 'local-profile-v1',
        processing_boundary TEXT NOT NULL DEFAULT 'local_only',
        evidence_capture_ids_json TEXT NOT NULL DEFAULT '[]',
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        source_grant_ids_json TEXT NOT NULL DEFAULT '[]',
        first_observed_at TEXT,
        last_observed_at TEXT,
        confirmed_at TEXT,
        rejected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_claim_tenant_state_idx
      ON proactive_profile_claims(workspace_id, subject_user_id, state);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_claim_tenant_type_idx
      ON proactive_profile_claims(workspace_id, subject_user_id, claim_type);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_claim_revision_idx ON proactive_profile_claims(revision_id);
    `);
  await addColumnIfMissing(client, "proactive_profile_claims", "algorithm_version", "algorithm_version TEXT NOT NULL DEFAULT 'local-profile-v1'");
  await addColumnIfMissing(client, "proactive_profile_claims", "first_observed_at", "first_observed_at TEXT");
  await addColumnIfMissing(client, "proactive_profile_claims", "last_observed_at", "last_observed_at TEXT");
  await client.execute(`
      CREATE TABLE IF NOT EXISTS proactive_actions (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
        activation_lease_id TEXT REFERENCES proactive_activation_leases(id) ON DELETE SET NULL,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target TEXT NOT NULL,
        request_json TEXT NOT NULL DEFAULT '{}',
        authorization_scope TEXT NOT NULL,
        action_grant_revision TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        requested_by TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT,
        reversible INTEGER NOT NULL DEFAULT 1,
        external INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        finished_at TEXT,
        outcome_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_action_tenant_state_idx
      ON proactive_actions(workspace_id, subject_user_id, state);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_action_tenant_created_idx
      ON proactive_actions(workspace_id, subject_user_id, created_at);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_action_revision_idx ON proactive_actions(revision_id);
    `);
  await addColumnIfMissing(client, "proactive_actions", "action_grant_revision", "action_grant_revision TEXT NOT NULL DEFAULT 'legacy-v1'");
  await client.execute(`
      CREATE TABLE IF NOT EXISTS proactive_audit_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        revision_id TEXT REFERENCES proactive_profile_revisions(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        processing_boundary TEXT NOT NULL DEFAULT 'local_only',
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_audit_tenant_occurred_idx
      ON proactive_audit_events(workspace_id, subject_user_id, occurred_at);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS proactive_audit_resource_idx
      ON proactive_audit_events(resource_type, resource_id);
    `);
}
