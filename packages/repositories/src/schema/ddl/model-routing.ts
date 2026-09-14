/**
 * Aervox｜思隅 @aervox/repositories — 本地模型降级阶梯与健康探测 DDL (CR-034/CR-042)
 */
import type { Client } from "@libsql/client";

export async function createModelRoutingTables(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS llm_health_snapshots (
      preset_id TEXT PRIMARY KEY,
      provider_type TEXT NOT NULL,
      endpoint_identity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      consecutive_successes INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      last_probe_at TEXT,
      last_success_at TEXT,
      last_failure_at TEXT,
      error_category TEXT,
      error_message TEXT,
      cooldown_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS llm_routing_events (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      turn_id TEXT,
      from_tier TEXT NOT NULL,
      to_tier TEXT NOT NULL,
      from_preset_id TEXT,
      to_preset_id TEXT,
      reason TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS llm_routing_events_session_idx
    ON llm_routing_events(session_id, occurred_at);
  `);
}
