import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository } from "@aervox/repositories";
import { buildApp } from "../src/app.js";
const local = { workspaceId: "local", subjectUserId: "local" };
afterEach(() => vi.unstubAllEnvs());

describe("opt-in API startup recovery", () => {
  it.each(["off", "local-results"])("%s controls the production startup dispatcher", async mode => {
    vi.stubEnv("AERVOX_LOOP_RESUME", mode); vi.stubEnv("AERVOX_LOOP_PROVIDER", "replay");
    const database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    const repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(local, "resume-session");
    await repo.createTurnWithOutbox(local, { id: "resume-turn", sessionId: "resume-session", idempotencyKey: "resume", status: "Created" }, { id: "resume-user", content: "Summarize the committed result" });
    await repo.createTurnAttempt(local, "resume-turn", { id: "resume-attempt", attempt: 1 });
    await repo.claimTurnAttempt(local, { turnId: "resume-turn", attemptId: "resume-attempt", leaseId: "old", expectedFencingToken: 0, ttlMs: 1 });
    await repo.reserveToolExecution(local, { turnId: "resume-turn", attemptId: "resume-attempt", invocationId: "resume-attempt:1:1", name: "read", arguments: {} });
    await repo.updateToolExecutionResult(local, { turnId: "resume-turn", attemptId: "resume-attempt", invocationId: "resume-attempt:1:1", status: "executed", output: "known" });
    for (const event of [
      { sequence: 1, eventType: "message", data: { messageId: "assistant" } },
      { sequence: 2, eventType: "tool_request", data: { executionId: "resume-attempt:1:1", invocationId: "call", name: "read", arguments: {} } },
      { sequence: 3, eventType: "tool_result", data: { executionId: "resume-attempt:1:1", invocationId: "call", name: "read", ok: true, output: "known" } },
    ]) await repo.appendStreamEvent(local, { ...event, id: `resume-event-${event.sequence}`, turnId: "resume-turn", attemptId: "resume-attempt" });
    const { app } = await buildApp({ db: database.db, client: database.client });
    try {
      await app.ready();
      if (mode === "local-results") await vi.waitFor(async () => {
        const rows = await database.client.execute("SELECT status FROM turn_attempts WHERE id = 'resume-attempt'");
        expect(rows.rows[0]?.status).toBe("Completed");
      });
      const events = await repo.getStreamEvents(local, "resume-turn");
      expect(events.filter(e => e.eventType === "done")).toHaveLength(mode === "off" ? 0 : 1);
      expect(await repo.listToolExecutionsByTurn(local, "resume-turn")).toHaveLength(1);
    } finally { await app.close(); await database.cleanup(); }
  });
});
