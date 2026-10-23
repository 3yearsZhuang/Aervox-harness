/**
 * Aervox｜思隅 @aervox/api — 系统级语音模块入口
 */
import path from "node:path";
import type { ModuleDependencies } from "../../context.js";
import { loadVoiceConfig, type VoiceConfig } from "@aervox/config";
import {
  SqliteVoiceConfigRepository,
  SqliteVoiceInputConfigRepository,
  SqliteVoiceRemoteConfigRepository,
} from "@aervox/repositories";
import type { VoiceProviderPort, ASRProviderPort } from "./types.js";
import { GptSovitsLocalProvider, GptSovitsRemoteProvider } from "./gpt-sovits.js";
import { SenseVoiceLocalProvider, WhisperCompatibleProvider } from "./asr-providers.js";
import { VoiceService } from "./service.js";
import { registerVoiceRoutes } from "./routes.js";
import { NativeAudioPreprocessor, nativeArtifactFromEnvironment } from "@aervox/native-runtime";

export * from "./types.js";
export * from "./gpt-sovits.js";
export * from "./asr-providers.js";
export * from "./service.js";

export interface VoiceModuleOptions {
  config?: VoiceConfig;
  providers?: VoiceProviderPort[];
  asrProviders?: ASRProviderPort[];
}

export function createDefaultVoiceProviders(config: VoiceConfig = loadVoiceConfig()): VoiceProviderPort[] {
  // 缺陷 E：GPT-Sovits 配置经 @aervox/config 集中解析（GPT_SOVITS_*）
  const { gptSovits } = config;
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

export function createDefaultASRProviders(config: VoiceConfig = loadVoiceConfig()): ASRProviderPort[] {
  const artifact = config.audioPreprocessor === "rust" ? nativeArtifactFromEnvironment() : undefined;
  // 缺陷 E：ASR 配置经 @aervox/config 集中解析（SENSEVOICE_* / WHISPER_*）
  const { asr } = config;
  const defaultAllowedRoots = [
    process.cwd(),
    path.join(process.cwd(), "data"),
    path.join(process.cwd(), "data", "models"),
    ...asr.senseVoiceAllowedRoots,
  ];
  return [
    new SenseVoiceLocalProvider("sensevoice-local", {
      audioPreprocessor: artifact ? new NativeAudioPreprocessor(artifact) : undefined,
      modelId: "sensevoice-small",
      modelBaseUrl: asr.senseVoiceBaseUrl,
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
  ctx: ModuleDependencies<"app" | "db">,
  options: VoiceModuleOptions = {},
): VoiceService {
  const { app, db } = ctx;
  const configRepository = new SqliteVoiceConfigRepository(db);
  const inputConfigRepository = new SqliteVoiceInputConfigRepository(db);
  const remoteConfigRepository = new SqliteVoiceRemoteConfigRepository(db);
  const config = options.config ?? loadVoiceConfig();
  const asrProviders = options.asrProviders ?? createDefaultASRProviders(config);
  app.addHook("onClose", async () => {
    await Promise.all(asrProviders.filter((p): p is SenseVoiceLocalProvider => p instanceof SenseVoiceLocalProvider).map(p => p.close()));
  });
  const service = new VoiceService(
    options.providers ?? createDefaultVoiceProviders(config),
    configRepository,
    asrProviders,
    inputConfigRepository,
    remoteConfigRepository,
  );
  registerVoiceRoutes(app, service);
  return service;
}

export type VoiceCatalogPort = Pick<import("./service.js").VoiceService, "listProviderIds">;
