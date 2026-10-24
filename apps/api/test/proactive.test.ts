import { FULL_PROFILE_SOURCE_MANIFEST } from "@aervox/schema";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it } from "vitest";
import {
  createInMemoryDatabase,
  createProactiveVaultCipher,
  type AervoxDatabase,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { buildApp } from "./app-fixture.js";

describe("CAP-033 proactive API", () => {
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];

  beforeEach(async () => {
    const result = await createInMemoryDatabase();
    db = result.db;
    client = result.client;
    cleanup = result.cleanup;
    app = (await buildApp({ db, client })).app;
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  const headers = {
    "x-workspace-id": "ws_api_pro",
    "x-user-id": "usr_api_pro",
    "x-actor-id": "usr_api_pro",
  };

  function grantedSources(profileId: string) {
    return FULL_PROFILE_SOURCE_MANIFEST.map((source, index) => ({
      id: `${profileId}_source_${index}`,
      sourceKey: source.sourceKey,
      state: "granted",
      purpose: source.purpose,
      osCapability: source.osCapability,
    }));
  }

  async function sourceIngest(kind: "capture" | "observation", suffix: string) {
    const profileId = `ingest-${kind}-${suffix}`;
    const profile = await app.inject({ method: "POST", url: "/v1/proactive/authorize", headers,
      payload: { id: profileId, deviceId: "device-api", fullAccessConfirmed: true, sources: grantedSources(profileId) } });
    expect(profile.statusCode).toBe(201);
    const revisionId = profile.json().revision.id;
    const source = profile.json().sources[0];
    const input = { id: `${kind}-${suffix}`, revisionId, sourceGrantId: source.id, sourceKey: source.sourceKey,
      checksum: `sha256:${kind}-${suffix}`,
      ...(kind === "capture" ? { contentType: "text/plain", payloadText: "PRIVATE_CAPTURE_INPUT" }
        : { observationType: "activity", subjectKey: "private-subject", payload: { value: "PRIVATE_OBSERVATION_INPUT" } }),
    };
    const state = async () => ({
      captures: (await client.execute("SELECT * FROM proactive_captures ORDER BY id")).rows,
      observations: (await client.execute("SELECT * FROM proactive_observations ORDER BY id")).rows,
      audits: (await client.execute("SELECT * FROM proactive_audit_events ORDER BY id")).rows,
    });
    return { path: `/v1/proactive/${kind === "capture" ? "captures" : "observations"}`, input, source, revisionId, state };
  }

  describe.each(["capture", "observation"] as const)("%s ingestion source qualification", kind => {
    it.each(["revoked", "expired", "pause"] as const)(
      "rejects both new and same-id requests after %s without payload disclosure or audit writes", async change => {
        const f = await sourceIngest(kind, change);
        expect((await app.inject({ method: "POST", url: f.path, headers, payload: f.input })).statusCode).toBe(201);
        const control = change === "pause"
          ? await app.inject({ method: "POST", url: "/v1/proactive/desired-state", headers,
            payload: { revisionId: f.revisionId, desiredState: "paused" } })
          : await app.inject({ method: "PATCH", url: `/v1/proactive/sources/${f.source.id}`, headers,
            payload: { state: change } });
        expect(control.statusCode).toBe(200);
        const before = await f.state();
        for (const id of [`${f.input.id}-late`, f.input.id]) {
          const response = await app.inject({ method: "POST", url: f.path, headers, payload: { ...f.input, id } });
          expect(response.statusCode).toBe(409);
          expect(response.json().code).toBe("CONFLICT");
          expect(response.body).not.toContain("PRIVATE_CAPTURE_INPUT");
          expect(response.body).not.toContain("PRIVATE_OBSERVATION_INPUT");
          expect(await f.state()).toEqual(before);
        }
      },
    );

    it("rolls back the write when its metadata audit fails, then retries once without duplicating the audit", async () => {
      const f = await sourceIngest(kind, "audit-failure");
      const eventType = kind === "capture" ? "capture.ingested" : "observation.normalized";
      await client.execute(`CREATE TRIGGER fail_ingest_audit BEFORE INSERT ON proactive_audit_events WHEN NEW.event_type = '${eventType}' BEGIN SELECT RAISE(ABORT, 'injected_ingest_audit_failure'); END`);
      const before = await f.state();
      const failed = await app.inject({ method: "POST", url: f.path, headers, payload: f.input });
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain("PRIVATE_CAPTURE_INPUT");
      expect(failed.body).not.toContain("PRIVATE_OBSERVATION_INPUT");
      expect(await f.state()).toEqual(before);
      await client.execute("DROP TRIGGER fail_ingest_audit");
      const accepted = await app.inject({ method: "POST", url: f.path, headers, payload: f.input });
      expect(accepted.statusCode).toBe(201);
      const saved = await f.state();
      const retried = await app.inject({ method: "POST", url: f.path, headers, payload: f.input });
      expect(retried.statusCode).toBe(201);
      expect(retried.json()).toEqual(accepted.json());
      expect(await f.state()).toEqual(saved);
      const audits = (await client.execute({ sql: "SELECT payload_json FROM proactive_audit_events WHERE resource_id = ? AND event_type = ?",
        args: [f.input.id, eventType] })).rows;
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits)).not.toContain("PRIVATE_CAPTURE_INPUT");
      expect(JSON.stringify(audits)).not.toContain("PRIVATE_OBSERVATION_INPUT");
      const conflict = await app.inject({ method: "POST", url: f.path, headers, payload: { ...f.input, checksum: "sha256:different-intent" } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("CONFLICT");
      expect(await f.state()).toEqual(saved);
    });
  });

  it.each([false, true])("rejects a deleted capture retry even when its source is regranted=%s", async regranted => {
    const f = await sourceIngest("capture", `deleted-${regranted}`);
    expect((await app.inject({ method: "POST", url: f.path, headers, payload: f.input })).statusCode).toBe(201);
    const deleted = await app.inject({ method: "DELETE", url: `/v1/proactive/sources/${f.source.id}/data`, headers });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().capturesScrubbed).toBe(1);
    if (regranted) expect((await app.inject({ method: "PATCH", url: `/v1/proactive/sources/${f.source.id}`, headers,
      payload: { state: "granted" } })).statusCode).toBe(200);
    const before = await f.state();
    const response = await app.inject({ method: "POST", url: f.path, headers, payload: f.input });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("CONFLICT");
    expect(response.body).not.toContain("PRIVATE_CAPTURE_INPUT");
    expect(await f.state()).toEqual(before);
    expect(before.captures[0]).toMatchObject({ distillation_status: "deleted", payload_text: null, payload_json: null });
  });

  it("requires the device token when the local Vault is protected", async () => {
    await app.close();
    const token = "device-token-1234567890-abcdefghijk";
    app = (await buildApp({ db, client, proactiveAccessToken: token })).app;
    const denied = await app.inject({ method: "GET", url: "/v1/proactive/manifest", headers });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error).toBe("proactive_device_auth_required");

    const allowed = await app.inject({
      method: "GET",
      url: "/v1/proactive/manifest",
      headers: { ...headers, "x-aervox-proactive-token": token },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().processingBoundary).toBe("local_only");
  });

  it("requires an explicit full_access confirmation and exposes local status", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/v1/proactive/authorize",
      headers,
      payload: { id: "profile-api-1", deviceId: "device-api", acknowledged: true },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error).toBe("full_access_confirmation_required");

    const authorized = await app.inject({
      method: "POST",
      url: "/v1/proactive/authorize",
      headers,
      payload: {
        id: "profile-api-1",
        deviceId: "device-api",
        acknowledged: true,
        fullAccessConfirmed: true,
      },
    });
    expect(authorized.statusCode).toBe(201);
    expect(authorized.json().sources).toHaveLength(FULL_PROFILE_SOURCE_MANIFEST.length);
    expect(authorized.json().sources[0].state).toBe("requested");

    const status = await app.inject({ method: "GET", url: "/v1/proactive/status", headers });
    expect(status.statusCode).toBe(200);
    expect(status.json().processingBoundary).toBe("local_only");
    expect(status.json().effectiveState).toBe("suspended");
  });

  it("supports explicit source grants, activation and redacted captures", async () => {
    const profile = await app.inject({
      method: "POST",
      url: "/v1/proactive/authorize",
      headers,
      payload: {
        id: "profile-api-2",
        deviceId: "device-api",
        fullAccessConfirmed: true,
        sources: grantedSources("profile-api-2"),
      },
    });
    expect(profile.statusCode).toBe(201);
    const revisionId = profile.json().revision.id;
    const sourceGrantId = profile.json().sources[0].id;

    const lease = await app.inject({
      method: "POST",
      url: "/v1/proactive/activation",
      headers,
      payload: {
        id: "lease-api-2",
        revisionId,
        deviceId: "device-api",
        epoch: "epoch-api-2",
        localReady: true,
        fullAccessSnapshot: true,
      },
    });
    expect(lease.statusCode).toBe(201);

    const status = await app.inject({ method: "GET", url: "/v1/proactive/status", headers });
    expect(status.json().effectiveState).toBe("active");

    const capture = await app.inject({
      method: "POST",
      url: "/v1/proactive/captures",
      headers,
      payload: {
        id: "capture-api-2",
        revisionId,
        sourceGrantId,
        sourceKey: profile.json().sources[0].sourceKey,
        contentType: "text/plain",
        payloadText: "private text",
      },
    });
    expect(capture.statusCode).toBe(201);
    expect(capture.json().payloadText).toBeUndefined();

    const raw = await app.inject({ method: "GET", url: "/v1/proactive/captures?includeRaw=true", headers });
    expect(raw.statusCode).toBe(200);
    expect(raw.json().items[0].payloadText).toBe("private text");

    await app.inject({
      method: "POST",
      url: "/v1/proactive/observations",
      headers,
      payload: {
        id: "observation-api-2",
        revisionId,
        sourceGrantId,
        sourceKey: profile.json().sources[0].sourceKey,
        observationType: "activity",
        subjectKey: "private-subject",
        payload: { value: "private observation" },
        checksum: "sha256:observation-api-2",
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/proactive/claims",
      headers,
      payload: {
        id: "claim-api-2",
        revisionId,
        claimType: "habit",
        subjectKey: "private-subject",
        content: "private profile claim",
        evidenceCaptureIds: ["capture-api-2"],
        sourceGrantIds: [sourceGrantId],
      },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/proactive/sources/${sourceGrantId}/data`,
      headers,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ capturesScrubbed: 1, observationsDeleted: 1, claimsDeleted: 1 });
    const deletedCaptures = await app.inject({
      method: "GET",
      url: "/v1/proactive/captures?includeRaw=true&includeDeleted=true",
      headers,
    });
    expect(deletedCaptures.json().items[0]).toMatchObject({ distillationStatus: "deleted", payloadText: null });
    expect((await app.inject({ method: "GET", url: "/v1/proactive/observations", headers })).json().items).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/v1/proactive/claims", headers })).json().items).toHaveLength(0);
  });

  it.each(["delete", "revoked", "expired", "pause", "missing-source", "wrong-source"])(
    "rejects a source-derived claim after %s without durable content or audit writes", async change => {
      const profileId = `claim-source-${change}`;
      const profile = await app.inject({ method: "POST", url: "/v1/proactive/authorize", headers,
        payload: { id: profileId, deviceId: "device-api", fullAccessConfirmed: true, sources: grantedSources(profileId) } });
      expect(profile.statusCode).toBe(201);
      const revisionId = profile.json().revision.id;
      const [source, other] = profile.json().sources;
      const captureId = `capture-${change}`;
      const captured = await app.inject({ method: "POST", url: "/v1/proactive/captures", headers,
        payload: { id: captureId, revisionId, sourceGrantId: source.id, sourceKey: source.sourceKey,
          contentType: "text/plain", payloadText: "private captured content" } });
      expect(captured.statusCode).toBe(201);
      const draft = { id: `claim-${change}`, revisionId, claimType: "habit", subjectKey: "private-subject",
        content: "late private derived content", evidenceCaptureIds: [captureId], sourceGrantIds: [source.id] };
      const accepted = await app.inject({ method: "POST", url: "/v1/proactive/claims", headers,
        payload: { ...draft, id: `accepted-${change}` } });
      expect(accepted.statusCode).toBe(201);
      if (change === "delete") {
        expect((await app.inject({ method: "DELETE", url: `/v1/proactive/sources/${source.id}/data`, headers })).statusCode).toBe(200);
      } else if (change === "pause") {
        expect((await app.inject({ method: "POST", url: "/v1/proactive/desired-state", headers,
          payload: { revisionId, desiredState: "paused" } })).statusCode).toBe(200);
      } else if (change === "revoked" || change === "expired") {
        expect((await app.inject({ method: "PATCH", url: `/v1/proactive/sources/${source.id}`, headers,
          payload: { state: change } })).statusCode).toBe(200);
      }
      const readState = async () => ({
        claims: (await client.execute("SELECT * FROM proactive_profile_claims ORDER BY id")).rows,
        audits: (await client.execute("SELECT * FROM proactive_audit_events ORDER BY id")).rows,
      });
      const before = await readState();
      const response = await app.inject({ method: "POST", url: "/v1/proactive/claims", headers, payload: {
        ...draft, ...(change === "missing-source" ? { sourceGrantIds: [] }
          : change === "wrong-source" ? { sourceGrantIds: [other.id] } : {}),
      } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "CONFLICT", message: "claim_source_unavailable" });
      expect(response.body).not.toContain(draft.content);
      expect(await readState()).toEqual(before);
      expect((await client.execute({ sql: "SELECT id FROM proactive_profile_claims WHERE id = ?", args: [draft.id] })).rows).toEqual([]);
    },
  );

  it("keeps explicitly unlinked user claims available while the proactive profile is paused", async () => {
    const profileId = "manual-claim-profile";
    const profile = await app.inject({ method: "POST", url: "/v1/proactive/authorize", headers,
      payload: { id: profileId, deviceId: "device-api", fullAccessConfirmed: true, sources: grantedSources(profileId) } });
    const revisionId = profile.json().revision.id;
    expect((await app.inject({ method: "POST", url: "/v1/proactive/desired-state", headers,
      payload: { revisionId, desiredState: "paused" } })).statusCode).toBe(200);
    const response = await app.inject({ method: "POST", url: "/v1/proactive/claims", headers,
      payload: { id: "manual-unlinked", revisionId, claimType: "habit", subjectKey: "user-authored",
        state: "user_asserted", content: "explicit manual input", evidenceCaptureIds: [], sourceGrantIds: [] } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ state: "user_asserted", content: "explicit manual input", evidenceCaptureIds: [], sourceGrantIds: [] });
  });

  it("E3 开关开启时校验 activation 并把 capture 双写为最小感知事件", async () => {
    await app.close();
    app = (await buildApp({
      db,
      client,
      proactiveFeatureFlags: new Set(["perception_events"]),
    })).app;
    const profile = await app.inject({
      method: "POST",
      url: "/v1/proactive/authorize",
      headers,
      payload: {
        id: "profile-api-events",
        deviceId: "device-events",
        fullAccessConfirmed: true,
        sources: grantedSources("profile-api-events"),
      },
    });
    const revisionId = profile.json().revision.id;
    const source = profile.json().sources.find((item: {sourceKey: string}) => item.sourceKey === "system.idle_state");
    await app.inject({
      method: "POST",
      url: "/v1/proactive/activation",
      headers,
      payload: {
        id: "lease-api-events",
        revisionId,
        deviceId: "device-events",
        epoch: "epoch-events",
        localReady: true,
        fullAccessSnapshot: true,
      },
    });
    const capture = await app.inject({
      method: "POST",
      url: "/v1/proactive/captures",
      headers,
      payload: {
        id: "capture-api-events",
        revisionId,
        sourceGrantId: source.id,
        sourceKey: source.sourceKey,
        contentType: "application/json",
        payload: {idleSeconds: 10, presenceState: "active", secret: "must-not-enter-event"},
        deviceId: "device-events",
        activationEpoch: "epoch-events",
      },
    });
    expect(capture.statusCode).toBe(201);
    expect(capture.json().eventSequence).toBe(1);
    const {SqlitePerceptionEventRepository} = await import("@aervox/repositories");
    const events = await new SqlitePerceptionEventRepository(db).replay(headers as never, 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({idleSeconds: 10, presenceState: "active"});
    expect(events[0]?.payload).not.toHaveProperty("secret");
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/proactive/sources/${encodeURIComponent(source.id)}/data`,
      headers,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().eventsDeleted).toBe(1);
    expect(await new SqlitePerceptionEventRepository(db).replay(headers as never, 1)).toEqual([]);
  });

  it("derives mandatory from the server manifest and stays active while platform-pending sources wait", async () => {
    const pending = new Set(["external.communication", "device.location", "device.sensors", "restricted.profile"]);
    const profile = await app.inject({
      method: "POST",
      url: "/v1/proactive/authorize",
      headers,
      payload: {
        id: "profile-api-pending",
        deviceId: "device-api",
        fullAccessConfirmed: true,
        // 客户端谎报 mandatory=true 也不能把待平台接入来源重新变成必需：
        // mandatory 由服务端 manifest 派生。
        sources: FULL_PROFILE_SOURCE_MANIFEST.map((source, index) => ({
          id: `profile-api-pending-source-${index}`,
          sourceKey: source.sourceKey,
          purpose: source.purpose,
          osCapability: source.osCapability,
          state: pending.has(source.sourceKey) ? "requested" : "granted",
          mandatory: true,
        })),
      },
    });
    expect(profile.statusCode).toBe(201);
    const grantedSource = profile.json().sources.find((source: {sourceKey: string; state: string}) => source.state === "granted");

    const lease = await app.inject({
      method: "POST",
      url: "/v1/proactive/activation",
      headers,
      payload: {
        id: "lease-api-pending",
        revisionId: profile.json().revision.id,
        deviceId: "device-api",
        epoch: "epoch-api-pending",
        localReady: true,
        fullAccessSnapshot: true,
      },
    });
    expect(lease.statusCode).toBe(201);

    const status = await app.inject({ method: "GET", url: "/v1/proactive/status", headers });
    expect(status.json().effectiveState).toBe("active");
    // mandatory 由服务端 manifest 派生；直接按 manifest 的 mandatory 标志推导
    //（待平台接入的非必选源不在 pending 集合内时公式依然成立）
    const mandatoryManifest = FULL_PROFILE_SOURCE_MANIFEST.filter((source) => source.mandatory);
    expect(status.json().mandatorySources).toMatchObject({
      total: mandatoryManifest.length,
      granted: mandatoryManifest.length,
      missing: [],
    });
    expect(grantedSource).toBeTruthy();
  });

  it("exports a checksummed local snapshot and tracks action grant revisions", async () => {
    const profile = await app.inject({
      method: "POST",
      url: "/v1/proactive/authorize",
      headers,
      payload: {
        id: "profile-api-3",
        deviceId: "device-api",
        fullAccessConfirmed: true,
        sources: grantedSources("profile-api-3"),
      },
    });
    const revisionId = profile.json().revision.id;
    const action = await app.inject({
      method: "POST",
      url: "/v1/proactive/actions",
      headers,
      payload: {
        id: "action-api-3",
        revisionId,
        actionType: "file.write",
        target: "/tmp/example.txt",
        request: { content: "hello" },
        authorizationScope: "action.local",
        actionGrantRevision: "actions-v1",
      },
    });
    expect(action.statusCode).toBe(201);
    // 服务端从真实 granted grant 派生授权指纹，客户端传入值被忽略
    expect(action.json().actionGrantRevision).toMatch(/^action\.local@\d+$/);
    expect(action.json().actionGrantRevision).not.toBe("actions-v1");

    const exported = await app.inject({ method: "GET", url: "/v1/proactive/export", headers });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(exported.json().data.processingBoundary).toBeUndefined();
    expect(exported.json().data.actions[0].actionGrantRevision).toMatch(/^action\.local@\d+$/);
    expect(exported.json().data.actions[0].actionGrantRevision).not.toBe("actions-v1");
  });

  it("keeps proactive rows in an injected local vault instead of the main database", async () => {
    const main = await createInMemoryDatabase();
    const vault = await createInMemoryDatabase();
    const isolated = await buildApp({
      db: main.db,
      client: main.client,
      proactiveDb: vault.db,
      proactiveClient: vault.client,
      proactiveCipher: createProactiveVaultCipher(new Uint8Array(32).fill(8), "api-vault"),
      proactiveAccessToken: null,
    });
    try {
      const response = await isolated.app.inject({
        method: "POST",
        url: "/v1/proactive/authorize",
        headers,
        payload: { id: "profile-vault", deviceId: "device-vault", fullAccessConfirmed: true },
      });
      expect(response.statusCode).toBe(201);
      const mainRows = await main.client.execute("SELECT count(*) AS count FROM proactive_profile_revisions");
      const vaultRows = await vault.client.execute("SELECT count(*) AS count FROM proactive_profile_revisions");
      expect(Number(mainRows.rows[0]?.count ?? 0)).toBe(0);
      expect(Number(vaultRows.rows[0]?.count ?? 0)).toBe(1);
      const raw = await vault.client.execute("SELECT manifest_json FROM proactive_profile_revisions WHERE id = 'profile-vault'");
      expect(String(raw.rows[0]?.manifest_json)).toMatch(/^avxenc:v1:/);
    } finally {
      await isolated.app.close();
      await main.cleanup();
      await vault.cleanup();
    }
  });
});
