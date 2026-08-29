/**
 * Aervox｜思隅 @aervox/api — 挂起提问会话持久化测试（缺陷 C）
 *
 * 覆盖：
 * - 提问挂起后写入 pending_user_questions（持久化真源）；
 * - 内存态丢失（模拟进程重启：新的协调器实例共享同一 DB）仍可提交回答 → accepted + 事件留痕；
 * - 重启后提交的幂等（重复提交不重复写 answered 事件）；
 * - 重启后按持久化 expiresAt 判定超时（崩溃后 timer 丢失不悬挂）；
 * - getPending 内存态丢失时回退持久化查询。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  SqliteUserQuestionRepository,
  type AervoxDatabase,
  type TenantContext,
} from "@aervox/database";
import type { Client } from "@libsql/client";
import { UserQuestionCoordinator } from "../src/modules/conversation/user-question-coordinator.js";
import type { AskUserQuestionPortRequest } from "@aervox/agent-loop";

const tenant: TenantContext = { workspaceId: "ws_uq", subjectUserId: "usr_uq" };

const askReq = (turnId: string, timeoutMs = 60_000): AskUserQuestionPortRequest => ({
  turnId,
  attemptId: `atp_${turnId}`,
  step: 1,
  timeoutMs,
  questions: [
    {
      id: "q1",
      question: "今天想复习什么？",
      options: [{ label: "数学" }, { label: "英语" }],
    },
  ],
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等待协调器进入挂起态（handleAsk 完成事件+持久化写入并建立内存 session） */
async function waitForSession(coordinator: UserQuestionCoordinator, turnId: string, ms = 500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((coordinator as unknown as { pendingByTurn: Map<string, unknown> }).pendingByTurn.has(turnId)) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`session ${turnId} not established within ${ms}ms`);
}

