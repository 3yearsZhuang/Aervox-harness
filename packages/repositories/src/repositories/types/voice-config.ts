/**
 * Aervox｜思隅 @aervox/repositories — voice-config 仓储类型（自 types.ts 机械拆分）
 */
import type { LocalVoiceConfigModel, LocalVoiceConfigSaveInput } from "./persona-preferences.js";
import type { LocalContext } from "../../local-context.js";

export interface IVoiceConfigRepository {
  /** 读取当前租户激活的本地语音配置（无激活行时回退第一条；不存在返回 null） */
  getConfig(tenant: LocalContext): Promise<LocalVoiceConfigModel | null>;
  /** upsert 到激活行（无激活行则插入并激活）；返回保存后的模型 */
  saveConfig(tenant: LocalContext, input: LocalVoiceConfigSaveInput): Promise<LocalVoiceConfigModel>;
  /** 列出全部预设（含激活标记） */
  listPresets(tenant: LocalContext): Promise<LocalVoiceConfigModel[]>;
  /** 新建预设（默认不激活，除非该租户尚无任何预设） */
  createPreset(tenant: LocalContext, name: string, input: LocalVoiceConfigSaveInput): Promise<LocalVoiceConfigModel>;
  /** 更新指定预设（保留激活状态） */
  updatePreset(tenant: LocalContext, presetId: string, input: LocalVoiceConfigSaveInput): Promise<LocalVoiceConfigModel | null>;
  /** 激活指定预设（事务内取消该租户其它激活）；预设不存在返回 null */
  activatePreset(tenant: LocalContext, presetId: string): Promise<LocalVoiceConfigModel | null>;
  /** 删除预设；若删除的是激活行则提升剩余第一条为激活 */
  deletePreset(tenant: LocalContext, presetId: string): Promise<boolean>;
}

export interface RemoteVoiceConfigModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  /** 预设名称（多预设切换用） */
  name?: string;
  /** 是否激活（0/1） */
  isActive?: number;
  enabled: number;
  providerId: string;
  endpoint: string;
  apiKey?: string | null;
  modelId: string;
  speakerId?: string | null;
  textLang?: string | null;
  refAudioPath?: string | null;
  promptText?: string | null;
  promptLang?: string | null;
  auxRefAudioPathsJson?: unknown;
  speedFactor?: number | null;
  settingsJson?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteVoiceConfigSaveInput {
  enabled: boolean;
  providerId: string;
  endpoint: string;
  apiKey?: string | null;
  modelId: string;
  speakerId?: string | null;
  textLang?: string | null;
  refAudioPath?: string | null;
  promptText?: string | null;
  promptLang?: string | null;
  auxRefAudioPaths?: string[] | null;
  speedFactor?: number | null;
  settings?: Record<string, unknown>;
}
