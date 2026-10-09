import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqlitePrivacyRepository, SqlitePlatformRepository, SqliteMemoryRepository, SqliteMemoryEmbeddingRepository, SqliteMemoryDeletionStore, indexMemoryFts, searchMemoriesFts } from "@aervox/repositories";
import { runDeletionCycle, type DeletionWorkerContext } from "../src/deletion-worker.js";
import { SqliteMemoryCompactionRepository, SqliteOutboxRepository, MemoryCompactionUnavailableError } from "@aervox/repositories";
import { runCompactionMarkerCycle, COMPACTION_EVENT_TYPE } from "../src/compaction-marker.js";
const local = { workspaceId: "local", subjectUserId: "local" };
describe("verified Memory deletion", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let ctx: DeletionWorkerContext;
  beforeEach(async () => {
    database = await createInMemoryDatabase(); await initDatabaseSchema(database.client);
    ctx = { db: database.db, privacyRepo: new SqlitePrivacyRepository(database.db), platformRepo: new SqlitePlatformRepository(database.db), workerId: "test" };
    const memory = new SqliteMemoryRepository(database.db, database.client);
    const embeddings = new SqliteMemoryEmbeddingRepository(database.db);
    for (const id of ["remove", "keep"]) {
      await memory.createRecord(local, { id, layer: "long_term", type: "user_fact", content: `privateword ${id}` });
      await indexMemoryFts(database.client, local, { id, content: `privateword ${id}` });
      await embeddings.insertBatch(local, [{ id: `vec_${id}`, memoryId: id, vector: [1, 0], modelId: "test" }]);
      await database.client.execute({ sql: "INSERT INTO memory_revisions (id, memory_id, content, created_at) VALUES (?, ?, ?, ?)", args: [`rev_${id}`, id, `privateword ${id}`, new Date().toISOString()] });
    }
  });
  afterEach(async () => { vi.restoreAllMocks(); await database.cleanup(); });
  const request = (scope = "memory", targets = [{ targetType: "memory", targetId: "remove", ownerModule: "memory" }]) => ctx.privacyRepo.createDeletionRequest(local, { id: "request", idempotencyKey: "request", scope, ownerModule: "memory", targets });
  it("clears business content, revision, FTS and vectors, preserves unrelated data, and records verifiable evidence", async () => {
    await request();
    expect(await ctx.privacyRepo.hasPendingDeletionRequest(local)).toBe(true);
    expect(await runDeletionCycle(ctx)).toBe(1);
    expect(await runDeletionCycle(ctx)).toBe(0);
    expect((await searchMemoriesFts(database.client, local, "privateword")).map((r) => r.id)).toEqual(["keep"]);
    expect((await database.client.execute("SELECT memory_id FROM memory_embeddings")).rows.map((r) => r.memory_id)).toEqual(["keep"]);
    expect((await database.client.execute("SELECT content FROM memory_revisions WHERE memory_id = 'remove'")).rows[0]!.content).toBe("");
    const target = (await database.client.execute("SELECT * FROM deletion_targets")).rows[0]!;
    expect(target.status).toBe("completed");
    expect(JSON.parse(String(target.evidence_ref))).toMatchObject({ verifier: "memory-local-v2", ftsRows: 0, vectorRows: 0 });
    expect(await ctx.privacyRepo.hasPendingDeletionRequest(local)).toBe(false);
    // An indexer that started before deletion cannot reinsert its late result.
    await indexMemoryFts(database.client, local, { id: "remove", content: "late privateword" });
    await new SqliteMemoryEmbeddingRepository(database.db).insertBatch(local, [{ id: "late", memoryId: "remove", vector: [1, 0], modelId: "test" }]);
    await expect(new SqliteMemoryDeletionStore(database.db).verify("remove")).resolves.toContain("memory-local-v2");
  });
  it.each([false, true])("deletion clears queued copies and rejects an already fetched compaction payload: %s", async (alreadyFetched) => {
    const outboxRepo = new SqliteOutboxRepository(database.db);
    const compactionRepo = new SqliteMemoryCompactionRepository(database.db);
    const event = { id: "queued", idempotencyKey: "queued", eventType: COMPACTION_EVENT_TYPE,
      payload: { memoryId: "remove", snapshotId: "snapshot", summaryText: "private summary" } };
    await outboxRepo.insertEvent(local, event);
    const fetched = await outboxRepo.fetchPendingEvents({ eventType: COMPACTION_EVENT_TYPE });
    await request();
    expect(await runDeletionCycle(ctx)).toBe(1);
    expect((await outboxRepo.getEventById("queued"))?.payload).toEqual({ memoryId: "remove", snapshotId: "snapshot", deleted: true });
    if (alreadyFetched) vi.spyOn(outboxRepo, "fetchPendingEvents").mockResolvedValueOnce(fetched);
    expect(await runCompactionMarkerCycle({ outboxRepo, compactionRepo, workerId: "test" })).toBe(0);
    expect(await compactionRepo.getMarkerBySnapshotId(local, "snapshot")).toBeNull();
    await expect(outboxRepo.insertEvent(local, { ...event, id: "late", idempotencyKey: "late" })).rejects.toBeInstanceOf(MemoryCompactionUnavailableError);
    await expect(compactionRepo.recordEvent(local, { id: "late-audit", memoryId: "remove", action: "compressed", reason: "private reason" })).rejects.toBeInstanceOf(MemoryCompactionUnavailableError);
    await expect(new SqliteMemoryDeletionStore(database.db).verify("remove")).resolves.toContain("memory-local-v2");
    expect(await ctx.privacyRepo.hasPendingDeletionRequest(local)).toBe(false);
    expect(await runDeletionCycle(ctx)).toBe(0);
  });

  it("deletion between marker and audit writes cannot restore a cleared reason", async () => {
    const outboxRepo = new SqliteOutboxRepository(database.db);
    const compactionRepo = new SqliteMemoryCompactionRepository(database.db);
    await outboxRepo.insertEvent(local, { id: "queued", idempotencyKey: "queued", eventType: COMPACTION_EVENT_TYPE,
      payload: { memoryId: "remove", snapshotId: "snapshot", summaryText: "private summary" } });
    const recordEvent = compactionRepo.recordEvent.bind(compactionRepo);
    vi.spyOn(compactionRepo, "recordEvent").mockImplementationOnce(async (...args) => {
      await request();
      expect(await runDeletionCycle(ctx)).toBe(1);
      return recordEvent(...args);
    });
    expect(await runCompactionMarkerCycle({ outboxRepo, compactionRepo, workerId: "test" })).toBe(0);
    expect((await compactionRepo.getMarkerBySnapshotId(local, "snapshot"))?.summaryText).toBeNull();
    await expect(new SqliteMemoryDeletionStore(database.db).verify("remove")).resolves.toContain("memory-local-v2");
  });

  it.each(["empty", "unknown-scope", "unknown-target", "unknown-owner"])("%s cannot claim completion or release the gate", async (scenario) => {
    await request(scenario === "unknown-scope" ? "account" : "memory", scenario === "empty" ? [] : [{ targetType: "memory", targetId: scenario === "unknown-target" ? "absent" : "remove", ownerModule: scenario === "unknown-owner" ? "other" : "memory" }]);
    expect(await runDeletionCycle(ctx)).toBe(0);
    expect((await ctx.privacyRepo.getDeletionRequest(local, "request"))?.status).toBe("failed");
    expect(await ctx.privacyRepo.hasPendingDeletionRequest(local)).toBe(true);
  });
  it("failed index cleanup rolls back and later polling retries idempotently", async () => {
    await request();
    await database.client.execute("CREATE TRIGGER fail_vector BEFORE DELETE ON memory_embeddings BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(await runDeletionCycle(ctx)).toBe(0);
    expect(await ctx.privacyRepo.hasPendingDeletionRequest(local)).toBe(true);
    expect((await database.client.execute("SELECT content FROM memory_records WHERE id = 'remove'")).rows[0]!.content).toContain("privateword");
    await database.client.execute("DROP TRIGGER fail_vector");
    expect(await runDeletionCycle(ctx)).toBe(1);
    expect((await ctx.privacyRepo.getDeletionRequest(local, "request"))?.attemptCount).toBe(2);
  });
  it("independent verification detects residue and shared projections remain blocked", async () => {
    const store = new SqliteMemoryDeletionStore(database.db);
    await expect(store.verify("remove")).rejects.toThrow("verification_failed");
    await store.clean("remove");
    await database.client.execute("INSERT INTO memories_fts (id, content) VALUES ('remove', 'residue')");
    await expect(store.verify("remove")).rejects.toThrow("verification_failed");
    await database.client.execute("UPDATE memory_records SET canonical_parent_id = 'remove' WHERE id = 'keep'");
    await request();
    expect(await runDeletionCycle(ctx)).toBe(0);
    expect((await ctx.privacyRepo.getDeletionRequest(local, "request"))?.lastError).toContain("requires_owner_cleanup");
    expect((await database.client.execute("SELECT content FROM memory_records WHERE id = 'keep'")).rows[0]!.content).toContain("privateword");
  });
  it.each(["ev:old-worker:placeholder", JSON.stringify({ verifier: "memory-local-v1" })])("legacy completion %s is denied and retried with real cleanup", async (oldEvidence) => {
    await request();
    await ctx.privacyRepo.updateDeletionTargetStatus({ requestId: "request", targetType: "memory", targetId: "remove" }, "completed", oldEvidence);
    await ctx.privacyRepo.updateDeletionRequestStatus(local, "request", "completed", { lastVerifiedAt: new Date().toISOString() });
    expect(await ctx.privacyRepo.hasPendingDeletionRequest(local)).toBe(true);
    expect(await runDeletionCycle(ctx)).toBe(1);
    expect(await ctx.privacyRepo.hasPendingDeletionRequest(local)).toBe(false);
    expect((await searchMemoriesFts(database.client, local, "privateword")).map((row) => row.id)).toEqual(["keep"]);
  });

});
