/**
 * Aervox｜思隅 @aervox/api — 系统级语音服务
 */
import type { TenantContext } from "@aervox/database";
import type {
  IVoiceConfigRepository,
  IVoiceInputConfigRepository,
} from "@aervox/database";
import { GptSovitsLocalProvider, validateLocalPath } from "./gpt-sovits.js";
import {
  SenseVoiceLocalProvider,
  WhisperCompatibleProvider,
} from "./asr-providers.js";
import type {
  AudioArtifact,
  VoiceModel,
  VoiceProviderPort,
  VoiceSynthesisRequest,
  ASRProviderPort,
  ASRTranscribeRequest,
  ASRTranscribeResult,
} from "./types.js";

/** 本地语音模型配置（CR-011 阶段 1 · WebUI 设置读写） */
export interface LocalVoiceConfig {
  enabled: boolean;
  providerId: string;
  modelPath?: string;
  modelId: string;
  speakerId?: string;
  settings?: Record<string, string | number | boolean>;
}

/** 离线语音输入 (ASR) 配置（CR-016） */
export interface VoiceInputConfig {
  enabled: boolean;
  engineType: "sensevoice-local" | "whisper-compatible";
  modelPath?: string;
  modelId: string;
  endpoint?: string;
  apiKey?: string;
  autoStopOnKeyboard: boolean;
  vadSilenceThresholdMs: number;
  settings?: Record<string, string | number | boolean>;
}

function normalizeLocalConfig(model: {
  enabled: number;
  providerId: string;
  modelPath: string | null;
  modelId: string;
  speakerId: string | null;
  settingsJson: unknown;
}): LocalVoiceConfig {
  return {
    enabled: model.enabled === 1,
    providerId: model.providerId,
    ...(model.modelPath ? { modelPath: model.modelPath } : {}),
    modelId: model.modelId,
    ...(model.speakerId ? { speakerId: model.speakerId } : {}),
    settings: (model.settingsJson as Record<string, string | number | boolean> | undefined) ?? {},
  };
}

function normalizeVoiceInputConfig(model: {
  enabled: number;
  engineType: string;
  modelPath: string | null;
  modelId: string;
  endpoint: string | null;
  apiKey: string | null;
  autoStopOnKeyboard: number;
  vadSilenceThresholdMs: number;
  settingsJson: unknown;
}): VoiceInputConfig {
  return {
    enabled: model.enabled === 1,
    engineType: model.engineType as "sensevoice-local" | "whisper-compatible",
    ...(model.modelPath ? { modelPath: model.modelPath } : {}),
    modelId: model.modelId,
    ...(model.endpoint ? { endpoint: model.endpoint } : {}),
    ...(model.apiKey ? { apiKey: model.apiKey } : {}),
    autoStopOnKeyboard: model.autoStopOnKeyboard === 1,
    vadSilenceThresholdMs: model.vadSilenceThresholdMs,
    settings: (model.settingsJson as Record<string, string | number | boolean> | undefined) ?? {},
  };
}

export class VoiceService {
  private readonly providers = new Map<string, VoiceProviderPort>();
  private readonly asrProviders = new Map<string, ASRProviderPort>();
  private readonly localProviderId = "gpt-sovits-local";
  private readonly defaultAsrProviderId = "sensevoice-local";

  constructor(
    initialProviders: VoiceProviderPort[] = [],
    private readonly configRepository?: IVoiceConfigRepository,
    initialAsrProviders: ASRProviderPort[] = [],
    private readonly inputConfigRepository?: IVoiceInputConfigRepository,
  ) {
    for (const provider of initialProviders) {
      this.providers.set(provider.id, provider);
    }
    for (const provider of initialAsrProviders) {
      this.asrProviders.set(provider.id, provider);
    }
  }

  registerProvider(provider: VoiceProviderPort): void {
    this.providers.set(provider.id, provider);
  }

  registerASRProvider(provider: ASRProviderPort): void {
    this.asrProviders.set(provider.id, provider);
  }

  getProvider(id: string): VoiceProviderPort | undefined {
    return this.providers.get(id);
  }

  getASRProvider(id: string): ASRProviderPort | undefined {
    return this.asrProviders.get(id);
  }

  hasProvider(id: string): boolean {
    return this.providers.has(id);
  }

  hasASRProvider(id: string): boolean {
    return this.asrProviders.has(id);
  }

  listProviderIds(): string[] {
    return [...this.providers.keys()];
  }

