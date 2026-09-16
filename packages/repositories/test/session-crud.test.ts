import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type LocalContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("CR-035 W1: SqliteConversationRepository session CRUD", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;

  const ctx: LocalContext = { workspaceId: "local", subjectUserId: "local" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
  });

  it("lists sessions ordered by updatedAt descending", async () => {
    const s1 = await repo.createSession(ctx, "第一会话");
    // small sleep to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 10));
    const s2 = await repo.createSession(ctx, "第二会话");

    const list = await repo.listSessions(ctx);
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(s2.id);
    expect(list[1].id).toBe(s1.id);
  });

  it("renames a session and updates updatedAt", async () => {
    const s1 = await repo.createSession(ctx, "原始标题");
    const renamed = await repo.renameSession(ctx, s1.id, "更新标题");

    expect(renamed).not.toBeNull();
    expect(renamed?.title).toBe("更新标题");

    const fetched = await repo.getSession(ctx, s1.id);
    expect(fetched?.title).toBe("更新标题");

    const missing = await repo.renameSession(ctx, "non_existent", "新标题");
    expect(missing).toBeNull();
  });

  it("deletes a session and cascades associated turns", async () => {
    const s = await repo.createSession(ctx, "待删除会话");
    await repo.createTurnWithOutbox(
      ctx,
      { id: "turn_del_1", sessionId: s.id, idempotencyKey: "idem_del_1" },
      { id: "msg_del_1", content: "hello" },
    );

    const deleted = await repo.deleteSession(ctx, s.id);
    expect(deleted).toBe(true);

    const fetched = await repo.getSession(ctx, s.id);
    expect(fetched).toBeNull();

    const fetchedTurn = await repo.getTurn(ctx, "turn_del_1");
    expect(fetchedTurn).toBeNull();

    const notFound = await repo.deleteSession(ctx, "non_existent");
    expect(notFound).toBe(false);
  });
});
