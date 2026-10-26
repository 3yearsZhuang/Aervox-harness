import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, indexMessageFts, searchMessagesFts } from "../src/index.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
describe("message FTS derives only from current eligible conversation truth", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase(); repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(ctx, "session");
  });
  afterEach(async () => { await database.cleanup(); });
  async function answer(status = "Completed", messageId = "assistant") {
    await repo.acceptTurn(ctx, { turnId: "turn", sessionId: "session", idempotencyKey: "turn", attemptId: "attempt",
      message: { id: "user", content: "question" }, consumeInbox: false });
    await repo.appendStreamEvent(ctx, { id: "message", turnId: "turn", attemptId: "attempt", expectedFencingToken: 0, sequence: 1,
      eventType: "message", data: { role: "assistant", messageId }, safetyDecision: "approved" });
    await repo.recordSafeSegmentAtomically(ctx, { turnId: "turn", attemptId: "attempt", expectedFencingToken: 0, sequence: 2,
      text: "approvedcanary", eventData: { messageId, text: "approvedcanary" }, safetyDecision: "approved" });
    await repo.finalizeAttemptWithEventAtomically(ctx, { turnId: "turn", attemptId: "attempt", expectedFencingToken: 0, sequence: 3,
      status, eventType: "done", eventData: { status, isComplete: status === "Completed" }, safetyDecision: "approved" });
    return messageId;
  }
  const search = (query = "approvedcanary") => searchMessagesFts(database.client, ctx, query);
  async function insertStaleIndex(id: string, content = "approvedcanary") {
    await database.client.execute({ sql: "INSERT INTO messages_fts(id, content) VALUES(?, ?)", args: [id, content] });
  }

  it.each(["Interrupted", "Cancelled", "Failed"])("does not index or recall a %s assistant prefix", async status => {
    const id = await answer(status);
    await indexMessageFts(database.client, ctx, { id, content: "approvedcanary" });
    expect((await database.client.execute("SELECT id FROM messages_fts")).rows).toEqual([]);
    await insertStaleIndex(id);
    expect(await search()).toEqual([]);
  });

  it.each(["user", "assistant", "physical-input"])("denies stale recall and late reindex after deleting %s", async target => {
    const id = await answer();
    await indexMessageFts(database.client, ctx, { id, content: "approvedcanary" });
    expect(await search()).toHaveLength(1);
    if (target === "physical-input") await repo.deleteMessage(ctx, "user");
    else await repo.softDeleteMessage(ctx, target);
    expect(await search()).toEqual([]);
    await indexMessageFts(database.client, ctx, { id, content: "approvedcanary" });
    expect((await database.client.execute("SELECT id FROM messages_fts")).rows).toEqual([]);
  });

  it("does not recall a previous version or let a late indexer replace a user correction", async () => {
    const id = await answer();
    await indexMessageFts(database.client, ctx, { id, content: "approvedcanary" });
    const identity = await repo.getMessage(ctx, id);
    const version = (await repo.listMessageVersions(ctx, id)).find(row => row.id === identity?.currentVersionId)!;
    await repo.editMessage(ctx, id, "correctedcanary", version.version);
    expect(await search()).toEqual([]);
    await indexMessageFts(database.client, ctx, { id, content: "approvedcanary" });
    expect((await database.client.execute("SELECT id FROM messages_fts")).rows).toEqual([]);
    await indexMessageFts(database.client, ctx, { id, content: "correctedcanary" });
    expect(await search("correctedcanary")).toMatchObject([{ id }]);
  });

  it("rejects forged index text even when its message identity is valid", async () => {
    const id = await answer();
    await indexMessageFts(database.client, ctx, { id, content: "forgedcanary" });
    expect((await database.client.execute("SELECT id FROM messages_fts")).rows).toEqual([]);
    await insertStaleIndex(id, "forgedcanary");
    expect(await search("forgedcanary")).toEqual([]);
  });

  it("retains eligible legacy and imported conversations", async () => {
    await repo.createTurnWithOutbox(ctx, { id: "legacy", sessionId: "session", idempotencyKey: "legacy", status: "Completed" },
      { id: "legacy-user", content: "legacycanary" });
    await indexMessageFts(database.client, ctx, { id: "legacy-user", content: "legacycanary" });
    expect(await search("legacycanary")).toMatchObject([{ id: "legacy-user" }]);
    const imported = await repo.importSession(ctx, { messages: [{ role: "user", content: "import question" }, { role: "assistant", content: "importcanary" }] });
    const row = (await database.client.execute({ sql: "SELECT id FROM messages WHERE session_id = ? AND role = 'assistant'", args: [imported.session.id] })).rows[0]!;
    const id = String(row.id);
    await indexMessageFts(database.client, ctx, { id, content: "importcanary" });
    expect(await search("importcanary")).toMatchObject([{ id }]);
  });

  it("cannot replace a physically deleted original input with its later edit", async () => {
    const id = await answer();
    await indexMessageFts(database.client, ctx, { id, content: "approvedcanary" });
    const input = await repo.getMessage(ctx, "user");
    const version = (await repo.listMessageVersions(ctx, "user")).find(row => row.id === input?.currentVersionId)!;
    await repo.editMessage(ctx, "user", "edited question", version.version);
    expect(await search()).toHaveLength(1);
    await repo.deleteMessage(ctx, "user");
    expect(await search()).toEqual([]);
    await indexMessageFts(database.client, ctx, { id, content: "approvedcanary" });
    expect((await database.client.execute("SELECT id FROM messages_fts")).rows).toEqual([]);
  });

  it("refuses a stale index after the current source version is redacted", async () => {
    const id = await answer();
    await indexMessageFts(database.client, ctx, { id, content: "approvedcanary" });
    await repo.redactTurnMessages(ctx, "turn");
    expect(await search()).toEqual([]);
    await indexMessageFts(database.client, ctx, { id, content: "approvedcanary" });
    expect((await database.client.execute("SELECT id FROM messages_fts")).rows).toEqual([]);
  });

  it("does not widen bot-group messages into cross-session derivation", async () => {
    await repo.getOrCreateSession(ctx, "group", "group", null, "bot-group-member-v1");
    await repo.createTurnWithOutbox(ctx, { id: "group-turn", sessionId: "group", idempotencyKey: "group-turn",
      status: "Completed", executionPolicy: "bot-group-member-v1", dispatchTarget: "api" }, { id: "group-user", content: "groupcanary" });
    await indexMessageFts(database.client, ctx, { id: "group-user", content: "groupcanary" });
    expect((await database.client.execute("SELECT id FROM messages_fts")).rows).toEqual([]);
    await insertStaleIndex("group-user", "groupcanary");
    expect(await search("groupcanary")).toEqual([]);
  });

  it("preserves embedded NUL message identities without returning another identity", async () => {
    const id = await answer("Completed", "assistant\0tail");
    await indexMessageFts(database.client, ctx, { id, content: "approvedcanary" });
    expect(await search()).toMatchObject([{ id }]);
  });
});
