import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema } from "../src/index.js";
import { SqliteConversationRepository } from "../src/repositories/sqlite/conversation-repository.js";

const tenant = { workspaceId: "ws_history", subjectUserId: "usr_history" };

describe("安全会话历史读取", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(tenant, "session");
  });
  afterEach(async () => { await database.cleanup(); });

  async function seed(id: string, options: {
    sessionId?: string; status?: string; key?: string; user?: string; assistant?: string;
  } = {}) {
    await repo.createTurnWithOutbox(tenant, {
      id, sessionId: options.sessionId ?? "session",
      idempotencyKey: options.key ?? id, status: options.status ?? "Completed",
    }, { id: `user_${id}`, content: options.user ?? `question_${id}` });
    for (const [index, event] of [
      { eventType: "delta", data: { messageId: `assistant_${id}`, text: options.assistant ?? `answer_${id}` } },
      { eventType: "done", data: { messageId: `assistant_${id}`, status: "Completed", isComplete: true } },
    ].entries()) {
      await repo.appendStreamEvent(tenant, {
        id: `event_${id}_${index}`, turnId: id, sequence: index + 1,
        ...event, attemptId: `attempt_${id}`, safetyDecision: "approved",
      });
    }
  }
  const history = () => repo.getSessionHistory(tenant, { sessionId: "session", beforeTurnId: "current" });

  it("按插入顺序读取，排除当前/未来轮、其他会话和子任务", async () => {
    await seed("z_first");
    await seed("a_second");
    await repo.getOrCreateSession(tenant, "other");
    await seed("other", { sessionId: "other" });
    await seed("child", { key: "subagent:parent:1" });
    await seed("current");
    await seed("future");
    await database.client.execute("UPDATE turns SET created_at = '2026-09-07T00:00:00.000Z'");
    expect(await history()).toEqual([
      { role: "user", content: "question_z_first" }, { role: "assistant", content: "answer_z_first" },
      { role: "user", content: "question_a_second" }, { role: "assistant", content: "answer_a_second" },
    ]);
    expect(await repo.getSessionHistory(tenant, { sessionId: "other", beforeTurnId: "current" })).toEqual([]);
    expect(await repo.getSessionHistory(tenant, { sessionId: "session", beforeTurnId: "child" })).toEqual([]);
  });

  it("排除未完成、失败、取消、脱敏和未通过安全门的历史", async () => {
    for (const status of ["Running", "Failed", "Cancelled", "Interrupted"]) await seed(status, { status });
    await seed("redacted");
    await seed("blocked");
    await seed("pending");
    await seed("withdrawn");
    await seed("valid");
    await seed("current");
    await database.client.execute("UPDATE message_versions SET is_redacted = 1 WHERE turn_id = 'redacted'");
    await database.client.execute("UPDATE turn_stream_events SET safety_decision = 'blocked' WHERE id = 'event_blocked_0'");
    await database.client.execute("UPDATE turn_stream_events SET safety_decision = 'pending' WHERE id = 'event_pending_0'");
    await repo.appendStreamEvent(tenant, { id: "withdraw", turnId: "withdrawn", sequence: 3, eventType: "redacted", data: {} });
    expect(await history()).toEqual([
      { role: "user", content: "question_valid" }, { role: "assistant", content: "answer_valid" },
    ]);
  });

  it("使用最新用户版本，软删除用户或助手后整轮不召回，也不退回旧版本", async () => {
    await seed("edited");
    await seed("current");
    await repo.createMessage(tenant, { id: "identity", sessionId: "session", role: "user" });
    await database.client.execute("UPDATE message_versions SET message_id = 'identity' WHERE turn_id = 'edited'");
    await repo.editMessage(tenant, "identity", "我现在叫小李", 1);
    expect((await history())[0]?.content).toBe("我现在叫小李");
    await database.client.execute("UPDATE message_versions SET is_redacted = 1 WHERE turn_id = 'edited' AND version = 2");
    expect(await history()).toEqual([]);
    await database.client.execute("UPDATE message_versions SET is_redacted = 0 WHERE turn_id = 'edited'");
    await repo.softDeleteMessage(tenant, "identity");
    expect(await history()).toEqual([]);
    await repo.restoreMessage(tenant, "identity");
    await repo.createMessage(tenant, { id: "assistant_edited", sessionId: "session", role: "assistant" });
    await repo.softDeleteMessage(tenant, "assistant_edited");
    expect(await history()).toEqual([]);
  });

  it("物理删除用户版本后不从助手事件恢复该轮信息", async () => {
    await seed("deleted");
    await seed("current");
    await repo.deleteMessage(tenant, "user_deleted");
    expect(await history()).toEqual([]);
  });

  it("不带入工具结果、思考过程和旧 Attempt 的文本", async () => {
    await seed("safe");
    await seed("current");
    await database.client.execute("UPDATE turn_stream_events SET sequence = sequence + 10 WHERE turn_id = 'safe'");
    await repo.appendStreamEvent(tenant, {
      id: "old_delta", turnId: "safe", sequence: 1, eventType: "delta", attemptId: "old",
      safetyDecision: "approved", data: { messageId: "assistant_safe", text: "old_attempt_secret" },
    });
    await repo.appendStreamEvent(tenant, {
      id: "tool", turnId: "safe", sequence: 2, eventType: "tool_result",
      data: { output: "tool_secret" },
    });
    await repo.appendStreamEvent(tenant, {
      id: "reasoning", turnId: "safe", sequence: 3, eventType: "reasoning_delta",
      data: { text: "reasoning_secret" },
    });
    expect(await history()).toEqual([
      { role: "user", content: "question_safe" }, { role: "assistant", content: "answer_safe" },
    ]);
  });

  it("最多保留最近 20 轮", async () => {
    for (let index = 0; index < 22; index += 1) await seed(`turn_${index}`);
    await seed("current");
    const result = await history();
    expect(result).toHaveLength(40);
    expect(result[0]?.content).toBe("question_turn_2");
    expect(result.at(-1)?.content).toBe("answer_turn_21");
  });

  it("32000 字符预算按完整轮裁剪，优先保留近期对话", async () => {
    await seed("large", { user: "x".repeat(32_000) });
    await seed("recent");
    await seed("current");
    expect(await history()).toEqual([
      { role: "user", content: "question_recent" }, { role: "assistant", content: "answer_recent" },
    ]);
  });
});
