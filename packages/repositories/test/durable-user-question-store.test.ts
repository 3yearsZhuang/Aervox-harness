import { afterEach, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, SqliteUserQuestionRepository } from "../src/index.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
const identity = { turnId: "turn", attemptId: "attempt", invocationId: "attempt:1:1", step: 1 };
const questions = [{ id: "choice", question: "Choose?", options: [{ label: "A" }, { label: "B" }] }];
const answer = [{ id: "choice", selected: ["A"] }];
const clients: Client[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
async function fixture() {
  const { db, client } = await createInMemoryDatabase(); clients.push(client);
  await initDatabaseSchema(client);
  const repo = new SqliteConversationRepository(db);
  await repo.getOrCreateSession(ctx, "session");
  await repo.acceptTurn(ctx, { turnId: "turn", sessionId: "session", idempotencyKey: "key", attemptId: "attempt",
    message: { id: "user", content: "Question source" }, consumeInbox: false });
  const claim = await repo.claimTurnAttempt(ctx, { turnId: "turn", attemptId: "attempt", expectedFencingToken: 0, leaseId: "lease" });
  expect(claim.ok).toBe(true);
  const request = { ...identity, expectedFencingToken: claim.fencingToken, leaseId: claim.leaseId, questions, timeoutMs: 60000 };
  return { db, client, repo, request };
}

it("rolls back the required event when pending registration fails, then returns the original committed question on retry", async () => {
  const { client, repo, request } = await fixture();
  await client.execute("CREATE TRIGGER fail_pending BEFORE INSERT ON pending_user_questions BEGIN SELECT RAISE(ABORT, 'injected registration failure'); END");
  await expect(repo.requireUserQuestion(ctx, request)).rejects.toMatchObject({ cause: { message: expect.stringContaining("injected registration failure") } });
  expect(await repo.getStreamEvents(ctx, "turn")).toEqual([]);
  expect(await repo.getPendingUserQuestion(ctx, "turn")).toBeNull();
  await client.execute("DROP TRIGGER fail_pending");
  const first = await repo.requireUserQuestion(ctx, request);
  const retry = await repo.requireUserQuestion(ctx, request);
  expect(retry).toEqual(first);
  expect(first.event).toMatchObject({ attemptId: "attempt", data: { invocationId: identity.invocationId, step: 1 } });
  expect((await repo.getStreamEvents(ctx, "turn")).length).toBe(1);
});

it("keeps the waiter truth pending if answer commit fails; identical retries return the stored answer and different answers conflict", async () => {
  const { client, repo, request } = await fixture();
  await repo.requireUserQuestion(ctx, request);
  await client.execute("CREATE TRIGGER fail_cleanup BEFORE DELETE ON pending_user_questions BEGIN SELECT RAISE(ABORT, 'injected answer failure'); END");
  await expect(repo.answerUserQuestion(ctx, identity, answer)).rejects.toMatchObject({ cause: { message: expect.stringContaining("injected answer failure") } });
  expect(await repo.getPendingUserQuestion(ctx, "turn")).not.toBeNull();
  expect(await repo.getUserQuestionAnswerReceipt(ctx, identity)).toBeNull();
  expect((await repo.getStreamEvents(ctx, "turn")).map(event => event.eventType)).toEqual(["user_question_required"]);
  await client.execute("DROP TRIGGER fail_cleanup");
  const first = await repo.answerUserQuestion(ctx, identity, answer);
  expect(await repo.answerUserQuestion(ctx, identity, answer)).toEqual(first);
  expect(await repo.requireUserQuestion(ctx, request)).toMatchObject({ pending: null, receipt: first });
  await expect(repo.answerUserQuestion(ctx, identity, [{ id: "choice", selected: ["B"] }])).rejects.toThrow("QUESTION_ANSWER_CONFLICT");
  expect((await repo.getStreamEvents(ctx, "turn")).length).toBe(2);
});

it("binds answer and cleanup to the original invocation even when later questions reuse the same Turn and step", async () => {
  const { repo, request } = await fixture();
  await repo.requireUserQuestion(ctx, request);
  await expect(repo.requireUserQuestion(ctx, { ...request, invocationId: "attempt:1:2" })).rejects.toThrow("QUESTION_PENDING");
  await repo.answerUserQuestion(ctx, identity, answer);
  const next = { ...request, invocationId: "attempt:1:2" };
  await repo.requireUserQuestion(ctx, next);
  expect(await repo.cancelUserQuestion(ctx, { ...identity, reason: "cancelled" })).toBe(false);
  expect(await repo.getPendingUserQuestion(ctx, "turn")).toMatchObject({ invocationId: next.invocationId });
  expect(await repo.answerUserQuestion(ctx, identity, answer)).toMatchObject({ invocationId: identity.invocationId });
  expect(await repo.getPendingUserQuestion(ctx, "turn")).toMatchObject({ invocationId: next.invocationId });
  await expect(repo.answerUserQuestion(ctx, { ...identity, invocationId: next.invocationId }, [{ id: "wrong", selected: ["A"] }])).rejects.toThrow("QUESTION_ANSWER_INVALID");
});

it("rejects missing legacy identity without backfill, and permits explicit identity-matched cancellation", async () => {
  const { db, repo } = await fixture();
  const legacy = new SqliteUserQuestionRepository(db);
  await legacy.upsertPending(ctx, { turnId: "turn", attemptId: "attempt", step: 1, questions,
    timeoutMs: 60000, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() });
  expect(await repo.getPendingUserQuestion(ctx, "turn")).toMatchObject({ invocationId: null, identityStatus: "identity_unavailable" });
  await expect(repo.answerUserQuestion(ctx, identity, answer)).rejects.toThrow("QUESTION_IDENTITY_UNAVAILABLE");
  expect(await legacy.getPending(ctx, "turn")).toMatchObject({ invocationId: null });
  expect(await repo.cancelUserQuestion(ctx, { ...identity, invocationId: null, reason: "cancelled" })).toBe(true);
});

it("checks the original lease and fencing proof and source/deletion gates at the write, and hides revoked reads", async () => {
  const { client, repo, request } = await fixture();
  await expect(repo.requireUserQuestion(ctx, { ...request, expectedFencingToken: request.expectedFencingToken + 1 })).rejects.toThrow("question_execution_expired");
  await expect(repo.requireUserQuestion(ctx, { ...request, leaseId: "replacement" })).rejects.toThrow("question_execution_expired");
  await repo.requireUserQuestion(ctx, request);
  await repo.deleteMessage(ctx, "user");
  expect(await repo.getPendingUserQuestion(ctx, "turn")).toBeNull();
  await expect(repo.answerUserQuestion(ctx, identity, answer)).rejects.toThrow("conversation_source_unavailable");
  expect(await repo.getUserQuestionAnswerReceipt(ctx, identity)).toBeNull();
  expect((await client.execute("SELECT count(*) AS count FROM pending_user_questions")).rows[0]!.count).toBe(1);
});

it("rejects expired answers and cleans only the matching expired question", async () => {
  const { client, repo, request } = await fixture();
  await repo.requireUserQuestion(ctx, request);
  expect(await repo.cancelUserQuestion(ctx, { ...identity, reason: "expired" })).toBe(false);
  await client.execute("UPDATE pending_user_questions SET expires_at='2000-01-01T00:00:00.000Z'");
  expect(await repo.getPendingUserQuestion(ctx, "turn")).toBeNull();
  await expect(repo.answerUserQuestion(ctx, identity, answer)).rejects.toThrow("QUESTION_EXPIRED");
  expect(await repo.cancelUserQuestion(ctx, { ...identity, invocationId: "new", reason: "expired" })).toBe(false);
  expect(await repo.cancelUserQuestion(ctx, { ...identity, reason: "expired" })).toBe(true);
  await expect(repo.requireUserQuestion(ctx, request)).rejects.toThrow("QUESTION_CLOSED");
});

it.each(["CancelRequested", "Cancelled"] as const)("rejects a new answer after user cancellation reaches %s", async status => {
  const { client, repo, request } = await fixture();
  await repo.requireUserQuestion(ctx, request);
  expect(await repo.requestCancelTurnAttempt(ctx, identity)).toEqual({ ok: true });
  if (status === "Cancelled") {
    await repo.finalizeTurnAttempt(ctx, { ...identity, status, expectedFencingToken: request.expectedFencingToken });
  }
  expect(await repo.getTurnAttemptStatus(ctx, identity)).toBe(status);
  expect(await repo.getPendingUserQuestion(ctx, "turn")).toBeNull();
  await expect(repo.answerUserQuestion(ctx, identity, answer)).rejects.toThrow("QUESTION_CANCELLED");
  expect(await repo.getUserQuestionAnswerReceipt(ctx, identity)).toBeNull();
  expect((await repo.getStreamEvents(ctx, "turn")).map(event => event.eventType)).toEqual(["user_question_required"]);
  expect((await client.execute("SELECT count(*) AS count FROM pending_user_questions")).rows[0]!.count).toBe(1);
});

it("returns an already committed answer after cancellation, and allows original answer registration after process interruption", async () => {
  const first = await fixture();
  await first.repo.requireUserQuestion(ctx, first.request);
  const receipt = await first.repo.answerUserQuestion(ctx, identity, answer);
  await first.repo.requestCancelTurnAttempt(ctx, identity);
  expect(await first.repo.answerUserQuestion(ctx, identity, answer)).toEqual(receipt);
  await expect(first.repo.answerUserQuestion(ctx, identity, [{ id: "choice", selected: ["B"] }])).rejects.toThrow("QUESTION_ANSWER_CONFLICT");

  const reopened = await fixture();
  await reopened.repo.requireUserQuestion(ctx, reopened.request);
  await reopened.repo.finalizeTurnAttempt(ctx, { ...identity, status: "Interrupted", expectedFencingToken: reopened.request.expectedFencingToken });
  expect(await reopened.repo.answerUserQuestion(ctx, identity, answer)).toMatchObject({ accepted: true, ...identity });
  expect(await reopened.repo.getTurnAttemptStatus(ctx, identity)).toBe("Interrupted");
  expect((await reopened.repo.listTurnAttempts(ctx, "turn")).length).toBe(1);
});

it.each([false, true])("blocks question writes and disclosure during deletion propagation (answered=%s)", async answered => {
  const { client, repo, request } = await fixture();
  await repo.requireUserQuestion(ctx, request);
  if (answered) await repo.answerUserQuestion(ctx, identity, answer);
  const now = new Date().toISOString();
  await client.execute({ sql: "INSERT INTO deletion_requests(id,scope,idempotency_key,requested_at,status,owner_module,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    args: ["deletion", "source", "deletion", now, "pending", "privacy", now, now] });
  expect(await repo.getPendingUserQuestion(ctx, "turn")).toBeNull();
  expect(await repo.getUserQuestionAnswerReceipt(ctx, identity)).toBeNull();
  await expect(repo.requireUserQuestion(ctx, request)).rejects.toThrow("deletion_blocked");
  await expect(repo.answerUserQuestion(ctx, identity, answer)).rejects.toThrow("deletion_blocked");
  expect((await client.execute("SELECT count(*) AS count FROM pending_user_questions")).rows[0]!.count).toBe(answered ? 0 : 1);
});
