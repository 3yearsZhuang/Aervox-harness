/**
 * Aervox｜思隅 @aervox/worker — 主动触发规则引擎（CR-032 S4）
 *
 * 规则真源迁移的两半：
 * 1. 物化（materializePluginTriggerRules）：插件清单 spec.proactive 声明是「声明真源」
 *   （存主库 plugins.proactive_spec_json）；本函数把启用且感知源已授权的插件规则
 *   同步进 vault proactive_trigger_rules（plugin_id 标记归属），声明收敛时拔除消失的
 *   规则，未授权/停用插件的规则整体清除（fail-closed：切断事件输入）。
 * 2. 求值（evaluateTriggerRule）：对物化规则按类型求值，产出命中与否及证据快照。
 *
 * 冷却状态（lastTriggeredAt）由 upsert 的 undefined 语义保护：物化重入不清零。
 */
import type { PluginProactiveSpec } from "@aervox/contracts";
import type {
  IntelligenceTriggerRule,
  SqliteProactiveIntelligenceRepository,
  LocalContext,
} from "@aervox/repositories";

/** 一个插件在主库中的主动声明投影（Worker 物化输入） */
export interface ProactivePluginDeclaration {
  pluginId: string;
  pluginName: string;
  /** 主库 plugins.enabled（停用插件的整体规则一并拔除） */
  enabled: boolean;
  spec: PluginProactiveSpec;
  /** 该插件已获授权的感知源集合（plugin_grants: permission=proactive.sensor, scope=sourceId） */
  grantedSensors: ReadonlySet<string>;
}

export interface RuleMaterializationResult {
  materialized: number;
  removed: number;
}

/** 求值输入信号（由 Worker 周期上下文投影，全部可缺失） */
export interface TriggerSignals {
  now: Date;
  fatigueScore?: number;
  /** 当日漂移信号的最高严重度 */
  driftSeverity?: number;
  sleepMinutes?: number;
  dueCommitments: Array<{id: string; content: string; dueAt?: string | null}>;
  /** system.idle_state 观测（observedAt 升序；payload.idleSeconds） */
  idleSamples: Array<{observedAt: string; idleSeconds: number}>;
}

export interface RuleEvaluation {
  hit: boolean;
  cause: Record<string, unknown>;
  reason: string;
}

/** 判定样本「在场」的空闲上限（秒）：空闲 ≤ 5 分钟视为在场 */
export const PRESENT_IDLE_SECONDS_MAX = 300;

