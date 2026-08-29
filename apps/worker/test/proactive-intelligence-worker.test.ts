import { describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  createProactiveVaultCipher,
  FULL_PROFILE_SOURCE_MANIFEST,
  initDatabaseSchema,
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveProfileRepository,
} from "@aervox/database";
import { runProactiveIntelligenceCycle } from "../src/proactive-intelligence-worker.js";

const tenant = {workspaceId: "ws_intelligence_worker", subjectUserId: "usr_intelligence_worker"} as const;
const now = new Date("2026-08-29T12:00:00.000Z");

describe("proactive intelligence worker", () => {
  it("materializes all twelve local intelligence capabilities and daily/weekly reviews", async () => {
    const database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(7), "worker-intelligence");
    const profileRepo = new SqliteProactiveProfileRepository(database.db, cipher);
    const intelligenceRepo = new SqliteProactiveIntelligenceRepository(database.db, cipher);
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

      const result = await runProactiveIntelligenceCycle({
        db: database.db,
        profileRepo,
        intelligenceRepo,
        workerId: "worker_intelligence_test",
        now: () => now,
      });
      expect(result).toMatchObject({tenants: 1});
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
