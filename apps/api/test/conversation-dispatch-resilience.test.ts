import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { doneEventDataSchema } from "@aervox/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  SqliteAgentInboxRepository,
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
  it("concurrent HTTP acceptance dispatches once with the persisted Inbox input", async () => {
    const inboxRepo = new SqliteAgentInboxRepository(db);
    const skillLoader = vi.fn(async () => { throw new Error("stop after dispatch"); });
    registerConversationRoutes(app, conversationRepo, { inboxRepo, skillLoader });
    await app.ready();
    await conversationRepo.getOrCreateSession(localCtx, "s");
    await inboxRepo.enqueue(localCtx, { id: "followup", idempotencyKey: "followup", sessionId: "s", type: "followup", sourceActor: "user", payload: "queued input" });
    const responses = await Promise.all([1, 2].map(() => app.inject({
      method: "POST", url: "/v1/sessions/s/turns", headers: { ...headers, "idempotency-key": "same" },
      payload: { message: { content: "new input", contentType: "text" }, clientVersion: "test", references: [] },
    })));
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(responses[0]!.json().turnId).toBe(responses[1]!.json().turnId);
    await vi.waitFor(() => expect(skillLoader).toHaveBeenCalledTimes(1));
    const messages = await client.execute("SELECT content FROM message_versions");
    expect(messages.rows.map((row) => row.content)).toEqual(["queued input\n\nnew input"]);
    await vi.waitFor(async () => expect((await conversationRepo.getTurn(localCtx, responses[0]!.json().turnId))?.status).toBe("Failed"));
  });

  it("restart recovers CancelRequested, fences late outcomes, and reconnect observes a terminal event", async () => {
    await conversationRepo.getOrCreateSession(localCtx, "s");
    await conversationRepo.acceptTurn(localCtx, { turnId: "cancelled", sessionId: "s", idempotencyKey: "cancelled", attemptId: "a", message: { id: "m", content: "x" }, consumeInbox: false });
    await conversationRepo.reserveToolExecution(localCtx, { turnId: "cancelled", attemptId: "a", invocationId: "i", name: "write" });
    await conversationRepo.requestCancelTurnAttempt(localCtx, { turnId: "cancelled", attemptId: "a" });
    await client.execute("UPDATE turn_attempts SET started_at = '2000-01-01T00:00:00.000Z'");
    const restarted = new SqliteConversationRepository(db);
    expect(await restarted.recoverExpiredAttempts(client)).toBe(1);
    expect(await restarted.recoverExpiredAttempts(client)).toBe(0);
    expect(await restarted.listTurnAttempts(localCtx, "cancelled")).toMatchObject([{ status: "Cancelled", fencingToken: 1 }]);
    expect(await restarted.finalizeTurnAttempt(localCtx, { turnId: "cancelled", attemptId: "a", status: "Completed", expectedFencingToken: 0 })).toBeNull();
    expect((await client.execute("SELECT status FROM tool_executions")).rows[0]!.status).toBe("outcome_unknown");
    registerConversationRoutes(app, restarted, {}); await app.ready();
    const stream = await app.inject({ method: "GET", url: "/v1/turns/cancelled/events", headers });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain('"status":"Cancelled"');
    expect(stream.body).toContain('"eventType":"done"');
    const frame = JSON.parse(stream.body.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
    expect(doneEventDataSchema.safeParse(frame.data).success).toBe(true);
    expect(frame.data.lastSequence).toBe(frame.sequence);
  });

});
