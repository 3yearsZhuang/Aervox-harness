import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { memoryRecords, messages, messageVersions, sessions, turns } from "@aervox/schema";
import { createInMemoryDatabase } from "../src/client.js";
import type { AervoxDatabase } from "../src/database.js";
import { createPostgresQueryRuntime } from "../src/driver/postgres-session.js";
import { createPostgresRepositoryConnection } from "../src/driver/repository-connection.js";
import { initializePostgresqlSchema } from "../src/schema/postgresql.js";
import { SqliteConversationRepository } from "../src/repositories/sqlite/conversation-repository.js";
import { registerDatabaseBackend } from "../src/database-backend.js";
import { nodeConversationHost } from "../src/conversation-host-node.js";
import { renderTurnIntentMessage, turnIntentHashWithHost, type NormalizedTurnIntent } from "../src/conversation-turn-intent-neutral.js";
import {
  indexMemoryFts, indexMessageFts, searchMemoriesFts, searchMessagesFts, rebuildSearchProjections, rebuildMessageFts,
  type FtsConnection, type ProjectionWriter,
} from "../src/search/fts.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const postgresUrl = process.env.AERVOX_PG_TEST_URL ?? process.env.AERVOX_TEST_POSTGRES_URL;
type Fixture = { db: AervoxDatabase; client: FtsConnection; cleanup(): Promise<void>;
  write(operation: (writer: ProjectionWriter) => Promise<void>, rollback?: boolean): Promise<void> };

async function fixture(backend: "sqlite" | "postgresql"): Promise<Fixture> {
  if (backend === "sqlite") {
    const database = await createInMemoryDatabase();
    return { ...database, async write(operation, rollback) {
      const tx = await database.client.transaction("write");
      try { await operation(tx); if (rollback) await tx.rollback(); else await tx.commit(); }
      catch (error) { if (!tx.closed) await tx.rollback(); throw error; }
      finally { tx.close(); }
    } };
  }
  const schema = `aervox_fts_${randomUUID().replaceAll("-", "")}`;
  const instanceId = randomUUID();
  const admin = new Pool({ connectionString: postgresUrl });
  const setup = await admin.connect();
  try {
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await initializePostgresqlSchema({ schema, instanceId, client: { query: (text, values) => setup.query(text, values) } });
  } catch (error) {
    await setup.query("ROLLBACK");
    await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    setup.release(); await admin.end(); throw error;
  }
  setup.release();
  const runtime = createPostgresQueryRuntime(new Pool({ connectionString: postgresUrl }), { schema, instanceId });
  const client = createPostgresRepositoryConnection(runtime);
  return { db: runtime.db, client, async cleanup() {
    await client.close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  }, async write(operation, rollback) {
    const tx = await client.transaction("write");
    try { await operation(tx); if (rollback) await tx.rollback(); else await tx.commit(); }
    catch (error) { if (!tx.closed) await tx.rollback(); throw error; }
    finally { await tx.close(); }
  } };
}

