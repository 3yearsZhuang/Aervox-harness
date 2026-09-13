/**
 * CR-032 主动智能插件化测试：全局防打扰裁决器 + 规则引擎 + 插件化调度闭环。
 */
import { describe, expect, it } from "vitest";
import { FULL_PROFILE_SOURCE_MANIFEST } from "@aervox/schema";
import {
  createInMemoryDatabase,
  createProactiveVaultCipher,
  initDatabaseSchema,
  SqliteExtensionRepository,
  SqliteSkillRegistryRepository,
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveProfileRepository,
} from "@aervox/repositories";
import {
  arbitrate,
  DEFAULT_GLOBAL_QUIET_HOURS,
  isWithinQuietHours,
} from "../src/proactive-arbitrator.js";
import {
  computeIdleFacts,
  evaluateTriggerRule,
  materializePluginTriggerRules,
} from "../src/proactive-rule-engine.js";
import { renderTemplateMessage } from "../src/proactive-composer.js";
import { runProactiveIntelligenceCycle } from "../src/proactive-intelligence-worker.js";

const tenant = {workspaceId: "local", subjectUserId: "local"} as const;
/** 14:30 本地午后时刻（避开全局静音窗口） */
const NOON = new Date(2026, 8, 13, 14, 30, 0);

describe("proactive arbitrator (CR-032 §2.1)", () => {
  const base = {
    now: NOON,
    cooldownSeconds: 1800,
    quietHoursPolicy: "respect_global" as const,
    quietHours: null,
    globalQuietHours: DEFAULT_GLOBAL_QUIET_HOURS,
    authorized: true,
    dispatchedInWindow: 0,
    maxDispatchesPerHour: 3,
  };

  it("dispatches when every line holds", () => {
    expect(arbitrate(base).decision).toBe("dispatch");
  });

  it("suppresses unauthorized plugin sensors (fail-closed)", () => {
    const verdict = arbitrate({...base, authorized: false});
    expect(verdict.decision).toBe("suppressed_unauthorized");
  });

  it("suppresses within cooldown window", () => {
    const lastTriggeredAt = new Date(NOON.getTime() - 600_000).toISOString();
    const verdict = arbitrate({...base, lastTriggeredAt});
    expect(verdict.decision).toBe("suppressed_cooldown");
  });

  it("dispatches after cooldown elapsed", () => {
    const lastTriggeredAt = new Date(NOON.getTime() - 3_600_000).toISOString();
    expect(arbitrate({...base, lastTriggeredAt}).decision).toBe("dispatch");
  });

  it("respects global quiet hours and bypass policy", () => {
    const lateNight = new Date(2026, 8, 13, 23, 30, 0);
    expect(arbitrate({...base, now: lateNight}).decision).toBe("suppressed_quiet_hours");
    const verdict = arbitrate({...base, quietHoursPolicy: "bypass", quietHours: null, now: lateNight});
    expect(verdict.decision).toBe("dispatch");
  });

  it("suppresses at global dispatch watermark", () => {
    const verdict = arbitrate({...base, dispatchedInWindow: 3});
    expect(verdict.decision).toBe("suppressed_rate_limit");
  });

  it("treats overnight window as quiet and day window as quiet only inside", () => {
    expect(isWithinQuietHours(new Date(2026, 8, 13, 23, 0), {start: "22:00", end: "07:00"})).toBe(true);
    expect(isWithinQuietHours(new Date(2026, 8, 13, 3, 0), {start: "22:00", end: "07:00"})).toBe(true);
    expect(isWithinQuietHours(NOON, {start: "22:00", end: "07:00"})).toBe(false);
    expect(isWithinQuietHours(new Date(2026, 8, 13, 12, 0), {start: "12:00", end: "13:00"})).toBe(true);
  });
});

