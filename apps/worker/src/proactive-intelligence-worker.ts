/**
 * Deterministic local engine for the twelve proactive intelligence capabilities.
 *
 * CR-032：第 4 步触发调度已插件化——
 * - 规则真源 = 插件清单声明（主库 plugins.proactive_spec_json）+ 内置规则（plugin_id 为空）；
 * - 周期开头把启用的插件声明物化进 vault proactive_trigger_rules（plugin_id 标记）；
 * - 所有候选（内置 + 插件）统一经全局防打扰裁决器（ProactiveArbitrator）裁决；
 * - 插件规则命中后走主动回合调度：vault proactive_actions 账本 + One-shot 关怀话术
 *   组合器 + 主库通知（payload 携带表现声明，API 经 SSE 直推多端）。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import {
  PLUGIN_SENSOR_PERMISSION,
  pluginProactiveSpecSchema,
} from "@aervox/contracts";
import type { PluginProactiveSpec } from "@aervox/contracts";
import {
  proactiveProfileRevisions,
} from "@aervox/schema";
import type {
  AervoxDatabase,
  IntelligenceTriggerRule,
  SqliteExtensionRepository,
  SqliteLLMConfigRepository,
  SqlitePlatformRepository,
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveProfileRepository,
  SqliteSkillRegistryRepository,
  LocalContext,
} from "@aervox/repositories";
import { arbitrate, DEFAULT_GLOBAL_QUIET_HOURS, DEFAULT_MAX_DISPATCHES_PER_HOUR } from "./proactive-arbitrator.js";
import {
  evaluateTriggerRule,
  materializePluginTriggerRules,
  type ProactivePluginDeclaration,
  type RuleEvaluation,
} from "./proactive-rule-engine.js";
import { composeProactiveMessage } from "./proactive-composer.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 20);
const id = (prefix: string, value: string): string => `${prefix}_${hash(value)}`;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 插件规则最小冷却下限（秒）：防止 cooldown=0 且条件恒真的规则逐节拍刷屏 */
const MIN_PLUGIN_COOLDOWN_SECONDS = 60;

function utcWeekRange(now: Date): {start: string; end: string} {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - day + 1);
  const end = new Date(start.getTime() + 6 * DAY_MS);
  return {start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10)};
}

export interface ProactiveIntelligenceCycleContext {
  db: AervoxDatabase;
  profileRepo: SqliteProactiveProfileRepository;
  intelligenceRepo: SqliteProactiveIntelligenceRepository;
  platformRepo?: SqlitePlatformRepository;
  workerId: string;
  now?: () => Date;
  /** CR-032：主库插件声明与感知源授权读取（缺省时插件化调度降级关闭） */
  extensionRepo?: SqliteExtensionRepository;
  /** CR-032：关怀话术组合器依赖 */
  llmConfigRepo?: SqliteLLMConfigRepository;
  skillRegistry?: SqliteSkillRegistryRepository;
  /** 全局静音窗口（本地时区 HH:mm）；缺省 22:00-07:00 */
  globalQuietHours?: {start: string; end: string};
  /** 全局频次水位（次/小时）；缺省 3 */
  maxDispatchesPerHour?: number;
}

export interface ProactiveIntelligenceCycleResult {
  tenants: number;
  timeline: number;
  projects: number;
  workflows: number;
  triggers: number;
  verifications: number;
  conflicts: number;
  preparations: number;
  attention: number;
  drift: number;
  relationships: number;
  scenes: number;
  reviews: number;
  /** CR-032：本次周期物化的插件规则数 / 实际派发的主动回合数 */
  materializedRules: number;
  dispatches: number;
}

/**
 * CR-032 §4.3 主动回合调度：命中规则 → vault 账本（pending→approved→running→executed）
 * → One-shot 关怀话术组合器 → 主库通知（payload 携带表现声明）。
 * 返回派发结果（含话术与表现声明）；账本/授权失败向上抛出由调用方记录 failed_dispatch。
 */