for (const backend of ["sqlite", "postgresql"] as const) {
  describe.skipIf(backend === "postgresql" && !postgresUrl)(`${backend} full-text projections retain live source qualification`, () => {
    let database: Fixture;
    beforeEach(async () => { database = await fixture(backend); });
    afterEach(async () => { await database?.cleanup(); });
    const memory = (id: string, content: string, isDeleted = 0) => database.db.insert(memoryRecords)
      .values({ id, layer: "long_term", type: "user_fact", content, isDeleted });
    const memorySearch = (query: string) => searchMemoriesFts(database.client, local, query);
    async function message(content = "messagecanary") {
      await database.db.insert(sessions).values({ id: "session", title: "FTS source fixture" });
      await database.db.insert(turns).values({ id: "turn", sessionId: "session", idempotencyKey: "turn", status: "Completed" });
      await database.db.insert(messages).values({ id: "message", sessionId: "session", role: "user", currentVersionId: "message" });
      await database.db.insert(messageVersions).values({ id: "message", messageId: "message", turnId: "turn", role: "user", version: 1, content });
    }
    async function acceptedSources() {
      const conversations = new SqliteConversationRepository(database.db);
      await conversations.getOrCreateSession(local, "session");
      for (const id of ["historical", "text"]) {
        await conversations.acceptTurn(local, { turnId: id, sessionId: "session", idempotencyKey: id, attemptId: `${id}-attempt`,
          message: { id: `${id}-input`, content: `${id} canary` }, consumeInbox: false });
        await conversations.finalizeAttemptWithEventAtomically(local, { turnId: id, attemptId: `${id}-attempt`, expectedFencingToken: 0,
          sequence: 1, status: "Completed", eventType: "done", eventData: { status: "Completed", isComplete: true }, safetyDecision: "approved" });
        await database.db.insert(memoryRecords).values({ id: `${id}-memory`, layer: "long_term", type: "user_fact",
          content: `${id} canary`, sourceTurnId: id });
      }
      await rebuildSearchProjections(database.client);
    }

    it("rejects nonexistent and forged memory bodies even if stale index rows exist", async () => {
      await indexMemoryFts(database.client, local, { id: "missing", content: "ghostcanary" });
      expect((await database.client.execute("SELECT id FROM memories_fts")).rows).toEqual([]);
      await memory("memory", "currentcanary");
      await indexMemoryFts(database.client, local, { id: "memory", content: "forgedcanary" });
      await database.client.execute({ sql: "INSERT INTO memories_fts(id, content) VALUES (?, ?)", args: ["missing", "ghostcanary"] });
      await database.client.execute({ sql: "INSERT INTO memories_fts(id, content) VALUES (?, ?)", args: ["memory", "forgedcanary"] });
      expect(await memorySearch("ghostcanary")).toEqual([]);
      expect(await memorySearch("forgedcanary")).toEqual([]);
      await indexMemoryFts(database.client, local, { id: "memory", content: "currentcanary" });
      expect(await memorySearch("currentcanary")).toMatchObject([{ id: "memory" }]);
    });

    it("withdraws edited and deleted memory facts before asynchronous projection cleanup", async () => {
      await memory("memory", "oldcanary");
      await indexMemoryFts(database.client, local, { id: "memory", content: "oldcanary" });
      expect(await memorySearch("oldcanary")).toHaveLength(1);
      await database.db.update(memoryRecords).set({ content: "newcanary" }).where(eq(memoryRecords.id, "memory"));
      expect(await memorySearch("oldcanary")).toEqual([]);
      await indexMemoryFts(database.client, local, { id: "memory", content: "oldcanary" });
      expect((await database.client.execute("SELECT id FROM memories_fts")).rows).toEqual([]);
      await indexMemoryFts(database.client, local, { id: "memory", content: "newcanary" });
      const found = await memorySearch("newcanary");
      expect(found).toMatchObject([{ id: "memory" }]);
      expect(found[0]!.score).toBeLessThanOrEqual(0);
      await database.db.update(memoryRecords).set({ isDeleted: 1 }).where(eq(memoryRecords.id, "memory"));
      expect(await memorySearch("newcanary")).toEqual([]);
      await indexMemoryFts(database.client, local, { id: "memory", content: "newcanary" });
      expect((await database.client.execute("SELECT id FROM memories_fts")).rows).toEqual([]);
    });

    it("cannot use a stale message index after source edits or identity deletion", async () => {
      await message();
      await indexMessageFts(database.client, local, { id: "message", content: "messagecanary" });
      expect(await searchMessagesFts(database.client, local, "messagecanary")).toMatchObject([{ id: "message" }]);
      await database.db.update(messageVersions).set({ content: "correctedcanary" }).where(eq(messageVersions.id, "message"));
      expect(await searchMessagesFts(database.client, local, "messagecanary")).toEqual([]);
      await indexMessageFts(database.client, local, { id: "message", content: "correctedcanary" });
      expect(await searchMessagesFts(database.client, local, "correctedcanary")).toHaveLength(1);
      await database.db.update(messages).set({ deletedAt: new Date().toISOString() }).where(eq(messages.id, "message"));
      expect(await searchMessagesFts(database.client, local, "correctedcanary")).toEqual([]);
      await indexMessageFts(database.client, local, { id: "message", content: "correctedcanary" });
      expect((await database.client.execute("SELECT id FROM messages_fts")).rows).toEqual([]);
    });

    it("rebuilds only current facts in a real writer transaction and preserves projections on rollback", async () => {
      await memory("memory", "memorycanary"); await memory("deleted", "deletedcanary", 1); await message();
      await database.client.execute("INSERT INTO memories_fts(id, content) VALUES ('ghost', 'ghostcanary')");
      await database.client.execute("INSERT INTO messages_fts(id, content) VALUES ('ghost', 'ghostcanary')");
      await database.write(rebuildSearchProjections, true);
      expect((await database.client.execute("SELECT id FROM memories_fts")).rows.map(row => row.id)).toEqual(["ghost"]);
      expect((await database.client.execute("SELECT id FROM messages_fts")).rows.map(row => row.id)).toEqual(["ghost"]);
      await database.write(rebuildSearchProjections);
      expect((await database.client.execute("SELECT id FROM memories_fts")).rows.map(row => row.id)).toEqual(["memory"]);
      expect((await database.client.execute("SELECT id FROM messages_fts")).rows.map(row => row.id)).toEqual(["message"]);
      expect(await memorySearch("deletedcanary")).toEqual([]);
      expect(await searchMessagesFts(database.client, local, "messagecanary")).toMatchObject([{ id: "message" }]);
    });

    it("rejects canonical attachment sources and receipt drift in live reads, delayed indexes and both rebuilds", async () => {
      await acceptedSources();
      const original = JSON.parse(String((await database.client.execute(
        "SELECT payload FROM outbox_events WHERE id='outbox_historical'",
      )).rows[0]!.payload)) as { intent: NormalizedTurnIntent; requestHash: string; userMessage: string };
      const attachmentIntent: NormalizedTurnIntent = { ...original.intent, message: { ...original.intent.message,
        attachments: [{ attachmentId: "unverified-history", name: null, mediaType: "image/png" }] } };
      const attachmentHash = turnIntentHashWithHost(attachmentIntent, nodeConversationHost);
      const attachmentMessage = renderTurnIntentMessage(attachmentIntent);
      const cases = [
        { hash: attachmentHash, content: attachmentMessage,
          payload: JSON.stringify({ ...original, intent: attachmentIntent, requestHash: attachmentHash, userMessage: attachmentMessage }) },
        { hash: attachmentHash, content: attachmentMessage,
          payload: JSON.stringify({ ...original, intent: { ...attachmentIntent, message: { ...attachmentIntent.message, attachments: [] } },
            requestHash: attachmentHash, userMessage: attachmentMessage }) },
        { hash: original.requestHash, content: original.userMessage,
          payload: JSON.stringify({ ...original, intent: { ...original.intent, metadata: { changed: true } } }) },
        { hash: original.requestHash, content: original.userMessage, payload: "{" },
      ];
      for (const changed of cases) {
        await database.client.execute({ sql: "UPDATE turns SET request_hash=? WHERE id='historical'", args: [original.requestHash] });
        await database.client.execute({ sql: "UPDATE message_versions SET content=? WHERE id='historical-input'", args: [original.userMessage] });
        await database.client.execute({ sql: "UPDATE outbox_events SET payload=? WHERE id='outbox_historical'", args: [JSON.stringify(original)] });
        await rebuildSearchProjections(database.client);
        expect(await searchMessagesFts(database.client, local, "canary")).toHaveLength(2);
        expect(await memorySearch("canary")).toHaveLength(2);
        await database.client.execute({ sql: "UPDATE turns SET request_hash=? WHERE id='historical'", args: [changed.hash] });
        await database.client.execute({ sql: "UPDATE message_versions SET content=? WHERE id='historical-input'", args: [changed.content] });
        await database.client.execute({ sql: "UPDATE outbox_events SET payload=? WHERE id='outbox_historical'", args: [changed.payload] });
        expect((await searchMessagesFts(database.client, local, "canary")).map(row => row.id)).toEqual(["text-input"]);
        expect((await memorySearch("canary")).map(row => row.id)).toEqual(["text-memory"]);
        await indexMessageFts(database.client, local, { id: "historical-input", content: changed.content });
        await indexMemoryFts(database.client, local, { id: "historical-memory", content: "historical canary" });
        await rebuildMessageFts(database.client);
        expect((await database.client.execute("SELECT id FROM messages_fts ORDER BY id")).rows.map(row => row.id)).toEqual(["text-input"]);
        await rebuildSearchProjections(database.client);
        expect((await database.client.execute("SELECT id FROM messages_fts ORDER BY id")).rows.map(row => row.id)).toEqual(["text-input"]);
        expect((await database.client.execute("SELECT id FROM memories_fts ORDER BY id")).rows.map(row => row.id)).toEqual(["text-memory"]);
      }
    });

    it("does not index a different receipt after its digest was checked in the writer", async () => {
      await acceptedSources();
      const original = String((await database.client.execute("SELECT payload FROM outbox_events WHERE id='outbox_historical'")).rows[0]!.payload);
      const payload = JSON.parse(original) as { intent: NormalizedTurnIntent };
      const changed = JSON.stringify({ ...payload, intent: { ...payload.intent, metadata: { writerDrift: true } } });
      type Transaction = Awaited<ReturnType<FtsConnection["transaction"]>>;
      const afterReceiptRead: FtsConnection = {
        execute: database.client.execute.bind(database.client),
        async transaction(mode) {
          const writer = await database.client.transaction(mode);
          let changedOnce = false;
          const guarded: Transaction = {
            async execute(input) {
              const result = await writer.execute(input);
              if (!changedOnce && result.rows[0]?.evidence != null) {
                changedOnce = true;
                await writer.execute({ sql: "UPDATE outbox_events SET payload=? WHERE id='outbox_historical'", args: [changed] });
              }
              return result;
            },
            commit: writer.commit.bind(writer), rollback: writer.rollback.bind(writer), close: writer.close.bind(writer),
            get closed() { return writer.closed; },
          };
          registerDatabaseBackend(guarded, backend);
          return guarded;
        },
      };
      registerDatabaseBackend(afterReceiptRead, backend);
      await indexMessageFts(afterReceiptRead, local, { id: "historical-input", content: "historical canary" });
      expect((await database.client.execute("SELECT id FROM messages_fts WHERE id='historical-input'")).rows).toEqual([]);
      await database.client.execute({ sql: "UPDATE outbox_events SET payload=? WHERE id='outbox_historical'", args: [original] });
      await indexMemoryFts(afterReceiptRead, local, { id: "historical-memory", content: "historical canary" });
      expect((await database.client.execute("SELECT id FROM memories_fts WHERE id='historical-memory'")).rows).toEqual([]);
      expect(await searchMessagesFts(database.client, local, "text")).toMatchObject([{ id: "text-input" }]);
      expect(await memorySearch("text")).toMatchObject([{ id: "text-memory" }]);
    });
  });
}
