/**
 * Aervox｜思隅 @aervox/api — 系统级语音领域类型与 Provider Port
 */
export type VoiceProviderKind = "gpt-sovits-local" | "gpt-sovits-remote";
export type VoiceProtocol = "http" | "websocket";

export interface VoiceModel {
  providerId: string;
  modelId: string;
  displayName: string;
  speakerIds: string[];
  available: boolean;
  source: "local" | "remote";
}

export interface VoiceProviderHealth {
  status: "healthy" | "unavailable" | "misconfigured";
  message?: string;
}

export interface VoiceSynthesisRequest {
  text: string;
  modelId: string;
  speakerId?: string;
  settings?: Record<string, string | number | boolean>;
}

export interface AudioArtifact {
  contentType: string;
  bytes: Uint8Array;
  providerId: string;
  modelId: string;
  generatedAt: string;
}

export interface VoiceProviderPort {
  readonly id: string;
  readonly kind: VoiceProviderKind | string;
  listModels(): Promise<VoiceModel[]>;
  healthCheck(): Promise<VoiceProviderHealth>;
  synthesize(request: VoiceSynthesisRequest): Promise<AudioArtifact>;
}
