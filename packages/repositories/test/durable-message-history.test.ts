import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_DELETION_VERIFIER } from "../src/memory-deletion-protocol.js";
import { createInMemoryDatabase, SqliteConversationRepository, collectDiaryMaterial } from "../src/index.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
const assistantId = "msg_turn_assistant";
describe("accepted conversation message history", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(ctx, "session");
    await repo.acceptTurn(ctx, { turnId: "turn", sessionId: "session", idempotencyKey: "turn", attemptId: "attempt",
      message: { id: "user", content: "user input" }, consumeInbox: false });
  });
  afterEach(async () => { await database.cleanup(); });
  const start = () => repo.appendStreamEvent(ctx, { id: "message", turnId: "turn", attemptId: "attempt", expectedFencingToken: 0,
    sequence: 1, eventType: "message", safetyDecision: "approved", data: { messageId: assistantId, role: "assistant" } });
  const segment = (sequence = 2, text = "safe prefix", attemptId = "attempt") => repo.recordSafeSegmentAtomically(ctx, {
    turnId: "turn", attemptId, expectedFencingToken: 0, sequence, text, eventData: { messageId: assistantId, text }, safetyDecision: "approved" });
  const finish = (status = "Completed", sequence = 3, attemptId = "attempt") => repo.finalizeAttemptWithEventAtomically(ctx, {
    turnId: "turn", attemptId, expectedFencingToken: 0, sequence, status, eventType: status === "Failed" ? "error" : "done",
    eventData: { status, isComplete: status === "Completed" }, safetyDecision: "approved" });
  const currentAssistant = async () => {
    const identity = await repo.getMessage(ctx, assistantId);
    return (await repo.listMessageVersions(ctx, assistantId)).find(version => version.id === identity?.currentVersionId);
  };

  it("acceptance creates the real user identity without changing its version id", async () => {
    expect(await repo.getMessage(ctx, "user")).toMatchObject({ id: "user", sessionId: "session", role: "user", currentVersionId: "user" });
    expect(await repo.listMessageVersions(ctx, "user")).toMatchObject([{ id: "user", messageId: "user", version: 1, content: "user input" }]);
  });
  it.each(["Completed", "Cancelled", "Failed", "Interrupted"])("%s preserves the committed assistant prefix after replay events are removed", async status => {
    await start(); await segment(); await finish(status);
    await database.client.execute("DELETE FROM turn_stream_events WHERE turn_id = 'turn'");
    expect(await currentAssistant()).toMatchObject({ content: "safe prefix", role: "assistant", messageId: assistantId });
    expect((await repo.getTurn(ctx, "turn"))?.status).toBe(status);
  });
  it("copies only committed safe segments, never raw deltas, reasoning or tool data", async () => {
    await start(); await segment();
    for (const [sequence, eventType] of [[3, "delta"], [4, "reasoning_delta"], [5, "tool_result"]] as const) {
      await repo.appendStreamEvent(ctx, { id: `raw${sequence}`, turnId: "turn", attemptId: "attempt", expectedFencingToken: 0,
        sequence, eventType, safetyDecision: "approved", data: { messageId: assistantId, text: "unsafe raw copy", output: "tool private" } });
    }
    await finish("Completed", 6);
    expect((await currentAssistant())?.content).toBe("safe prefix");
  });
  it("approval continuation preserves the prefix and publishes a new immutable current version", async () => {
    await start(); await segment(); await finish("Interrupted");
    const original = await currentAssistant();
    await database.client.execute("DELETE FROM turn_stream_events WHERE turn_id = 'turn'");
    await database.client.execute("DELETE FROM safe_segments WHERE turn_id = 'turn'");
    await repo.createTurnAttempt(ctx, "turn", { id: "continuation", attempt: 2 });
    await segment(4, " then continued", "continuation"); await finish("Completed", 5, "continuation");
    expect((await currentAssistant())?.content).toBe("safe prefix then continued");
    expect((await repo.listMessageVersions(ctx, assistantId)).find(version => version.id === original?.id))
      .toMatchObject({ content: "safe prefix", supersededAt: expect.any(String) });
  });
  it.each(["user", "assistant"])("deleting the %s identity blocks late segment and history writes", async target => {
    await start(); await segment();
    await repo.softDeleteMessage(ctx, target === "user" ? "user" : assistantId);
    await expect(segment(3, "late body")).rejects.toThrow();
    await finish("Cancelled", 4);
    expect((await currentAssistant())?.content).toBe("");
  });
  it("physically removed accepted input cannot be replaced with an old event prefix", async () => {
    await start(); await segment(); await repo.deleteMessage(ctx, "user");
    await finish("Cancelled");
    expect((await currentAssistant())?.content).toBe("");
  });
  it("history write failure rolls back the terminal status, event and pointer together", async () => {
    await start(); await segment();
    await database.client.execute("CREATE TRIGGER reject_history BEFORE INSERT ON message_versions WHEN NEW.role = 'assistant' AND NEW.content <> '' BEGIN SELECT RAISE(ABORT, 'injected history failure'); END");
    await expect(finish()).rejects.toThrow("Database query failed");
    expect((await repo.listTurnAttempts(ctx, "turn"))[0]?.status).toBe("Running");
    expect((await repo.getStreamEvents(ctx, "turn")).some(event => event.eventType === "done")).toBe(false);
    expect((await currentAssistant())?.content).toBe("");
    await database.client.execute("DROP TRIGGER reject_history"); await finish();
    expect((await currentAssistant())?.content).toBe("safe prefix");
  });
  it("allocates turn-unique versions while both user and assistant messages can be edited", async () => {
    await start(); await segment(); await finish();
    const assistant = await currentAssistant();
    const userEdit = await repo.editMessage(ctx, "user", "edited input", 1);
    expect(userEdit?.newVersion.content).toBe("edited input");
    const assistantEdit = await repo.editMessage(ctx, assistantId, "edited output", assistant!.version);
    expect(assistantEdit?.newVersion.content).toBe("edited output");
    expect(userEdit?.newVersion.version).not.toBe(assistantEdit?.newVersion.version);
    expect(await repo.editMessage(ctx, "user", "stale", 1)).toBeNull();
  });
  it("an unclaimed cancellation publishes its already committed prefix atomically", async () => {
    await start(); await segment();
    expect(await repo.requestCancelTurnAttempt(ctx, { turnId: "turn", attemptId: "attempt" })).toEqual({ ok: true });
    expect((await currentAssistant())?.content).toBe("safe prefix");
    expect((await repo.getTurn(ctx, "turn"))?.status).toBe("Cancelled");
  });
  it("unclaimed cancellation keeps its durable sequence after replay rows are cleaned", async () => {
    await start(); await segment(); await finish("Interrupted");
    const highWater = (await repo.getTurn(ctx, "turn"))!.lastSequence;
    await database.client.execute("DELETE FROM turn_stream_events");
    await database.client.execute("DELETE FROM safe_segments");
    await repo.createTurnAttempt(ctx, "turn", { id: "continuation", attempt: 2 });
    expect(await repo.requestCancelTurnAttempt(ctx, { turnId: "turn", attemptId: "continuation" })).toEqual({ ok: true });
    expect((await repo.getTurn(ctx, "turn"))?.lastSequence).toBe(highWater + 1);
    expect((await repo.getStreamEvents(ctx, "turn")).map(event => event.sequence)).toEqual([highWater + 1]);
    expect((await currentAssistant())?.content).toBe("safe prefix");
  });
  it("plugin hook allocation starts after the durable sequence when replay rows are cleaned", async () => {
    await start(); await segment(); await finish("Interrupted");
    const highWater = (await repo.getTurn(ctx, "turn"))!.lastSequence;
    await database.client.execute("DELETE FROM turn_stream_events");
    await repo.createTurnAttempt(ctx, "turn", { id: "continuation", attempt: 2 });
    await database.client.execute("INSERT INTO plugins(id,publisher,version,checksum,lifecycle_generation,created_at,updated_at) VALUES ('hook','fixture','1','fixture','g','now','now')");
    const event = await repo.appendPluginHookEvent(ctx, { turnId: "turn", attemptId: "continuation", expectedFencingToken: 0,
      pluginGeneration: { pluginId: "hook", generation: "g" }, phase: "beforeTurn", eventType: "plugin.hook", data: {} });
    expect(event.sequence).toBe(highWater + 1);
  });
  it("expired process recovery publishes the committed prefix in its terminal transaction", async () => {
    await start(); await segment();
    await database.client.execute("UPDATE turn_attempts SET started_at = '2000-01-01T00:00:00.000Z' WHERE id = 'attempt'");
    expect(await repo.recoverExpiredAttempts(database.client)).toBe(1);
    expect((await currentAssistant())?.content).toBe("safe prefix");
    expect((await repo.getTurn(ctx, "turn"))?.status).toBe("Interrupted");
  });
  it("process recovery preserves NUL-bearing identities without touching their prefix Turn", async () => {
    const turnId = "turn\0tail", attemptId = "attempt\0tail", messageId = "assistant\0tail";
    await repo.acceptTurn(ctx, { turnId, sessionId: "session", idempotencyKey: turnId, attemptId,
      message: { id: "nul-user", content: "nul question" }, consumeInbox: false });
    await repo.appendStreamEvent(ctx, { id: "nul-message", turnId, attemptId, expectedFencingToken: 0,
      sequence: 1, eventType: "message", safetyDecision: "approved", data: { messageId, role: "assistant" } });
    await repo.recordSafeSegmentAtomically(ctx, { turnId, attemptId, expectedFencingToken: 0,
      sequence: 2, text: "nul answer", eventData: { messageId, text: "nul answer" }, safetyDecision: "approved" });
    await database.client.execute({ sql: "UPDATE turn_attempts SET started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", args: [attemptId] });
    expect(await repo.recoverExpiredAttempts(database.client)).toBe(1);
    const versions = await database.client.execute({ sql: "SELECT content FROM message_versions WHERE message_id = ? AND superseded_at IS NULL", args: [messageId] });
    expect(versions.rows[0]?.content).toBe("nul answer");
    expect((await repo.getTurn(ctx, "turn"))?.status).toBe("Created");
    const actual = await database.client.execute({ sql: "SELECT status FROM turns WHERE id = ?", args: [turnId] });
    expect(actual.rows[0]?.status).toBe("Interrupted");
  });
  it("late finalization never overwrites a user-edited assistant version", async () => {
    await start(); await segment(); await finish("Interrupted");
    const original = await currentAssistant();
    const edit = await repo.editMessage(ctx, assistantId, "user correction", original!.version);
    await repo.createTurnAttempt(ctx, "turn", { id: "continuation", attempt: 2 });
    await segment(4, "late continuation", "continuation"); await finish("Completed", 5, "continuation");
    expect((await repo.getMessage(ctx, assistantId))?.currentVersionId).toBe(edit?.newVersion.id);
    expect((await currentAssistant())?.content).toBe("user correction");
  });
  it("preserves embedded NUL in the new durable prefix and appends after its checkpoint", async () => {
    await start(); await segment(2, "before\0after"); await finish("Interrupted");
    await database.client.execute("DELETE FROM turn_stream_events WHERE turn_id = 'turn'");
    await database.client.execute("DELETE FROM safe_segments WHERE turn_id = 'turn'");
    await repo.createTurnAttempt(ctx, "turn", { id: "continuation", attempt: 2 });
    await segment(4, " next\0tail", "continuation"); await finish("Completed", 5, "continuation");
    // JSON escaping crosses the native decoder without losing the suffix.
    const result = await database.client.execute("SELECT json_quote(content) AS body FROM message_versions WHERE id = (SELECT current_version_id FROM messages WHERE id = 'msg_turn_assistant')");
    expect(JSON.parse(String(result.rows[0]?.body))).toBe("before\0after next\0tail");
  });
  it.each(["uncommitted", "pending", "wrong-message", "changed-text"])("does not persist a %s fragment", async mode => {
    await start(); await segment();
    if (mode === "uncommitted") await database.client.execute("UPDATE safe_segments SET committed = 0");
    if (mode === "pending") await database.client.execute("UPDATE turn_stream_events SET safety_decision = 'pending' WHERE sequence = 2");
    if (mode === "wrong-message") await database.client.execute({ sql: "UPDATE turn_stream_events SET data = ? WHERE sequence = 2", args: [JSON.stringify({messageId: "another", text: "safe prefix"})] });
    if (mode === "changed-text") await database.client.execute({ sql: "UPDATE turn_stream_events SET data = ? WHERE sequence = 2", args: [JSON.stringify({messageId: assistantId, text: "tampered"})] });
    await finish(); expect((await currentAssistant())?.content).toBe("");
  });
  it("assistant identity collision cannot move another session's message or commit its event", async () => {
    await repo.getOrCreateSession(ctx, "other");
    await repo.createMessage(ctx, { id: assistantId, sessionId: "other", role: "assistant" });
    await expect(start()).rejects.toThrow("conversation_message_identity_conflict");
    expect(await repo.getMessage(ctx, assistantId)).toMatchObject({ sessionId: "other", currentVersionId: null });
    expect(await repo.getStreamEvents(ctx, "turn")).toEqual([]);
  });
  it("initial message binding failure rolls back both identity and stream event", async () => {
    await database.client.execute("CREATE TRIGGER reject_binding BEFORE INSERT ON message_versions WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END");
    await expect(start()).rejects.toThrow("Database query failed");
    expect(await repo.getMessage(ctx, assistantId)).toBeNull();
    expect(await repo.getStreamEvents(ctx, "turn")).toEqual([]);
  });
  it("acceptance failure cannot leave a visible orphan user identity", async () => {
    await database.client.execute("CREATE TRIGGER reject_attempt BEFORE INSERT ON turn_attempts BEGIN SELECT RAISE(ABORT, 'injected attempt failure'); END");
    await expect(repo.acceptTurn(ctx, { turnId: "failed", sessionId: "session", idempotencyKey: "failed", attemptId: "failed",
      message: { id: "failed-user", content: "uncommitted" }, consumeInbox: false })).rejects.toThrow();
    expect(await repo.getMessage(ctx, "failed-user")).toBeNull();
    expect(await repo.getTurn(ctx, "failed")).toBeNull();
  });
  it("keeps multiple assistant identities and their committed prefixes separate", async () => {
    await start(); await segment();
    await repo.appendStreamEvent(ctx, { id: "second", turnId: "turn", attemptId: "attempt", expectedFencingToken: 0, sequence: 3,
      eventType: "message", safetyDecision: "approved", data: { messageId: "second-assistant", role: "assistant" } });
    await repo.recordSafeSegmentAtomically(ctx, { turnId: "turn", attemptId: "attempt", expectedFencingToken: 0, sequence: 4,
      text: "second prefix", eventData: { messageId: "second-assistant", text: "second prefix" }, safetyDecision: "approved" });
    await finish("Completed", 5);
    expect((await currentAssistant())?.content).toBe("safe prefix");
    const identity = await repo.getMessage(ctx, "second-assistant");
    expect((await repo.listMessageVersions(ctx, "second-assistant")).find(version => version.id === identity?.currentVersionId)?.content).toBe("second prefix");
  });
  it("retains the full session identity across the native text decoder", async () => {
    await repo.getOrCreateSession(ctx, "session\0tail");
    await repo.acceptTurn(ctx, { turnId: "nul-turn", sessionId: "session\0tail", idempotencyKey: "nul-turn", attemptId: "nul-attempt",
      message: { id: "nul-user", content: "input" }, consumeInbox: false });
    await repo.appendStreamEvent(ctx, { id: "nul-message", turnId: "nul-turn", attemptId: "nul-attempt", expectedFencingToken: 0, sequence: 1,
      eventType: "message", safetyDecision: "approved", data: { messageId: "nul-assistant", role: "assistant" } });
    await repo.recordSafeSegmentAtomically(ctx, { turnId: "nul-turn", attemptId: "nul-attempt", expectedFencingToken: 0, sequence: 2,
      text: "body", eventData: { messageId: "nul-assistant", text: "body" }, safetyDecision: "approved" });
    await repo.finalizeAttemptWithEventAtomically(ctx, { turnId: "nul-turn", attemptId: "nul-attempt", expectedFencingToken: 0, sequence: 3,
      status: "Completed", eventType: "done", eventData: {}, safetyDecision: "approved" });
    const result = await database.client.execute("SELECT json_quote(session_id) AS session FROM messages WHERE id = 'nul-assistant'");
    expect(JSON.parse(String(result.rows[0]?.session))).toBe("session\0tail");
    expect((await repo.listMessageVersions(ctx, "nul-assistant")).some(version => version.content === "body")).toBe(true);
  });
  it.each([
    { mode: "retire", suffix: "" }, { mode: "synchronize", suffix: "" },
    { mode: "retire", suffix: "\0tail" }, { mode: "synchronize", suffix: "\0tail" },
  ])("Bot $mode retirement preserves full identities and the approved prefix ($suffix)", async ({ mode, suffix }) => {
    const turnId = "bot-turn" + suffix, attemptId = "bot-attempt" + suffix;
    await repo.createSession(ctx, "bot", { id: "bot", executionPolicy: "bot-owner-v1" });
    await repo.acceptTurn(ctx, { turnId, sessionId: "bot", idempotencyKey: turnId, attemptId,
      message: { id: "bot-user", content: "question" }, consumeInbox: false, execution: "api" });
    const claim = await repo.claimTurnAttempt(ctx, { turnId, attemptId, expectedFencingToken: 0, leaseId: "bot-lease" });
    expect(claim.ok).toBe(true);
    await repo.appendStreamEvent(ctx, { id: "bot-message", turnId, attemptId, expectedFencingToken: 1, sequence: 1,
      eventType: "message", safetyDecision: "approved", data: { messageId: "bot-assistant", role: "assistant" } });
    await repo.recordSafeSegmentAtomically(ctx, { turnId, attemptId, expectedFencingToken: 1, sequence: 2,
      text: "bot prefix", eventData: { messageId: "bot-assistant", text: "bot prefix" }, safetyDecision: "approved" });
    if (mode === "retire") {
      await database.client.execute({ sql: "UPDATE turn_attempts SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", args: [attemptId] });
      expect(await repo.retireExpiredApiOwnedAttempt(turnId, attemptId, 1)).toBe(true);
    } else {
      await repo.finalizeTurnAttempt(ctx, { turnId, attemptId, status: "Interrupted", expectedFencingToken: 1 });
      expect(await repo.synchronizeTurnWithLatestAttempt(turnId)).toMatchObject({ status: "Interrupted" });
    }
    await database.client.execute({ sql: "DELETE FROM turn_stream_events WHERE turn_id = ?", args: [turnId] });
    await database.client.execute({ sql: "DELETE FROM safe_segments WHERE turn_id = ?", args: [turnId] });
    const identity = await repo.getMessage(ctx, "bot-assistant");
    expect((await repo.listMessageVersions(ctx, "bot-assistant")).find(version => version.id === identity?.currentVersionId)?.content).toBe("bot prefix");
  });
  it("initialization keeps an empty binding while global deletion blocks generated body writes", async () => {
    await database.client.execute("INSERT INTO deletion_requests (id,scope,idempotency_key,requested_at,owner_module,created_at,updated_at) VALUES ('deletion','memory','deletion','now','memory','now','now')");
    await database.client.execute("INSERT INTO deletion_targets (request_id,target_type,target_id,owner_module) VALUES ('deletion','memory','target','memory')");
    await start();
    expect((await currentAssistant())?.content).toBe("");
    await expect(segment()).rejects.toThrow("deletion_blocked");
    // Simulate the already separately tested verifier's durable completion receipt.
    await database.client.execute("UPDATE deletion_requests SET status='completed',last_verified_at='now' WHERE id='deletion'");
    await database.client.execute({ sql: "UPDATE deletion_targets SET status='completed',verified_at='now',evidence_ref=? WHERE request_id='deletion'", args: [JSON.stringify({ verifier: MEMORY_DELETION_VERIFIER })] });
    await segment(); await finish();
    expect((await currentAssistant())?.content).toBe("safe prefix");
  });
  it.each(["Interrupted", "Cancelled", "Failed"])("%s visible prefixes never enter automatic diary material", async status => {
    await start(); await segment(); await finish(status);
    const material = await collectDiaryMaterial(database.db, ctx, { startIso: "2000", endIso: "9999" });
    expect(material.messages).toEqual([]);
  });
  it.each(["user", "assistant", "physical-source"])("diary material excludes a completed Turn after %s deletion", async target => {
    await start(); await segment(); await finish();
    expect((await collectDiaryMaterial(database.db, ctx, { startIso: "2000", endIso: "9999" })).messages)
      .toContainEqual(expect.objectContaining({ content: "safe prefix" }));
    if (target === "physical-source") await repo.deleteMessage(ctx, "user");
    else await repo.softDeleteMessage(ctx, target === "user" ? "user" : assistantId);
    expect((await collectDiaryMaterial(database.db, ctx, { startIso: "2000", endIso: "9999" })).messages).toEqual([]);
  });
  it("a durable redaction event also invalidates automatic use after replay rows are cleaned", async () => {
    await start(); await segment(); await finish();
    await repo.appendStreamEvent(ctx, { id: "withdrawn", turnId: "turn", sequence: 4, eventType: "redacted", data: {} });
    await database.client.execute("DELETE FROM turn_stream_events");
    expect((await collectDiaryMaterial(database.db, ctx, { startIso: "2000", endIso: "9999" })).messages).toEqual([]);
  });
  it("does not fabricate message history for an unlinked legacy source", async () => {
    await database.client.execute("UPDATE message_versions SET message_id = NULL WHERE id = 'user'");
    await start(); await segment(); await finish();
    expect(await repo.getMessage(ctx, assistantId)).toBeNull();
  });
});
