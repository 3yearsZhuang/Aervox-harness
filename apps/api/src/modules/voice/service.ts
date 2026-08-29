/**
 * Aervox｜思隅 @aervox/api — 系统级语音服务
 */
import type { TenantContext } from "@aervox/database";
import type {
  IVoiceConfigRepository,
  IVoiceInputConfigRepository,
  IVoiceRemoteConfigRepository,
} from "@aervox/database";
import { GptSovitsLocalProvider, GptSovitsRemoteProvider, validateLocalPath } from "./gpt-sovits.js";
import {
  SenseVoiceLocalProvider,
  WhisperCompatibleProvider,
} from "./asr-providers.js";
import { loadApiConfig } from "@aervox/config";
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

/** 在线语音模型配置（CR-028 · GPT-SoVITS 远程 API，WebUI 设置读写） */
export interface RemoteVoiceConfig {
  enabled: boolean;
  providerId: string;
  /** api_v2 服务 base URL（env 未配置且未持久化时缺省） */
  endpoint?: string;
  apiKey?: string;
  modelId: string;
  speakerId?: string;
  textLang?: string;
  refAudioPath?: string;
  auxRefAudioPaths?: string[];
  speedFactor?: number;
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

function normalizeRemoteConfig(model: {
  enabled: number;
  providerId: string;
  endpoint: string;
  apiKey: string | null;
  modelId: string;
  speakerId: string | null;
  textLang: string | null;
  refAudioPath: string | null;
  auxRefAudioPathsJson: unknown;
  speedFactor: number | null;
  settingsJson: unknown;
}): RemoteVoiceConfig {
  return {
    enabled: model.enabled === 1,
    providerId: model.providerId,
    endpoint: model.endpoint,
    ...(model.apiKey ? { apiKey: model.apiKey } : {}),
    modelId: model.modelId,
    ...(model.speakerId ? { speakerId: model.speakerId } : {}),
    ...(model.textLang ? { textLang: model.textLang } : {}),
    ...(model.refAudioPath ? { refAudioPath: model.refAudioPath } : {}),
    ...(Array.isArray(model.auxRefAudioPathsJson) && model.auxRefAudioPathsJson.length > 0
      ? { auxRefAudioPaths: model.auxRefAudioPathsJson as string[] }
      : {}),
    ...(model.speedFactor !== null && model.speedFactor !== undefined
      ? { speedFactor: model.speedFactor }
      : {}),
    settings: (model.settingsJson as Record<string, string | number | boolean> | undefined) ?? {},
  };
}

export class VoiceService {
  private readonly providers = new Map<string, VoiceProviderPort>();
  private readonly asrProviders = new Map<string, ASRProviderPort>();
  private readonly localProviderId = "gpt-sovits-local";
  private readonly remoteProviderId = "gpt-sovits-remote";
  private readonly defaultAsrProviderId = "sensevoice-local";

