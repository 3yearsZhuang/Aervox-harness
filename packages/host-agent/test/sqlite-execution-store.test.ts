/**
 * Aervox｜思隅 @aervox/host-agent — SqliteExecutionStore 适配冒烟（阶段 4a）
 *
 * 验证宿主适配在真实 SQLite 上的最小回路：claim → append/list → finalize / CAS 失败跳过。
 * 深度行为（租约、fencing、工具预留）由 @aervox/database conversation-* 测试覆盖，此处只做宿主侧桥接验证。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteExecutionStore } from "../src/index.js";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type TenantContext,
} from "@aervox/database";
import type { Client } from "@libsql/client";

const tenant: TenantContext = { workspaceId: "ws_host", subjectUserId: "usr_host" };

describe("SqliteExecutionStore（SQLite 适配冒烟）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;
  let store: SqliteExecutionStore;
  let seq = 0;

  const nextTurn = async (): Promise<{ turnId: string; attemptId: string; sessionId: string }> => {
    const turnId = `turn_host_${(++seq).toString(36)}`;
    const sessionId = `ses_host_${turnId}`;
    await repo.getOrCreateSession(tenant, sessionId, "host 测试");
    await repo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId, idempotencyKey: `idem_${turnId}`, status: "Created" },
      { id: `msg_${turnId}`, content: "x" },
      {
        id: `ob_${turnId}`,
        eventType: "turn.created",
        idempotencyKey: `idem_ob_${turnId}`,
        payload: { turnId, sessionId },
      },
    );
    const attemptId = `atp_host_${(++seq).toString(36)}`;
    await repo.createTurnAttempt(tenant, turnId, { id: attemptId, attempt: 1 });
    return { turnId, attemptId, sessionId };
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    store = new SqliteExecutionStore(repo, tenant);
  });

  it("claim → append/list → finalize 完整回路，fencing 递增", async () => {
    const { turnId, attemptId } = await nextTurn();

    const claim = await store.claimTurnAttempt({
      turnId,
      attemptId,
      expectedFencingToken: 0,
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    // 重复领取（fencing 已 1）→ 拒绝
    const second = await store.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 0 });
    expect(second.ok).toBe(false);
    if (second.ok) return;

    // 事件写读
    await store.appendEvent({
      turnId,
      attemptId,
      sequence: await store.nextSequence(turnId),
      eventType: "message",
      data: { text: "hi" },
      safetyDecision: "approved",
    });
    const events = await store.listEvents(turnId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("message");
    expect(events[0]?.sequence).toBe(1);

    // 续租 CAS：正确 leaseId + fencing 通过
    expect(
      await store.renewAttemptLease({
        attemptId,
        leaseId: claim.leaseId!,
        expectedFencingToken: claim.fencingToken,
      }),
    ).toEqual({ ok: true });

    await store.finalizeAttempt({ turnId, attemptId, status: "Completed" });
    const attempts = await repo.listTurnAttempts(tenant, turnId);
    expect(attempts[0]?.status).toBe("Completed");
  });

  it("终态后 claim/finalize 拒绝（单一终态）", async () => {
    const { turnId, attemptId } = await nextTurn();

    await store.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 0 });
    await store.finalizeAttempt({ turnId, attemptId, status: "Failed" });

    // 已终态 → 不可再领、不可再提交
    expect((await store.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 1 })).ok).toBe(false);
    expect((await store.finalizeAttempt({ turnId, attemptId, status: "Completed" })).ok).toBe(false);
  });

  it("取消请求位与检查点；工具执行账本冒烟", async () => {
    const { turnId, attemptId } = await nextTurn();
    await store.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 0 });

    expect(await store.isCancelRequested({ turnId, attemptId })).toBe(false);
    expect((await store.requestCancelAttempt({ turnId, attemptId })).ok).toBe(true);
    expect(await store.isCancelRequested({ turnId, attemptId })).toBe(true);

    // 预留 + 收口（幂等）
    const reserve = await store.reserveToolExecution({
      turnId,
      attemptId,
      invocationId: `${attemptId}:1:1`,
      name: "notes_search",
      arguments: {},
    });
    expect(reserve.ok).toBe(true);
    expect(reserve.alreadyReserved).toBe(false);
    await store.updateToolExecutionResult({
      turnId,
      attemptId,
      invocationId: `${attemptId}:1:1`,
      status: "executed",
      output: "ok",
    });
  });
});