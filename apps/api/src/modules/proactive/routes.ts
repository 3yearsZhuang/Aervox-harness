/**
 * Aervox｜思隅 @aervox/api — CAP-033 主动智能模式控制面
 *
 * 这里仅提供本地 Host/用户控制面和数据管道入口。原始捕获默认脱敏，导出
 * 必须由用户显式请求；所有动作都保留独立 actionGrantRevision。
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  IProactiveProfileRepository,
  IPrivacyRepository,
  ProactiveActionState,
  ProactiveCaptureDistillationStatus,
  ProactiveClaimState,
  ProactiveDesiredState,
  ProactiveSourceGrantState,
} from "@aervox/database";
import { FULL_PROFILE_SOURCE_MANIFEST } from "@aervox/database";
import { resolveTenant } from "../../shared/tenant.js";

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function actorFor(req: Parameters<typeof resolveTenant>[0]): string {
  const tenant = resolveTenant(req);
  return tenant.actorId ?? tenant.subjectUserId;
}

function idFromRequest(
  req: Parameters<typeof resolveTenant>[0],
  prefix: string,
  explicit: unknown,
): string {
  const provided = requiredString(explicit);
  if (provided) return provided;
  const idempotencyKey = req.headers["idempotency-key"];
  if (typeof idempotencyKey === "string" && idempotencyKey.trim().length > 0) {
    return `${prefix}_${sha256(idempotencyKey.trim()).slice(0, 32)}`;
  }
  return nextId(prefix);
}

function validDesiredState(value: unknown): value is ProactiveDesiredState {
  return value === "enabled" || value === "paused" || value === "revoked";
}

function validSourceState(value: unknown): value is ProactiveSourceGrantState {
  return value === "requested" || value === "granted" || value === "denied" || value === "revoked" || value === "expired";
}

function validClaimState(value: unknown): value is ProactiveClaimState {
  return value === "observed" || value === "inferred" || value === "user_asserted" || value === "confirmed" || value === "rejected";
}

function validActionState(value: unknown): value is ProactiveActionState {
  return value === "pending" || value === "approved" || value === "running" || value === "executed" || value === "denied" || value === "failed" || value === "revoked";
}

function validDistillationStatus(value: unknown): value is ProactiveCaptureDistillationStatus {
  return value === "pending" || value === "distilled" || value === "failed" || value === "blocked" || value === "deleted";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeLimit(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(500, Math.floor(n))) : undefined;
}

export interface ProactiveRouteDeps {
  repository: IProactiveProfileRepository;
  /** CAP-033 consent projection lives in the same local Vault when supplied. */
  privacyRepository?: IPrivacyRepository;
}

