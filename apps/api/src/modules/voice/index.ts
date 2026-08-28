/**
 * Aervox｜思隅 @aervox/api — 系统级语音模块入口
 */
import type { FastifyInstance } from "fastify";
import { SqliteVoiceConfigRepository, type AervoxDatabase } from "@aervox/database";
import type { VoiceProviderPort } from "./types.js";
import { GptSovitsLocalProvider, GptSovitsRemoteProvider } from "./gpt-sovits.js";
import { VoiceService } from "./service.js";
import { registerVoiceRoutes } from "./routes.js";

export * from "./types.js";
export * from "./gpt-sovits.js";
export * from "./service.js";

export interface VoiceModuleOptions {
  providers?: VoiceProviderPort[];
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

export function registerVoiceModule(
  app: FastifyInstance,
  db: AervoxDatabase,
  options: VoiceModuleOptions = {},
): VoiceService {
  const configRepository = new SqliteVoiceConfigRepository(db);
  const service = new VoiceService(
    options.providers ?? createDefaultVoiceProviders(),
    configRepository,
  );
  registerVoiceRoutes(app, service);
  return service;
}
