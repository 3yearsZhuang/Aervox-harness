/**
 * Aervox｜思隅 @aervox/api — 系统级语音模块入口
 */
import path from "node:path";
import type { ModuleContext } from "../context.js";
import { loadApiConfig } from "@aervox/config";
import {
  SqliteVoiceConfigRepository,
  SqliteVoiceInputConfigRepository,
  SqliteVoiceRemoteConfigRepository,
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
  // 缺陷 E：GPT-Sovits 配置经 @aervox/config 集中解析（GPT_SOVITS_*）
  const { gptSovits } = loadApiConfig();
  return [
    new GptSovitsLocalProvider("gpt-sovits-local", {
      modelId: "default-local",
      modelPath: gptSovits.modelPath,
      allowedRoots: gptSovits.allowedRoots,
    }),
    new GptSovitsRemoteProvider("gpt-sovits-remote", {
      endpoint: gptSovits.endpoint,
      protocol: gptSovits.protocol,
      modelId: gptSovits.modelId,
      secretRef: gptSovits.secretRef,
    }),
  ];
}

export function createDefaultASRProviders(): ASRProviderPort[] {
  // 缺陷 E：ASR 配置经 @aervox/config 集中解析（SENSEVOICE_* / WHISPER_*）
  const { asr } = loadApiConfig();
  const defaultAllowedRoots = [
    process.cwd(),
    path.join(process.cwd(), "data"),
    path.join(process.cwd(), "data", "models"),
    ...asr.senseVoiceAllowedRoots,
  ];
  return [
    new SenseVoiceLocalProvider("sensevoice-local", {
      modelId: "sensevoice-small",
      modelPath: asr.senseVoiceModelPath,
      allowedRoots: defaultAllowedRoots,
    }),
    new WhisperCompatibleProvider("whisper-compatible", {
      endpoint: asr.whisperEndpoint,
      apiKey: asr.whisperApiKey,
      modelId: asr.whisperModelId,
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
  const remoteConfigRepository = new SqliteVoiceRemoteConfigRepository(db);
  const service = new VoiceService(
    options.providers ?? createDefaultVoiceProviders(),
    configRepository,
    options.asrProviders ?? createDefaultASRProviders(),
    inputConfigRepository,
    remoteConfigRepository,
  );
  registerVoiceRoutes(app, service);
  return service;
}
