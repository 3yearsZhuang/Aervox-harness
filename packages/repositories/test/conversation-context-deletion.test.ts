import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqlitePlatformRepository } from "../src/index.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
describe("conversation deletion removes linked historical context bodies", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let conversation: SqliteConversationRepository;
  let platform: SqlitePlatformRepository;
  const sessionId = "removed\0tail";
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    conversation = new SqliteConversationRepository(database.db);
    platform = new SqlitePlatformRepository(database.db);
    await conversation.getOrCreateSession(ctx, sessionId);
    await conversation.getOrCreateSession(ctx, "removed");
    for (const [turn, session] of [["source", sessionId], ["later", sessionId], ["other", "removed"]]) {
      await conversation.acceptTurn(ctx, { turnId: turn!, sessionId: session!, idempotencyKey: turn!, attemptId: `attempt_${turn}`,
        message: { id: `input_${turn}`, content: `history_${turn}` }, consumeInbox: false });
      await platform.createModelRun(ctx, { id: `run_${turn}`, attemptId: `attempt_${turn}`, purpose: "agent.loop", provider: "fixture", modelId: "fixture" });
      await platform.createContextManifest({ id: `manifest_${turn}`, modelRunId: `run_${turn}`, purpose: "agent.loop",
        sourceArtifactId: "turn:history", sourceRevisionId: "1" });
      // Reproduce a pre-minimization row at the actual SQLite boundary.
      await database.client.execute({ sql: "UPDATE context_manifests SET snapshot_json=?, permission_snapshot=?, selection_reason=? WHERE id=?",
        args: [JSON.stringify({ messages: [{ role: "user", content: `PRIVATE_${turn}` }], tools: [{ description: `PRIVATE_${turn}` }] }),
          JSON.stringify({ note: `PRIVATE_${turn}` }), `PRIVATE_${turn}`, `manifest_${turn}`] });
    }
  });
  afterEach(async () => { await database.cleanup(); });
  const rows = async () => (await database.client.execute("SELECT id,snapshot_json,permission_snapshot,selection_reason FROM context_manifests ORDER BY id")).rows;

  it.each(["message", "version", "session"] as const)("clears all linked session snapshots in the same %s deletion, preserving a different NUL-prefix identity", async target => {
    if (target === "message") expect(await conversation.softDeleteMessage(ctx, "input_source")).not.toBeNull();
    else if (target === "version") expect(await conversation.deleteMessage(ctx, "input_source")).toBe(true);
    else expect(await conversation.deleteSession(ctx, sessionId)).toBe(true);
    const remaining = await rows();
    for (const id of ["manifest_source", "manifest_later"]) {
      expect(remaining.find(row => row.id === id)).toMatchObject({ snapshot_json: null, permission_snapshot: null, selection_reason: null });
    }
    expect(remaining.find(row => row.id === "manifest_other")).toMatchObject({ selection_reason: "PRIVATE_other" });
    expect((await conversation.getSessionHistoryPage(ctx, { sessionId: "removed" })).items[0]?.messages[0]?.content).toBe("history_other");
    if (target === "message") {
      // Undo retains the user's version, without reconstructing an old diagnostic copy.
      expect(await conversation.restoreMessage(ctx, "input_source")).not.toBeNull();
      expect((await rows()).find(row => row.id === "manifest_source")?.snapshot_json).toBeNull();
    }
  });

  it.each(["message", "version", "session"] as const)("rolls back the %s deletion if linked context cleanup fails", async target => {
    await database.client.execute("CREATE TRIGGER reject_context_cleanup BEFORE UPDATE ON context_manifests WHEN NEW.snapshot_json IS NULL BEGIN SELECT RAISE(ABORT, 'context cleanup failed'); END");
    const deletion = target === "message" ? conversation.softDeleteMessage(ctx, "input_source")
      : target === "version" ? conversation.deleteMessage(ctx, "input_source") : conversation.deleteSession(ctx, sessionId);
    await expect(deletion).rejects.toThrow();
    expect((await conversation.getMessage(ctx, "input_source"))?.deletedAt).toBeNull();
    expect((await conversation.listMessageVersions(ctx, "input_source"))[0]?.content).toBe("history_source");
    expect((await rows()).find(row => row.id === "manifest_source")?.selection_reason).toBe("PRIVATE_source");
  });

  it("does not reintroduce free-form conversation annotations through a late manifest writer", async () => {
    await conversation.deleteSession(ctx, sessionId);
    await platform.createContextManifest({ id: "late", modelRunId: "run_source", purpose: "agent.loop", sourceArtifactId: "turn:history",
      sourceRevisionId: "1", selectionReason: "PRIVATE_late", permissionSnapshot: { content: "PRIVATE_late" },
      snapshot: [{ role: "user", content: "PRIVATE_late" }] });
    const row = (await rows()).find(item => item.id === "late")!;
    expect(row.selection_reason).toBeNull();
    expect(row.permission_snapshot).toBeNull();
    expect(String(row.snapshot_json)).not.toContain("PRIVATE");
  });

  it("cleans linked historical bodies when retrying an identity soft-deleted by an older build", async () => {
    const deletedAt = "2020-01-01T00:00:00.000Z";
    await database.client.execute({ sql: "UPDATE messages SET deleted_at=? WHERE id=?", args: [deletedAt, "input_source"] });
    expect(await conversation.softDeleteMessage(ctx, "input_source")).toBeNull();
    expect((await conversation.getMessage(ctx, "input_source"))?.deletedAt).toBe(deletedAt);
    for (const id of ["manifest_source", "manifest_later"]) {
      expect((await rows()).find(row => row.id === id)).toMatchObject({ snapshot_json: null, permission_snapshot: null, selection_reason: null });
    }
    expect((await rows()).find(row => row.id === "manifest_other")?.selection_reason).toBe("PRIVATE_other");
  });

  it("preserves an independent artifact's permission proof and selection metadata", async () => {
    await platform.createContextManifest({ id: "artifact", modelRunId: "run_other", purpose: "artifact.read",
      sourceArtifactId: "artifact_other", sourceRevisionId: "revision_other", selectionReason: "selected_by_user",
      permissionSnapshot: { grantRevision: "grant_other" } });
    await conversation.deleteSession(ctx, sessionId);
    expect((await rows()).find(item => item.id === "artifact")).toMatchObject({
      selection_reason: "selected_by_user", permission_snapshot: JSON.stringify({ grantRevision: "grant_other" }),
    });
  });
});
