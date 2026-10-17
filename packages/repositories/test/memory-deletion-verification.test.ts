import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  MEMORY_DELETION_VERIFIER,
  SqliteMemoryCompactionRepository,
  SqliteMemoryDeletionStore,
  SqliteMemoryRepository,
  SqliteOutboxRepository,
} from "../src/index.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const tombstone = { memoryId: "target", snapshotId: "snapshot-target", deleted: true };

describe("Memory deletion independently verifies the complete tombstone", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let deletion: SqliteMemoryDeletionStore;
  let outbox: SqliteOutboxRepository;

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    deletion = new SqliteMemoryDeletionStore(database.db);
    outbox = new SqliteOutboxRepository(database.db);
    const memory = new SqliteMemoryRepository(database.db, database.client);
    const compaction = new SqliteMemoryCompactionRepository(database.db);
    for (const id of ["target", "keep"]) {
      await memory.createRecord(local, {
        id, layer: "long_term", type: "user_fact", content: `private source ${id}`,
      });
      await compaction.upsertMarker(local, {
        id: `marker-${id}`, memoryId: id, snapshotId: `snapshot-${id}`, summaryText: `private summary ${id}`,
      });
      await outbox.insertEvent(local, {
        id: `outbox-${id}`, idempotencyKey: `outbox-${id}`, eventType: "memory.compaction.requested",
        payload: { memoryId: id, snapshotId: `snapshot-${id}`, summaryText: `private summary ${id}` },
      });
    }
  });

  afterEach(async () => { await database.cleanup(); });

  async function setPayload(payload: unknown) {
    await database.db.run(sql`UPDATE outbox_events SET payload = ${JSON.stringify(payload)} WHERE id = 'outbox-target'`);
  }

  it("accepts repeated cleanup and preserves unrelated records, markers and events", async () => {
    const keepRecord = await database.db.all(sql`SELECT * FROM memory_records WHERE id = 'keep'`);
    const keepMarker = await database.db.all(sql`SELECT * FROM memory_compaction_markers WHERE memory_id = 'keep'`);
    const keepEvent = await outbox.getEventById("outbox-keep");
    await database.db.run(sql`UPDATE memory_records SET canonical_parent_id = 'keep', source_turn_id = 'turn', current_revision_id = 'revision' WHERE id = 'target'`);
    for (let attempt = 0; attempt < 2; attempt++) {
      await deletion.clean("target");
      await expect(deletion.verify("target")).resolves.toContain(MEMORY_DELETION_VERIFIER);
    }
    expect(await database.db.all(sql`SELECT * FROM memory_records WHERE id = 'keep'`)).toEqual(keepRecord);
    expect(await database.db.all(sql`SELECT * FROM memory_compaction_markers WHERE memory_id = 'keep'`)).toEqual(keepMarker);
    expect(await outbox.getEventById("outbox-keep")).toEqual(keepEvent);
    expect((await outbox.getEventById("outbox-target"))?.payload).toEqual(tombstone);
  });

  it.each([
    ["parent reference", sql`UPDATE memory_records SET canonical_parent_id = 'keep' WHERE id = 'target'`],
    ["source Turn reference", sql`UPDATE memory_records SET source_turn_id = 'turn' WHERE id = 'target'`],
    ["current revision reference", sql`UPDATE memory_records SET current_revision_id = 'revision' WHERE id = 'target'`],
    ["live marker status", sql`UPDATE memory_compaction_markers SET status = 'completed' WHERE memory_id = 'target'`],
    ["pending Outbox status", sql`UPDATE outbox_events SET status = 'pending' WHERE id = 'outbox-target'`],
    ["failed Outbox status", sql`UPDATE outbox_events SET status = 'failed' WHERE id = 'outbox-target'`],
    ["dead-letter Outbox status", sql`UPDATE outbox_events SET status = 'dead_letter' WHERE id = 'outbox-target'`],
  ] as const)("rejects retained %s and accepts a cleanup retry", async (_label, mutation) => {
    await deletion.clean("target");
    await database.db.run(mutation);
    await expect(deletion.verify("target")).rejects.toThrow("deletion_memory_verification_failed");
    await deletion.clean("target");
    await expect(deletion.verify("target")).resolves.toContain(MEMORY_DELETION_VERIFIER);
  });

  it.each([
    ["content under another key", { ...tombstone, extraContent: "private summary" }],
    ["unrecognized empty key", { ...tombstone, summaryText: null }],
    ["nested snapshot object", { ...tombstone, snapshotId: { content: "private summary" } }],
    ["nested snapshot array", { ...tombstone, snapshotId: ["private summary"] }],
    ["numeric snapshot identity", { ...tombstone, snapshotId: 7 }],
    ["numeric deletion marker", { ...tombstone, deleted: 1 }],
    ["string deletion marker", { ...tombstone, deleted: "true" }],
  ] as const)("rejects %s in an Outbox tombstone", async (_label, payload) => {
    await deletion.clean("target");
    await setPayload(payload);
    await expect(deletion.verify("target")).rejects.toThrow("deletion_memory_verification_failed");
    await deletion.clean("target");
    await expect(deletion.verify("target")).resolves.toContain(MEMORY_DELETION_VERIFIER);
    const cleaned = (await outbox.getEventById("outbox-target"))?.payload;
    expect(cleaned).toEqual({ ...tombstone, snapshotId: typeof payload.snapshotId === "string" ? payload.snapshotId : null });
  });

  it.each([
    { memoryId: "target", deleted: true },
    { memoryId: "target", snapshotId: null, deleted: true },
    tombstone,
  ])("accepts an identity-only Outbox tombstone: %j", async (payload) => {
    await deletion.clean("target");
    await setPayload(payload);
    await expect(deletion.verify("target")).resolves.toContain(MEMORY_DELETION_VERIFIER);
  });

  it("does not verify a missing target or a shared projection as complete", async () => {
    await expect(deletion.verify("missing")).rejects.toThrow("deletion_memory_target_unknown");
    await database.db.run(sql`UPDATE memory_records SET canonical_parent_id = 'target' WHERE id = 'keep'`);
    await expect(deletion.clean("target")).rejects.toThrow("deletion_memory_projection_requires_owner_cleanup");
    await expect(deletion.verify("target")).rejects.toThrow("deletion_memory_projection_requires_owner_cleanup");
    expect(await database.db.all(sql`SELECT content FROM memory_records WHERE id = 'target'`)).toEqual([{ content: "private source target" }]);
  });
});
