/**
 * Aervox｜思隅 @aervox/repositories — proactive-intelligence 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createProactiveIntelligenceTables(client: Client): Promise<void> {
  // CAP-033 intelligence suite + CAP-034 Home Assistant + CAP-035 Xiaomi Health.
    const proactiveIntelligenceDdl = [
      `CREATE TABLE IF NOT EXISTS proactive_timeline_events (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, source_grant_id TEXT, source_key TEXT NOT NULL,
        event_type TEXT NOT NULL, subject_key TEXT NOT NULL, title TEXT NOT NULL, summary TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}', privacy_class TEXT NOT NULL DEFAULT 'private',
        project_id TEXT, relationship_id TEXT, checksum TEXT NOT NULL,
        processing_boundary TEXT NOT NULL DEFAULT 'local_only', occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS proactive_timeline_local_checksum_idx
        ON proactive_timeline_events(checksum);`,
      `CREATE INDEX IF NOT EXISTS proactive_timeline_local_occurred_idx
        ON proactive_timeline_events(occurred_at);`,
      `CREATE INDEX IF NOT EXISTS proactive_timeline_local_subject_idx
        ON proactive_timeline_events(subject_key);`,
      `CREATE TABLE IF NOT EXISTS proactive_projects (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, title TEXT NOT NULL, objective TEXT, description TEXT,
        status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 50,
        confidence INTEGER NOT NULL DEFAULT 0, due_at TEXT, last_activity_at TEXT,
        source_timeline_ids_json TEXT NOT NULL DEFAULT '[]', processing_boundary TEXT NOT NULL DEFAULT 'local_only',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS proactive_project_local_status_idx
        ON proactive_projects(status);`,
      `CREATE TABLE IF NOT EXISTS proactive_relationships (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, relationship_type TEXT NOT NULL DEFAULT 'contact', display_name TEXT NOT NULL,
        notes TEXT, state TEXT NOT NULL DEFAULT 'active', confidence INTEGER NOT NULL DEFAULT 0,
        last_interaction_at TEXT, source_grant_ids_json TEXT NOT NULL DEFAULT '[]',
        processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS proactive_relationship_local_state_idx
        ON proactive_relationships(state);`,
      `CREATE TABLE IF NOT EXISTS proactive_commitments (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, project_id TEXT, relationship_id TEXT, content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', importance INTEGER NOT NULL DEFAULT 50,
        due_at TEXT, source_timeline_id TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS proactive_commitment_local_due_idx
        ON proactive_commitments(status, due_at);`,
      `CREATE TABLE IF NOT EXISTS proactive_workflow_templates (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        state TEXT NOT NULL DEFAULT 'candidate', trigger_json TEXT NOT NULL DEFAULT '{}',
        steps_json TEXT NOT NULL DEFAULT '[]', evidence_count INTEGER NOT NULL DEFAULT 1,
        success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0,
        last_observed_at TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS proactive_workflow_local_state_idx
        ON proactive_workflow_templates(state);`,
      `CREATE TABLE IF NOT EXISTS proactive_trigger_rules (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, name TEXT NOT NULL, trigger_type TEXT NOT NULL,
        condition_json TEXT NOT NULL DEFAULT '{}', action_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 0,
        cooldown_seconds INTEGER NOT NULL DEFAULT 3600, quiet_hours_json TEXT NOT NULL DEFAULT '{}',
        last_triggered_at TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS proactive_trigger_rule_local_enabled_idx
        ON proactive_trigger_rules(enabled);`,
      `CREATE TABLE IF NOT EXISTS proactive_trigger_events (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, rule_id TEXT, trigger_type TEXT NOT NULL, cause_json TEXT NOT NULL DEFAULT '{}',
        decision TEXT NOT NULL, reason TEXT, action_id TEXT, occurred_at TEXT NOT NULL,
        processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS proactive_trigger_event_local_occurred_idx
        ON proactive_trigger_events(occurred_at);`,
      `CREATE TABLE IF NOT EXISTS proactive_action_verifications (
        id TEXT PRIMARY KEY, action_id TEXT NOT NULL, expected_json TEXT NOT NULL DEFAULT '{}', observed_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0,
        verified_at TEXT, error TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS proactive_action_verification_local_action_idx
        ON proactive_action_verifications(action_id);`,
      `CREATE TABLE IF NOT EXISTS proactive_claim_conflicts (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, primary_claim_id TEXT NOT NULL, conflicting_claim_id TEXT NOT NULL,
        reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, resolved_at TEXT,
        processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS proactive_claim_conflict_pair_idx
        ON proactive_claim_conflicts(primary_claim_id, conflicting_claim_id);`,
      `CREATE TABLE IF NOT EXISTS proactive_preparation_bundles (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, project_id TEXT, commitment_id TEXT, title TEXT NOT NULL,
        bundle_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ready', available_at TEXT NOT NULL,
        expires_at TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS proactive_preparation_local_available_idx
        ON proactive_preparation_bundles(status, available_at);`,
      `CREATE TABLE IF NOT EXISTS proactive_attention_states (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
        focus_score INTEGER NOT NULL, fatigue_score INTEGER NOT NULL, context_switches INTEGER NOT NULL DEFAULT 0,
        error_signals INTEGER NOT NULL DEFAULT 0, recommendation TEXT, evidence_json TEXT NOT NULL DEFAULT '[]',
        processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS proactive_attention_local_window_idx
        ON proactive_attention_states(window_end);`,
      `CREATE TABLE IF NOT EXISTS proactive_drift_signals (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, signal_type TEXT NOT NULL, project_id TEXT,
        expected_json TEXT NOT NULL DEFAULT '{}', actual_json TEXT NOT NULL DEFAULT '{}', severity INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'open', explanation TEXT, detected_at TEXT NOT NULL,
        processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS proactive_drift_local_state_idx
        ON proactive_drift_signals(state);`,
      `CREATE TABLE IF NOT EXISTS proactive_scene_snapshots (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, scene_type TEXT NOT NULL, application_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}', checksum TEXT NOT NULL, captured_at TEXT NOT NULL,
        processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS proactive_scene_local_checksum_idx
        ON proactive_scene_snapshots(checksum);`,
      `CREATE TABLE IF NOT EXISTS proactive_review_reports (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, period_type TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
        summary TEXT NOT NULL, metrics_json TEXT NOT NULL DEFAULT '{}', recommendations_json TEXT NOT NULL DEFAULT '[]',
        processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS proactive_review_local_period_idx
        ON proactive_review_reports(period_type, period_start, period_end);`,
      `CREATE TABLE IF NOT EXISTS proactive_external_connections (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, provider TEXT NOT NULL, display_name TEXT NOT NULL, endpoint TEXT,
        auth_type TEXT NOT NULL, credential_json TEXT NOT NULL DEFAULT '{}', scopes_json TEXT NOT NULL DEFAULT '[]',
        settings_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'active', last_sync_at TEXT,
        last_error TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS proactive_connection_local_provider_idx
        ON proactive_external_connections(provider, state);`,
      `CREATE TABLE IF NOT EXISTS proactive_home_entities (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, entity_id TEXT NOT NULL, domain TEXT NOT NULL, display_name TEXT, device_class TEXT,
        allowed_ops_json TEXT NOT NULL DEFAULT '[]', state_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 0,
        sensitive INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS proactive_home_connection_entity_idx
        ON proactive_home_entities(connection_id, entity_id);`,
      `CREATE TABLE IF NOT EXISTS proactive_health_samples (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, metric TEXT NOT NULL, local_date TEXT NOT NULL, value INTEGER NOT NULL, unit TEXT NOT NULL,
        sensitivity TEXT NOT NULL DEFAULT 'low', source TEXT NOT NULL DEFAULT 'xiaomi_health',
        metadata_json TEXT NOT NULL DEFAULT '{}', observed_at TEXT NOT NULL,
        processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS proactive_health_local_metric_date_idx
        ON proactive_health_samples(connection_id, metric, local_date);`,
    ];
  for (const ddl of proactiveIntelligenceDdl) await client.execute(ddl);
}
