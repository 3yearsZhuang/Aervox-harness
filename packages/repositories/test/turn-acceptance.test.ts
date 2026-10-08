import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, SqliteAgentInboxRepository } from "../src/index.js";
const ctx = { workspaceId: "local", subjectUserId: "local" };
describe("atomic Turn acceptance", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  let inbox: SqliteAgentInboxRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase(); await initDatabaseSchema(database.client);
    repo = new SqliteConversationRepository(database.db); inbox = new SqliteAgentInboxRepository(database.db);
    await repo.getOrCreateSession(ctx, "s");
    await inbox.enqueue(ctx, { id: "i", idempotencyKey: "i", sessionId: "s", type: "followup", payload: "queued", sourceActor: "user" });
  });
  afterEach(async () => { await database.cleanup(); });
  const accept = (id = "t") => repo.acceptTurn(ctx, { turnId: id, sessionId: "s", idempotencyKey: "same", attemptId: `a_${id}`, message: { id: `m_${id}`, content: "current" }, consumeInbox: true });
  it.each(["BEFORE INSERT ON turns", "BEFORE INSERT ON message_versions", "BEFORE INSERT ON outbox_events", "BEFORE INSERT ON turn_attempts", "BEFORE UPDATE ON agent_inbox_items"])("%s failure leaves input replayable and no partial Turn", async (point) => {
    await database.client.execute(`CREATE TRIGGER fail_accept ${point} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await expect(accept()).rejects.toThrow("injected");
    for (const table of ["turns", "message_versions", "outbox_events", "turn_attempts"]) {
      expect(Number((await database.client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n)).toBe(0);
    }
    expect(await inbox.getByIdempotencyKey(ctx, "i")).toMatchObject({ status: "pending", ackedAt: null });
    await database.client.execute("DROP TRIGGER fail_accept");
    expect(await accept()).toMatchObject({ created: true, message: { content: "queued\n\ncurrent" } });
  });
  it("same-key concurrent acceptance dispatches only the winner and consumes input once", async () => {
    const results = await Promise.all([accept("one"), accept("two")]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0]!.turn.id).toBe(results[1]!.turn.id);
    expect(await repo.listTurnAttempts(ctx, results[0]!.turn.id)).toHaveLength(1);
    expect(await inbox.getByIdempotencyKey(ctx, "i")).toMatchObject({ status: "acknowledged", attemptId: `a_${results[0]!.turn.id}` });
    await inbox.enqueue(ctx, { id: "later", idempotencyKey: "later", sessionId: "s", type: "followup", payload: "later", sourceActor: "user" });
    expect((await accept("retry")).created).toBe(false);
    expect((await inbox.getByIdempotencyKey(ctx, "later"))?.status).toBe("pending");
  });
  it("fresh cancellation is not reclaimed; recovery event failure rolls back the fence and tool outcome", async () => {
    await accept();
    await repo.reserveToolExecution(ctx, { turnId: "t", attemptId: "a_t", invocationId: "call", name: "write" });
    await repo.requestCancelTurnAttempt(ctx, { turnId: "t", attemptId: "a_t" });
    expect(await repo.recoverExpiredAttempts(database.client)).toBe(0);
    await database.client.execute("UPDATE turn_attempts SET started_at = '2000-01-01T00:00:00.000Z'");
    await database.client.execute("CREATE TRIGGER fail_recovery BEFORE INSERT ON turn_stream_events BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(repo.recoverExpiredAttempts(database.client)).rejects.toThrow("injected");
    expect(await repo.listTurnAttempts(ctx, "t")).toMatchObject([{ status: "CancelRequested", fencingToken: 0, finishedAt: null }]);
    expect((await repo.listToolExecutionsByTurn(ctx, "t"))[0]?.status).toBe("pending");
    expect(await repo.getStreamEvents(ctx, "t")).toEqual([]);
    await database.client.execute("DROP TRIGGER fail_recovery");
    expect(await repo.recoverExpiredAttempts(database.client)).toBe(1);
    expect(await repo.listTurnAttempts(ctx, "t")).toMatchObject([{ status: "Cancelled", fencingToken: 1 }]);
  });

});
