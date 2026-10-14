import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  SqlitePrivacyRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { createReplayProvider } from "@aervox/core";
import { runAttemptRecoveryCycle } from "../src/attempt-recovery.js";

describe("HLS-DEC-01 / ARC-01: Worker 崩溃断点自动续跑与失效 Attempt 恢复测试", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;
  let privacyRepo: SqlitePrivacyRepository;

  const localCtx: LocalContext = {
    workspaceId: "local",
    subjectUserId: "local",
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    privacyRepo = new SqlitePrivacyRepository(db);
  });

  it("具备有效工具结果的过期 Attempt 会被自动抢占续跑并完成，无需用户重新发消息", async () => {
    const turnId = "turn_resume_1";
    const sessionId = "ses_resume_1";
    const attemptId = "atp_resume_1";

    await repo.createSession(localCtx, "续跑测试会话", { id: sessionId });
    await repo.createTurnWithOutbox(
      localCtx,
      { id: turnId, sessionId, idempotencyKey: "idem_resume_1", status: "Created" },
      { id: "msg_user_resume", content: "请帮我查复习笔记" },
      { id: "ob_resume_1", eventType: "turn.created", idempotencyKey: "idem_ob_resume_1", payload: { turnId, sessionId } },
    );
    await repo.createTurnAttempt(localCtx, turnId, { id: attemptId, attempt: 1 });
    await repo.claimTurnAttempt(localCtx, {
      turnId,
      attemptId,
      expectedFencingToken: 0,
      leaseId: "lease_old",
      ttlMs: 1,
    });

    // 模拟租约过期
    await new Promise((r) => setTimeout(r, 10));

    // 写入权威提交的工具执行结果（模拟执行到一半进程崩溃/重启）
    await repo.reserveToolExecution(localCtx, {
      turnId,
      attemptId,
      invocationId: `${attemptId}:1:1`,
      name: "notes_search",
      arguments: {},
    });
    await repo.updateToolExecutionResult(localCtx, {
      turnId,
      attemptId,
      invocationId: `${attemptId}:1:1`,
      status: "executed",
      output: { topic: "微积分基础" },
    });
    await repo.appendStreamEvent(localCtx, {
      id: "ev_tool_req",
      turnId,
      sequence: 1,
      eventType: "tool_request",
      data: { name: "notes_search", executionId: `${attemptId}:1:1` },
      attemptId,
    });
    await repo.appendStreamEvent(localCtx, {
      id: "ev_tool_res",
      turnId,
      sequence: 2,
      eventType: "tool_result",
      data: { output: { topic: "微积分基础" }, executionId: `${attemptId}:1:1` },
      attemptId,
    });

    const provider = createReplayProvider([
      { type: "text", delta: "根据笔记查询结果，您的复习重点是微积分基础。" },
    ]);

    // 执行 Attempt 恢复周期
    await runAttemptRecoveryCycle({
      db,
      client,
      workerId: "worker-recovery-test",
      provider,
      privacyRepo,
    });

    // 验证 Attempt 已被推进至 Completed（而非粗暴标记为 Interrupted）
    const attempts = await repo.listTurnAttempts(localCtx, turnId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("Completed");

    // 验证 Turn 状态同步完成
    const turn = await repo.getTurn(localCtx, turnId);
    expect(turn?.status).toBe("Completed");

    // 验证事件流中已追加 done 事件
    const events = await repo.getStreamEvents(localCtx, turnId);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("done");
  });

  it("无提交工具结果的超时 Attempt 会安全熔断为 Interrupted，并使未决工具进入 outcome_unknown", async () => {
    const turnId = "turn_stale_1";
    const sessionId = "ses_stale_1";
    const attemptId = "atp_stale_1";

    await repo.createSession(localCtx, "超时会话", { id: sessionId });
    await repo.createTurnWithOutbox(
      localCtx,
      { id: turnId, sessionId, idempotencyKey: "idem_stale_1", status: "Created" },
      { id: "msg_user_stale", content: "卡死的请求" },
      { id: "ob_stale_1", eventType: "turn.created", idempotencyKey: "idem_ob_stale_1", payload: { turnId, sessionId } },
    );
    await repo.createTurnAttempt(localCtx, turnId, { id: attemptId, attempt: 1 });
    await repo.claimTurnAttempt(localCtx, {
      turnId,
      attemptId,
      expectedFencingToken: 0,
      leaseId: "lease_stale",
      ttlMs: 1,
    });

    // 租约过期
    await new Promise((r) => setTimeout(r, 10));

    // 预留工具但未提交结果
    await repo.reserveToolExecution(localCtx, {
      turnId,
      attemptId,
      invocationId: `${attemptId}:1:1`,
      name: "slow_tool",
      arguments: {},
    });

    // 执行恢复
    const recovered = await runAttemptRecoveryCycle({
      db,
      client,
      workerId: "worker-recovery-test",
    });

    expect(recovered).toBe(1);

    // 验证该 Attempt 已被安全熔断为 Interrupted
    const attempts = await repo.listTurnAttempts(localCtx, turnId);
    expect(attempts[0]?.status).toBe("Interrupted");

    // 验证挂起的工具状态被标记为 outcome_unknown
    const toolExecs = await repo.listToolExecutionsByTurn(localCtx, turnId);
    expect(toolExecs[0]?.status).toBe("outcome_unknown");
  });
});
