/**
 * Aervox｜思隅 @aervox/repositories — llm-config 仓储类型（自 types.ts 机械拆分）
 */
import type { LLMConfigModel, LLMConfigSaveInput } from "./skill-lifecycle.js";
import type { LocalContext } from "../../local-context.js";

export interface ILLMConfigRepository {
  /** 读取当前租户激活的 LLM 配置（无激活行时回退第一条；不存在返回 null） */
  getConfig(tenant: LocalContext): Promise<LLMConfigModel | null>;
  /** upsert 到激活行（无激活行则插入并激活）；返回保存后的模型 */
  saveConfig(
    tenant: LocalContext,
    input: LLMConfigSaveInput,
  ): Promise<LLMConfigModel>;
  /** 列出全部预设（含激活标记） */
  listPresets(tenant: LocalContext): Promise<LLMConfigModel[]>;
  /** 新建预设（默认不激活，除非该租户尚无任何预设） */
  createPreset(tenant: LocalContext, name: string, input: LLMConfigSaveInput): Promise<LLMConfigModel>;
  /** 更新指定预设（保留激活状态） */
  updatePreset(tenant: LocalContext, presetId: string, input: LLMConfigSaveInput): Promise<LLMConfigModel | null>;
  /** 激活指定预设（事务内取消该租户其它激活）；预设不存在返回 null */
  activatePreset(tenant: LocalContext, presetId: string): Promise<LLMConfigModel | null>;
  /** 删除预设；若删除的是激活行则提升剩余第一条为激活 */
  deletePreset(tenant: LocalContext, presetId: string): Promise<boolean>;
}
