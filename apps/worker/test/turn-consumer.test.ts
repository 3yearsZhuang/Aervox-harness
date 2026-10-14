import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  SqliteOutboxRepository,
  SqlitePlatformRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { createReplayProvider } from "@aervox/core";
import { runOutboxCycle } from "../src/outbox-worker.js";
import { createTurnConsumerHandler } from "../src/turn-consumer.js";

describe("HLS-DEC-01: Worker 异步接单与执行消费测试", () => {
  let db: AervoxDatabase;
  let client: Client;
  let conversationRepo: SqliteConversationRepository;
  let outboxRepo: SqliteOutboxRepository;
  let platformRepo: SqlitePlatformRepository;

  const localCtx: LocalContext = {
    workspaceId: "local",
    subjectUserId: "local",
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    conversationRepo = new SqliteConversationRepository(db);
    outboxRepo = new SqliteOutboxRepository(db);
    platformRepo = new SqlitePlatformRepository(db);
  });

  it("通过 Outbox 事件领取 turn.created，由 Worker 异步执行并推进终态", async () => {
    const turnId = "turn_async_1";
    const sessionId = "session_async_1";
    const attemptId = "atp_turn_async_1";

    // 0. 准备关联 Session 记录以满足外键约束
    await conversationRepo.createSession(localCtx, "测试会话", { id: sessionId });

    // 1. 模拟 API 端写入接单（acceptTurn 产生 turn.created Outbox 事件）
    const accepted = await conversationRepo.acceptTurn(localCtx, {
      turnId,
      sessionId,
      idempotencyKey: "idem_async_1",
      attemptId,
      message: { id: "msg_user_1", content: "请问 1+1 等于几？" },
      consumeInbox: false,
    });
    expect(accepted.created).toBe(true);

    // 2. 构造确定性回放模型 Provider
    const provider = createReplayProvider([
      { type: "text", delta: "1+1 等于 2。" },
    ]);

    // 3. 配置并启动 Worker Outbox 消费
    const handler = createTurnConsumerHandler({
      repo: conversationRepo,
      provider,
    });

    const processed = await runOutboxCycle({
      outboxRepo,
      platformRepo,
      workerId: "worker-node-1",
      handlers: { "turn.created": handler },
    });

    expect(processed).toBe(1);

    // 4. 验证 Attempt 状态已由 Running/Pending 推进为 Completed
    const attempts = await conversationRepo.listTurnAttempts(localCtx, turnId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("Completed");

    // 5. 验证事件流已权威写入 SQLite
    const events = await conversationRepo.getStreamEvents(localCtx, turnId);
    expect(events.length).toBeGreaterThan(0);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("done");

    // 6. 验证 Outbox 事件已被标记为 published
    const pendingEvents = await outboxRepo.fetchPendingEvents({ limit: 10 });
    expect(pendingEvents).toHaveLength(0);
  });

  it("无待执行 Attempt 时安全跳过，不阻塞 Outbox 队列", async () => {
    const turnId = "turn_orphan_1";
    const sessionId = "session_orphan_1";

    // 手动插入一条孤儿事件
    await outboxRepo.insertEvent(localCtx, {
      id: "outbox_orphan_1",
      idempotencyKey: "idem_orphan_1",
      eventType: "turn.created",
      payload: { turnId, sessionId },
    });

    const provider = createReplayProvider([]);
    const handler = createTurnConsumerHandler({
      repo: conversationRepo,
      provider,
    });

    const processed = await runOutboxCycle({
      outboxRepo,
      platformRepo,
      workerId: "worker-node-1",
      handlers: { "turn.created": handler },
    });

    expect(processed).toBe(1);
    const pending = await outboxRepo.fetchPendingEvents({ limit: 10 });
    expect(pending).toHaveLength(0);
  });

  it("支持在 Worker 进程中驱动 HostToolRuntime 工具调用并记录事件与结果", async () => {
    const turnId = "turn_tool_1";
    const sessionId = "session_tool_1";
    const attemptId = "atp_tool_1";

    await conversationRepo.createSession(localCtx, "工具测试会话", { id: sessionId });
    await conversationRepo.acceptTurn(localCtx, {
      turnId,
      sessionId,
      idempotencyKey: "idem_tool_1",
      attemptId,
      message: { id: "msg_user_tool", content: "请帮我计算 2+3" },
      consumeInbox: false,
    });

    const { HostToolRuntime } = await import("@aervox/core");
    const { createHostToolProvider } = await import("@aervox/host-agent");

    const runtime = new HostToolRuntime();
    await runtime.registerContribution(
      {
        id: "calculator_add",
        name: "calculator_add",
        description: "加法计算",
        safetyLevel: "read_only",
        inputSchemaJson: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
        },
      },
      {
        async call(_ctx, args: any) {
          return { sum: (args.a ?? 0) + (args.b ?? 0) };
        },
      },
    );

    const tools = createHostToolProvider(runtime, conversationRepo);

    const { createScriptedProvider } = await import("@aervox/core");

    // 构造带工具调用的两步脚本模型
    const provider = createScriptedProvider([
      {
        toolCalls: [
          {
            id: "call_1",
            name: "calculator_add",
            arguments: { a: 2, b: 3 },
          },
        ],
      },
      {
        text: "计算结果是 5。",
      },
    ]);

    const handler = createTurnConsumerHandler({
      repo: conversationRepo,
      provider: async () => provider,
      tools,
    });

    const processed = await runOutboxCycle({
      outboxRepo,
      platformRepo,
      workerId: "worker-node-1",
      handlers: { "turn.created": handler },
    });

    expect(processed).toBe(1);

    // 验证 Attempt 已完成
    const attempts = await conversationRepo.listTurnAttempts(localCtx, turnId);
    expect(attempts[0]?.status).toBe("Completed");

    // 验证工具调用及结果事件均记录在 SQLite 中
    const events = await conversationRepo.getStreamEvents(localCtx, turnId);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("tool_request");
    expect(eventTypes).toContain("tool_result");
    expect(eventTypes).toContain("done");
  });
});

