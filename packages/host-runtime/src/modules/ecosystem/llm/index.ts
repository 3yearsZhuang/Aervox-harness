import type { ModuleDependencies } from "../../context.js";
import type { ModelRoutingPort } from "@aervox/contracts";
import { SqliteLLMConfigRepository, SqliteModelRoutingRepository } from "@aervox/repositories";
import { createModelGenerationPort, type ModelGenerationPort } from "./generation.js";
import { LLMConfigService } from "./service.js";
import { registerLLMRoutes } from "./routes.js";
import { LlmHealthProber } from "./health-prober.js";
import { LlmDegradationService } from "./degradation-service.js";
import type { LLMServiceOptions } from "./types.js";
import { createConfiguredProviderFactory, type ConfiguredProviderFactoryPort } from "./provider-factory.js";

export function registerLLMModule(
  ctx: ModuleDependencies<"app" | "db" | "modelStreamResources">,
  options?: LLMServiceOptions,
): { config: LLMConfigPort; routing: ModelRoutingPort; generation: ModelGenerationPort; factory: ConfiguredProviderFactoryPort } {
  const { app, db } = ctx;
  if (!ctx.modelStreamResources) throw new Error("model_stream_resources_required");
  const factory = createConfiguredProviderFactory(ctx.modelStreamResources);
  const repo = new SqliteLLMConfigRepository(db);
  const service = new LLMConfigService(repo, options);
  const routingRepo = new SqliteModelRoutingRepository(db);
  const degradationService = new LlmDegradationService(repo, routingRepo, {
    prober: new LlmHealthProber(),
  });
  registerLLMRoutes(app, service);
  return { config: service, routing: degradationService, generation: createModelGenerationPort(service, factory), factory };
}

export * from "./service.js";
export * from "./health-prober.js";
export * from "./degradation-service.js";
export * from "./types.js";

export type LLMConfigPort = Pick<import("./service.js").LLMConfigService, "getConfig" | "listPresets">;

export type { ModelRoutingPort } from "@aervox/contracts";

export { createModelGenerationPort, generateModelText, type ModelGenerationPort, type ModelGenerationInput } from "./generation.js";
export { createConfiguredModelProvider } from "./provider-config.js";
export { createConfiguredProviderFactory, type ConfiguredProviderFactoryPort } from "./provider-factory.js";
export { createModelStreamResources, ModelStreamAdmissionError, ModelStreamDrainError, type ModelStreamResourcePort } from "./model-resources.js";
