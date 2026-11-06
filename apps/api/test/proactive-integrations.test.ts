import { FULL_PROFILE_SOURCE_MANIFEST } from "@aervox/schema";
import {
  createServer,
  type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi } from "vitest";
import {
  createInMemoryDatabase,
  SqliteProactiveIntelligenceRepository,
  type AervoxDatabase,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { buildApp } from "./app-fixture.js";

const headers = {
  "x-workspace-id": "ws_integrations",
  "x-user-id": "usr_integrations",
  "x-actor-id": "usr_integrations",
} as const;

describe("CAP-033/034/035 proactive integrations", () => {
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let server: Server;
  let endpoint: string;
  let holdState: ((reply: () => void) => void) | undefined;
  let releaseState: (() => void) | undefined;
  const serviceCalls: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/") return res.end(JSON.stringify({message: "API running."}));
      if (req.url === "/api/states") {
        return res.end(JSON.stringify([
          {entity_id: "light.study", state: "off", attributes: {friendly_name: "Study Light"}, last_updated: "2026-08-29T08:00:00.000Z"},
          {entity_id: "camera.private", state: "idle", attributes: {friendly_name: "Private Camera"}, last_updated: "2026-08-29T08:00:00.000Z"},
        ]));
      }
      if (req.url === "/api/states/light.study") {
        const send = () => res.end(JSON.stringify({entity_id: "light.study", state: "on", attributes: {friendly_name: "Study Light"}, last_updated: "2026-08-29T08:01:00.000Z"}));
        if (holdState) { const hold = holdState; holdState = undefined; hold(send); return; }
        return send();
      }
      if (req.url === "/api/services/light/turn_on" && req.method === "POST") {
        let raw = "";
        req.on("data", (chunk) => { raw += String(chunk); });
        req.on("end", () => {
          serviceCalls.push(JSON.parse(raw) as Record<string, unknown>);
          res.end(JSON.stringify([{entity_id: "light.study", state: "on"}]));
        });
        return;
      }
      if (req.url?.startsWith("/v1/health/daily")) {
        return res.end(JSON.stringify({data: {
          date: "2026-08-29",
          steps: 8123,
          sleep_minutes: 421,
          resting_heart_rate: 58,
        }}));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({error: "not_found"}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const database = await createInMemoryDatabase();
    db = database.db;
    client = database.client;
    cleanup = database.cleanup;
    app = (await buildApp({db, client})).app;
    await activateProfile();
  });

  afterEach(async () => {
    releaseState?.(); releaseState = undefined; holdState = undefined;
    await app.close();
    await cleanup();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    serviceCalls.length = 0;
  });

  async function connectHome(): Promise<void> {
    const connected = await app.inject({method: "POST", url: "/v1/proactive/integrations/home-assistant", headers,
      payload: {id: "conn_ha_test", endpoint, accessToken: "ha-secret-token", subscriptionEnabled: false,
        entities: [{entityId: "light.study", enabled: true, allowedOps: ["turn_on"]}]}});
    expect(connected.statusCode).toBe(201);
    expect(connected.json().connection.settings).not.toHaveProperty("__aervox_connection_generation");
  }

  function suspendHomeRead() {
    let entered!: () => void;
    const received = new Promise<void>(resolve => { entered = resolve; });
    holdState = send => { releaseState = send; entered(); };
    const read = app.inject({method: "GET", url: "/v1/proactive/integrations/home-assistant/conn_ha_test/entities/light.study/state", headers}).then(response => response);
    return {received, read, release: () => { releaseState?.(); releaseState = undefined; }};
  }

  async function atOneTimestamp(action: (now: string) => Promise<void>) {
    const now = new Date().toISOString();
    const original = Date.prototype.toISOString;
    // Freeze write timestamps without collapsing calculated future lease TTLs.
    const clock = vi.spyOn(Date.prototype, "toISOString").mockImplementation(function (this: Date) {
      return this.getTime() > Date.now() + 1_000 ? original.call(this) : now;
    });
    try {
      await client.execute({sql: "UPDATE proactive_source_grants SET updated_at = ?", args: [now]});
      await action(now);
      expect((await app.inject({method: "GET", url: "/v1/proactive/integrations/home-assistant/conn_ha_test/entities/light.study/state", headers})).statusCode).toBe(200);
      const rows = await client.execute("SELECT created_at, updated_at FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
      expect(rows.rows.length).toBeGreaterThan(0);
      for (const row of rows.rows) {
        expect(row.created_at).toBe(now);
        expect(row.updated_at).toBe(now);
      }
      const sources = await client.execute("SELECT updated_at FROM proactive_source_grants");
      for (const source of sources.rows) expect(source.updated_at).toBe(now);
    } finally { clock.mockRestore(); }
  }

  it("does not reuse the original read after an entity is disabled and re-enabled at one timestamp", async () => {
    await atOneTimestamp(async () => {
      await connectHome(); const pending = suspendHomeRead(); await pending.received;
      for (const enabled of [false, true]) {
        expect((await app.inject({method: "PATCH", url: "/v1/proactive/integrations/home-assistant/conn_ha_test/entities/light.study", headers, payload: {enabled}})).statusCode).toBe(200);
      }
      const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
      pending.release(); expect((await pending.read).statusCode).toBe(403);
      expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
    });
  });

  it("does not reuse the original read after its source is revoked and re-granted at one timestamp", async () => {
    await atOneTimestamp(async now => {
      await connectHome();
      const status = await app.inject({method: "GET", url: "/v1/proactive/status", headers});
      const source = status.json().sources.find((item: {sourceKey: string}) => item.sourceKey === "device.sensors");
      await client.execute({sql: "UPDATE proactive_source_grants SET updated_at = ? WHERE id = ?", args: [now, source.id]});
      const pending = suspendHomeRead(); await pending.received;
      for (const state of ["revoked", "granted"]) {
        expect((await app.inject({method: "PATCH", url: `/v1/proactive/sources/${source.id}`, headers, payload: {state}})).statusCode).toBe(200);
      }
      const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
      pending.release(); expect((await pending.read).statusCode).toBe(403);
      expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
    });
  });

  it("does not reuse the original read after the profile is paused and resumed at one timestamp", async () => {
    await atOneTimestamp(async () => {
      await connectHome(); const pending = suspendHomeRead(); await pending.received;
      for (const desiredState of ["paused", "enabled"]) {
        expect((await app.inject({method: "POST", url: "/v1/proactive/desired-state", headers, payload: {desiredState}})).statusCode).toBe(200);
      }
      const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
      pending.release(); expect((await pending.read).statusCode).toBe(403);
      expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
    });
  });

  it("does not reuse the original read after an equal entity is recreated at one timestamp", async () => {
    await atOneTimestamp(async () => {
      await connectHome(); const pending = suspendHomeRead(); await pending.received;
      const repo = new SqliteProactiveIntelligenceRepository(db);
      const ctx = {workspaceId: "local", subjectUserId: "local"};
      const original = (await repo.getHomeEntity(ctx, "conn_ha_test", "light.study"))!;
      await client.execute({sql: "DELETE FROM proactive_home_entities WHERE id = ?", args: [original.id]});
      await repo.upsertHomeEntity(ctx, {...original, lastSeenAt: original.lastSeenAt ?? undefined});
      const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
      pending.release(); expect((await pending.read).statusCode).toBe(403);
      expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
    });
  });

  it("does not grant an old read to a new activation lease", async () => {
    await connectHome(); const pending = suspendHomeRead(); await pending.received;
    const status = (await app.inject({method: "GET", url: "/v1/proactive/status", headers})).json();
    expect((await app.inject({method: "POST", url: `/v1/proactive/activation/${status.activationLease.id}/end`, headers, payload: {reason: "replacement_test"}})).statusCode).toBe(200);
    expect((await app.inject({method: "POST", url: "/v1/proactive/activation", headers, payload: {
      id: "lease_replacement", revisionId: status.revision.id, deviceId: "device_integrations", epoch: "replacement_epoch",
      localReady: true, fullAccessSnapshot: true, ttlSeconds: 60,
    }})).statusCode).toBe(201);
    const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
    pending.release(); expect((await pending.read).statusCode).toBe(403);
    expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
  });

  it("does not reuse an old read after the same activation epoch is ended and reactivated", async () => {
    await atOneTimestamp(async () => {
      await connectHome(); const pending = suspendHomeRead(); await pending.received;
      const status = (await app.inject({method: "GET", url: "/v1/proactive/status", headers})).json();
      expect((await app.inject({method: "POST", url: `/v1/proactive/activation/${status.activationLease.id}/end`, headers, payload: {reason: "same_epoch_test"}})).statusCode).toBe(200);
      const renewed = await app.inject({method: "POST", url: "/v1/proactive/activation", headers, payload: {
        id: "lease_same_epoch_retry", revisionId: status.revision.id, deviceId: status.activationLease.deviceId,
        epoch: status.activationLease.epoch, localReady: true, fullAccessSnapshot: true,
      }});
      expect(renewed.statusCode).toBe(201);
      expect(renewed.json().id).toBe(status.activationLease.id);
      const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
      pending.release(); expect((await pending.read).statusCode).toBe(403);
      expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
    });
  });

  it.each(["localReady", "fullAccessSnapshot"])("does not reuse an old read after lease %s is lost and restored", async field => {
    await atOneTimestamp(async () => {
      await connectHome(); const pending = suspendHomeRead(); await pending.received;
      const status = (await app.inject({method: "GET", url: "/v1/proactive/status", headers})).json();
      for (const value of [false, true]) {
        expect((await app.inject({method: "POST", url: `/v1/proactive/activation/${status.activationLease.id}/heartbeat`, headers, payload: {[field]: value}})).statusCode).toBe(200);
      }
      const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
      pending.release(); expect((await pending.read).statusCode).toBe(403);
      expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
    });
  });

  it("does not reuse an old read after its connection is revoked and restored", async () => {
    await atOneTimestamp(async () => {
      await connectHome(); const pending = suspendHomeRead(); await pending.received;
      const repo = new SqliteProactiveIntelligenceRepository(db);
      for (const state of ["revoked", "active"]) {
        await repo.updateConnectionState({workspaceId: "local", subjectUserId: "local"}, "conn_ha_test", state);
      }
      const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
      pending.release(); expect((await pending.read).statusCode).toBe(403);
      expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
    });
  });

  it("accepts and audits consecutive source changes within one clock tick", async () => {
    const status = (await app.inject({method: "GET", url: "/v1/proactive/status", headers})).json();
    const source = status.sources.find((item: {sourceKey: string}) => item.sourceKey === "device.sensors");
    expect(source).toBeDefined();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      for (const state of ["revoked", "granted"]) {
        const changed = await app.inject({method: "PATCH", url: `/v1/proactive/sources/${source.id}`, headers, payload: {state}});
        expect(changed.statusCode).toBe(200);
        expect(changed.json()).toMatchObject({id: source.id, state});
      }
    } finally { clock.mockRestore(); }
    const audit = await app.inject({method: "GET", url: "/v1/proactive/audit", headers});
    expect(audit.statusCode).toBe(200);
    const events = audit.json().items.filter((event: {resourceId: string}) => event.resourceId === source.id);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event: {id: string}) => event.id)).size).toBe(2);
    expect(events.map((event: {eventType: string}) => event.eventType).sort()).toEqual(["source.granted", "source.revoked"]);
  });

  it("does not reuse an old read after another mandatory source is revoked and re-granted", async () => {
    await atOneTimestamp(async () => {
      await connectHome(); const pending = suspendHomeRead(); await pending.received;
      const status = (await app.inject({method: "GET", url: "/v1/proactive/status", headers})).json();
      const source = status.sources.find((item: {sourceKey: string; mandatory: boolean}) => item.mandatory && item.sourceKey !== "device.sensors");
      expect(source).toBeDefined();
      for (const state of ["revoked", "granted"]) {
        expect((await app.inject({method: "PATCH", url: `/v1/proactive/sources/${source.id}`, headers, payload: {state}})).statusCode).toBe(200);
      }
      const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
      pending.release(); expect((await pending.read).statusCode).toBe(403);
      expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
    });
  });

  it.each([{enabled: false}, {allowedOps: []}])("fences a delayed Home Assistant read after access edit %j", async patch => {
    await connectHome();
    const pending = suspendHomeRead();
    await pending.received;
    const edited = await app.inject({method: "PATCH", url: "/v1/proactive/integrations/home-assistant/conn_ha_test/entities/light.study", headers, payload: patch});
    expect(edited.statusCode).toBe(200);
    const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
    pending.release();
    expect((await pending.read).statusCode).toBe(403);
    expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
  });

  it("fences a delayed Home Assistant read after its source is revoked", async () => {
    await connectHome();
    const pending = suspendHomeRead(); await pending.received;
    const status = await app.inject({method: "GET", url: "/v1/proactive/status", headers});
    const source = status.json().sources.find((item: {sourceKey: string}) => item.sourceKey === "device.sensors");
    const revoked = await app.inject({method: "PATCH", url: `/v1/proactive/sources/${source.id}`, headers, payload: {state: "revoked"}});
    expect(revoked.statusCode).toBe(200);
    const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
    pending.release(); expect((await pending.read).statusCode).toBe(403);
    expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
  });

  it("does not recreate an entity after a delayed read outlives connection deletion", async () => {
    await connectHome(); const pending = suspendHomeRead(); await pending.received;
    const deleted = await app.inject({method: "DELETE", url: "/v1/proactive/integrations/home-assistant/conn_ha_test", headers});
    expect(deleted.statusCode).toBe(204);
    pending.release(); expect((await pending.read).statusCode).toBe(403);
    expect((await client.execute("SELECT count(*) AS count FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows[0]?.count).toBe(0);
  });

  it("does not disclose an old read to a replacement connection with the same local ID", async () => {
    await connectHome(); const pending = suspendHomeRead(); await pending.received;
    expect((await app.inject({method: "DELETE", url: "/v1/proactive/integrations/home-assistant/conn_ha_test", headers})).statusCode).toBe(204);
    await connectHome();
    const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
    pending.release(); expect((await pending.read).statusCode).toBe(403);
    expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
  });

  it("fences identical connection replacement even when every timestamp has the same value", async () => {
    const clock = vi.spyOn(Date.prototype, "toISOString").mockReturnValue(new Date().toISOString());
    try {
      await connectHome(); const pending = suspendHomeRead(); await pending.received;
      const original = (await client.execute("SELECT created_at, settings_json FROM proactive_external_connections WHERE id = 'conn_ha_test'")).rows[0]!;
      expect((await app.inject({method: "DELETE", url: "/v1/proactive/integrations/home-assistant/conn_ha_test", headers})).statusCode).toBe(204);
      await connectHome();
      const replacement = (await client.execute("SELECT created_at, settings_json FROM proactive_external_connections WHERE id = 'conn_ha_test'")).rows[0]!;
      expect(replacement.created_at).toBe(original.created_at);
      expect(replacement.settings_json).not.toBe(original.settings_json);
      const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
      pending.release(); expect((await pending.read).statusCode).toBe(403);
      expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
    } finally { clock.mockRestore(); }
  });

  it("fences a delayed Home Assistant read while the profile is paused", async () => {
    await connectHome(); const pending = suspendHomeRead(); await pending.received;
    expect((await app.inject({method: "POST", url: "/v1/proactive/desired-state", headers, payload: {desiredState: "paused"}})).statusCode).toBe(200);
    const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
    pending.release(); expect((await pending.read).statusCode).toBe(403);
    expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
  });

  it("fences a delayed Home Assistant read after its connection is revoked", async () => {
    await connectHome(); const pending = suspendHomeRead(); await pending.received;
    await client.execute("UPDATE proactive_external_connections SET state = 'revoked' WHERE id = 'conn_ha_test'");
    const before = await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'");
    pending.release(); expect((await pending.read).statusCode).toBe(403);
    expect((await client.execute("SELECT * FROM proactive_home_entities WHERE connection_id = 'conn_ha_test'")).rows).toEqual(before.rows);
  });

  async function activateProfile(): Promise<void> {
    const profileId = "profile_integrations";
    const profile = await app.inject({
      method: "POST",
      url: "/v1/proactive/authorize",
      headers,
      payload: {
        id: profileId,
        deviceId: "device_integrations",
        fullAccessConfirmed: true,
        sources: FULL_PROFILE_SOURCE_MANIFEST.map((source, index) => ({
          id: `${profileId}_source_${index}`,
          sourceKey: source.sourceKey,
          purpose: source.purpose,
          osCapability: source.osCapability,
          state: "granted",
        })),
      },
    });
    expect(profile.statusCode).toBe(201);
    const lease = await app.inject({
      method: "POST",
      url: "/v1/proactive/activation",
      headers,
      payload: {
        id: "lease_integrations",
        revisionId: profile.json().revision.id,
        deviceId: "device_integrations",
        epoch: "epoch_integrations",
        localReady: true,
        fullAccessSnapshot: true,
      },
    });
    expect(lease.statusCode).toBe(201);
  }

  it("connects Home Assistant, enforces entity/service allowlists, and audits writes", async () => {
    const connected = await app.inject({
      method: "POST",
      url: "/v1/proactive/integrations/home-assistant",
      headers,
      payload: {
        id: "conn_ha_test",
        endpoint,
        accessToken: "ha-secret-token",
        subscriptionEnabled: false,
        entities: [{entityId: "light.study", enabled: true, allowedOps: ["turn_on"]}],
      },
    });
    expect(connected.statusCode).toBe(201);
    expect(connected.json().connection).toMatchObject({id: "conn_ha_test", hasCredential: true});
    expect(JSON.stringify(connected.json())).not.toContain("ha-secret-token");

    const entities = await app.inject({
      method: "GET",
      url: "/v1/proactive/integrations/home-assistant/conn_ha_test/entities",
      headers,
    });
    expect(entities.json().items.find((item: {entityId: string}) => item.entityId === "light.study")).toMatchObject({enabled: true});
    expect(entities.json().items.find((item: {entityId: string}) => item.entityId === "camera.private")).toMatchObject({enabled: false, sensitive: true});

    const state = await app.inject({
      method: "GET",
      url: "/v1/proactive/integrations/home-assistant/conn_ha_test/entities/light.study/state",
      headers,
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({entityId: "light.study", state: "on"});

    const denied = await app.inject({
      method: "POST",
      url: "/v1/proactive/integrations/home-assistant/conn_ha_test/call-service",
      headers,
      payload: {entityId: "light.study", service: "turn_off"},
    });
    expect(denied.statusCode).toBe(403);

    const called = await app.inject({
      method: "POST",
      url: "/v1/proactive/integrations/home-assistant/conn_ha_test/call-service",
      headers,
      payload: {entityId: "light.study", service: "turn_on", data: {brightness: 120}},
    });
    expect(called.statusCode).toBe(200);
    expect(serviceCalls).toEqual([{brightness: 120, entity_id: "light.study"}]);

    const actions = await app.inject({method: "GET", url: "/v1/proactive/actions", headers});
    expect(actions.json().items.some((item: {actionType: string; state: string}) => item.actionType === "ha_call_service" && item.state === "executed")).toBe(true);
  });

  it("syncs Xiaomi health locally and exposes the read-only health tools", async () => {
    const connected = await app.inject({
      method: "POST",
      url: "/v1/proactive/integrations/xiaomi-health",
      headers,
      payload: {
        id: "conn_xiaomi_test",
        apiBaseUrl: endpoint,
        accessToken: "xiaomi-secret-token",
        localDate: "2026-08-29",
      },
    });
    expect(connected.statusCode).toBe(201);
    expect(connected.json().sync.synced).toBe(3);
    expect(JSON.stringify(connected.json())).not.toContain("xiaomi-secret-token");

    const samples = await app.inject({
      method: "GET",
      url: "/v1/proactive/integrations/xiaomi-health/conn_xiaomi_test/samples",
      headers,
    });
    expect(samples.json().items).toHaveLength(3);

    const steps = await app.inject({
      method: "POST",
      url: "/v1/tools/health_get_daily_steps/call",
      headers,
      payload: {arguments: {connectionId: "conn_xiaomi_test", date: "2026-08-29"}},
    });
    expect(steps.statusCode).toBe(200);
    const toolPayload = JSON.parse(steps.json().content[0].text) as {total: number};
    expect(toolPayload.total).toBe(8123);

    const dashboard = await app.inject({method: "GET", url: "/v1/proactive/intelligence/dashboard", headers});
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().health).toHaveLength(3);
  });

  it("accepts Fastify string query limits without falling back to an unbounded page", async () => {
    for (const [id, title] of [["project_limit_1", "First project"], ["project_limit_2", "Second project"]] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/v1/proactive/intelligence/projects",
        headers,
        payload: {id, title},
      });
      expect(created.statusCode).toBe(201);
    }

    const limited = await app.inject({
      method: "GET",
      url: "/v1/proactive/intelligence/projects?limit=1",
      headers,
    });
    expect(limited.statusCode).toBe(200);
    expect(limited.json().items).toHaveLength(1);
  });

  it("gates integrations on active mode and explicit revocation instead of unreachable OS grants", async () => {
    const sensorHeaders = {
      "x-workspace-id": "ws_sensor_flow",
      "x-user-id": "usr_sensor_flow",
      "x-actor-id": "usr_sensor_flow",
    } as const;
    // device.sensors 没有平台 Provider，桌面 Host 只能回报 requested；
    // 授权不得因此卡在 limited（历史上这是集成全链路被闸死的根因）。
    const profile = await app.inject({
      method: "POST",
      url: "/v1/proactive/authorize",
      headers: sensorHeaders,
      payload: {
        id: "profile_sensor_flow",
        deviceId: "device_sensor_flow",
        fullAccessConfirmed: true,
        sources: FULL_PROFILE_SOURCE_MANIFEST.map((source, index) => ({
          id: `profile_sensor_flow_source_${index}`,
          sourceKey: source.sourceKey,
          purpose: source.purpose,
          osCapability: source.osCapability,
          state: source.sourceKey === "device.sensors" ? "requested" : "granted",
        })),
      },
    });
    expect(profile.statusCode).toBe(201);
    const lease = await app.inject({
      method: "POST",
      url: "/v1/proactive/activation",
      headers: sensorHeaders,
      payload: {
        id: "lease_sensor_flow",
        revisionId: profile.json().revision.id,
        deviceId: "device_sensor_flow",
        epoch: "epoch_sensor_flow",
        localReady: true,
        fullAccessSnapshot: true,
      },
    });
    expect(lease.statusCode).toBe(201);

    const status = await app.inject({method: "GET", url: "/v1/proactive/status", headers: sensorHeaders});
    expect(status.statusCode).toBe(200);
    expect(status.json().effectiveState).toBe("active");

    const connected = await app.inject({
      method: "POST",
      url: "/v1/proactive/integrations/home-assistant",
      headers: sensorHeaders,
      payload: {
        id: "conn_ha_sensor_flow",
        endpoint,
        accessToken: "ha-sensor-token",
        subscriptionEnabled: false,
      },
    });
    expect(connected.statusCode).toBe(201);
    expect(connected.json().sync.synced).toBe(2);

    // 用户显式撤销该来源后，集成同步必须重新被阻断。
    const grantId = (status.json().sources as Array<{sourceKey: string; id: string}>)
      .find((source) => source.sourceKey === "device.sensors")?.id;
    expect(grantId).toBeTruthy();
    const revoked = await app.inject({
      method: "PATCH",
      url: `/v1/proactive/sources/${encodeURIComponent(grantId!)}`,
      headers: sensorHeaders,
      payload: {state: "revoked"},
    });
    expect(revoked.statusCode).toBe(200);
    const sync = await app.inject({
      method: "POST",
      url: "/v1/proactive/integrations/home-assistant/conn_ha_sensor_flow/sync",
      headers: sensorHeaders,
    });
    expect(sync.statusCode).toBe(403);
  });

  it("registers five integration tools and removes credentials plus cached data on revoke", async () => {
    const tools = await app.inject({method: "GET", url: "/v1/tools", headers});
    const names = tools.json().items.map((item: {name: string}) => item.name);
    expect(names).toEqual(expect.arrayContaining([
      "ha_list_entities",
      "ha_get_entity_state",
      "ha_call_service",
      "health_get_daily_steps",
      "health_get_sleep_summary",
    ]));

    await app.inject({
      method: "POST",
      url: "/v1/proactive/integrations/xiaomi-health",
      headers,
      payload: {id: "conn_delete_test", apiBaseUrl: endpoint, accessToken: "delete-secret", localDate: "2026-08-29"},
    });
    const removed = await app.inject({
      method: "DELETE",
      url: "/v1/proactive/integrations/xiaomi-health/conn_delete_test",
      headers,
    });
    expect(removed.statusCode).toBe(204);
    const connections = await app.inject({method: "GET", url: "/v1/proactive/integrations", headers});
    expect(connections.json().items).toHaveLength(0);
    const raw = await client.execute("SELECT count(*) AS count FROM proactive_health_samples WHERE connection_id = 'conn_delete_test'");
    expect(Number(raw.rows[0]?.count ?? 0)).toBe(0);
  });
});