  private getLocalProvider(): GptSovitsLocalProvider | undefined {
    return this.providers.get(this.localProviderId) as GptSovitsLocalProvider | undefined;
  }

  private getSenseVoiceProvider(): SenseVoiceLocalProvider | undefined {
    return this.asrProviders.get(this.defaultAsrProviderId) as SenseVoiceLocalProvider | undefined;
  }

  async listModels(): Promise<VoiceModel[]> {
    const lists = await Promise.all(
      [...this.providers.values()].map((provider) => provider.listModels()),
    );
    return lists.flat();
  }

  async synthesize(
    providerId: string,
    request: VoiceSynthesisRequest,
  ): Promise<AudioArtifact> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Voice provider "${providerId}" is not available`);
    }
    return provider.synthesize(request);
  }

  /** 转写音频为文本（ASR） */
  async transcribe(
    tenant: TenantContext,
    request: ASRTranscribeRequest,
  ): Promise<ASRTranscribeResult> {
    const config = await this.getVoiceInputConfig(tenant);
    if (!config.enabled) {
      return { text: "", durationMs: 0, isFinal: true };
    }

    const providerId = config.engineType;
    let provider = this.asrProviders.get(providerId);
    if (!provider) {
      provider = this.getSenseVoiceProvider();
    }
    if (!provider) {
      throw new Error(`ASR provider "${providerId}" is unavailable`);
    }

    if (config.modelPath && provider instanceof SenseVoiceLocalProvider) {
      provider.reconfigure({ modelPath: config.modelPath, modelId: config.modelId });
    } else if (provider instanceof WhisperCompatibleProvider) {
      provider.reconfigure({
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        modelId: config.modelId,
      });
    }

    return provider.transcribe(request);
  }

  /** 读取当前租户的本地语音配置；未持久化时按本地 provider 当前生效值给出默认 */
  async getLocalConfig(tenant: TenantContext): Promise<LocalVoiceConfig> {
    const stored = this.configRepository
      ? await this.configRepository.getConfig(tenant)
      : null;
    if (stored) {
      return normalizeLocalConfig({
        enabled: stored.enabled,
        providerId: stored.providerId,
        modelPath: stored.modelPath ?? null,
        modelId: stored.modelId,
        speakerId: stored.speakerId ?? null,
        settingsJson: stored.settingsJson,
      });
    }
    const local = this.getLocalProvider();
    return {
      enabled: true,
      providerId: this.localProviderId,
      ...(local?.defaultModelPath ? { modelPath: local.defaultModelPath } : {}),
      modelId: local?.defaultModelId ?? "default-local",
      settings: {},
    };
  }

  /** 保存本地语音配置：modelPath 白名单校验 → 持久化 → 同步本地 provider 生效配置 */
  async setLocalConfig(tenant: TenantContext, cfg: LocalVoiceConfig): Promise<LocalVoiceConfig> {
    const local = this.getLocalProvider();
    if (!local) {
      throw new Error("Local GPT-SoVITS provider is not registered");
    }
    if (cfg.modelPath) {
      const error = validateLocalPath(cfg.modelPath, local.allowedRoots);
      if (error) {
        throw new Error(`INVALID_VOICE_CONFIG: ${error}`);
      }
    }
    local.reconfigure({ modelPath: cfg.modelPath, modelId: cfg.modelId });

    if (!this.configRepository) {
      return {
        enabled: cfg.enabled,
        providerId: cfg.providerId,
        ...(cfg.modelPath ? { modelPath: cfg.modelPath } : {}),
        modelId: cfg.modelId,
        ...(cfg.speakerId ? { speakerId: cfg.speakerId } : {}),
        settings: cfg.settings ?? {},
      };
    }

    const saved = await this.configRepository.saveConfig(tenant, {
      enabled: cfg.enabled,
      providerId: cfg.providerId,
      modelPath: cfg.modelPath ?? null,
      modelId: cfg.modelId,
      speakerId: cfg.speakerId ?? null,
      settings: cfg.settings,
    });
    return normalizeLocalConfig({
      enabled: saved.enabled,
      providerId: saved.providerId,
      modelPath: saved.modelPath ?? null,
      modelId: saved.modelId,
      speakerId: saved.speakerId ?? null,
      settingsJson: saved.settingsJson,
    });
  }

  /** 读取当前租户的离线语音输入 (ASR) 配置 */
  async getVoiceInputConfig(tenant: TenantContext): Promise<VoiceInputConfig> {
    const stored = this.inputConfigRepository
      ? await this.inputConfigRepository.getConfig(tenant)
      : null;
    if (stored) {
      return normalizeVoiceInputConfig({
        enabled: stored.enabled,
        engineType: stored.engineType,
        modelPath: stored.modelPath ?? null,
        modelId: stored.modelId,
        endpoint: stored.endpoint ?? null,
        apiKey: stored.apiKey ?? null,
        autoStopOnKeyboard: stored.autoStopOnKeyboard,
        vadSilenceThresholdMs: stored.vadSilenceThresholdMs,
        settingsJson: stored.settingsJson,
      });
    }
    const senseVoice = this.getSenseVoiceProvider();
    return {
      enabled: true,
      engineType: "sensevoice-local",
      ...(senseVoice?.defaultModelPath ? { modelPath: senseVoice.defaultModelPath } : {}),
      modelId: senseVoice?.defaultModelId ?? "sensevoice-small",
      autoStopOnKeyboard: true,
      vadSilenceThresholdMs: 700,
      settings: {},
    };
  }

  /** 保存当前租户的离线语音输入 (ASR) 配置 */
  async setVoiceInputConfig(
    tenant: TenantContext,
    cfg: VoiceInputConfig,
  ): Promise<VoiceInputConfig> {
    const senseVoice = this.getSenseVoiceProvider();
    if (cfg.modelPath && senseVoice) {
      const error = validateLocalPath(cfg.modelPath, senseVoice.allowedRoots);
      if (error) {
        throw new Error(`INVALID_VOICE_INPUT_CONFIG: ${error}`);
      }
    }
    if (cfg.engineType === "sensevoice-local" && senseVoice) {
      senseVoice.reconfigure({ modelPath: cfg.modelPath, modelId: cfg.modelId });
    }

    if (!this.inputConfigRepository) {
      return cfg;
    }

    const saved = await this.inputConfigRepository.saveConfig(tenant, {
      enabled: cfg.enabled,
      engineType: cfg.engineType,
      modelPath: cfg.modelPath ?? null,
      modelId: cfg.modelId,
      endpoint: cfg.endpoint ?? null,
      apiKey: cfg.apiKey ?? null,
      autoStopOnKeyboard: cfg.autoStopOnKeyboard,
      vadSilenceThresholdMs: cfg.vadSilenceThresholdMs,
      settings: cfg.settings,
    });

    return normalizeVoiceInputConfig({
      enabled: saved.enabled,
      engineType: saved.engineType,
      modelPath: saved.modelPath ?? null,
      modelId: saved.modelId,
      endpoint: saved.endpoint ?? null,
      apiKey: saved.apiKey ?? null,
      autoStopOnKeyboard: saved.autoStopOnKeyboard,
      vadSilenceThresholdMs: saved.vadSilenceThresholdMs,
      settingsJson: saved.settingsJson,
    });
  }

  /** 获取离线语音输入模型状态 */
  async getVoiceInputModelStatus(tenant: TenantContext): Promise<{
    downloaded: boolean;
    downloading: boolean;
    progressPercent: number;
    downloadedBytes?: number;
    totalBytes?: number;
    verified: boolean;
    checksum?: string;
    modelPath?: string;
    message?: string;
  }> {
    const config = await this.getVoiceInputConfig(tenant);
    const senseVoice = this.getSenseVoiceProvider();
    if (!senseVoice) {
      return {
        downloaded: false,
        downloading: false,
        progressPercent: 0,
        verified: false,
        message: "未找到 SenseVoice 本地提供者",
      };
    }
    if (config.modelPath) {
      senseVoice.reconfigure({ modelPath: config.modelPath });
    }
    return senseVoice.getModelStatus();
  }

  /** 触发离线语音输入模型下载 */
  async downloadVoiceInputModel(
    tenant: TenantContext,
    options?: { targetDir?: string; mirrorUrl?: string },
  ): Promise<{
    accepted: boolean;
    message: string;
    status: {
      downloaded: boolean;
      downloading: boolean;
      progressPercent: number;
      downloadedBytes?: number;
      totalBytes?: number;
      verified: boolean;
      checksum?: string;
      modelPath?: string;
      message?: string;
    };
  }> {
    const senseVoice = this.getSenseVoiceProvider();
    if (!senseVoice) {
      throw new Error("SenseVoice local provider is not available");
    }
    const result = await senseVoice.startDownload(options);
    if (result.status.modelPath) {
      await this.setVoiceInputConfig(tenant, {
        ...(await this.getVoiceInputConfig(tenant)),
        modelPath: result.status.modelPath,
      });
    }
    return result;
  }
}