function consentId(revisionId: string, sourceKey: string): string {
  return `${revisionId}_consent_${sourceKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function registerProactiveRoutes(app: FastifyInstance, deps: ProactiveRouteDeps): void {
  const repo = deps.repository;

  app.get("/v1/proactive/status", async (req) => {
    const status = await repo.getEffectiveStatus(resolveTenant(req));
    return {
      version: "full_profile_v1",
      processingBoundary: "local_only",
      exportAvailable: true,
      ...status,
    };
  });

  app.get("/v1/proactive/manifest", async () => ({
    version: "full_profile_v1",
    processingBoundary: "local_only",
    sources: FULL_PROFILE_SOURCE_MANIFEST,
    persistence: {
      autostart: true,
      background: true,
      sleepResume: true,
      restartResume: true,
      rawRetentionDays: 7,
      rawDeleteAfterMemoryExtraction: true,
    },
  }));

  app.get("/v1/proactive/revisions", async (req) => ({
    items: await repo.listRevisions(resolveTenant(req), safeLimit((req.query as { limit?: unknown }).limit)),
  }));

  app.post("/v1/proactive/drafts", async (req, reply) => {
    const body = objectBody(req.body);
    const deviceId = requiredString(body.deviceId);
    if (!deviceId) return reply.code(400).send({ error: "deviceId is required" });
    const draft = await repo.createDraft(resolveTenant(req), {
      id: idFromRequest(req, "pro_profile", body.id),
      profileVersion: optionalString(body.profileVersion),
      deviceId,
      manifest: body.manifest,
      actorId: actorFor(req),
    });
    return reply.code(201).send(draft);
  });

  app.post("/v1/proactive/authorize", async (req, reply) => {
    const body = objectBody(req.body);
    // 主动智能授权必须与 CR-022 的 Turn full_access 明确绑定，不能由画像授权替代。
    if (body.fullAccessConfirmed !== true && body.toolApprovalMode !== "full_access") {
      return reply.code(409).send({ error: "full_access_confirmation_required" });
    }
    if (body.acknowledged !== undefined && body.acknowledged !== true) {
      return reply.code(400).send({ error: "profile_authorization_acknowledgement_required" });
    }
    const deviceId = requiredString(body.deviceId);
    if (!deviceId) return reply.code(400).send({ error: "deviceId is required" });
    const profileId = idFromRequest(req, "pro_profile", body.id);
    const rawSources = Array.isArray(body.sources) ? body.sources : undefined;
    const parsedSources = rawSources?.map((raw, index) => {
      const source = objectBody(raw);
      const sourceKey = requiredString(source.sourceKey);
      if (!sourceKey) return null;
      const state = validSourceState(source.state) ? source.state : "requested";
      return {
        id: requiredString(source.id) ?? `${profileId}_source_${index + 1}`,
        sourceKey,
        purpose: optionalString(source.purpose),
        scope: optionalString(source.scope),
        osCapability: optionalString(source.osCapability),
        state,
        mandatory: optionalBoolean(source.mandatory, true),
        grantVersion: typeof source.grantVersion === "number" ? Math.max(1, Math.floor(source.grantVersion)) : 1,
        metadata: source.metadata,
        grantedAt: optionalString(source.grantedAt) ?? null,
        lastVerifiedAt: optionalString(source.lastVerifiedAt) ?? null,
      };
    }).filter((source): source is NonNullable<typeof source> => source !== null) ?? [];
    // full_profile_v1 的 manifest 是固定全量清单；调用方只回报已拿到的 OS grant
    // 时，其余来源仍落为 requested，不能因请求体省略而暗示授权范围变小。
    // mandatory 是服务端策略（当前版本支持的最小激活集），不信任客户端声明：
    // 无平台 Provider 的来源不能被客户端改回 mandatory 而重新闸死激活。
    const parsedByKey = new Map(parsedSources.map((source) => [source.sourceKey, source]));
    const sources = FULL_PROFILE_SOURCE_MANIFEST.map((manifest, index) => {
      const parsed = parsedByKey.get(manifest.sourceKey);
      if (parsed) return {...parsed, mandatory: manifest.mandatory};
      return {
        id: `${profileId}_source_${index + 1}`,
        sourceKey: manifest.sourceKey,
        purpose: manifest.purpose,
        scope: "all",
        osCapability: manifest.osCapability,
        state: "requested" as const,
        mandatory: manifest.mandatory,
        grantVersion: 1,
        metadata: {},
        grantedAt: null,
        lastVerifiedAt: null,
      };
    });
    // Preserve explicitly supplied non-catalog source IDs for forward-compatible adapters.
    for (const source of parsedSources) {
      if (!FULL_PROFILE_SOURCE_MANIFEST.some((item) => item.sourceKey === source.sourceKey)) sources.push(source);
    }
    const tenant = resolveTenant(req);
    const existed = await repo.getRevision(tenant, profileId);
    const result = await repo.confirmProfile(tenant, {
      id: profileId,
      profileVersion: optionalString(body.profileVersion),
      deviceId,
      manifest: body.manifest,
      grantSetHash: optionalString(body.grantSetHash) ?? null,
      fullAccessSnapshot: true,
      actorId: actorFor(req),
      sources,
    });
    // Consent is a separate product-purpose record, but is projected into the same
    // local Vault. Idempotent retries reuse the deterministic grant id.
    if (deps.privacyRepository) {
      for (const source of result.sources) {
        const id = consentId(result.revision.id, source.sourceKey);
        if (await deps.privacyRepository.hasActiveConsent(tenant, "proactive_profile", source.sourceKey)) continue;
        try {
          await deps.privacyRepository.grantConsent(tenant, {
            id,
            actorId: actorFor(req),
            purpose: "proactive_profile",
            scope: source.sourceKey,
            policyVersion: result.revision.profileVersion,
          });
        } catch {
          // A concurrent idempotent authorization may have inserted the grant.
        }
      }
    }
    return reply.code(existed?.id === result.revision.id ? 200 : 201).send(result);
  });

  app.post("/v1/proactive/desired-state", async (req, reply) => {
    const body = objectBody(req.body);
    if (!validDesiredState(body.desiredState)) return reply.code(400).send({ error: "invalid desiredState" });
    const tenant = resolveTenant(req);
    const updated = await repo.setDesiredState(
      tenant,
      body.desiredState,
      actorFor(req),
      optionalString(body.revisionId),
    );
    if (!updated) return reply.code(404).send({ error: "proactive profile revision not found" });
    if (body.desiredState === "revoked" && deps.privacyRepository) {
      const sourceGrants = await repo.listSourceGrants(tenant, updated.id);
      for (const source of sourceGrants) {
        await deps.privacyRepository.revokeConsent(tenant, consentId(updated.id, source.sourceKey));
      }
    }
    return updated;
  });

  app.get("/v1/proactive/sources", async (req) => ({
    items: await repo.listSourceGrants(resolveTenant(req), optionalString((req.query as { revisionId?: unknown }).revisionId)),
  }));

  app.patch("/v1/proactive/sources/:sourceGrantId", async (req, reply) => {
    const { sourceGrantId } = req.params as { sourceGrantId: string };
    const body = objectBody(req.body);
    if (!validSourceState(body.state)) return reply.code(400).send({ error: "invalid source state" });
    const tenant = resolveTenant(req);
    const updated = await repo.updateSourceGrant(tenant, sourceGrantId, {
      state: body.state,
      metadata: body.metadata,
      lastVerifiedAt: optionalString(body.lastVerifiedAt) ?? null,
      actorId: actorFor(req),
    });
    if (!updated) return reply.code(404).send({ error: "source grant not found" });
    if ((body.state === "revoked" || body.state === "expired") && deps.privacyRepository) {
      await deps.privacyRepository.revokeConsent(tenant, consentId(updated.revisionId, updated.sourceKey));
    }
    return updated;
  });

  app.delete("/v1/proactive/sources/:sourceGrantId/data", async (req, reply) => {
    const { sourceGrantId } = req.params as { sourceGrantId: string };
    const deleted = await repo.deleteSourceData(resolveTenant(req), sourceGrantId, actorFor(req));
    if (!deleted) return reply.code(404).send({ error: "source grant not found" });
    return deleted;
  });

  app.post("/v1/proactive/activation", async (req, reply) => {
    const body = objectBody(req.body);
    const revisionId = requiredString(body.revisionId);
    const deviceId = requiredString(body.deviceId);
    const epoch = requiredString(body.epoch);
    if (!revisionId || !deviceId || !epoch) return reply.code(400).send({ error: "revisionId, deviceId and epoch are required" });
    const lease = await repo.createActivationLease(resolveTenant(req), {
      id: idFromRequest(req, "pro_lease", body.id),
      revisionId,
      deviceId,
      epoch,
      ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : undefined,
      localReady: body.localReady === true,
      fullAccessSnapshot: body.fullAccessSnapshot === true,
      metadata: body.metadata,
      actorId: actorFor(req),
    });
    return reply.code(201).send(lease);
  });

  app.post("/v1/proactive/activation/:leaseId/heartbeat", async (req, reply) => {
    const { leaseId } = req.params as { leaseId: string };
    const body = objectBody(req.body);
    const lease = await repo.heartbeatActivationLease(resolveTenant(req), leaseId, {
      ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : undefined,
      localReady: typeof body.localReady === "boolean" ? body.localReady : undefined,
      fullAccessSnapshot: typeof body.fullAccessSnapshot === "boolean" ? body.fullAccessSnapshot : undefined,
      metadata: body.metadata,
    });
    if (!lease) return reply.code(404).send({ error: "activation lease not found" });
    return lease;
  });

  app.post("/v1/proactive/activation/:leaseId/end", async (req, reply) => {
    const { leaseId } = req.params as { leaseId: string };
    const body = objectBody(req.body);
    const ended = await repo.endActivationLease(resolveTenant(req), leaseId, optionalString(body.reason) ?? "user_requested", actorFor(req));
    if (!ended) return reply.code(404).send({ error: "activation lease not found" });
    return ended;
  });

  app.get("/v1/proactive/captures", async (req) => {
    const query = req.query as { revisionId?: unknown; sourceKey?: unknown; includeDeleted?: unknown; includeRaw?: unknown; limit?: unknown };
    // payload 正文只有显式 includeRaw=true 才返回；仓储结果在这里再做一次防线。
    const includeRaw = query.includeRaw === "true";
    const items = await repo.listCaptures(resolveTenant(req), {
      revisionId: optionalString(query.revisionId),
      sourceKey: optionalString(query.sourceKey),
      includeDeleted: query.includeDeleted === "true",
      limit: safeLimit(query.limit),
    });
    return { items: includeRaw ? items : items.map(({ payloadText: _payloadText, payload: _payload, ...item }) => item) };
  });

  app.post("/v1/proactive/captures", async (req, reply) => {
    const body = objectBody(req.body);
    const revisionId = requiredString(body.revisionId);
    const sourceGrantId = requiredString(body.sourceGrantId);
    const sourceKey = requiredString(body.sourceKey);
    const contentType = requiredString(body.contentType);
    if (!revisionId || !sourceGrantId || !sourceKey || !contentType) {
      return reply.code(400).send({ error: "revisionId, sourceGrantId, sourceKey and contentType are required" });
    }
    if (body.payload === undefined && body.payloadText === undefined) {
      return reply.code(400).send({ error: "payload or payloadText is required" });
    }
    const canonicalPayload = body.payload !== undefined ? JSON.stringify(body.payload) : String(body.payloadText);
    const capture = await repo.createCapture(resolveTenant(req), {
      id: idFromRequest(req, "pro_capture", body.id),
      revisionId,
      sourceGrantId,
      sourceKey,
      contentType,
      payloadText: typeof body.payloadText === "string" ? body.payloadText : undefined,
      payload: body.payload,
      checksum: optionalString(body.checksum) ?? sha256(canonicalPayload),
      byteSize: typeof body.byteSize === "number" ? body.byteSize : undefined,
      observedAt: optionalString(body.observedAt),
      ingestedAt: optionalString(body.ingestedAt),
    });
    const { payloadText: _payloadText, payload: _payload, ...redacted } = capture;
    return reply.code(201).send(redacted);
  });

  app.post("/v1/proactive/captures/purge", async (req) => {
    const body = objectBody(req.body);
    const now = optionalString(body.now);
    return { deleted: await repo.purgeEligibleCaptures(resolveTenant(req), now, typeof body.limit === "number" ? body.limit : undefined) };
  });

  app.post("/v1/proactive/captures/:captureId/distill", async (req, reply) => {
    const { captureId } = req.params as { captureId: string };
    const body = objectBody(req.body);
    const memoryIds = Array.isArray(body.memoryIds) ? body.memoryIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
    if (memoryIds.length === 0) return reply.code(400).send({ error: "memoryIds must contain at least one id" });
    const capture = await repo.markCaptureDistilled(resolveTenant(req), captureId, memoryIds);
    if (!capture) return reply.code(404).send({ error: "capture not found" });
    const { payloadText: _payloadText, payload: _payload, ...redacted } = capture;
    return redacted;
  });

  app.post("/v1/proactive/captures/:captureId/distillation-failed", async (req, reply) => {
    const { captureId } = req.params as { captureId: string };
    const body = objectBody(req.body);
    const capture = await repo.markCaptureDistillationFailed(resolveTenant(req), captureId, optionalString(body.reason));
    if (!capture) return reply.code(404).send({ error: "capture not found" });
    const { payloadText: _payloadText, payload: _payload, ...redacted } = capture;
    return redacted;
  });

  app.get("/v1/proactive/observations", async (req) => {
    const query = req.query as { revisionId?: unknown; sourceKey?: unknown; limit?: unknown };
    return {
      items: await repo.listObservations(resolveTenant(req), {
        revisionId: optionalString(query.revisionId),
        sourceKey: optionalString(query.sourceKey),
        limit: safeLimit(query.limit),
      }),
    };
  });

  app.post("/v1/proactive/observations", async (req, reply) => {
    const body = objectBody(req.body);
    const revisionId = requiredString(body.revisionId);
    const sourceGrantId = requiredString(body.sourceGrantId);
    const sourceKey = requiredString(body.sourceKey);
    const observationType = requiredString(body.observationType);
    const subjectKey = requiredString(body.subjectKey);
    if (!revisionId || !sourceGrantId || !sourceKey || !observationType || !subjectKey) {
      return reply.code(400).send({ error: "revisionId, sourceGrantId, sourceKey, observationType and subjectKey are required" });
    }
    const payloadCanonical = JSON.stringify(body.payload ?? {});
    const observation = await repo.createObservation(resolveTenant(req), {
      id: idFromRequest(req, "pro_observation", body.id),
      revisionId,
      sourceGrantId,
      sourceKey,
      observationType,
      subjectKey,
      payload: body.payload,
      checksum: optionalString(body.checksum) ?? sha256(payloadCanonical),
      algorithmVersion: optionalString(body.algorithmVersion),
      observedAt: optionalString(body.observedAt),
      normalizedAt: optionalString(body.normalizedAt),
    });
    return reply.code(201).send(observation);
  });

  app.get("/v1/proactive/claims", async (req) => {
    const query = req.query as { revisionId?: unknown; state?: unknown; limit?: unknown };
    return {
      items: await repo.listClaims(resolveTenant(req), {
        revisionId: optionalString(query.revisionId),
        state: validClaimState(query.state) ? query.state : undefined,
        limit: safeLimit(query.limit),
      }),
    };
  });

  app.post("/v1/proactive/claims", async (req, reply) => {
    const body = objectBody(req.body);
    const revisionId = requiredString(body.revisionId);
    const claimType = requiredString(body.claimType);
    const subjectKey = requiredString(body.subjectKey);
    const content = requiredString(body.content);
    if (!revisionId || !claimType || !subjectKey || !content) return reply.code(400).send({ error: "revisionId, claimType, subjectKey and content are required" });
    const claim = await repo.createClaim(resolveTenant(req), {
      id: idFromRequest(req, "pro_claim", body.id),
      revisionId,
      claimType,
      subjectKey,
      content,
      state: validClaimState(body.state) ? body.state : undefined,
      confidence: typeof body.confidence === "number" ? body.confidence : undefined,
      algorithmVersion: optionalString(body.algorithmVersion),
      evidenceCaptureIds: Array.isArray(body.evidenceCaptureIds) ? body.evidenceCaptureIds.filter((id): id is string => typeof id === "string") : undefined,
      evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs : undefined,
      sourceGrantIds: Array.isArray(body.sourceGrantIds) ? body.sourceGrantIds.filter((id): id is string => typeof id === "string") : undefined,
      firstObservedAt: optionalString(body.firstObservedAt) ?? null,
      lastObservedAt: optionalString(body.lastObservedAt) ?? null,
    });
    return reply.code(201).send(claim);
  });

  app.post("/v1/proactive/claims/:claimId/state", async (req, reply) => {
    const { claimId } = req.params as { claimId: string };
    const body = objectBody(req.body);
    if (!validClaimState(body.state)) return reply.code(400).send({ error: "invalid claim state" });
    const claim = await repo.updateClaimState(resolveTenant(req), claimId, body.state, actorFor(req));
    if (!claim) return reply.code(404).send({ error: "profile claim not found" });
    return claim;
  });

  app.get("/v1/proactive/actions", async (req) => {
    const query = req.query as { revisionId?: unknown; state?: unknown; limit?: unknown };
    return {
      items: await repo.listActions(resolveTenant(req), {
        revisionId: optionalString(query.revisionId),
        state: validActionState(query.state) ? query.state : undefined,
        limit: safeLimit(query.limit),
      }),
    };
  });

  app.post("/v1/proactive/actions", async (req, reply) => {
    const body = objectBody(req.body);
    const revisionId = requiredString(body.revisionId);
    const actionType = requiredString(body.actionType);
    const target = requiredString(body.target);
    const authorizationScope = requiredString(body.authorizationScope);
    const actionGrantRevision = requiredString(body.actionGrantRevision);
    if (!revisionId || !actionType || !target || !authorizationScope || !actionGrantRevision) {
      return reply.code(400).send({ error: "revisionId, actionType, target, authorizationScope and actionGrantRevision are required" });
    }
    const action = await repo.createAction(resolveTenant(req), {
      id: idFromRequest(req, "pro_action", body.id),
      revisionId,
      activationLeaseId: optionalString(body.activationLeaseId) ?? null,
      actionType,
      target,
      request: body.request,
      authorizationScope,
      actionGrantRevision,
      requestedBy: actorFor(req),
      reversible: optionalBoolean(body.reversible, true),
      external: optionalBoolean(body.external, false),
    });
    return reply.code(201).send(action);
  });

  app.post("/v1/proactive/actions/:actionId/state", async (req, reply) => {
    const { actionId } = req.params as { actionId: string };
    const body = objectBody(req.body);
    if (!validActionState(body.state)) return reply.code(400).send({ error: "invalid action state" });
    const tenant = resolveTenant(req);
    try {
      const action = await repo.updateAction(tenant, actionId, {
        state: body.state,
        actorId: actorFor(req),
        outcome: body.outcome,
        error: optionalString(body.error) ?? null,
      });
      if (!action) return reply.code(404).send({ error: "proactive action not found" });
      return action;
    } catch (error) {
      if (error instanceof Error && /state transition/i.test(error.message)) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/proactive/audit", async (req) => ({
    items: await repo.listAuditEvents(resolveTenant(req), safeLimit((req.query as { limit?: unknown }).limit)),
  }));

  async function sendExport(req: Parameters<typeof resolveTenant>[0], reply: { header(name: string, value: string): unknown; send(payload: unknown): unknown }, includeRaw: boolean) {
    const tenant = resolveTenant(req);
    await repo.recordAudit(tenant, {
      id: nextId("pro_export_audit"),
      eventType: "export.requested",
      actorId: actorFor(req),
      resourceType: "proactive_export",
      resourceId: `${tenant.workspaceId}:${tenant.subjectUserId}`,
      payload: { includeRaw, format: "json" },
    });
    const snapshot = await repo.exportSnapshot(tenant, { includeRaw });
    const canonical = JSON.stringify(snapshot);
    const manifest = {
      schemaVersion: snapshot.schemaVersion,
      exportedAt: snapshot.exportedAt,
      processingBoundary: "local_only",
      includeRaw,
      checksum: sha256(canonical),
      counts: {
        profileRevisions: snapshot.profileRevisions.length,
        sourceGrants: snapshot.sourceGrants.length,
        activationLeases: snapshot.activationLeases.length,
        captures: snapshot.captures.length,
        observations: snapshot.observations.length,
        claims: snapshot.claims.length,
        actions: snapshot.actions.length,
        auditEvents: snapshot.auditEvents.length,
        consents: snapshot.consents.length,
      },
    };
    await repo.recordAudit(tenant, {
      id: nextId("pro_export_audit"),
      revisionId: snapshot.profileRevisions[0]?.id ?? null,
      eventType: "profile.exported",
      actorId: actorFor(req),
      resourceType: "proactive_export",
      resourceId: manifest.checksum,
      payload: { includeRaw, counts: manifest.counts },
    });
    reply.header("content-type", "application/json; charset=utf-8");
    return reply.send({ manifest, data: snapshot });
  }

  app.get("/v1/proactive/export", async (req, reply) => {
    const query = req.query as { includeRaw?: unknown };
    return sendExport(req, reply, query.includeRaw === "true");
  });

  app.post("/v1/proactive/export", async (req, reply) => {
    const body = objectBody(req.body);
    return sendExport(req, reply, body.includeRaw === true);
  });
}
