import Fastify, { type FastifyInstance } from "fastify";
import {
  activatePersonaRequestSchema,
  cancelTurnResponseSchema,
  createTurnRequestSchema,
  createPersonaRequestSchema,
  exportSkillsRequestSchema,
  importPersonaRequestSchema,
  importSkillsRequestSchema,
  openApiDocument,
  updatePersonaRequestSchema,
  voiceSynthesisRequestSchema,
  type TurnStreamEvent,
} from "@aervox/contracts";
import {
  composeSystemPrompt,
  createPersonaContextSnapshot,
  exportPersonaBundleDetails,
  importPersonaBundle,
  InMemoryMcpRegistry,
  InMemoryPersonaRepository,
  InMemorySkillRegistry,
  previewPersonaBundle,
  createSkillsZip,
  summarizeSkill,
  GptSovitsLocalProvider,
  GptSovitsRemoteProvider,
  type McpTool,
  type SkillRecord,
  type VoiceProviderPort,
} from "@aervox/mod-persona";

export type AervoxAppOptions = {
  logger?: boolean;
  seedSkills?: SkillRecord[];
  seedMcpTools?: McpTool[];
  voiceProviders?: VoiceProviderPort[];
};

const DEFAULT_WORKSPACE = "workspace_demo";
const DEFAULT_SUBJECT = "user_demo";

function headerValue(request: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function scope(request: { headers: Record<string, string | string[] | undefined> }): { workspaceId: string; subjectUserId: string } {
  return {
    workspaceId: headerValue(request, "x-workspace-id") || DEFAULT_WORKSPACE,
    subjectUserId: headerValue(request, "x-subject-user-id") || DEFAULT_SUBJECT,
  };
}

function asBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function sendError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, status: number, code: string, message: string, details?: unknown) {
  return reply.code(status).send({ code, message, ...(details === undefined ? {} : { details }) });
}

