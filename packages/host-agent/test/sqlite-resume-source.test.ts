/**
 * Aervox｜思隅 @aervox/host-agent — SQLite 续跑源集成测试（阶段 4b）
 *
 * 覆盖：真实 SQLite 上「工具结果已权威提交但尚未注入」的过期 Attempt →
 * findResumeCandidates 命中 → createSqliteResumeSource 重建上下文产出 ClaimableTurn；
 * 非可续候选（有 done 终态 / 未知结果）过滤。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createSqliteResumeSource } from "../src/index.js";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type TenantContext,
} from "@aervox/database";
import type { Client } from "@libsql/client";

const tenant: TenantContext = { workspaceId: "ws_src", subjectUserId: "usr_src" };

describe("SqliteResumeSource（续跑候选源）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;

  async function seedExpiredAttemptWithCommittedTool(): Promise<void> {
    await repo.getOrCreateSession(tenant, "ses_src", "续跑源测试");
    await repo.createTurnWithOutbox(
      tenant,
      { id: "turn_src", sessionId: "ses_src", idempotencyKey: "idem_src", status: "Created" },
      { id: "msg_src", content: "帮我查复习计划" },
      { id: "ob_src", eventType: "turn.created", idempotencyKey: "idem_ob_src", payload: { turnId: "turn_src", sessionId: "ses_src" } },
    );
    await repo.createTurnAttempt(tenant, "turn_src", { id: "atp_src", attempt: 1 });
    await repo.claimTurnAttempt(tenant, {
      turnId: "turn_src",
      attemptId: "atp_src",
      expectedFencingToken: 0,
      leaseId: "lease_src",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10)); // 等租约过期
    await repo.reserveToolExecution(tenant, {
      turnId: "turn_src",
      attemptId: "atp_src",
      invocationId: "atp_src:1:1",
      name: "notes_search",
      arguments: {},
    });
    await repo.updateToolExecutionResult(tenant, {
      turnId: "turn_src",
      attemptId: "atp_src",
      invocationId: "atp_src:1:1",
      status: "executed",
      output: { notes: "三角函数" },
    });
    await repo.appendStreamEvent(tenant, {
      id: "tev_src_msg",
      turnId: "turn_src",
      sequence: 1,
      eventType: "message",
      data: { messageId: "msg_turn_src_assistant", role: "assistant", contentType: "text", isComplete: false },
      occurredAt: new Date().toISOString(),
    });
    await repo.appendStreamEvent(tenant, {
      id: "tev_src_delta",
      turnId: "turn_src",
      sequence: 2,
      eventType: "delta",
      data: { messageId: "msg_turn_src_assistant", text: "让我查一下。", isFinal: false },
      occurredAt: new Date().toISOString(),
    });
    await repo.appendStreamEvent(tenant, {
      id: "tev_src_toolreq",
      turnId: "turn_src",
      sequence: 3,
      eventType: "tool_request",
      data: { invocationId: "call_1", executionId: "atp_src:1:1", name: "notes_search", arguments: {} },
      occurredAt: new Date().toISOString(),
    });
    await repo.appendStreamEvent(tenant, {
      id: "tev_src_toolres",
      turnId: "turn_src",
      sequence: 4,
      eventType: "tool_result",
      data: { invocationId: "call_1", executionId: "atp_src:1:1", name: "notes_search", ok: true, output: { notes: "三角函数" } },
      occurredAt: new Date().toISOString(),
    });
  }

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
  });

  it("命中可续候选：产出携带 resume 上下文的 ClaimableTurn", async () => {
    await seedExpiredAttemptWithCommittedTool();
    const source = createSqliteResumeSource({ repo, client });
    const turns = await source.listClaimable(10);

    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.turnId).toBe("turn_src");
    expect(t.attemptId).toBe("atp_src");
    expect(t.sessionId).toBe("ses_src");
    expect(t.resume).toBeDefined();
    expect(t.resume!.expectedFencingToken).toBe(1); // claim（0→1）后崩溃
    expect(t.resume!.lastSequence).toBe(4); // 最后 tool_result 序号
    expect(t.resume!.lastStep).toBe(1);
    expect(t.resume!.messageId).toBe("msg_turn_src_assistant");
    // 上下文重建：user + assistant 文本 + 权威工具结果
    expect(t.resume!.history[0]).toMatchObject({ role: "user", content: "帮我查复习计划" });
    expect(t.resume!.history).toHaveLength(3);
  });

  it("有 done 终态事件 → 非可续，过滤（不产出候选）", async () => {
    await seedExpiredAttemptWithCommittedTool();
    await repo.appendStreamEvent(tenant, {
      id: "tev_src_done",
      turnId: "turn_src",
      sequence: 5,
      eventType: "done",
      data: { status: "Completed" },
      occurredAt: new Date().toISOString(),
    });
    const source = createSqliteResumeSource({ repo, client });
    const turns = await source.listClaimable(10);
    expect(turns).toHaveLength(0);
  });

  it("仅 pending 预留（结果未知）→ 非可续，过滤", async () => {
    await repo.getOrCreateSession(tenant, "ses_src2", "续跑源测试2");
    await repo.createTurnWithOutbox(
      tenant,
      { id: "turn_src2", sessionId: "ses_src2", idempotencyKey: "idem_src2", status: "Created" },
      { id: "msg_src2", content: "x" },
    );
    await repo.createTurnAttempt(tenant, "turn_src2", { id: "atp_src2", attempt: 1 });
    await repo.claimTurnAttempt(tenant, {
      turnId: "turn_src2",
      attemptId: "atp_src2",
      expectedFencingToken: 0,
      leaseId: "lease_src2",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    await repo.reserveToolExecution(tenant, {
      turnId: "turn_src2",
      attemptId: "atp_src2",
      invocationId: "atp_src2:1:1",
      name: "notes_search",
      arguments: {},
    });
    const source = createSqliteResumeSource({ repo, client });
    const turns = await source.listClaimable(10);
    expect(turns).toHaveLength(0);
  });
});