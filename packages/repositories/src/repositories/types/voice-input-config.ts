/**
 * Aervox｜思隅 @aervox/repositories — voice-input-config 仓储类型（自 types.ts 机械拆分）
 */
import type { VoiceInputConfigModel, VoiceInputConfigSaveInput } from "./voice-remote-config.js";
import type { LocalContext } from "../../local-context.js";

export interface IVoiceInputConfigRepository {
  /** 读取当前租户激活的语音输入配置（无激活行时回退第一条；不存在返回 null） */
  getConfig(tenant: LocalContext): Promise<VoiceInputConfigModel | null>;
  /** upsert 到激活行（无激活行则插入并激活）；返回保存后的模型 */
  saveConfig(
    tenant: LocalContext,
    input: VoiceInputConfigSaveInput,
  ): Promise<VoiceInputConfigModel>;
  /** 列出全部预设（含激活标记） */
  listPresets(tenant: LocalContext): Promise<VoiceInputConfigModel[]>;
  /** 新建预设（默认不激活，除非该租户尚无任何预设） */
  createPreset(tenant: LocalContext, name: string, input: VoiceInputConfigSaveInput): Promise<VoiceInputConfigModel>;
  /** 更新指定预设（保留激活状态） */
  updatePreset(tenant: LocalContext, presetId: string, input: VoiceInputConfigSaveInput): Promise<VoiceInputConfigModel | null>;
  /** 激活指定预设（事务内取消该租户其它激活）；预设不存在返回 null */
  activatePreset(tenant: LocalContext, presetId: string): Promise<VoiceInputConfigModel | null>;
  /** 删除预设；若删除的是激活行则提升剩余第一条为激活 */
  deletePreset(tenant: LocalContext, presetId: string): Promise<boolean>;
}

export interface ToolRegistrationModel {
  id: string;
  name: string;
  description: string;
  category: string; // memory/search/learning/diary/system/external
  /** PET-05 安全级别：read_only / write_with_approval / privileged */
  safetyLevel: string;
  /** B3：结果未知恢复复议声明（"never" | "safe"；NULL=未声明，收敛） */
  replay?: string | null;
  requiredPermissionsJson?: unknown;
  inputSchemaJson?: unknown;
  builtin: number; // 0 | 1
  pluginId?: string | null;
  enabled: number; // 0 | 1
  /** AST-04 条件门控（JSON 数组，运行时求值） */
  gatingConditionsJson?: unknown;
  priority: number;
  createdAt: string;
  updatedAt: string;
}
