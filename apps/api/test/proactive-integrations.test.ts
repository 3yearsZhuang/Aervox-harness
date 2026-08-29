import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  FULL_PROFILE_SOURCE_MANIFEST,
  type AervoxDatabase,
} from "@aervox/database";
import type { Client } from "@libsql/client";
import { buildApp } from "../src/app.js";

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
        return res.end(JSON.stringify({entity_id: "light.study", state: "on", attributes: {friendly_name: "Study Light"}, last_updated: "2026-08-29T08:01:00.000Z"}));
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
    await app.close();
    await cleanup();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    serviceCalls.length = 0;
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
