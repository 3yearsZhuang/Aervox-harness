import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type LocalContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("TC-SEC-LOCAL-DB-001: 本地单用户上下文兼容测试", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;

  const tenantA: LocalContext = {
    workspaceId: "ws_alpha",
    subjectUserId: "usr_alice",
  };

  const tenantB: LocalContext = {
    workspaceId: "ws_beta",
    subjectUserId: "usr_bob",
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
  });

  it("不同兼容上下文共享同一本地 Session 和 Turn", async () => {
    // 1. 通过兼容上下文 A 创建 Session
    const sessionA = await repo.createSession(tenantA, "Alice's Learning Session");
    expect(sessionA.id).toBeDefined();

    // 2. 通过兼容上下文 A 创建 Turn
    const { turn: turnA } = await repo.createTurnWithOutbox(
      tenantA,
      { id: "turn_101", sessionId: sessionA.id, idempotencyKey: "idem_alice_1" },
      { id: "msg_101", content: "Alice private question" },
    );
    expect(turnA.id).toBe("turn_101");

    // 3. 兼容上下文 B 查询同一本地 Session
    const bobQuerySession = await repo.getSession(tenantB, sessionA.id);
    expect(bobQuerySession).not.toBeNull();

    // 4. 兼容上下文 B 查询同一本地 Turn
    const bobQueryTurn = await repo.getTurn(tenantB, turnA.id);
    expect(bobQueryTurn).not.toBeNull();

    // 5. 幂等键也属于本地实例全局范围
    const bobQueryIdem = await repo.getTurnByIdempotencyKey(tenantB, "idem_alice_1");
    expect(bobQueryIdem).not.toBeNull();
  });

  it("兼容 LocalContext 不再作为数据库访问前置条件", async () => {
    const invalidTenant = { workspaceId: "", subjectUserId: "" } as unknown as LocalContext;
    await expect(repo.createSession(invalidTenant, "Invalid Session")).resolves.toBeDefined();
  });
});
