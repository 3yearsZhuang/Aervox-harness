/**
 * Aervox｜思隅 @aervox/repositories — persona-preferences 仓储类型（自 types.ts 机械拆分）
 */
import type { PersonaPreferencesModel } from "./plugin-page.js";
import type { LocalContext } from "../../local-context.js";

export interface IPersonaPreferencesRepository {
  /** 获取当前租户偏好（不存在返回 null） */
  get(tenant: LocalContext): Promise<PersonaPreferencesModel | null>;
  /** 首次填写问卷（跳过或提交四项） */
  save(
    tenant: LocalContext,
    input: {
      tone?: string;
      proactiveness?: string;
      addressForm?: string;
      reminderCadence?: string;
      skipped?: boolean;
    },
  ): Promise<PersonaPreferencesModel>;
  /** 单项或多项更新，版本号递增 */
  update(
    tenant: LocalContext,
    input: {
      tone?: string;
      proactiveness?: string;
      addressForm?: string;
      reminderCadence?: string;
    },
  ): Promise<PersonaPreferencesModel>;
  /** 重置为中性默认值（FR-PER-002） */
  reset(tenant: LocalContext): Promise<PersonaPreferencesModel>;
}

export interface LocalVoiceConfigModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  /** 预设名称（多预设切换用） */
  name?: string;
  /** 是否激活（0/1） */
  isActive?: number;
  enabled: number;
  providerId: string;
  modelPath?: string | null;
  modelId: string;
  speakerId?: string | null;
  settingsJson?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface LocalVoiceConfigSaveInput {
  enabled: boolean;
  providerId: string;
  modelPath?: string | null;
  modelId: string;
  speakerId?: string | null;
  settings?: Record<string, unknown>;
}
