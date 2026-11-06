import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "../src/client.js";
import { createPostgresqlDatabase } from "../src/driver/create-postgresql-database.js";
import { SqliteConversationRepository } from "../src/repositories/sqlite/conversation-repository.js";

const databaseUrl = process.env.AERVOX_TEST_POSTGRES_URL ?? process.env.AERVOX_PG_TEST_URL;
const ctx = { workspaceId: "local", subjectUserId: "local" };
describe.skipIf(!databaseUrl)("SQLite and PostgreSQL repository prefix parity", () => {
  let sqlite: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let postgres: Awaited<ReturnType<typeof createPostgresqlDatabase>>;
  let admin: Pool;
  const schema = `aervox_prefix_${randomUUID().replaceAll("-", "")}`;
  const repositories: SqliteConversationRepository[] = [];
  beforeAll(async () => {
    sqlite = await createInMemoryDatabase();
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    postgres = await createPostgresqlDatabase({ connectionString: databaseUrl!, schema,
      instanceId: "prefix-owner", initializeEmpty: true });
    repositories.push(new SqliteConversationRepository(sqlite.db), new SqliteConversationRepository(postgres.db));
  });
  afterAll(async () => {
    await postgres?.closeAsync(); await sqlite?.cleanup();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  async function seed(repo: SqliteConversationRepository, sessionId: string, id: string, key: string) {
    await repo.createTurnWithOutbox(ctx, { id, sessionId, idempotencyKey: key, status: "Completed" },
      { id: `user_${id}`, content: `question_${id}` });
    await repo.createTurnAttempt(ctx, id, { id: `attempt_${id}` });
    await repo.appendStreamEvent(ctx, { id: `delta_${id}`, turnId: id, attemptId: `attempt_${id}`, sequence: 1,
      eventType: "delta", safetyDecision: "approved", data: { messageId: `assistant_${id}`, text: `answer_${id}` } });
    await repo.appendStreamEvent(ctx, { id: `done_${id}`, turnId: id, attemptId: `attempt_${id}`, sequence: 2,
      eventType: "done", safetyDecision: "approved", data: { messageId: `assistant_${id}`, status: "Completed", isComplete: true } });
  }
  it("excludes ASCII case variants of child Turns from pages, cursors and model history", async () => {
    for (const repo of repositories) {
      await repo.createSession(ctx, "Prefix history", { id: "prefix-history" });
      await seed(repo, "prefix-history", "ordinary", "ordinary");
      await seed(repo, "prefix-history", "lower-child", "subagent:lower");
      await seed(repo, "prefix-history", "upper-child", "SuBaGeNt:upper");
      // ASCII folding must not broaden into Unicode case normalization.
      await seed(repo, "prefix-history", "unicode", "ſubagent:unicode");
      await seed(repo, "prefix-history", "current", "current");
      const page = await repo.getSessionHistoryPage(ctx, { sessionId: "prefix-history" });
      expect(page.items.map(item => item.turnId)).toEqual(["ordinary", "unicode", "current"]);
      expect(page.nextCursor).toBeNull();
      const cursor = Buffer.from(JSON.stringify({ v: 1, sessionId: "prefix-history", beforeTurnId: "upper-child" })).toString("base64url");
      await expect(repo.getSessionHistoryPage(ctx, { sessionId: "prefix-history", cursor }))
        .rejects.toMatchObject({ code: "HISTORY_CURSOR_EXPIRED" });
      expect(await repo.getSessionHistory(ctx, { sessionId: "prefix-history", beforeTurnId: "current" })).toEqual([
        { role: "user", content: "question_ordinary" }, { role: "assistant", content: "answer_ordinary" },
        { role: "user", content: "question_unicode" }, { role: "assistant", content: "answer_unicode" },
      ]);
    }
  }, 30_000);
  it("does not reuse automatic approvals whose excluded prefix differs only in ASCII case", async () => {
    for (const repo of repositories) {
      await repo.createSession(ctx, "Prefix approvals", { id: "prefix-approvals" });
      await seed(repo, "prefix-approvals", "approval-turn", "approval-turn");
      const request = { turnId: "approval-turn", attemptId: "attempt_approval-turn", toolName: "write_note",
        argumentsHash: "same-intent", requester: "owner", state: "pending" as const };
      const excluded = ["permission:full_access:", "permission:proactive_action:"];
      for (const decidedBy of ["permission:full_access:old", "Permission:FULL_ACCESS:old", "PERMISSION:Proactive_Action:old"]) {
        const approval = await repo.recordToolApproval(ctx, request);
        expect(await repo.decideToolApproval(ctx, approval.id, "granted", decidedBy)).toMatchObject({ state: "granted", decidedBy });
      }
      expect(await repo.findGrantedToolApproval(ctx, { toolName: request.toolName, argumentsHash: request.argumentsHash,
        excludeDecidedByPrefixes: excluded })).toBeNull();
      const manual = await repo.recordToolApproval(ctx, request);
      await repo.decideToolApproval(ctx, manual.id, "granted", "owner");
      expect(await repo.findGrantedToolApproval(ctx, { toolName: request.toolName, argumentsHash: request.argumentsHash,
        excludeDecidedByPrefixes: excluded })).toMatchObject({ id: manual.id, decidedBy: "owner" });
      const ownerExcluded = await repo.findGrantedToolApproval(ctx, { toolName: request.toolName, argumentsHash: request.argumentsHash,
        excludeDecidedByPrefix: "OWNER" });
      expect(ownerExcluded).toMatchObject({ state: "granted" });
      expect(ownerExcluded!.id).not.toBe(manual.id);
    }
  }, 30_000);
});
