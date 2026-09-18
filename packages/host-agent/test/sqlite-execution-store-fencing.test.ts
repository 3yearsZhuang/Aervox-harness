/**
 * Aervox｜思隅 @aervox/host-agent — B1：SqliteExecutionStore 事件写入 fencing 桥接（3c+）
 *
 * 宿主适配把 @aervox/repositories 的 FencingMismatchError 转译为 Loop 的 LeaseLostError，
 * 使 executor 可识别「被抢占」并立即收敛。未携带期望值时保持既有无校验行为。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteExecutionStore } from "../src/index.js";
import { LeaseLostError } from "@aervox/agent-loop";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";

const ctx: LocalContext = { workspaceId: "ws_fhost", subjectUserId: "usr_fhost" };

describe("SqliteExecutionStore 事件写入 fencing 桥接", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;
  let store: SqliteExecutionStore;
  let seq = 0;

  const nextTurn = async (): Promise<{ turnId: string; attemptId: string }> => {
    const n = (++seq).toString(36);
    const turnId = `turn_fhost_${n}`;
    const sessionId = `ses_fhost_${n}`;
    await repo.getOrCreateSession(ctx, sessionId, "fhost 测试");
    await repo.createTurnWithOutbox(
      ctx,
      { id: turnId, sessionId, idempotencyKey: `idem_${turnId}`, status: "Created" },
      { id: `msg_${turnId}`, content: "x" },
      { id: `ob_${turnId}`, eventType: "turn.created", idempotencyKey: `idem_ob_${turnId}`, payload: { turnId } },
    );
    const attemptId = `atp_fhost_${n}`;
    await repo.createTurnAttempt(ctx, turnId, { id: attemptId, attempt: 1 });
    return { turnId, attemptId };
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    store = new SqliteExecutionStore(repo, ctx);
  });

  it("claim 后携带正确 fencing 写入通过", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await store.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 0 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const ev = await store.appendEvent({
      turnId,
      attemptId,
      sequence: await store.nextSequence(turnId),
      eventType: "message",
      data: { text: "ok" },
      safetyDecision: "approved",
      expectedFencingToken: claim.fencingToken,
    });
    expect(ev.eventType).toBe("message");
  });

  it("fencing 失配 → 转译为 LeaseLostError", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await store.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 0 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    await expect(
      store.appendEvent({
        turnId,
        attemptId,
        sequence: await store.nextSequence(turnId),
        eventType: "delta",
        data: { text: "late" },
        safetyDecision: "approved",
        expectedFencingToken: claim.fencingToken + 100, // 已不等于当前 fencing
      }),
    ).rejects.toThrow(LeaseLostError);

    const events = await store.listEvents(turnId);
    expect(events).toHaveLength(0); // 零污染
  });

  it("未携带期望 fencing：保持既有无校验行为（兼容路径）", async () => {
    const { turnId, attemptId } = await nextTurn();
    const ev = await store.appendEvent({
      turnId,
      attemptId,
      sequence: await store.nextSequence(turnId),
      eventType: "error",
      data: { code: "HOST_COMPAT" },
      safetyDecision: "approved",
    });
    expect(ev.eventType).toBe("error");
  });

  // ============ B4-D：原子写对桥接 ============

  it("recordToolOutcome：账本 + 事件原子；fencing 失配转译 LeaseLostError", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await store.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 0 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    await repo.reserveToolExecution(ctx, { turnId, attemptId, invocationId: `atp_fhost_d:1:1`, name: "notes_search", arguments: {} });

    const ok = await store.recordToolOutcome({
      turnId,
      attemptId,
      sequence: await store.nextSequence(turnId),
      invocationId: `atp_fhost_d:1:1`,
      name: "notes_search",
      arguments: {},
      status: "executed",
      output: { notes: "ok" },
      startedAt: new Date().toISOString(),
      eventData: { ok: true },
      safetyDecision: "approved",
      expectedFencingToken: claim.fencingToken,
    });
    expect(ok.ok).toBe(true);
    const events = await store.listEvents(turnId);
    expect(events.some((e) => e.eventType === "tool_result")).toBe(true);

    await expect(
      store.recordToolOutcome({
        turnId,
        attemptId,
        sequence: await store.nextSequence(turnId),
        invocationId: `atp_fhost_d:1:1`,
        name: "notes_search",
        arguments: {},
        status: "executed",
        startedAt: new Date().toISOString(),
        eventData: { ok: true },
        safetyDecision: "approved",
        expectedFencingToken: claim.fencingToken + 100,
      }),
    ).rejects.toThrow(LeaseLostError);
  });

  it("finalizeAttemptWithEvent：终态 + done 原子；CAS 失败返回 false", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await store.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 0 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const ok = await store.finalizeAttemptWithEvent({
      turnId,
      attemptId,
      status: "Completed",
      expectedFencingToken: claim.fencingToken,
      sequence: await store.nextSequence(turnId),
      eventType: "done",
      eventData: { status: "Completed", isComplete: true },
      safetyDecision: "approved",
    });
    expect(ok.ok).toBe(true);
    const events = await store.listEvents(turnId);
    expect(events.some((e) => e.eventType === "done")).toBe(true);

    // 已终态 → false 且不写第二个事件
    const again = await store.finalizeAttemptWithEvent({
      turnId,
      attemptId,
      status: "Failed",
      expectedFencingToken: claim.fencingToken,
      sequence: await store.nextSequence(turnId),
      eventType: "error",
      eventData: { code: "X" },
      safetyDecision: "approved",
    });
    expect(again.ok).toBe(false);
    const eventsAfter = await store.listEvents(turnId);
    expect(eventsAfter.filter((e) => e.eventType === "error")).toHaveLength(0);
  });

  it("recordSafeSegment：安全片段 + delta 事件原子；可见前缀读取；fencing 失配转译", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await store.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 0 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const ok = await store.recordSafeSegment({
      turnId,
      attemptId,
      sequence: await store.nextSequence(turnId),
      text: "第一段",
      eventData: { text: "第一段", isFinal: false },
      safetyDecision: "approved",
      expectedFencingToken: claim.fencingToken,
    });
    expect(ok.ok).toBe(true);

    const events = await store.listEvents(turnId);
    expect(events.some((e) => e.eventType === "delta")).toBe(true);
    const segments = await store.listCommittedSegments(turnId);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe("第一段");

    await expect(
      store.recordSafeSegment({
        turnId,
        attemptId,
        sequence: await store.nextSequence(turnId),
        text: "迟到",
        eventData: { text: "迟到" },
        safetyDecision: "approved",
        expectedFencingToken: claim.fencingToken + 100,
      }),
    ).rejects.toThrow(LeaseLostError);
  });

  it("recordSafeSegments：同一 step 的多个 delta 在一次批量事务中落盘", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await store.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 0 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const start = await store.nextSequence(turnId);
    const result = await store.recordSafeSegments([
      {
        turnId,
        attemptId,
        sequence: start,
        text: "第一块",
        eventData: { text: "第一块", isFinal: true },
        safetyDecision: "approved",
        expectedFencingToken: claim.fencingToken,
      },
      {
        turnId,
        attemptId,
        sequence: start + 1,
        text: "第二块",
        eventData: { text: "第二块", isFinal: true },
        safetyDecision: "approved",
        expectedFencingToken: claim.fencingToken,
      },
    ]);
    expect(result.ok).toBe(true);
    expect((await store.listEvents(turnId)).filter((event) => event.eventType === "delta")).toHaveLength(2);
    expect((await store.listCommittedSegments(turnId)).map((segment) => segment.text)).toEqual(["第一块", "第二块"]);

    await expect(
      store.recordSafeSegments([
        {
          turnId,
          attemptId,
          sequence: start + 2,
          text: "迟到",
          eventData: { text: "迟到" },
          safetyDecision: "approved",
          expectedFencingToken: claim.fencingToken + 1,
        },
      ]),
    ).rejects.toThrow(LeaseLostError);
  });
});
