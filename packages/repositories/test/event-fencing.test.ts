/**
 * Aervox｜思隅 @aervox/database — B1：事件写入 fencing CAS（3c+）
 *
 * 规则依据：AVX-HAR-001 §11.2「事件/工具写入的 fencing 校验」、§12.2 事务边界。
 * appendStreamEvent 携带 expectedFencingToken 时：要求 turn_attempts 存在且
 * fencing_token 一致、状态运行中（或终态下仅收尾 done/error），否则拒绝写入并抛
 * FencingMismatchError（迟到/被抢占执行器的事件流零污染）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, type AervoxDatabase, type TenantContext } from "../src/index.js";
import { FencingMismatchError } from "../src/errors.js";
import type { Client } from "@libsql/client";

const tenant: TenantContext = { workspaceId: "ws_fence", subjectUserId: "usr_fence" };

describe("B1 事件写入 fencing CAS（appendStreamEvent）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;
  let seq = 0;

  const nextTurn = async (): Promise<{ turnId: string; attemptId: string }> => {
    const n = (++seq).toString(36);
    const turnId = `turn_fence_${n}`;
    await repo.getOrCreateSession(tenant, `ses_fence_${n}`, "fencing 测试");
    await repo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId: `ses_fence_${n}`, idempotencyKey: `idem_${turnId}`, status: "Created" },
      { id: `msg_${turnId}`, content: "x" },
      { id: `ob_${turnId}`, eventType: "turn.created", idempotencyKey: `idem_ob_${turnId}`, payload: { turnId } },
    );
    const attemptId = `atp_fence_${n}`;
    await repo.createTurnAttempt(tenant, turnId, { id: attemptId, attempt: 1 });
    return { turnId, attemptId };
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
  });

  it("运行中 Attempt：claim 后携带正确 fencing 写入通过", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await repo.claimTurnAttempt(tenant, { turnId, attemptId, expectedFencingToken: 0, leaseId: "lease_f1", ttlMs: 60_000 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const ev = await repo.appendStreamEvent(tenant, {
      id: "tev_f1",
      turnId,
      sequence: 1,
      eventType: "delta",
      data: { text: "ok" },
      attemptId,
      expectedFencingToken: claim.fencingToken,
    });
    expect(ev.sequence).toBe(1);
    // 未携带期望值（保持无校验兼容路径）也仍可写入
    const ev2 = await repo.appendStreamEvent(tenant, {
      id: "tev_f1b",
      turnId,
      sequence: 2,
      eventType: "delta",
      data: { text: "ok2" },
      attemptId,
    });
    expect(ev2.sequence).toBe(2);
  });

  it("fencing 失配（被恢复器抢占/收敛后递增）：迟到写入被拒绝且零污染", async () => {
    const { turnId, attemptId } = await nextTurn();
    // 租约 TTL 为负 → leaseExpiresAt 已过期，可被恢复器收敛（fencing +1 → Interrupted）
    const claim = await repo.claimTurnAttempt(tenant, { turnId, attemptId, expectedFencingToken: 0, leaseId: "lease_f2", ttlMs: -1_000 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.fencingToken).toBe(1);

    const recovered = await repo.recoverExpiredAttempts(client);
    expect(recovered).toBe(1);

    // 旧执行器以 claim 当时的 fencing（1）迟到写入 → 拒绝（恢复器已递增为 2）
    await expect(
      repo.appendStreamEvent(tenant, {
        id: "tev_f2_late",
        turnId,
        sequence: 2,
        eventType: "tool_result",
        data: { ok: true },
        attemptId,
        expectedFencingToken: claim.fencingToken,
      }),
    ).rejects.toThrow(FencingMismatchError);

    const events = await repo.getStreamEvents(tenant, turnId, 0);
    expect(events).toHaveLength(0); // 事件流零污染
  });

  it("attempt 不存在：拒绝并抛 FencingMismatchError", async () => {
    const { turnId } = await nextTurn();
    await expect(
      repo.appendStreamEvent(tenant, {
        id: "tev_f3",
        turnId,
        sequence: 1,
        eventType: "delta",
        data: { text: "x" },
        attemptId: "atp_ghost",
        expectedFencingToken: 0,
      }),
    ).rejects.toThrow(FencingMismatchError);
  });

  it("终态后：仅收尾 done/error 允许；普通事件（delta）拒绝", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await repo.claimTurnAttempt(tenant, { turnId, attemptId, expectedFencingToken: 0, leaseId: "lease_f4", ttlMs: 60_000 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    const finalized = await repo.finalizeTurnAttempt(tenant, {
      turnId,
      attemptId,
      status: "Completed",
      expectedFencingToken: claim.fencingToken,
    });
    expect(finalized?.fencingToken).toBe(claim.fencingToken);

    // 终态下写普通事件 → 拒绝
    await expect(
      repo.appendStreamEvent(tenant, {
        id: "tev_f4_delta",
        turnId,
        sequence: 2,
        eventType: "delta",
        data: { text: "late" },
        attemptId,
        expectedFencingToken: claim.fencingToken,
      }),
    ).rejects.toThrow(FencingMismatchError);

    // 终态下收尾 done（finalize-then-done 路径）→ 放行
    const done = await repo.appendStreamEvent(tenant, {
      id: "tev_f4_done",
      turnId,
      sequence: 3,
      eventType: "done",
      data: { status: "Completed", isComplete: true },
      attemptId,
      expectedFencingToken: claim.fencingToken,
    });
    expect(done.eventType).toBe("done");
  });

  it("CancelRequested 状态仍可写事件（取消路径）", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await repo.claimTurnAttempt(tenant, { turnId, attemptId, expectedFencingToken: 0, leaseId: "lease_f5", ttlMs: 60_000 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    const cancel = await repo.requestCancelTurnAttempt(tenant, { turnId, attemptId });
    expect(cancel.ok).toBe(true);

    const ev = await repo.appendStreamEvent(tenant, {
      id: "tev_f5",
      turnId,
      sequence: 1,
      eventType: "done",
      data: { status: "Cancelled", isComplete: false },
      attemptId,
      expectedFencingToken: claim.fencingToken,
    });
    expect(ev.eventType).toBe("done");
  });
});