describe("proactive rule engine (CR-032 S4)", () => {
  const rule = {
    id: "rule_rev_plugin_health-guard_sedentary_alert",
    revisionId: "rev",
    pluginId: "health-guard",
    name: "连续久坐健康提醒",
    triggerType: "system_state",
    condition: {continuousActiveMinutesMin: 50, idleMinutesMax: 5},
    action: {},
    enabled: true,
    cooldownSeconds: 1800,
    quietHours: {},
    createdAt: "",
    updatedAt: "",
  };

  it("computes continuous presence from idle samples", () => {
    const samples = Array.from({length: 12}, (_, index) => ({
      observedAt: new Date(NOON.getTime() - (11 - index) * 300_000).toISOString(),
      idleSeconds: 40,
    }));
    const facts = computeIdleFacts(samples, NOON);
    expect(facts.hasRecentData).toBe(true);
    expect(facts.continuousActiveMinutes).toBeGreaterThanOrEqual(55);
    expect(facts.currentIdleMinutes).toBeCloseTo(0.67, 1);
  });

  it("hits sedentary rule and skips when idle too long", () => {
    const samples = Array.from({length: 12}, (_, index) => ({
      observedAt: new Date(NOON.getTime() - (11 - index) * 300_000).toISOString(),
      idleSeconds: 40,
    }));
    expect(evaluateTriggerRule(rule, {now: NOON, dueCommitments: [], idleSamples: samples}).hit).toBe(true);
    const awaySamples = samples.map((sample) => ({...sample, idleSeconds: 1_800}));
    const evaluation = evaluateTriggerRule(rule, {now: NOON, dueCommitments: [], idleSamples: awaySamples});
    expect(evaluation.hit).toBe(false);
  });

  it("does not hit without fresh observations (fail-closed)", () => {
    const evaluation = evaluateTriggerRule(rule, {now: NOON, dueCommitments: [], idleSamples: []});
    expect(evaluation.hit).toBe(false);
  });
});

