import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("TC-SEC-TENANT-001: 多租户数据隔离测试", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;

  const tenantA: TenantContext = {
    workspaceId: "ws_alpha",
    subjectUserId: "usr_alice",
  };

  const tenantB: TenantContext = {
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

  it("Tenant A 创建的 Session 和 Turn，Tenant B 无法访问", async () => {
    // 1. Alice 在 ws_alpha 创建 Session
    const sessionA = await repo.createSession(tenantA, "Alice's Learning Session");
    expect(sessionA.id).toBeDefined();

    // 2. Alice 创建 Turn
    const { turn: turnA } = await repo.createTurnWithOutbox(
      tenantA,
      { id: "turn_101", sessionId: sessionA.id, idempotencyKey: "idem_alice_1" },
      { id: "msg_101", content: "Alice private question" },
    );
    expect(turnA.id).toBe("turn_101");

    // 3. Bob (ws_beta / usr_bob) 查询该 Session 应当返回 null
    const bobQuerySession = await repo.getSession(tenantB, sessionA.id);
    expect(bobQuerySession).toBeNull();

    // 4. Bob 查询该 Turn 应当返回 null
    const bobQueryTurn = await repo.getTurn(tenantB, turnA.id);
    expect(bobQueryTurn).toBeNull();

    // 5. Bob 通过相同的 idempotencyKey 无法查到 Alice 的记录
    const bobQueryIdem = await repo.getTurnByIdempotencyKey(tenantB, "idem_alice_1");
    expect(bobQueryIdem).toBeNull();
  });

  it("当 TenantContext 缺失或非法时，仓储操作应当抛出强隔离校验异常", async () => {
    const invalidTenant = { workspaceId: "", subjectUserId: "" } as unknown as TenantContext;
    await expect(repo.createSession(invalidTenant, "Invalid Session")).rejects.toThrow(
      "TenantContext.workspaceId must be a non-empty string",
    );
  });
});
