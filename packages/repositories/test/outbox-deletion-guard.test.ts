import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  MEMORY_DELETION_VERIFIER,
  SqliteMemoryDeletionStore,
  SqliteMemoryRepository,
  SqliteOutboxRepository,
} from "../src/index.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const compactionType = "memory.compaction.requested";

describe("Outbox failure writes respect Memory deletion", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let outbox: SqliteOutboxRepository;
  let deletion: SqliteMemoryDeletionStore;

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    outbox = new SqliteOutboxRepository(database.db);
    deletion = new SqliteMemoryDeletionStore(database.db);
    await new SqliteMemoryRepository(database.db, database.client).createRecord(local, {
      id: "memory", layer: "long_term", type: "user_fact", content: "private source",
    });
  });

  afterEach(async () => { await database.cleanup(); });

  async function queue(eventType = compactionType, deleted = false) {
    await outbox.insertEvent(local, {
      id: "event", idempotencyKey: "event", eventType,
      payload: { memoryId: "memory", snapshotId: "snapshot", summaryText: "private summary", deleted },
    });
  }

  async function reportFailure(kind: "retry" | "dead_letter", reason: string, eventId = "event") {
    if (kind === "retry") {
      return outbox.markFailed(eventId, reason);
    }
    await outbox.markDeadLetter(eventId, reason);
    return undefined;
  }

  it.each(["retry", "dead_letter"] as const)("late %s after clean and verify cannot restore error content or retry state", async (kind) => {
    await queue();
    // A worker retains content fetched before cleanup, then reports its error after verification.
    const [fetched] = await outbox.fetchPendingEvents({ eventType: compactionType });
    const error = `provider rejected ${(fetched!.payload as { summaryText: string }).summaryText}`;
    await deletion.clean("memory");
    await expect(deletion.verify("memory")).resolves.toContain(MEMORY_DELETION_VERIFIER);
    const cleared = await outbox.getEventById("event");

    const result = await reportFailure(kind, error);

    if (kind === "retry") expect(result).toBeNull();
    expect(await outbox.getEventById("event")).toEqual(cleared);
    expect(await outbox.fetchPendingEvents({ eventType: compactionType, includeRetriable: true })).toEqual([]);
    await expect(deletion.verify("memory")).resolves.toContain(MEMORY_DELETION_VERIFIER);
  });

  it.each(["retry", "dead_letter"] as const)("cleanup removes %s errors committed before deletion", async (kind) => {
    await queue();
    await reportFailure(kind, "provider rejected private summary");
    expect((await outbox.getEventById("event"))?.lastError).toContain("private summary");

    await deletion.clean("memory");

    expect(await outbox.getEventById("event")).toMatchObject({ status: "published", lastError: null });
    await expect(deletion.verify("memory")).resolves.toContain(MEMORY_DELETION_VERIFIER);
  });

  it.each([
    ["retry", "tombstoned"], ["dead_letter", "tombstoned"],
    ["retry", "missing"], ["dead_letter", "missing"],
  ] as const)("%s checks the %s source even when payload has no deletion marker", async (kind, sourceState) => {
    await queue();
    // A different live source must neither authorize this event's stale write
    // nor lose its own retry/dead-letter behavior when this source is removed.
    await new SqliteMemoryRepository(database.db, database.client).createRecord(local, {
      id: "keep", layer: "long_term", type: "user_fact", content: "retained source",
    });
    await outbox.insertEvent(local, {
      id: "keep-event", idempotencyKey: "keep-event", eventType: compactionType,
      payload: { memoryId: "keep", snapshotId: "keep-snapshot", summaryText: "retained summary" },
    });
    if (sourceState === "tombstoned") {
      await database.db.run(sql`UPDATE memory_records SET is_deleted = 1 WHERE id = 'memory'`);
    } else {
      await database.db.run(sql`DELETE FROM memory_records WHERE id = 'memory'`);
    }
    const before = await outbox.getEventById("event");

    const result = await reportFailure(kind, "late private failure");

    if (kind === "retry") expect(result).toBeNull();
    expect(await outbox.getEventById("event")).toEqual(before);
    await reportFailure(kind, "retained failure", "keep-event");
    expect(await outbox.getEventById("keep-event")).toMatchObject({
      status: kind === "retry" ? "failed" : "dead_letter",
      retryCount: kind === "retry" ? 1 : 0,
      lastError: "retained failure",
    });
  });

  it.each(["retry", "dead_letter"] as const)("%s also respects an event deletion marker while its source exists", async (kind) => {
    await queue(compactionType, true);
    const before = await outbox.getEventById("event");

    const result = await reportFailure(kind, "late private failure");

    if (kind === "retry") expect(result).toBeNull();
    expect(await outbox.getEventById("event")).toEqual(before);
  });

  it("retains retry escalation and explicit dead-letter behavior for live compaction sources", async () => {
    await queue();
    expect(await outbox.markFailed("event", "first error", { maxRetries: 2 })).toMatchObject({ status: "failed", retryCount: 1 });
    expect((await outbox.fetchPendingEvents({ includeRetriable: true }))).toHaveLength(1);
    expect(await outbox.markFailed("event", "second error", { maxRetries: 2 })).toMatchObject({ status: "dead_letter", retryCount: 2 });
    await outbox.markDeadLetter("event", "permanent reason");
    expect(await outbox.getEventById("event")).toMatchObject({ status: "dead_letter", retryCount: 2, lastError: "permanent reason" });
  });

  it("does not apply Memory source checks to other event types", async () => {
    await queue("turn.created", true);
    await database.db.run(sql`DELETE FROM memory_records WHERE id = 'memory'`);

    expect(await outbox.markFailed("event", "retry reason")).toMatchObject({ status: "failed", retryCount: 1 });
    await outbox.markDeadLetter("event", "terminal reason");

    expect(await outbox.getEventById("event")).toMatchObject({ status: "dead_letter", retryCount: 1, lastError: "terminal reason" });
  });
});
