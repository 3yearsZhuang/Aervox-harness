import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository } from "../src/index.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };

describe("durable stream disclosure", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(ctx, "session");
    for (const turnId of ["turn", "other"]) {
      await repo.createTurnWithOutbox(ctx,
        { id: turnId, sessionId: "session", idempotencyKey: turnId },
        { id: `m_${turnId}`, content: "accepted input" });
      await repo.appendStreamEvent(ctx,
        { id: `event_${turnId}`, turnId, sequence: 1, eventType: "delta", data: { text: "private output" } });
    }
  });

  afterEach(async () => { vi.restoreAllMocks(); await database.cleanup(); });

  const expectUnavailable = async () => {
    expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(false);
    expect(await repo.getStreamEventForDisclosure(ctx, "turn", "event_turn")).toBeNull();
  };

  it("allows legacy first input and reads each disclosure decision in one SQL statement", async () => {
    const select = vi.spyOn(database.db, "select");
    expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(true);
    expect(select).toHaveBeenCalledOnce();
    select.mockClear();
    expect(await repo.getStreamEventForDisclosure(ctx, "turn", "event_turn"))
      .toMatchObject({ id: "event_turn", data: { text: "private output" } });
    expect(select).toHaveBeenCalledOnce();
    expect(await repo.getStreamEventForDisclosure(ctx, "turn", "event_other")).toBeNull();
    expect(await repo.isTurnStreamDisclosable(ctx, "missing")).toBe(false);
  });

  it("reloads the durable event instead of returning an earlier transport page payload", async () => {
    const page = await repo.getStreamEventsPage(ctx, "turn", { throughSequence: 1 });
    await database.client.execute({
      sql: "UPDATE turn_stream_events SET data = ?, event_type = 'redacted' WHERE id = 'event_turn'",
      args: [JSON.stringify({ text: "replacement" })],
    });
    expect(page.events[0]?.data).toEqual({ text: "private output" });
    expect(await repo.getStreamEventForDisclosure(ctx, "turn", page.events[0]!.id))
      .toMatchObject({ eventType: "redacted", data: { text: "replacement" } });
  });

  it("does not disclose an event removed after its page was cached", async () => {
    const page = await repo.getStreamEventsPage(ctx, "turn", { throughSequence: 1 });
    await database.client.execute("DELETE FROM turn_stream_events WHERE id = 'event_turn'");
    expect(page.events[0]?.data).toEqual({ text: "private output" });
    expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(true);
    expect(await repo.getStreamEventForDisclosure(ctx, "turn", page.events[0]!.id)).toBeNull();
  });

  it("does not substitute a later user version after the accepted first input is physically deleted", async () => {
    await database.client.execute("INSERT INTO message_versions (id, turn_id, role, version, content, created_at) VALUES ('edited', 'turn', 'user', 2, 'later input', '2026-10-24T00:00:00.000Z')");
    await repo.deleteMessage(ctx, "m_turn");
    expect(await repo.getStreamEvents(ctx, "turn")).toHaveLength(1);
    await expectUnavailable();
  });

  it("preserves existing fixed safety response replay when its messages are marked redacted", async () => {
    const safetyResponse = "fixed safety response";
    await repo.redactTurnMessages(ctx, "turn");
    await repo.appendRedactedAssistantMessage(ctx, { id: "assistant", turnId: "turn", content: safetyResponse });
    await database.client.execute({
      sql: "UPDATE turn_stream_events SET data = ?, safety_decision = 'redacted' WHERE id = 'event_turn'",
      args: [JSON.stringify({ text: safetyResponse })],
    });
    expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(true);
    expect(await repo.getStreamEventForDisclosure(ctx, "turn", "event_turn"))
      .toMatchObject({ eventType: "delta", data: { text: safetyResponse }, safetyDecision: "redacted" });
    // isRedacted excludes extraction; it is not a separate disclosure denial.
    // Source deletion still wins over an existing safety response.
    await repo.createMessage(ctx, { id: "m_turn", sessionId: "session", role: "user" });
    await repo.softDeleteMessage(ctx, "m_turn");
    await expectUnavailable();
  });

  it.each([
    ["local-v1", "local-v1", "api", false],
    ["bot-owner-v1", "local-v1", "api", false],
    ["bot-owner-v1", "bot-owner-v1", "default", false],
    ["unknown", "unknown", "api", false],
    ["bot-owner-v1", "bot-owner-v1", "api", true],
    ["bot-group-member-v1", "bot-group-member-v1", "api", true],
  ] as const)("preserves Turn %s / Session %s policy and %s dispatch eligibility", async (turnPolicy, sessionPolicy, dispatch, eligible) => {
    await database.client.execute({ sql: "UPDATE turns SET execution_policy = ?, dispatch_target = ? WHERE id = 'turn'", args: [turnPolicy, dispatch] });
    await database.client.execute({ sql: "UPDATE sessions SET execution_policy = ? WHERE id = 'session'", args: [sessionPolicy] });
    expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(eligible);
    if (eligible) {
      expect(await repo.getStreamEventForDisclosure(ctx, "turn", "event_turn"))
        .toMatchObject({ id: "event_turn" });
    } else {
      await expectUnavailable();
    }
  });

  it.each(["messageId", "legacy version id", "currentVersionId"])(
    "checks deleted identity related through %s and permits a restored source", async (relation) => {
      const identityId = relation === "legacy version id" ? "m_turn" : "identity";
      await repo.createMessage(ctx, { id: identityId, sessionId: "session", role: "user" });
      if (relation === "messageId") {
        await database.client.execute("UPDATE message_versions SET message_id = 'identity' WHERE id = 'm_turn'");
      } else if (relation === "currentVersionId") {
        await database.client.execute("UPDATE messages SET current_version_id = 'm_turn' WHERE id = 'identity'");
      }
      expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(true);
      await repo.softDeleteMessage(ctx, identityId);
      await expectUnavailable();
      await repo.restoreMessage(ctx, identityId);
      expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(true);
    });

  it("rejects a deleted assistant identity but keeps unrelated Turn flags out of the decision", async () => {
    await repo.createMessage(ctx, { id: "assistant_identity", sessionId: "session", role: "assistant" });
    await database.client.execute("INSERT INTO message_versions (id, turn_id, message_id, role, version, content, created_at) VALUES ('assistant', 'turn', 'assistant_identity', 'assistant', 2, 'output', '2026-10-24T00:00:00.000Z')");
    await repo.redactTurnMessages(ctx, "other");
    expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(true);
    await repo.softDeleteMessage(ctx, "assistant_identity");
    await expectUnavailable();
  });

  it("fails closed for a missing Session even if legacy orphan events remain", async () => {
    await database.client.execute("PRAGMA foreign_keys = OFF");
    await database.client.execute("DELETE FROM sessions WHERE id = 'session'");
    expect(await repo.getStreamEvents(ctx, "turn")).toHaveLength(1);
    await expectUnavailable();
  });
});
