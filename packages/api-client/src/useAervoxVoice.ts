/**
 * Aervox｜思隅 @aervox/api-client — 语音能力组合式 API（CR-011 阶段 1）
 *
 * Web / Desktop 共用：通过统一 Transport 读写本地语音模型配置、列出本地模型、试听合成。
 */
import { getTransport } from './transport';

/** 本地语音模型配置（对应 GET/PUT /v1/voice/config） */
export interface LocalVoiceConfigDto {
  enabled: boolean;
  providerId: string;
  modelPath?: string;
  modelId: string;
  speakerId?: string;
  settings?: Record<string, string | number | boolean>;
}

/** 在线语音模型配置（对应 GET/PUT /v1/voice/remote/config；CR-028） */
export interface RemoteVoiceConfigDto {
  enabled: boolean;
  providerId: string;
  endpoint?: string;
  apiKey?: string;
  modelId: string;
  speakerId?: string;
  textLang?: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue';
  refAudioPath?: string;
  promptText?: string;
  promptLang?: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue';
  auxRefAudioPaths?: string[];
  speedFactor?: number;
  settings?: Record<string, string | number | boolean>;
}

/** 在线语音服务连通性测试结果（POST /v1/voice/remote/test-connection） */
export interface VoiceRemoteTestConnectionResultDto {
  ok: boolean;
  latencyMs: number;
  message: string;
}

/** 语音模型（GET /v1/voice/models 条目） */
export interface VoiceModelDto {
  providerId: string;
  modelId: string;
  displayName: string;
  speakerIds: string[];
  available: boolean;
  source: 'local' | 'remote';
}

export interface VoiceSynthesisInput {
  providerId: string;
  modelId: string;
  speakerId?: string;
  text: string;
  settings?: Record<string, string | number | boolean>;
}

/** 语音合成结果（audioBase64 → Blob → <audio> 播放） */
export interface VoiceSynthesisResultDto {
  providerId: string;
  modelId: string;
  contentType: string;
  audioBase64: string;
}

/** 语音配置预设条目（多预设：本地输出/在线输出/输入共享 id+name+isActive） */
export interface VoicePresetDto {
  id: string;
  name: string;
  isActive: boolean;
  local: LocalVoiceConfigDto | null;
  remote: RemoteVoiceConfigDto | null;
  input: VoiceInputConfigRefDto | null;
}

/** 语音输入 (ASR) 配置引用（与 useAervoxVoiceInput 的 VoiceInputConfigDto 结构兼容） */
export interface VoiceInputConfigRefDto {
  enabled: boolean;
  engineType: string;
  modelPath?: string;
  modelId: string;
  endpoint?: string;
  apiKey?: string;
  autoStopOnKeyboard: boolean;
  vadSilenceThresholdMs: number;
  settings?: Record<string, string | number | boolean>;
}

/** 语音配置预设列表响应 */
export interface VoicePresetListDto {
  presets: VoicePresetDto[];
  activeId: string | null;
}

/** 取路径的最后一段（目录名），用作本地音色标识（如 /a/b/spk1 → spk1） */
export function basenameOf(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}

/** 当前环境是否支持系统「选择文件夹」对话框（仅 Electron 桌面端） */
export function canPickDirectory(): boolean {
  return typeof window !== 'undefined' && typeof window.fairyDesktop?.pickDirectory === 'function';
}

