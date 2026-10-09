import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteOutboxRepository,
  SqlitePlatformRepository,
  SqliteMemoryCompactionRepository,
  SqliteMemoryRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { runOutboxCycle } from "../src/outbox-worker.js";
import { runCompactionMarkerCycle, COMPACTION_EVENT_TYPE } from "../src/compaction-marker.js";

describe("FND-01: Outbox 消费归属、抢先完成防御与失败死信测试", () => {
  let db: AervoxDatabase;
  let client: Client;
  let outboxRepo: SqliteOutboxRepository;
  let platformRepo: SqlitePlatformRepository;
  let compactionRepo: SqliteMemoryCompactionRepository;
  let memoryRepo: SqliteMemoryRepository;

  const localCtx: LocalContext = {
    workspaceId: "local",
    subjectUserId: "local",
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    outboxRepo = new SqliteOutboxRepository(db);
    platformRepo = new SqlitePlatformRepository(db);
    compactionRepo = new SqliteMemoryCompactionRepository(db);
    memoryRepo = new SqliteMemoryRepository(db, client);
  });

  it("防抢先完成：通用 Outbox 循环先执行时，不得抢先标记发布压缩事件（保证压缩标记正常生成）", async () => {
    // 0. 先建立先验 memory 记录（满足外键约束）
    await memoryRepo.createRecord(localCtx, {
      id: "mem_alpha",
      layer: "short_term",
      type: "learning_event",
      content: "Alpha test memory content",
    });

    // 1. 插入 memory.compaction.requested 事件与通用业务事件
    await outboxRepo.insertEvent(localCtx, {
      id: "evt_compact_1",
      idempotencyKey: "idem_compact_1",
      eventType: COMPACTION_EVENT_TYPE,
      payload: {
        memoryId: "mem_alpha",
        snapshotId: "snap_alpha_1",
        summaryText: "Key facts summarized",
      },
    });

    await outboxRepo.insertEvent(localCtx, {
      id: "evt_turn_1",
      idempotencyKey: "idem_turn_1",
      eventType: "turn.created",
      payload: { turnId: "turn_1" },
    });

    // 2. 先执行通用 Outbox 循环
    const outboxProcessed = await runOutboxCycle({
      outboxRepo,
      platformRepo,
      workerId: "test_worker",
    });

    // 通用循环只处理了通用事件，排除了压缩事件
    expect(outboxProcessed).toBe(1);

    const turnEvent = await outboxRepo.getEventById("evt_turn_1");
    expect(turnEvent?.status).toBe("published");

    const compactEventBefore = await outboxRepo.getEventById("evt_compact_1");
    expect(compactEventBefore?.status).toBe("pending");

    // 3. 执行压缩消费循环
    const markersCreated = await runCompactionMarkerCycle({
      outboxRepo,
      compactionRepo,
      workerId: "test_worker",
    });

    expect(markersCreated).toBe(1);

    // 验证压缩标记与审计已成功写入
    const marker = await compactionRepo.getMarkerBySnapshotId(localCtx, "snap_alpha_1");
    expect(marker).not.toBeNull();
    expect(marker?.memoryId).toBe("mem_alpha");
    expect(marker?.summaryText).toBe("Key facts summarized");

    const compactEventAfter = await outboxRepo.getEventById("evt_compact_1");
    expect(compactEventAfter?.status).toBe("published");
  });

  it("反向顺序：压缩消费循环先执行，通用循环随后执行，各司其职且不产生多余副作用", async () => {
    // 0. 先建立先验 memory 记录
    await memoryRepo.createRecord(localCtx, {
      id: "mem_beta",
      layer: "short_term",
      type: "learning_event",
      content: "Beta test memory content",
    });

    await outboxRepo.insertEvent(localCtx, {
      id: "evt_compact_rev",
      idempotencyKey: "idem_compact_rev",
      eventType: COMPACTION_EVENT_TYPE,
      payload: {
        memoryId: "mem_beta",
        snapshotId: "snap_beta_1",
        summaryText: "Beta summary",
      },
    });

    // 先运行压缩消费
    const markers = await runCompactionMarkerCycle({
      outboxRepo,
      compactionRepo,
      workerId: "test_worker",
    });
    expect(markers).toBe(1);

    // 后运行通用消费（此时无待处理通用事件）
    const outboxCount = await runOutboxCycle({
      outboxRepo,
      platformRepo,
      workerId: "test_worker",
    });
    expect(outboxCount).toBe(0);

    const event = await outboxRepo.getEventById("evt_compact_rev");
    expect(event?.status).toBe("published");
  });

  it("失败重试与死信机制：达到 maxRetries 后自动收敛至 dead_letter 状态并保留错误信息", async () => {
    await memoryRepo.createRecord(localCtx, {
      id: "mem_faulty", layer: "short_term", type: "learning_event", content: "Retry fixture",
    });
    // 插入一个载荷缺少 snapshotId 的压缩事件（必定引发校验失败）
    await outboxRepo.insertEvent(localCtx, {
      id: "evt_faulty",
      idempotencyKey: "idem_faulty",
      eventType: COMPACTION_EVENT_TYPE,
      payload: {
        memoryId: "mem_faulty",
        // missing snapshotId
      },
    });

    // 轮次 1: 失败，retryCount=1, status=failed
    await runCompactionMarkerCycle({
      outboxRepo,
      compactionRepo,
      workerId: "test_worker",
    });

    let ev = await outboxRepo.getEventById("evt_faulty");
    expect(ev?.status).toBe("failed");
    expect(ev?.retryCount).toBe(1);
    expect(ev?.lastError).toContain("missing memoryId/snapshotId");

    // 轮次 2: 再次尝试，retryCount=2, status=failed
    await runCompactionMarkerCycle({
      outboxRepo,
      compactionRepo,
      workerId: "test_worker",
    });

    ev = await outboxRepo.getEventById("evt_faulty");
    expect(ev?.status).toBe("failed");
    expect(ev?.retryCount).toBe(2);

    // 轮次 3: 达到最大重试上限（3次），状态收敛为 dead_letter
    await runCompactionMarkerCycle({
      outboxRepo,
      compactionRepo,
      workerId: "test_worker",
    });

    ev = await outboxRepo.getEventById("evt_faulty");
    expect(ev?.status).toBe("dead_letter");
    expect(ev?.retryCount).toBe(3);

    // 轮次 4: 后续轮次不再将其拉取，避免无休止无效循环
    const processedNext = await runCompactionMarkerCycle({
      outboxRepo,
      compactionRepo,
      workerId: "test_worker",
    });
    expect(processedNext).toBe(0);
  });

  it("统一分发模式：支持在 OutboxCycleContext 中注册自定义 handlers", async () => {
    let handled = false;

    await outboxRepo.insertEvent(localCtx, {
      id: "evt_custom",
      idempotencyKey: "idem_custom",
      eventType: "custom.domain.event",
      payload: { foo: "bar" },
    });

    await runOutboxCycle({
      outboxRepo,
      platformRepo,
      workerId: "test_worker",
      handlers: {
        "custom.domain.event": async (event) => {
          expect(event.id).toBe("evt_custom");
          handled = true;
        },
      },
    });

    expect(handled).toBe(true);
    const ev = await outboxRepo.getEventById("evt_custom");
    expect(ev?.status).toBe("published");
  });
});
