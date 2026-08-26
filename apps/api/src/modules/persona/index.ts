/**
 * Aervox｜思隅 @aervox/api — 系统级 Persona 领域模块（CAP-019/CAP-020）
 */
import type { FastifyInstance } from "fastify";
import type { AervoxDatabase } from "@aervox/database";
import { SqlitePersonaRepository } from "@aervox/database";
import type { SkillManager } from "../skills/skill-manager.js";
import type { ToolRuntime } from "../tools/runtime.js";
import type { VoiceService } from "../voice/service.js";
import { PersonaService } from "./service.js";
import { registerPersonaRoutes } from "./routes.js";

export * from "./types.js";
export * from "./bundle.js";
export * from "./service.js";

export interface RegisterPersonaModuleOptions {
  skillManager?: SkillManager;
  toolRuntime?: ToolRuntime;
  voiceService?: VoiceService;
}

export function registerPersonaModule(
  app: FastifyInstance,
  db: AervoxDatabase,
  options: RegisterPersonaModuleOptions = {},
): PersonaService {
  const personaRepo = new SqlitePersonaRepository(db);
  const service = new PersonaService({
    personaRepo,
    skillManager: options.skillManager,
    toolRuntime: options.toolRuntime,
    voiceService: options.voiceService,
  });
  registerPersonaRoutes(app, service);
  return service;
}