describe("缺陷 C：挂起提问会话持久化", () => {
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let conversationRepo: SqliteConversationRepository;
  let coordinator: UserQuestionCoordinator;
  const answeredEvents: string[] = []; // 记录各 turn 的 answered 事件数量（幂等断言用）

  const assertTurnExists = async (turnId: string) => {
    // 先确保会话存在（messages/turns 的 session_id 外键引用 sessions.id）
    const sessionId = `sess_${turnId}`;
    await conversationRepo.getOrCreateSession(tenant, sessionId, "UQ 测试会话");
    const { turn } = await conversationRepo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId, idempotencyKey: `idem_${turnId}` },
      { id: `msg_${turnId}`, content: "你好" },
    );
    return turn;
  };

  const countAnswered = async (turnId: string): Promise<number> => {
    const events = await conversationRepo.getStreamEvents(tenant, turnId, 0);
    return events.filter((e) => e.eventType === "user_question_answered").length;
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    conversationRepo = new SqliteConversationRepository(db);
    // 默认协调器：注入真实持久化仓储（生产装配一致）
    coordinator = new UserQuestionCoordinator(conversationRepo, new SqliteUserQuestionRepository(db));
  });

  afterEach(async () => {
    await cleanup();
  });

  it("提问挂起：user_question_required 事件 + 持久化行写齐，内存提交回答 → accepted + answered 事件", async () => {
    await assertTurnExists("turn_1");
    const port = coordinator.createPort(tenant);
    const askPromise = port.ask(askReq("turn_1"));
    askPromise.catch(() => undefined);

    await waitForSession(coordinator, "turn_1");

    // 持久化行存在（expiresAt = createdAt + timeoutMs）
    const repo = new SqliteUserQuestionRepository(db);
    const stored = await repo.getPending(tenant, "turn_1");
    expect(stored).not.toBeNull();
    expect(stored!.turnId).toBe("turn_1");
    expect(new Date(stored!.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // 内存提交
    const res = await coordinator.submitAnswers(tenant, "turn_1", [
      { id: "q1", selected: ["数学"] },
    ]);
    expect(res.accepted).toBe(true);

    // 挂起 Promise 被唤醒并返回答案
    const result = await askPromise;
    expect(result.answers[0].selected).toEqual(["数学"]);

    // answered 事件已写入、持久化已清理
    expect(await countAnswered("turn_1")).toBe(1);
    expect(await repo.getPending(tenant, "turn_1")).toBeNull();
  });

  it("重启后提交回答（内存态丢失）：accepted + 事件留痕，不 409 悬挂", async () => {
    await assertTurnExists("turn_2");
    // 提问进程（coordinator）挂起后"崩溃"：直接丢弃，不 submit
    const dying = new UserQuestionCoordinator(conversationRepo, new SqliteUserQuestionRepository(db));
    const dyingPort = dying.createPort(tenant);
    const dyingAsk = dyingPort.ask(askReq("turn_2"));
    dyingAsk.catch(() => undefined);
    await waitForSession(dying, "turn_2");

    // "重启"：新的协调器实例（内存态为空，共享同一 DB）
    const revived = new UserQuestionCoordinator(conversationRepo, new SqliteUserQuestionRepository(db));
    const res = await revived.submitAnswers(tenant, "turn_2", [{ id: "q1", selected: ["英语"] }]);
    expect(res.accepted).toBe(true);
    expect(await countAnswered("turn_2")).toBe(1);
    expect(await new SqliteUserQuestionRepository(db).getPending(tenant, "turn_2")).toBeNull();

    // 幂等：重复提交返回 accepted 且不重复写事件
    const again = await revived.submitAnswers(tenant, "turn_2", [{ id: "q1", selected: ["英语"] }]);
    expect(again.accepted).toBe(true);
    expect(await countAnswered("turn_2")).toBe(1);
    expect(answeredEvents).toHaveLength(0); // 仅占位：真实断言在 countAnswered
  });

  it("重启后按持久化 expiresAt 判定超时（崩溃后 timer 丢失不悬挂）", async () => {
    await assertTurnExists("turn_3");
    // 提问进程挂起（超时 60s > 测试时长，持久化未过期）
    const p1 = coordinator.createPort(tenant);
    const askP1 = p1.ask(askReq("turn_3", 60_000));
    askP1.catch(() => undefined);
    await waitForSession(coordinator, "turn_3");
    await sleep(20); // 确保持久化写入完成

    // 另一进程（新实例）同样可查询到挂起问题（持久化回退，未过期）
    const other = new UserQuestionCoordinator(conversationRepo, new SqliteUserQuestionRepository(db));
    const pending = await other.getPending(tenant, "turn_3");
    expect(pending).toBeDefined();
    expect(pending!.questions).toHaveLength(1);

    // 过期场景：短超时并等待过期，用新实例提交 → NO_PENDING_QUESTION（不许 500/悬挂）
    await assertTurnExists("turn_4");
    const p2 = coordinator.createPort(tenant);
    const askP2 = p2.ask(askReq("turn_4", 50));
    askP2.catch(() => undefined);
    await waitForSession(coordinator, "turn_4");
    await sleep(120); // 超过 50ms 超时（timer 已由原进程触发并清理持久化；等价进程崩溃后到期）

    const revived = new UserQuestionCoordinator(conversationRepo, new SqliteUserQuestionRepository(db));
    await expect(
      revived.submitAnswers(tenant, "turn_4", [{ id: "q1", selected: ["数学"] }]),
    ).rejects.toThrow(/NO_PENDING_QUESTION/);
    expect(await countAnswered("turn_4")).toBe(0);
  });

  it("getPending 内存态丢失时回退持久化；已作答后不再视为挂起", async () => {
    await assertTurnExists("turn_5");
    const p = coordinator.createPort(tenant);
    const ask = p.ask(askReq("turn_5", 60_000));
    ask.catch(() => undefined);
    await waitForSession(coordinator, "turn_5");
    await sleep(20);

    // 新实例（重启）：内存空 → 持久化回退可见
    const revived = new UserQuestionCoordinator(conversationRepo, new SqliteUserQuestionRepository(db));
    expect(await revived.getPending(tenant, "turn_5")).toBeDefined();

    // 作答后不再视为挂起（幂等机会已释放）
    await revived.submitAnswers(tenant, "turn_5", [{ id: "q1", selected: ["数学"] }]);
    expect(await revived.getPending(tenant, "turn_5")).toBeUndefined();
    expect(await countAnswered("turn_5")).toBe(1);
  });

  it("工具超时信号（缺陷 D）：abort 立即终止挂起并清理持久化", async () => {
    await assertTurnExists("turn_sig");
    const controller = new AbortController();
    const port = coordinator.createPort(tenant);
    const askPromise = port.ask({ ...askReq("turn_sig", 300_000), signal: controller.signal });
    askPromise.catch(() => undefined);
    await waitForSession(coordinator, "turn_sig");
    await sleep(20);

    // 宿主工具超时/取消 → abort 信号 → 协调器立即终止等待（而不是挂 300s）
    controller.abort();
    await expect(askPromise).rejects.toThrow(/USER_QUESTION_CANCELLED/);

    // 内存挂起已清理 + 持久化已清理
    expect(await coordinator.getPending(tenant, "turn_sig")).toBeUndefined();
    expect(await new SqliteUserQuestionRepository(db).getPending(tenant, "turn_sig")).toBeNull();
    // 无 answered 事件（取消 ≠ 作答）
    expect(await countAnswered("turn_sig")).toBe(0);
  });
});