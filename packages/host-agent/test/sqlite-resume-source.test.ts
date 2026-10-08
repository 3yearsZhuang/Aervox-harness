/**
 * Aervox｜思隅 @aervox/host-agent — SQLite 续跑源集成测试（阶段 4b）
 *
 * 覆盖：真实 SQLite 上「工具结果已权威提交但尚未注入」的过期 Attempt →
 * findResumeCandidates 命中 → createSqliteResumeSource 重建上下文产出 ClaimableTurn；
 * 非可续候选（有 done 终态 / 未知结果）过滤。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteResumeSource, resumeCommittedTurns, SqliteExecutionStore } from "../src/index.js";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  SqliteToolRegistryRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";

const ctx: LocalContext = { workspaceId: "ws_src", subjectUserId: "usr_src" };

describe("SqliteResumeSource（续跑候选源）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;

  async function seedExpiredAttemptWithCommittedTool(): Promise<void> {
    await repo.getOrCreateSession(ctx, "ses_src", "续跑源测试");
    await repo.createTurnWithOutbox(
      ctx,
      { id: "turn_src", sessionId: "ses_src", idempotencyKey: "idem_src", status: "Created" },
      { id: "msg_src", content: "帮我查复习计划" },
      { id: "ob_src", eventType: "turn.created", idempotencyKey: "idem_ob_src", payload: { turnId: "turn_src", sessionId: "ses_src" } },
    );
    await repo.createTurnAttempt(ctx, "turn_src", { id: "atp_src", attempt: 1 });
    await repo.claimTurnAttempt(ctx, {
      turnId: "turn_src",
      attemptId: "atp_src",
      expectedFencingToken: 0,
      leaseId: "lease_src",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10)); // 等租约过期
    await repo.reserveToolExecution(ctx, {
      turnId: "turn_src",
      attemptId: "atp_src",
      invocationId: "atp_src:1:1",
      name: "notes_search",
      arguments: {},
    });
    await repo.updateToolExecutionResult(ctx, {
      turnId: "turn_src",
      attemptId: "atp_src",
      invocationId: "atp_src:1:1",
      status: "executed",
      output: { notes: "三角函数" },
    });
    await repo.appendStreamEvent(ctx, {
      id: "tev_src_msg",
      turnId: "turn_src",
      attemptId: "atp_src",
      sequence: 1,
      eventType: "message",
      data: { messageId: "msg_turn_src_assistant", role: "assistant", contentType: "text", isComplete: false },
      occurredAt: new Date().toISOString(),
    });
    await repo.appendStreamEvent(ctx, {
      id: "tev_src_delta",
      turnId: "turn_src",
      attemptId: "atp_src",
      sequence: 2,
      eventType: "delta",
      data: { messageId: "msg_turn_src_assistant", text: "让我查一下。", isFinal: false },
      occurredAt: new Date().toISOString(),
    });
    await repo.appendStreamEvent(ctx, {
      id: "tev_src_toolreq",
      turnId: "turn_src",
      attemptId: "atp_src",
      sequence: 3,
      eventType: "tool_request",
      data: { invocationId: "call_1", executionId: "atp_src:1:1", name: "notes_search", arguments: {} },
      occurredAt: new Date().toISOString(),
    });
    await repo.appendStreamEvent(ctx, {
      id: "tev_src_toolres",
      turnId: "turn_src",
      attemptId: "atp_src",
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

  afterEach(() => client.close());

  it("real SQLite resumes only the committed result and preserves the sequence watermark", async () => {
    await seedExpiredAttemptWithCommittedTool();
    await repo.appendStreamEvent(ctx, { id: "late_reason", turnId: "turn_src", attemptId: "atp_src", sequence: 7, eventType: "reasoning_delta", data: { text: "progress" } });
    const source = createSqliteResumeSource({ repo, client });
    const snapshot = await source.listClaimable(1);
    expect(snapshot[0]?.resume?.lastSequence).toBe(7);
    const createProvider = vi.fn(async (_turn, control) => {
      expect(control.localProcessingOnly).toBe(true);
      return { id: "local-fixture", async *stream(request) {
        expect(request.tools).toBeUndefined();
        expect(request.context.messages.some(m => m.role === "tool" && m.content.includes("三角函数"))).toBe(true);
        yield { text: "已查询的计划如下", isFinal: true };
      } };
    });
    const deps = { source: { listClaimable: async () => snapshot }, createStore: () => new SqliteExecutionStore(repo, ctx), createProvider, deletionGate: { isBlocked: async () => false } };
    const result = await resumeCommittedTurns(deps);
    expect(result[0]?.status).toBe("completed");
    const rows = await client.execute("SELECT status FROM turn_attempts WHERE id = 'atp_src'");
    expect(rows.rows[0]?.status).toBe("Completed");
    const executions = await repo.listToolExecutionsByTurn(ctx, "turn_src");
    expect(executions).toHaveLength(1);
    const events = await repo.getStreamEvents(ctx, "turn_src");
    expect(events.filter(e => e.eventType === "done")).toHaveLength(1);
    expect(events.at(-1)!.sequence).toBeGreaterThan(7);
    expect((await resumeCommittedTurns(deps))[0]?.status).toBe("skipped");
  });

  it("redacted input cannot become a resume candidate", async () => {
    await seedExpiredAttemptWithCommittedTool();
    await repo.redactTurnMessages(ctx, "turn_src");
    expect(await createSqliteResumeSource({ repo, client }).listClaimable(1)).toEqual([]);
  });

  it("deletion blocks provider admission; newer uncommitted tool intent blocks recovery", async () => {
    await seedExpiredAttemptWithCommittedTool();
    const source = createSqliteResumeSource({ repo, client });
    const createProvider = vi.fn();
    expect(await resumeCommittedTurns({ source, createStore: () => new SqliteExecutionStore(repo, ctx), createProvider, deletionGate: { isBlocked: async () => true } })).toEqual([]);
    expect(createProvider).not.toHaveBeenCalled();
    await repo.appendStreamEvent(ctx, { id: "late_intent", turnId: "turn_src", attemptId: "atp_src", sequence: 8, eventType: "tool_request", data: { executionId: "atp_src:2:1", invocationId: "call2", name: "write", arguments: {} } });
    expect(await source.listClaimable(1)).toEqual([]);
  });

  it("续跑携带此前会话历史，并保留本轮权威工具结果", async () => {
    await repo.getOrCreateSession(ctx, "ses_src");
    await repo.createTurnWithOutbox(ctx,
      { id: "previous", sessionId: "ses_src", idempotencyKey: "previous", status: "Completed" },
      { id: "previous_user", content: "我叫小庄" });
    await repo.appendStreamEvent(ctx, {
      id: "previous_delta", turnId: "previous", sequence: 1, eventType: "delta",
      safetyDecision: "approved", data: { messageId: "previous_assistant", text: "好的，小庄。" },
    });
    await repo.appendStreamEvent(ctx, {
      id: "previous_done", turnId: "previous", sequence: 2, eventType: "done",
      safetyDecision: "approved",
      data: { messageId: "previous_assistant", status: "Completed", isComplete: true },
    });
    await seedExpiredAttemptWithCommittedTool();
    const source = createSqliteResumeSource({ repo, client });
    const [candidate] = await source.listClaimable(10);
    expect(candidate?.resume?.history.slice(0, 3)).toEqual([
      { role: "user", content: "我叫小庄" },
      { role: "assistant", content: "好的，小庄。" },
      { role: "user", content: "帮我查复习计划" },
    ]);
    expect(candidate?.resume?.history.at(-1)?.role).toBe("tool");
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
    await repo.appendStreamEvent(ctx, {
      id: "tev_src_done",
      turnId: "turn_src",
      attemptId: "atp_src",
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
    await repo.getOrCreateSession(ctx, "ses_src2", "续跑源测试2");
    await repo.createTurnWithOutbox(
      ctx,
      { id: "turn_src2", sessionId: "ses_src2", idempotencyKey: "idem_src2", status: "Created" },
      { id: "msg_src2", content: "x" },
    );
    await repo.createTurnAttempt(ctx, "turn_src2", { id: "atp_src2", attempt: 1 });
    await repo.claimTurnAttempt(ctx, {
      turnId: "turn_src2",
      attemptId: "atp_src2",
      expectedFencingToken: 0,
      leaseId: "lease_src2",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    await repo.reserveToolExecution(ctx, {
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

  // ============ B3：结果未知三态政策（§11.3 行 4/5） ============

  /** 批：tool1 已执行（executed）+ tool2 仅请求（pending，崩溃残留意图） */
  async function seedExpiredMixedBatch(replay: "safe" | "never"): Promise<void> {
    await new SqliteToolRegistryRepository(db).registerTool({
      id: "notes_search",
      name: "notes_search",
      description: "查询笔记",
      category: "memory",
      safetyLevel: "read_only",
      replay,
    });
    await repo.getOrCreateSession(ctx, "ses_src_b3", "续跑源B3测试");
    await repo.createTurnWithOutbox(
      ctx,
      { id: "turn_src_b3", sessionId: "ses_src_b3", idempotencyKey: "idem_src_b3", status: "Created" },
      { id: "msg_src_b3", content: "再查一下" },
      { id: "ob_src_b3", eventType: "turn.created", idempotencyKey: "idem_ob_src_b3", payload: { turnId: "turn_src_b3" } },
    );
    await repo.createTurnAttempt(ctx, "turn_src_b3", { id: "atp_src_b3", attempt: 1 });
    await repo.claimTurnAttempt(ctx, {
      turnId: "turn_src_b3",
      attemptId: "atp_src_b3",
      expectedFencingToken: 0,
      leaseId: "lease_src_b3",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10)); // 租约过期
    await repo.reserveToolExecution(ctx, {
      turnId: "turn_src_b3", attemptId: "atp_src_b3", invocationId: "atp_src_b3:1:1", name: "notes_search", arguments: {},
    });
    await repo.updateToolExecutionResult(ctx, {
      turnId: "turn_src_b3", attemptId: "atp_src_b3", invocationId: "atp_src_b3:1:1", status: "executed", output: { notes: "B3" },
    });
    await repo.reserveToolExecution(ctx, {
      turnId: "turn_src_b3", attemptId: "atp_src_b3", invocationId: "atp_src_b3:1:2", name: "notes_search", arguments: {},
    }); // 留 pending：意图已提交、未收口
    await repo.appendStreamEvent(ctx, {
      id: "tev_b3_msg", turnId: "turn_src_b3", attemptId: "atp_src_b3", sequence: 1, eventType: "message",
      data: { messageId: "msg_turn_src_b3_assistant" }, occurredAt: new Date().toISOString(),
    });
    await repo.appendStreamEvent(ctx, {
      id: "tev_b3_req1", turnId: "turn_src_b3", attemptId: "atp_src_b3", sequence: 2, eventType: "tool_request",
      data: { invocationId: "call_1", executionId: "atp_src_b3:1:1", name: "notes_search", arguments: {} },
      occurredAt: new Date().toISOString(),
    });
    await repo.appendStreamEvent(ctx, {
      id: "tev_b3_res1", turnId: "turn_src_b3", attemptId: "atp_src_b3", sequence: 3, eventType: "tool_result",
      data: { invocationId: "call_1", executionId: "atp_src_b3:1:1", name: "notes_search", ok: true, output: { notes: "B3" } },
      occurredAt: new Date().toISOString(),
    });
    await repo.appendStreamEvent(ctx, {
      id: "tev_b3_req2", turnId: "turn_src_b3", attemptId: "atp_src_b3", sequence: 4, eventType: "tool_request",
      data: { invocationId: "call_2", executionId: "atp_src_b3:1:2", name: "notes_search", arguments: {} },
      occurredAt: new Date().toISOString(),
    }); // 无 tool_result：崩溃前最后请求
  }

  it("replay:safe does not auto-resume an unknown result in the production source", async () => {
    await seedExpiredMixedBatch("safe");
    expect(await createSqliteResumeSource({ repo, client }).listClaimable(10)).toEqual([]);
  });

  it("B3 fail-closed：pending（replay:never）→ 收敛，不产出候选", async () => {
    await seedExpiredMixedBatch("never");
    const source = createSqliteResumeSource({ repo, client });
    const turns = await source.listClaimable(10);
    expect(turns).toHaveLength(0);
  });
});
