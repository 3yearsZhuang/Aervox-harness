/**
 * Aervox｜思隅 @aervox/database — 语音输出配置 SQLite 仓储实现（CR-011 阶段 1 · 本地语音模型配置）
 *
 * - 配置按 (workspaceId, subjectUserId) 租户隔离，每租户一行（upsert）；
 * - 本地 provider 固定 gpt-sovits-local；modelPath 白名单校验由 API 层负责。
 */
import { and, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { voiceConfigs } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IVoiceConfigRepository,
  LocalVoiceConfigSaveInput,
  LocalVoiceConfigModel,
} from "../types.js";

export class SqliteVoiceConfigRepository implements IVoiceConfigRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async getConfig(tenant: TenantContext): Promise<LocalVoiceConfigModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(voiceConfigs)
      .where(
        and(
          eq(voiceConfigs.workspaceId, tenant.workspaceId),
          eq(voiceConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return (found as LocalVoiceConfigModel) ?? null;
  }

  async saveConfig(
    tenant: TenantContext,
    input: LocalVoiceConfigSaveInput,
  ): Promise<LocalVoiceConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.getConfig(tenant);

    if (existing) {
      const [updated] = await this.db
        .update(voiceConfigs)
        .set({
          enabled: input.enabled ? 1 : 0,
          providerId: input.providerId,
          modelPath: input.modelPath ?? null,
          modelId: input.modelId,
          speakerId: input.speakerId ?? null,
          settingsJson: input.settings ?? {},
          updatedAt: now,
        })
        .where(
          and(
            eq(voiceConfigs.workspaceId, tenant.workspaceId),
            eq(voiceConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .returning();
      return updated as LocalVoiceConfigModel;
    }

    const [created] = await this.db
      .insert(voiceConfigs)
      .values({
        id: `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        enabled: input.enabled ? 1 : 0,
        providerId: input.providerId,
        modelPath: input.modelPath ?? null,
        modelId: input.modelId,
        speakerId: input.speakerId ?? null,
        settingsJson: input.settings ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [voiceConfigs.workspaceId, voiceConfigs.subjectUserId],
        set: {
          enabled: input.enabled ? 1 : 0,
          providerId: input.providerId,
          modelPath: input.modelPath ?? null,
          modelId: input.modelId,
          speakerId: input.speakerId ?? null,
          settingsJson: input.settings ?? {},
          updatedAt: now,
        },
      })
      .returning();
    return created as LocalVoiceConfigModel;
  }
}