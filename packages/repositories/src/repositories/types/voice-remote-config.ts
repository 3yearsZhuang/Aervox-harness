/**
 * Aervox｜思隅 @aervox/repositories — voice-remote-config 仓储类型（自 types.ts 机械拆分）
 */
import type { RemoteVoiceConfigModel, RemoteVoiceConfigSaveInput } from "./voice-config.js";
import type { TenantContext } from "../../tenant.js";

export interface IVoiceRemoteConfigRepository {
  /** 读取当前租户激活的在线语音配置（无激活行时回退第一条；不存在返回 null） */
  getConfig(tenant: TenantContext): Promise<RemoteVoiceConfigModel | null>;
  /** upsert 到激活行（无激活行则插入并激活）；返回保存后的模型 */
  saveConfig(tenant: TenantContext, input: RemoteVoiceConfigSaveInput): Promise<RemoteVoiceConfigModel>;
  /** 列出全部预设（含激活标记） */
  listPresets(tenant: TenantContext): Promise<RemoteVoiceConfigModel[]>;
  /** 新建预设（默认不激活，除非该租户尚无任何预设） */
  createPreset(tenant: TenantContext, name: string, input: RemoteVoiceConfigSaveInput): Promise<RemoteVoiceConfigModel>;
  /** 更新指定预设（保留激活状态） */
  updatePreset(tenant: TenantContext, presetId: string, input: RemoteVoiceConfigSaveInput): Promise<RemoteVoiceConfigModel | null>;
  /** 激活指定预设（事务内取消该租户其它激活）；预设不存在返回 null */
  activatePreset(tenant: TenantContext, presetId: string): Promise<RemoteVoiceConfigModel | null>;
  /** 删除预设；若删除的是激活行则提升剩余第一条为激活 */
  deletePreset(tenant: TenantContext, presetId: string): Promise<boolean>;
}

export interface VoiceInputConfigModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  /** 预设名称（多预设切换用） */
  name?: string;
  /** 是否激活（0/1） */
  isActive?: number;
  enabled: number;
  engineType: string;
  modelPath?: string | null;
  modelId: string;
  endpoint?: string | null;
  apiKey?: string | null;
  autoStopOnKeyboard: number;
  vadSilenceThresholdMs: number;
  settingsJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceInputConfigSaveInput {
  enabled: boolean;
  engineType: string;
  modelPath?: string | null;
  modelId: string;
  endpoint?: string | null;
  apiKey?: string | null;
  autoStopOnKeyboard?: boolean;
  vadSilenceThresholdMs?: number;
  settings?: Record<string, unknown>;
}
