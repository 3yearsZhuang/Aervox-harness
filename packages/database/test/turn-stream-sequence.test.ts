/**
 * 流事件序号并发分配回归测试（UQ-01 sequence 冲突缺陷修复）
 *
 * 缺陷：执行器（本地计数器）与协调器/路由（读条数+1）各自分配 turn_stream_events.sequence，
 * 并发追加时触发唯一约束 (turn_id, sequence) 冲突，导致真实 LLM 下模型提问回合报
 * MODEL_UNAVAILABLE 且 Attempt 卡死。
 * 修复：appendStreamEvent 缺省序号时仓储原子分配 MAX+1；显式序号冲突时回退原子改配。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("流事件序号并发分配（UQ-01 冲突修复）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;
  let turnId = "";

  const tenant: TenantContext = {
    workspaceId: "ws_seq_test",
    subjectUserId: "usr_seq_test",
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    const session = await repo.createSession(tenant, "序号测试会话");
    const { turn } = await repo.createTurnWithOutbox(
      tenant,
      { id: "t_seq_1", sessionId: session.id, idempotencyKey: "idem_seq_1" },
      { id: "m_seq_1", content: "写篇笔记" },
    );
    turnId = turn.id;
  });

  it("缺省序号：仓储原子分配，连续追加单调递增且唯一", async () => {
    const a = await repo.appendStreamEvent(tenant, { id: "ev_a", turnId, eventType: "message", data: {} });
    const b = await repo.appendStreamEvent(tenant, { id: "ev_b", turnId, eventType: "delta", data: {} });
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
  });

  it("执行器滞后计数器与协调器并发插入：冲突序号原子改配，不再抛唯一约束错误", async () => {
    // 1. 模拟执行器：本地计数器写 message(1)、tool_request(2)
    await repo.appendStreamEvent(tenant, { id: "ev_exec_1", turnId, sequence: 1, eventType: "message", data: {} });
    await repo.appendStreamEvent(tenant, { id: "ev_exec_2", turnId, sequence: 2, eventType: "tool_request", data: {} });

    // 2. 模拟协调器：无序号原子分配 → 3
    const uq = await repo.appendStreamEvent(tenant, {
      id: "ev_coord_1",
      turnId,
      eventType: "user_question_required",
      data: {},
    });
    expect(uq.sequence).toBe(3);

    // 3. 模拟执行器本地计数器滞后：仍认为下一个是 3 → 冲突回退为原子分配 4
    const stale = await repo.appendStreamEvent(tenant, {
      id: "ev_exec_3",
      turnId,
      sequence: 3,
      eventType: "tool_result",
      data: {},
    });
    expect(stale.sequence).toBe(4);

    // 4. 全量校验：序号唯一、单调递增、事件类型完整
    const events = await repo.getStreamEvents(tenant, turnId, 0);
    const sequences = events.map((e) => e.sequence);
    expect(sequences).toEqual([1, 2, 3, 4]);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(events.map((e) => e.eventType)).toEqual([
      "message",
      "tool_request",
      "user_question_required",
      "tool_result",
    ]);
  });

  it("显式序号占用他人 eventId 之外的非唯一冲突（如其它唯一约束）仍然抛出", async () => {
    await repo.appendStreamEvent(tenant, { id: "ev_dup_id", turnId, sequence: 1, eventType: "message", data: {} });
    // 同 id 主键冲突不属于序号回退范畴，应原样抛出
    await expect(
      repo.appendStreamEvent(tenant, { id: "ev_dup_id", turnId, sequence: 9, eventType: "delta", data: {} }),
    ).rejects.toThrow();
  });
});
