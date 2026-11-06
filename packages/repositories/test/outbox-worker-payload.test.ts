import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase, initDatabaseSchema, SqliteConversationRepository, SqliteOutboxRepository } from "../src/index.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const malformed = "{ invalid worker receipt";

describe("file SQLite worker Outbox payload isolation", () => {
  let directory: string;
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let outbox: SqliteOutboxRepository;
  let conversations: SqliteConversationRepository;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "aervox-worker-payload-"));
    database = await createDatabase({ url: `file:${path.join(directory, "outbox.db")}` });
    await initDatabaseSchema(database.client);
    outbox = new SqliteOutboxRepository(database.db);
    conversations = new SqliteConversationRepository(database.db);
    await conversations.getOrCreateSession(local, "session");
    for (const id of ["bad", "good"]) await conversations.acceptTurn(local, {
      turnId: id, sessionId: "session", idempotencyKey: id, attemptId: `attempt-${id}`,
      message: { id: `message-${id}`, content: id }, execution: "worker",
    });
    await database.client.execute({ sql: "UPDATE outbox_events SET payload=? WHERE id='outbox_bad'", args: [malformed] });
  });
  afterEach(async () => {
    database.client.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("returns a malformed worker receipt beside a valid object without poisoning the batch", async () => {
    const events = await outbox.fetchPendingEvents({ eventType: "agent.turn.requested", includeRetriable: true });
    expect(events.find(event => event.id === "outbox_bad")?.payload).toBe(malformed);
    expect(events.find(event => event.id === "outbox_good")?.payload).toMatchObject({ turnId: "good", execution: "worker" });
    expect(await outbox.getEventById("outbox_bad")).toMatchObject({ payload: malformed, status: "pending" });
  });

  it("dead-letters a poison receipt while the next valid accepted Turn can still complete", async () => {
    const events = await outbox.fetchPendingEvents({ eventType: "agent.turn.requested" });
    expect(events.map(event => event.id)).toEqual(["outbox_bad", "outbox_good"]);
    await outbox.markDeadLetter("outbox_bad", "invalid_delegated_turn_payload");
    expect(await outbox.getEventById("outbox_bad")).toMatchObject({ status: "dead_letter", lastError: "invalid_delegated_turn_payload" });
    expect((await outbox.fetchPendingEvents({ eventType: "agent.turn.requested" })).map(event => event.id)).toEqual(["outbox_good"]);
    expect(await conversations.hasWorkerDelegation("good", "outbox_good")).toBe(true);
    expect(await conversations.getAcceptedTurnParameters(local, "good")).toMatchObject({ userMessage: "good" });
    const claim = await conversations.claimTurnAttempt(local, {
      turnId: "good", attemptId: "attempt-good", leaseId: "worker", expectedFencingToken: 0,
    });
    expect(claim.ok).toBe(true);
    expect(await conversations.finalizeAttemptWithEventAtomically(local, {
      turnId: "good", attemptId: "attempt-good", status: "Completed", expectedFencingToken: claim.fencingToken,
      sequence: 1, eventType: "done", eventData: { status: "Completed" },
    })).toBe(true);
    await outbox.markPublished("outbox_good");
    expect((await conversations.listTurnAttempts(local, "good"))[0]?.status).toBe("Completed");
    expect(await outbox.fetchPendingEvents({ eventType: "agent.turn.requested" })).toEqual([]);
  });

  it("can record a retry for a raw poison receipt without mapping its payload after the write", async () => {
    expect(await outbox.markFailed("outbox_bad", "delivery failed")).toEqual({ status: "failed", retryCount: 1 });
    expect(await outbox.getEventById("outbox_bad")).toMatchObject({ status: "failed", retryCount: 1, lastError: "delivery failed", payload: malformed });
  });

  it("preserves valid object payloads for both worker and other event consumers", async () => {
    await outbox.insertEvent(local, { id: "ordinary", idempotencyKey: "ordinary", eventType: "turn.created", payload: { nested: { value: 1 } } });
    expect(await outbox.getEventById("outbox_good")).toMatchObject({ payload: { turnId: "good" } });
    expect(await outbox.getEventById("ordinary")).toMatchObject({ payload: { nested: { value: 1 } } });
    expect((await outbox.fetchPendingEvents({ eventType: "turn.created" }))[0]?.payload).toEqual({ nested: { value: 1 } });
  });

  it("fails closed for malformed Memory payloads without throwing or writing error content", async () => {
    await database.client.execute({
      sql: "INSERT INTO outbox_events(id,idempotency_key,event_type,payload,created_at) VALUES('memory','memory','memory.compaction.requested',?,?)",
      args: [malformed, new Date().toISOString()],
    });
    expect(await outbox.markFailed("memory", "private error")).toBeNull();
    await expect(outbox.markDeadLetter("memory", "private error")).resolves.toBeUndefined();
    const stored = await database.client.execute("SELECT status,last_error,retry_count FROM outbox_events WHERE id='memory'");
    expect(stored.rows[0]).toMatchObject({ status: "pending", last_error: null, retry_count: 0 });
  });
});
