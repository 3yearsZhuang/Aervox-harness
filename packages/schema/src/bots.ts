import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Host-owned transport state. Platform plugins never import these tables. */
export const botConnections = sqliteTable("bot_connections", {
  id: text("id").primaryKey(), adapterId: text("adapter_id").notNull(), pluginId: text("plugin_id").notNull(),
  displayName: text("display_name").notNull(), enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  revision: integer("revision").notNull().default(1), state: text("state").notNull().default("stopped"),
  configJson: text("config_json").notNull().default("{}"), secretCipher: text("secret_cipher"), checkpointCipher: text("checkpoint_cipher"),
  accountId: text("account_id"), ownerSenderId: text("owner_sender_id"), lastError: text("last_error"),
  leaseOwner: text("lease_owner"), leaseUntil: text("lease_until"),
  pairingHash: text("pairing_hash"), pairingExpiresAt: text("pairing_expires_at"), pairingCandidate: text("pairing_candidate"),
  createdAt: text("created_at").notNull(),
});

export const botSessionBindings = sqliteTable("bot_session_bindings", {
  id: text("id").primaryKey(), connectionId: text("connection_id").notNull().references(() => botConnections.id, { onDelete: "cascade" }),
  routeKey: text("route_key").notNull(), sessionId: text("session_id").notNull(),
}, t => [uniqueIndex("bot_session_route_idx").on(t.connectionId, t.routeKey)]);

export const botInbox = sqliteTable("bot_inbox", {
  id: text("id").primaryKey(), connectionId: text("connection_id").notNull().references(() => botConnections.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(), messageJson: text("message_json").notNull(),
  connectionRevision: integer("connection_revision").notNull(), state: text("state").notNull().default("queued"),
  turnId: text("turn_id"), createdAt: text("created_at").notNull(), lastError: text("last_error"),
}, t => [index("bot_inbox_pending_idx").on(t.connectionId, t.state, t.createdAt)]);

export const botDeliveries = sqliteTable("bot_deliveries", {
  id: text("id").primaryKey(), connectionId: text("connection_id").notNull().references(() => botConnections.id, { onDelete: "cascade" }),
  inboxId: text("inbox_id").notNull().references(() => botInbox.id, { onDelete: "cascade" }),
  partIndex: integer("part_index").notNull(), text: text("text").notNull(), status: text("status").notNull().default("queued"),
  platformMessageId: text("platform_message_id"), lastError: text("last_error"), createdAt: text("created_at").notNull(),
}, t => [uniqueIndex("bot_delivery_part_idx").on(t.inboxId, t.partIndex)]);
