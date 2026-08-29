/**
 * Aervox｜思隅 @aervox/database — 在线语音配置 SQLite 仓储实现（CR-028 · GPT-SoVITS 远程 API）
 *
 * - 配置按 (workspaceId, subjectUserId) 租户隔离，每租户一行（upsert）；
 * - 在线 provider 固定 gpt-sovits-remote；endpoint 合法性由 API 层校验。
 */
import { and, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { voiceRemoteConfigs } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IVoiceRemoteConfigRepository,
  RemoteVoiceConfigSaveInput,
  RemoteVoiceConfigModel,
} from "../types.js";

export class SqliteVoiceRemoteConfigRepository implements IVoiceRemoteConfigRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async getConfig(tenant: TenantContext): Promise<RemoteVoiceConfigModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(voiceRemoteConfigs)
      .where(
        and(
          eq(voiceRemoteConfigs.workspaceId, tenant.workspaceId),
          eq(voiceRemoteConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return (found as RemoteVoiceConfigModel) ?? null;
  }

  async saveConfig(
    tenant: TenantContext,
    input: RemoteVoiceConfigSaveInput,
  ): Promise<RemoteVoiceConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.getConfig(tenant);

    const row = {
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

    if (existing) {
      const [updated] = await this.db
        .update(voiceRemoteConfigs)
        .set({ ...row, updatedAt: now })
        .where(
          and(
            eq(voiceRemoteConfigs.workspaceId, tenant.workspaceId),
            eq(voiceRemoteConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .returning();
      return updated as RemoteVoiceConfigModel;
    }

    const [created] = await this.db
      .insert(voiceRemoteConfigs)
      .values({
        id: `vrc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        ...row,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [voiceRemoteConfigs.workspaceId, voiceRemoteConfigs.subjectUserId],
        set: { ...row, updatedAt: now },
      })
      .returning();
    return created as RemoteVoiceConfigModel;
  }
}
