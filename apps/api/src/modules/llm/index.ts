import type { FastifyInstance } from "fastify";
import type { AervoxDatabase } from "@aervox/database";
import { SqliteLLMConfigRepository } from "@aervox/database";
import { LLMConfigService } from "./service.js";
import { registerLLMRoutes } from "./routes.js";
import type { LLMServiceOptions } from "./types.js";

export function registerLLMModule(
  app: FastifyInstance,
  db: AervoxDatabase,
  options?: LLMServiceOptions,
): LLMConfigService {
  const repo = new SqliteLLMConfigRepository(db);
  const service = new LLMConfigService(repo, options);
  registerLLMRoutes(app, service);
  return service;
}

export * from "./service.js";
export * from "./types.js";
