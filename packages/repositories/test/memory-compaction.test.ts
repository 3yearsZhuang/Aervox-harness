import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteMemoryRepository,
  SqliteMemoryCompactionRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";

describe("T-03 上下文压缩标记", () => {
  let db: AervoxDatabase;
  let client: Client;
  let memoryRepo: SqliteMemoryRepository;
  let compactionRepo: SqliteMemoryCompactionRepository;

  const tenant: TenantContext = { workspaceId: "ws_1", subjectUserId: "usr_1" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    memoryRepo = new SqliteMemoryRepository(db, client);
    compactionRepo = new SqliteMemoryCompactionRepository(db);
  });

  it("写入标记并可按 snapshotId 溯源", async () => {
    const memory = await memoryRepo.createRecord(tenant, {
      id: "mem_1",
      layer: "short_term",
      type: "learning_event",
      content: "短期记忆产物",
    });

    const marker = await compactionRepo.upsertMarker(tenant, {
      id: "cmark_1",
      memoryId: memory.id,
      snapshotId: "snap_001",
      coveredUpToMessageId: "msg_10",
      summaryText: "压缩摘要",
      phase: "auto",
      thoughtDurationMs: 120,
      summaryDurationMs: 80,
    });

    expect(marker.snapshotId).toBe("snap_001");
    const found = await compactionRepo.getMarkerBySnapshotId(tenant, "snap_001");
    expect(found).not.toBeNull();
    expect(found!.memoryId).toBe("mem_1");
    expect(found!.coveredUpToMessageId).toBe("msg_10");
    expect(found!.summaryText).toBe("压缩摘要");
  });

  it("同 memoryId + snapshotId 幂等：不覆盖既有标记", async () => {
    await memoryRepo.createRecord(tenant, {
      id: "mem_2",
      layer: "short_term",
      type: "learning_event",
      content: "短期记忆产物 B",
    });
    await compactionRepo.upsertMarker(tenant, {
      id: "cmark_2",
      memoryId: "mem_2",
      snapshotId: "snap_002",
      summaryText: "第一版摘要",
    });
    const second = await compactionRepo.upsertMarker(tenant, {
      id: "cmark_2b",
      memoryId: "mem_2",
      snapshotId: "snap_002",
      summaryText: "不应写入的第二版",
    });

    expect(second.summaryText).toBe("第一版摘要");
    const all = await compactionRepo.listMarkersByMemoryId(tenant, "mem_2");
    expect(all).toHaveLength(1);
  });

  it("recordEvent 写入 memory_events 审计（action=compressed）", async () => {
    await memoryRepo.createRecord(tenant, {
      id: "mem_3",
      layer: "short_term",
      type: "learning_event",
      content: "短期记忆产物 C",
    });
    await compactionRepo.recordEvent(tenant, {
      id: "evt_1",
      memoryId: "mem_3",
      action: "compressed",
      fromTier: "ephemeral",
      toTier: "short_term",
      reason: "上下文窗口压缩",
    });

    const rows = await client.execute(
      "SELECT action, from_tier, to_tier FROM memory_events WHERE id = 'evt_1'",
    );
    expect(rows.rows[0]).toMatchObject({
      action: "compressed",
      from_tier: "ephemeral",
      to_tier: "short_term",
    });
  });

  it("PET-02：createRecord 支持 source/category/keywords/lastUsedAt 字段", async () => {
    const memory = await memoryRepo.createRecord(tenant, {
      id: "mem_4",
      layer: "long_term",
      type: "user_preference",
      content: "用户喜欢番茄工作法",
      source: "ai_inferred",
      category: "habit",
      keywords: ["番茄工作法", "专注"],
      lastUsedAt: "2026-08-26T10:00:00.000Z",
    });

    const found = await memoryRepo.getRecord(tenant, "mem_4");
    expect(found!.source).toBe("ai_inferred");
    expect(found!.category).toBe("habit");
    expect(JSON.parse(found!.keywordsJson!)).toEqual(["番茄工作法", "专注"]);
    expect(found!.lastUsedAt).toBe("2026-08-26T10:00:00.000Z");

    // 缺省值：user_said / other
    const plain = await memoryRepo.createRecord(tenant, {
      id: "mem_5",
      layer: "long_term",
      type: "user_fact",
      content: "用户叫小明",
    });
    const plainFound = await memoryRepo.getRecord(tenant, "mem_5");
    expect(plainFound!.source).toBe("user_said");
    expect(plainFound!.category).toBe("other");
    expect(plain!.keywordsJson).toBe(null);
  });
});