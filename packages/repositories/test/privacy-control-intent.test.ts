import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import {
  createInMemoryDatabase, DomainConflictError, SqlitePrivacyRepository, SqliteRecoveryLedgerRepository,
} from "../src/index.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const target = (targetId: string, ownerModule = "memory") => ({ targetType: "memory", targetId, ownerModule });
const deletion = { id: "original", scope: "memory", ownerModule: "memory", idempotencyKey: "delete-intent", targets: [target("a"), target("b")] };
const control = {
  eventId: "control", idempotencyKey: "control-intent", eventType: "delete",
  workspaceRef: "local-reference", subjectRef: "subject-reference", targetRef: "target-reference",
  occurredAt: "2026-01-01T00:00:00.000Z", tamperEvidence: { version: 1, digest: "proof" },
};

let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
let privacy: SqlitePrivacyRepository;
let ledgerClient: Client;
let ledger: SqliteRecoveryLedgerRepository;
beforeEach(async () => {
  database = await createInMemoryDatabase();
  privacy = new SqlitePrivacyRepository(database.db);
  ledgerClient = createClient({ url: ":memory:" });
  await SqliteRecoveryLedgerRepository.init(ledgerClient);
  ledger = new SqliteRecoveryLedgerRepository(ledgerClient);
});
afterEach(async () => { ledgerClient.close(); await database.cleanup(); });

describe("deletion request intent is immutable for a business key", () => {
  it("preserves exact text identities through every deletion read and write receipt", async () => {
    const input = { ...deletion, id: "request\0tail", idempotencyKey: "key\0tail", scope: "scope\0tail", ownerModule: "owner\0tail",
      targets: [{ targetType: "type\0tail", targetId: "target\0tail", ownerModule: "owner\0tail" }] };
    const original = await privacy.createDeletionRequest(local, input);
    const identity = { id: input.id, idempotencyKey: input.idempotencyKey, scope: input.scope, ownerModule: input.ownerModule };
    expect(original).toMatchObject(identity);
    expect(await privacy.getDeletionRequest(local, input.id)).toMatchObject(identity);
    expect((await privacy.listUnverifiedDeletionRequests())[0]).toMatchObject(identity);
    expect(await privacy.beginDeletionRequestAttempt(input.id)).toMatchObject(identity);
    expect(await privacy.updateDeletionRequestStatus(local, input.id, "failed", { lastError: "error\0tail" }))
      .toMatchObject({ ...identity, lastError: "error\0tail" });
    expect(await privacy.createDeletionRequest(local, { ...input, id: "retry" })).toMatchObject(identity);
    const targetIdentity = { requestId: input.id, ...input.targets[0]! };
    expect((await privacy.listDeletionTargets(input.id))[0]).toMatchObject(targetIdentity);
    expect(await privacy.beginDeletionTargetAttempt(targetIdentity)).toMatchObject(targetIdentity);
    expect(await privacy.updateDeletionTargetStatus(targetIdentity, "failed", "proof\0tail"))
      .toMatchObject({ ...targetIdentity, evidenceRef: "proof\0tail" });
    const extra = { ...targetIdentity, targetId: "extra\0tail" };
    expect(await privacy.createDeletionTarget(extra)).toMatchObject(extra);
  });
  it.each([
    { scope: "account" }, { ownerModule: "other" }, { targets: [target("c")] },
    { targets: [target("a")] }, { targets: [target("a"), target("b", "other")] },
    { targets: [{ ...target("a"), targetType: "attachment" }, target("b")] },
  ])("rejects changed deletion intent %j without changing the existing request or targets", async change => {
    const original = await privacy.createDeletionRequest(local, deletion);
    const originalTargets = await privacy.listDeletionTargets(original.id);
    await expect(privacy.createDeletionRequest(local, { ...deletion, ...change, id: "replacement" }))
      .rejects.toBeInstanceOf(DomainConflictError);
    expect(await privacy.getDeletionRequest(local, original.id)).toEqual(original);
    expect(await privacy.listDeletionTargets(original.id)).toEqual(originalTargets);
    expect(await privacy.getDeletionRequest(local, "replacement")).toBeNull();
  });

  it("replays a canonical target set regardless of order, duplicate targets, new request id or receipt time", async () => {
    const original = await privacy.createDeletionRequest(local, deletion);
    await privacy.updateDeletionRequestStatus(local, original.id, "in_progress", { attemptCount: 2 });
    const replay = await privacy.createDeletionRequest(local, { ...deletion, id: "retry", requestedAt: "2099-01-01T00:00:00Z",
      targets: [target("b"), target("a"), target("b")] });
    expect(replay).toMatchObject({ id: original.id, requestedAt: original.requestedAt, status: "in_progress", attemptCount: 2 });
    expect(await privacy.listDeletionTargets(original.id)).toHaveLength(2);
  });

  it("normalizes duplicate targets at the repository boundary and rejects ambiguous owners before inserting", async () => {
    const original = await privacy.createDeletionRequest(local, { ...deletion, targets: [target("a"), target("a")] });
    expect(await privacy.listDeletionTargets(original.id)).toHaveLength(1);
    await expect(privacy.createDeletionRequest(local, { ...deletion, id: "ambiguous", idempotencyKey: "ambiguous",
      targets: [target("a"), target("a", "other")] })).rejects.toBeInstanceOf(DomainConflictError);
    expect(await privacy.getDeletionRequest(local, "ambiguous")).toBeNull();
  });

  it("distinguishes an empty target set from a retry with new explicit targets", async () => {
    await privacy.createDeletionRequest(local, { ...deletion, targets: undefined });
    await expect(privacy.createDeletionRequest(local, deletion)).rejects.toBeInstanceOf(DomainConflictError);
    expect((await privacy.createDeletionRequest(local, { ...deletion, id: "retry", targets: [] })).id).toBe("original");
  });
});

