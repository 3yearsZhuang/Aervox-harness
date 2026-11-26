/**
 * Aervox｜思隅 @aervox/repositories — 模型服务配置 SQLite 仓储实现
 *
 * - 配置属于本地单用户实例，可保存多个预设，至多一行激活；
 * - 协议、可用性与 contextWindow 的判定由宿主 LLM 模块负责，本文件只管持久化。
 *
 * 多预设、至多一行激活、首个预设自动激活、删除后回落等规则由 `preset-repository.ts`
 * 统一实现；本文件只声明该表的行映射与字段映射。
 */
import { llmConfigs } from "@aervox/schema";
import type { AervoxDatabase } from "../../client.js";
import type { LocalContext } from "../../local-context.js";
import { createPresetCrud } from "./preset-repository.js";
import type { ILLMConfigRepository, LLMConfigSaveInput, LLMConfigModel } from "../types/index.js";

function rowToModel(row: typeof llmConfigs.$inferSelect): LLMConfigModel {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    enabled: row.enabled,
    providerType: row.providerType,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    modelId: row.modelId,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    settingsJson: row.settingsJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 该表的字段映射：布尔转 0/1、可选字段落 null、默认值在此补齐。 */
function valuesFor(input: LLMConfigSaveInput) {
  return {
    enabled: input.enabled ? 1 : 0,
    providerType: input.providerType,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey ?? null,
    modelId: input.modelId,
    temperature: input.temperature,
    maxTokens: input.maxTokens ?? 4096,
    settingsJson: input.settings ?? {},
  };
}

export class SqliteLLMConfigRepository implements ILLMConfigRepository {
  private readonly crud;

  constructor(db: AervoxDatabase) {
    this.crud = createPresetCrud({
      db,
      table: llmConfigs,
      idPrefix: "llm",
      toModel: rowToModel,
      toRow: valuesFor,
    });
  }

  getConfig(ctx: LocalContext): Promise<LLMConfigModel | null> { return this.crud.getConfig(ctx); }
  saveConfig(ctx: LocalContext, input: LLMConfigSaveInput): Promise<LLMConfigModel> { return this.crud.saveConfig(ctx, input); }
  listPresets(ctx: LocalContext): Promise<LLMConfigModel[]> { return this.crud.listPresets(ctx); }
  createPreset(ctx: LocalContext, name: string, input: LLMConfigSaveInput): Promise<LLMConfigModel> { return this.crud.createPreset(ctx, name, input); }
  updatePreset(ctx: LocalContext, presetId: string, input: LLMConfigSaveInput): Promise<LLMConfigModel | null> { return this.crud.updatePreset(ctx, presetId, input); }
  activatePreset(ctx: LocalContext, presetId: string): Promise<LLMConfigModel | null> { return this.crud.activatePreset(ctx, presetId); }
  deletePreset(ctx: LocalContext, presetId: string): Promise<boolean> { return this.crud.deletePreset(ctx, presetId); }
}