describe("proactive plugin dispatch loop (CR-032 §4.2/§4.3)", () => {
  it("materializes plugin rules, dispatches approved action and cascades plugin disable", async () => {
    const database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(9), "worker-plugin-dispatch");
    const profileRepo = new SqliteProactiveProfileRepository(database.db, cipher);
    const intelligenceRepo = new SqliteProactiveIntelligenceRepository(database.db, cipher);
    const extensionRepo = new SqliteExtensionRepository(database.db);
    const skillRegistry = new SqliteSkillRegistryRepository(database.db);
    try {
      const {revision, sources} = await profileRepo.confirmProfile(tenant, {
        id: "profile_plugin_dispatch",
        deviceId: "device_plugin_dispatch",
        actorId: tenant.subjectUserId,
        sources: FULL_PROFILE_SOURCE_MANIFEST.map((source, index) => ({
          id: `source_plugin_dispatch_${index}`,
          sourceKey: source.sourceKey,
          purpose: source.purpose,
          scope: "all",
          osCapability: source.osCapability,
          state: "granted" as const,
          mandatory: true,
        })),
      });

      // 主库登记插件声明（未授权感知源 → 物化器应拒之门外）
      await extensionRepo.createPlugin({
        id: "health-guard",
        publisher: "aervox-official",
        version: "1.0.0",
        checksum: "sha256:test",
        enabled: 1,
        proactiveSpecJson: {
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
        },
      });
      const grantedSensors = new Set<string>(["system.idle_state"]);
      const declarations = [{
        pluginId: "health-guard",
        pluginName: "health-guard",
        enabled: true,
        spec: {
          sensors: [{sourceId: "system.idle_state"}],
          triggers: [{
            ruleId: "sedentary_alert",
            name: "连续久坐健康提醒",
            triggerType: "system_state" as const,
            condition: {continuousActiveMinutesMin: 50, idleMinutesMax: 5},
            cooldownSeconds: 1800,
            quietHoursPolicy: "respect_global" as const,
            petPresentation: {animation: "stretch_body", bubblePreset: "gentle_care"},
          }],
        },
        grantedSensors,
      }];

      // 主库感知源授权（Worker 物化/求值前都会复核 plugin_grants，fail-closed）
      await extensionRepo.grantPlugin(tenant, {
        id: "grant_idle_state",
        pluginId: "health-guard",
        permission: "proactive.sensor",
        scope: "system.idle_state",
      });

      // 1) 未授权：物化器整体拔除（fail-closed）
      const blocked = await materializePluginTriggerRules({
        intelligenceRepo, tenant, revisionId: revision.id,
        declarations: [{...declarations[0]!, grantedSensors: new Set<string>()}], now: NOON,
      });
      expect(blocked.materialized).toBe(0);

      // 2) 授权后物化成功且绑定 plugin_id
      const materialized = await materializePluginTriggerRules({
        intelligenceRepo, tenant, revisionId: revision.id, declarations, now: NOON,
      });
      expect(materialized.materialized).toBe(1);
      const rules = await intelligenceRepo.listTriggerRulesByPlugin(tenant, "health-guard");
      expect(rules).toHaveLength(1);
      expect(rules[0]!.pluginId).toBe("health-guard");
      expect(rules[0]!.enabled).toBe(true);

      // 3) 造新鲜 idle 观测（50 分钟连续在场 + 当前空闲 1 分钟）→ 周期命中并派发
      const sourceByKey = new Map(sources.map((source) => [source.sourceKey, source]));
      for (let index = 0; index < 11; index += 1) {
        const observedAt = new Date(NOON.getTime() - (10 - index) * 300_000).toISOString();
        await profileRepo.createObservation(tenant, {
          id: `observation_idle_${index}`,
          revisionId: revision.id,
          sourceGrantId: sourceByKey.get("system.idle_state")!.id,
          sourceKey: "system.idle_state",
          observationType: "device_presence_context",
          subjectKey: "system.idle_state",
          payload: {idleSeconds: 60},
          checksum: `idle-${index}`,
          observedAt,
        });
      }

      const result = await runProactiveIntelligenceCycle({
        db: database.db,
        profileRepo,
        intelligenceRepo,
        workerId: "worker_plugin_test",
        now: () => NOON,
        extensionRepo,
        skillRegistry,
      });
      expect(result.dispatches).toBeGreaterThanOrEqual(1);

      const actions = await profileRepo.listActions(tenant, {revisionId: revision.id, limit: 20});
      const dispatched = actions.find((action) => action.actionType === "proactive_dispatch");
      expect(dispatched?.state).toBe("executed");
      const outcome = dispatched?.outcome as {kind?: string; message?: string; presentation?: {bubblePreset?: string}};
      expect(outcome.kind).toBe("plugin_dispatch");
      expect(outcome.message).toBeTruthy();
      expect(outcome.presentation?.bubblePreset).toBe("gentle_care");

      const events = await intelligenceRepo.listTriggerEvents(tenant, 50);
      expect(events.some((event) => event.decision === "dispatch")).toBe(true);

      // 4) 冷却生效：紧接着的第二个周期不再派发
      const second = await runProactiveIntelligenceCycle({
        db: database.db,
        profileRepo,
        intelligenceRepo,
        workerId: "worker_plugin_test",
        now: () => new Date(NOON.getTime() + 60_000),
        extensionRepo,
        skillRegistry,
      });
      expect(second.dispatches).toBe(0);

      // 5) 插件停用 → 级联禁用物化规则
      await intelligenceRepo.setTriggerRulesEnabledByPlugin(tenant, "health-guard", false);
      const disabled = await intelligenceRepo.listTriggerRulesByPlugin(tenant, "health-guard");
      expect(disabled.every((rule) => !rule.enabled)).toBe(true);

      // 6) 卸载级联：规则清零（幽灵规则零残留）
      await intelligenceRepo.deleteTriggerRulesByPlugin(tenant, "health-guard");
      expect(await intelligenceRepo.listTriggerRulesByPlugin(tenant, "health-guard")).toHaveLength(0);
    } finally {
      database.client.close();
    }
  });

  it("template composer degrades gracefully per bubble preset", () => {
    const input = {
      tenant,
      pluginId: "health-guard",
      pluginName: "久坐与健康护航助手",
      ruleName: "连续久坐健康提醒",
      triggerType: "system_state",
      evidence: {summary: "已连续在场约 55 分钟", facts: {continuousActiveMinutes: 55}},
      skillContent: null,
      bubblePreset: "gentle_care",
    };
    expect(renderTemplateMessage(input)).toContain("55 分钟");
    expect(renderTemplateMessage(input).length).toBeGreaterThan(0);
  });
});