export function buildApp(options: AervoxAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const personas = new InMemoryPersonaRepository();
  const skills = new InMemorySkillRegistry(options.seedSkills ?? []);
  const mcp = new InMemoryMcpRegistry(options.seedMcpTools ?? []);
  const voiceProviders = new Map<string, VoiceProviderPort>((options.voiceProviders ?? []).map((provider) => [provider.id, provider]));
  type TurnRecord = {
    turnId: string;
    sessionId: string;
    status: "Created" | "Cancelled";
    contextVersion: string;
    personaId?: string;
    revisionId?: string;
    skillNames: string[];
    mcpToolIds: string[];
    contextSnapshot?: ReturnType<typeof createPersonaContextSnapshot>;
    idempotencyKey: string;
  };
  const turns = new Map<string, TurnRecord>();
  const turnsByIdempotency = new Map<string, string>();
  let turnSequence = 0;
  const nextTurnId = (): string => `turn_${Date.now().toString(36)}_${(++turnSequence).toString(36)}`;
  const now = (): string => new Date().toISOString();

  const resolveTurnContext = (current: { workspaceId: string; subjectUserId: string }) => {
    const activeSelection = personas.active(current.workspaceId, current.subjectUserId);
    const activePersona = activeSelection ? personas.get(current.workspaceId, current.subjectUserId, activeSelection.personaId) : undefined;
    const revision = activePersona && activeSelection ? personas.getRevision(activePersona.id, activeSelection.revisionId) : undefined;
    const composed = composeSystemPrompt({
      coreSystemPrompt: "You are Aervox, an assistant for structured learning.",
      safetyPolicyPrompt: "Safety, privacy, deletion, exit, and server-side authorization rules are non-overridable.",
      personaConfig: revision?.config ?? { systemPromptAppend: "" },
      activeSkills: [],
      workspaceSkills: skills.list(current.workspaceId),
      mcp: { tools: mcp.list() },
    });
    const contextSnapshot = activePersona && revision
      ? createPersonaContextSnapshot({
          persona: activePersona,
          revision,
          skills: composed.skills,
          mcpToolIds: composed.mcp.tools.map((tool) => tool.id),
        })
      : undefined;
    return {
      contextVersion: composed.contextVersion,
      personaId: activePersona?.id,
      revisionId: revision?.id,
      skillNames: composed.skills.map((skill) => skill.name),
      mcpToolIds: composed.mcp.tools.map((tool) => tool.id),
      ...(contextSnapshot ? { contextSnapshot } : {}),
    };
  };

  app.get("/openapi.json", async () => openApiDocument);

  // Turn routes retain the original POST + SSE contract and now snapshot Persona/Skills/MCP context.
  app.post("/v1/sessions/:sessionId/turns", async (request, reply) => {
    const parsed = createTurnRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_TURN", "Invalid create turn request", parsed.error.issues);
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (!idempotencyKey) return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required");
    const existingId = turnsByIdempotency.get(idempotencyKey);
    if (existingId) {
      const existing = turns.get(existingId);
      if (existing) {
        return reply.code(201).send({ turnId: existing.turnId, status: "Created", eventsUrl: `/v1/turns/${existing.turnId}/events`, cancelUrl: `/v1/turns/${existing.turnId}/cancel` });
      }
    }
    const current = scope(request);
    const turnId = nextTurnId();
    const context = resolveTurnContext(current);
    const record: TurnRecord = { turnId, sessionId: (request.params as { sessionId: string }).sessionId, status: "Created", ...context, idempotencyKey };
    turns.set(turnId, record);
    turnsByIdempotency.set(idempotencyKey, turnId);
    void parsed.data;
    return reply.code(201).send({ turnId, status: "Created", eventsUrl: `/v1/turns/${turnId}/events`, cancelUrl: `/v1/turns/${turnId}/cancel` });
  });

  app.get("/v1/turns/:turnId/events", async (request, reply) => {
    const { turnId } = request.params as { turnId: string };
    const record = turns.get(turnId);
    if (!record) return sendError(reply, 404, "TURN_NOT_FOUND", "Turn not found");
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
    const done: TurnStreamEvent = {
      eventId: `tev_${Date.now().toString(36)}`,
      turnId,
      sequence: 1,
      eventType: "done",
      payloadVersion: 1,
      occurredAt: now(),
      data: { status: record.status === "Cancelled" ? "Cancelled" : "Completed", isComplete: true, lastSequence: 1, contextVersion: record.contextVersion },
    };
    reply.raw.write(`id: ${done.eventId}\n`);
    reply.raw.write(`data: ${JSON.stringify(done)}\n\n`);
    reply.raw.end();
  });

  app.get("/v1/turns/:turnId/context", async (request, reply) => {
    const { turnId } = request.params as { turnId: string };
    const record = turns.get(turnId);
    if (!record) return sendError(reply, 404, "TURN_NOT_FOUND", "Turn not found");
    return {
      turnId,
      contextVersion: record.contextVersion,
      personaId: record.personaId ?? null,
      revisionId: record.revisionId ?? null,
      skillNames: record.skillNames,
      mcpToolIds: record.mcpToolIds,
      contextSnapshot: record.contextSnapshot ?? null,
    };
  });

  app.post("/v1/turns/:turnId/cancel", async (request, reply) => {
    const { turnId } = request.params as { turnId: string };
    const record = turns.get(turnId);
    if (!record) return sendError(reply, 404, "TURN_NOT_FOUND", "Turn not found");
    record.status = "Cancelled";
    const response = { turnId, status: "Cancelled" as const };
    cancelTurnResponseSchema.parse(response);
    return response;
  });

  app.get("/v1/personas", async (request) => {
    const current = scope(request);
    return { personas: personas.list(current.workspaceId, current.subjectUserId), active: personas.active(current.workspaceId, current.subjectUserId) ?? null };
  });

  app.post("/v1/personas", async (request, reply) => {
    const parsed = createPersonaRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_PERSONA", "Invalid persona request", parsed.error.issues);
    const current = scope(request);
    try {
      const created = personas.create({ ...current, ...parsed.data });
      return reply.code(201).send(created);
    } catch (error) {
      return sendError(reply, 400, "INVALID_PERSONA", error instanceof Error ? error.message : "Invalid persona");
    }
  });

  app.get("/v1/personas/:personaId", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const current = scope(request);
    const persona = personas.get(current.workspaceId, current.subjectUserId, personaId);
    if (!persona) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona not found");
    const revision = personas.getRevision(persona.id, persona.currentRevisionId);
    return { persona, revision, active: personas.active(current.workspaceId, current.subjectUserId)?.personaId === persona.id };
  });

  app.patch("/v1/personas/:personaId", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const parsed = updatePersonaRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_PERSONA", "Invalid persona update", parsed.error.issues);
    const current = scope(request);
    try {
      const updated = personas.update({ ...current, personaId, ...parsed.data });
      if (!updated) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona not found");
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid persona update";
      return sendError(reply, message === "PERSONA_REVISION_CONFLICT" ? 409 : 400, message, message);
    }
  });

  app.delete("/v1/personas/:personaId", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const current = scope(request);
    if (!personas.delete(current.workspaceId, current.subjectUserId, personaId)) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona not found");
    return { deleted: true, personaId };
  });

  app.post("/v1/personas/:personaId/activate", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const parsed = activatePersonaRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, "INVALID_PERSONA", "Invalid activation request", parsed.error.issues);
    const current = scope(request);
    const selection = personas.activate(current.workspaceId, current.subjectUserId, personaId, parsed.data.revisionId);
    if (!selection) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona or revision not found");
    return selection;
  });

  app.post("/v1/personas/:personaId/export", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const current = scope(request);
    const persona = personas.get(current.workspaceId, current.subjectUserId, personaId);
    if (!persona) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona not found");
    const revision = personas.getRevision(persona.id, persona.currentRevisionId);
    if (!revision) return sendError(reply, 500, "PERSONA_REVISION_MISSING", "Persona revision is missing");
    const exported = exportPersonaBundleDetails({
      persona,
      revision,
      activeSkills: [],
      workspaceSkills: skills.list(current.workspaceId),
      availableMcpToolIds: mcp.list().map((tool) => tool.id),
      availableVoiceProviderIds: [...voiceProviders.keys()],
    });
    return {
      bundleBase64: asBase64(exported.bytes),
      fileName: `${persona.name.replace(/[^a-z0-9-_]+/gi, "-")}.persona.zip`,
      skillNames: exported.skillNames,
      missingDependencies: exported.missingDependencies,
    };
  });

  app.post("/v1/personas/import/preview", async (request, reply) => {
    const parsed = importPersonaRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_BUNDLE", "Invalid persona bundle request", parsed.error.issues);
    const current = scope(request);
    try {
      return previewPersonaBundle(fromBase64(parsed.data.bundleBase64), current.workspaceId);
    } catch (error) {
      return sendError(reply, 400, "INVALID_BUNDLE", error instanceof Error ? error.message : "Invalid persona bundle");
    }
  });

  app.post("/v1/personas/import", async (request, reply) => {
    const parsed = importPersonaRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_BUNDLE", "Invalid persona bundle request", parsed.error.issues);
    const current = scope(request);
    try {
      const imported = importPersonaBundle({
        bytes: fromBase64(parsed.data.bundleBase64),
        ...current,
        repository: personas,
        skillImport: (workspaceId, bytes, conflictResolution) => skills.importZip(workspaceId, bytes, conflictResolution),
        conflictResolution: parsed.data.conflictResolution,
      });
      return reply.code(201).send(imported);
    } catch (error) {
      return sendError(reply, 400, "INVALID_BUNDLE", error instanceof Error ? error.message : "Unable to import persona bundle");
    }
  });

  app.get("/v1/skills", async (request) => {
    const current = scope(request);
    return { skills: skills.list(current.workspaceId).map(summarizeSkill) };
  });

  app.post("/v1/skills/import", async (request, reply) => {
    const parsed = importSkillsRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_SKILL_BUNDLE", "Invalid Skills bundle request", parsed.error.issues);
    const current = scope(request);
    try {
      const imported = skills.importZip(current.workspaceId, fromBase64(parsed.data.zipBase64), parsed.data.conflictResolution);
      return reply.code(201).send({ skills: imported.map(summarizeSkill) });
    } catch (error) {
      return sendError(reply, 400, "INVALID_SKILL_BUNDLE", error instanceof Error ? error.message : "Unable to import Skills");
    }
  });

  app.post("/v1/skills/export", async (request, reply) => {
    const parsed = exportSkillsRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, "INVALID_SKILL_EXPORT", "Invalid Skills export request", parsed.error.issues);
    const current = scope(request);
    const available = skills.list(current.workspaceId);
    const selected = parsed.data.names === undefined ? available : available.filter((skill) => parsed.data.names!.includes(skill.name));
    const bundle = createSkillsZip(selected);
    return { bundleBase64: asBase64(bundle), fileName: "skills.zip", skillNames: selected.map((skill) => skill.name) };
  });

  app.post("/v1/skills/:skillName/enable", async (request, reply) => {
    const { skillName } = request.params as { skillName: string };
    const current = scope(request);
    const skill = skills.setEnabled(current.workspaceId, skillName, true);
    if (!skill) return sendError(reply, 404, "SKILL_NOT_FOUND", "Skill not found");
    return summarizeSkill(skill);
  });

  app.post("/v1/skills/:skillName/disable", async (request, reply) => {
    const { skillName } = request.params as { skillName: string };
    const current = scope(request);
    const skill = skills.setEnabled(current.workspaceId, skillName, false);
    if (!skill) return sendError(reply, 404, "SKILL_NOT_FOUND", "Skill not found");
    return summarizeSkill(skill);
  });

  app.delete("/v1/skills/:skillName", async (request, reply) => {
    const { skillName } = request.params as { skillName: string };
    const current = scope(request);
    if (!skills.delete(current.workspaceId, skillName)) return sendError(reply, 404, "SKILL_NOT_FOUND", "Skill not found");
    return { deleted: true, skillName };
  });

  app.get("/v1/mcp/tools", async () => ({ tools: mcp.list() }));

  app.get("/v1/voice/models", async () => {
    const models = (await Promise.all([...voiceProviders.values()].map((provider) => provider.listModels()))).flat();
    return { models };
  });

  app.post("/v1/voice/synthesize", async (request, reply) => {
    const parsed = voiceSynthesisRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_VOICE_REQUEST", "Invalid voice synthesis request", parsed.error.issues);
    const provider = voiceProviders.get(parsed.data.providerId);
    if (!provider) return sendError(reply, 503, "VOICE_PROVIDER_UNAVAILABLE", "Voice provider is unavailable");
    try {
      const artifact = await provider.synthesize(parsed.data);
      return {
        providerId: artifact.providerId,
        modelId: artifact.modelId,
        contentType: artifact.contentType,
        audioBase64: asBase64(artifact.bytes),
      };
    } catch (error) {
      return sendError(reply, 503, "VOICE_PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "Voice synthesis failed");
    }
  });

  return app;
}

export function createDefaultVoiceProviders(): VoiceProviderPort[] {
  return [
    new GptSovitsLocalProvider("gpt-sovits-local", {
      modelId: "default-local",
      modelPath: process.env.GPT_SOVITS_MODEL_PATH,
      allowedRoots: process.env.GPT_SOVITS_ALLOWED_ROOTS?.split(":").filter(Boolean) ?? [],
    }),
    new GptSovitsRemoteProvider("gpt-sovits-remote", {
      endpoint: process.env.GPT_SOVITS_ENDPOINT,
      protocol: (process.env.GPT_SOVITS_PROTOCOL as "http" | "websocket" | undefined) ?? "http",
      modelId: process.env.GPT_SOVITS_MODEL_ID ?? "default-remote",
      secretRef: process.env.GPT_SOVITS_SECRET_REF,
    }),
  ];
}
