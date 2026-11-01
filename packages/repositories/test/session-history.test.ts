import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema } from "../src/index.js";
import { SqliteConversationRepository } from "../src/repositories/sqlite/conversation-repository.js";
import { createInjectedDatabase } from "../src/database.js";
import { readSessionHistory } from "../src/repositories/sqlite/session-history.js";
import { nativeSqliteBoundary } from "./helpers/native-sqlite-boundary.js";

const ctx = { workspaceId: "ws_history", subjectUserId: "usr_history" };

describe("安全会话历史读取", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(ctx, "session");
  });
  afterEach(async () => { await database.cleanup(); });

  async function seed(id: string, options: {
    sessionId?: string; status?: string; key?: string; user?: string; assistant?: string;
  } = {}) {
    await repo.createTurnWithOutbox(ctx, {
      id, sessionId: options.sessionId ?? "session",
      idempotencyKey: options.key ?? id, status: options.status ?? "Completed",
    }, { id: `user_${id}`, content: options.user ?? `question_${id}` });
    for (const [index, event] of [
      { eventType: "delta", data: { messageId: `assistant_${id}`, text: options.assistant ?? `answer_${id}` } },
      { eventType: "done", data: { messageId: `assistant_${id}`, status: "Completed", isComplete: true } },
    ].entries()) {
      await repo.appendStreamEvent(ctx, {
        id: `event_${id}_${index}`, turnId: id, sequence: index + 1,
        ...event, attemptId: `attempt_${id}`, safetyDecision: "approved",
      });
    }
  }
  const history = () => repo.getSessionHistory(ctx, { sessionId: "session", beforeTurnId: "current" });

  it("按插入顺序读取，排除当前/未来轮、其他会话和子任务", async () => {
    await seed("z_first");
    await seed("a_second");
    await repo.getOrCreateSession(ctx, "other");
    await seed("other", { sessionId: "other" });
    await seed("child", { key: "subagent:parent:1" });
    await seed("current");
    await seed("future");
    await database.client.execute("UPDATE turns SET created_at = '2026-09-07T00:00:00.000Z'");
    expect(await history()).toEqual([
      { role: "user", content: "question_z_first" }, { role: "assistant", content: "answer_z_first" },
      { role: "user", content: "question_a_second" }, { role: "assistant", content: "answer_a_second" },
    ]);
    expect(await repo.getSessionHistory(
      { ...ctx, subjectUserId: "another" }, { sessionId: "session", beforeTurnId: "current" },
    )).toEqual(await history());
    expect(await repo.getSessionHistory(
      { ...ctx, workspaceId: "another" }, { sessionId: "session", beforeTurnId: "current" },
    )).toEqual(await history());
    expect(await repo.getSessionHistory(ctx, { sessionId: "other", beforeTurnId: "current" })).toEqual([]);
    expect(await repo.getSessionHistory(ctx, { sessionId: "session", beforeTurnId: "child" })).toEqual([]);
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
    await repo.appendStreamEvent(ctx, { id: "withdraw", turnId: "withdrawn", sequence: 3, eventType: "redacted", data: {} });
    expect(await history()).toEqual([
      { role: "user", content: "question_valid" }, { role: "assistant", content: "answer_valid" },
    ]);
  });

  it("使用最新用户版本，软删除用户或助手后整轮不召回，也不退回旧版本", async () => {
    await seed("edited");
    await seed("current");
    await repo.createMessage(ctx, { id: "identity", sessionId: "session", role: "user" });
    await database.client.execute("UPDATE message_versions SET message_id = 'identity' WHERE turn_id = 'edited'");
    await repo.editMessage(ctx, "identity", "我现在叫小李", 1);
    expect((await history())[0]?.content).toBe("我现在叫小李");
    await database.client.execute("UPDATE message_versions SET is_redacted = 1 WHERE turn_id = 'edited' AND version = 2");
    expect(await history()).toEqual([]);
    await database.client.execute("UPDATE message_versions SET is_redacted = 0 WHERE turn_id = 'edited'");
    await repo.softDeleteMessage(ctx, "identity");
    expect(await history()).toEqual([]);
    await repo.restoreMessage(ctx, "identity");
    await repo.createMessage(ctx, { id: "assistant_edited", sessionId: "session", role: "assistant" });
    await repo.softDeleteMessage(ctx, "assistant_edited");
    expect(await history()).toEqual([]);
  });

  it("物理删除用户版本后不从助手事件恢复该轮信息", async () => {
    await seed("deleted");
    await seed("current");
    await repo.deleteMessage(ctx, "user_deleted");
    expect(await history()).toEqual([]);
  });

  it("不带入工具结果、思考过程和旧 Attempt 的文本", async () => {
    await seed("safe");
    await seed("current");
    await database.client.execute("UPDATE turn_stream_events SET sequence = sequence + 10 WHERE turn_id = 'safe'");
    await repo.appendStreamEvent(ctx, {
      id: "old_delta", turnId: "safe", sequence: 1, eventType: "delta", attemptId: "old",
      safetyDecision: "approved", data: { messageId: "assistant_safe", text: "old_attempt_secret" },
    });
    await repo.appendStreamEvent(ctx, {
      id: "tool", turnId: "safe", sequence: 2, eventType: "tool_result",
      data: { output: "tool_secret" },
    });
    await repo.appendStreamEvent(ctx, {
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
  async function accepted(id = "durable", sessionId = "session", user = "persistent question", assistant = "persistent answer") {
    const messageId = `assistant_${id}`;
    await repo.acceptTurn(ctx, { turnId: id, sessionId, idempotencyKey: id, attemptId: `attempt_${id}`,
      message: { id: `user_${id}`, content: user }, consumeInbox: false });
    await repo.appendStreamEvent(ctx, { id: `message_${id}`, turnId: id, attemptId: `attempt_${id}`, expectedFencingToken: 0,
      sequence: 1, eventType: "message", safetyDecision: "approved", data: { messageId, role: "assistant" } });
    await repo.recordSafeSegmentAtomically(ctx, { turnId: id, attemptId: `attempt_${id}`, expectedFencingToken: 0,
      sequence: 2, text: assistant, eventData: { messageId, text: assistant }, safetyDecision: "approved" });
    await repo.finalizeAttemptWithEventAtomically(ctx, { turnId: id, attemptId: `attempt_${id}`, expectedFencingToken: 0,
      sequence: 3, status: "Completed", eventType: "done", eventData: { messageId, status: "Completed", isComplete: true }, safetyDecision: "approved" });
    return messageId;
  }

  async function manyReplayEvents(turnId = "durable") {
    await database.client.batch(Array.from({ length: 600 }, (_, index) => ({
      sql: "INSERT INTO turn_stream_events(id,turn_id,sequence,event_type,data,occurred_at,attempt_id,safety_decision) VALUES (?,?,?,?,?,?,?,?)",
      args: [`bulk_${turnId}_${index}`, turnId, index + 4, "delta", JSON.stringify({ messageId: `assistant_${turnId}`, text: "raw replay body" }), "now", `attempt_${turnId}`, "approved"],
    })), "write");
  }

  function boundedHistory() {
    return readSessionHistory(createInjectedDatabase(nativeSqliteBoundary(database.client).client), ctx, { sessionId: "session", beforeTurnId: "current" });
  }

  it("reads model context across twenty individually legal wide Turns within one native cursor window", async () => {
    // Each Turn obeys native's input and escaped response budgets; copying all
    // twenty current-version bodies before pruning exceeds the native window.
    for (let index = 0; index < 19; index += 1) await accepted(`wide_${index}`, "session", "u".repeat(32_000), "\0".repeat(8_000));
    const assistantId = await accepted("recent", "session", "recent question", "original answer");
    const identity = await repo.getMessage(ctx, assistantId);
    const version = (await repo.listMessageVersions(ctx, assistantId)).find(row => row.id === identity!.currentVersionId)!;
    await repo.editMessage(ctx, assistantId, "corrected recent answer", version.version);
    await seed("current");
    const boundary = nativeSqliteBoundary(database.client);
    const read = () => readSessionHistory(createInjectedDatabase(boundary.client), ctx, { sessionId: "session", beforeTurnId: "current" });
    expect(await read()).toEqual([
      { role: "user", content: "recent question" }, { role: "assistant", content: "corrected recent answer" },
    ]);
    expect(boundary.measurements.largestWindowBytes).toBeLessThan(128 * 1024);
    await repo.editMessage(ctx, "user_recent", "u".repeat(32_000), 1);
    expect(await read()).toEqual([]);
  });

  it("reads durable bodies beyond the native replay row limit while preserving mixed legacy history", async () => {
    await accepted(); await manyReplayEvents(); await seed("legacy"); await seed("current");
    expect(await boundedHistory()).toEqual([
      { role: "user", content: "persistent question" }, { role: "assistant", content: "persistent answer" },
      { role: "user", content: "question_legacy" }, { role: "assistant", content: "answer_legacy" },
    ]);
  });

  it.each([
    ["message", "blocked"], ["delta", "redacted"], ["done", "blocked"], ["redacted", "approved"],
  ])("keeps the durable withdrawal gate for %s/%s after more than 512 replay rows", async (eventType, safetyDecision) => {
    await accepted(); await manyReplayEvents(); await seed("current");
    await repo.appendStreamEvent(ctx, { id: "withdrawal", turnId: "durable", sequence: 604,
      eventType, safetyDecision, data: {} });
    expect(await boundedHistory()).toEqual([]);
  });

  it("never uses the bounded durable projection after its input identity is withdrawn", async () => {
    await accepted(); await manyReplayEvents(); await seed("current");
    await repo.softDeleteMessage(ctx, "user_durable");
    expect(await boundedHistory()).toEqual([]);
  });

  it("uses the current durable assistant version after online events and safe segments are cleaned", async () => {
    const messageId = await accepted();
    const identity = await repo.getMessage(ctx, messageId);
    const version = (await repo.listMessageVersions(ctx, messageId)).find(row => row.id === identity?.currentVersionId)!;
    await repo.editMessage(ctx, messageId, "user corrected durable answer", version.version);
    await database.client.execute("DELETE FROM turn_stream_events WHERE turn_id = 'durable'");
    await database.client.execute("DELETE FROM safe_segments WHERE turn_id = 'durable'");
    await seed("current");
    expect(await history()).toEqual([
      { role: "user", content: "persistent question" }, { role: "assistant", content: "user corrected durable answer" },
    ]);
  });

  it("keeps assistant identities in creation order after editing the older assistant", async () => {
    const firstId = await accepted();
    const secondId = "second_assistant";
    await repo.createTurnAttempt(ctx, "durable", { id: "continuation", attempt: 2 });
    await repo.appendStreamEvent(ctx, { id: "second_message", turnId: "durable", attemptId: "continuation", expectedFencingToken: 0,
      sequence: 4, eventType: "message", safetyDecision: "approved", data: { messageId: secondId, role: "assistant" } });
    await repo.recordSafeSegmentAtomically(ctx, { turnId: "durable", attemptId: "continuation", expectedFencingToken: 0,
      sequence: 5, text: "second answer", eventData: { messageId: secondId, text: "second answer" }, safetyDecision: "approved" });
    await repo.finalizeAttemptWithEventAtomically(ctx, { turnId: "durable", attemptId: "continuation", expectedFencingToken: 0,
      sequence: 6, status: "Completed", eventType: "done", eventData: { status: "Completed", isComplete: true }, safetyDecision: "approved" });
    const first = await repo.getMessage(ctx, firstId);
    const version = (await repo.listMessageVersions(ctx, firstId)).find(row => row.id === first!.currentVersionId)!;
    await repo.editMessage(ctx, firstId, "corrected first answer", version.version);
    await seed("current");
    expect(await boundedHistory()).toEqual([
      { role: "user", content: "persistent question" },
      { role: "assistant", content: "corrected first answer" }, { role: "assistant", content: "second answer" },
    ]);
  });

  it("does not recover a linked assistant from events after its current version is redacted or missing", async () => {
    const messageId = await accepted(); await seed("current");
    const identity = await repo.getMessage(ctx, messageId);
    await database.client.execute({ sql: "UPDATE message_versions SET is_redacted = 1 WHERE id = ?", args: [identity!.currentVersionId!] });
    expect(await history()).toEqual([]);
    await database.client.execute({ sql: "DELETE FROM message_versions WHERE id = ?", args: [identity!.currentVersionId!] });
    expect(await history()).toEqual([]);
  });

  it("does not fall back to an edited user version after its original accepted input is physically removed", async () => {
    await accepted(); await repo.editMessage(ctx, "user_durable", "later version", 1); await seed("current");
    await repo.deleteMessage(ctx, "user_durable");
    expect(await history()).toEqual([]);
  });

  it("retains NUL-bearing session, turn and message identities and content in model history", async () => {
    const sessionId = "session\0tail";
    await repo.getOrCreateSession(ctx, sessionId);
    await accepted("durable\0tail", sessionId, "question\0tail", "answer\0tail");
    await repo.acceptTurn(ctx, { turnId: "current\0tail", sessionId, idempotencyKey: "current\0tail", attemptId: "next-attempt",
      message: { id: "next-user", content: "continue" }, consumeInbox: false });
    await database.client.execute("DELETE FROM turn_stream_events"); await database.client.execute("DELETE FROM safe_segments");
    expect(await repo.getSessionHistory(ctx, { sessionId, beforeTurnId: "current\0tail" })).toEqual([
      { role: "user", content: "question\0tail" }, { role: "assistant", content: "answer\0tail" },
    ]);
    expect(await repo.getSessionHistory(ctx, { sessionId: "session", beforeTurnId: "current\0tail" })).toEqual([]);
  });

});
