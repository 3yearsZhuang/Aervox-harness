/**
 * Aervox｜思隅 @aervox/api — 系统级语音服务
 */
import type {
  AudioArtifact,
  VoiceModel,
  VoiceProviderPort,
  VoiceSynthesisRequest,
} from "./types.js";

export class VoiceService {
  private readonly providers = new Map<string, VoiceProviderPort>();

  constructor(initialProviders: VoiceProviderPort[] = []) {
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
}
