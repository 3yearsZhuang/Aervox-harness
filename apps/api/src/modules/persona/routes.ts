/**
 * Aervox｜思隅 @aervox/api — Persona / Skills / MCP / Voice 路由
 *
 * 全部写路径校验租户上下文；Persona 修订使用 CAS；MCP 持久化走 SQLite（经模块 Port）。
 * Skills 生命周期（/v1/skills*）已由系统级 skills 模块接管（本分支统一实现），
 * 本文件仅保留 Persona 域路由；persona bundle 导入仍会向 `skills` 仓储写入工作区技能。
 * 导入编排（Bundle 预览 → Skills 入库 → 创建人格）由 @aervox/mod-persona 的
 * `importPersonaBundle` 承担，本文件只做请求解析与错误映射。
 */
import type { FastifyInstance } from "fastify";
import {
  activatePersonaRequestSchema,
  createPersonaRequestSchema,
  importPersonaRequestSchema,
  updatePersonaRequestSchema,
  voiceSynthesisRequestSchema,
} from "@aervox/contracts";
import {
  exportPersonaBundleDetails,
  importPersonaBundle,
  parseSkillZip,
  previewPersonaBundle,
  summarizeSkill,
  type McpToolRepository,
  type PersonaRepository,
  type SkillRecord,
  type SkillRepository,
  type VoiceProviderPort,
} from "@aervox/mod-persona";
import { resolveTenant } from "../../shared/tenant.js";

type PersonaServices = {
  personas: PersonaRepository;
  skills: SkillRepository;
  mcp: McpToolRepository;
  voiceProviders: Map<string, VoiceProviderPort>;
};

function asBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function sendError(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return reply.code(status).send({ code, message, ...(details === undefined ? {} : { details }) });
}

async function importSkillZip(
  services: PersonaServices,
  workspaceId: string,
  subjectUserId: string,
  bytes: Uint8Array,
  conflictResolution: "error" | "replace",
): Promise<SkillRecord[]> {
  const parsed = parseSkillZip(bytes, { workspaceId, source: "imported" });
  const imported: SkillRecord[] = [];
  for (const skill of parsed) {
    const existing = await services.skills.get(workspaceId, subjectUserId, skill.name);
    if (existing && existing.checksum !== skill.checksum && conflictResolution === "error") {
      const error = new Error(`Skill ${skill.name} already exists with a different checksum`);
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }
    if (existing?.checksum !== skill.checksum) {
      await services.skills.upsert(workspaceId, subjectUserId, skill);
      imported.push(skill);
    }
  }
  return imported;
}

