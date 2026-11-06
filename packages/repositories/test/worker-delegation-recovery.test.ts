import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository } from "../src/index.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const old = "2000-01-01T00:00:00.000Z";

describe("queued worker delegation recovery", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(local, "session");
    await repo.acceptTurn(local, {
      turnId: "turn", sessionId: "session", idempotencyKey: "request", attemptId: "attempt",
      message: { id: "message", content: "explicit background work" }, execution: "worker",
    });
    await database.client.execute({ sql: "UPDATE turn_attempts SET started_at=? WHERE id='attempt'", args: [old] });
  });
  afterEach(async () => { await database.cleanup(); });

  it.each(["pending", "failed-0", "failed-1", "failed-2"])("retains an unclaimed %s delegation beyond the orphan timeout", async state => {
    if (state.startsWith("failed")) await database.client.execute({
      sql: "UPDATE outbox_events SET status='failed',retry_count=? WHERE id='outbox_turn'", args: [Number(state.split("-")[1])],
    });
    expect(await repo.hasWorkerDelegation("turn", "outbox_turn")).toBe(true);
    expect(await repo.recoverExpiredAttempts(database.client, { dispatchTarget: "default" })).toBe(0);
    expect(await repo.listTurnAttempts(local, "turn")).toMatchObject([{ status: "Running", fencingToken: 0, leaseId: null, leaseExpiresAt: null }]);
    expect((await repo.getTurn(local, "turn"))?.status).toBe("Created");
    expect(await repo.getStreamEvents(local, "turn")).toEqual([]);
  });

  it("preserves a queued Running Turn without restricting the recovery dispatch target", async () => {
    await repo.updateTurnStatus(local, "turn", "Running");
    expect(await repo.recoverExpiredAttempts(database.client)).toBe(0);
    expect((await repo.getTurn(local, "turn"))?.status).toBe("Running");
    expect((await repo.listTurnAttempts(local, "turn"))[0]?.fencingToken).toBe(0);
    expect(await repo.getStreamEvents(local, "turn")).toEqual([]);
  });

  it.each(["bot-owner-v1", "unknown-policy"])("rejects a receipt after the Session policy changes to %s and retires the queue item", async policy => {
    await database.client.execute({ sql: "UPDATE sessions SET execution_policy=? WHERE id='session'", args: [policy] });
    expect(await repo.hasWorkerDelegation("turn", "outbox_turn")).toBe(false);
    expect(await repo.recoverExpiredAttempts(database.client, { dispatchTarget: "default" })).toBe(1);
    expect((await database.client.execute("SELECT status,fencing_token FROM turn_attempts WHERE id='attempt'")).rows[0])
      .toMatchObject({ status: "Interrupted", fencing_token: 1 });
    expect(await repo.recoverExpiredAttempts(database.client, { dispatchTarget: "default" })).toBe(0);
  });

  it("rejects a receipt for a missing Session without permanently protecting its initial Attempt", async () => {
    // Model a damaged/imported relation without deleting the original Session
    // or cascading away the Turn. Restore the normal FK setting immediately.
    await database.client.execute("PRAGMA foreign_keys=OFF");
    try {
      await database.client.execute("UPDATE turns SET session_id='missing-session' WHERE id='turn'");
      await database.client.execute("UPDATE outbox_events SET payload=json_set(payload,'$.sessionId','missing-session') WHERE id='outbox_turn'");
    } finally { await database.client.execute("PRAGMA foreign_keys=ON"); }
    expect(await repo.hasWorkerDelegation("turn", "outbox_turn")).toBe(false);
    expect(await repo.recoverExpiredAttempts(database.client, { dispatchTarget: "default" })).toBe(1);
    expect((await database.client.execute("SELECT status,fencing_token FROM turn_attempts WHERE id='attempt'")).rows[0])
      .toMatchObject({ status: "Interrupted", fencing_token: 1 });
    expect(await repo.recoverExpiredAttempts(database.client, { dispatchTarget: "default" })).toBe(0);
  });

  it.each([
    ["cancellation", "UPDATE turn_attempts SET status='CancelRequested' WHERE id='attempt'", "Cancelled"],
    ["expired owner", "UPDATE turn_attempts SET lease_id='owner',lease_expires_at='2000-01-01T00:00:00.000Z',fencing_token=1 WHERE id='attempt'", "Interrupted"],
    ["lost lease id", "UPDATE turn_attempts SET lease_id='owner' WHERE id='attempt'", "Interrupted"],
    ["advanced fence", "UPDATE turn_attempts SET fencing_token=1 WHERE id='attempt'", "Interrupted"],
    ["later attempt", "UPDATE turn_attempts SET attempt=2 WHERE id='attempt'", "Interrupted"],
    ["API dispatch", "UPDATE turns SET dispatch_target='api' WHERE id='turn'", "Interrupted"],
    ["Bot policy", "UPDATE turns SET execution_policy='bot-owner-v1' WHERE id='turn'", "Interrupted"],
    ["terminal Turn", "UPDATE turns SET status='Completed' WHERE id='turn'", "Interrupted"],
    ["published", "UPDATE outbox_events SET status='published' WHERE id='outbox_turn'", "Interrupted"],
    ["dead letter", "UPDATE outbox_events SET status='dead_letter' WHERE id='outbox_turn'", "Interrupted"],
    ["exhausted retries", "UPDATE outbox_events SET status='failed',retry_count=3 WHERE id='outbox_turn'", "Interrupted"],
    ["missing receipt", "DELETE FROM outbox_events WHERE id='outbox_turn'", "Interrupted"],
    ["receipt id", "UPDATE outbox_events SET id='other' WHERE id='outbox_turn'", "Interrupted"],
    ["event type", "UPDATE outbox_events SET event_type='turn.created' WHERE id='outbox_turn'", "Interrupted"],
    ["execution mismatch", "UPDATE outbox_events SET payload=json_set(payload,'$.execution','api') WHERE id='outbox_turn'", "Interrupted"],
    ["Turn mismatch", "UPDATE outbox_events SET payload=json_set(payload,'$.turnId','other') WHERE id='outbox_turn'", "Interrupted"],
    ["session mismatch", "UPDATE outbox_events SET payload=json_set(payload,'$.sessionId','other') WHERE id='outbox_turn'", "Interrupted"],
    ["hash mismatch", "UPDATE outbox_events SET payload=json_set(payload,'$.requestHash','forged') WHERE id='outbox_turn'", "Interrupted"],
    ["missing hash", "UPDATE turns SET request_hash=NULL WHERE id='turn'", "Interrupted"],
    ["invalid JSON", "UPDATE outbox_events SET payload='invalid JSON' WHERE id='outbox_turn'", "Interrupted"],
  ])("still retires %s work", async (_name, mutation, status) => {
    await database.client.execute(mutation);
    if (_name === "invalid JSON") expect(await repo.hasWorkerDelegation("turn", "outbox_turn")).toBe(false);
    expect(await repo.recoverExpiredAttempts(database.client)).toBe(1);
    expect((await repo.listTurnAttempts(local, "turn"))[0]?.status).toBe(status);
    expect((await repo.getStreamEvents(local, "turn")).filter(event => event.eventType === "done")).toHaveLength(_name === "terminal Turn" ? 0 : 1);
    expect(await repo.recoverExpiredAttempts(database.client)).toBe(0);
  });
});