async function dispatchProactiveTurn(
  ctx: ProactiveIntelligenceCycleContext,
  tenant: LocalContext,
  profile: {id: string},
  rule: IntelligenceTriggerRule,
  evaluation: RuleEvaluation,
  declarations: ProactivePluginDeclaration[],
  now: Date,
): Promise<{actionId: string; message: string; source: "llm" | "template"; presentation: {animation?: string; bubblePreset?: string} | null}> {
  const pluginId = rule.pluginId ?? "builtin";
  const actionSpec = rule.pluginId
    ? ((rule.action as {presentation?: {animation?: string; bubblePreset?: string} | null} | undefined)?.presentation ?? null)
    : null;
  const declaration = declarations.find((item) => item.pluginId === rule.pluginId) ?? null;

  const skillContent = rule.pluginId
    ? await loadPluginSkillContent(ctx.skillRegistry, undefined, rule.pluginId)
    : null;
  const compose = ctx.llmConfigRepo
    ? await composeProactiveMessage({
        llmConfigRepo: ctx.llmConfigRepo,
        input: {
          tenant,
          pluginId,
          pluginName: declaration?.pluginName ?? pluginId,
          ruleName: rule.name,
          triggerType: rule.triggerType,
          evidence: {summary: evaluation.reason, facts: evaluation.cause},
          skillContent,
          bubblePreset: actionSpec?.bubblePreset ?? null,
        },
      })
    : {message: evaluation.reason, source: "template" as const};

  const actionId = id("pact", `${profile.id}:${rule.id}:${now.toISOString()}`);
  const action = await ctx.profileRepo.createAction(tenant, {
    id: actionId,
    revisionId: profile.id,
    actionType: "proactive_dispatch",
    target: pluginId,
    request: {ruleId: rule.id, triggerType: rule.triggerType, cause: evaluation.cause},
    authorizationScope: "action.local",
    actionGrantRevision: "",
    requestedBy: rule.pluginId ? `plugin:${rule.pluginId}` : "builtin_rules",
    reversible: true,
    external: false,
  });
  await ctx.profileRepo.updateAction(tenant, action.id, {state: "approved", actorId: "proactive-arbitrator"});
  await ctx.profileRepo.updateAction(tenant, action.id, {state: "running", actorId: "proactive-dispatcher"});
  await ctx.profileRepo.updateAction(tenant, action.id, {
    state: "executed",
    actorId: "proactive-dispatcher",
    outcome: {
      kind: "plugin_dispatch",
      pluginId,
      ruleId: rule.id,
      title: rule.name,
      message: compose.message,
      source: compose.source,
      presentation: actionSpec,
      evidence: evaluation.cause,
    },
  });
  return {actionId: action.id, message: compose.message, source: compose.source, presentation: actionSpec};
}

async function activeProfiles(ctx: ProactiveIntelligenceCycleContext) {
  return ctx.db.select({
    id: proactiveProfileRevisions.id,
  }).from(proactiveProfileRevisions).where(and(
    eq(proactiveProfileRevisions.status, "active"),
    eq(proactiveProfileRevisions.desiredState, "enabled"),
  ));
}

/** 从主库加载插件主动声明（fail-closed：声明经清单 zod 校验，非法声明跳过该插件） */
async function loadPluginDeclarations(extensionRepo: SqliteExtensionRepository): Promise<ProactivePluginDeclaration[]> {
  const [plugins, grants] = await Promise.all([
    extensionRepo.listPlugins(),
    extensionRepo.listActiveGrantsByPermission({workspaceId: "local", subjectUserId: "local"}, PLUGIN_SENSOR_PERMISSION),
  ]);
  const grantedByPlugin = new Map<string, Set<string>>();
  for (const grant of grants) {
    const set = grantedByPlugin.get(grant.pluginId) ?? new Set<string>();
    set.add(grant.scope);
    grantedByPlugin.set(grant.pluginId, set);
  }
  const declarations: ProactivePluginDeclaration[] = [];
  for (const plugin of plugins) {
    const parsed = pluginProactiveSpecSchema.safeParse(plugin.proactiveSpecJson);
    if (!parsed.success) continue;
    const spec = parsed.data as PluginProactiveSpec;
    if (spec.triggers.length === 0) continue;
    declarations.push({
      pluginId: plugin.id,
      pluginName: plugin.id,
      enabled: plugin.enabled === 1,
      spec,
      grantedSensors: grantedByPlugin.get(plugin.id) ?? new Set<string>(),
    });
  }
  return declarations;
}

