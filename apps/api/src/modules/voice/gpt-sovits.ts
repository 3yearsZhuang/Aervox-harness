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

function validateLocalPath(
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
  ) {}

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

export class GptSovitsRemoteProvider implements VoiceProviderPort {
  readonly kind = "gpt-sovits-remote" as const;

  constructor(
    readonly id: string,
    private readonly config: {
      endpoint?: string;
      protocol?: VoiceProtocol;
      modelId: string;
      speakerIds?: string[];
      secretRef?: string;
    },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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
    if (!this.config.endpoint || !this.config.protocol) {
      return { status: "misconfigured", message: "endpoint and protocol are required" };
    }
    try {
      const response = await this.fetchImpl(this.config.endpoint, {
        method: "GET",
        headers: this.config.secretRef
          ? { Authorization: `Bearer ${this.config.secretRef}` }
          : undefined,
      });
      return response.ok
        ? { status: "healthy" }
        : { status: "unavailable", message: `provider returned ${response.status}` };
    } catch (error) {
      return {
        status: "unavailable",
        message: error instanceof Error ? error.message : "provider unavailable",
      };
    }
  }

  async synthesize(request: VoiceSynthesisRequest): Promise<AudioArtifact> {
    if (!this.config.endpoint || !this.config.protocol) {
      throw new Error("Remote GPT-SoVITS is misconfigured");
    }
    const response = await this.fetchImpl(this.config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.secretRef ? { Authorization: `Bearer ${this.config.secretRef}` } : {}),
      },
      body: JSON.stringify({
        text: request.text,
        modelId: request.modelId,
        speakerId: request.speakerId,
        settings: request.settings,
      }),
    });
    if (!response.ok) {
      throw new Error(`GPT-SoVITS provider returned ${response.status}`);
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
