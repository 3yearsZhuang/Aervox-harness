/**
 * Aervox｜思隅 @aervox/repositories — 在线语音配置 SQLite 仓储实现（CR-028 · GPT-SoVITS 远程 API）
 *
 * - 配置属于本地单用户实例，可保存多个预设，至多一行激活；
 * - 在线 provider 固定 gpt-sovits-remote；endpoint 合法性由 API 层校验。
 */
import { and, asc, eq } from "drizzle-orm";
import { activePresetOrder, activatePreset, deletePreset } from "./preset-lifecycle.js";
import type { AervoxDatabase } from "../../client.js";
import { voiceRemoteConfigs } from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";
import type {
  IVoiceRemoteConfigRepository,
  RemoteVoiceConfigSaveInput,
  RemoteVoiceConfigModel,
} from "../types/index.js";

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

export class SqliteVoiceRemoteConfigRepository implements IVoiceRemoteConfigRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async getConfig(ctx: LocalContext): Promise<RemoteVoiceConfigModel | null> {
    const rows = await this.db
      .select()
      .from(voiceRemoteConfigs)
      .orderBy(...activePresetOrder(voiceRemoteConfigs))
      .limit(1);
    if (rows.length === 0) return null;
    return rowToModel(rows[0]!);
  }

  async saveConfig(
    ctx: LocalContext,
    input: RemoteVoiceConfigSaveInput,
  ): Promise<RemoteVoiceConfigModel> {
    const now = new Date().toISOString();
    const active = await this.getConfig(ctx);

    if (active) {
      const [updated] = await this.db
        .update(voiceRemoteConfigs)
        .set({ ...valuesFor(input), updatedAt: now })
        .where(eq(voiceRemoteConfigs.id, active.id))
        .returning();
      return rowToModel(updated!);
    }

    const [created] = await this.db
      .insert(voiceRemoteConfigs)
      .values({
        id: `vrc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        name: "默认配置",
        isActive: 1,
        ...valuesFor(input),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToModel(created!);
  }

  async listPresets(ctx: LocalContext): Promise<RemoteVoiceConfigModel[]> {
    const rows = await this.db
      .select()
      .from(voiceRemoteConfigs)
      .orderBy(asc(voiceRemoteConfigs.createdAt));
    return rows.map(rowToModel);
  }

  async createPreset(
    ctx: LocalContext,
    name: string,
    input: RemoteVoiceConfigSaveInput,
  ): Promise<RemoteVoiceConfigModel> {
    const now = new Date().toISOString();
    const existing = await this.listPresets(ctx);
    const firstPreset = existing.length === 0;

    const [created] = await this.db
      .insert(voiceRemoteConfigs)
      .values({
        id: `vrc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        name: name.trim() || "默认配置",
        isActive: firstPreset ? 1 : 0,
        ...valuesFor(input),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToModel(created!);
  }

  async updatePreset(
    ctx: LocalContext,
    presetId: string,
    input: RemoteVoiceConfigSaveInput,
  ): Promise<RemoteVoiceConfigModel | null> {
    const [updated] = await this.db
      .update(voiceRemoteConfigs)
      .set({ ...valuesFor(input), updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(voiceRemoteConfigs.id, presetId),
        ),
      )
      .returning();
    return updated ? rowToModel(updated!) : null;
  }

  async activatePreset(
    ctx: LocalContext,
    presetId: string,
  ): Promise<RemoteVoiceConfigModel | null> {
    return activatePreset(this.db, voiceRemoteConfigs, presetId, async tx => {
      const [row] = await tx.select().from(voiceRemoteConfigs).where(eq(voiceRemoteConfigs.id, presetId)).limit(1);
      return row ? rowToModel(row) : null;
    });
  }

  async deletePreset(ctx: LocalContext, presetId: string): Promise<boolean> {
    return deletePreset(this.db, voiceRemoteConfigs, presetId);
  }
}

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
