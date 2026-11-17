import { expect, it, vi } from "vitest";
import { runReviewNotificationCycle } from "../src/review-notifier.js";
import { runDeletionCycle } from "../src/deletion-worker.js";
import type { DeletionRequestModel, DeletionTargetModel } from "@aervox/repositories";

it("review scheduling runs with only the bounded schedule projection and notification/audit ports", async () => {
  const createNotificationIdempotent = vi.fn(async () => undefined), createAuditRecordIdempotent = vi.fn(async () => undefined);
  const count = await runReviewNotificationCycle({
    workerId: "fake", platformRepo: { createNotificationIdempotent, createAuditRecordIdempotent } as never,
    learningRepo: { listDueReviewSchedule: vi.fn(async () => [{id:"review",knowledgeId:"knowledge",dueAt:"2026-01-01"}]),
      listKnowledgeRelationsForKnowledgeIds: vi.fn(async () => new Map()) },
  });
  expect(count).toBe(1); expect(createNotificationIdempotent).toHaveBeenCalledOnce(); expect(createAuditRecordIdempotent).toHaveBeenCalledOnce();
});
function deletionFixture() {
  const claimed: DeletionRequestModel = {
    id: "request", scope: "memory", ownerModule: "memory", status: "in_progress", attemptCount: 7,
    idempotencyKey: "request", requestedAt: "2026-01-01", createdAt: "2026-01-01", updatedAt: "2026-01-01",
  };
  const target: DeletionTargetModel = { requestId: "request", targetType: "memory", targetId: "memory", ownerModule: "memory", status: "in_progress", attemptCount: 1 };
  const privacyRepo = {
    listUnverifiedDeletionRequests: vi.fn(async () => [{ ...claimed, attemptCount: 0 }]),
    beginDeletionRequestAttempt: vi.fn<() => Promise<DeletionRequestModel | null>>(async () => claimed),
    listDeletionTargets: vi.fn(async () => [target]),
    beginDeletionTargetAttempt: vi.fn<() => Promise<DeletionTargetModel | null>>(async () => target),
    updateDeletionTargetAttemptStatus: vi.fn<() => Promise<DeletionTargetModel | null>>(async () => ({ ...target, status: "completed" })),
    failDeletionRequestAttempt: vi.fn<() => Promise<DeletionRequestModel | null>>(async () => null),
    finalizeDeletionRequestAttempt: vi.fn<() => Promise<DeletionRequestModel | null>>(async () => ({ ...claimed, status: "completed" })),
  };
  const memoryDeletion = { clean: vi.fn(async () => undefined), verify: vi.fn(async () => "evidence") };
  return { privacyRepo, memoryDeletion, workerId: "fake" };
}
it("deletion scheduling runs with injected cleanup/verification and no database capability", async () => {
  const ctx = deletionFixture(), { privacyRepo, memoryDeletion } = ctx;
  expect(await runDeletionCycle(ctx)).toBe(1);
  expect(privacyRepo.beginDeletionTargetAttempt).toHaveBeenCalledOnce(); expect(memoryDeletion.verify).toHaveBeenCalledWith("memory");
  expect(privacyRepo.beginDeletionTargetAttempt).toHaveBeenCalledWith({ requestId: "request", requestAttemptCount: 7, targetType: "memory", targetId: "memory" });
  expect(privacyRepo.finalizeDeletionRequestAttempt).toHaveBeenCalledWith({ requestId: "request", requestAttemptCount: 7 }, "fake");
});
it.each(["claim", "begin", "result", "finalize"])("abandons a null %s receipt without an unguarded failure or completion", async stage => {
  const ctx = deletionFixture(), { privacyRepo, memoryDeletion } = ctx;
  if (stage === "claim") privacyRepo.beginDeletionRequestAttempt.mockResolvedValueOnce(null);
  if (stage === "begin") privacyRepo.beginDeletionTargetAttempt.mockResolvedValueOnce(null);
  if (stage === "result") privacyRepo.updateDeletionTargetAttemptStatus.mockResolvedValueOnce(null);
  if (stage === "finalize") privacyRepo.finalizeDeletionRequestAttempt.mockResolvedValueOnce(null);
  expect(await runDeletionCycle(ctx)).toBe(0);
  expect(privacyRepo.failDeletionRequestAttempt).not.toHaveBeenCalled();
  if (stage === "claim" || stage === "begin") {
    expect(memoryDeletion.clean).not.toHaveBeenCalled(); expect(memoryDeletion.verify).not.toHaveBeenCalled();
  }
  if (stage !== "finalize") expect(privacyRepo.finalizeDeletionRequestAttempt).not.toHaveBeenCalled();
});
it("does not guess an attempt when claiming throws before returning its epoch", async () => {
  const ctx = deletionFixture();
  ctx.privacyRepo.beginDeletionRequestAttempt.mockRejectedValueOnce(new Error("claim failed"));
  expect(await runDeletionCycle(ctx)).toBe(0);
  expect(ctx.privacyRepo.failDeletionRequestAttempt).not.toHaveBeenCalled();
  expect(ctx.memoryDeletion.clean).not.toHaveBeenCalled();
});
