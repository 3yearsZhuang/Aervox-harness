/**
 * Aervox｜思隅 @aervox/database — 在线语音配置 SQLite 仓储实现（CR-028 · GPT-SoVITS 远程 API）
 *
 * - 配置按 (workspaceId, subjectUserId) 租户隔离，每租户多行（多预设），至多一行激活；
 * - 在线 provider 固定 gpt-sovits-remote；endpoint 合法性由 API 层校验。
 */
import { and, asc, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { voiceRemoteConfigs } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IVoiceRemoteConfigRepository,
  RemoteVoiceConfigSaveInput,
  RemoteVoiceConfigModel,
} from "../types.js";

function rowToModel(row: typeof voiceRemoteConfigs.$inferSelect): RemoteVoiceConfigModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
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

  async getConfig(tenant: TenantContext): Promise<RemoteVoiceConfigModel | null> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(voiceRemoteConfigs)
      .where(
        and(
          eq(voiceRemoteConfigs.workspaceId, tenant.workspaceId),
          eq(voiceRemoteConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(asc(voiceRemoteConfigs.createdAt))
      .limit(50);
    if (rows.length === 0) return null;
    const active = rows.find((row) => row.isActive === 1) ?? rows[0]!;
    return rowToModel(active);
  }

  async saveConfig(
    tenant: TenantContext,
    input: RemoteVoiceConfigSaveInput,
  ): Promise<RemoteVoiceConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const active = await this.getConfig(tenant);

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
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        name: "默认配置",
        isActive: 1,
        ...valuesFor(input),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToModel(created!);
  }

  async listPresets(tenant: TenantContext): Promise<RemoteVoiceConfigModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(voiceRemoteConfigs)
      .where(
        and(
          eq(voiceRemoteConfigs.workspaceId, tenant.workspaceId),
          eq(voiceRemoteConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(asc(voiceRemoteConfigs.createdAt));
    return rows.map(rowToModel);
  }

  async createPreset(
    tenant: TenantContext,
    name: string,
    input: RemoteVoiceConfigSaveInput,
  ): Promise<RemoteVoiceConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.listPresets(tenant);
    const firstPreset = existing.length === 0;

    const [created] = await this.db
      .insert(voiceRemoteConfigs)
      .values({
        id: `vrc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
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
    tenant: TenantContext,
    presetId: string,
    input: RemoteVoiceConfigSaveInput,
  ): Promise<RemoteVoiceConfigModel | null> {
    assertTenantContext(tenant);
    const [updated] = await this.db
      .update(voiceRemoteConfigs)
      .set({ ...valuesFor(input), updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(voiceRemoteConfigs.id, presetId),
          eq(voiceRemoteConfigs.workspaceId, tenant.workspaceId),
          eq(voiceRemoteConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return updated ? rowToModel(updated!) : null;
  }

  async activatePreset(
    tenant: TenantContext,
    presetId: string,
  ): Promise<RemoteVoiceConfigModel | null> {
    assertTenantContext(tenant);
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(voiceRemoteConfigs)
        .where(
          and(
            eq(voiceRemoteConfigs.id, presetId),
            eq(voiceRemoteConfigs.workspaceId, tenant.workspaceId),
            eq(voiceRemoteConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .limit(1);
      if (!target) return null;
      await tx
        .update(voiceRemoteConfigs)
        .set({ isActive: 0, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(voiceRemoteConfigs.workspaceId, tenant.workspaceId),
            eq(voiceRemoteConfigs.subjectUserId, tenant.subjectUserId),
          ),
        );
      const [activated] = await tx
        .update(voiceRemoteConfigs)
        .set({ isActive: 1, updatedAt: new Date().toISOString() })
        .where(eq(voiceRemoteConfigs.id, presetId))
        .returning();
      return rowToModel(activated!);
    });
  }

  async deletePreset(tenant: TenantContext, presetId: string): Promise<boolean> {
    assertTenantContext(tenant);
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(voiceRemoteConfigs)
        .where(
          and(
            eq(voiceRemoteConfigs.id, presetId),
            eq(voiceRemoteConfigs.workspaceId, tenant.workspaceId),
            eq(voiceRemoteConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .limit(1);
      if (!target) return false;
      const wasActive = target.isActive === 1;
      await tx.delete(voiceRemoteConfigs).where(eq(voiceRemoteConfigs.id, presetId));
      if (wasActive) {
        const [first] = await tx
          .select()
          .from(voiceRemoteConfigs)
          .where(
            and(
              eq(voiceRemoteConfigs.workspaceId, tenant.workspaceId),
              eq(voiceRemoteConfigs.subjectUserId, tenant.subjectUserId),
            ),
          )
          .orderBy(asc(voiceRemoteConfigs.createdAt))
          .limit(1);
        if (first) {
          await tx
            .update(voiceRemoteConfigs)
            .set({ isActive: 1, updatedAt: new Date().toISOString() })
            .where(eq(voiceRemoteConfigs.id, first.id));
        }
      }
      return true;
    });
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