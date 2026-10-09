import type { ModuleDependencies } from "../../context.js";
import type { ModelRoutingPort } from "@aervox/contracts";
import { SqliteLLMConfigRepository, SqliteModelRoutingRepository } from "@aervox/repositories";
import { LLMConfigService } from "./service.js";
import { registerLLMRoutes } from "./routes.js";
import { LlmHealthProber } from "./health-prober.js";
import { LlmDegradationService } from "./degradation-service.js";
import type { LLMServiceOptions } from "./types.js";

export function registerLLMModule(
  ctx: ModuleDependencies<"app" | "db">,
  options?: LLMServiceOptions,
): { config: LLMConfigPort; routing: ModelRoutingPort } {
  const { app, db } = ctx;
  const repo = new SqliteLLMConfigRepository(db);
  const service = new LLMConfigService(repo, options);
  const routingRepo = new SqliteModelRoutingRepository(db);
  const degradationService = new LlmDegradationService(repo, routingRepo, {
    prober: new LlmHealthProber(),
  });
  registerLLMRoutes(app, service);
  return { config: service, routing: degradationService };
}

export * from "./service.js";
export * from "./health-prober.js";
export * from "./degradation-service.js";
export * from "./types.js";

export type LLMConfigPort = Pick<import("./service.js").LLMConfigService, "getConfig" | "listPresets">;

export type { ModelRoutingPort } from "@aervox/contracts";
