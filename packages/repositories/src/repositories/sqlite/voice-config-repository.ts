/**
 * Aervox｜思隅 @aervox/repositories — 语音输出配置 SQLite 仓储实现（CR-011 阶段 1 · 本地语音模型配置）
 *
 * - 配置属于本地单用户实例，可保存多个预设，至多一行激活；
 * - 本地 provider 固定 gpt-sovits-local；modelPath 白名单校验由 API 层负责。
 *
 * 多预设、至多一行激活、首个预设自动激活、删除后回落等规则由 `preset-repository.ts`
 * 统一实现；本文件只声明该表的行映射与字段映射。
 */
import { voiceConfigs } from "@aervox/schema";
import type { AervoxDatabase } from "../../client.js";
import type { LocalContext } from "../../local-context.js";
import { createPresetCrud } from "./preset-repository.js";
import type {
  IVoiceConfigRepository,
  LocalVoiceConfigSaveInput,
  LocalVoiceConfigModel,
} from "../types/index.js";

function rowToModel(row: typeof voiceConfigs.$inferSelect): LocalVoiceConfigModel {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    enabled: row.enabled,
    providerId: row.providerId,
    modelPath: row.modelPath,
    modelId: row.modelId,
    speakerId: row.speakerId,
    settingsJson: row.settingsJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 该表的字段映射：布尔转 0/1、可选字段落 null。 */
function valuesFor(input: LocalVoiceConfigSaveInput) {
  return {
    enabled: input.enabled ? 1 : 0,
    providerId: input.providerId,
    modelPath: input.modelPath ?? null,
    modelId: input.modelId,
    speakerId: input.speakerId ?? null,
    settingsJson: input.settings ?? {},
  };
}

export class SqliteVoiceConfigRepository implements IVoiceConfigRepository {
  private readonly crud;

  constructor(db: AervoxDatabase) {
    this.crud = createPresetCrud({
      db,
      table: voiceConfigs,
      idPrefix: "vc",
      toModel: rowToModel,
      toRow: valuesFor,
    });
  }

  getConfig(ctx: LocalContext): Promise<LocalVoiceConfigModel | null> {
    return this.crud.getConfig(ctx);
  }

  saveConfig(ctx: LocalContext, input: LocalVoiceConfigSaveInput): Promise<LocalVoiceConfigModel> {
    return this.crud.saveConfig(ctx, input);
  }

  listPresets(ctx: LocalContext): Promise<LocalVoiceConfigModel[]> {
    return this.crud.listPresets(ctx);
  }

  createPreset(ctx: LocalContext, name: string, input: LocalVoiceConfigSaveInput): Promise<LocalVoiceConfigModel> {
    return this.crud.createPreset(ctx, name, input);
  }

  updatePreset(ctx: LocalContext, presetId: string, input: LocalVoiceConfigSaveInput): Promise<LocalVoiceConfigModel | null> {
    return this.crud.updatePreset(ctx, presetId, input);
  }

  activatePreset(ctx: LocalContext, presetId: string): Promise<LocalVoiceConfigModel | null> {
    return this.crud.activatePreset(ctx, presetId);
  }

  deletePreset(ctx: LocalContext, presetId: string): Promise<boolean> {
    return this.crud.deletePreset(ctx, presetId);
  }
}
