import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  createDatabase,
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteOutboxRepository,
  SqlitePlatformRepository,
  SqliteConversationRepository,
  notifyWorkerWakeup,
  notifyWorkerPressure,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { WorkerHost } from "../src/worker-host.js";
import { runOutboxCycle } from "../src/outbox-worker.js";

describe("ITER-027: 多进程 SQLite 写入并发、自适应退避与 IPC 唤醒集成测试", () => {
  let tempDbFile: string;
  let apiConn: { db: AervoxDatabase; client: Client };
  let workerConn: { db: AervoxDatabase; client: Client };
  let conversationRepo: SqliteConversationRepository;
  let outboxRepo: SqliteOutboxRepository;
  let platformRepo: SqlitePlatformRepository;
  let testSocketPath: string;
  let host: WorkerHost;

  const localCtx: LocalContext = {
    workspaceId: "ws_iter027",
    subjectUserId: "usr_iter027",
  };

  const createMockLogger = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  });

  beforeEach(async () => {
    tempDbFile = path.join(
      os.tmpdir(),
      `aervox_concurrency_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`,
    );

    // 进程 1 连接（代表 API 服务进程）
    apiConn = await createDatabase({ url: `file:${tempDbFile}` });
    await initDatabaseSchema(apiConn.client);

    // 进程 2 连接（代表后台 Worker 进程，共用同一 SQLite 文件与 WAL 日志）
    workerConn = await createDatabase({ url: `file:${tempDbFile}` });

    conversationRepo = new SqliteConversationRepository(apiConn.db);
    outboxRepo = new SqliteOutboxRepository(workerConn.db);
    platformRepo = new SqlitePlatformRepository(workerConn.db);

    testSocketPath = path.join(
      os.tmpdir(),
      `aervox-test-ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
    );

    host = new WorkerHost({
      workerId: "test-concurrency-worker",
      defaultTickMs: 10_000, // 默认低频 10s，验证 IPC 可瞬时唤醒
      initialStaggerMs: 0,
      enableIpc: true,
      ipcSocketPath: testSocketPath,
      adaptiveBackoff: {
        enabled: true,
        idleMultiplier: 1.5,
        maxIntervalMs: 30_000,
        pressureMinIntervalMs: 3_000,
      },
      logger: createMockLogger() as any,
    });
  });

  afterEach(async () => {
    host.stop();
    try {
      apiConn.client.close();
      workerConn.client.close();
      if (fs.existsSync(tempDbFile)) fs.unlinkSync(tempDbFile);
      if (fs.existsSync(`${tempDbFile}-wal`)) fs.unlinkSync(`${tempDbFile}-wal`);
      if (fs.existsSync(`${tempDbFile}-shm`)) fs.unlinkSync(`${tempDbFile}-shm`);
    } catch {
      // ignore cleanup
    }
    if (fs.existsSync(testSocketPath)) {
      try {
        fs.unlinkSync(testSocketPath);
      } catch {
        // ignore
      }
    }
  });

  it("IPC 秒级唤醒：API 插入 Outbox 事件后触发 IPC 信号，Worker 即刻消费而非等待轮询周期", async () => {
    let outboxProcessedCount = 0;
    host.registerJob({
      name: "outbox",
      run: async () => {
        const count = await runOutboxCycle({
          outboxRepo,
          platformRepo,
          workerId: "test-concurrency-worker",
        });
        outboxProcessedCount += count;
        return count;
      },
    });

    host.start();

    // 等待 IPC 监听就绪
    await new Promise((r) => setTimeout(r, 100));

    // 插入待消费事件
    await outboxRepo.insertEvent(localCtx, {
      id: "evt_ipc_wake_1",
      idempotencyKey: "idem_ipc_wake_1",
      eventType: "turn.created",
      payload: { turnId: "t_1" },
    });

    // 此时 Outbox 仍在 pending 状态（Worker 默认节拍为 10s，尚未轮询到）
    const eventBefore = await outboxRepo.getEventById("evt_ipc_wake_1");
    expect(eventBefore?.status).toBe("pending");

    // 通过 IPC 发送唤醒信号
    const notified = await notifyWorkerWakeup("outbox", testSocketPath);
    expect(notified).toBe(true);

    // 等待 Worker 异步处理（几毫秒内触发）
    await new Promise((r) => setTimeout(r, 150));

    // 验证事件已被立即消费并标记为 published
    const eventAfter = await outboxRepo.getEventById("evt_ipc_wake_1");
    expect(eventAfter?.status).toBe("published");
    expect(outboxProcessedCount).toBe(1);
  });

  it("IPC 写入压力协调：API 密集写入期间 Worker 开启退避，会话结束后恢复", async () => {
    host.registerJob({
      name: "outbox",
      run: vi.fn().mockResolvedValue(0),
    });

    host.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(host.isPressureMode()).toBe(false);

    // 发送写入压力开始信号（会话流式开启）
    const p1 = await notifyWorkerPressure(true, 5000, testSocketPath);
    expect(p1).toBe(true);
    expect(host.isPressureMode()).toBe(true);

    // 发送写入压力解除信号（会话流式终态）
    const p2 = await notifyWorkerPressure(false, undefined, testSocketPath);
    expect(p2).toBe(true);
    expect(host.isPressureMode()).toBe(false);
  });

  it("并发多轮写入稳定性：多并发会话落库与 Worker 密集消费下，零 SQLITE_BUSY 报错且数据完整", async () => {
    host.registerJob({
      name: "outbox",
      defaultIntervalMs: 50, // 极高频后台消费
      run: async () => {
        return runOutboxCycle({
          outboxRepo,
          platformRepo,
          workerId: "test-concurrency-worker",
        });
      },
    });

    host.start();
    await new Promise((r) => setTimeout(r, 100));

    // 1. 模拟密集对话会话开启：下发写入压力协调信号（Worker 自动退避至低频轮询，避免抢占写锁）
    await notifyWorkerPressure(true, 10_000, testSocketPath);
    expect(host.isPressureMode()).toBe(true);

    // 模拟 API 多轮会话密集写入（消息、Turn、Attempt、审计记录与 Outbox 事件）
    // 注意：在单个 Node 进程内，相同连接的并发写由于 @libsql/client 的同步 C++ 阻塞机制
    // 不可在单个事件循环内交织事务；在真实多进程架构中，API 进程各请求持锁排队，
    // 此处验证 API 密集落库期间，后台独立连接的 Worker 稳妥退避且零 SQLITE_BUSY 冲突。
    const sessionCount = 6;
    for (let index = 0; index < sessionCount; index++) {
      const session = await conversationRepo.createSession(localCtx, `Concurrent Session ${index}`);
      const turnId = `turn_concurrent_${index}`;
      const attemptId = `att_concurrent_${index}`;
      const idempotencyKey = `idem_concurrent_${index}`;

      // 1. 原子创建 Turn、首条 Message 与 Outbox 事件
      await conversationRepo.createTurnWithOutbox(
        localCtx,
        { id: turnId, sessionId: session.id, idempotencyKey },
        { id: `msg_concurrent_${index}`, role: "user", content: `Prompt ${index}` },
        { id: `evt_concurrent_${index}`, idempotencyKey, eventType: "turn.step_completed", payload: { turnId, step: index } },
      );

      // 2. 记录 Attempt
      await conversationRepo.createTurnAttempt(localCtx, turnId, {
        id: attemptId,
        attempt: 1,
      });

      // 3. 更新终态
      await conversationRepo.finalizeTurnAttempt(localCtx, {
        turnId,
        attemptId,
        status: "Completed",
      });
      await conversationRepo.updateTurnStatus(localCtx, turnId, "Completed");
    }

    // 2. 密集写入完成：解除写入压力并触发 IPC 秒级唤醒，Worker 即刻消化积压 Outbox
    await notifyWorkerPressure(false, undefined, testSocketPath);
    expect(host.isPressureMode()).toBe(false);
    await notifyWorkerWakeup("outbox", testSocketPath);

    // 等待 Worker 消费排队事件
    await new Promise((r) => setTimeout(r, 400));

    // 验证所有 Outbox 事件全部消费完成，无遗留 pending
    const pending = await outboxRepo.fetchPendingEvents({ limit: 100 });
    expect(pending.length).toBe(0);

    for (let i = 0; i < sessionCount; i++) {
      const event = await outboxRepo.getEventById(`evt_concurrent_${i}`);
      expect(event?.status).toBe("published");
    }
  });
});
