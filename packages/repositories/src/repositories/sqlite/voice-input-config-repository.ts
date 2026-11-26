/**
 * Aervox｜思隅 @aervox/repositories — 语音输入配置 SQLite 仓储实现（CR-016）
 *
 * - 配置属于本地单用户实例，可保存多个预设，至多一行激活；
 * - 支持 SenseVoice 本地模型 / OpenAI Whisper 兼容端点配置。
 *
 * 多预设、至多一行激活、首个预设自动激活、删除后回落等规则由 `preset-repository.ts`
 * 统一实现；本文件只声明该表的行映射与字段映射。
 */
import { voiceInputConfigs } from "@aervox/schema";
import type { AervoxDatabase } from "../../client.js";
import type { LocalContext } from "../../local-context.js";
import { createPresetCrud } from "./preset-repository.js";
import type { IVoiceInputConfigRepository, VoiceInputConfigSaveInput, VoiceInputConfigModel } from "../types/index.js";

function rowToModel(row: typeof voiceInputConfigs.$inferSelect): VoiceInputConfigModel {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    enabled: row.enabled,
    engineType: row.engineType,
    modelPath: row.modelPath,
    modelId: row.modelId,
    endpoint: row.endpoint,
    apiKey: row.apiKey,
    autoStopOnKeyboard: row.autoStopOnKeyboard,
    vadSilenceThresholdMs: row.vadSilenceThresholdMs,
    settingsJson: row.settingsJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 该表的字段映射：布尔转 0/1、可选字段落 null、默认值在此补齐。 */
function valuesFor(input: VoiceInputConfigSaveInput) {
  return {
    enabled: input.enabled ? 1 : 0,
    engineType: input.engineType,
    modelPath: input.modelPath ?? null,
    modelId: input.modelId,
    endpoint: input.endpoint ?? null,
    apiKey: input.apiKey ?? null,
    autoStopOnKeyboard: input.autoStopOnKeyboard === false ? 0 : 1,
    vadSilenceThresholdMs: input.vadSilenceThresholdMs ?? 700,
    settingsJson: input.settings ?? {},
  };
}

export class SqliteVoiceInputConfigRepository implements IVoiceInputConfigRepository {
  private readonly crud;

  constructor(db: AervoxDatabase) {
    this.crud = createPresetCrud({
      db,
      table: voiceInputConfigs,
      idPrefix: "vic",
      toModel: rowToModel,
      toRow: valuesFor,
    });
  }

  getConfig(ctx: LocalContext): Promise<VoiceInputConfigModel | null> { return this.crud.getConfig(ctx); }
  saveConfig(ctx: LocalContext, input: VoiceInputConfigSaveInput): Promise<VoiceInputConfigModel> { return this.crud.saveConfig(ctx, input); }
  listPresets(ctx: LocalContext): Promise<VoiceInputConfigModel[]> { return this.crud.listPresets(ctx); }
  createPreset(ctx: LocalContext, name: string, input: VoiceInputConfigSaveInput): Promise<VoiceInputConfigModel> { return this.crud.createPreset(ctx, name, input); }
  updatePreset(ctx: LocalContext, presetId: string, input: VoiceInputConfigSaveInput): Promise<VoiceInputConfigModel | null> { return this.crud.updatePreset(ctx, presetId, input); }
  activatePreset(ctx: LocalContext, presetId: string): Promise<VoiceInputConfigModel | null> { return this.crud.activatePreset(ctx, presetId); }
  deletePreset(ctx: LocalContext, presetId: string): Promise<boolean> { return this.crud.deletePreset(ctx, presetId); }
}
