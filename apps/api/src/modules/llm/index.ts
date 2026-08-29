import type { ModuleContext } from "../context.js";
import { SqliteLLMConfigRepository } from "@aervox/database";
import { LLMConfigService } from "./service.js";
import { registerLLMRoutes } from "./routes.js";
import type { LLMServiceOptions } from "./types.js";

export function registerLLMModule(
  ctx: ModuleContext,
  options?: LLMServiceOptions,
): LLMConfigService {
  const { app, db } = ctx;
  const repo = new SqliteLLMConfigRepository(db);
  const service = new LLMConfigService(repo, options);
  registerLLMRoutes(app, service);
  return service;
}

export * from "./service.js";
export * from "./types.js";
