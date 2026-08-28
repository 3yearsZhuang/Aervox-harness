/**
 * Aervox｜思隅 @aervox/database — 阶段 2c 工具幂等预留与 unknown outcome 测试
 *
 * 覆盖 AVX-HAR-001 §9（idempotency reservation）与 §11.3（unknown outcome 不自动重放）：
 * - reserve 幂等：attempt+invocation 唯一，重复预留不重复写行（ON CONFLICT DO NOTHING）；
 * - update 收口：执行后以权威状态/结果回写；预留未收口的 pending 在释放后标记 outcome_unknown。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, type AervoxDatabase, type TenantContext } from "../src/index.js";
import type { Client } from "@libsql/client";

const tenant: TenantContext = { workspaceId: "ws_resv", subjectUserId: "usr_resv" };

describe("2c 工具幂等预留与结果收口", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    await repo.getOrCreateSession(tenant, "ses_resv", "预留测试");
    await repo.createTurnWithOutbox(
      tenant,
      { id: "turn_resv", sessionId: "ses_resv", idempotencyKey: "idem_resv", status: "Created" },
      { id: "msg_resv", content: "x" },
      { id: "ob_resv", eventType: "turn.created", idempotencyKey: "idem_ob_resv", payload: { turnId: "turn_resv", sessionId: "ses_resv" } },
    );
    await repo.createTurnAttempt(tenant, "turn_resv", { id: "atp_resv", attempt: 1 });
  });

  it("reserve 新建预留：status=pending，非 already", async () => {
    const res = await repo.reserveToolExecution(tenant, {
      turnId: "turn_resv",
      attemptId: "atp_resv",
      invocationId: "call_1",
      name: "notes_search",
      arguments: { query: "x" },
    });
    expect(res).toEqual({ ok: true, alreadyReserved: false });
    const rows = await repo.listToolExecutionsByTurn(tenant, "turn_resv");
    expect(rows[0]?.status).toBe("pending");
  });

  it("reserve 幂等：同 attempt+invocation 二次预留不重复写行", async () => {
    await repo.reserveToolExecution(tenant, {
      turnId: "turn_resv",
      attemptId: "atp_resv",
      invocationId: "call_1",
      name: "notes_search",
      arguments: { query: "x" },
    });
    const again = await repo.reserveToolExecution(tenant, {
      turnId: "turn_resv",
      attemptId: "atp_resv",
      invocationId: "call_1",
      name: "notes_search",
      arguments: { query: "x" },
    });
    expect(again).toEqual({ ok: true, alreadyReserved: true });
    const rows = await repo.listToolExecutionsByTurn(tenant, "turn_resv");
    expect(rows).toHaveLength(1);
  });

  it("update 收口：预留行以权威结果回写", async () => {
    await repo.reserveToolExecution(tenant, {
      turnId: "turn_resv",
      attemptId: "atp_resv",
      invocationId: "call_1",
      name: "notes_search",
      arguments: { query: "x" },
    });
    const updated = await repo.updateToolExecutionResult(tenant, {
      turnId: "turn_resv",
      attemptId: "atp_resv",
      invocationId: "call_1",
      status: "executed",
      output: { hits: 3 },
    });
    expect(updated.ok).toBe(true);
    const rows = await repo.listToolExecutionsByTurn(tenant, "turn_resv");
    expect(rows).toHaveLength(1); // 仍是同一行
    expect(rows[0]?.status).toBe("executed");
    expect(rows[0]?.outputJson).toEqual({ hits: 3 });
  });

  it("释放后 pending 预留标记 outcome_unknown（§11.3 不自动重放）", async () => {
    await repo.claimTurnAttempt(tenant, {
      turnId: "turn_resv",
      attemptId: "atp_resv",
      expectedFencingToken: 0,
      leaseId: "lease_r1",
      ttlMs: 1,
    });
    await repo.reserveToolExecution(tenant, {
      turnId: "turn_resv",
      attemptId: "atp_resv",
      invocationId: "call_1",
      name: "notes_search",
      arguments: { query: "x" },
    });
    await new Promise((r) => setTimeout(r, 10)); // 租约过期
    await repo.recoverExpiredAttempts(client); // attempt → Interrupted（fencing+1）
    const marked = await repo.markPendingOutcomeUnknown(client);
    expect(marked).toBeGreaterThanOrEqual(1);
    const rows = await repo.listToolExecutionsByTurn(tenant, "turn_resv");
    expect(rows[0]?.status).toBe("outcome_unknown");
  });
});

describe("3c 恢复候选（findResumeCandidates）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    await repo.getOrCreateSession(tenant, "ses_resume", "恢复候选测试");
    await repo.createTurnWithOutbox(
      tenant,
      { id: "turn_resume", sessionId: "ses_resume", idempotencyKey: "idem_resume", status: "Created" },
      { id: "msg_resume", content: "x" },
      { id: "ob_resume", eventType: "turn.created", idempotencyKey: "idem_ob_resume", payload: { turnId: "turn_resume", sessionId: "ses_resume" } },
    );
    await repo.createTurnAttempt(tenant, "turn_resume", { id: "atp_resume", attempt: 1 });
  });

  async function seedExecutedToolWithExpiredLease(): Promise<void> {
    await repo.claimTurnAttempt(tenant, {
      turnId: "turn_resume",
      attemptId: "atp_resume",
      expectedFencingToken: 0,
      leaseId: "lease_resume",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    await repo.reserveToolExecution(tenant, {
      turnId: "turn_resume",
      attemptId: "atp_resume",
      invocationId: "atp_resume:1:1",
      name: "notes_write",
      arguments: {},
    });
    await repo.updateToolExecutionResult(tenant, {
      turnId: "turn_resume",
      attemptId: "atp_resume",
      invocationId: "atp_resume:1:1",
      status: "executed",
      output: { ok: true },
    });
    await repo.appendStreamEvent(tenant, {
      id: "tev_resume_1",
      turnId: "turn_resume",
      sequence: 1,
      eventType: "tool_result",
      data: { executionId: "atp_resume:1:1", ok: true },
      occurredAt: new Date().toISOString(),
    });
  }

  it("过期 Running + executed 工具 + 无终态事件 → 命中候选（lastSequence=tool_result seq + 续跑数据面）", async () => {
    await seedExecutedToolWithExpiredLease();
    const candidates = await repo.findResumeCandidates(client);
    expect(candidates[0]).toMatchObject({
      attemptId: "atp_resume",
      turnId: "turn_resume",
      sessionId: "ses_resume",
      workspaceId: "ws_resv",
      subjectUserId: "usr_resv",
      lastSequence: 1,
      fencingToken: 1, // claim（0→1）后崩溃，续跑 claim 预期
    });
  });

  it("存在 done 终态事件 → 不命中", async () => {
    await seedExecutedToolWithExpiredLease();
    await repo.appendStreamEvent(tenant, {
      id: "tev_resume_done",
      turnId: "turn_resume",
      sequence: 2,
      eventType: "done",
      data: { status: "Interrupted" },
      occurredAt: new Date().toISOString(),
    });
    const candidates = await repo.findResumeCandidates(client);
    expect(candidates).toHaveLength(0);
  });

  it("无 executed 工具（仅 pending 预留）→ 不命中（结果未知）", async () => {
    await repo.claimTurnAttempt(tenant, {
      turnId: "turn_resume",
      attemptId: "atp_resume",
      expectedFencingToken: 0,
      leaseId: "lease_resume",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    await repo.reserveToolExecution(tenant, {
      turnId: "turn_resume",
      attemptId: "atp_resume",
      invocationId: "atp_resume:1:1",
      name: "notes_write",
      arguments: {},
    });
    const candidates = await repo.findResumeCandidates(client);
    expect(candidates).toHaveLength(0);
  });
});