import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  SqliteMemoryRepository,
  indexMessageFts,
  searchMessagesFts,
  deleteMessageFts,
  InMemoryVectorSearchAdapter,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("TC-PRIV-DEL-001: 删除传播与即刻零召回验证测试", () => {
  let db: AervoxDatabase;
  let client: Client;
  let convRepo: SqliteConversationRepository;
  let memoryRepo: SqliteMemoryRepository;
  let vectorPort: InMemoryVectorSearchAdapter;

  const tenant: TenantContext = {
    workspaceId: "ws_del_verify",
    subjectUserId: "usr_eva",
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    convRepo = new SqliteConversationRepository(db);
    memoryRepo = new SqliteMemoryRepository(db, client);
    vectorPort = new InMemoryVectorSearchAdapter();
  });

  it("删除消息后，业务记录、FTS5 全文索引与向量检索立即实现零召回", async () => {
    const session = await convRepo.createSession(tenant, "Sensitive Session");
    const messageId = "msg_sensitive_999";
    const sensitiveText = "My private password reminder is sunshine123";

    // 1. 落库业务消息
    await convRepo.createTurnWithOutbox(
      tenant,
      { id: "turn_sens_1", sessionId: session.id, idempotencyKey: "idem_sens_1" },
      { id: messageId, content: sensitiveText },
    );

    // 2. 建立 FTS5 与 Vector 派生索引
    await indexMessageFts(client, tenant, { id: messageId, content: sensitiveText });
    await vectorPort.upsert(tenant, [
      { id: messageId, vector: [0.1, 0.9, 0.4], metadata: { content: sensitiveText } },
    ]);

    // 3. 验证删除前能够检索召回
    const ftsBefore = await searchMessagesFts(client, tenant, "sunshine123");
    expect(ftsBefore).toHaveLength(1);
    expect(ftsBefore[0]!.id).toBe(messageId);

    const vectorBefore = await vectorPort.search(tenant, [0.1, 0.9, 0.4], 5);
    expect(vectorBefore).toHaveLength(1);
    expect(vectorBefore[0]!.id).toBe(messageId);

    // 4. 执行删除传播（清除消息、清理 FTS5 虚表、删除向量索引）
    const deleted = await convRepo.deleteMessage(tenant, messageId);
    expect(deleted).toBe(true);
    await deleteMessageFts(client, tenant, messageId);
    await vectorPort.delete(tenant, messageId);

    // 5. 验证删除后：FTS5 与 Vector 零召回
    const ftsAfter = await searchMessagesFts(client, tenant, "sunshine123");
    expect(ftsAfter).toHaveLength(0);

    const vectorAfter = await vectorPort.search(tenant, [0.1, 0.9, 0.4], 5);
    expect(vectorAfter).toHaveLength(0);
  });
});