/** 读取插件 SKILL.md 全文（主动回合装配插件专有关怀心智） */
async function loadPluginSkillContent(
  skillRegistry: SqliteSkillRegistryRepository | undefined,
  skillsRootHint: string | undefined,
  pluginId: string,
): Promise<string | null> {
  try {
    const skills = await skillRegistry?.listSkills(true);
    const registration = skills?.find((skill) => skill.pluginId === pluginId);
    const contentPath = registration?.contentPath
      ?? (skillsRootHint ? `${skillsRootHint}/${pluginId}/${pluginId}/SKILL.md` : undefined);
    if (!contentPath) return null;
    const content = await fs.readFile(contentPath, "utf8");
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

/** 插件感知源授权复核：声明存在且清单声明的全部感知源均已授权（fail-closed 二次校验） */
function isDeclarationAuthorized(declarations: ProactivePluginDeclaration[], pluginId: string): boolean {
  const declaration = declarations.find((item) => item.pluginId === pluginId);
  if (!declaration) return false;
  return declaration.spec.sensors.every((sensor) => declaration.grantedSensors.has(sensor.sourceId));
}

export async function runProactiveIntelligenceCycle(
  ctx: ProactiveIntelligenceCycleContext,
): Promise<ProactiveIntelligenceCycleResult> {
  const now = (ctx.now ?? (() => new Date()))();
  const result: ProactiveIntelligenceCycleResult = {
    tenants: 0, timeline: 0, projects: 0, workflows: 0, triggers: 0, verifications: 0,
    conflicts: 0, preparations: 0, attention: 0, drift: 0, relationships: 0, scenes: 0, reviews: 0,
    materializedRules: 0, dispatches: 0,
  };

  for (const profile of await activeProfiles(ctx)) {
    const tenant: LocalContext = {workspaceId: "local", subjectUserId: "local"};
    result.tenants += 1;
    const observations = await ctx.profileRepo.listObservations(tenant, {revisionId: profile.id, limit: 500});
    const actions = await ctx.profileRepo.listActions(tenant, {revisionId: profile.id, limit: 500});
    const claims = await ctx.profileRepo.listClaims(tenant, {revisionId: profile.id, limit: 500});

    // 1. Unified personal timeline.
    for (const observation of observations) {
      const checksum = `observation:${observation.checksum}`;
      await ctx.intelligenceRepo.createTimelineEvent(tenant, {
        id: id("timeline", checksum), revisionId: profile.id, sourceGrantId: observation.sourceGrantId,
        sourceKey: observation.sourceKey, eventType: observation.observationType,
        subjectKey: observation.subjectKey, title: observation.observationType,
        summary: typeof (observation.payload as {content?: unknown})?.content === "string"
          ? String((observation.payload as {content: string}).content).slice(0, 500) : null,
        payload: observation.payload, privacyClass: observation.sourceKey === "restricted.profile" ? "restricted" : "private",
        projectId: null, relationshipId: null, checksum, occurredAt: observation.observedAt,
      });
      result.timeline += 1;
    }
    for (const action of actions) {
      const checksum = `action:${action.id}:${action.state}`;
      await ctx.intelligenceRepo.createTimelineEvent(tenant, {
        id: id("timeline", checksum), revisionId: profile.id, sourceGrantId: null,
        sourceKey: "proactive.action", eventType: `action.${action.state}`, subjectKey: action.target,
        title: action.actionType, summary: action.error ?? null, payload: {state: action.state, scope: action.authorizationScope},
        privacyClass: "private", projectId: null, relationshipId: null, checksum,
        occurredAt: action.finishedAt ?? action.createdAt,
      });
      result.timeline += 1;
    }

    const timeline = await ctx.intelligenceRepo.listTimeline(tenant, {limit: 500});
    const localDate = now.toISOString().slice(0, 10);
    const healthSamples = await ctx.intelligenceRepo.listHealthSamples(tenant, {
      from: localDate,
      to: localDate,
      limit: 100,
    });
    const sleepMinutes = healthSamples.find((item) => item.metric === "sleep_minutes")?.value;
    const dailySteps = healthSamples.find((item) => item.metric === "steps")?.value;

    // 2. Project and intent graph from recurring subjects.
    const bySubject = new Map<string, typeof timeline>();
    for (const event of timeline) {
      const list = bySubject.get(event.subjectKey) ?? [];
      list.push(event);
      bySubject.set(event.subjectKey, list);
    }
    for (const [subjectKey, events] of bySubject) {
      if (events.length < 2 || subjectKey.length < 3) continue;
      await ctx.intelligenceRepo.upsertProject(tenant, {
        id: id("project", subjectKey), revisionId: profile.id, title: subjectKey,
        objective: `Continue ${subjectKey}`, description: `Locally inferred from ${events.length} timeline events`,
        status: "active", priority: Math.min(100, 40 + events.length * 5), confidence: Math.min(95, 45 + events.length * 8),
        dueAt: null, lastActivityAt: events[0]?.occurredAt ?? null,
        sourceTimelineIds: events.slice(0, 50).map((event) => event.id),
      });
      result.projects += 1;
    }

    // 3. Repeated operation workflow mining.
    const operations = timeline.filter((event) => event.sourceKey === "aervox.operation").sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const operationCounts = new Map<string, number>();
    for (const operation of operations) operationCounts.set(operation.eventType, (operationCounts.get(operation.eventType) ?? 0) + 1);
    for (const [eventType, count] of operationCounts) {
      if (count < 3) continue;
      await ctx.intelligenceRepo.upsertWorkflow(tenant, {
        id: id("workflow", eventType), revisionId: profile.id, name: `Repeat ${eventType}`,
        description: `Observed ${count} times`, state: count >= 5 ? "ready" : "candidate",
        trigger: {eventType}, steps: [{eventType}], evidenceCount: count, successCount: 0, failureCount: 0,
        lastObservedAt: operations.filter((item) => item.eventType === eventType).at(-1)?.occurredAt ?? null,
      });
      result.workflows += 1;
    }

    // 6. Profile conflict detection and correction queue.
    const claimsBySubject = new Map<string, typeof claims>();
    for (const claim of claims.filter((item) => item.state !== "rejected")) {
      const list = claimsBySubject.get(claim.subjectKey) ?? [];
      list.push(claim);
      claimsBySubject.set(claim.subjectKey, list);
    }
    for (const claimSet of claimsBySubject.values()) {
      for (let index = 0; index < claimSet.length; index += 1) {
        for (let next = index + 1; next < claimSet.length; next += 1) {
          const left = claimSet[index]!;
          const right = claimSet[next]!;
          if (left.content === right.content) continue;
          await ctx.intelligenceRepo.createClaimConflict(tenant, {
            id: id("conflict", `${left.id}:${right.id}`), revisionId: profile.id,
            primaryClaimId: left.id, conflictingClaimId: right.id,
            reason: `Conflicting claims for ${left.subjectKey}`,
          });
          result.conflicts += 1;
        }
      }
    }

    // 10. Relationship context from communication observations.
    const communications = timeline.filter((event) => event.sourceKey === "external.communication");
    for (const [subjectKey, events] of new Map(communications.map((event) => [event.subjectKey, communications.filter((item) => item.subjectKey === event.subjectKey)]))) {
      await ctx.intelligenceRepo.upsertRelationship(tenant, {
        id: id("relationship", subjectKey), revisionId: profile.id, relationshipType: "contact",
        displayName: subjectKey, notes: `Observed ${events.length} communication events`,
        confidence: Math.min(95, 40 + events.length * 10), lastInteractionAt: events[0]?.occurredAt,
        sourceGrantIds: events.flatMap((event) => event.sourceGrantId ? [event.sourceGrantId] : []),
      });
      result.relationships += 1;
    }

    // 11. Real-time scene model from latest app/screen/browser events.
    const sceneEvents = timeline.filter((event) => ["device.app_activity", "device.screen_capture", "device.browser_activity"].includes(event.sourceKey)).slice(0, 20);
    if (sceneEvents.length > 0) {
      const checksum = hash(sceneEvents.map((event) => event.checksum).join(":"));
      await ctx.intelligenceRepo.createScene(tenant, {
        id: id("scene", checksum), revisionId: profile.id, sceneType: "device_context",
        applicationId: sceneEvents.find((event) => event.sourceKey === "device.app_activity")?.subjectKey ?? null,
        payload: {events: sceneEvents.map((event) => ({id: event.id, type: event.eventType, source: event.sourceKey}))},
        checksum, capturedAt: sceneEvents[0]!.occurredAt,
      });
      result.scenes += 1;
    }

    // 8. Attention/fatigue model over the last hour.
    const hourStart = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const recent = timeline.filter((event) => event.occurredAt >= hourStart);
    const switches = recent.reduce((count, event, index) => index > 0 && recent[index - 1]?.subjectKey !== event.subjectKey ? count + 1 : count, 0);
    const errorSignals = recent.filter((event) => /failed|error|denied/.test(event.eventType)).length;
    const lowSleepPenalty = sleepMinutes !== undefined && sleepMinutes < 360 ? 20 : 0;
    const lowActivityPenalty = dailySteps !== undefined && dailySteps < 1_500 ? 8 : 0;
    const focusScore = Math.max(0, Math.min(100, 85 - switches * 5 - errorSignals * 8 - lowSleepPenalty));
    const fatigueScore = Math.max(0, Math.min(100,
      20 + switches * 6 + errorSignals * 10 + Math.max(0, recent.length - 30) + lowSleepPenalty + lowActivityPenalty,
    ));
    await ctx.intelligenceRepo.createAttentionState(tenant, {
      id: id("attention", `${profile.id}:${now.toISOString().slice(0, 13)}`), revisionId: profile.id,
      windowStart: hourStart, windowEnd: now.toISOString(), focusScore, fatigueScore,
      contextSwitches: switches, errorSignals,
      recommendation: fatigueScore >= 70 ? "Pause high-load work and recover" : focusScore >= 70 ? "Protect the current focus block" : "Choose one next task",
      evidence: [...recent.slice(0, 50).map((event) => event.id), ...healthSamples.map((item) => item.id)],
    }).catch(() => undefined);
    result.attention += 1;

    // 5. Action outcome verification.
    const verifications = await ctx.intelligenceRepo.listActionVerifications(tenant);
    const verifiedActions = new Set(verifications.map((item) => item.actionId));
    for (const action of actions.filter((item) => ["executed", "failed"].includes(item.state) && !verifiedActions.has(item.id))) {
      await ctx.intelligenceRepo.upsertActionVerification(tenant, {
        id: id("verification", action.id), actionId: action.id,
        expected: {state: "executed"}, observed: {state: action.state, outcome: action.outcome},
        status: action.state === "executed" ? "verified" : "failed", attemptCount: 1,
        verifiedAt: now.toISOString(), error: action.error,
      });
      result.verifications += 1;
    }

    // 9. Behaviour drift against declared project activity.
    const projects = await ctx.intelligenceRepo.listProjects(tenant, "active", 200);
    let tenantDriftCount = 0;
    let maxDriftSeverity = 0;
    for (const project of projects) {
      const last = project.lastActivityAt ? Date.parse(project.lastActivityAt) : 0;
      const inactiveDays = Math.floor((now.getTime() - last) / DAY_MS);
      if (inactiveDays < 3) continue;
      const severity = Math.min(100, 40 + inactiveDays * 10);
      maxDriftSeverity = Math.max(maxDriftSeverity, severity);
      await ctx.intelligenceRepo.createDriftSignal(tenant, {
        id: id("drift", `${project.id}:${now.toISOString().slice(0, 10)}`), revisionId: profile.id,
        signalType: "project_stalled", projectId: project.id, expected: {activeWithinDays: 2},
        actual: {inactiveDays}, severity,
        explanation: `${project.title} has had no observed activity for ${inactiveDays} days`,
      }).catch(() => undefined);
      result.drift += 1;
      tenantDriftCount += 1;
    }

    // 7. Proactive preparation for near-term commitments.
    const dueBefore = new Date(now.getTime() + DAY_MS).toISOString();
    const commitments = await ctx.intelligenceRepo.listCommitments(tenant, {status: "open", dueBefore, limit: 200});
    for (const commitment of commitments) {
      const project = projects.find((item) => item.id === commitment.projectId);
      await ctx.intelligenceRepo.createPreparation(tenant, {
        id: id("preparation", `${commitment.id}:${now.toISOString().slice(0, 10)}`), revisionId: profile.id,
        projectId: commitment.projectId, commitmentId: commitment.id,
        title: `Prepare: ${commitment.content}`, bundle: {
          commitment, project, timeline: project ? timeline.filter((event) => event.projectId === project.id).slice(0, 20) : [],
        },
        expiresAt: commitment.dueAt,
      }).catch(() => undefined);
      result.preparations += 1;
    }

    // 4. Context-aware triggers（CR-032 插件化调度：物化 → 求值 → 全局裁决 → 主动回合）
    const declarations = ctx.extensionRepo ? await loadPluginDeclarations(ctx.extensionRepo) : [];
    if (ctx.extensionRepo) {
      const materialization = await materializePluginTriggerRules({
        intelligenceRepo: ctx.intelligenceRepo, tenant, revisionId: profile.id, declarations, now,
      });
      result.materializedRules += materialization.materialized;
    }

    const builtInRules = [
      {id: "commitment_due", name: "Upcoming commitment", triggerType: "commitment_due", condition: {hours: 24}},
      {id: "fatigue_high", name: "High fatigue", triggerType: "fatigue_high", condition: {score: 70}},
      {id: "drift_high", name: "Plan drift", triggerType: "drift_high", condition: {severity: 60}},
      {id: "health_sleep_low", name: "Low sleep context", triggerType: "health_sleep_low", condition: {minutes: 360}},
    ];
    for (const rule of builtInRules) {
      await ctx.intelligenceRepo.upsertTriggerRule(tenant, {
        id: `rule_${profile.id}_${rule.id}`, revisionId: profile.id, name: rule.name,
        triggerType: rule.triggerType, condition: rule.condition, action: {kind: "notify"}, enabled: true,
        cooldownSeconds: 6 * 3600, quietHours: {start: "22:00", end: "07:00"},
        // undefined：保留裁决器写回的冷却起点（此前每周期清零导致 cooldown 永不生效）
        lastTriggeredAt: undefined,
      });
    }

    const existingTriggerIds = new Set((await ctx.intelligenceRepo.listTriggerEvents(tenant, 500)).map((event) => event.id));
    const windowStart = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    let dispatchedInWindow = (await ctx.intelligenceRepo.listTriggerEventsSince(tenant, windowStart, 500))
      .filter((event) => event.decision === "dispatch").length;

    const signals = {
      now,
      fatigueScore,
      driftSeverity: maxDriftSeverity > 0 ? maxDriftSeverity : undefined,
      sleepMinutes,
      dueCommitments: commitments.map((item) => ({id: item.id, content: item.content, dueAt: item.dueAt})),
      idleSamples: (await ctx.profileRepo.listObservations(tenant, {revisionId: profile.id, sourceKey: "system.idle_state", limit: 200}))
        .map((item) => {
          const raw = (item.payload as {idleSeconds?: unknown} | null)?.idleSeconds;
          return {observedAt: item.observedAt, idleSeconds: typeof raw === "number" ? raw : Number.NaN};
        })
        .filter((item) => Number.isFinite(item.idleSeconds))
        .sort((left, right) => left.observedAt.localeCompare(right.observedAt)),
    };

    // 候选集：内置规则沿用既有候选逻辑；插件规则读物化规则逐条求值
    const candidates: Array<{rule: IntelligenceTriggerRule; evaluation: ReturnType<typeof evaluateTriggerRule>}> = [];
    for (const rule of await ctx.intelligenceRepo.listTriggerRules(tenant, true)) {
      if (rule.pluginId) {
        candidates.push({rule, evaluation: evaluateTriggerRule(rule, signals)});
        continue;
      }
      // 内置规则候选（行为保持：逐类型条件比对）
      const builtInHit =
        (rule.triggerType === "commitment_due" && commitments.length > 0) ||
        (rule.triggerType === "fatigue_high" && fatigueScore >= 70) ||
        (rule.triggerType === "drift_high" && tenantDriftCount > 0) ||
        (rule.triggerType === "health_sleep_low" && sleepMinutes !== undefined && sleepMinutes < 360);
      if (!builtInHit) continue;
      const cause =
        rule.triggerType === "commitment_due" ? {count: commitments.length}
        : rule.triggerType === "fatigue_high" ? {fatigueScore}
        : rule.triggerType === "drift_high" ? {count: tenantDriftCount}
        : {sleepMinutes};
      candidates.push({
        rule,
        evaluation: {
          hit: true, cause,
          reason:
            rule.triggerType === "commitment_due" ? "Upcoming commitment due within 24h"
            : rule.triggerType === "fatigue_high" ? "High context switching or errors"
            : rule.triggerType === "drift_high" ? "Project activity differs from plan"
            : "Recent sleep duration is below the configured recovery threshold",
        },
      });
    }

    for (const {rule, evaluation} of candidates) {
      const localDate = now.toISOString().slice(0, 10);
      if (!evaluation.hit) {
        // 未命中不落事件（与既有行为一致：条件未满足即静默）
        continue;
      }
      const verdict = arbitrate({
        now,
        lastTriggeredAt: rule.lastTriggeredAt ?? null,
        cooldownSeconds: rule.pluginId ? Math.max(rule.cooldownSeconds, MIN_PLUGIN_COOLDOWN_SECONDS) : rule.cooldownSeconds,
        quietHoursPolicy: rule.pluginId
          ? (((rule.quietHours as {policy?: string} | null)?.policy === "bypass" ? "bypass" : "respect_global") as "bypass" | "respect_global")
          : "respect_global",
        quietHours: null,
        globalQuietHours: ctx.globalQuietHours ?? DEFAULT_GLOBAL_QUIET_HOURS,
        authorized: !rule.pluginId || isDeclarationAuthorized(declarations, rule.pluginId),
        dispatchedInWindow,
        maxDispatchesPerHour: ctx.maxDispatchesPerHour ?? DEFAULT_MAX_DISPATCHES_PER_HOUR,
      });

      if (verdict.decision !== "dispatch") {
        // 抑制决策按 (规则, 决策, 日) 去重落事件，避免逐节拍刷屏
        const suppressedEventId = id("trigger", `${profile.id}:${rule.id}:${verdict.decision}:${localDate}`);
        if (!existingTriggerIds.has(suppressedEventId)) {
          existingTriggerIds.add(suppressedEventId);
          await ctx.intelligenceRepo.recordTriggerEvent(tenant, {
            id: suppressedEventId, revisionId: profile.id, ruleId: rule.id,
            triggerType: rule.triggerType, cause: evaluation.cause, decision: verdict.decision, reason: verdict.reason,
          });
        }
        result.triggers += 1;
        continue;
      }

      const dispatchEventId = id("trigger", `${profile.id}:${rule.id}:${now.toISOString()}`);
      existingTriggerIds.add(dispatchEventId);
      try {
        const dispatched = await dispatchProactiveTurn(ctx, tenant, profile, rule, evaluation, declarations, now);
        await ctx.intelligenceRepo.recordTriggerEvent(tenant, {
          id: dispatchEventId, revisionId: profile.id, ruleId: rule.id,
          triggerType: rule.triggerType, cause: evaluation.cause, decision: "dispatch", reason: evaluation.reason,
          actionId: dispatched.actionId,
        });
        await ctx.intelligenceRepo.updateTriggerRuleLastTriggeredAt(tenant, rule.id, now.toISOString());
        dispatchedInWindow += 1;
        result.dispatches += 1;
        result.triggers += 1;
        if (ctx.platformRepo) {
          await ctx.platformRepo.createNotification(tenant, {
            id: id("notification", dispatchEventId), type: `proactive.${rule.triggerType}`,
            scheduledAt: now.toISOString(), channel: "in_app",
            payload: {
              kind: "plugin_dispatch", pluginId: rule.pluginId ?? "builtin", ruleId: rule.id,
              title: rule.name, triggerType: rule.triggerType,
              message: dispatched.message, source: dispatched.source, presentation: dispatched.presentation,
              occurredAt: now.toISOString(),
            },
          }).catch(() => undefined);
        }
      } catch (error) {
        // 派发失败（如 vault action.local 授权缺失）按日去重记录，冷却起点不推进以便重试
        const failedEventId = id("trigger", `${profile.id}:${rule.id}:failed_dispatch:${localDate}`);
        if (!existingTriggerIds.has(failedEventId)) {
          existingTriggerIds.add(failedEventId);
          await ctx.intelligenceRepo.recordTriggerEvent(tenant, {
            id: failedEventId, revisionId: profile.id, ruleId: rule.id,
            triggerType: rule.triggerType, cause: evaluation.cause, decision: "failed_dispatch",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        result.triggers += 1;
      }
    }

    // 12. Automatic daily review.
    const dayStart = `${localDate}T00:00:00.000Z`;
    const dayTimeline = timeline.filter((event) => event.occurredAt >= dayStart);
    await ctx.intelligenceRepo.upsertReview(tenant, {
      id: id("review", `${profile.id}:${localDate}`), revisionId: profile.id, periodType: "daily",
      periodStart: localDate, periodEnd: localDate,
      summary: `${dayTimeline.length} timeline events, ${projects.length} active projects, ${commitments.length} near-term commitments`,
      metrics: {
        timelineEvents: dayTimeline.length, activeProjects: projects.length, dueCommitments: commitments.length,
        focusScore, fatigueScore, sleepMinutes: sleepMinutes ?? null, dailySteps: dailySteps ?? null,
      },
      recommendations: [fatigueScore >= 70 ? "Reduce cognitive load" : "Protect focus", commitments.length > 0 ? "Review upcoming commitments" : "No urgent commitment"],
    });
    result.reviews += 1;

    const week = utcWeekRange(now);
    const weekTimeline = timeline.filter((event) => event.occurredAt.slice(0, 10) >= week.start && event.occurredAt.slice(0, 10) <= week.end);
    const completedActions = actions.filter((action) => action.state === "executed" && action.createdAt.slice(0, 10) >= week.start);
    await ctx.intelligenceRepo.upsertReview(tenant, {
      id: id("review_week", `${profile.id}:${week.start}`), revisionId: profile.id, periodType: "weekly",
      periodStart: week.start, periodEnd: week.end,
      summary: `${weekTimeline.length} timeline events and ${completedActions.length} completed proactive actions this week`,
      metrics: {
        timelineEvents: weekTimeline.length,
        completedActions: completedActions.length,
        activeProjects: projects.length,
        openConflicts: (await ctx.intelligenceRepo.listClaimConflicts(tenant, "open")).length,
      },
      recommendations: [
        tenantDriftCount > 0 ? "Reconfirm stalled project priorities" : "Keep current project cadence",
        "Review learned workflows before enabling automatic execution",
      ],
    });
    result.reviews += 1;
  }
  return result;
}
