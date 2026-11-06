import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, SqliteUserQuestionRepository,
  type AervoxDatabase, type LocalContext } from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { UserQuestionCoordinator } from "@aervox/host-runtime-test/modules/companion/conversation/user-question-coordinator";

const ctx: LocalContext = { workspaceId: "local", subjectUserId: "local" };
const questions = [{ id: "q1", question: "今天想复习什么？", multiSelect: false, options: [{ label: "数学" }, { label: "英语" }] }];
const answers = [{ id: "q1", selected: ["数学"] }];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitForQuestion(coordinator: UserQuestionCoordinator, turnId: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const pending = await coordinator.getPending(ctx, turnId);
    if (pending) return pending;
    await pause(10);
  }
  throw new Error("question did not commit");
}

describe("durable question commands and Host waiter", () => {
  let db: AervoxDatabase, client: Client, cleanup: () => Promise<void>;
  let repo: SqliteConversationRepository, coordinator: UserQuestionCoordinator;
  beforeEach(async () => {
    const resource = await createInMemoryDatabase();
    ({ db, client, cleanup } = resource);
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    coordinator = new UserQuestionCoordinator(repo);
  });
  afterEach(async () => { await cleanup(); });
  async function execution(turnId = "turn") {
    await repo.getOrCreateSession(ctx, "session");
    const attemptId = `attempt_${turnId}`;
    await repo.acceptTurn(ctx, { turnId, attemptId, sessionId: "session", idempotencyKey: turnId,
      message: { id: `user_${turnId}`, content: "Question source" }, consumeInbox: false });
    const claim = await repo.claimTurnAttempt(ctx, { turnId, attemptId, expectedFencingToken: 0, leaseId: `lease_${turnId}` });
    expect(claim.ok).toBe(true);
    const owner = { turnId, attemptId, expectedFencingToken: claim.fencingToken, leaseId: claim.leaseId };
    const request = { turnId, attemptId, invocationId: `${attemptId}:1:1`, step: 1, questions, timeoutMs: 60000 };
    return { owner, request, identity: { attemptId, invocationId: request.invocationId, step: 1 } };
  }

  it("commits original question identity and only wakes its waiter after answer commit", async () => {
    const { owner, request, identity } = await execution();
    const ask = coordinator.createPort(ctx, owner).ask(request);
    const pending = await waitForQuestion(coordinator, "turn");
    expect(pending).toMatchObject({ ...identity, identityStatus: "available" });
    const receipt = await coordinator.submitAnswers(ctx, "turn", answers, identity);
    expect(receipt).toMatchObject({ ...identity, accepted: true, answers });
    await expect(ask).resolves.toEqual({ answers });
    expect(await coordinator.getPending(ctx, "turn")).toBeUndefined();
    expect((await repo.getStreamEvents(ctx, "turn")).map(event => event.eventType)).toEqual(["user_question_required", "user_question_answered"]);
  });

  it("independent coordinators query and answer the same durable question, and exact retries return its receipt", async () => {
    const { owner, request, identity } = await execution();
    const ask = coordinator.createPort(ctx, owner).ask(request);
    await waitForQuestion(coordinator, "turn");
    const reopened = new UserQuestionCoordinator(repo);
    expect(await reopened.getPending(ctx, "turn")).toMatchObject(identity);
    const first = await reopened.submitAnswers(ctx, "turn", answers, identity);
    await expect(ask).resolves.toEqual({ answers });
    expect(await reopened.submitAnswers(ctx, "turn", answers, identity)).toEqual(first);
    await expect(reopened.submitAnswers(ctx, "turn", [{ id: "q1", selected: ["英语"] }], identity)).rejects.toThrow("QUESTION_ANSWER_CONFLICT");
    expect((await repo.getStreamEvents(ctx, "turn")).filter(event => event.eventType === "user_question_answered")).toHaveLength(1);
  });

  it("keeps a failed answer transaction pending and retryable without settling the loop", async () => {
    const { owner, request, identity } = await execution();
    let settled = false;
    const ask = coordinator.createPort(ctx, owner).ask(request).then(result => { settled = true; return result; });
    await waitForQuestion(coordinator, "turn");
    await client.execute("CREATE TRIGGER fail_answer BEFORE DELETE ON pending_user_questions BEGIN SELECT RAISE(ABORT, 'answer failed'); END");
    await expect(coordinator.submitAnswers(ctx, "turn", answers, identity)).rejects.toThrow("Database query failed");
    expect(settled).toBe(false);
    expect(await coordinator.getPending(ctx, "turn")).toBeDefined();
    await client.execute("DROP TRIGGER fail_answer");
    await coordinator.submitAnswers(ctx, "turn", answers, identity);
    await expect(ask).resolves.toEqual({ answers });
  });

  it("observes an answer committed between the receipt read and pending read instead of rejecting the owner", async () => {
    const { owner, request, identity } = await execution();
    const readPending = repo.getPendingUserQuestion.bind(repo);
    let armed = true;
    vi.spyOn(repo, "getPendingUserQuestion").mockImplementation(async (context, turnId) => {
      if (armed) { armed = false; await repo.answerUserQuestion(ctx, { turnId, ...identity }, answers); }
      return readPending(context, turnId);
    });
    const ask = coordinator.createPort(ctx, owner).ask(request);
    await expect(ask).resolves.toEqual({ answers });
    expect((await repo.getStreamEvents(ctx, "turn")).filter(event => event.eventType === "user_question_answered")).toHaveLength(1);
  });

  it("abort removes only the original pending question and never registers an answer", async () => {
    const { owner, request } = await execution();
    const signal = new AbortController();
    const ask = coordinator.createPort(ctx, owner).ask({ ...request, signal: signal.signal });
    ask.catch(() => undefined);
    await waitForQuestion(coordinator, "turn");
    signal.abort();
    await expect(ask).rejects.toThrow("QUESTION_CANCELLED");
    expect(await coordinator.getPending(ctx, "turn")).toBeUndefined();
    expect((await repo.getStreamEvents(ctx, "turn")).filter(event => event.eventType === "user_question_answered")).toHaveLength(0);
  });

  it("times out without choosing options or converting expiry into human authorization", async () => {
    const { owner, request, identity } = await execution();
    const ask = coordinator.createPort(ctx, owner).ask({ ...request, timeoutMs: 120 });
    ask.catch(() => undefined);
    await expect(ask).rejects.toThrow(/QUESTION_TIMEOUT|QUESTION_CLOSED/);
    expect(await coordinator.getPending(ctx, "turn")).toBeUndefined();
    await expect(new UserQuestionCoordinator(repo).submitAnswers(ctx, "turn", answers, identity)).rejects.toThrow("QUESTION_NOT_PENDING");
    expect((await repo.getStreamEvents(ctx, "turn")).filter(event => event.eventType === "user_question_answered")).toHaveLength(0);
  });

  it("fails closed for missing execution proof and displays legacy NULL identity without inventing one", async () => {
    const { request } = await execution();
    await expect(coordinator.createPort(ctx).ask(request)).rejects.toThrow("QUESTION_EXECUTION_IDENTITY_REQUIRED");
    const legacy = new SqliteUserQuestionRepository(db);
    await legacy.upsertPending(ctx, { ...request, invocationId: null,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() });
    expect(await coordinator.getPending(ctx, "turn")).toMatchObject({ invocationId: null, identityStatus: "identity_unavailable" });
    await expect(coordinator.submitAnswers(ctx, "turn", answers)).rejects.toThrow("QUESTION_IDENTITY_UNAVAILABLE");
    expect(await legacy.getPending(ctx, "turn")).toMatchObject({ invocationId: null });
  });
});
