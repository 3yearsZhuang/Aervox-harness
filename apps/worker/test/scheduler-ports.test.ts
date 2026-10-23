import { expect, it, vi } from "vitest";
import { runReviewNotificationCycle } from "../src/review-notifier.js";
import { runDeletionCycle } from "../src/deletion-worker.js";

it("review scheduling runs with only the bounded schedule projection and notification/audit ports", async () => {
  const createNotificationIdempotent = vi.fn(async () => undefined), createAuditRecordIdempotent = vi.fn(async () => undefined);
  const count = await runReviewNotificationCycle({
    workerId: "fake", platformRepo: { createNotificationIdempotent, createAuditRecordIdempotent } as never,
    learningRepo: { listDueReviewSchedule: vi.fn(async () => [{id:"review",knowledgeId:"knowledge",dueAt:"2026-01-01"}]),
      listKnowledgeRelationsForKnowledgeIds: vi.fn(async () => new Map()) },
  });
  expect(count).toBe(1); expect(createNotificationIdempotent).toHaveBeenCalledOnce(); expect(createAuditRecordIdempotent).toHaveBeenCalledOnce();
});
it("deletion scheduling runs with injected cleanup/verification and no database capability", async () => {
  const privacyRepo = {
    listUnverifiedDeletionRequests: vi.fn(async () => [{id:"request",scope:"memory",ownerModule:"memory"}]),
    beginDeletionRequestAttempt: vi.fn(async () => ({id:"request"})),
    listDeletionTargets: vi.fn(async () => [{targetType:"memory",targetId:"memory",ownerModule:"memory"}]),
    beginDeletionTargetAttempt: vi.fn(async () => ({targetId:"memory"})),
    updateDeletionTargetStatus: vi.fn(async () => null), updateDeletionRequestStatus: vi.fn(async () => null),
  };
  const memoryDeletion = { clean: vi.fn(async () => undefined), verify: vi.fn(async () => "evidence") };
  expect(await runDeletionCycle({workerId:"fake",privacyRepo: privacyRepo as never,memoryDeletion: memoryDeletion as never,
    platformRepo:{createAuditRecord:vi.fn(async()=>undefined)} as never})).toBe(1);
  expect(privacyRepo.beginDeletionTargetAttempt).toHaveBeenCalledOnce(); expect(memoryDeletion.verify).toHaveBeenCalledWith("memory");
});
