import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import {
  createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, SqliteAgentInboxRepository,
  SqliteMemoryRepository, SqliteMemoryCompactionRepository, SqliteOutboxRepository, collectDiaryMaterial,
  memoryRecords, agentInboxItems, type AervoxDatabase, type ConversationExecutionPolicy,
  botConnections, botInbox, botDeliveries, botSessionBindings,
} from "../src/index.js";
import { createConversationsTables } from "./fixtures/legacy-ddl/conversations.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };

describe("durable Bot execution boundaries", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, client, cleanup } = await createInMemoryDatabase());
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
  });
  afterEach(() => cleanup());

  async function accept(id: string, policy: ConversationExecutionPolicy = "bot-group-member-v1", consumeInbox = false) {
    await repo.getOrCreateSession(ctx, id, id, null, policy);
    return repo.acceptTurn(ctx, {
      turnId: `turn_${id}`, sessionId: id, idempotencyKey: `idem_${id}`, attemptId: `attempt_${id}`,
      message: { id: `message_${id}`, content: `${id} message` }, consumeInbox,
    });
  }

  it("inherits policy and API ownership for every turn creation path, including after repository restart", async () => {
    const accepted = await accept("group");
    expect(accepted.turn).toMatchObject({ executionPolicy: "bot-group-member-v1", dispatchTarget: "api" });
    repo = new SqliteConversationRepository(db);
    expect(await repo.getOrCreateSession(ctx, "group")).toMatchObject({ executionPolicy: "bot-group-member-v1" });
    const next = await repo.createTurnWithAttempt(ctx, {
      turnId: "next", sessionId: "group", idempotencyKey: "next", message: { id: "next_message", content: "next" }, attemptId: "next_attempt",
    });
    expect(next.turn).toMatchObject({ executionPolicy: "bot-group-member-v1", dispatchTarget: "api" });
    const retry = await repo.createTurnWithOutbox(ctx, { id: "retry", sessionId: "group", idempotencyKey: "retry" }, { id: "retry_message", content: "retry" });
    expect(retry.turn).toMatchObject({ executionPolicy: "bot-group-member-v1", dispatchTarget: "api" });
    expect((await accept("owner", "bot-owner-v1")).turn).toMatchObject({ executionPolicy: "bot-owner-v1", dispatchTarget: "api" });
    expect((await accept("local", "local-v1")).turn).toMatchObject({ executionPolicy: "local-v1", dispatchTarget: "default" });
  });

  it("deduplicates acceptance and rejects attempts to upgrade a session or reuse another session's idempotency key", async () => {
    await accept("group");
    const input = { turnId: "second", sessionId: "group", idempotencyKey: "idem_group", attemptId: "second_attempt", message: { id: "second_message", content: "second" }, consumeInbox: false };
    expect(await repo.acceptTurn(ctx, input)).toMatchObject({ created: false, turn: { id: "turn_group", executionPolicy: "bot-group-member-v1" } });
    await expect(repo.acceptTurn(ctx, { ...input, executionPolicy: "local-v1" })).rejects.toThrow("conversation_execution_policy_mismatch");
    await expect(repo.getOrCreateSession(ctx, "group", "group", null, "local-v1")).rejects.toThrow("conversation_execution_policy_mismatch");
    await repo.createSession(ctx, "local", { id: "local" });
    await expect(repo.acceptTurn(ctx, { ...input, sessionId: "local" })).rejects.toThrow("conversation_execution_policy_mismatch");
    expect(await repo.listTurnAttempts(ctx, "turn_group")).toHaveLength(1);
  });

  it("fails closed on unknown persisted policies and mismatched dispatch ownership", async () => {
    await accept("group");
    await client.execute("UPDATE sessions SET execution_policy = 'future-v9' WHERE id = 'group'");
    await expect(repo.getSession(ctx, "group")).rejects.toThrow("conversation_execution_policy_unknown");
    await expect(repo.getTurn(ctx, "turn_group")).rejects.toThrow("conversation_execution_policy_unknown");
    await client.execute("UPDATE sessions SET execution_policy = 'bot-group-member-v1' WHERE id = 'group'");
    await client.execute("UPDATE turns SET dispatch_target = 'default' WHERE id = 'turn_group'");
    await expect(repo.getTurn(ctx, "turn_group")).rejects.toThrow("conversation_execution_policy_mismatch");
  });

  it("does not consume private Inbox payloads for group turns even when requested", async () => {
    await repo.getOrCreateSession(ctx, "group", "group", null, "bot-group-member-v1");
    await new SqliteAgentInboxRepository(db).enqueue(ctx, {
      id: "private_inbox", idempotencyKey: "private_inbox", sessionId: "group", type: "followup",
      sourceActor: "owner", payload: "PRIVATE_INBOX_SECRET", consumeBoundary: "next-turn",
    });
    const accepted = await accept("group", "bot-group-member-v1", true);
    expect(accepted.created && accepted.message.content).toBe("group message");
    expect((await db.select().from(agentInboxItems))[0]?.status).toBe("pending");
  });

  it("requires child branches to inherit the parent policy", async () => {
    await accept("group");
    await repo.createSession(ctx, "local", { id: "local" });
    await expect(repo.createExplorationBranch(ctx, { id: "bad", parentSessionId: "group", childSessionId: "local" })).rejects.toThrow("conversation_execution_policy_mismatch");
    await repo.createSession(ctx, "child", { id: "child", executionPolicy: "bot-group-member-v1" });
    expect(await repo.createExplorationBranch(ctx, { id: "good", parentSessionId: "group", childSessionId: "child" })).toMatchObject({ childSessionId: "child" });
    expect((await repo.getSession(ctx, "child"))?.executionPolicy).toBe("bot-group-member-v1");
  });

  it("excludes group material from shared diary collection and refuses memory creation or compaction", async () => {
    await accept("GROUP_SECRET");
    await accept("owner", "bot-owner-v1");
    await accept("local", "local-v1");
    const memories = new SqliteMemoryRepository(db, client);
    await expect(memories.createRecord(ctx, {
      id: "forbidden", layer: "long_term", type: "user_fact", content: "GROUP_SECRET", sourceTurnId: "turn_GROUP_SECRET",
    })).rejects.toThrow("personal_derived_data_source_forbidden");
    await memories.createRecord(ctx, { id: "owner_memory", layer: "long_term", type: "user_fact", content: "owner fact", sourceTurnId: "turn_owner" });
    // A legacy or externally inserted row still must not enter downstream personal projections.
    const now = new Date().toISOString();
    await db.insert(memoryRecords).values({ id: "legacy_group", layer: "long_term", type: "user_fact", content: "GROUP_SECRET", sourceTurnId: "turn_GROUP_SECRET", createdAt: now, updatedAt: now });
    const material = await collectDiaryMaterial(db, ctx, { startIso: "2000-01-01T00:00:00.000Z", endIso: "2099-01-01T00:00:00.000Z" });
    expect(material.messages.map((m) => m.content)).toEqual(["owner message", "local message"]);
    expect(material.memories.map((m) => m.content)).toEqual(["owner fact"]);
    expect(JSON.stringify(material)).not.toContain("GROUP_SECRET");
    await expect(new SqliteMemoryCompactionRepository(db).upsertMarker(ctx, { id: "mark", memoryId: "legacy_group", snapshotId: "snapshot", summaryText: "GROUP_SECRET" })).rejects.toThrow("memory_compaction_target_unavailable");
    await expect(new SqliteOutboxRepository(db).insertEvent(ctx, { id: "event", idempotencyKey: "event", eventType: "memory.compaction.requested", payload: { memoryId: "legacy_group", snapshotId: "snapshot" } })).rejects.toThrow("memory_compaction_target_unavailable");
  });

  it("keeps API turns out of Worker recovery without changing their persisted policy", async () => {
    await accept("group");
    await accept("local", "local-v1");
    await client.execute("UPDATE turn_attempts SET started_at = '2000-01-01T00:00:00.000Z'");
    expect(await repo.recoverExpiredAttempts(client, { dispatchTarget: "default" })).toBe(1);
    expect((await repo.listTurnAttempts(ctx, "turn_group"))[0]?.status).toBe("Running");
    expect((await repo.getTurn(ctx, "turn_group"))?.executionPolicy).toBe("bot-group-member-v1");
    expect((await repo.getTurn(ctx, "turn_local"))?.status).toBe("Interrupted");
  });

  async function seedBotDelivery() {
    await accept("group");
    const now = new Date().toISOString();
    await db.insert(botConnections).values({ id: "connection", adapterId: "onebot-v11", pluginId: "bot-onebot", displayName: "QQ", createdAt: now });
    await db.insert(botSessionBindings).values({ id: "binding", connectionId: "connection", routeKey: "group/member", sessionId: "group" });
    await db.insert(botInbox).values({ id: "inbox", connectionId: "connection", sessionId: "group", messageJson: '{"text":"DELETED_SECRET"}', connectionRevision: 1, turnId: "turn_group", createdAt: now });
    await db.insert(botDeliveries).values({ id: "delivery", connectionId: "connection", inboxId: "inbox", partIndex: 0, text: "DELETED_SECRET", createdAt: now });
  }

  it("deletes transport copies with a session while keeping a replay tombstone", async () => {
    await seedBotDelivery();
    expect(await repo.deleteSession(ctx, "group")).toBe(true);
    expect(await repo.getSession(ctx, "group")).toBeNull();
    expect(await db.select().from(botSessionBindings)).toEqual([]);
    expect(await db.select().from(botDeliveries)).toEqual([]);
    expect((await db.select().from(botInbox))[0]).toMatchObject({ id: "inbox", state: "deleted", messageJson: "{}" });
  });

  it.each(["physical", "soft"])("deletes transport copies with %s message deletion", async (kind) => {
    await seedBotDelivery();
    if (kind === "physical") expect(await repo.deleteMessage(ctx, "message_group")).toBe(true);
    else {
      await repo.createMessage(ctx, { id: "message_group", sessionId: "group", role: "user" });
      expect(await repo.softDeleteMessage(ctx, "message_group")).not.toBeNull();
    }
    expect(await db.select().from(botDeliveries)).toEqual([]);
    expect((await db.select().from(botInbox))[0]).toMatchObject({ state: "deleted", messageJson: "{}" });
  });

  it("adds local defaults to an existing schema without changing rows", async () => {
    const legacy = createClient({ url: ":memory:" });
    try {
      await legacy.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      await legacy.execute("CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), idempotency_key TEXT NOT NULL, status TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      await legacy.execute("INSERT INTO sessions VALUES ('legacy', 'legacy title', '2000', '2000')");
      await legacy.execute("INSERT INTO turns VALUES ('legacy_turn', 'legacy', 'legacy_key', 'Completed', 0, '2000', '2000')");
      await createConversationsTables(legacy);
      await createConversationsTables(legacy);
      expect((await legacy.execute("SELECT execution_policy FROM sessions")).rows[0]?.execution_policy).toBe("local-v1");
      expect((await legacy.execute("SELECT execution_policy, dispatch_target FROM turns WHERE id = 'legacy_turn'")).rows[0]).toMatchObject({ execution_policy: "local-v1", dispatch_target: "default" });
    } finally { legacy.close(); }
  });
});