  constructor(
    initialProviders: VoiceProviderPort[] = [],
    private readonly configRepository?: IVoiceConfigRepository,
    initialAsrProviders: ASRProviderPort[] = [],
    private readonly inputConfigRepository?: IVoiceInputConfigRepository,
    private readonly remoteConfigRepository?: IVoiceRemoteConfigRepository,
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

  private getRemoteProvider(): GptSovitsRemoteProvider | undefined {
    return this.providers.get(this.remoteProviderId) as GptSovitsRemoteProvider | undefined;
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

  /** 读取当前租户的在线语音配置；未持久化时按远程 provider 当前生效值给出默认（CR-028） */
  async getRemoteConfig(tenant: TenantContext): Promise<RemoteVoiceConfig> {
    const stored = this.remoteConfigRepository
      ? await this.remoteConfigRepository.getConfig(tenant)
      : null;
    if (stored) {
      return normalizeRemoteConfig({
        enabled: stored.enabled,
        providerId: stored.providerId,
        endpoint: stored.endpoint,
        apiKey: stored.apiKey ?? null,
        modelId: stored.modelId,
        speakerId: stored.speakerId ?? null,
        textLang: stored.textLang ?? null,
        refAudioPath: stored.refAudioPath ?? null,
        auxRefAudioPathsJson: stored.auxRefAudioPathsJson,
        speedFactor: stored.speedFactor ?? null,
        settingsJson: stored.settingsJson,
      });
    }
    const remote = this.getRemoteProvider();
    return {
      enabled: false,
      providerId: this.remoteProviderId,
      ...(remote?.defaultEndpoint ? { endpoint: remote.defaultEndpoint } : {}),
      modelId: remote?.defaultModelId ?? "default-remote",
      settings: {},
    };
  }

  /** 保存当前租户的在线语音配置：endpoint 合法性校验 → 持久化 → 同步远程 provider 生效配置（CR-028） */
  async setRemoteConfig(tenant: TenantContext, cfg: RemoteVoiceConfig): Promise<RemoteVoiceConfig> {
    const remote = this.getRemoteProvider();
    if (!remote) {
      throw new Error("Remote GPT-SoVITS provider is not registered");
    }
    if (!cfg.endpoint) {
      throw new Error("INVALID_VOICE_REMOTE_CONFIG: endpoint is required");
    }
    try {
      const parsed = new URL(cfg.endpoint);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("protocol must be http(s)");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "invalid URL";
      throw new Error(`INVALID_VOICE_REMOTE_CONFIG: endpoint URL 非法（${reason}）`);
    }
    remote.reconfigure({
      endpoint: cfg.endpoint,
      modelId: cfg.modelId,
      ...(cfg.apiKey !== undefined ? { secretRef: cfg.apiKey } : {}),
      ...(cfg.textLang !== undefined ? { textLang: cfg.textLang } : {}),
      ...(cfg.refAudioPath !== undefined ? { refAudioPath: cfg.refAudioPath } : {}),
      ...(cfg.auxRefAudioPaths !== undefined ? { auxRefAudioPaths: cfg.auxRefAudioPaths } : {}),
      ...(cfg.speedFactor !== undefined ? { speedFactor: cfg.speedFactor } : {}),
    });

    if (!this.remoteConfigRepository) {
      return cfg;
    }

    const saved = await this.remoteConfigRepository.saveConfig(tenant, {
      enabled: cfg.enabled,
      providerId: cfg.providerId,
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey ?? null,
      modelId: cfg.modelId,
      speakerId: cfg.speakerId ?? null,
      textLang: cfg.textLang ?? null,
      refAudioPath: cfg.refAudioPath ?? null,
      auxRefAudioPaths: cfg.auxRefAudioPaths ?? null,
      speedFactor: cfg.speedFactor ?? null,
      settings: cfg.settings,
    });
    return normalizeRemoteConfig({
      enabled: saved.enabled,
      providerId: saved.providerId,
      endpoint: saved.endpoint,
      apiKey: saved.apiKey ?? null,
      modelId: saved.modelId,
      speakerId: saved.speakerId ?? null,
      textLang: saved.textLang ?? null,
      refAudioPath: saved.refAudioPath ?? null,
      auxRefAudioPathsJson: saved.auxRefAudioPathsJson,
      speedFactor: saved.speedFactor ?? null,
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
    // CR-016 整改：Whisper 兼容模式 endpoint 必须为合法 http(s) URL（对齐 LLM baseUrl 校验先例），
    // 防止非法协议/格式在转写时才暴露或引发异常。
    if (cfg.engineType === "whisper-compatible" && cfg.endpoint) {
      try {
        const parsed = new URL(cfg.endpoint);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new Error("protocol must be http(s)");
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "invalid URL";
        throw new Error(`INVALID_VOICE_INPUT_CONFIG: endpoint URL 非法（${reason}）`);
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
    // CR-016 安全整改：targetDir 必须位于 allowedRoots 白名单内（允许尚不存在的目录），
    // 防止任意路径写入；mirrorUrl 必须命中允许的镜像源，防止 SSRF。
    const downloadError = validateDownloadTarget(senseVoice.allowedRoots, options);
    if (downloadError) {
      throw new Error(`INVALID_DOWNLOAD_REQUEST: ${downloadError}`);
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

/** 允许的 SenseVoice 模型镜像源 host（默认 hf-mirror.com，可通过环境变量覆盖；缺陷 E 经 @aervox/config 解析） */
export const ALLOWED_SENSEVOICE_MIRROR_HOSTS: readonly string[] = (() => {
  const envBase = loadApiConfig().asr.senseVoiceBaseUrl;
  const hosts = ["hf-mirror.com"];
  if (envBase) {
    try {
      hosts.push(new URL(envBase).host);
    } catch {
      // 忽略非法 SENSEVOICE_MODEL_BASE_URL，回退默认镜像
    }
  }
  return hosts;
})();

/**
 * 校验模型下载请求：targetDir 位于 allowedRoots 内（允许不存在），
 * mirrorUrl 的 host 命中允许的镜像源。任一不满足返回错误信息，否则返回 undefined。
 */
export function validateDownloadTarget(
  allowedRoots: readonly string[],
  options?: { targetDir?: string; mirrorUrl?: string },
): string | undefined {
  if (options?.targetDir) {
    if (allowedRoots.length === 0) return "no local model roots are configured";
    const normalized = options.targetDir.replaceAll("\\", "/").replace(/\/$/, "");
    const allowed = allowedRoots.some((root) => {
      const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
      return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
    });
    if (!allowed) return "targetDir is outside the configured allowlist";
  }
  if (options?.mirrorUrl) {
    let host: string;
    try {
      host = new URL(options.mirrorUrl).host;
    } catch {
      return "mirrorUrl is not a valid http(s) URL";
    }
    if (!ALLOWED_SENSEVOICE_MIRROR_HOSTS.includes(host)) {
      return `mirrorUrl host "${host}" is not allowed`;
    }
  }
  return undefined;
}