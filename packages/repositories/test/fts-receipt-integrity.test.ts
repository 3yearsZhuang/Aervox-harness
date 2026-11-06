import { afterEach, beforeEach, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteMemoryRepository,
  indexMessageFts, indexMemoryFts, searchMessagesFts, searchMemoriesFts, rebuildSearchProjections } from "../src/index.js";
import { rebuildSearchProjections as portableRebuild } from "../src/backup.js";
import { nodeConversationHost } from "../src/conversation-host-node.js";
import { corruptReceipt } from "./helpers/receipt-corruption.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
beforeEach(async () => {
  database = await createInMemoryDatabase();
  const conversations = new SqliteConversationRepository(database.db);
  const memories = new SqliteMemoryRepository(database.db, database.client);
  await conversations.getOrCreateSession(ctx, "session");
  for (const id of ["historical", "text"]) {
    await conversations.acceptTurn(ctx, { turnId: id, sessionId: "session", idempotencyKey: id, attemptId: `${id}-attempt`,
      message: { id: `${id}-input`, content: `${id} canary` }, consumeInbox: false });
    await conversations.finalizeAttemptWithEventAtomically(ctx, { turnId: id, attemptId: `${id}-attempt`, expectedFencingToken: 0,
      sequence: 1, status: "Completed", eventType: "done", eventData: {status: "Completed", isComplete: true}, safetyDecision: "approved" });
    await memories.createRecord(ctx, { id: `${id}-memory`, layer: "long_term", type: "user_fact", content: `${id} canary`, sourceTurnId: id });
    await indexMessageFts(database.client, ctx, { id: `${id}-input`, content: `${id} canary` });
    await indexMemoryFts(database.client, ctx, { id: `${id}-memory`, content: `${id} canary` });
  }
});
afterEach(() => database.cleanup());

it("denies canonical empty-attachment hash drift in live searches, late writers and both rebuilds", async () => {
  expect(await searchMessagesFts(database.client, ctx, "canary")).toHaveLength(2);
  expect(await searchMemoriesFts(database.client, ctx, "canary")).toHaveLength(2);
  await corruptReceipt(database.client, "historical", {name: "removed attachments", historicalAttachmentRemoved: true});
  expect((await searchMessagesFts(database.client, ctx, "canary")).map(row => row.id)).toEqual(["text-input"]);
  expect((await searchMemoriesFts(database.client, ctx, "canary")).map(row => row.id)).toEqual(["text-memory"]);
  await indexMessageFts(database.client, ctx, {id: "historical-input", content: "historical canary"});
  await indexMemoryFts(database.client, ctx, {id: "historical-memory", content: "historical canary"});
  await rebuildSearchProjections(database.client);
  expect((await database.client.execute("SELECT id FROM messages_fts ORDER BY id")).rows.map(row => row.id)).toEqual(["text-input"]);
  expect((await database.client.execute("SELECT id FROM memories_fts ORDER BY id")).rows.map(row => row.id)).toEqual(["text-memory"]);
});

it("portable rebuild fails closed for known receipts without crypto and consumes an existing writer", async () => {
  await portableRebuild(database.client);
  expect((await database.client.execute("SELECT count(*) AS total FROM messages_fts")).rows[0]?.total).toBe(0);
  const writer = await database.client.transaction("write");
  try {
    await portableRebuild({execute: writer.execute.bind(writer)}, nodeConversationHost);
    expect((await writer.execute("SELECT count(*) AS total FROM messages_fts")).rows[0]?.total).toBe(2);
    await writer.rollback();
  } finally { writer.close(); }
  expect((await database.client.execute("SELECT count(*) AS total FROM messages_fts")).rows[0]?.total).toBe(0);
  await portableRebuild(database.client, nodeConversationHost);
  expect(await searchMessagesFts(database.client, ctx, "canary")).toHaveLength(2);
});

it("bounds selected search identities and refuses negative or noninteger limits", async () => {
  for (const limit of [-1, NaN, Infinity, 1.5]) {
    await expect(searchMessagesFts(database.client, ctx, "canary", limit)).rejects.toThrow("invalid_fts_search_limit");
    await expect(searchMemoriesFts(database.client, ctx, "canary", limit)).rejects.toThrow("invalid_fts_search_limit");
  }
  expect(await searchMessagesFts(database.client, ctx, "canary", 0)).toEqual([]);
  expect(await searchMemoriesFts(database.client, ctx, "canary", 0)).toEqual([]);
});

it("caps real message and Memory candidate pages even when the caller asks for more", async () => {
  await database.client.execute(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<510)
    INSERT INTO turns (id, session_id, idempotency_key, status, created_at, updated_at)
    SELECT printf('bounded-turn-%04d',n), 'session', printf('bounded-turn-%04d',n), 'Completed',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM ids`);
  await database.client.execute(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<510)
    INSERT INTO message_versions (id, turn_id, role, content, created_at)
    SELECT printf('bounded-message-%04d',n), printf('bounded-turn-%04d',n), 'user', 'boundedcanary', '2026-01-01T00:00:00Z' FROM ids`);
  await database.client.execute(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<510)
    INSERT INTO memory_records (id, layer, type, content, created_at, updated_at)
    SELECT printf('bounded-memory-%04d',n), 'long_term', 'user_fact', 'boundedcanary',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM ids`);
  await rebuildSearchProjections(database.client);
  expect((await database.client.execute("SELECT count(*) AS total FROM messages_fts WHERE messages_fts MATCH 'boundedcanary'")).rows[0]?.total).toBe(510);
  expect((await database.client.execute("SELECT count(*) AS total FROM memories_fts WHERE memories_fts MATCH 'boundedcanary'")).rows[0]?.total).toBe(510);
  const selected: number[] = [];
  const reader = {execute: async (...args: Parameters<Client["execute"]>) => {
    const result = await database.client.execute(...args);
    selected.push(result.rows.length);
    return result;
  }} as Client;
  expect(await searchMessagesFts(reader, ctx, "boundedcanary", 10_000)).toHaveLength(500);
  expect(await searchMemoriesFts(reader, ctx, "boundedcanary", 10_000)).toHaveLength(500);
  expect(Math.max(...selected)).toBe(500);
  expect(selected.filter(count => count > 1)).toEqual([500, 500]);
});

it("rechecks a Memory tombstone after selecting a ranked identity", async () => {
  let reads = 0;
  const reader = {execute: async (...args: Parameters<Client["execute"]>) => {
    const result = await database.client.execute(...args);
    if (++reads === 1) await database.client.execute("UPDATE memory_records SET is_deleted = 1 WHERE id = 'text-memory'");
    return result;
  }} as Client;
  expect(await searchMemoriesFts(reader, ctx, "text")).toEqual([]);
  expect(await searchMemoriesFts(database.client, ctx, "text")).toEqual([]);
});
