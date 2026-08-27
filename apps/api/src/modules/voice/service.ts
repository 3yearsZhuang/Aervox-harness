/**
 * Aervox｜思隅 @aervox/api — 系统级语音服务
 */
import type { TenantContext } from "@aervox/database";
import type { IVoiceConfigRepository } from "@aervox/database";
import { GptSovitsLocalProvider, validateLocalPath } from "./gpt-sovits.js";
import type {
  AudioArtifact,
  VoiceModel,
  VoiceProviderPort,
  VoiceSynthesisRequest,
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

export class VoiceService {
  private readonly providers = new Map<string, VoiceProviderPort>();
  private readonly localProviderId = "gpt-sovits-local";

  constructor(
    initialProviders: VoiceProviderPort[] = [],
    private readonly configRepository?: IVoiceConfigRepository,
  ) {
    for (const provider of initialProviders) {
      this.providers.set(provider.id, provider);
    }
  }

  registerProvider(provider: VoiceProviderPort): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(id: string): VoiceProviderPort | undefined {
    return this.providers.get(id);
  }

  hasProvider(id: string): boolean {
    return this.providers.has(id);
  }

  listProviderIds(): string[] {
    return [...this.providers.keys()];
  }

  private getLocalProvider(): GptSovitsLocalProvider | undefined {
    return this.providers.get(this.localProviderId) as GptSovitsLocalProvider | undefined;
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
}