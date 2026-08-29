/**
 * Aervox｜思隅 @aervox/api — 系统级 GPT-SoVITS 本地与远程适配器
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  AudioArtifact,
  VoiceModel,
  VoiceProtocol,
  VoiceProviderHealth,
  VoiceProviderPort,
  VoiceSynthesisRequest,
} from "./types.js";

export function validateLocalPath(
  modelPath: string | undefined,
  allowedRoots: readonly string[],
): string | undefined {
  if (!modelPath) return "modelPath is required";
  if (allowedRoots.length === 0) return "no local model roots are configured";
  const normalized = modelPath.replaceAll("\\", "/");
  const allowed = allowedRoots.some((root) => {
    const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
    const prefix = `${normalizedRoot}/`;
    return normalized === normalizedRoot || normalized.startsWith(prefix);
  });
  if (!allowed) return "modelPath is outside the configured allowlist";
  return existsSync(modelPath) ? undefined : "modelPath does not exist";
}

export class GptSovitsLocalProvider implements VoiceProviderPort {
  readonly kind = "gpt-sovits-local" as const;

  constructor(
    readonly id: string,
    private readonly config: {
      modelPath?: string;
      modelId: string;
      speakerIds?: string[];
      allowedRoots: string[];
    },
  ) {
    // 快照最初（env）配置，作为未持久化配置时的缺省默认值；
    // reconfigure 只改运行时生效值，不影响此后缺省回退。
    this.defaults = { modelPath: config.modelPath, modelId: config.modelId };
  }

  private readonly defaults: { modelPath?: string; modelId: string };

  /** 已配置的本地模型路径白名单（供配置路由校验 modelPath） */
  get allowedRoots(): readonly string[] {
    return this.config.allowedRoots;
  }

  get configuredModelPath(): string | undefined {
    return this.config.modelPath;
  }

  get configuredModelId(): string {
    return this.config.modelId;
  }

  /** 最初（env）默认模型路径，用作未持久化配置时的缺省 */
  get defaultModelPath(): string | undefined {
    return this.defaults.modelPath;
  }

  /** 最初（env）默认模型 ID */
  get defaultModelId(): string {
    return this.defaults.modelId;
  }

  /** 保存本地语音配置后，同步更新本地 provider 的生效配置 */
  reconfigure(update: { modelPath?: string; modelId?: string }): void {
    if (update.modelPath !== undefined) this.config.modelPath = update.modelPath;
    if (update.modelId !== undefined) this.config.modelId = update.modelId;
  }

  async listModels(): Promise<VoiceModel[]> {
    const error = validateLocalPath(this.config.modelPath, this.config.allowedRoots);
    return [
      {
        providerId: this.id,
        modelId: this.config.modelId,
        displayName: this.config.modelId,
        speakerIds: this.config.speakerIds ?? [],
        available: !error,
        source: "local",
      },
    ];
  }

  async healthCheck(): Promise<VoiceProviderHealth> {
    const error = validateLocalPath(this.config.modelPath, this.config.allowedRoots);
    return error ? { status: "misconfigured", message: error } : { status: "healthy" };
  }

  async synthesize(request: VoiceSynthesisRequest): Promise<AudioArtifact> {
    const health = await this.healthCheck();
    if (health.status !== "healthy") {
      throw new Error(health.message ?? "Local GPT-SoVITS unavailable");
    }
    return {
      contentType: "audio/wav",
      bytes: new TextEncoder().encode(`GPT-SOVITS-LOCAL:${request.modelId}:${request.text}`),
      providerId: this.id,
      modelId: request.modelId,
      generatedAt: new Date().toISOString(),
    };
  }
}

/** 远程 Provider 运行时配置（CR-028：此前仅由 env 管理，现在可由设置 UI 热更新） */
export interface GptSovitsRemoteRuntimeConfig {
  /** api_v2 服务 base URL（如 http://127.0.0.1:9880），不含 /tts 后缀 */
  endpoint?: string;
  protocol?: VoiceProtocol;
  modelId: string;
  speakerIds?: string[];
  /** Bearer 访问密钥（服务端未开启鉴权时留空） */
  secretRef?: string;
  /** api_v2 text_lang（auto/zh/en/ja/ko/yue） */
  textLang?: string;
  /** api_v2 参考音频路径（GPT-SoVITS 机器上的路径） */
  refAudioPath?: string;
  /** api_v2 参考音频的文字内容（v3/v4 SoVITS 必填，需与参考音频一致） */
  promptText?: string;
  /** api_v2 参考音频的语言（prompt_lang） */
  promptLang?: string;
  /** api_v2 辅助参考音频路径列表 */
  auxRefAudioPaths?: string[];
  /** api_v2 语速（0.6–1.65） */
  speedFactor?: number;
}

export class GptSovitsRemoteProvider implements VoiceProviderPort {
  readonly kind = "gpt-sovits-remote" as const;

  constructor(
    readonly id: string,
    private readonly config: GptSovitsRemoteRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // 快照最初（env）配置，作为未持久化配置时的缺省默认值；
    // reconfigure 只改运行时生效值，不影响此后缺省回退。
    this.defaults = { ...config };
  }

  private readonly defaults: GptSovitsRemoteRuntimeConfig;

  /** 最初（env）默认 base URL，用作未持久化配置时的缺省 */
  get defaultEndpoint(): string | undefined {
    return this.defaults.endpoint;
  }

