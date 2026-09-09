import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("TC-CONV-SESSION-001: getOrCreateSession 修复 Turn 外键依赖", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;

  const tenantA: TenantContext = { workspaceId: "ws_alpha", subjectUserId: "usr_alice" };
  const tenantB: TenantContext = { workspaceId: "ws_beta", subjectUserId: "usr_bob" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
  });

  it("API 流程: 外部 sessionId 直接创建 Turn,自动补齐会话,无外键违约", async () => {
    const session = await repo.getOrCreateSession(tenantA, "desktop-demo");
    expect(session.id).toBe("desktop-demo");
    expect(session.workspaceId).toBe("ws_alpha");

    const { turn } = await repo.createTurnWithOutbox(
      tenantA,
      { id: "turn_200", sessionId: "desktop-demo", idempotencyKey: "idem_200" },
      { id: "msg_200", content: "hello" },
    );
    expect(turn.id).toBe("turn_200");
    expect(turn.sessionId).toBe("desktop-demo");
  });

  it("重复调用返回同一会话且不覆盖标题(幂等)", async () => {
    const first = await repo.getOrCreateSession(tenantA, "desktop-demo", "标题A");
    const second = await repo.getOrCreateSession(tenantA, "desktop-demo", "标题B");
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("标题A");
  });

  it("租户隔离: 会话按租户可见,他租户不可见", async () => {
    await repo.getOrCreateSession(tenantA, "desktop-demo");
    const bobView = await repo.getSession(tenantB, "desktop-demo");
    expect(bobView).toBeNull();

    // 他租户可用自己的 id 创建独立会话
    const bobSession = await repo.getOrCreateSession(tenantB, "bob-session");
    expect(bobSession.workspaceId).toBe("ws_beta");
  });
});
