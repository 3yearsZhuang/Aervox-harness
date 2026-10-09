/**
 * Aervox｜思隅 @aervox/api — 系统级 Persona 领域模块（CAP-019/CAP-020）
 */
import type { ModuleDependencies } from "../../context.js";
import { SqlitePersonaRepository } from "@aervox/repositories";
import { PersonaService } from "./service.js";
import { registerPersonaRoutes } from "./routes.js";

export * from "./types.js";
export * from "./bundle.js";
export * from "./service.js";

export function registerPersonaModule(ctx: ModuleDependencies<"app" | "db" | "skillManager" | "toolRuntime" | "voiceService">): PersonaService {
  const { app, db, skillManager, toolRuntime, voiceService } = ctx;
  const personaRepo = new SqlitePersonaRepository(db);
  const service = new PersonaService({
    personaRepo,
    skillManager,
    toolRuntime,
    voiceService,
  });
  registerPersonaRoutes(app, service);
  return service;
}

export type PersonaSummaryPort = Pick<import("./service.js").PersonaService, "describeActivePersonaSummary">;
