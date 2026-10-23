/**
 * Aervox｜思隅 @aervox/api-client — 语音能力组合式 API（CR-011 阶段 1）
 *
 * Web / Desktop 共用：通过统一 Transport 读写本地语音模型配置、列出本地模型、试听合成。
 */
import { getClientTransport, getClientPlatformServices } from './client-context.js';
import { voiceApi } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import type { LocalVoiceConfigDraft as LocalVoiceConfigDto, RemoteVoiceConfigDraft as RemoteVoiceConfigDto, VoiceRemoteTestOutput as VoiceRemoteTestConnectionResultDto, VoiceModelOutput as VoiceModelDto, VoiceSynthesisInput, VoiceSynthesisOutput as VoiceSynthesisResultDto, VoicePreset as VoicePresetDto, VoicePresetReceipt, VoiceInputConfigOutput as VoiceInputConfigRefDto, VoicePresetListResponse as VoicePresetListDto } from '@aervox/contracts';
export type { LocalVoiceConfigDto, RemoteVoiceConfigDto, VoiceRemoteTestConnectionResultDto, VoiceModelDto, VoiceSynthesisInput, VoiceSynthesisResultDto, VoicePresetDto, VoiceInputConfigRefDto, VoicePresetListDto };

/** 取路径的最后一段（目录名），用作本地音色标识（如 /a/b/spk1 → spk1） */
export function basenameOf(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}

/** 当前环境是否支持系统「选择文件夹」对话框（仅 Electron 桌面端） */
export function canPickDirectory(): boolean {
  return typeof getClientPlatformServices().pickDirectory === 'function';
}

export function useAervoxVoice() {
  const transport = getClientTransport();
  const platform = getClientPlatformServices();
  const canPickDirectory = () => typeof platform.pickDirectory === 'function';

  /** 读取本地语音模型配置 */
  const getConfig = async (): Promise<LocalVoiceConfigDto> =>
    requestEndpoint(transport, voiceApi.local);

  /** 保存本地语音模型配置（modelPath 受 allowedRoots 白名单约束） */
  const saveConfig = async (body: LocalVoiceConfigDto): Promise<LocalVoiceConfigDto> =>
    requestEndpoint(transport, voiceApi.saveLocal, body);

  /** 列出本地可用语音模型 */
  const loadLocalVoices = async (): Promise<VoiceModelDto[]> => {
    const res = await requestEndpoint(transport, voiceApi.models);
    return (res.models ?? []).filter(
      (m) => m.source === 'local' && m.available,
    );
  };

  /** 列出全部可用语音模型（本地 + 在线；CR-028） */
  const loadVoices = async (source?: 'local' | 'remote'): Promise<VoiceModelDto[]> => {
    const res = await requestEndpoint(transport, voiceApi.models);
    const models = res.models ?? [];
    return source ? models.filter((m) => m.source === source && m.available) : models.filter((m) => m.available);
  };

  /** 读取在线语音模型配置（CR-028） */
  const getRemoteConfig = async (): Promise<RemoteVoiceConfigDto> =>
    requestEndpoint(transport, voiceApi.remote);

  /** 保存在线语音模型配置（endpoint 必须为合法 http(s) URL） */
  const saveRemoteConfig = async (body: RemoteVoiceConfigDto): Promise<RemoteVoiceConfigDto> =>
    requestEndpoint(transport, voiceApi.saveRemote, body);

  /** 在线语音服务连通性测试 */
  const testRemoteConnection = async (
    body: Pick<RemoteVoiceConfigDto, 'endpoint' | 'apiKey' | 'modelId'>,
  ): Promise<VoiceRemoteTestConnectionResultDto> =>
    requestEndpoint(transport, voiceApi.testRemote, body);

  /** 试听：合成一段语音并返回 base64 音频 */
  const synthesize = async (input: VoiceSynthesisInput): Promise<VoiceSynthesisResultDto> => {
    const body = {
      providerId: input.providerId,
      modelId: input.modelId,
      ...(input.speakerId ? { speakerId: input.speakerId } : {}),
      ...(input.settings ? { settings: input.settings } : {}),
      text: input.text,
    };
    return requestEndpoint(transport, voiceApi.synthesize, body);
  };

  /** 打开系统目录选择器（Electron 桌面端）；Web 浏览器无桥时返回 null */
  const pickDirectory = async (): Promise<string | null> => {
    if (!canPickDirectory()) return null;
    return (await platform.pickDirectory!()) ?? null;
  };

  /** 列出语音配置预设（含激活标记与三块配置） */
  const listPresets = async (): Promise<VoicePresetListDto> =>
    requestEndpoint(transport, voiceApi.presets);

  /** 新建语音配置预设（仅登记名称，三表同步占位） */
  const createPreset = async (name: string): Promise<VoicePresetReceipt> =>
    requestEndpoint(transport, voiceApi.createPreset, { name });

  /** 激活指定语音配置预设 */
  const activatePreset = async (presetId: string): Promise<VoicePresetReceipt> =>
    requestEndpoint(transport, voiceApi.activatePreset, undefined, { presetId });

  /** 删除指定语音配置预设（三表中同名行均删除） */
  const deletePreset = async (presetId: string): Promise<unknown> =>
    requestEndpoint(transport, voiceApi.deletePreset, undefined, { presetId });

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