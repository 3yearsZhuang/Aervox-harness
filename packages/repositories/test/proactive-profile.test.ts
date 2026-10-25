import { describe, expect, it, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  FULL_PROFILE_SOURCE_MANIFEST,
  SqliteProactiveProfileRepository,
  createProactiveVaultCipher,
  type AervoxDatabase,
  type LocalContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";
import { proactiveActions } from "@aervox/schema";

describe("CAP-033 proactive profile repository", () => {
  let db: AervoxDatabase;
  let client: Client;
  const ctx: LocalContext = { workspaceId: "ws_pro", subjectUserId: "usr_pro" };
  const otherTenant: LocalContext = { workspaceId: "ws_other", subjectUserId: "usr_other" };

  beforeEach(async () => {
    const result = await createInMemoryDatabase();
    db = result.db;
    client = result.client;
    await initDatabaseSchema(result.client);
  });

  function allGrantedSources(profileId: string) {
    return FULL_PROFILE_SOURCE_MANIFEST.map((source, index) => ({
      id: `${profileId}_source_${index + 1}`,
      sourceKey: source.sourceKey,
      purpose: source.purpose,
      osCapability: source.osCapability,
      scope: "all",
      state: "granted" as const,
      mandatory: true,
      lastVerifiedAt: "2026-08-29T00:00:00.000Z",
    }));
  }

  it("keeps an unacknowledged OS grant requested and isolates tenants", async () => {
    const repository = new SqliteProactiveProfileRepository(db);
    const result = await repository.confirmProfile(ctx, {
      id: "profile_requested",
      deviceId: "device-a",
      actorId: "usr_pro",
    });
    expect(result.sources).toHaveLength(FULL_PROFILE_SOURCE_MANIFEST.length);
    expect(result.sources.every((source) => source.state === "requested")).toBe(true);
    expect((await repository.getEffectiveStatus(ctx)).effectiveState).toBe("suspended");
    expect(await repository.getRevision(otherTenant)).not.toBeNull();
    expect(await repository.listSourceGrants(otherTenant)).toHaveLength(FULL_PROFILE_SOURCE_MANIFEST.length);
  });

  it("derives active only after all source grants, local readiness and full access snapshot", async () => {
    const repository = new SqliteProactiveProfileRepository(db);
    const result = await repository.confirmProfile(ctx, {
      id: "profile_active",
      deviceId: "device-a",
      actorId: "usr_pro",
      sources: allGrantedSources("profile_active"),
    });
    const lease = await repository.createActivationLease(ctx, {
      id: "lease_active",
      revisionId: result.revision.id,
      deviceId: "device-a",
      epoch: "epoch-a",
      localReady: true,
      fullAccessSnapshot: true,
      actorId: "usr_pro",
    });
    expect(lease.status).toBe("active");
    const status = await repository.getEffectiveStatus(ctx);
    expect(status.effectiveState).toBe("active");
    expect(status.mandatorySources.granted).toBe(FULL_PROFILE_SOURCE_MANIFEST.length);

    await repository.updateSourceGrant(ctx, result.sources[0]!.id, {
      state: "revoked",
      actorId: "usr_pro",
    });
    expect((await repository.getEffectiveStatus(ctx)).effectiveState).toBe("limited");
  });

  it("derives active once mandatory sources are granted even when platform-pending sources wait", async () => {
    const repository = new SqliteProactiveProfileRepository(db);
    // 未显式传入 sources 时，mandatory 由服务端 manifest 派生：
    // 通信/位置/传感器/敏感资料与 idle_state（CR-032 可选感知源）不计入必需集合。
    const pending = new Set(["external.communication", "device.location", "device.sensors", "restricted.profile", "system.idle_state"]);
    const fallback = await repository.confirmProfile(ctx, {
      id: "profile_fallback",
      deviceId: "device-a",
      actorId: "usr_pro",
    });
    expect(fallback.sources).toHaveLength(FULL_PROFILE_SOURCE_MANIFEST.length);
    expect(fallback.sources.filter((source) => source.mandatory)).toHaveLength(FULL_PROFILE_SOURCE_MANIFEST.length - pending.size);

    const sources = FULL_PROFILE_SOURCE_MANIFEST.map((source, index) => ({
      id: `profile_pending_source_${index + 1}`,
      sourceKey: source.sourceKey,
      purpose: source.purpose,
      osCapability: source.osCapability,
      scope: "all",
      state: (pending.has(source.sourceKey) ? "requested" : "granted") as "requested" | "granted",
      mandatory: !pending.has(source.sourceKey),
      lastVerifiedAt: "2026-08-29T00:00:00.000Z",
    }));
    const result = await repository.confirmProfile(otherTenant, {
      id: "profile_pending",
      deviceId: "device-b",
      actorId: "usr_other",
      sources,
    });
    await repository.createActivationLease(otherTenant, {
      id: "lease_pending",
      revisionId: result.revision.id,
      deviceId: "device-b",
      epoch: "epoch-pending",
      localReady: true,
      fullAccessSnapshot: true,
      actorId: "usr_other",
    });
    const status = await repository.getEffectiveStatus(otherTenant);
    expect(status.effectiveState).toBe("suspended");
    expect(status.mandatorySources).toMatchObject({total: FULL_PROFILE_SOURCE_MANIFEST.length - pending.size, granted: 0});
  });

  it("retains raw captures for seven days and blocks expiry until memory distillation", async () => {
    const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(9), "test-v1");
    const repository = new SqliteProactiveProfileRepository(db, cipher);
    const profile = await repository.confirmProfile(ctx, {
      id: "profile_capture",
      deviceId: "device-a",
      actorId: "usr_pro",
      sources: allGrantedSources("profile_capture"),
    });
    const capture = await repository.createCapture(ctx, {
      id: "capture-1",
      revisionId: profile.revision.id,
      sourceGrantId: profile.sources[0]!.id,
      sourceKey: profile.sources[0]!.sourceKey,
      contentType: "text/plain",
      payloadText: "private source text",
      checksum: "sha256:test",
      ingestedAt: "2026-08-01T00:00:00.000Z",
      observedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(capture.retentionUntil).toBe("2026-08-08T00:00:00.000Z");
    expect(capture.payloadText).toBe("private source text");
    await expect(repository.createCapture(ctx, {
      id: "capture-1",
      revisionId: profile.revision.id,
      sourceGrantId: profile.sources[0]!.id,
      sourceKey: profile.sources[0]!.sourceKey,
      contentType: "text/plain",
      payloadText: "private source text",
      checksum: "sha256:test",
      ingestedAt: "2026-08-01T00:00:00.000Z",
      observedAt: "2026-08-01T00:00:00.000Z",
    })).resolves.toMatchObject({ id: "capture-1" });
    await expect(repository.createCapture(ctx, {
      id: "capture-1",
      revisionId: profile.revision.id,
      sourceGrantId: profile.sources[0]!.id,
      sourceKey: profile.sources[0]!.sourceKey,
      contentType: "text/plain",
      payloadText: "different content",
      checksum: "sha256:different",
    })).rejects.toThrow("idempotency key reused");
    const rawCapture = await client.execute("SELECT payload_text FROM proactive_captures WHERE id = 'capture-1'");
    expect(String(rawCapture.rows[0]?.payload_text)).toMatch(/^avxenc:v1:/);
    expect(String(rawCapture.rows[0]?.payload_text)).not.toContain("private source text");

    expect(await repository.purgeEligibleCaptures(ctx, "2026-08-09T00:00:00.000Z")).toBe(0);
    expect((await repository.listCaptures(ctx))[0]!.distillationStatus).toBe("blocked");
    await repository.createClaim(ctx, { id: "memory-1", revisionId: profile.revision.id, claimType: "habit",
      subjectKey: "capture-derived", content: "distilled private source", evidenceCaptureIds: [capture.id],
      sourceGrantIds: [capture.sourceGrantId] });
    await repository.markCaptureDistilled(ctx, capture.id, ["memory-1"]);
    expect(await repository.purgeEligibleCaptures(ctx, "2026-08-09T00:00:00.000Z")).toBe(1);
    const deleted = (await repository.listCaptures(ctx, { includeDeleted: true }))[0]!;
    expect(deleted.distillationStatus).toBe("deleted");
    expect(deleted.payloadText).toBeNull();

    const exported = await repository.exportSnapshot(ctx, { includeRaw: true });
    expect(exported.captures[0]!.payloadText).toBeNull();
  });

  it("encrypts claim/action content and preserves independent action grant revision", async () => {
    const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(3), "test-v1");
    const repository = new SqliteProactiveProfileRepository(db, cipher);
    const profile = await repository.confirmProfile(ctx, {
      id: "profile_action",
      deviceId: "device-a",
      actorId: "usr_pro",
      sources: allGrantedSources("profile_action"),
    });
    const claim = await repository.createClaim(ctx, {
      id: "claim-1",
      revisionId: profile.revision.id,
      claimType: "habit",
      subjectKey: "morning",
      content: "user works best in the morning",
      confidence: 80,
    });
    expect(claim.content).toContain("morning");
    const action = await repository.createAction(ctx, {
      id: "action-1",
      revisionId: profile.revision.id,
      actionType: "browser.open",
      target: "https://example.test",
      request: { url: "https://example.test" },
      authorizationScope: "action.external",
      actionGrantRevision: "grant-v2",
      requestedBy: "usr_pro",
      external: true,
    });
    // 授权指纹由服务端从真实 granted grant 版本派生，客户端传入值被忽略
    expect(action.actionGrantRevision).toMatch(/^action\.external@\d+$/);
    expect(action.actionGrantRevision).not.toBe("grant-v2");
    expect((await repository.updateAction(ctx, action.id, { state: "approved", actorId: "usr_pro" }))?.approvedBy).toBe("usr_pro");
    await repository.updateAction(ctx, action.id, { state: "failed", error: "private target failed" });
    const rawClaim = await client.execute("SELECT subject_key, content, evidence_refs_json FROM proactive_profile_claims WHERE id = 'claim-1'");
    expect(String(rawClaim.rows[0]?.subject_key)).toMatch(/^avxenc:v1:/);
    expect(String(rawClaim.rows[0]?.content)).toMatch(/^avxenc:v1:/);
    expect(String(rawClaim.rows[0]?.evidence_refs_json)).toMatch(/^avxenc:v1:/);
    const rawAction = await client.execute("SELECT target, request_json, error FROM proactive_actions WHERE id = 'action-1'");
    expect(String(rawAction.rows[0]?.target)).toMatch(/^avxenc:v1:/);
    expect(String(rawAction.rows[0]?.request_json)).toMatch(/^avxenc:v1:/);
    expect(String(rawAction.rows[0]?.error)).toMatch(/^avxenc:v1:/);
    expect(String(rawAction.rows[0]?.target)).not.toContain("example.test");
    expect((await repository.listAuditEvents(ctx)).some((event) => event.eventType === "action.approved")).toBe(true);
    const externalGrant = profile.sources.find((source) => source.sourceKey === "action.external")!;
    const deletion = await repository.deleteSourceData(ctx, externalGrant.id, ctx.subjectUserId);
    expect(deletion?.actionsScrubbed).toBe(1);
    expect((await repository.listActions(ctx))[0]?.target).toBe("[deleted]");
  });

  it("persists normalized behavior observations with source provenance", async () => {
    const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(5), "obs-v1");
    const repository = new SqliteProactiveProfileRepository(db, cipher);
    const profile = await repository.confirmProfile(ctx, {
      id: "profile-observation",
      deviceId: "device-a",
      actorId: "usr_pro",
      sources: [
        {
          id: "source-observation",
          sourceKey: "device.app_activity",
          state: "granted",
          mandatory: true,
        },
      ],
    });
    const observation = await repository.createObservation(ctx, {
      id: "observation-1",
      revisionId: profile.revision.id,
      sourceGrantId: profile.sources[0]!.id,
      sourceKey: "device.app_activity",
      observationType: "foreground_window",
      subjectKey: "editor",
      payload: { durationSeconds: 120 },
      checksum: "sha256:observation",
    });
    expect(observation.payload).toEqual({ durationSeconds: 120 });
    const rawObservation = await client.execute("SELECT subject_key, payload_json FROM proactive_observations WHERE id = 'observation-1'");
    expect(String(rawObservation.rows[0]?.subject_key)).toMatch(/^avxenc:v1:/);
    expect(String(rawObservation.rows[0]?.payload_json)).toMatch(/^avxenc:v1:/);
    expect((await repository.listObservations(ctx))[0]).toMatchObject({
      id: "observation-1",
      processingBoundary: "local_only",
      sourceKey: "device.app_activity",
    });
    expect(await repository.listObservations(otherTenant)).toHaveLength(1);
  });

  it("rejects client-forged action grant revisions and enforces the action state machine", async () => {
    const repository = new SqliteProactiveProfileRepository(db);
    const profile = await repository.confirmProfile(ctx, {
      id: "profile_sm",
      deviceId: "device-sm",
      actorId: "usr_pro",
      sources: allGrantedSources("profile_sm"),
    });
    // 客户端传入伪造授权指纹被忽略，改为服务端派生
    const first = await repository.createAction(ctx, {
      id: "action-sm-1",
      revisionId: profile.revision.id,
      actionType: "file.write",
      target: "/tmp/sm.txt",
      request: { content: "x" },
      authorizationScope: "action.local",
      actionGrantRevision: "forged-revision",
      requestedBy: "usr_pro",
    });
    expect(first.actionGrantRevision).toMatch(/^action\.local@\d+$/);
    expect(first.actionGrantRevision).not.toBe("forged-revision");
    // pending 不能直接置 running/executed
    await expect(repository.updateAction(ctx, "action-sm-1", { state: "executed", actorId: "attacker" }))
      .rejects.toThrow(/state transition/);
    // 未批准的 action 也不能直接置 running
    await expect(repository.updateAction(ctx, "action-sm-1", { state: "running", actorId: "attacker" }))
      .rejects.toThrow(/state transition/);
    // 合法路径：pending -> approved -> running -> executed
    await repository.updateAction(ctx, "action-sm-1", { state: "approved", actorId: "usr_pro" });
    await repository.updateAction(ctx, "action-sm-1", { state: "running", actorId: "usr_pro" });
    const executed = await repository.updateAction(ctx, "action-sm-1", { state: "executed", actorId: "usr_pro", outcome: { ok: true } });
    expect(executed?.state).toBe("executed");
    // 终态不可再变
    await expect(repository.updateAction(ctx, "action-sm-1", { state: "revoked", actorId: "usr_pro" }))
      .rejects.toThrow(/state transition/);
  });

  describe("atomic action creation", () => {
    async function creationFixture() {
      const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(5), "creation-test-v1");
      const repository = new SqliteProactiveProfileRepository(db, cipher);
      const profile = await repository.confirmProfile(ctx, { id: "creation-profile", deviceId: "creation-device",
        actorId: ctx.subjectUserId, sources: allGrantedSources("creation-profile") });
      const draft = { id: "created-action", revisionId: profile.revision.id, actionType: "file.write", target: "/private/original-target",
        request: { nested: { content: "private original request" } }, authorizationScope: "action.local",
        actionGrantRevision: "caller-forged", requestedBy: "original-requester" };
      const snapshot = async () => ({
        actions: (await client.execute("SELECT * FROM proactive_actions ORDER BY id")).rows,
        audits: (await client.execute("SELECT * FROM proactive_audit_events ORDER BY id")).rows,
      });
      return { repository, profile, draft, snapshot, source: profile.sources.find(source => source.sourceKey === "action.local")! };
    }

    it.each(["delete", "revoked", "expired"] as const)("does not insert a late private draft after %s wins admission", async change => {
      const { repository, draft, source, snapshot } = await creationFixture();
      // Stop an unprotected outer INSERT just before SQLite executes it. An
      // admitted transactional writer may instead finish before the control.
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>(resolve => { reached = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      let interrupted = false;
      const insert = db.insert.bind(db);
      db.insert = (table => {
        const builder = insert(table);
        if (table !== proactiveActions) return builder;
        const values = builder.values.bind(builder);
        builder.values = ((...args: Parameters<typeof values>) => {
          const query = values(...args);
          const returning = query.returning.bind(query);
          query.returning = ((...columns: Parameters<typeof returning>) => {
            const result = returning(...columns);
            const then = result.then.bind(result);
            result.then = ((fulfilled, rejected) => {
              interrupted = true;
              reached();
              return gate.then(() => then(fulfilled, rejected));
            }) as typeof result.then;
            return result;
          }) as typeof query.returning;
          return query;
        }) as typeof builder.values;
        return builder;
      }) as typeof db.insert;
      const writing = repository.createAction(ctx, draft);
      try {
        await Promise.race([paused, writing]);
        db.insert = insert;
        if (change === "delete") await repository.deleteSourceData(ctx, source.id, ctx.subjectUserId);
        else await repository.updateSourceGrant(ctx, source.id, { state: change, actorId: ctx.subjectUserId });
        const controlled = await snapshot();
        release();
        const [result] = await Promise.allSettled([writing]);
        if (interrupted) {
          expect(result.status).toBe("rejected");
          expect(await snapshot()).toEqual(controlled);
        } else {
          expect(result.status).toBe("fulfilled");
          if (change === "delete") expect((await repository.listActions(ctx))[0]).toMatchObject({
            state: "revoked", target: "[deleted]", request: {}, error: null,
          });
        }
      } finally {
        db.insert = insert;
        release();
        await writing.catch(() => undefined);
      }
    });

    it.each(["delete", "revoked", "expired"] as const)("rejects %s committed before admission to the action writer", async change => {
      const { repository, draft, source, snapshot } = await creationFixture();
      const transaction = db.transaction.bind(db);
      let controlled: Awaited<ReturnType<typeof snapshot>> | undefined;
      db.transaction = async (...args) => {
        db.transaction = transaction;
        if (change === "delete") await repository.deleteSourceData(ctx, source.id, ctx.subjectUserId);
        else await repository.updateSourceGrant(ctx, source.id, { state: change, actorId: ctx.subjectUserId });
        controlled = await snapshot();
        return transaction(...args);
      };
      await expect(repository.createAction(ctx, draft)).rejects.toThrow("action grant missing: action.local");
      expect(controlled).toBeDefined();
      expect(await snapshot()).toEqual(controlled);
    });

    it("rolls back the private draft when its metadata audit fails and permits a clean retry", async () => {
      const { repository, draft, snapshot } = await creationFixture();
      await client.execute("CREATE TRIGGER fail_action_request_audit BEFORE INSERT ON proactive_audit_events WHEN NEW.event_type = 'action.requested' BEGIN SELECT RAISE(ABORT, 'injected_request_audit_failure'); END");
      const before = await snapshot();
      await expect(repository.createAction(ctx, draft)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await client.execute("DROP TRIGGER fail_action_request_audit");
      const created = await repository.createAction(ctx, draft);
      expect(created).toMatchObject({ state: "pending", target: "/private/original-target", request: draft.request });
      const audit = await client.execute({ sql: "SELECT payload_json FROM proactive_audit_events WHERE resource_id = ? AND event_type = 'action.requested'", args: [created.id] });
      expect(audit.rows).toHaveLength(1);
      expect(String(audit.rows[0]!.payload_json)).not.toContain("private");
    });

    it("freezes source scope, target, requester and nested request before awaiting admission", async () => {
      const { repository, draft } = await creationFixture();
      const creating = repository.createAction(ctx, draft);
      draft.authorizationScope = "action.external";
      draft.target = "/private/mutated-target";
      draft.requestedBy = "mutated-requester";
      draft.request.nested.content = "private mutated request";
      expect(await creating).toMatchObject({ authorizationScope: "action.local", actionGrantRevision: "action.local@1",
        target: "/private/original-target", requestedBy: "original-requester", request: { nested: { content: "private original request" } } });
      const audit = await client.execute("SELECT actor_id FROM proactive_audit_events WHERE event_type = 'action.requested'");
      expect(audit.rows[0]?.actor_id).toBe("original-requester");
    });

    it("derives ordered grant revisions and defaults from real grants rather than caller input", async () => {
      const { repository, profile, draft } = await creationFixture();
      const external = profile.sources.find(source => source.sourceKey === "action.external")!;
      await client.execute({ sql: "UPDATE proactive_source_grants SET grant_version = 7 WHERE id = ?", args: [external.id] });
      const created = await repository.createAction(ctx, { ...draft, authorizationScope: "action.external, action.local action.external" });
      expect(created).toMatchObject({ actionGrantRevision: "action.external@7+action.local@1", reversible: true, external: true });
    });

    it.each(["missing", "another-revision"])("rejects an optional lease with %s identity without writes", async kind => {
      const { repository, draft, snapshot } = await creationFixture();
      let activationLeaseId = "missing-lease";
      if (kind === "another-revision") {
        const other = await repository.confirmProfile(ctx, { id: "other-creation-profile", deviceId: "other-device",
          actorId: ctx.subjectUserId, sources: allGrantedSources("other-creation-profile") });
        const lease = await repository.createActivationLease(ctx, { id: "other-lease", revisionId: other.revision.id,
          deviceId: "other-device", epoch: "other-epoch", localReady: true, fullAccessSnapshot: true, actorId: ctx.subjectUserId });
        activationLeaseId = lease.id;
      }
      const before = await snapshot();
      await expect(repository.createAction(ctx, { ...draft, activationLeaseId })).rejects.toThrow("activation lease not found");
      expect(await snapshot()).toEqual(before);
    });

    it("retains pending draft creation for a paused profile and an ended matching lease", async () => {
      const { repository, profile, draft } = await creationFixture();
      const lease = await repository.createActivationLease(ctx, { id: "ended-creation-lease", revisionId: profile.revision.id,
        deviceId: "creation-device", epoch: "creation-epoch", localReady: true, fullAccessSnapshot: true, actorId: ctx.subjectUserId });
      await repository.endActivationLease(ctx, lease.id, "user_requested", ctx.subjectUserId);
      await repository.setDesiredState(ctx, "paused", ctx.subjectUserId, profile.revision.id);
      expect(await repository.createAction(ctx, { ...draft, activationLeaseId: lease.id })).toMatchObject({ state: "pending", activationLeaseId: lease.id });
    });

    it.each(["revision", "source", "nonrequested-source"])("retains the existing %s local processing boundary", async kind => {
      const { repository, profile, draft, source, snapshot } = await creationFixture();
      const sourceId = kind === "nonrequested-source" ? profile.sources.find(item => item.sourceKey === "device.browser_activity")!.id : source.id;
      await client.execute(kind === "revision"
        ? { sql: "UPDATE proactive_profile_revisions SET processing_boundary = 'cloud' WHERE id = ?", args: [profile.revision.id] }
        : { sql: "UPDATE proactive_source_grants SET processing_boundary = 'cloud' WHERE id = ?", args: [sourceId] });
      const before = await snapshot();
      await expect(repository.createAction(ctx, draft)).rejects.toThrow("proactive record is outside the local-only boundary");
      expect(await snapshot()).toEqual(before);
    });

    it("preserves missing-revision precedence over unsupported action scope", async () => {
      const { repository, draft, snapshot } = await creationFixture();
      const before = await snapshot();
      await expect(repository.createAction(ctx, { ...draft, revisionId: "missing-revision", authorizationScope: "unknown.action" }))
        .rejects.toThrow("proactive profile revision not found");
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("atomic action state transitions", () => {
    async function actionFixture(state: "pending" | "approved" | "running" = "pending") {
      const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(4), "action-test-v1");
      const repository = new SqliteProactiveProfileRepository(db, cipher);
      const profile = await repository.confirmProfile(ctx, { id: "atomic-profile", deviceId: "atomic-device",
        actorId: ctx.subjectUserId, sources: allGrantedSources("atomic-profile") });
      const action = await repository.createAction(ctx, { id: "atomic-action", revisionId: profile.revision.id,
        actionType: "file.write", target: "/private/target", request: { value: "private request" },
        authorizationScope: "action.local", actionGrantRevision: "ignored", requestedBy: ctx.subjectUserId });
      if (state !== "pending") await repository.updateAction(ctx, action.id, { state: "approved", actorId: "approver" });
      if (state === "running") await repository.updateAction(ctx, action.id, { state: "running" });
      const snapshot = async () => ({
        action: (await client.execute({ sql: "SELECT * FROM proactive_actions WHERE id = ?", args: [action.id] })).rows,
        audits: (await client.execute({ sql: "SELECT * FROM proactive_audit_events WHERE resource_id = ? ORDER BY id", args: [action.id] })).rows,
      });
      return { repository, action, source: profile.sources.find(source => source.sourceKey === "action.local")!, snapshot };
    }

    it("accepts only one of two incompatible transitions from the same state", async () => {
      const { repository, action } = await actionFixture();
      const results = await Promise.allSettled([
        repository.updateAction(ctx, action.id, { state: "approved", actorId: "approver" }),
        repository.updateAction(ctx, action.id, { state: "denied", actorId: "denier" }),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(result => result.status === "rejected");
      expect(rejected).toMatchObject({ status: "rejected", reason: { message: expect.stringMatching(/state transition/) } });
      const audits = await client.execute({ sql: "SELECT event_type FROM proactive_audit_events WHERE resource_id = ? AND event_type IN ('action.approved', 'action.denied')", args: [action.id] });
      expect(audits.rows).toHaveLength(1);
    });

    it.each(["running", "failed"] as const)("rolls back %s and private output when its metadata audit fails", async state => {
      const { repository, action, snapshot } = await actionFixture("approved");
      await client.execute(`CREATE TRIGGER fail_action_audit BEFORE INSERT ON proactive_audit_events WHEN NEW.event_type = 'action.${state}' BEGIN SELECT RAISE(ABORT, 'injected_action_audit_failure'); END`);
      const before = await snapshot();
      await expect(repository.updateAction(ctx, action.id, { state, outcome: { value: "private late outcome" }, error: "private late error" }))
        .rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await client.execute("DROP TRIGGER fail_action_audit");
      expect(await repository.updateAction(ctx, action.id, { state })).toMatchObject({ state });
    });

    it.each([
      ["approved", "running"], ["approved", "failed"], ["running", "executed"], ["running", "failed"],
    ] as const)("keeps source deletion scrubbing intact when %s -> %s races it", async (initial, state) => {
      const { repository, action, source } = await actionFixture(initial);
      const [deleted, transitioned] = await Promise.allSettled([
        repository.deleteSourceData(ctx, source.id, ctx.subjectUserId),
        repository.updateAction(ctx, action.id, { state, outcome: { value: "private late outcome" }, error: "private late error" }),
      ]);
      expect(deleted).toMatchObject({ status: "fulfilled", value: { actionsScrubbed: 1 } });
      if (transitioned.status === "rejected") expect(transitioned.reason).toHaveProperty("message", expect.stringMatching(/state transition/));
      const [saved] = await repository.listActions(ctx);
      expect(saved).toMatchObject({ target: "[deleted]", request: {}, error: null });
      expect(saved!.outcome).toBeUndefined();
      expect(state === "running" ? ["revoked"] : ["revoked", state]).toContain(saved!.state);
    });

    it("freezes transition, actor and nested output before awaiting the writer", async () => {
      const { repository, action } = await actionFixture("running");
      const input: Parameters<typeof repository.updateAction>[2] = { state: "executed", actorId: "original-actor",
        outcome: { nested: { value: "original outcome" } }, error: null };
      const transition = repository.updateAction(ctx, action.id, input);
      input.state = "failed";
      input.actorId = "mutated-actor";
      (input.outcome as { nested: { value: string } }).nested.value = "mutated outcome";
      input.error = "mutated error";
      expect(await transition).toMatchObject({ state: "executed", outcome: { nested: { value: "original outcome" } }, error: null });
      const audit = await client.execute({ sql: "SELECT actor_id, payload_json FROM proactive_audit_events WHERE resource_id = ? AND event_type = 'action.executed'", args: [action.id] });
      expect(audit.rows).toEqual([expect.objectContaining({ actor_id: "original-actor", payload_json: "{}" })]);
    });

    it.each([{ outcome: {} }, { outcome: [] }, { outcome: "" }, { outcome: false }, { outcome: 0 }, { error: " " }])(
      "rejects non-null outcome or nonempty error in revocation without using target sentinels: %j", async extra => {
        const { repository, action, snapshot } = await actionFixture("approved");
        await repository.updateAction(ctx, action.id, { state: "failed" });
        const before = await snapshot();
        await expect(repository.updateAction(ctx, action.id, { state: "revoked", ...extra }))
          .rejects.toThrow("revocation cannot introduce outcome or error content");
        expect(await snapshot()).toEqual(before);
      },
    );

    it("allows repository revocation to retain existing content when both fields are omitted", async () => {
      const { repository, action } = await actionFixture("approved");
      await repository.updateAction(ctx, action.id, { state: "failed", outcome: { prior: "retained" }, error: "prior error" });
      expect(await repository.updateAction(ctx, action.id, { state: "revoked" })).toMatchObject({
        state: "revoked", outcome: { prior: "retained" }, error: "prior error",
      });
    });

    it("allows empty repository error content and explicit null outcome on revocation", async () => {
      const { repository, action } = await actionFixture("approved");
      await repository.updateAction(ctx, action.id, { state: "failed", outcome: { prior: "cleared" }, error: "prior error" });
      expect(await repository.updateAction(ctx, action.id, { state: "revoked", outcome: null, error: "" })).toMatchObject({
        state: "revoked", outcome: null, error: "",
      });
    });

    it("returns null for a missing action without creating an audit", async () => {
      const { repository, snapshot } = await actionFixture();
      const before = await snapshot();
      expect(await repository.updateAction(ctx, "missing-action", { state: "approved" })).toBeNull();
      expect(await repository.updateAction(ctx, "missing-action", { state: "revoked", outcome: { ignored: true }, error: "ignored" })).toBeNull();
      expect(await snapshot()).toEqual(before);
      expect((await client.execute("SELECT id FROM proactive_audit_events WHERE resource_id = 'missing-action'")).rows).toEqual([]);
    });
  });
});
