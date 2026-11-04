import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_EXCLUDED_TABLES,
  backupExclusionReason,
  isBackupScopedTable,
  isDerivedSearchTable,
  rebuildSearchProjections,
} from "../src/backup.js";
import { createDatabase, initDatabaseSchema, SqliteConversationRepository } from "../src/index.js";

describe("logical backup scope", () => {
 it("keeps derived projections, credential scope and schema metadata out of an envelope", () => {
  for (const name of ["messages_fts", "messages_fts_data", "messages_fts_idx", "messages_fts_content",
    "messages_fts_docsize", "messages_fts_config", "memories_fts", "memories_fts_docsize"]) {
    expect(isDerivedSearchTable(name), name).toBe(true);
    expect(isBackupScopedTable(name), name).toBe(false);
    expect(backupExclusionReason(name)).toBe("derived_search");
  }
  for (const name of BACKUP_EXCLUDED_TABLES) expect(isBackupScopedTable(name), name).toBe(false);
  expect(backupExclusionReason("_aervox_schema_versions")).toBe("schema_metadata");
  expect(backupExclusionReason("llm_configs")).toBe("credential_scope");
  // A table that merely contains the letters still counts as business data.
  for (const name of ["messages", "sessions", "questions", "knowledge_items", "memory_records", "personas"]) {
    expect(isBackupScopedTable(name), name).toBe(true);
    expect(backupExclusionReason(name)).toBeNull();
  }
  // Credential scope must not swallow business tables through a loose prefix match.
  expect(isBackupScopedTable("memory_records")).toBe(true);
  expect(isBackupScopedTable("bot_owner_sessions")).toBe(true);
 });
});

describe("search projection rebuild", () => {
 it("rebuilds both FTS tables from authoritative rows and leaves them writable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aervox-fts-rebuild-"));
  const database = await createDatabase({ url: `file:${join(directory, "main.db")}` });
  try {
    await initDatabaseSchema(database.client);
    const ctx = { workspaceId: "local", subjectUserId: "local" };
    const conversation = new SqliteConversationRepository(database.db);
    await conversation.getOrCreateSession(ctx, "session");
    await conversation.acceptTurn(ctx, { turnId: "turn", sessionId: "session", idempotencyKey: "turn",
      attemptId: "attempt", message: { id: "user", content: "问题" }, consumeInbox: false });
    await conversation.appendStreamEvent(ctx, { id: "message", turnId: "turn", attemptId: "attempt",
      expectedFencingToken: 0, sequence: 1, eventType: "message", data: { role: "assistant", messageId: "assistant" },
      safetyDecision: "approved" });
    await conversation.recordSafeSegmentAtomically(ctx, { turnId: "turn", attemptId: "attempt",
      expectedFencingToken: 0, sequence: 2, text: "可召回正文", safetyDecision: "approved",
      eventData: { messageId: "assistant", text: "可召回正文" } });
    await conversation.finalizeAttemptWithEventAtomically(ctx, { turnId: "turn", attemptId: "attempt",
      expectedFencingToken: 0, sequence: 3, status: "Completed", eventType: "done", eventData: { status: "Completed" },
      safetyDecision: "approved" });

    // A raw shadow-table write is exactly what a naive backup restore would do.
    await database.client.execute("INSERT INTO messages_fts(id, content) VALUES ('stale', '陈旧索引')");
    await database.client.execute({ sql: "INSERT INTO memory_records (id, layer, type, content, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      args: ["mem_live", "short_term", "user_fact", "记忆正文", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"] });

    await rebuildSearchProjections(database.client);
    const messages = await database.client.execute("SELECT id FROM messages_fts ORDER BY id");
    expect(messages.rows.map(row => row.id)).toEqual(["assistant", "user"].sort((a, b) => a < b ? -1 : 1));
    expect((await database.client.execute("SELECT id FROM messages_fts WHERE messages_fts MATCH '可召回正文'")).rows.length).toBeGreaterThan(0);
    expect(await database.client.execute("SELECT id FROM messages_fts WHERE messages_fts MATCH '陈旧索引'")).toMatchObject({ rows: [] });
    expect((await database.client.execute("SELECT id FROM memories_fts")).rows.map(row => row.id)).toEqual(["mem_live"]);

    // Deleted Memories stay out, matching deleteMemoryFts.
    await database.client.execute("UPDATE memory_records SET is_deleted = 1 WHERE id = 'mem_live'");
    await rebuildSearchProjections(database.client);
    expect((await database.client.execute("SELECT id FROM memories_fts")).rows).toEqual([]);

    // The rebuilt index accepts further writes; a corrupted shadow table would fail here.
    await database.client.execute("INSERT INTO messages_fts(id, content) VALUES ('after', '恢复后可写')");
    expect((await database.client.execute("SELECT id FROM messages_fts WHERE messages_fts MATCH '恢复后可写'")).rows.map(row => row.id)).toEqual(["after"]);
  } finally {
    database.client.close();
    rmSync(directory, { recursive: true, force: true });
  }
 });
});