  /** 最初（env）默认模型 ID */
  get defaultModelId(): string {
    return this.defaults.modelId;
  }

  /** 保存在线语音配置后，同步更新远程 provider 的生效配置 */
  reconfigure(update: Partial<Omit<GptSovitsRemoteRuntimeConfig, "modelId">> & { modelId?: string }): void {
    if (update.endpoint !== undefined) this.config.endpoint = update.endpoint;
    if (update.protocol !== undefined) this.config.protocol = update.protocol;
    if (update.modelId !== undefined) this.config.modelId = update.modelId;
    if (update.speakerIds !== undefined) this.config.speakerIds = update.speakerIds;
    if (update.secretRef !== undefined) this.config.secretRef = update.secretRef;
    if (update.textLang !== undefined) this.config.textLang = update.textLang;
    if (update.refAudioPath !== undefined) this.config.refAudioPath = update.refAudioPath;
    if (update.promptText !== undefined) this.config.promptText = update.promptText;
    if (update.promptLang !== undefined) this.config.promptLang = update.promptLang;
    if (update.auxRefAudioPaths !== undefined) this.config.auxRefAudioPaths = update.auxRefAudioPaths;
    if (update.speedFactor !== undefined) this.config.speedFactor = update.speedFactor;
  }

  /** 拼接 api_v2 端点：base URL 去尾斜杠 + /tts */
  private ttsEndpoint(): string {
    return `${this.config.endpoint!.replace(/\/+$/, "")}/tts`;
  }

  private authHeaders(): Record<string, string> {
    return this.config.secretRef
      ? { Authorization: `Bearer ${this.config.secretRef}` }
      : {};
  }

  async listModels(): Promise<VoiceModel[]> {
    const health = await this.healthCheck();
    return [
      {
        providerId: this.id,
        modelId: this.config.modelId,
        displayName: this.config.modelId,
        speakerIds: this.config.speakerIds ?? [],
        available: health.status === "healthy",
        source: "remote",
      },
    ];
  }

  async healthCheck(): Promise<VoiceProviderHealth> {
    if (!this.config.endpoint) {
      return { status: "misconfigured", message: "endpoint is required" };
    }
    try {
      // api_v2 对根路径与 /tts 的 GET 都会返回 HTTP 状态（非 2xx 也说明服务可达），
      // 因此以「是否拿到 HTTP 响应」判定连通性，网络异常才视为不可用。
      const response = await this.fetchImpl(this.config.endpoint.replace(/\/+$/, ""), {
        method: "GET",
        headers: this.authHeaders(),
      });
      return {
        status: "healthy",
        message: `服务可达（HTTP ${response.status}）`,
      };
    } catch (error) {
      return {
        status: "unavailable",
        message: error instanceof Error ? error.message : "provider unavailable",
      };
    }
  }

  async synthesize(request: VoiceSynthesisRequest): Promise<AudioArtifact> {
    if (!this.config.endpoint) {
      throw new Error("Remote GPT-SoVITS is misconfigured");
    }
    // GPT-SoVITS api_v2 协议（CR-028）：text_lang / ref_audio_path / prompt_lang 为必填，
    // v3/v4 SoVITS 还要求 prompt_text 非空；请求级 settings 可覆盖 provider 配置（便于试听不同参数）。
    const settings = request.settings ?? {};
    const textLang = (settings.textLang as string | undefined) ?? this.config.textLang ?? "zh";
    const refAudioPath =
      (settings.refAudioPath as string | undefined) ?? this.config.refAudioPath;
    if (!refAudioPath) {
      throw new Error("refAudioPath is required (api_v2 ref_audio_path)");
    }
    const promptText =
      (settings.promptText as string | undefined) ?? this.config.promptText;
    if (!promptText) {
      throw new Error("promptText is required (api_v2 prompt_text)");
    }
    const promptLang =
      (settings.promptLang as string | undefined) ??
      this.config.promptLang ??
      textLang;
    const speedFactor =
      (settings.speedFactor as number | undefined) ?? this.config.speedFactor;
    const auxRefAudioPaths =
      this.config.auxRefAudioPaths && this.config.auxRefAudioPaths.length > 0
        ? this.config.auxRefAudioPaths
        : undefined;

    const response = await this.fetchImpl(this.ttsEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders(),
      },
      body: JSON.stringify({
        text: request.text,
        text_lang: textLang,
        ref_audio_path: refAudioPath,
        prompt_text: promptText,
        prompt_lang: promptLang,
        ...(auxRefAudioPaths ? { aux_ref_audio_paths: auxRefAudioPaths } : {}),
        ...(speedFactor !== undefined ? { speed_factor: speedFactor } : {}),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `GPT-SoVITS provider returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    return {
      contentType: response.headers.get("content-type") ?? "audio/wav",
      bytes: new Uint8Array(await response.arrayBuffer()),
      providerId: this.id,
      modelId: request.modelId,
      generatedAt: new Date().toISOString(),
    };
  }
}

export function voiceReferenceFingerprint(ref: {
  providerId: string;
  kind: string;
  endpoint?: string;
  protocol?: string;
  modelId?: string;
  speakerId?: string;
  modelPath?: string;
  secretRef?: string;
}): string {
  const safe = { ...ref };
  delete safe.secretRef;
  return createHash("sha256").update(JSON.stringify(safe)).digest("hex");
}