export function registerPersonaRoutes(app: FastifyInstance, services: PersonaServices): void {
  const { personas, skills, mcp, voiceProviders } = services;

  // ── Persona ────────────────────────────────────────────────
  app.get("/v1/personas", async (request) => {
    const tenant = resolveTenant(request);
    const list = await personas.list(tenant.workspaceId, tenant.subjectUserId);
    const active = await personas.active(tenant.workspaceId, tenant.subjectUserId);
    return { personas: list, active: active ?? null };
  });

  app.post("/v1/personas", async (request, reply) => {
    const parsed = createPersonaRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_PERSONA", "Invalid persona request", parsed.error.issues);
    const tenant = resolveTenant(request);
    try {
      const created = await personas.create({
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        name: parsed.data.name,
        description: parsed.data.description,
        config: parsed.data.config,
      });
      return reply.code(201).send(created);
    } catch (error) {
      return sendError(reply, 400, "INVALID_PERSONA", error instanceof Error ? error.message : "Invalid persona");
    }
  });

  app.get("/v1/personas/:personaId", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const tenant = resolveTenant(request);
    const persona = await personas.get(tenant.workspaceId, tenant.subjectUserId, personaId);
    if (!persona) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona not found");
    const revision = await personas.getRevision(persona.id, persona.currentRevisionId);
    const active = (await personas.active(tenant.workspaceId, tenant.subjectUserId))?.personaId === persona.id;
    return { persona, revision: revision ?? null, active };
  });

  app.patch("/v1/personas/:personaId", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const parsed = updatePersonaRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_PERSONA", "Invalid persona update", parsed.error.issues);
    const tenant = resolveTenant(request);
    try {
      const updated = await personas.update({
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        personaId,
        expectedRevision: parsed.data.expectedRevision,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        config: parsed.data.config,
      });
      if (!updated) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona not found");
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid persona update";
      return sendError(reply, message === "PERSONA_REVISION_CONFLICT" ? 409 : 400, message, message);
    }
  });

  app.delete("/v1/personas/:personaId", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const tenant = resolveTenant(request);
    if (!(await personas.delete(tenant.workspaceId, tenant.subjectUserId, personaId))) {
      return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona not found");
    }
    return { deleted: true, personaId };
  });

  app.post("/v1/personas/:personaId/activate", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const parsed = activatePersonaRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, "INVALID_PERSONA", "Invalid activation request", parsed.error.issues);
    const tenant = resolveTenant(request);
    const selection = await personas.activate(tenant.workspaceId, tenant.subjectUserId, personaId, parsed.data.revisionId);
    if (!selection) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona or revision not found");
    return selection;
  });

  app.post("/v1/personas/:personaId/export", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const tenant = resolveTenant(request);
    const persona = await personas.get(tenant.workspaceId, tenant.subjectUserId, personaId);
    if (!persona) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona not found");
    const revision = await personas.getRevision(persona.id, persona.currentRevisionId);
    if (!revision) return sendError(reply, 500, "PERSONA_REVISION_MISSING", "Persona revision is missing");
    const workspaceSkills = await skills.list(tenant.workspaceId, tenant.subjectUserId);
    const mcpTools = await mcp.list(tenant.workspaceId, tenant.subjectUserId);
    const exported = exportPersonaBundleDetails({
      persona,
      revision,
      activeSkills: [],
      workspaceSkills,
      availableMcpToolIds: mcpTools.map((tool) => tool.id),
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
    const tenant = resolveTenant(request);
    try {
      return previewPersonaBundle(fromBase64(parsed.data.bundleBase64), tenant.workspaceId);
    } catch (error) {
      return sendError(reply, 400, "INVALID_BUNDLE", error instanceof Error ? error.message : "Invalid persona bundle");
    }
  });

  app.post("/v1/personas/import", async (request, reply) => {
    const parsed = importPersonaRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_BUNDLE", "Invalid persona bundle request", parsed.error.issues);
    const tenant = resolveTenant(request);
    try {
      const imported = await importPersonaBundle({
        bytes: fromBase64(parsed.data.bundleBase64),
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        repository: personas,
        skillImport: (workspaceId, subjectUserId, bytes, conflictResolution) =>
          importSkillZip(services, workspaceId, subjectUserId, bytes, conflictResolution ?? "error"),
        conflictResolution: parsed.data.conflictResolution,
      });
      return reply.code(201).send({
        persona: imported.persona,
        revision: imported.revision,
        skills: imported.skills.map(summarizeSkill),
        missingDependencies: imported.missingDependencies,
      });
    } catch (error) {
      const status = (error as Error & { statusCode?: number }).statusCode ?? 400;
      return sendError(reply, status, status === 409 ? "SKILL_CONFLICT" : "INVALID_BUNDLE", error instanceof Error ? error.message : "Unable to import persona bundle");
    }
  });

  // ── MCP 工具注册表（只读列表；授权/健康由服务端策略维护）──
  app.get("/v1/mcp/tools", async (request) => {
    const tenant = resolveTenant(request);
    return { tools: await mcp.list(tenant.workspaceId, tenant.subjectUserId) };
  });

  // ── GPT-SoVITS Voice ───────────────────────────────────────
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
}
