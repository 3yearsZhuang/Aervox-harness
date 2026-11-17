/**
 * Aervox｜思隅 @aervox/host-agent — SqliteExecutionStore 适配冒烟（阶段 4a）
 *
 * 验证宿主适配在真实 SQLite 上的最小回路：claim → append/list → finalize / CAS 失败跳过。
 * 深度行为（租约、fencing、工具预留）由 @aervox/repositories conversation-* 测试覆盖，此处只做宿主侧桥接验证。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteExecutionStore } from "../src/index.js";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";

const ctx: LocalContext = { workspaceId: "ws_host", subjectUserId: "usr_host" };

describe("SqliteExecutionStore（SQLite 适配冒烟）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;
  let store: SqliteExecutionStore;
  let seq = 0;

  const nextTurn = async (): Promise<{ turnId: string; attemptId: string; sessionId: string }> => {
    const turnId = `turn_host_${(++seq).toString(36)}`;
    const sessionId = `ses_host_${turnId}`;
    await repo.getOrCreateSession(ctx, sessionId, "host 测试");
    await repo.createTurnWithOutbox(
      ctx,
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
    await repo.createTurnAttempt(ctx, turnId, { id: attemptId, attempt: 1 });
    return { turnId, attemptId, sessionId };
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    store = new SqliteExecutionStore(repo, ctx);
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
    const attempts = await repo.listTurnAttempts(ctx, turnId);
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

  it("releases original question claims across repeated executions and cancellation in one long-lived store", async () => {
    const ended: Array<{ turnId: string; attemptId: string }> = [];
    for (let index = 0; index < 20; index += 1) {
      const identity = await nextTurn();
      const claim = await store.claimTurnAttempt({ ...identity, expectedFencingToken: 0 });
      expect(claim.ok).toBe(true);
      if (!claim.ok) throw new Error("claim failed");
      const proof = { turnId: identity.turnId, attemptId: identity.attemptId, expectedFencingToken: claim.fencingToken, leaseId: claim.leaseId };
      expect(store.getQuestionExecutionOwner(identity.turnId, identity.attemptId)).toEqual(proof);
      await store.claimTurnAttempt({ ...identity, expectedFencingToken: 0 });
      expect(store.getQuestionExecutionOwner(identity.turnId, identity.attemptId)).toEqual(proof);
      store.releaseQuestionExecutionOwner("wrong-turn", identity.attemptId);
      expect(store.getQuestionExecutionOwner(identity.turnId, identity.attemptId)).toEqual(proof);
      if (index % 2 === 0) {
        await store.finalizeAttempt({ ...identity, status: "Completed", expectedFencingToken: claim.fencingToken });
      } else {
        await store.finalizeAttemptWithEvent({ ...identity, status: "Completed", expectedFencingToken: claim.fencingToken,
          sequence: await store.nextSequence(identity.turnId), eventType: "done", eventData: { status: "Completed" } });
      }
      ended.push(identity);
      for (const previous of ended) expect(store.getQuestionExecutionOwner(previous.turnId, previous.attemptId)).toBeUndefined();
    }
    const cancelled = await nextTurn();
    await store.claimTurnAttempt({ ...cancelled, expectedFencingToken: 0 });
    await store.requestCancelAttempt(cancelled);
    expect(store.getQuestionExecutionOwner(cancelled.turnId, cancelled.attemptId)).toBeUndefined();
  });

  it("releases an exited execution proof on terminal failure and explicit lease-loss exit", async () => {
    const identity = await nextTurn();
    const claim = await store.claimTurnAttempt({ ...identity, expectedFencingToken: 0 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("claim failed");
    vi.spyOn(repo, "finalizeAttemptWithEventAtomically").mockRejectedValueOnce(new Error("terminal commit failed"));
    await expect(store.finalizeAttemptWithEvent({ ...identity, status: "Completed", expectedFencingToken: claim.fencingToken,
      sequence: 1, eventType: "done", eventData: {} })).rejects.toThrow("terminal commit failed");
    expect(store.getQuestionExecutionOwner(identity.turnId, identity.attemptId)).toBeUndefined();
    expect(await repo.getTurnAttemptStatus(ctx, identity)).toBe("Running");
    const lost = await nextTurn();
    await store.claimTurnAttempt({ ...lost, expectedFencingToken: 0 });
    store.releaseQuestionExecutionOwner(lost.turnId, lost.attemptId);
    expect(store.getQuestionExecutionOwner(lost.turnId, lost.attemptId)).toBeUndefined();
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
