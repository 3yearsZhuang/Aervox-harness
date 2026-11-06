import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository } from "../src/index.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
const privateBody = "PRIVATE_TERMINAL_DIAGNOSTIC\0tail";

describe("diagnostics for persisted terminal projections", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(ctx, "session");
    await repo.acceptTurn(ctx, { turnId: "turn", sessionId: "session", idempotencyKey: "turn",
      attemptId: "attempt", message: { id: "user", content: "source" }, consumeInbox: false });
  });
  afterEach(async () => { await database.cleanup(); });

  async function finalize(eventType: "done" | "error", eventData: unknown) {
    expect(await repo.finalizeAttemptWithEventAtomically(ctx, {
      turnId: "turn", attemptId: "attempt", expectedFencingToken: 0,
      status: eventType === "done" ? "Interrupted" : "Failed", sequence: 1, eventType, eventData,
    })).toBe(true);
    return (await repo.getStreamEvents(ctx, "turn"))[0]!;
  }

  it.each(["done", "error"] as const)("reports the fixed %s projection after source deletion without its caller body", async eventType => {
    await repo.softDeleteMessage(ctx, "user");
    const event = await finalize(eventType, { code: privateBody, reason: privateBody, message: privateBody,
      retryable: true, status: privateBody, isComplete: true, nested: { output: privateBody } });
    expect(event.data).toEqual(eventType === "done"
      ? { status: "Interrupted", isComplete: false, reason: "source_unavailable", lastSequence: 1 }
      : { code: "PERMISSION_REVOKED", retryable: false, message: "Conversation source is unavailable", lastSequence: 1 });
    const diagnostics = await repo.getTurnDiagnostics(ctx, "turn");
    expect(diagnostics).toMatchObject({ selectedAttemptId: "attempt", status: eventType === "done" ? "Interrupted" : "Failed",
      terminationReason: eventType === "done" ? "source_unavailable" : "PERMISSION_REVOKED" });
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_TERMINAL_DIAGNOSTIC");
    expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(false);
  });

  it.each((["done", "error"] as const).flatMap(eventType =>
    ["unknown_terminal_reason", privateBody].map(value => ({ eventType, value }))))
  ("omits unrecognized $eventType values from diagnostics", async ({ eventType, value }) => {
    const data = { [eventType === "done" ? "reason" : "code"]: value, message: privateBody,
      nested: { output: privateBody } };
    const event = await finalize(eventType, data);
    expect(event.data).toEqual(data);
    expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(true);
    const diagnostics = await repo.getTurnDiagnostics(ctx, "turn");
    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.terminationReason).toBeNull();
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_TERMINAL_DIAGNOSTIC");
    expect(JSON.stringify(diagnostics)).not.toContain("unknown_terminal_reason");
  });
});
