import { describe, expect, it, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  FULL_PROFILE_SOURCE_MANIFEST,
  SqliteProactiveProfileRepository,
  createProactiveVaultCipher,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("CAP-033 proactive profile repository", () => {
  let db: AervoxDatabase;
  let client: Client;
  const tenant: TenantContext = { workspaceId: "ws_pro", subjectUserId: "usr_pro" };
  const otherTenant: TenantContext = { workspaceId: "ws_other", subjectUserId: "usr_other" };

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
    const result = await repository.confirmProfile(tenant, {
      id: "profile_requested",
      deviceId: "device-a",
      actorId: "usr_pro",
    });
    expect(result.sources).toHaveLength(FULL_PROFILE_SOURCE_MANIFEST.length);
    expect(result.sources.every((source) => source.state === "requested")).toBe(true);
    expect((await repository.getEffectiveStatus(tenant)).effectiveState).toBe("suspended");
    expect(await repository.getRevision(otherTenant)).toBeNull();
    expect(await repository.listSourceGrants(otherTenant)).toHaveLength(0);
  });

  it("derives active only after all source grants, local readiness and full access snapshot", async () => {
    const repository = new SqliteProactiveProfileRepository(db);
    const result = await repository.confirmProfile(tenant, {
      id: "profile_active",
      deviceId: "device-a",
      actorId: "usr_pro",
      sources: allGrantedSources("profile_active"),
    });
    const lease = await repository.createActivationLease(tenant, {
      id: "lease_active",
      revisionId: result.revision.id,
      deviceId: "device-a",
      epoch: "epoch-a",
      localReady: true,
      fullAccessSnapshot: true,
      actorId: "usr_pro",
    });
    expect(lease.status).toBe("active");
    const status = await repository.getEffectiveStatus(tenant);
    expect(status.effectiveState).toBe("active");
    expect(status.mandatorySources.granted).toBe(FULL_PROFILE_SOURCE_MANIFEST.length);

    await repository.updateSourceGrant(tenant, result.sources[0]!.id, {
      state: "revoked",
      actorId: "usr_pro",
    });
    expect((await repository.getEffectiveStatus(tenant)).effectiveState).toBe("limited");
  });

  it("derives active once mandatory sources are granted even when platform-pending sources wait", async () => {
    const repository = new SqliteProactiveProfileRepository(db);
    // 未显式传入 sources 时，mandatory 由服务端 manifest 派生：
    // 通信/位置/传感器/敏感资料 4 项待平台接入，不计入必需集合。
    const pending = new Set(["external.communication", "device.location", "device.sensors", "restricted.profile"]);
    const fallback = await repository.confirmProfile(tenant, {
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
    expect(status.effectiveState).toBe("active");
    expect(status.mandatorySources).toMatchObject({total: FULL_PROFILE_SOURCE_MANIFEST.length - pending.size, granted: FULL_PROFILE_SOURCE_MANIFEST.length - pending.size, missing: []});
  });

  it("retains raw captures for seven days and blocks expiry until memory distillation", async () => {
    const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(9), "test-v1");
    const repository = new SqliteProactiveProfileRepository(db, cipher);
    const profile = await repository.confirmProfile(tenant, {
      id: "profile_capture",
      deviceId: "device-a",
      actorId: "usr_pro",
      sources: allGrantedSources("profile_capture"),
    });
    const capture = await repository.createCapture(tenant, {
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
    await expect(repository.createCapture(tenant, {
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
    await expect(repository.createCapture(tenant, {
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

    expect(await repository.purgeEligibleCaptures(tenant, "2026-08-09T00:00:00.000Z")).toBe(0);
    expect((await repository.listCaptures(tenant))[0]!.distillationStatus).toBe("blocked");
    await repository.markCaptureDistilled(tenant, capture.id, ["memory-1"]);
    expect(await repository.purgeEligibleCaptures(tenant, "2026-08-09T00:00:00.000Z")).toBe(1);
    const deleted = (await repository.listCaptures(tenant, { includeDeleted: true }))[0]!;
    expect(deleted.distillationStatus).toBe("deleted");
    expect(deleted.payloadText).toBeNull();

    const exported = await repository.exportSnapshot(tenant, { includeRaw: true });
    expect(exported.captures[0]!.payloadText).toBeNull();
  });

  it("encrypts claim/action content and preserves independent action grant revision", async () => {
    const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(3), "test-v1");
    const repository = new SqliteProactiveProfileRepository(db, cipher);
    const profile = await repository.confirmProfile(tenant, {
      id: "profile_action",
      deviceId: "device-a",
      actorId: "usr_pro",
      sources: allGrantedSources("profile_action"),
    });
    const claim = await repository.createClaim(tenant, {
      id: "claim-1",
      revisionId: profile.revision.id,
      claimType: "habit",
      subjectKey: "morning",
      content: "user works best in the morning",
      confidence: 80,
    });
    expect(claim.content).toContain("morning");
    const action = await repository.createAction(tenant, {
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
    expect((await repository.updateAction(tenant, action.id, { state: "approved", actorId: "usr_pro" }))?.approvedBy).toBe("usr_pro");
    await repository.updateAction(tenant, action.id, { state: "failed", error: "private target failed" });
    const rawClaim = await client.execute("SELECT subject_key, content, evidence_refs_json FROM proactive_profile_claims WHERE id = 'claim-1'");
    expect(String(rawClaim.rows[0]?.subject_key)).toMatch(/^avxenc:v1:/);
    expect(String(rawClaim.rows[0]?.content)).toMatch(/^avxenc:v1:/);
    expect(String(rawClaim.rows[0]?.evidence_refs_json)).toMatch(/^avxenc:v1:/);
    const rawAction = await client.execute("SELECT target, request_json, error FROM proactive_actions WHERE id = 'action-1'");
    expect(String(rawAction.rows[0]?.target)).toMatch(/^avxenc:v1:/);
    expect(String(rawAction.rows[0]?.request_json)).toMatch(/^avxenc:v1:/);
    expect(String(rawAction.rows[0]?.error)).toMatch(/^avxenc:v1:/);
    expect(String(rawAction.rows[0]?.target)).not.toContain("example.test");
    expect((await repository.listAuditEvents(tenant)).some((event) => event.eventType === "action.approved")).toBe(true);
    const externalGrant = profile.sources.find((source) => source.sourceKey === "action.external")!;
    const deletion = await repository.deleteSourceData(tenant, externalGrant.id, tenant.subjectUserId);
    expect(deletion?.actionsScrubbed).toBe(1);
    expect((await repository.listActions(tenant))[0]?.target).toBe("[deleted]");
  });

  it("persists normalized behavior observations with source provenance", async () => {
    const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(5), "obs-v1");
    const repository = new SqliteProactiveProfileRepository(db, cipher);
    const profile = await repository.confirmProfile(tenant, {
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
    const observation = await repository.createObservation(tenant, {
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
    expect((await repository.listObservations(tenant))[0]).toMatchObject({
      id: "observation-1",
      processingBoundary: "local_only",
      sourceKey: "device.app_activity",
    });
    expect(await repository.listObservations(otherTenant)).toHaveLength(0);
  });

  it("rejects client-forged action grant revisions and enforces the action state machine", async () => {
    const repository = new SqliteProactiveProfileRepository(db);
    const profile = await repository.confirmProfile(tenant, {
      id: "profile_sm",
      deviceId: "device-sm",
      actorId: "usr_pro",
      sources: allGrantedSources("profile_sm"),
    });
    // 客户端传入伪造授权指纹被忽略，改为服务端派生
    const first = await repository.createAction(tenant, {
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
    await expect(repository.updateAction(tenant, "action-sm-1", { state: "executed", actorId: "attacker" }))
      .rejects.toThrow(/state transition/);
    // 未批准的 action 也不能直接置 running
    await expect(repository.updateAction(tenant, "action-sm-1", { state: "running", actorId: "attacker" }))
      .rejects.toThrow(/state transition/);
    // 合法路径：pending -> approved -> running -> executed
    await repository.updateAction(tenant, "action-sm-1", { state: "approved", actorId: "usr_pro" });
    await repository.updateAction(tenant, "action-sm-1", { state: "running", actorId: "usr_pro" });
    const executed = await repository.updateAction(tenant, "action-sm-1", { state: "executed", actorId: "usr_pro", outcome: { ok: true } });
    expect(executed?.state).toBe("executed");
    // 终态不可再变
    await expect(repository.updateAction(tenant, "action-sm-1", { state: "revoked", actorId: "usr_pro" }))
      .rejects.toThrow(/state transition/);
  });
});
