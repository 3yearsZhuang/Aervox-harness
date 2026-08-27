/**
 * Aervox｜思隅 @aervox/api — 系统级 Persona HTTP 路由
 */
import type { FastifyInstance } from "fastify";
import {
  activatePersonaRequestSchema,
  createPersonaRequestSchema,
  importPersonaRequestSchema,
  updatePersonaRequestSchema,
} from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";
import type { PersonaService } from "./service.js";

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

export function registerPersonaRoutes(app: FastifyInstance, service: PersonaService): void {
  // GET /v1/personas
  app.get("/v1/personas", async (request) => {
    const tenant = resolveTenant(request);
    const list = await service.listPersonas(tenant);
    const active = await service.getActivePersona(tenant);
    return { personas: list, active: active ?? null };
  });

  // POST /v1/personas
  app.post("/v1/personas", async (request, reply) => {
    const parsed = createPersonaRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_PERSONA", "Invalid persona request", parsed.error.issues);
    }
    const tenant = resolveTenant(request);
    try {
      const created = await service.createPersona(tenant, {
        name: parsed.data.name,
        description: parsed.data.description,
        config: parsed.data.config,
      });
      return reply.code(201).send(created);
    } catch (error) {
      return sendError(
        reply,
        400,
        "INVALID_PERSONA",
        error instanceof Error ? error.message : "Invalid persona",
      );
    }
  });

  // GET /v1/personas/:personaId
  app.get("/v1/personas/:personaId", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const tenant = resolveTenant(request);
    const result = await service.getPersona(tenant, personaId);
    if (!result) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona not found");
    return result;
  });

  // PATCH /v1/personas/:personaId
  app.patch("/v1/personas/:personaId", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const parsed = updatePersonaRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_PERSONA", "Invalid persona update", parsed.error.issues);
    }
    const tenant = resolveTenant(request);
    try {
      const updated = await service.updatePersona(tenant, {
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
      return sendError(
        reply,
        message === "PERSONA_REVISION_CONFLICT" ? 409 : 400,
        message,
        message,
      );
    }
  });

  // DELETE /v1/personas/:personaId
  app.delete("/v1/personas/:personaId", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const tenant = resolveTenant(request);
    const ok = await service.deletePersona(tenant, personaId);
    if (!ok) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona not found");
    return { deleted: true, personaId };
  });

  // POST /v1/personas/:personaId/activate
  app.post("/v1/personas/:personaId/activate", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const parsed = activatePersonaRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_PERSONA", "Invalid activation request", parsed.error.issues);
    }
    const tenant = resolveTenant(request);
    const selection = await service.activatePersona(tenant, personaId, parsed.data.revisionId);
    if (!selection) return sendError(reply, 404, "PERSONA_NOT_FOUND", "Persona or revision not found");
    return selection;
  });

  // POST /v1/personas/:personaId/export
  app.post("/v1/personas/:personaId/export", async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const tenant = resolveTenant(request);
    try {
      const exported = await service.exportBundle(tenant, personaId);
      const persona = await service.getPersona(tenant, personaId);
      const name = persona?.persona.name ?? "persona";
      return {
        bundleBase64: asBase64(exported.bytes),
        fileName: `${name.replace(/[^a-z0-9-_]+/gi, "-")}.persona.zip`,
        skillNames: exported.skillNames,
        missingDependencies: exported.missingDependencies,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Export failed";
      return sendError(
        reply,
        message === "Persona not found" ? 404 : 500,
        "EXPORT_FAILED",
        message,
      );
    }
  });

  // POST /v1/personas/import/preview
  app.post("/v1/personas/import/preview", async (request, reply) => {
    const parsed = importPersonaRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_BUNDLE", "Invalid persona bundle request", parsed.error.issues);
    }
    const tenant = resolveTenant(request);
    try {
      return service.previewBundle(fromBase64(parsed.data.bundleBase64), tenant.workspaceId);
    } catch (error) {
      return sendError(
        reply,
        400,
        "INVALID_BUNDLE",
        error instanceof Error ? error.message : "Invalid persona bundle",
      );
    }
  });

  // POST /v1/personas/import
  app.post("/v1/personas/import", async (request, reply) => {
    const parsed = importPersonaRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_BUNDLE", "Invalid persona bundle request", parsed.error.issues);
    }
    const tenant = resolveTenant(request);
    try {
      const imported = await service.importBundle(
        tenant,
        fromBase64(parsed.data.bundleBase64),
        parsed.data.conflictResolution,
      );
      return reply.code(201).send({
        persona: imported.persona,
        revision: imported.revision,
        skills: imported.skills.map((s) => ({
          name: s.name,
          description: s.description,
          checksum: s.checksum,
        })),
        missingDependencies: imported.missingDependencies,
      });
    } catch (error) {
      const isConflict =
        error instanceof FileExistsError ||
        (error as Error & { statusCode?: number }).statusCode === 409 ||
        (error instanceof Error && error.message.includes("already exists"));
      const status = isConflict ? 409 : ((error as Error & { statusCode?: number }).statusCode ?? 400);
      return sendError(
        reply,
        status,
        status === 409 ? "SKILL_CONFLICT" : "INVALID_BUNDLE",
        error instanceof Error ? error.message : "Unable to import persona bundle",
      );
    }
  });
}
import { FileExistsError } from "../skills/skill-manager.js";
