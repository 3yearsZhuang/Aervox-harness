/**
 * Aervox｜思隅 @aervox/database — B4-D：原子写对（§12.2）
 *
 * - recordToolOutcomeAtomically：tool_executions 收口 + tool_result 事件同事务，
 *   fencing 失配抛 FencingMismatchError 且无部分写入；
 * - finalizeAttemptWithEventAtomically：终态 CAS + done/error 事件同事务，
 *   CAS 失败返回 false 且不写事件（杜绝孤儿 done）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, type AervoxDatabase, type TenantContext } from "../src/index.js";
import { FencingMismatchError } from "../src/errors.js";
import type { Client } from "@libsql/client";

const tenant: TenantContext = { workspaceId: "ws_atomic", subjectUserId: "usr_atomic" };

describe("B4-D 原子写对", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;
  let seq = 0;

  const nextTurn = async (): Promise<{ turnId: string; attemptId: string }> => {
    const n = (++seq).toString(36);
    const turnId = `turn_atomic_${n}`;
    const sessionId = `ses_atomic_${n}`;
    await repo.getOrCreateSession(tenant, sessionId, "原子写对");
    await repo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId, idempotencyKey: `idem_${turnId}`, status: "Created" },
      { id: `msg_${turnId}`, content: "x" },
      { id: `ob_${turnId}`, eventType: "turn.created", idempotencyKey: `idem_ob_${turnId}`, payload: { turnId } },
    );
    const attemptId = `atp_atomic_${n}`;
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

  it("recordToolOutcomeAtomically：账本收口 + tool_result 事件同事务写入", async () => {
    const { turnId, attemptId } = await nextTurn();
    await repo.claimTurnAttempt(tenant, { turnId, attemptId, expectedFencingToken: 0, leaseId: "lease_a1", ttlMs: 60_000 });
    await repo.reserveToolExecution(tenant, { turnId, attemptId, invocationId: "atp_atomic_1:1:1", name: "notes_search", arguments: {} });

    const ok = await repo.recordToolOutcomeAtomically(tenant, {
      turnId,
      attemptId,
      sequence: 2,
      invocationId: "atp_atomic_1:1:1",
      name: "notes_search",
      arguments: {},
      status: "executed",
      output: { notes: "ok" },
      startedAt: new Date().toISOString(),
      eventData: { executionId: "atp_atomic_1:1:1", ok: true, output: { notes: "ok" } },
      safetyDecision: "approved",
      expectedFencingToken: 1,
    });
    expect(ok).toBe(true);

    // 账本已收口
    const executions = await repo.listToolExecutionsByTurn(tenant, turnId);
    expect(executions[0]?.status).toBe("executed");
    // 事件已写入
    const events = await repo.getStreamEvents(tenant, turnId, 0);
    expect(events.some((e) => e.eventType === "tool_result")).toBe(true);
  });

  it("recordToolOutcomeAtomically：fencing 失配 → 抛错且无部分写入", async () => {
    const { turnId, attemptId } = await nextTurn();
    await repo.claimTurnAttempt(tenant, { turnId, attemptId, expectedFencingToken: 0, leaseId: "lease_a2", ttlMs: 60_000 });
    await repo.reserveToolExecution(tenant, { turnId, attemptId, invocationId: "atp_atomic_2:1:1", name: "notes_search", arguments: {} });

    await expect(
      repo.recordToolOutcomeAtomically(tenant, {
        turnId,
        attemptId,
        sequence: 2,
        invocationId: "atp_atomic_2:1:1",
        name: "notes_search",
        arguments: {},
        status: "executed",
        startedAt: new Date().toISOString(),
        eventData: { ok: true },
        safetyDecision: "approved",
        expectedFencingToken: 99, // 失配
      }),
    ).rejects.toThrow(FencingMismatchError);

    // 无部分写入：无 tool_result 事件、账本仍 pending
    const events = await repo.getStreamEvents(tenant, turnId, 0);
    expect(events.some((e) => e.eventType === "tool_result")).toBe(false);
    const executions = await repo.listToolExecutionsByTurn(tenant, turnId);
    expect(executions[0]?.status).toBe("pending");
  });

  it("finalizeAttemptWithEventAtomically：终态 + done 同事务；CAS 失败不写事件", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await repo.claimTurnAttempt(tenant, { turnId, attemptId, expectedFencingToken: 0, leaseId: "lease_a3", ttlMs: 60_000 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const ok = await repo.finalizeAttemptWithEventAtomically(tenant, {
      turnId,
      attemptId,
      status: "Completed",
      expectedFencingToken: claim.fencingToken,
      sequence: 3,
      eventType: "done",
      eventData: { status: "Completed", isComplete: true },
      safetyDecision: "approved",
    });
    expect(ok).toBe(true);

    const events = await repo.getStreamEvents(tenant, turnId, 0);
    expect(events.some((e) => e.eventType === "done")).toBe(true);
    const [attempt] = await repo.listTurnAttempts(tenant, turnId);
    expect(attempt?.status).toBe("Completed");

    // 二次提交（已终态）→ false 且不写第二个 done
    const again = await repo.finalizeAttemptWithEventAtomically(tenant, {
      turnId,
      attemptId,
      status: "Failed",
      expectedFencingToken: claim.fencingToken,
      sequence: 4,
      eventType: "error",
      eventData: { code: "X" },
      safetyDecision: "approved",
    });
    expect(again).toBe(false);
    const eventsAfter = await repo.getStreamEvents(tenant, turnId, 0);
    expect(eventsAfter.filter((e) => e.eventType === "error")).toHaveLength(0);
  });
});