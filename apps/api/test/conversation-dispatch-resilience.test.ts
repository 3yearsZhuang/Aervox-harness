import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { registerConversationRoutes } from "../src/modules/companion/conversation/routes.js";

describe("ARC-01: 对话接单弹性、Claim 前故障追踪与孤儿 Attempt 恢复测试", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let conversationRepo: SqliteConversationRepository;

  const localCtx: LocalContext = {
    workspaceId: "ws_resilience",
    subjectUserId: "usr_resilience",
  };

  const headers = {
    "x-workspace-id": "ws_resilience",
    "x-user-id": "usr_resilience",
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    conversationRepo = new SqliteConversationRepository(db);

    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("预加载异常闭环：当 skillLoader 抛错时，Attempt 与 Turn 推进至 Failed 终态，杜绝死锁于 Running/Created", async () => {
    // 注入合成故障的 skillLoader
    registerConversationRoutes(app, conversationRepo, {
      skillLoader: async () => {
        throw new Error("Synthetic skillLoader failure before claim");
      },
    });
    await app.ready();

    const session = await conversationRepo.createSession(localCtx, "Resilience Session");

    const idempotencyKey = "idem_preload_failure_1";
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/turns`,
      headers: {
        ...headers,
        "idempotency-key": idempotencyKey,
      },
      payload: {
        message: { content: "测试预加载故障", contentType: "text" },
        clientVersion: "test",
        references: [],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.turnId).toBeDefined();

    // 等待后台 runLoop 执行并被 try-catch 拦截
    await new Promise((r) => setTimeout(r, 100));

    // 验证 Attempt 状态收敛为 Failed，而非停滞在 Running 且 lease=null
    const attempts = await conversationRepo.listTurnAttempts(localCtx, body.turnId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("Failed");
    expect(attempts[0]!.finishedAt).not.toBeNull();

    // 验证 Turn 状态推进为 Failed，而非停滞在 Created
    const turn = await conversationRepo.getTurn(localCtx, body.turnId);
    expect(turn).not.toBeNull();
    expect(turn!.status).toBe("Failed");

    // 重试相同幂等键时，返回当前 Failed 终态（而非死锁在 Created）
    const retryRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/turns`,
      headers: {
        ...headers,
        "idempotency-key": idempotencyKey,
      },
      payload: {
        message: { content: "测试预加载故障", contentType: "text" },
        clientVersion: "test",
        references: [],
      },
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.json().status).toBe("Failed");
  });

  it("未认领孤儿 Attempt 恢复：recoverExpiredAttempts 扫描未绑定租约的超时 Attempt 并同步推进 turns 状态", async () => {
    const session = await conversationRepo.createSession(localCtx, "Orphan Recovery Session");
    const turnId = "turn_orphan_1";
    const attemptId = "atp_orphan_1";

    // 模拟进程在建完 Turn 和 Attempt 后、但在 claim 发生前崩溃（leaseId 与 leaseExpiresAt 均为 null）
    await conversationRepo.createTurnWithOutbox(
      localCtx,
      { id: turnId, sessionId: session.id, idempotencyKey: "idem_orphan_1", status: "Created" },
      { id: "msg_orphan_1", content: "Orphan message" },
      { id: "ob_orphan_1", eventType: "turn.created", idempotencyKey: "idem_ob_orphan", payload: { turnId } },
    );

    // 插入一个 120 秒前开始但未认领的 Attempt
    const twoMinutesAgoIso = new Date(Date.now() - 120_000).toISOString();
    await client.execute(`
      INSERT INTO turn_attempts (id, turn_id, attempt, lease_id, fencing_token, status, started_at)
      VALUES ('${attemptId}', '${turnId}', 1, NULL, 0, 'Running', '${twoMinutesAgoIso}')
    `);

    // 执行恢复扫描（设定超时阈值为 10 秒）
    const recoveredCount = await conversationRepo.recoverExpiredAttempts(client, { unclaimedTimeoutMs: 10_000 });
    expect(recoveredCount).toBe(1);

    // 验证 Attempt 状态已推进至 Interrupted 且 fencing+1
    const attempts = await conversationRepo.listTurnAttempts(localCtx, turnId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("Interrupted");
    expect(attempts[0]!.fencingToken).toBe(1);
    expect(attempts[0]!.finishedAt).not.toBeNull();

    // 验证所属 Turn 状态同步推进至 Interrupted，不再是 Created 孤儿
    const turn = await conversationRepo.getTurn(localCtx, turnId);
    expect(turn).not.toBeNull();
    expect(turn!.status).toBe("Interrupted");
  });
});
