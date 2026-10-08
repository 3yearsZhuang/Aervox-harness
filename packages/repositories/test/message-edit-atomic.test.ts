import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository } from "../src/index.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };

describe("消息编辑短事务", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(ctx, "session");
    await repo.createTurnWithOutbox(ctx, {
      id: "turn", sessionId: "session", idempotencyKey: "turn", status: "Completed",
    }, { id: "v1", content: "old" });
    await repo.createMessage(ctx, { id: "message", sessionId: "session", role: "user" });
    await database.db.run(sql`UPDATE message_versions SET message_id = 'message' WHERE id = 'v1'`);
    await database.db.run(sql`UPDATE messages SET current_version_id = 'v1' WHERE id = 'message'`);
  });
  afterEach(async () => { await database.cleanup(); });

  it.each(["message_versions", "messages"])("%s 写入失败保留完整旧版本和指针", async (table) => {
    const event = table === "messages" ? "UPDATE" : "INSERT";
    await database.db.run(sql.raw(`CREATE TRIGGER reject_edit BEFORE ${event} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'injected edit failure'); END`));
    await expect(repo.editMessage(ctx, "message", "new", 1)).rejects.toThrow();
    expect((await repo.getMessage(ctx, "message"))?.currentVersionId).toBe("v1");
    expect(await repo.listMessageVersions(ctx, "message")).toMatchObject([
      { id: "v1", version: 1, content: "old", supersededAt: null },
    ]);
    await database.db.run(sql`DROP TRIGGER reject_edit`);
    expect((await repo.editMessage(ctx, "message", "new", 1))?.newVersion.version).toBe(2);
    expect(await repo.editMessage(ctx, "message", "stale", 1)).toBeNull();
  });

  it("已软删除的消息不可编辑；编辑后软删除保留完整版本", async () => {
    await repo.softDeleteMessage(ctx, "message");
    expect(await repo.editMessage(ctx, "message", "blocked", 1)).toBeNull();
    await repo.restoreMessage(ctx, "message");
    const edited = await repo.editMessage(ctx, "message", "new", 1);
    await repo.softDeleteMessage(ctx, "message");
    const current = await repo.getMessage(ctx, "message");
    expect(current?.deletedAt).toBeTruthy();
    expect(current?.currentVersionId).toBe(edited?.newVersion.id);
    expect(await repo.listMessageVersions(ctx, "message")).toHaveLength(2);
  });
});