export function useAervoxVoice() {
  const transport = getTransport();

  /** 读取本地语音模型配置 */
  const getConfig = async (): Promise<LocalVoiceConfigDto> =>
    transport.request<LocalVoiceConfigDto>('GET', '/v1/voice/config');

  /** 保存本地语音模型配置（modelPath 受 allowedRoots 白名单约束） */
  const saveConfig = async (body: LocalVoiceConfigDto): Promise<LocalVoiceConfigDto> =>
    transport.request<LocalVoiceConfigDto>('PUT', '/v1/voice/config', body);

  /** 列出本地可用语音模型 */
  const loadLocalVoices = async (): Promise<VoiceModelDto[]> => {
    const res = await transport.request<{ models: VoiceModelDto[] }>('GET', '/v1/voice/models');
    return (res.models ?? []).filter(
      (m) => m.source === 'local' && m.available,
    );
  };

  /** 列出全部可用语音模型（本地 + 在线；CR-028） */
  const loadVoices = async (source?: 'local' | 'remote'): Promise<VoiceModelDto[]> => {
    const res = await transport.request<{ models: VoiceModelDto[] }>('GET', '/v1/voice/models');
    const models = res.models ?? [];
    return source ? models.filter((m) => m.source === source && m.available) : models.filter((m) => m.available);
  };

  /** 读取在线语音模型配置（CR-028） */
  const getRemoteConfig = async (): Promise<RemoteVoiceConfigDto> =>
    transport.request<RemoteVoiceConfigDto>('GET', '/v1/voice/remote/config');

  /** 保存在线语音模型配置（endpoint 必须为合法 http(s) URL） */
  const saveRemoteConfig = async (body: RemoteVoiceConfigDto): Promise<RemoteVoiceConfigDto> =>
    transport.request<RemoteVoiceConfigDto>('PUT', '/v1/voice/remote/config', body);

  /** 在线语音服务连通性测试 */
  const testRemoteConnection = async (
    body: Pick<RemoteVoiceConfigDto, 'endpoint' | 'apiKey' | 'modelId'>,
  ): Promise<VoiceRemoteTestConnectionResultDto> =>
    transport.request<VoiceRemoteTestConnectionResultDto>(
      'POST',
      '/v1/voice/remote/test-connection',
      body,
    );

  /** 试听：合成一段语音并返回 base64 音频 */
  const synthesize = async (input: VoiceSynthesisInput): Promise<VoiceSynthesisResultDto> => {
    const body = {
      providerId: input.providerId,
      modelId: input.modelId,
      ...(input.speakerId ? { speakerId: input.speakerId } : {}),
      ...(input.settings ? { settings: input.settings } : {}),
      text: input.text,
    };
    return transport.request<VoiceSynthesisResultDto>('POST', '/v1/voice/synthesize', body);
  };

  /** 打开系统目录选择器（Electron 桌面端）；Web 浏览器无桥时返回 null */
  const pickDirectory = async (): Promise<string | null> => {
    if (!canPickDirectory()) return null;
    return (await window.fairyDesktop!.pickDirectory!()) ?? null;
  };

  /** 列出语音配置预设（含激活标记与三块配置） */
  const listPresets = async (): Promise<VoicePresetListDto> =>
    transport.request<VoicePresetListDto>('GET', '/v1/voice/presets');

  /** 新建语音配置预设（仅登记名称，三表同步占位） */
  const createPreset = async (name: string): Promise<VoicePresetDto> =>
    transport.request<VoicePresetDto>('POST', '/v1/voice/presets', { name });

  /** 激活指定语音配置预设 */
  const activatePreset = async (presetId: string): Promise<VoicePresetDto> =>
    transport.request<VoicePresetDto>(
      'POST',
      `/v1/voice/presets/${encodeURIComponent(presetId)}/activate`,
    );

  /** 删除指定语音配置预设（三表中同名行均删除） */
  const deletePreset = async (presetId: string): Promise<unknown> =>
    transport.request<unknown>('DELETE', `/v1/voice/presets/${encodeURIComponent(presetId)}`);

  return {
    getConfig,
    saveConfig,
    loadLocalVoices,
    loadVoices,
    getRemoteConfig,
    saveRemoteConfig,
    testRemoteConnection,
    synthesize,
    pickDirectory,
    canPickDirectory,
    basenameOf,
    listPresets,
    createPreset,
    activatePreset,
    deletePreset,
  };
}