describe("recovery control receipt binds the complete persisted event", () => {
  it("preserves embedded NULs in control identities on append, lookup and replay", async () => {
    const input = { ...control, eventId: "event\0tail", idempotencyKey: "key\0tail", eventType: "delete\0tail",
      workspaceRef: "local\0tail", subjectRef: "subject\0tail", targetRef: "target\0tail", tamperEvidence: { proof: "proof\0tail" } };
    const original = await ledger.appendEvent(input);
    expect(original).toMatchObject(input);
    expect(await ledger.getByIdempotencyKey(input.idempotencyKey)).toEqual(original);
    expect(await ledger.getBySequence(original.sequence)).toEqual(original);
    expect(await ledger.appendEvent(input)).toEqual(original);
    await expect(ledger.appendEvent({ ...input, targetRef: "target\0different" })).rejects.toBeInstanceOf(DomainConflictError);
  });
  it.each([
    { eventId: "other-event" }, { eventType: "consent_revoke" }, { workspaceRef: "other-workspace" },
    { subjectRef: "other-subject" }, { targetRef: "other-target" }, { targetRef: null },
    { occurredAt: "2026-02-01T00:00:00.000Z" }, { tamperEvidence: { version: 2, digest: "proof" } },
  ])("rejects same-key changed event %j while preserving the durable receipt and sequence", async change => {
    const original = await ledger.appendEvent(control);
    await expect(ledger.appendEvent({ ...control, ...change })).rejects.toBeInstanceOf(DomainConflictError);
    expect(await ledger.getByIdempotencyKey(control.idempotencyKey)).toEqual(original);
    expect(await ledger.getMaxSequence()).toBe(1);
  });

  it("preserves equivalent JSON proof order and the original generated time on retries", async () => {
    const { occurredAt: _time, ...input } = control;
    const original = await ledger.appendEvent(input);
    const replay = await ledger.appendEvent({ ...input, tamperEvidence: { digest: "proof", version: 1 } });
    expect(replay).toEqual(original);
    expect(await ledger.getMaxSequence()).toBe(1);
  });

  it("normalizes omitted and null optional fields without treating them as a changed intent", async () => {
    const input = { eventId: "empty", idempotencyKey: "empty", eventType: "delete" };
    const original = await ledger.appendEvent(input);
    expect(await ledger.appendEvent({ ...input, workspaceRef: null, subjectRef: null, targetRef: null, tamperEvidence: null })).toEqual(original);
  });

  it("coalesces concurrent identical retries to the same durable sequence", async () => {
    const receipts = await Promise.all(Array.from({ length: 8 }, () => ledger.appendEvent(control)));
    expect(receipts.every(receipt => receipt.sequence === 1)).toBe(true);
    expect(await ledger.inspectConsistency()).toMatchObject({ eventCount: 1, maxSequence: 1, duplicatedSequences: [], missingSequences: [] });
  });

  it("rejects a conflicting concurrent retry after the winner commits", async () => {
    const settled = await Promise.allSettled([
      ledger.appendEvent(control), ledger.appendEvent({ ...control, targetRef: "other-target" }),
    ]);
    expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(DomainConflictError);
    expect(await ledger.getMaxSequence()).toBe(1);
  });
});
