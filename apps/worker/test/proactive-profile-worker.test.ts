import { describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  createProactiveVaultCipher,
  initDatabaseSchema,
  SqliteProactiveProfileRepository,
} from "@aervox/database";
import { createRuleBasedProactiveDistiller } from "../src/proactive-distiller.js";
import { runProactiveProfileCycle } from "../src/proactive-profile-worker.js";

const tenant = { workspaceId: "ws_pro", subjectUserId: "usr_pro" } as const;
const oldIngestedAt = "2026-08-20T00:00:00.000Z";
const now = new Date("2026-08-29T00:00:00.000Z");

async function fixture() {
  const database = await createInMemoryDatabase();
  await initDatabaseSchema(database.client);
  const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(9), "test-vault");
  const repo = new SqliteProactiveProfileRepository(database.db, cipher);
  const { revision, sources } = await repo.confirmProfile(tenant, {
    id: "pro_1",
    deviceId: "device_1",
    actorId: tenant.subjectUserId,
    sources: [
      {
        id: "src_browser",
        sourceKey: "device.browser_activity",
        purpose: "profile.observe",
        scope: "all",
        osCapability: "os.browser_history",
        state: "granted",
        mandatory: true,
      },
    ],
  });
  return { ...database, repo, revision, source: sources[0]! };
}

describe("CAP-033 proactive profile worker", () => {
  it("distills a local claim before deleting an expired raw copy", async () => {
    const ctx = await fixture();
    try {
      await ctx.repo.createCapture(tenant, {
        id: "cap_due_distill",
        revisionId: ctx.revision.id,
        sourceGrantId: ctx.source.id,
        sourceKey: ctx.source.sourceKey,
        contentType: "text/plain",
        payloadText: "晚间反复阅读 TypeScript 类型体操资料",
        checksum: "sha256:due",
        ingestedAt: oldIngestedAt,
        observedAt: oldIngestedAt,
      });

      const result = await runProactiveProfileCycle({
        db: ctx.db,
        repo: ctx.repo,
        distiller: createRuleBasedProactiveDistiller(),
        workerId: "worker_test",
        now: () => now,
      });
      expect(result).toMatchObject({ distilled: 1, failed: 0, purged: 1 });
      const [capture] = await ctx.repo.listCaptures(tenant, { includeDeleted: true });
      expect(capture).toMatchObject({
        id: "cap_due_distill",
        distillationStatus: "deleted",
        byteSize: 0,
      });
      expect(capture?.payloadText).toBeNull();
      const [claim] = await ctx.repo.listClaims(tenant, { revisionId: ctx.revision.id });
      expect(claim?.content).toContain("TypeScript");
      expect(claim?.evidenceCaptureIds).toContain("cap_due_distill");
      const [observation] = await ctx.repo.listObservations(tenant, { revisionId: ctx.revision.id });
      expect(observation).toMatchObject({
        sourceKey: "device.browser_activity",
        algorithmVersion: "local-rule-profile-v1",
      });
      expect(claim?.evidenceRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({ observationId: observation?.id }),
      ]));
    } finally {
      await ctx.cleanup();
    }
  });

  it("blocks and alerts instead of deleting when distillation fails", async () => {
    const ctx = await fixture();
    try {
      await ctx.repo.createCapture(tenant, {
        id: "cap_due_failed",
        revisionId: ctx.revision.id,
        sourceGrantId: ctx.source.id,
        sourceKey: ctx.source.sourceKey,
        contentType: "text/plain",
        payloadText: "must remain encrypted locally",
        checksum: "sha256:failed",
        ingestedAt: oldIngestedAt,
        observedAt: oldIngestedAt,
      });
      const result = await runProactiveProfileCycle({
        db: ctx.db,
        repo: ctx.repo,
        distiller: {
          processorId: "always-fail",
          async distill() {
            throw new Error("local processor unavailable");
          },
        },
        workerId: "worker_test",
        now: () => now,
      });
      expect(result).toMatchObject({ distilled: 0, failed: 1, purged: 0 });
      const [capture] = await ctx.repo.listCaptures(tenant, { includeDeleted: true });
      expect(capture).toMatchObject({
        id: "cap_due_failed",
        distillationStatus: "blocked",
        lastDistillationError: "retention_expired_before_distillation",
      });
      expect(capture?.payloadText).toBe("must remain encrypted locally");
      expect((await ctx.repo.listAuditEvents(tenant)).some((event) =>
        event.eventType === "capture.retention_blocked" && event.resourceId === capture?.id,
      )).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });
});