const conditionNumber = (condition: unknown, key: string): number | null => {
  const raw = (condition as Record<string, unknown> | null)?.[key];
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export function pluginRuleId(revisionId: string, pluginId: string, ruleId: string): string {
  return `rule_${revisionId}_plugin_${pluginId}_${ruleId}`;
}

/**
 * 物化插件触发规则进 vault。
 * - 启用且全部感知源已授权的插件 → 逐条 upsert（保留冷却状态）；
 * - 声明中已消失的规则 → 单条拔除；
 * - 停用或授权不全的插件 → 整体拔除（未授权即切断事件输入）。
 */
export async function materializePluginTriggerRules(ctx: {
  intelligenceRepo: SqliteProactiveIntelligenceRepository;
  tenant: LocalContext;
  revisionId: string;
  declarations: ProactivePluginDeclaration[];
  now: Date;
}): Promise<RuleMaterializationResult> {
  const {intelligenceRepo, tenant, revisionId, declarations, now} = ctx;
  let materialized = 0;
  let removed = 0;

  for (const declaration of declarations) {
    const sensors = declaration.spec.sensors.map((sensor) => sensor.sourceId);
    const fullyAuthorized = sensors.every((sourceId) => declaration.grantedSensors.has(sourceId));

    if (!declaration.enabled || !fullyAuthorized) {
      removed += await intelligenceRepo.deleteTriggerRulesByPlugin(tenant, declaration.pluginId);
      continue;
    }

    const existing = await intelligenceRepo.listTriggerRulesByPlugin(tenant, declaration.pluginId, 500);
    const declaredRuleIds = new Set<string>();

    for (const trigger of declaration.spec.triggers) {
      const ruleId = pluginRuleId(revisionId, declaration.pluginId, trigger.ruleId);
      declaredRuleIds.add(ruleId);
      await intelligenceRepo.upsertTriggerRule(tenant, {
        id: ruleId,
        revisionId,
        pluginId: declaration.pluginId,
        name: trigger.name,
        triggerType: trigger.triggerType,
        condition: trigger.dsl ? {
          legacy: trigger.condition,
          dslVersion: trigger.dsl.version,
          dsl: trigger.dsl.expression,
          quotas: trigger.dsl.quotas,
        } : trigger.condition,
        action: {
          kind: "plugin_dispatch",
          pluginId: declaration.pluginId,
          presentation: trigger.petPresentation ?? null,
        },
        enabled: true,
        cooldownSeconds: trigger.cooldownSeconds,
        quietHours: {policy: trigger.quietHoursPolicy},
        // undefined：保留既有 lastTriggeredAt（冷却状态跨周期存活）
        lastTriggeredAt: undefined,
      });
      materialized += 1;
    }

    for (const rule of existing) {
      if (!declaredRuleIds.has(rule.id)) {
        if (await intelligenceRepo.deleteTriggerRule(tenant, rule.id)) removed += 1;
      }
    }
  }

  // 幽灵规则清理：vault 中仍挂着 plugin_id、但主库已无该插件声明的规则（卸载兜底）
  const declaredPluginIds = new Set(declarations.map((declaration) => declaration.pluginId));
  for (const rule of await intelligenceRepo.listTriggerRules(tenant, undefined, 500)) {
    if (rule.pluginId && !declaredPluginIds.has(rule.pluginId)) {
      if (await intelligenceRepo.deleteTriggerRule(tenant, rule.id)) removed += 1;
    }
  }

  // now 保留用于未来按声明时间戳做差异日志；避免无意义读时告警
  void now;
  return {materialized, removed};
}

/**
 * system.idle_state 证据快照：当前空闲分钟与连续在场分钟。
 * 样本须按 observedAt 升序；最近 15 分钟内无样本视为无新鲜数据。
 *
 * 连续在场 = 自最近一次键鼠活动起、沿样本链倒序延伸至首个「不在场」样本的跨度：
 * 相邻间隔超过 15 分钟（数据断档）同样终止链条。
 */
export function computeIdleFacts(
  samples: Array<{observedAt: string; idleSeconds: number}>,
  now: Date,
): {currentIdleMinutes: number | null; continuousActiveMinutes: number; hasRecentData: boolean} {
  if (samples.length === 0) return {currentIdleMinutes: null, continuousActiveMinutes: 0, hasRecentData: false};
  const latest = samples[samples.length - 1]!;
  const latestAt = Date.parse(latest.observedAt);
  const hasRecentData = Number.isFinite(latestAt) && now.getTime() - latestAt <= 15 * 60 * 1000;
  if (!hasRecentData) return {currentIdleMinutes: null, continuousActiveMinutes: 0, hasRecentData: false};

  const currentIdleMinutes = Math.max(0, latest.idleSeconds) / 60;

  let continuousMs = 0;
  if (latest.idleSeconds <= PRESENT_IDLE_SECONDS_MAX) {
    continuousMs = latest.idleSeconds * 1000;
    for (let index = samples.length - 1; index > 0; index -= 1) {
      const current = samples[index]!;
      const previous = samples[index - 1]!;
      if (current.idleSeconds > PRESENT_IDLE_SECONDS_MAX) break;
      if (previous.idleSeconds > PRESENT_IDLE_SECONDS_MAX) break;
      const gapMs = Date.parse(current.observedAt) - Date.parse(previous.observedAt);
      if (!Number.isFinite(gapMs) || gapMs <= 0 || gapMs > 15 * 60 * 1000) break;
      continuousMs += gapMs;
    }
  }
  return {currentIdleMinutes, continuousActiveMinutes: Math.round(continuousMs / 60000), hasRecentData: true};
}

/** 对单条物化规则求值；未知类型或非法条件一律不命中（fail-closed） */
export function evaluateTriggerRule(rule: IntelligenceTriggerRule, signals: TriggerSignals): RuleEvaluation {
  const condition = (rule.condition ?? {}) as Record<string, unknown>;
  const noHit = (reason: string): RuleEvaluation => ({hit: false, cause: {}, reason});

  switch (rule.triggerType) {
    case "system_state": {
      const idleMinutesMax = conditionNumber(condition, "idleMinutesMax");
      const continuousActiveMinutesMin = conditionNumber(condition, "continuousActiveMinutesMin");
      if (idleMinutesMax === null && continuousActiveMinutesMin === null) {
        return noHit("system_state condition requires idleMinutesMax and/or continuousActiveMinutesMin");
      }
      const facts = computeIdleFacts(signals.idleSamples, signals.now);
      if (!facts.hasRecentData) return noHit("no fresh idle_state observations");
      if (idleMinutesMax !== null && facts.currentIdleMinutes !== null && facts.currentIdleMinutes > idleMinutesMax) {
        return noHit(`current idle ${facts.currentIdleMinutes.toFixed(1)}min exceeds idleMinutesMax=${idleMinutesMax}`);
      }
      if (continuousActiveMinutesMin !== null && facts.continuousActiveMinutes < continuousActiveMinutesMin) {
        return noHit(`continuous active ${facts.continuousActiveMinutes}min below continuousActiveMinutesMin=${continuousActiveMinutesMin}`);
      }
      return {
        hit: true,
        cause: {continuousActiveMinutes: facts.continuousActiveMinutes, currentIdleMinutes: facts.currentIdleMinutes},
        reason: `continuous active ${facts.continuousActiveMinutes}min, current idle ${facts.currentIdleMinutes?.toFixed(1) ?? "?"}min`,
      };
    }
    case "fatigue_high": {
      const threshold = conditionNumber(condition, "score");
      if (threshold === null || signals.fatigueScore === undefined) return noHit("fatigue score unavailable");
      if (signals.fatigueScore < threshold) return noHit(`fatigueScore ${signals.fatigueScore} below ${threshold}`);
      return {hit: true, cause: {fatigueScore: signals.fatigueScore}, reason: `fatigue score ${signals.fatigueScore} >= ${threshold}`};
    }
    case "drift_high": {
      const threshold = conditionNumber(condition, "severity");
      if (threshold === null || signals.driftSeverity === undefined) return noHit("drift severity unavailable");
      if (signals.driftSeverity < threshold) return noHit(`drift severity ${signals.driftSeverity} below ${threshold}`);
      return {hit: true, cause: {driftSeverity: signals.driftSeverity}, reason: `drift severity ${signals.driftSeverity} >= ${threshold}`};
    }
    case "health_sleep_low": {
      const threshold = conditionNumber(condition, "minutes");
      if (threshold === null || signals.sleepMinutes === undefined) return noHit("sleep minutes unavailable");
      if (signals.sleepMinutes >= threshold) return noHit(`sleep ${signals.sleepMinutes}min at or above ${threshold}`);
      return {hit: true, cause: {sleepMinutes: signals.sleepMinutes}, reason: `sleep ${signals.sleepMinutes}min below ${threshold}min`};
    }
    case "commitment_due": {
      const hours = conditionNumber(condition, "hours") ?? 24;
      const horizon = signals.now.getTime() + hours * 3600 * 1000;
      const due = signals.dueCommitments.find((item) => {
        if (!item.dueAt) return true;
        const dueAt = Date.parse(item.dueAt);
        return Number.isFinite(dueAt) && dueAt <= horizon;
      });
      if (!due) return noHit("no commitment due within horizon");
      return {hit: true, cause: {commitmentId: due.id}, reason: due.content};
    }
    default:
      return noHit(`unsupported trigger type: ${rule.triggerType}`);
  }
}
