import { describe, expect, it } from "vitest";
import { FULL_PROFILE_SOURCE_MANIFEST } from "@aervox/schema";
import {
  createInMemoryDatabase,
  createProactiveVaultCipher,
  initDatabaseSchema,
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveBudgetRepository,
  SqliteProactiveProfileRepository,
  SqliteProactiveSituationRepository,
  SqlitePerceptionEventRepository,
  perceptionPayloadDigest,
} from "@aervox/repositories";
import { runProactiveIntelligenceCycle } from "../src/proactive/intelligence-worker.js";

const tenant = {workspaceId: "ws_intelligence_worker", subjectUserId: "usr_intelligence_worker"} as const;
const now = new Date("2026-08-29T12:00:00.000Z");

describe("proactive intelligence worker", () => {
  it("materializes all twelve local intelligence capabilities and daily/weekly reviews", async () => {
    const database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(7), "worker-intelligence");
    const profileRepo = new SqliteProactiveProfileRepository(database.db, cipher);
    const intelligenceRepo = new SqliteProactiveIntelligenceRepository(database.db, cipher);
    const situationRepo = new SqliteProactiveSituationRepository(database.db, cipher);
    const budgetRepo = new SqliteProactiveBudgetRepository(database.db);
    const perceptionRepo = new SqlitePerceptionEventRepository(database.db);
    try {
      const {revision, sources} = await profileRepo.confirmProfile(tenant, {
        id: "profile_intelligence_worker",
        deviceId: "device_intelligence_worker",
        actorId: tenant.subjectUserId,
        sources: FULL_PROFILE_SOURCE_MANIFEST.map((source, index) => ({
          id: `source_intelligence_${index}`,
          sourceKey: source.sourceKey,
          purpose: source.purpose,
          scope: "all",
          osCapability: source.osCapability,
          state: "granted" as const,
          mandatory: true,
        })),
      });
      const sourceByKey = new Map(sources.map((source) => [source.sourceKey, source]));
      const lease = await profileRepo.createActivationLease(tenant, {
        id: "lease_intelligence_worker",
        revisionId: revision.id,
        deviceId: revision.deviceId,
        epoch: "epoch_intelligence_worker",
        localReady: true,
        fullAccessSnapshot: true,
        actorId: tenant.subjectUserId,
      });

      for (let index = 0; index < 5; index += 1) {
        await profileRepo.createObservation(tenant, {
          id: `observation_operation_${index}`,
          revisionId: revision.id,
          sourceGrantId: sourceByKey.get("aervox.operation")!.id,
          sourceKey: "aervox.operation",
          observationType: "editor.opened",
          subjectKey: "project:alpha",
          payload: {content: "Open editor and task board"},
          checksum: `operation-${index}`,
          observedAt: `2026-08-2${index}T08:00:00.000Z`,
        });
      }
      await profileRepo.createObservation(tenant, {
        id: "observation_communication",
        revisionId: revision.id,
        sourceGrantId: sourceByKey.get("external.communication")!.id,
        sourceKey: "external.communication",
        observationType: "message.received",
        subjectKey: "Alice",
        payload: {content: "Please send the Alpha update"},
        checksum: "communication-1",
        observedAt: "2026-08-28T09:00:00.000Z",
      });
      await profileRepo.createObservation(tenant, {
        id: "observation_scene",
        revisionId: revision.id,
        sourceGrantId: sourceByKey.get("device.app_activity")!.id,
        sourceKey: "device.app_activity",
        observationType: "app.focused",
        subjectKey: "editor",
        payload: {content: "Alpha workspace"},
        checksum: "scene-1",
        observedAt: "2026-08-29T11:30:00.000Z",
      });
      await profileRepo.createClaim(tenant, {
        id: "claim_morning",
        revisionId: revision.id,
        claimType: "habit",
        subjectKey: "preferred_focus_time",
        content: "Prefers morning focus",
        state: "inferred",
        confidence: 70,
        sourceGrantIds: [sourceByKey.get("aervox.activity")!.id],
      });
      await profileRepo.createClaim(tenant, {
        id: "claim_evening",
        revisionId: revision.id,
        claimType: "habit",
        subjectKey: "preferred_focus_time",
        content: "Prefers evening focus",
        state: "inferred",
        confidence: 68,
        sourceGrantIds: [sourceByKey.get("aervox.activity")!.id],
      });
      const action = await profileRepo.createAction(tenant, {
        id: "action_intelligence_worker",
        revisionId: revision.id,
        activationLeaseId: lease.id,
        actionType: "workspace.prepare",
        target: "workspace:beta",
        request: {workspace: "alpha"},
        authorizationScope: "action.local",
        actionGrantRevision: "ignored",
        requestedBy: tenant.subjectUserId,
        reversible: true,
        external: false,
      });
      await profileRepo.updateAction(tenant, action.id, {state: "approved", actorId: tenant.subjectUserId});
      await profileRepo.updateAction(tenant, action.id, {state: "running", actorId: tenant.subjectUserId});
      await profileRepo.updateAction(tenant, action.id, {state: "executed", actorId: tenant.subjectUserId, outcome: {prepared: true}});
      await intelligenceRepo.createCommitment(tenant, {
        id: "commitment_worker",
        revisionId: revision.id,
        projectId: null,
        relationshipId: null,
        content: "Send Alpha update",
        status: "open",
        importance: 90,
        dueAt: "2026-08-30T09:00:00.000Z",
        sourceTimelineId: null,
      });
      const eventPayload = {
        revisionId: revision.id,
        captureId: "capture-perception-worker",
        contentType: "application/json",
        checksum: "perception-worker",
        eventType: "presence.active",
        idleSeconds: 0,
        presenceState: "active",
      };
      await perceptionRepo.ingest(tenant, {
        version: "perception_event_v1",
        eventId: "event-perception-worker",
        idempotencyKey: "event-perception-worker",
        source: "system.idle_state",
        deviceId: revision.deviceId,
        activationEpoch: lease.epoch,
        sourceGrantId: sourceByKey.get("system.idle_state")!.id,
        occurredAt: "2026-08-29T11:59:00.000Z",
        ingestedAt: "2026-08-29T11:59:00.000Z",
        sequence: 0,
        payloadDigest: perceptionPayloadDigest(eventPayload),
        schemaVersion: "perception_event_v1",
        payload: eventPayload,
      });

      const result = await runProactiveIntelligenceCycle({
        db: database.db,
        profileRepo,
        intelligenceRepo,
        situationRepo,
        budgetRepo,
        perceptionRepo,
        proactiveFeatureFlags: new Set(["situation_projection", "proactive_dsl", "attention_budget", "perception_events"]),
        workerId: "worker_intelligence_test",
        now: () => now,
      });
      expect(result).toMatchObject({tenants: 1});
      expect(result).toMatchObject({projections: 1, parityMismatches: 0});
      expect(result.budgetReceipts).toBeGreaterThan(0);
      expect(result.perceptionEvents).toBe(1);
      expect((await budgetRepo.getOrInitBudget(tenant, "global", null)).budgetUnits).toBeLessThan(100);
      const situation = await situationRepo.getLatestSnapshot(tenant, revision.id);
      expect(situation?.origin).toBe("backfill");
      expect(situation?.snapshot).toMatchObject({
        version: "situation_model_v1",
        revisionId: revision.id,
        commitments: [{id: "commitment_worker"}],
      });
      expect(situation?.lastEventSequence).toBe(1);
      expect(await perceptionRepo.consume(tenant, "proactive-distiller-v1")).toEqual([]);
      expect(await perceptionRepo.consume(tenant, "situation-projector-v1")).toEqual([]);
      for (const key of [
        "timeline", "projects", "workflows", "triggers", "verifications", "conflicts",
        "preparations", "attention", "drift", "relationships", "scenes", "reviews",
      ] as const) {
        expect(result[key], key).toBeGreaterThan(0);
      }

      const snapshot = await intelligenceRepo.exportSnapshot(tenant);
      expect(snapshot.timeline.length).toBeGreaterThan(0);
      expect(snapshot.projects.length).toBeGreaterThan(0);
      expect(snapshot.workflows.length).toBeGreaterThan(0);
      expect(snapshot.triggerEvents.length).toBeGreaterThan(0);
      expect(snapshot.verifications.length).toBeGreaterThan(0);
      expect(snapshot.conflicts.length).toBeGreaterThan(0);
      expect(snapshot.preparations.length).toBeGreaterThan(0);
      expect(snapshot.attentionStates.length).toBeGreaterThan(0);
      expect(snapshot.driftSignals.length).toBeGreaterThan(0);
      expect(snapshot.relationships.length).toBeGreaterThan(0);
      expect(snapshot.scenes.length).toBeGreaterThan(0);
      expect(snapshot.reviews.map((review: {periodType: string}) => review.periodType)).toEqual(expect.arrayContaining(["daily", "weekly"]));
    } finally {
      await database.cleanup();
    }
  }, 15_000);
});
