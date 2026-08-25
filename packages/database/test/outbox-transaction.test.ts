import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  SqliteOutboxRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("ADR-004: 业务状态与 OutboxEvent 单事务原子落库测试", () => {
  let db: AervoxDatabase;
  let client: Client;
  let convRepo: SqliteConversationRepository;
  let outboxRepo: SqliteOutboxRepository;

  const tenant: TenantContext = {
    workspaceId: "ws_test",
    subjectUserId: "usr_charlie",
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    convRepo = new SqliteConversationRepository(db);
    outboxRepo = new SqliteOutboxRepository(db);
  });

  it("成功创建 Turn 时，Turn、首条消息与 OutboxEvent 在同一事务中原子提交", async () => {
    const session = await convRepo.createSession(tenant, "Outbox Test Session");

    const { turn, message } = await convRepo.createTurnWithOutbox(
      tenant,
      { id: "turn_tx_1", sessionId: session.id, idempotencyKey: "idem_tx_1", status: "Running" },
      { id: "msg_tx_1", content: "What is photosynthesis?" },
      {
        id: "outbox_1",
        eventType: "turn.created",
        idempotencyKey: "idem_outbox_1",
        payload: { turnId: "turn_tx_1", sessionId: session.id },
      },
    );

    expect(turn.status).toBe("Running");
    expect(message.content).toBe("What is photosynthesis?");

    // 验证 Outbox 表已记录待发布事件
    const pending = await outboxRepo.fetchPendingEvents();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("outbox_1");
    expect(pending[0]!.status).toBe("pending");

    // 标记事件发布成功
    await outboxRepo.markPublished("outbox_1");
    const afterPublish = await outboxRepo.fetchPendingEvents();
    expect(afterPublish).toHaveLength(0);
  });

  it("若事务内由于唯一索引冲突失败，Turn 与 Outbox 同时回滚", async () => {
    const session = await convRepo.createSession(tenant, "Rollback Session");

    // 首次创建成功
    await convRepo.createTurnWithOutbox(
      tenant,
      { id: "turn_first", sessionId: session.id, idempotencyKey: "idem_conflict" },
      { id: "msg_first", content: "First question" },
      { id: "outbox_first", eventType: "turn.created", idempotencyKey: "idem_c1", payload: {} },
    );

    // 再次使用相同的 idempotencyKey 创建，触发唯一索引约束
    await expect(
      convRepo.createTurnWithOutbox(
        tenant,
        { id: "turn_duplicate", sessionId: session.id, idempotencyKey: "idem_conflict" },
        { id: "msg_dup", content: "Duplicate" },
        { id: "outbox_dup", eventType: "turn.created", idempotencyKey: "idem_c2", payload: {} },
      ),
    ).rejects.toThrow();

    // 验证 outbox_dup 没有被遗留写入
    const events = await outboxRepo.fetchPendingEvents();
    expect(events.find((e) => e.id === "outbox_dup")).toBeUndefined();
  });
});
