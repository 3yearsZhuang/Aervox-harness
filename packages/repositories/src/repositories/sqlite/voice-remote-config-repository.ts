/**
 * Aervox｜思隅 @aervox/repositories — 在线语音配置 SQLite 仓储实现（CR-028 · GPT-SoVITS 远程 API）
 *
 * - 配置属于本地单用户实例，可保存多个预设，至多一行激活；
 * - 在线 provider 固定 gpt-sovits-remote；endpoint 合法性由 API 层校验。
 *
 * 多预设、至多一行激活、首个预设自动激活、删除后回落等规则由 `preset-repository.ts`
 * 统一实现；本文件只声明该表的行映射与字段映射。
 */
import { voiceRemoteConfigs } from "@aervox/schema";
import type { AervoxDatabase } from "../../client.js";
import type { LocalContext } from "../../local-context.js";
import { createPresetCrud } from "./preset-repository.js";
import type { IVoiceRemoteConfigRepository, RemoteVoiceConfigSaveInput, RemoteVoiceConfigModel } from "../types/index.js";

function rowToModel(row: typeof voiceRemoteConfigs.$inferSelect): RemoteVoiceConfigModel {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    enabled: row.enabled,
    providerId: row.providerId,
    endpoint: row.endpoint,
    apiKey: row.apiKey,
    modelId: row.modelId,
    speakerId: row.speakerId,
    textLang: row.textLang,
    refAudioPath: row.refAudioPath,
    promptText: row.promptText,
    promptLang: row.promptLang,
    auxRefAudioPathsJson: row.auxRefAudioPathsJson,
    speedFactor: row.speedFactor,
    settingsJson: row.settingsJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 该表的字段映射：布尔转 0/1、可选字段落 null、默认值在此补齐。 */
function valuesFor(input: RemoteVoiceConfigSaveInput) {
  return {
    enabled: input.enabled ? 1 : 0,
    providerId: input.providerId,
    endpoint: input.endpoint,
    apiKey: input.apiKey ?? null,
    modelId: input.modelId,
    speakerId: input.speakerId ?? null,
    textLang: input.textLang ?? null,
    refAudioPath: input.refAudioPath ?? null,
    promptText: input.promptText ?? null,
    promptLang: input.promptLang ?? null,
    auxRefAudioPathsJson: input.auxRefAudioPaths ?? null,
    speedFactor: input.speedFactor ?? null,
    settingsJson: input.settings ?? {},
  };
}

export class SqliteVoiceRemoteConfigRepository implements IVoiceRemoteConfigRepository {
  private readonly crud;

  constructor(db: AervoxDatabase) {
    this.crud = createPresetCrud({
      db,
      table: voiceRemoteConfigs,
      idPrefix: "vrc",
      toModel: rowToModel,
      toRow: valuesFor,
    });
  }

  getConfig(ctx: LocalContext): Promise<RemoteVoiceConfigModel | null> { return this.crud.getConfig(ctx); }
  saveConfig(ctx: LocalContext, input: RemoteVoiceConfigSaveInput): Promise<RemoteVoiceConfigModel> { return this.crud.saveConfig(ctx, input); }
  listPresets(ctx: LocalContext): Promise<RemoteVoiceConfigModel[]> { return this.crud.listPresets(ctx); }
  createPreset(ctx: LocalContext, name: string, input: RemoteVoiceConfigSaveInput): Promise<RemoteVoiceConfigModel> { return this.crud.createPreset(ctx, name, input); }
  updatePreset(ctx: LocalContext, presetId: string, input: RemoteVoiceConfigSaveInput): Promise<RemoteVoiceConfigModel | null> { return this.crud.updatePreset(ctx, presetId, input); }
  activatePreset(ctx: LocalContext, presetId: string): Promise<RemoteVoiceConfigModel | null> { return this.crud.activatePreset(ctx, presetId); }
  deletePreset(ctx: LocalContext, presetId: string): Promise<boolean> { return this.crud.deletePreset(ctx, presetId); }
}
