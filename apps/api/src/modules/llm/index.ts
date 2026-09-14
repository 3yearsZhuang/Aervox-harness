import type { ModuleContext } from "../context.js";
import { SqliteLLMConfigRepository, SqliteModelRoutingRepository } from "@aervox/repositories";
import { LLMConfigService } from "./service.js";
import { registerLLMRoutes } from "./routes.js";
import { LlmHealthProber } from "./health-prober.js";
import { LlmDegradationService } from "./degradation-service.js";
import type { LLMServiceOptions } from "./types.js";

export function registerLLMModule(
  ctx: ModuleContext,
  options?: LLMServiceOptions,
): LLMConfigService {
  const { app, db } = ctx;
  const repo = new SqliteLLMConfigRepository(db);
  const service = new LLMConfigService(repo, options);
  const routingRepo = new SqliteModelRoutingRepository(db);
  const degradationService = new LlmDegradationService(repo, routingRepo, {
    prober: new LlmHealthProber(),
  });
  ctx.llmConfigService = service;
  ctx.modelRoutingService = degradationService;
  registerLLMRoutes(app, service);
  return service;
}

export * from "./service.js";
export * from "./health-prober.js";
export * from "./degradation-service.js";
export * from "./types.js";
