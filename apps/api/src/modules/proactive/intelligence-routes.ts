import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveProfileRepository,
} from "@aervox/database";
import { resolveTenant } from "../../shared/tenant.js";

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
const bodyOf = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const number = (value: unknown, fallback = 0): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

async function revisionId(profileRepo: SqliteProactiveProfileRepository, req: Parameters<typeof resolveTenant>[0]) {
  const revision = await profileRepo.getRevision(resolveTenant(req));
  // 409 而非默认 500：尚未确认画像授权是客户端可恢复的前置条件缺失。
  if (!revision) {
    const error = new Error("proactive_profile_revision_required") as Error & {statusCode?: number};
    error.statusCode = 409;
    throw error;
  }
  return revision.id;
}

export function registerProactiveIntelligenceRoutes(
  app: FastifyInstance,
  deps: { intelligenceRepo: SqliteProactiveIntelligenceRepository; profileRepo: SqliteProactiveProfileRepository },
): void {
  const repo = deps.intelligenceRepo;

  app.get("/v1/proactive/intelligence/dashboard", async (req) => {
    const tenant = resolveTenant(req);
    const [timeline, projects, commitments, workflows, triggers, verifications, conflicts, preparations, attention, drift, relationships, scenes, reviews, connections, homeEntities, health] = await Promise.all([
      repo.listTimeline(tenant, {limit: 20}), repo.listProjects(tenant, "active", 20), repo.listCommitments(tenant, {status: "open", limit: 20}),
      repo.listWorkflows(tenant, undefined, 20), repo.listTriggerEvents(tenant, 20), repo.listActionVerifications(tenant),
      repo.listClaimConflicts(tenant, "open"), repo.listPreparations(tenant, "ready", 20),
      repo.listAttentionStates(tenant, 10), repo.listDriftSignals(tenant, "open", 20), repo.listRelationships(tenant, 20),
      repo.listScenes(tenant, 10), repo.listReviews(tenant, 10), repo.listConnections(tenant), repo.listHomeEntities(tenant), repo.listHealthSamples(tenant, {limit: 20}),
    ]);
    return {timeline, projects, commitments, workflows, triggers, verifications, conflicts, preparations, attention, drift, relationships, scenes, reviews, connections, homeEntities, health};
  });

  app.get("/v1/proactive/intelligence/timeline", async (req) => {
    const query = req.query as Record<string, unknown>;
    return {items: await repo.listTimeline(resolveTenant(req), {from: text(query.from), to: text(query.to), sourceKey: text(query.sourceKey), projectId: text(query.projectId), limit: number(query.limit, 100)})};
  });
  app.post("/v1/proactive/intelligence/timeline", async (req, reply) => {
    const body = bodyOf(req.body);
    const sourceKey = text(body.sourceKey), eventType = text(body.eventType), subjectKey = text(body.subjectKey), title = text(body.title);
    if (!sourceKey || !eventType || !subjectKey || !title) return reply.code(400).send({error: "sourceKey, eventType, subjectKey and title are required"});
    const canonical = JSON.stringify({sourceKey, eventType, subjectKey, title, occurredAt: body.occurredAt, payload: body.payload});
    return reply.code(201).send(await repo.createTimelineEvent(resolveTenant(req), {
      id: text(body.id) ?? nextId("timeline"), revisionId: await revisionId(deps.profileRepo, req),
      sourceGrantId: text(body.sourceGrantId) ?? null, sourceKey, eventType, subjectKey, title,
      summary: text(body.summary) ?? null, payload: body.payload ?? {}, privacyClass: text(body.privacyClass) ?? "private",
      projectId: text(body.projectId) ?? null, relationshipId: text(body.relationshipId) ?? null,
      checksum: text(body.checksum) ?? createHash("sha256").update(canonical).digest("hex"),
      occurredAt: text(body.occurredAt) ?? new Date().toISOString(),
    }));
  });

  app.get("/v1/proactive/intelligence/projects", async (req) => ({items: await repo.listProjects(resolveTenant(req), text((req.query as Record<string, unknown>).status))}));
  app.post("/v1/proactive/intelligence/projects", async (req, reply) => {
    const body = bodyOf(req.body); const title = text(body.title);
    if (!title) return reply.code(400).send({error: "title is required"});
    const item = await repo.upsertProject(resolveTenant(req), {
      id: text(body.id) ?? nextId("project"), revisionId: await revisionId(deps.profileRepo, req), title,
      objective: text(body.objective) ?? null, description: text(body.description) ?? null, status: text(body.status) ?? "active",
      priority: number(body.priority, 50), confidence: number(body.confidence, 100), dueAt: text(body.dueAt) ?? null,
      lastActivityAt: text(body.lastActivityAt) ?? new Date().toISOString(), sourceTimelineIds: stringArray(body.sourceTimelineIds),
    });
    return reply.code(201).send(item);
  });

  app.get("/v1/proactive/intelligence/commitments", async (req) => {
    const query = req.query as Record<string, unknown>;
    return {items: await repo.listCommitments(resolveTenant(req), {status: text(query.status), dueBefore: text(query.dueBefore), limit: number(query.limit, 100)})};
  });
  app.post("/v1/proactive/intelligence/commitments", async (req, reply) => {
    const body = bodyOf(req.body); const content = text(body.content);
    if (!content) return reply.code(400).send({error: "content is required"});
    return reply.code(201).send(await repo.createCommitment(resolveTenant(req), {
      id: text(body.id) ?? nextId("commitment"), revisionId: await revisionId(deps.profileRepo, req),
      projectId: text(body.projectId) ?? null, relationshipId: text(body.relationshipId) ?? null,
      content, status: text(body.status) ?? "open", importance: number(body.importance, 50),
      dueAt: text(body.dueAt) ?? null, sourceTimelineId: text(body.sourceTimelineId) ?? null,
    }));
  });
  app.patch("/v1/proactive/intelligence/commitments/:id", async (req, reply) => {
    const {id} = req.params as {id: string}; const status = text(bodyOf(req.body).status);
    if (!status) return reply.code(400).send({error: "status is required"});
    const updated = await repo.updateCommitmentStatus(resolveTenant(req), id, status);
    return updated ?? reply.code(404).send({error: "commitment not found"});
  });

  app.get("/v1/proactive/intelligence/workflows", async (req) => ({items: await repo.listWorkflows(resolveTenant(req), text((req.query as Record<string, unknown>).state))}));
  app.post("/v1/proactive/intelligence/workflows", async (req, reply) => {
    const body = bodyOf(req.body); const name = text(body.name);
    if (!name) return reply.code(400).send({error: "name is required"});
    return reply.code(201).send(await repo.upsertWorkflow(resolveTenant(req), {
      id: text(body.id) ?? nextId("workflow"), revisionId: await revisionId(deps.profileRepo, req), name,
      description: text(body.description) ?? null, state: text(body.state) ?? "candidate", trigger: body.trigger ?? {},
      steps: Array.isArray(body.steps) ? body.steps : [], evidenceCount: number(body.evidenceCount, 1),
      successCount: number(body.successCount), failureCount: number(body.failureCount), lastObservedAt: text(body.lastObservedAt) ?? null,
    }));
  });

  app.get("/v1/proactive/intelligence/triggers", async (req) => ({rules: await repo.listTriggerRules(resolveTenant(req)), events: await repo.listTriggerEvents(resolveTenant(req), number((req.query as Record<string, unknown>).limit, 50))}));
  app.post("/v1/proactive/intelligence/triggers", async (req, reply) => {
    const body = bodyOf(req.body); const name = text(body.name), triggerType = text(body.triggerType);
    if (!name || !triggerType) return reply.code(400).send({error: "name and triggerType are required"});
    return reply.code(201).send(await repo.upsertTriggerRule(resolveTenant(req), {
      id: text(body.id) ?? nextId("rule"), revisionId: await revisionId(deps.profileRepo, req), name, triggerType,
      condition: body.condition ?? {}, action: body.action ?? {}, enabled: body.enabled === true,
      cooldownSeconds: number(body.cooldownSeconds, 3600), quietHours: body.quietHours ?? {}, lastTriggeredAt: text(body.lastTriggeredAt) ?? null,
    }));
  });

  app.get("/v1/proactive/intelligence/verifications", async (req) => ({items: await repo.listActionVerifications(resolveTenant(req), text((req.query as Record<string, unknown>).status))}));
  app.post("/v1/proactive/intelligence/verifications", async (req, reply) => {
    const body = bodyOf(req.body); const actionId = text(body.actionId), status = text(body.status);
    if (!actionId || !status) return reply.code(400).send({error: "actionId and status are required"});
    return reply.code(201).send(await repo.upsertActionVerification(resolveTenant(req), {
      id: text(body.id) ?? nextId("verification"), actionId, expected: body.expected, observed: body.observed,
      status, attemptCount: number(body.attemptCount), verifiedAt: text(body.verifiedAt) ?? null, error: text(body.error) ?? null,
    }));
  });

  app.get("/v1/proactive/intelligence/conflicts", async (req) => ({items: await repo.listClaimConflicts(resolveTenant(req), text((req.query as Record<string, unknown>).status))}));
  app.post("/v1/proactive/intelligence/conflicts/:id/resolve", async (req, reply) => {
    const resolution = text(bodyOf(req.body).resolution); if (!resolution) return reply.code(400).send({error: "resolution is required"});
    const item = await repo.resolveClaimConflict(resolveTenant(req), (req.params as {id: string}).id, resolution);
    return item ?? reply.code(404).send({error: "conflict not found"});
  });

  app.get("/v1/proactive/intelligence/preparations", async (req) => ({items: await repo.listPreparations(resolveTenant(req), text((req.query as Record<string, unknown>).status))}));
  app.get("/v1/proactive/intelligence/attention", async (req) => ({items: await repo.listAttentionStates(resolveTenant(req), number((req.query as Record<string, unknown>).limit, 50))}));
  app.get("/v1/proactive/intelligence/drift", async (req) => ({items: await repo.listDriftSignals(resolveTenant(req), text((req.query as Record<string, unknown>).state))}));

  app.get("/v1/proactive/intelligence/relationships", async (req) => ({items: await repo.listRelationships(resolveTenant(req), number((req.query as Record<string, unknown>).limit, 100))}));
  app.post("/v1/proactive/intelligence/relationships", async (req, reply) => {
    const body = bodyOf(req.body), displayName = text(body.displayName);
    if (!displayName) return reply.code(400).send({error: "displayName is required"});
    return reply.code(201).send(await repo.upsertRelationship(resolveTenant(req), {
      id: text(body.id) ?? nextId("relationship"), revisionId: await revisionId(deps.profileRepo, req),
      relationshipType: text(body.relationshipType) ?? "contact", displayName, notes: text(body.notes) ?? null,
      state: text(body.state) ?? "active", confidence: number(body.confidence, 100),
      lastInteractionAt: text(body.lastInteractionAt) ?? null, sourceGrantIds: stringArray(body.sourceGrantIds),
    }));
  });
  app.get("/v1/proactive/intelligence/scenes", async (req) => ({items: await repo.listScenes(resolveTenant(req), number((req.query as Record<string, unknown>).limit, 50))}));
  app.get("/v1/proactive/intelligence/reviews", async (req) => ({items: await repo.listReviews(resolveTenant(req), number((req.query as Record<string, unknown>).limit, 30))}));
  app.get("/v1/proactive/intelligence/export", async (req) => repo.exportSnapshot(resolveTenant(req)));
}
