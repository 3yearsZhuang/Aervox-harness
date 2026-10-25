import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createInMemoryDatabase, SqliteConversationRepository, SqliteBotRepository,
  type ConversationExecutionPolicy,
} from "../src/index.js";

const local = { workspaceId: "local", subjectUserId: "local" };
let repo: SqliteConversationRepository;
let bots: SqliteBotRepository;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const database = await createInMemoryDatabase();
  cleanup = database.cleanup;
  repo = new SqliteConversationRepository(database.db);
  bots = new SqliteBotRepository(database.db);
});
afterEach(async () => cleanup());

async function accept(id: string, policy: ConversationExecutionPolicy = "bot-group-member-v1", key = id) {
  await repo.createSession(local, id, { id, executionPolicy: policy });
  await repo.acceptTurn(local, { turnId: `turn-${id}`, sessionId: id, idempotencyKey: key, attemptId: `attempt-${id}`,
    message: { id: `message-${id}`, content: id } });
}

it("only selects API-owned workbench turns, excluding the platform acceptance crash window", async () => {
  await accept("local", "local-v1");
  await accept("owner", "bot-owner-v1");
  await accept("group");
  await bots.createConnection({ id: "bot", adapterId: "fake", pluginId: "fake", displayName: "Fake", createdAt: new Date().toISOString() });
  await bots.enqueue({ id: "event", connectionId: "bot", sessionId: "platform", connectionRevision: 1, messageJson: "{}", createdAt: new Date().toISOString() });
  await accept("platform", "bot-group-member-v1", "bot:event");
  expect((await repo.listApiOwnedRecoveryTurns("2999-01-01T00:00:00.000Z")).map(turn => turn.sessionId).sort()).toEqual(["group", "owner"]);
  expect(await repo.listApiOwnedRecoveryTurns("2000-01-01T00:00:00.000Z")).toEqual([]);
});

it("mirrors terminal attempts without overwriting an already terminal turn", async () => {
  await accept("interrupted", "bot-owner-v1");
  await repo.finalizeTurnAttempt(local, { turnId: "turn-interrupted", attemptId: "attempt-interrupted", status: "Interrupted" });
  expect(await repo.synchronizeTurnWithLatestAttempt("turn-interrupted")).toMatchObject({ status: "Interrupted" });
  expect((await repo.getStreamEvents(local, "turn-interrupted")).map(event => event.eventType)).toEqual(["done"]);
  expect(await repo.synchronizeTurnWithLatestAttempt("turn-interrupted")).toBeNull();
  await repo.updateTurnStatus(local, "turn-interrupted", "Completed");
  expect(await repo.synchronizeTurnWithLatestAttempt("turn-interrupted")).toBeNull();
  expect((await repo.getTurn(local, "turn-interrupted"))?.status).toBe("Completed");
});

it.each(["claimed", "unclaimed", "terminal_gap"])("recovers cancelled platform work in the %s crash window even after its inbox is tombstoned", async (mode) => {
  await bots.createConnection({ id: "connection", adapterId: "fake", pluginId: "fake", displayName: "Fake", createdAt: new Date().toISOString() });
  await bots.enqueue({ id: "event", connectionId: "connection", sessionId: "cancelled", connectionRevision: 1,
    messageJson: "{}", createdAt: new Date().toISOString() });
  await accept("cancelled", "bot-group-member-v1", "bot:event");
  let fencingToken = 0;
  if (mode === "claimed") {
    const claim = await repo.claimTurnAttempt(local, { turnId: "turn-cancelled", attemptId: "attempt-cancelled", expectedFencingToken: 0, leaseId: "dead-host", ttlMs: -1000 });
    fencingToken = claim.fencingToken;
    await repo.reserveToolExecution(local, { turnId: "turn-cancelled", attemptId: "attempt-cancelled", invocationId: "write", name: "write" });
  }
  if (mode === "terminal_gap") {
    await repo.finalizeTurnAttempt(local, { turnId: "turn-cancelled", attemptId: "attempt-cancelled", status: "Cancelled" });
    await repo.updateTurnStatus(local, "turn-cancelled", "Cancelled");
  } else await repo.requestCancelTurnAttempt(local, { turnId: "turn-cancelled", attemptId: "attempt-cancelled" });
  await bots.updateInbox("event", { state: "cancelled" });
  if (mode === "unclaimed") {
    expect((await repo.getStreamEvents(local, "turn-cancelled")).map(event => event.eventType)).toEqual(["done"]);
    expect(await repo.listApiOwnedRecoveryTurns("2999-01-01T00:00:00.000Z")).toEqual([]);
    return;
  }
  expect((await repo.listApiOwnedRecoveryTurns("2999-01-01T00:00:00.000Z")).map(turn => turn.id)).toContain("turn-cancelled");
  if (mode === "terminal_gap") await repo.synchronizeTurnWithLatestAttempt("turn-cancelled");
  else expect(await repo.retireExpiredApiOwnedAttempt("turn-cancelled", "attempt-cancelled", fencingToken)).toBe(true);
  expect((await repo.listTurnAttempts(local, "turn-cancelled"))[0]).toMatchObject({ status: "Cancelled", fencingToken: mode === "terminal_gap" ? 0 : fencingToken + 1 });
  expect((await repo.getStreamEvents(local, "turn-cancelled")).map(event => event.eventType)).toEqual(["done"]);
  expect(await repo.listApiOwnedRecoveryTurns("2999-01-01T00:00:00.000Z")).toEqual([]);
  if (mode === "claimed") {
    expect((await repo.listToolExecutionsByTurn(local, "turn-cancelled"))[0]).toMatchObject({ status: "outcome_unknown", error: "recovery_outcome_unknown" });
    expect(await repo.finalizeTurnAttempt(local, { turnId: "turn-cancelled", attemptId: "attempt-cancelled", status: "Completed", expectedFencingToken: fencingToken })).toBeNull();
  }
});

it("retirement rechecks lease expiry and fencing and records exactly one terminal event", async () => {
  await accept("live");
  const claim = await repo.claimTurnAttempt(local, { turnId: "turn-live", attemptId: "attempt-live", expectedFencingToken: 0, leaseId: "live" });
  expect(await repo.retireExpiredApiOwnedAttempt("turn-live", "attempt-live", claim.fencingToken)).toBe(false);
  await accept("expired");
  const expired = await repo.claimTurnAttempt(local, { turnId: "turn-expired", attemptId: "attempt-expired", expectedFencingToken: 0, leaseId: "expired", ttlMs: -1 });
  expect(await repo.retireExpiredApiOwnedAttempt("turn-expired", "attempt-expired", 0)).toBe(false);
  expect(await repo.retireExpiredApiOwnedAttempt("turn-expired", "attempt-expired", expired.fencingToken)).toBe(true);
  expect(await repo.retireExpiredApiOwnedAttempt("turn-expired", "attempt-expired", expired.fencingToken)).toBe(false);
  expect((await repo.listTurnAttempts(local, "turn-expired"))[0]).toMatchObject({ status: "Interrupted", fencingToken: 2 });
  expect((await repo.getTurn(local, "turn-expired"))?.status).toBe("Interrupted");
  expect(await repo.getStreamEvents(local, "turn-expired")).toHaveLength(1);
});
