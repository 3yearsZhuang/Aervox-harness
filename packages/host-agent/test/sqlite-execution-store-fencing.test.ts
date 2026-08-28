/**
 * Aervox｜思隅 @aervox/host-agent — B1：SqliteExecutionStore 事件写入 fencing 桥接（3c+）
 *
 * 宿主适配把 @aervox/database 的 FencingMismatchError 转译为 Loop 的 LeaseLostError，
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
  type TenantContext,
} from "@aervox/database";
import type { Client } from "@libsql/client";

const tenant: TenantContext = { workspaceId: "ws_fhost", subjectUserId: "usr_fhost" };

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
    await repo.getOrCreateSession(tenant, sessionId, "fhost 测试");
    await repo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId, idempotencyKey: `idem_${turnId}`, status: "Created" },
      { id: `msg_${turnId}`, content: "x" },
      { id: `ob_${turnId}`, eventType: "turn.created", idempotencyKey: `idem_ob_${turnId}`, payload: { turnId } },
    );
    const attemptId = `atp_fhost_${n}`;
    await repo.createTurnAttempt(tenant, turnId, { id: attemptId, attempt: 1 });
    return { turnId, attemptId };
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    store = new SqliteExecutionStore(repo, tenant);
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
});