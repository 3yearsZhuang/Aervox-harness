/**
 * Aervox｜思隅 @aervox/repositories — conversations 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";
import { addColumnIfMissing } from "./common.js";

export async function createConversationsTables(client: Client): Promise<void> {
  // 1. 会话与 Turn
    await client.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS sessions_tenant_idx ON sessions(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Created',
        last_sequence INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        request_hash TEXT,
        accepted_at TEXT,
        cancelled_at TEXT,
        completed_at TEXT,
        quote_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS turns_tenant_idempotency_idx ON turns(workspace_id, subject_user_id, idempotency_key);
    `);
  // CAP-013：为存量 turns 表补充 quote_message_id 列（迁移）
    await client.execute(`ALTER TABLE turns ADD COLUMN quote_message_id TEXT;`).catch(() => {});
  await client.execute(`
      CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS message_versions (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        message_id TEXT,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        content TEXT NOT NULL,
        is_redacted INTEGER NOT NULL DEFAULT 0,
        superseded_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS message_versions_turn_ver_idx ON message_versions(turn_id, version);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS message_versions_tenant_idx ON message_versions(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS turn_stream_events (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        attempt_id TEXT,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_version INTEGER NOT NULL DEFAULT 1,
        data TEXT NOT NULL,
        safety_decision TEXT,
        visibility_revision INTEGER NOT NULL DEFAULT 0,
        occurred_at TEXT NOT NULL,
        committed_at TEXT
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS turn_stream_events_turn_seq_idx ON turn_stream_events(turn_id, sequence);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        current_version_id TEXT,
        label TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS turn_attempts (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL DEFAULT 1,
        lease_id TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'Running',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        lease_expires_at TEXT
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS turn_attempts_turn_attempt_idx ON turn_attempts(turn_id, attempt);
    `);
  // 3b-A：旧库补齐租约过期列（新库已含；ALTER ADD COLUMN 幂等）
    await addColumnIfMissing(client, "turn_attempts", "lease_expires_at", "lease_expires_at TEXT");
  // 15. P1：会话地图分支 + 知识关系（PRD §8）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS conversation_branches (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        fork_at_message_id TEXT,
        child_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS conversation_branches_parent_idx ON conversation_branches(parent_session_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS conversation_branches_tenant_idx ON conversation_branches(workspace_id, subject_user_id);
    `);
  // CAP-014：扩展分支表（标题、原因、状态、布局、软删除）
    await addColumnIfMissing(client, "conversation_branches", "title", "title TEXT");
  await addColumnIfMissing(client, "conversation_branches", "branch_reason", "branch_reason TEXT");
  await addColumnIfMissing(client, "conversation_branches", "status", "status TEXT NOT NULL DEFAULT 'active'");
  await addColumnIfMissing(client, "conversation_branches", "merged_at", "merged_at TEXT");
  await addColumnIfMissing(client, "conversation_branches", "layout_data", "layout_data TEXT");
  await addColumnIfMissing(client, "conversation_branches", "deleted_at", "deleted_at TEXT");
  await client.execute(`
      CREATE INDEX IF NOT EXISTS conversation_branches_status_idx ON conversation_branches(status);
    `);
}
