import { describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  createProactiveVaultCipher,
  initDatabaseSchema,
  SqliteProactiveProfileRepository,
} from "@aervox/repositories";
import { createRuleBasedProactiveDistiller } from "../src/proactive/distiller.js";
import { runProactiveProfileCycle } from "../src/proactive/profile-worker.js";

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

  it("processes the oldest backlog even when more than 500 newer captures exist", async () => {
    const ctx = await fixture();
    try {
      for (let index = 0; index < 550; index++) {
        const timestamp = new Date(Date.UTC(2026, 7, 28) + index * 1000).toISOString();
        await ctx.repo.createCapture(tenant, {
          id: `backlog_${index}`, revisionId: ctx.revision.id, sourceGrantId: ctx.source.id,
          sourceKey: ctx.source.sourceKey, contentType: "text/plain", payloadText: `TypeScript ${index}`,
          checksum: `backlog:${index}`, ingestedAt: timestamp, observedAt: timestamp,
        });
      }
      const result = await runProactiveProfileCycle({ repo: ctx.repo,
        distiller: createRuleBasedProactiveDistiller(), workerId: "worker_test", now: () => now });
      expect(result).toMatchObject({ distilled: 50, failed: 0 });
      const oldest = await ctx.client.execute("SELECT distillation_status FROM proactive_captures WHERE id='backlog_0'");
      expect(oldest.rows[0]!.distillation_status).toBe("distilled");
      expect(await runProactiveProfileCycle({ repo: ctx.repo, distiller: createRuleBasedProactiveDistiller(),
        workerId: "worker_test", now: () => now })).toMatchObject({ distilled: 50, failed: 0 });
      expect((await ctx.client.execute("SELECT count(*) n FROM proactive_captures WHERE distillation_status='distilled'")).rows[0]!.n).toBe(100);
    } finally { await ctx.cleanup(); }
  });

  it("recovers capture claims outside the latest 500 without rerunning the distiller", async () => {
    const ctx = await fixture();
    try {
      await ctx.repo.createCapture(tenant, { id: "recovery", revisionId: ctx.revision.id, sourceGrantId: ctx.source.id,
        sourceKey: ctx.source.sourceKey, contentType: "text/plain", payloadText: "TypeScript", checksum: "recovery",
        observedAt: "2026-08-28T00:00:00.000Z", ingestedAt: "2026-08-28T00:00:00.000Z" });
      await ctx.repo.createClaim(tenant, { id: "recovered-claim", revisionId: ctx.revision.id, claimType: "habit",
        subjectKey: "recovery", content: "existing", evidenceCaptureIds: ["recovery"], sourceGrantIds: [ctx.source.id] });
      await ctx.client.execute("UPDATE proactive_profile_claims SET updated_at='2020-01-01T00:00:00.000Z'");
      for (let index = 0; index < 501; index++) await ctx.repo.createClaim(tenant, {
        id: `other_${index}`, revisionId: ctx.revision.id, claimType: "habit", subjectKey: `other_${index}`, content: "newer" });
      const result = await runProactiveProfileCycle({ repo: ctx.repo, workerId: "test", now: () => now,
        distiller: { processorId: "must-not-run", async distill() { throw new Error("recovery lost"); } } });
      expect(result).toMatchObject({ distilled: 1, failed: 0 });
      expect((await ctx.repo.listCaptures(tenant))[0]!.distilledMemoryIds).toEqual(["recovered-claim"]);
    } finally { await ctx.cleanup(); }
  });

  it.each(["revoke", "delete"] as const)("rejects a stale selected capture when its source is %s during distillation", async (change) => {
    const ctx = await fixture();
    try {
      await ctx.repo.createCapture(tenant, { id: "stale", revisionId: ctx.revision.id, sourceGrantId: ctx.source.id,
        sourceKey: ctx.source.sourceKey, contentType: "text/plain", payloadText: "must not be derived", checksum: "stale",
        observedAt: "2026-08-28T00:00:00.000Z", ingestedAt: "2026-08-28T00:00:00.000Z" });
      const distiller = createRuleBasedProactiveDistiller();
      const result = await runProactiveProfileCycle({ repo: ctx.repo, workerId: "test", now: () => now,
        distiller: { processorId: distiller.processorId, async distill(capture) {
          if (change === "revoke") await ctx.repo.updateSourceGrant(tenant, ctx.source.id, { state: "revoked", actorId: "test" });
          else await ctx.repo.deleteSourceData(tenant, ctx.source.id, "test");
          return distiller.distill(capture);
        } } });
      expect(result).toMatchObject({ distilled: 0, failed: 1 });
      expect(await ctx.repo.listClaims(tenant)).toHaveLength(0);
      expect(await ctx.repo.listObservations(tenant)).toHaveLength(0);
      expect(await ctx.repo.listDistillationCandidates(tenant, { retryBefore: now.toISOString() })).toHaveLength(0);
      if (change === "delete") expect((await ctx.repo.listCaptures(tenant, { includeDeleted: true }))[0]!.payloadText).toBeNull();
    } finally { await ctx.cleanup(); }
  });

  it("retries an observation committed before claim failure without creating duplicate observations", async () => {
    const ctx = await fixture();
    try {
      await ctx.repo.createCapture(tenant, { id: "retry", revisionId: ctx.revision.id, sourceGrantId: ctx.source.id,
        sourceKey: ctx.source.sourceKey, contentType: "text/plain", payloadText: "TypeScript", checksum: "retry",
        observedAt: "2026-08-28T00:00:00.000Z", ingestedAt: "2026-08-28T00:00:00.000Z" });
      await ctx.client.execute("CREATE TRIGGER fail_claim BEFORE INSERT ON proactive_profile_claims BEGIN SELECT RAISE(ABORT, 'injected'); END");
      const deps = { repo: ctx.repo, distiller: createRuleBasedProactiveDistiller(), workerId: "test", now: () => now };
      expect(await runProactiveProfileCycle(deps)).toMatchObject({ distilled: 0, failed: 1 });
      expect(await ctx.repo.listObservations(tenant)).toHaveLength(1);
      await ctx.client.execute("DROP TRIGGER fail_claim");
      await ctx.client.execute("UPDATE proactive_captures SET updated_at='2026-08-28T00:00:00.000Z' WHERE id='retry'");
      expect(await runProactiveProfileCycle(deps)).toMatchObject({ distilled: 1, failed: 0 });
      expect(await ctx.repo.listObservations(tenant)).toHaveLength(1);
      expect(await ctx.repo.listClaims(tenant)).toHaveLength(1);
    } finally { await ctx.cleanup(); }
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
