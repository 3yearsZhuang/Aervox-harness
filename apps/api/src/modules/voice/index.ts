/**
 * Aervox｜思隅 @aervox/api — 系统级语音模块入口
 */
import path from "node:path";
import type { ModuleContext } from "../context.js";
import {
  SqliteVoiceConfigRepository,
  SqliteVoiceInputConfigRepository,
} from "@aervox/database";
import type { VoiceProviderPort, ASRProviderPort } from "./types.js";
import { GptSovitsLocalProvider, GptSovitsRemoteProvider } from "./gpt-sovits.js";
import { SenseVoiceLocalProvider, WhisperCompatibleProvider } from "./asr-providers.js";
import { VoiceService } from "./service.js";
import { registerVoiceRoutes } from "./routes.js";

export * from "./types.js";
export * from "./gpt-sovits.js";
export * from "./asr-providers.js";
export * from "./service.js";

export interface VoiceModuleOptions {
  providers?: VoiceProviderPort[];
  asrProviders?: ASRProviderPort[];
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

export function createDefaultASRProviders(): ASRProviderPort[] {
  const defaultAllowedRoots = [
    process.cwd(),
    path.join(process.cwd(), "data"),
    path.join(process.cwd(), "data", "models"),
    ...(process.env.SENSEVOICE_ALLOWED_ROOTS?.split(":").filter(Boolean) ?? []),
  ];
  return [
    new SenseVoiceLocalProvider("sensevoice-local", {
      modelId: "sensevoice-small",
      modelPath: process.env.SENSEVOICE_MODEL_PATH,
      allowedRoots: defaultAllowedRoots,
    }),
    new WhisperCompatibleProvider("whisper-compatible", {
      endpoint: process.env.WHISPER_ENDPOINT,
      apiKey: process.env.WHISPER_API_KEY,
      modelId: process.env.WHISPER_MODEL_ID ?? "whisper-1",
    }),
  ];
}

export function registerVoiceModule(
  ctx: ModuleContext,
  options: VoiceModuleOptions = {},
): VoiceService {
  const { app, db } = ctx;
  const configRepository = new SqliteVoiceConfigRepository(db);
  const inputConfigRepository = new SqliteVoiceInputConfigRepository(db);
  const service = new VoiceService(
    options.providers ?? createDefaultVoiceProviders(),
    configRepository,
    options.asrProviders ?? createDefaultASRProviders(),
    inputConfigRepository,
  );
  registerVoiceRoutes(app, service);
  return service;
}
