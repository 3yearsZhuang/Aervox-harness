import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresqlDatabase } from "../src/driver/create-postgresql-database.js";
import { SqliteConversationRepository } from "../src/repositories/sqlite/conversation-repository.js";
import { SqlitePlatformRepository } from "../src/repositories/sqlite/platform-repository.js";
import { SqlitePrivacyRepository } from "../src/repositories/sqlite/privacy-repository.js";
import { MEMORY_DELETION_VERIFIER } from "../src/memory-deletion-protocol.js";

const databaseUrl = process.env.AERVOX_TEST_POSTGRES_URL ?? process.env.AERVOX_PG_TEST_URL;
const ctx = { workspaceId: "local", subjectUserId: "local" };
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

describe.skipIf(!databaseUrl)("PostgreSQL conversation deletion clears historical context bodies", () => {
  let database: Awaited<ReturnType<typeof createPostgresqlDatabase>>;
  let conversation: SqliteConversationRepository;
  let platform: SqlitePlatformRepository;
  let admin: Pool;
  const schema = `aervox_context_${randomUUID().replaceAll("-", "")}`;
  let caseNumber = 0;
  let prefix: string;
  let sessionId: string;
  let otherSessionId: string;
  const id = (name: string): string => `${prefix}_${name}`;
  const rows = async () => (await database.client.execute({
    sql: "SELECT id,snapshot_json,permission_snapshot,selection_reason FROM context_manifests WHERE id LIKE ? ORDER BY id",
    args: [`${prefix}_%`],
  })).rows;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    database = await createPostgresqlDatabase({ connectionString: databaseUrl!, schema,
      instanceId: "context-deletion-owner", initializeEmpty: true });
    conversation = new SqliteConversationRepository(database.db);
    platform = new SqlitePlatformRepository(database.db);
  });
  afterAll(async () => {
    await database?.closeAsync();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    prefix = `case${++caseNumber}`;
    // PostgreSQL rejects embedded NUL at admission. Quotes, slashes and Unicode
    // still exercise exact bound ownership without broadening a prefix match.
    otherSessionId = id("removed");
    sessionId = `${otherSessionId}-"\\🌙`;
    await conversation.getOrCreateSession(ctx, sessionId);
    await conversation.getOrCreateSession(ctx, otherSessionId);
    for (const [name, session] of [["source", sessionId], ["later", sessionId], ["other", otherSessionId]] as const) {
      await conversation.acceptTurn(ctx, { turnId: id(name), sessionId: session, idempotencyKey: id(name),
        attemptId: id(`attempt_${name}`), message: { id: id(`input_${name}`), content: `history_${name}` }, consumeInbox: false });
      await platform.createModelRun(ctx, { id: id(`run_${name}`), attemptId: id(`attempt_${name}`),
        purpose: "agent.loop", provider: "fixture", modelId: "fixture" });
      await platform.createContextManifest({ id: id(`manifest_${name}`), modelRunId: id(`run_${name}`),
        purpose: "agent.loop", sourceArtifactId: "turn:history", sourceRevisionId: "1" });
      // Seed the actual pre-minimization TEXT values, not a mock query result.
      await database.client.execute({
        sql: "UPDATE context_manifests SET snapshot_json=?,permission_snapshot=?,selection_reason=? WHERE id=?",
        args: [JSON.stringify({ messages: [{ content: `PRIVATE_${name}` }], tools: [{ description: `PRIVATE_${name}` }] }),
          JSON.stringify({ note: `PRIVATE_${name}` }), `PRIVATE_${name}`, id(`manifest_${name}`)],
      });
    }
  });

  it.each(["message", "version", "session"] as const)("clears every linked session manifest on %s deletion and preserves a different exact identity", async target => {
    if (target === "message") expect(await conversation.softDeleteMessage(ctx, id("input_source"))).not.toBeNull();
    else if (target === "version") expect(await conversation.deleteMessage(ctx, id("input_source"))).toBe(true);
    else expect(await conversation.deleteSession(ctx, sessionId)).toBe(true);
    const remaining = await rows();
    for (const name of ["source", "later"]) {
      expect(remaining.find(row => row.id === id(`manifest_${name}`))).toMatchObject({
        snapshot_json: null, permission_snapshot: null, selection_reason: null,
      });
    }
    expect(remaining.find(row => row.id === id("manifest_other"))).toMatchObject({ selection_reason: "PRIVATE_other" });
    expect((await conversation.getSessionHistoryPage(ctx, { sessionId: otherSessionId })).items[0]?.messages[0]?.content).toBe("history_other");
    if (target === "message") {
      expect(await conversation.restoreMessage(ctx, id("input_source"))).not.toBeNull();
      expect((await rows()).find(row => row.id === id("manifest_source"))?.snapshot_json).toBeNull();
    }
  });

  it.each(["message", "version", "session"] as const)("rolls back %s deletion when the actual context update fails", async target => {
    const constraint = `reject_context_cleanup_${caseNumber}`;
    // Inject a failure into the already admitted connection's next UPDATE.
    // No trigger or SQLite RAISE syntax is emulated in the PostgreSQL driver.
    await admin.query(`ALTER TABLE ${quote(schema)}.context_manifests ADD CONSTRAINT ${quote(constraint)}
      CHECK (id <> '${id("manifest_source")}' OR snapshot_json IS NOT NULL)`);
    try {
      const deletion = target === "message" ? conversation.softDeleteMessage(ctx, id("input_source"))
        : target === "version" ? conversation.deleteMessage(ctx, id("input_source")) : conversation.deleteSession(ctx, sessionId);
      await expect(deletion).rejects.toMatchObject({ code: "23514" });
      expect((await conversation.getMessage(ctx, id("input_source")))?.deletedAt).toBeNull();
      expect((await conversation.listMessageVersions(ctx, id("input_source")))[0]?.content).toBe("history_source");
      expect((await rows()).find(row => row.id === id("manifest_source"))?.selection_reason).toBe("PRIVATE_source");
    } finally {
      await admin.query(`ALTER TABLE ${quote(schema)}.context_manifests DROP CONSTRAINT ${quote(constraint)}`);
    }
  });

  it("does not persist prompt bodies or free-form annotations from a late conversation manifest writer", async () => {
    await conversation.deleteSession(ctx, sessionId);
    await platform.createContextManifest({ id: id("late"), modelRunId: id("run_source"), purpose: "agent.loop",
      sourceArtifactId: "turn:history", sourceRevisionId: "1", selectionReason: "PRIVATE_late",
      permissionSnapshot: { content: "PRIVATE_late" }, snapshot: [{ role: "user", content: "PRIVATE_late" }] });
    const row = (await rows()).find(item => item.id === id("late"))!;
    expect(row.selection_reason).toBeNull();
    expect(row.permission_snapshot).toBeNull();
    expect(String(row.snapshot_json)).not.toContain("PRIVATE");
  });

  it("clears old diagnostic copies when an already soft-deleted message is deleted again", async () => {
    const deletedAt = "2020-01-01T00:00:00.000Z";
    await database.client.execute({ sql: "UPDATE messages SET deleted_at=? WHERE id=?", args: [deletedAt, id("input_source")] });
    expect(await conversation.softDeleteMessage(ctx, id("input_source"))).toBeNull();
    expect((await conversation.getMessage(ctx, id("input_source")))?.deletedAt).toBe(deletedAt);
    for (const name of ["source", "later"]) {
      expect((await rows()).find(row => row.id === id(`manifest_${name}`))).toMatchObject({
        snapshot_json: null, permission_snapshot: null, selection_reason: null,
      });
    }
    expect((await rows()).find(row => row.id === id("manifest_other"))?.selection_reason).toBe("PRIVATE_other");
  });

  it("preserves an independent source's JSON permission proof and selection metadata", async () => {
    const proof = { grantRevision: 'grant-"🌙', allowed: true };
    await platform.createContextManifest({ id: id("artifact"), modelRunId: id("run_other"), purpose: "artifact.read",
      sourceArtifactId: "artifact_other", sourceRevisionId: "revision_other", selectionReason: "selected_by_user",
      permissionSnapshot: proof });
    await conversation.deleteSession(ctx, sessionId);
    expect((await rows()).find(item => item.id === id("artifact"))?.selection_reason).toBe("selected_by_user");
    expect(JSON.parse(String((await rows()).find(item => item.id === id("artifact"))?.permission_snapshot))).toEqual(proof);
  });

  it.each([
    ["beforeTurn", "user"], ["afterTurn", "user"],
    ["beforeTurn", "assistant"], ["afterTurn", "assistant"],
    ["beforeTurn", "first-version"], ["afterTurn", "first-version"],
  ] as const)("refuses a %s Hook body after %s deletion without publishing or allocating a sequence", async (phase, target) => {
    const turnId = id("source"), attemptId = id("attempt_source"), assistantId = `msg_${turnId}_assistant`;
    await conversation.appendStreamEvent(ctx, { id: id("message_event"), turnId, attemptId, expectedFencingToken: 0,
      sequence: 1, eventType: "message", safetyDecision: "approved", data: { messageId: assistantId, role: "assistant" } });
    await conversation.recordSafeSegmentAtomically(ctx, { turnId, attemptId, expectedFencingToken: 0, sequence: 2,
      text: "committed prefix", eventData: { messageId: assistantId, text: "committed prefix" }, safetyDecision: "approved" });
    await database.client.execute({ sql: "INSERT INTO plugins(id,publisher,version,checksum,enabled,availability,lifecycle_generation,created_at,updated_at) VALUES (?,'fixture','1','fixture',1,'available','g','now','now')", args: [id("hook")] });
    if (target === "first-version") await conversation.deleteMessage(ctx, id("input_source"));
    else await conversation.softDeleteMessage(ctx, target === "user" ? id("input_source") : assistantId);
    const events = await conversation.getStreamEvents(ctx, turnId), turn = await conversation.getTurn(ctx, turnId);
    await expect(conversation.appendPluginHookEvent(ctx, { turnId, attemptId, expectedFencingToken: 0,
      pluginGeneration: { pluginId: id("hook"), generation: "g" }, phase, eventType: "delta", data: { text: "PRIVATE_late" } })).rejects.toThrow("conversation_source_unavailable");
    expect(await conversation.getStreamEvents(ctx, turnId)).toEqual(events);
    expect(await conversation.getTurn(ctx, turnId)).toEqual(turn);
    expect((await conversation.listTurnAttempts(ctx, turnId))[0]?.status).toBe("Running");
  });

  it.each([
    { scope: "account" }, { ownerModule: "other" }, { targetType: "attachment" },
    { targetOwner: "other" }, { targetId: "" },
  ])("keeps unsupported PostgreSQL deletion completion %j denied and retryable with a current verifier", async change => {
    await database.client.execute("DELETE FROM deletion_targets"); await database.client.execute("DELETE FROM deletion_requests");
    const privacy = new SqlitePrivacyRepository(database.db), requestId = id("deletion");
    const target = { targetType: change.targetType ?? "memory", targetId: change.targetId ?? id("target"), ownerModule: change.targetOwner ?? "memory" };
    await privacy.createDeletionRequest(ctx, { id: requestId, idempotencyKey: requestId, scope: change.scope ?? "memory", ownerModule: change.ownerModule ?? "memory", targets: [target] });
    await privacy.updateDeletionTargetStatus({ requestId, targetType: target.targetType, targetId: target.targetId }, "completed", JSON.stringify({ verifier: MEMORY_DELETION_VERIFIER }));
    await privacy.updateDeletionRequestStatus(ctx, requestId, "completed", { lastVerifiedAt: "2026-11-07T00:00:00.000Z" });
    const original = await privacy.getDeletionRequest(ctx, requestId), targets = await privacy.listDeletionTargets(requestId);
    expect(await privacy.hasPendingDeletionRequest(ctx)).toBe(true);
    expect((await privacy.listUnverifiedDeletionRequests()).map(request => request.id)).toEqual([requestId]);
    expect(await privacy.getDeletionRequest(ctx, requestId)).toEqual(original);
    expect(await privacy.listDeletionTargets(requestId)).toEqual(targets);
    expect(await privacy.beginDeletionRequestAttempt(requestId)).toMatchObject({ status: "in_progress", attemptCount: 1 });
  });

  it("does not reopen a supported memory completion with the current verifier", async () => {
    await database.client.execute("DELETE FROM deletion_targets"); await database.client.execute("DELETE FROM deletion_requests");
    const privacy = new SqlitePrivacyRepository(database.db), requestId = id("supported_deletion"), targetId = id("supported_target");
    await privacy.createDeletionRequest(ctx, { id: requestId, idempotencyKey: requestId, scope: "memory", ownerModule: "memory",
      targets: [{ targetType: "memory", targetId, ownerModule: "memory" }] });
    await privacy.updateDeletionTargetStatus({ requestId, targetType: "memory", targetId }, "completed", JSON.stringify({ verifier: MEMORY_DELETION_VERIFIER }));
    await privacy.updateDeletionRequestStatus(ctx, requestId, "completed", { lastVerifiedAt: "2026-11-07T00:00:00.000Z" });
    expect(await privacy.hasPendingDeletionRequest(ctx)).toBe(false);
    expect(await privacy.listUnverifiedDeletionRequests()).toEqual([]);
    expect(await privacy.beginDeletionRequestAttempt(requestId)).toBeNull();
  });
});
