/**
 * Aervox｜思隅 @aervox/api — CR-032 主动智能插件生命周期集成测试
 *
 * 覆盖：清单 spec.proactive fail-closed 校验（非法声明拒装）→ 声明持久化 →
 * 感知源授权（含 scope 粒度共存）→ 启停级联 vault 物化规则 → 卸载清理。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createInMemoryDatabase, initDatabaseSchema, type AervoxDatabase } from "@aervox/repositories";
import { PLUGIN_SENSOR_PERMISSION, pluginManifestSchema, pluginProactiveSpecSchema } from "@aervox/contracts";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_crp032",
  "x-user-id": "usr_crp032",
} as const;

const VALID_SPEC = {
  sensors: [{sourceId: "system.idle_state"}],
  triggers: [{
    ruleId: "sedentary_alert",
    name: "连续久坐健康提醒",
    triggerType: "system_state",
    condition: {continuousActiveMinutesMin: 50, idleMinutesMax: 5},
    cooldownSeconds: 1800,
    quietHoursPolicy: "respect_global",
    petPresentation: {animation: "stretch_body", bubblePreset: "gentle_care"},
  }],
};

describe("CR-032 主动智能插件生命周期", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let proactiveDb: AervoxDatabase;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    // 测试回退模式：未注入 proactive 库时 vault 回退主库（buildApp 约定）
    const built = await buildApp({db, client});
    app = built.app;
    proactiveDb = built.proactiveDb!;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("rejects invalid proactive spec at install (fail-closed)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/plugins",
      headers,
      payload: {
        id: "bad-plugin",
        publisher: "aervox-labs",
        version: "1.0.0",
        proactiveSpec: {
          sensors: [{sourceId: "system.idle_state"}],
          triggers: [{
            ruleId: "bad_trigger",
            name: "未知类型规则",
            triggerType: "teleport_user",
            condition: {},
          }],
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid proactive spec");
  });

  it("rejects unknown fields in proactive triggers (strict)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/plugins",
      headers,
      payload: {
        id: "bad-plugin-2",
        publisher: "aervox-labs",
        version: "1.0.0",
        proactiveSpec: {
          sensors: [],
          triggers: [{
            ruleId: "sneaky",
            name: "带私货字段",
            triggerType: "system_state",
            condition: {},
            adminBackdoor: true,
          }],
        },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("persists valid declaration and manages sensor grants with scope isolation", async () => {
    const install = await app.inject({
      method: "POST",
      url: "/v1/plugins",
      headers,
      payload: {
        id: "health-guard",
        publisher: "aervox-official",
        version: "1.0.0",
        proactiveSpec: VALID_SPEC,
      },
    });
    expect(install.statusCode).toBe(201);
    const installed = install.json();
    expect(installed.proactiveSpecJson).toEqual(VALID_SPEC);

    // 两个感知源授权可共存（scope 粒度唯一索引）
    const grantA = await app.inject({
      method: "POST",
      url: "/v1/plugins/health-guard/grants",
      headers,
      payload: {permission: "proactive.sensor", scope: "system.idle_state"},
    });
    expect(grantA.statusCode).toBe(201);
    const grantB = await app.inject({
      method: "POST",
      url: "/v1/plugins/health-guard/grants",
      headers,
      payload: {permission: "proactive.sensor", scope: "device.clipboard"},
    });
    expect(grantB.statusCode).toBe(201);

    const grants = await app.inject({
      method: "GET",
      url: "/v1/plugins/health-guard/grants",
      headers,
    });
    expect(grants.json().items).toHaveLength(2);

    const scoped = await app.inject({
      method: "GET",
      url: "/v1/plugins/health-guard/permissions/proactive.sensor?scope=system.idle_state",
      headers,
    });
    expect(scoped.json().granted).toBe(true);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/plugins/health-guard/grants/${grantA.json().id}`,
      headers,
    });
    expect(revoked.statusCode).toBe(200);
    const afterRevoke = await app.inject({
      method: "GET",
      url: "/v1/plugins/health-guard/permissions/proactive.sensor?scope=system.idle_state",
      headers,
    });
    expect(afterRevoke.json().granted).toBe(false);
  });

  it("cascades vault rule enable/disable and purge on uninstall via sync port", async () => {
    // 直接经 PluginService 校验级联口（buildApp 装配的 proactiveRuleSync 指向 vault 仓储）
    const install = await app.inject({
      method: "POST",
      url: "/v1/plugins",
      headers,
      payload: {
        id: "health-guard",
        publisher: "aervox-official",
        version: "1.0.0",
        proactiveSpec: VALID_SPEC,
      },
    });
    expect(install.statusCode).toBe(201);

    // 测试回退模式下 vault 即主库：经智能仓储手工插入一条该插件的物化规则
    const {SqliteProactiveIntelligenceRepository} = await import("@aervox/repositories");
    const repo = new SqliteProactiveIntelligenceRepository(proactiveDb);
    const tenant = {workspaceId: "local", subjectUserId: "local"} as const;
    await repo.upsertTriggerRule(tenant, {
      id: "rule_rev_plugin_health-guard_sedentary_alert",
      revisionId: "rev_test",
      pluginId: "health-guard",
      name: "连续久坐健康提醒",
      triggerType: "system_state",
      condition: {},
      action: {kind: "plugin_dispatch"},
      enabled: true,
      cooldownSeconds: 1800,
      quietHours: {},
      lastTriggeredAt: undefined,
    });

    // 停用插件 → 级联禁用规则
    await app.inject({method: "PATCH", url: "/v1/plugins/health-guard", headers, payload: {enabled: false}});
    const disabled = await repo.listTriggerRulesByPlugin(tenant, "health-guard");
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.enabled).toBe(false);

    // 卸载插件 → 规则清零（幽灵规则零残留）
    await app.inject({method: "DELETE", url: "/v1/plugins/health-guard", headers});
    expect(await repo.listTriggerRulesByPlugin(tenant, "health-guard")).toHaveLength(0);
  });

  it("安装期拒绝引用 SituationModel 白名单外字段的 DSL", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/plugins",
      headers,
      payload: {
        id: "invalid-dsl",
        publisher: "aervox-official",
        version: "1.0.0",
        proactiveSpec: {
          sensors: [],
          triggers: [{
            ruleId: "unsafe",
            name: "Unsafe",
            triggerType: "fatigue_high",
            condition: {score: 70},
            dsl: {
              version: "proactive_dsl_v1",
              expression: {op: "field_ref", field: "persona.secret"},
            },
          }],
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({error: "invalid proactive DSL"});
  });
});

describe("CR-032 清单契约 fail-closed", () => {
  it("parses the bundled health-guard manifest and rejects unknown trigger types", async () => {
    const manifestPath = path.resolve(import.meta.dirname, "../../../plugins/health-guard/plugin.manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const parsed = pluginManifestSchema.parse(manifest);
    expect(parsed.spec.proactive?.triggers[0]?.ruleId).toBe("sedentary_alert");
    expect(parsed.spec.proactive?.sensors[0]?.sourceId).toBe("system.idle_state");
    expect(PLUGIN_SENSOR_PERMISSION).toBe("proactive.sensor");

    expect(
      pluginProactiveSpecSchema.safeParse({
        sensors: [],
        triggers: [{ruleId: "x", name: "X", triggerType: "system_state", condition: {}}],
      }).success,
    ).toBe(true);
    expect(
      pluginProactiveSpecSchema.safeParse({
        sensors: [],
        triggers: [{ruleId: "x", name: "X", triggerType: "mind_control", condition: {}}],
      }).success,
    ).toBe(false);
    // 超限规则数 fail-closed
    expect(
      pluginProactiveSpecSchema.safeParse({
        sensors: [],
        triggers: Array.from({length: 21}, (_, index) => ({
          ruleId: `r${index}`,
          name: `R${index}`,
          triggerType: "system_state",
          condition: {},
        })),
      }).success,
    ).toBe(false);
  });
});
