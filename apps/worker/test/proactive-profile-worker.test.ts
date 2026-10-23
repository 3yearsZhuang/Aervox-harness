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

  it("does not mistake one legacy claim for a complete multi-output publication", async () => {
    const ctx = await fixture();
    try {
      await ctx.repo.createCapture(tenant, { id: "recovery", revisionId: ctx.revision.id, sourceGrantId: ctx.source.id,
        sourceKey: ctx.source.sourceKey, contentType: "text/plain", payloadText: "TypeScript", checksum: "recovery",
        observedAt: "2026-08-28T00:00:00.000Z", ingestedAt: "2026-08-28T00:00:00.000Z" });
      await ctx.repo.createClaim(tenant, { id: "recovered-claim", revisionId: ctx.revision.id, claimType: "habit",
        subjectKey: "recovery", content: "existing", evidenceCaptureIds: ["recovery"], sourceGrantIds: [ctx.source.id] });
      const result = await runProactiveProfileCycle({ repo: ctx.repo, workerId: "test", now: () => now,
        distiller: createRuleBasedProactiveDistiller() });
      expect(result).toMatchObject({ distilled: 0, failed: 1 });
      expect((await ctx.repo.listCaptures(tenant))[0]).toMatchObject({ distillationStatus: "failed",
        lastDistillationError: "capture_distillation_receipt_unavailable" });
      expect(await ctx.repo.listCaptureClaims(tenant, "recovery")).toHaveLength(1);
    } finally { await ctx.cleanup(); }
  });

  it("rolls back the whole multi-output batch if the second claim fails", async () => {
    const ctx = await fixture();
    try {
      await ctx.repo.createCapture(tenant, { id: "multi", revisionId: ctx.revision.id, sourceGrantId: ctx.source.id,
        sourceKey: ctx.source.sourceKey, contentType: "text/plain", payloadText: "TypeScript", checksum: "multi",
        observedAt: "2026-08-28T00:00:00.000Z", ingestedAt: "2026-08-28T00:00:00.000Z" });
      await ctx.client.execute("CREATE TRIGGER fail_second BEFORE INSERT ON proactive_profile_claims WHEN new.id='pclaim_multi_2' BEGIN SELECT RAISE(ABORT, 'injected'); END");
      const deps = { repo: ctx.repo, workerId: "test", now: () => now, distiller: { processorId: "multi-v1",
        async distill() { return [1, 2].map(index => ({ claimType: "habit", subjectKey: `subject-${index}`,
          content: `output-${index}`, confidence: 80, evidenceRefs: [] })); } } };
      expect(await runProactiveProfileCycle(deps)).toMatchObject({ distilled: 0, failed: 1 });
      expect(await ctx.repo.listCaptureClaims(tenant, "multi")).toHaveLength(0);
      expect(await ctx.repo.listObservations(tenant)).toHaveLength(0);
      await ctx.client.execute("DROP TRIGGER fail_second");
      await ctx.client.execute("UPDATE proactive_captures SET updated_at='2026-08-28T00:00:00.000Z' WHERE id='multi'");
      expect(await runProactiveProfileCycle(deps)).toMatchObject({ distilled: 1, failed: 0 });
      expect(await ctx.repo.listCaptureClaims(tenant, "multi")).toHaveLength(2);
      expect((await ctx.repo.listCaptures(tenant))[0]!.distilledMemoryIds).toHaveLength(2);
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
      expect((await ctx.repo.listAuditEvents(tenant)).filter(event => event.eventType === "capture.distillation_failed")).toHaveLength(0);
      if (change === "delete") expect((await ctx.repo.listCaptures(tenant, { includeDeleted: true }))[0]!.payloadText).toBeNull();
    } finally { await ctx.cleanup(); }
  });

  it("rolls back an observation with claim failure and retries the complete batch", async () => {
    const ctx = await fixture();
    try {
      await ctx.repo.createCapture(tenant, { id: "retry", revisionId: ctx.revision.id, sourceGrantId: ctx.source.id,
        sourceKey: ctx.source.sourceKey, contentType: "text/plain", payloadText: "TypeScript", checksum: "retry",
        observedAt: "2026-08-28T00:00:00.000Z", ingestedAt: "2026-08-28T00:00:00.000Z" });
      await ctx.client.execute("CREATE TRIGGER fail_claim BEFORE INSERT ON proactive_profile_claims BEGIN SELECT RAISE(ABORT, 'injected'); END");
      const deps = { repo: ctx.repo, distiller: createRuleBasedProactiveDistiller(), workerId: "test", now: () => now };
      expect(await runProactiveProfileCycle(deps)).toMatchObject({ distilled: 0, failed: 1 });
      expect(await ctx.repo.listObservations(tenant)).toHaveLength(0);
      await ctx.client.execute("DROP TRIGGER fail_claim");
      await ctx.client.execute("UPDATE proactive_captures SET updated_at='2026-08-28T00:00:00.000Z' WHERE id='retry'");
      expect(await runProactiveProfileCycle(deps)).toMatchObject({ distilled: 1, failed: 0 });
      expect(await ctx.repo.listObservations(tenant)).toHaveLength(1);
      expect(await ctx.repo.listClaims(tenant)).toHaveLength(1);
    } finally { await ctx.cleanup(); }
  });

  it("does not downgrade a committed publication after an acknowledgement is lost", async () => {
    const ctx = await fixture();
    try {
      await ctx.repo.createCapture(tenant, { id: "lost-ack", revisionId: ctx.revision.id, sourceGrantId: ctx.source.id,
        sourceKey: ctx.source.sourceKey, contentType: "text/plain", payloadText: "TypeScript", checksum: "lost-ack",
        observedAt: "2026-08-28T00:00:00.000Z", ingestedAt: "2026-08-28T00:00:00.000Z" });
      const publish = ctx.repo.publishCaptureDistillation.bind(ctx.repo);
      ctx.repo.publishCaptureDistillation = async (...args) => { await publish(...args); throw new Error("ack lost"); };
      let calls = 0;
      const distiller = createRuleBasedProactiveDistiller();
      const deps = { repo: ctx.repo, workerId: "test", now: () => now, distiller: {
        processorId: distiller.processorId, async distill(capture: Parameters<typeof distiller.distill>[0]) { calls++; return distiller.distill(capture); },
      } };
      expect(await runProactiveProfileCycle(deps)).toMatchObject({ distilled: 0, failed: 1 });
      expect((await ctx.repo.listCaptures(tenant))[0]!.distillationStatus).toBe("distilled");
      expect(await runProactiveProfileCycle(deps)).toMatchObject({ distilled: 0, failed: 0 });
      expect(calls).toBe(1);
      expect(await ctx.repo.listCaptureClaims(tenant, "lost-ack")).toHaveLength(1);
    } finally { await ctx.cleanup(); }
  });

  it("keeps a processor exception containing private capture text out of durable errors and audits", async () => {
    const ctx = await fixture();
    try {
      await ctx.repo.createCapture(tenant, { id: "private-error", revisionId: ctx.revision.id, sourceGrantId: ctx.source.id,
        sourceKey: ctx.source.sourceKey, contentType: "text/plain", payloadText: "private source secret=do-not-retain",
        checksum: "private-error", observedAt: "2026-08-28T00:00:00.000Z", ingestedAt: "2026-08-28T00:00:00.000Z" });
      expect(await runProactiveProfileCycle({ repo: ctx.repo, workerId: "test", now: () => now,
        distiller: { processorId: "private-error-v1", async distill(capture) { throw new Error(`failed: ${capture.payloadText}`); } },
      })).toMatchObject({ distilled: 0, failed: 1 });
      expect((await ctx.repo.listCaptures(tenant))[0]!.lastDistillationError).toBe("capture_distillation_failed");
      const failureAudits = (await ctx.repo.listAuditEvents(tenant)).filter(event => event.eventType === "capture.distillation_failed");
      expect(failureAudits).toHaveLength(1);
      expect(JSON.stringify(failureAudits)).not.toContain("do-not-retain");
      await ctx.repo.deleteSourceData(tenant, ctx.source.id, "test");
      expect(JSON.stringify(await ctx.repo.listAuditEvents(tenant))).not.toContain("do-not-retain");
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
