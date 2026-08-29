/** Deterministic local engine for the twelve proactive intelligence capabilities. */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  proactiveProfileRevisions,
  type AervoxDatabase,
  type SqlitePlatformRepository,
  type SqliteProactiveIntelligenceRepository,
  type SqliteProactiveProfileRepository,
  type TenantContext,
} from "@aervox/database";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 20);
const id = (prefix: string, value: string): string => `${prefix}_${hash(value)}`;
const DAY_MS = 24 * 60 * 60 * 1000;

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
}

async function activeProfiles(ctx: ProactiveIntelligenceCycleContext) {
  return ctx.db.select({
    id: proactiveProfileRevisions.id,
    workspaceId: proactiveProfileRevisions.workspaceId,
    subjectUserId: proactiveProfileRevisions.subjectUserId,
  }).from(proactiveProfileRevisions).where(and(
    eq(proactiveProfileRevisions.status, "active"),
    eq(proactiveProfileRevisions.desiredState, "enabled"),
  ));
}

export async function runProactiveIntelligenceCycle(
  ctx: ProactiveIntelligenceCycleContext,
): Promise<ProactiveIntelligenceCycleResult> {
  const now = (ctx.now ?? (() => new Date()))();
  const result: ProactiveIntelligenceCycleResult = {
    tenants: 0, timeline: 0, projects: 0, workflows: 0, triggers: 0, verifications: 0,
    conflicts: 0, preparations: 0, attention: 0, drift: 0, relationships: 0, scenes: 0, reviews: 0,
  };

  for (const profile of await activeProfiles(ctx)) {
    const tenant: TenantContext = {workspaceId: profile.workspaceId, subjectUserId: profile.subjectUserId};
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
    for (const project of projects) {
      const last = project.lastActivityAt ? Date.parse(project.lastActivityAt) : 0;
      const inactiveDays = Math.floor((now.getTime() - last) / DAY_MS);
      if (inactiveDays < 3) continue;
      await ctx.intelligenceRepo.createDriftSignal(tenant, {
        id: id("drift", `${project.id}:${now.toISOString().slice(0, 10)}`), revisionId: profile.id,
        signalType: "project_stalled", projectId: project.id, expected: {activeWithinDays: 2},
        actual: {inactiveDays}, severity: Math.min(100, 40 + inactiveDays * 10),
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

    // 4. Context-aware triggers with local records and in-app notification projection.
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
        cooldownSeconds: 6 * 3600, quietHours: {start: "22:00", end: "07:00"}, lastTriggeredAt: null,
      });
    }
    const triggerCandidates = [
      ...commitments.map((item) => ({type: "commitment_due", cause: {commitmentId: item.id}, reason: item.content})),
      ...(fatigueScore >= 70 ? [{type: "fatigue_high", cause: {fatigueScore}, reason: "High context switching or errors"}] : []),
      ...(tenantDriftCount > 0 ? [{type: "drift_high", cause: {count: tenantDriftCount}, reason: "Project activity differs from plan"}] : []),
      ...(sleepMinutes !== undefined && sleepMinutes < 360
        ? [{type: "health_sleep_low", cause: {sleepMinutes}, reason: "Recent sleep duration is below the configured recovery threshold"}]
        : []),
    ];
    const existingTriggerIds = new Set((await ctx.intelligenceRepo.listTriggerEvents(tenant, 500)).map((event) => event.id));
    for (const candidate of triggerCandidates) {
      const eventId = id("trigger", `${profile.id}:${candidate.type}:${now.toISOString().slice(0, 10)}`);
      if (existingTriggerIds.has(eventId)) continue;
      await ctx.intelligenceRepo.recordTriggerEvent(tenant, {
        id: eventId, revisionId: profile.id, ruleId: `rule_${profile.id}_${candidate.type}`,
        triggerType: candidate.type, cause: candidate.cause, decision: "notify", reason: candidate.reason,
      });
      if (ctx.platformRepo) {
        await ctx.platformRepo.createNotification(tenant, {
          id: id("notification", eventId), type: `proactive.${candidate.type}`,
          scheduledAt: now.toISOString(), channel: "in_app",
        }).catch(() => undefined);
      }
      result.triggers += 1;
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
