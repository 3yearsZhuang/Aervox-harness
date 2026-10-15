import type { Client } from "@libsql/client";

export async function createBotTables(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS bot_connections (
    id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, plugin_id TEXT NOT NULL, display_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'stopped',
    config_json TEXT NOT NULL DEFAULT '{}', secret_cipher TEXT, checkpoint_cipher TEXT,
    account_id TEXT, owner_sender_id TEXT, last_error TEXT, lease_owner TEXT, lease_until TEXT,
    pairing_hash TEXT, pairing_expires_at TEXT, pairing_candidate TEXT, created_at TEXT NOT NULL
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS bot_session_bindings (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES bot_connections(id) ON DELETE CASCADE,
    route_key TEXT NOT NULL, session_id TEXT NOT NULL
  )`);
  await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS bot_session_route_idx ON bot_session_bindings(connection_id, route_key)`);
  await client.execute(`CREATE TABLE IF NOT EXISTS bot_inbox (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES bot_connections(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, message_json TEXT NOT NULL, connection_revision INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', turn_id TEXT, created_at TEXT NOT NULL, last_error TEXT
  )`);
  await client.execute(`CREATE INDEX IF NOT EXISTS bot_inbox_pending_idx ON bot_inbox(connection_id, state, created_at)`);
  await client.execute(`CREATE TABLE IF NOT EXISTS bot_deliveries (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES bot_connections(id) ON DELETE CASCADE,
    inbox_id TEXT NOT NULL REFERENCES bot_inbox(id) ON DELETE CASCADE, part_index INTEGER NOT NULL,
    text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', platform_message_id TEXT, last_error TEXT, created_at TEXT NOT NULL
  )`);
  await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS bot_delivery_part_idx ON bot_deliveries(inbox_id, part_index)`);
}
