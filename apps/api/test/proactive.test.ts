import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  createProactiveVaultCipher,
  FULL_PROFILE_SOURCE_MANIFEST,
  type AervoxDatabase,
} from "@aervox/database";
import type { Client } from "@libsql/client";
import { buildApp } from "../src/app.js";

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
    expect(status.json().mandatorySources).toMatchObject({
      total: FULL_PROFILE_SOURCE_MANIFEST.length - pending.size,
      granted: FULL_PROFILE_SOURCE_MANIFEST.length - pending.size,
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
