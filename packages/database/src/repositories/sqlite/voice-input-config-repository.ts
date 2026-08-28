/**
 * Aervox｜思隅 @aervox/database — 语音输入配置 SQLite 仓储实现（CR-016）
 *
 * - 配置按 (workspaceId, subjectUserId) 租户隔离，每租户一行（upsert）；
 * - 支持 SenseVoice 本地模型 / OpenAI Whisper 兼容端点配置。
 */
import { and, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { voiceInputConfigs } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IVoiceInputConfigRepository,
  VoiceInputConfigSaveInput,
  VoiceInputConfigModel,
} from "../types.js";

export class SqliteVoiceInputConfigRepository implements IVoiceInputConfigRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async getConfig(tenant: TenantContext): Promise<VoiceInputConfigModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(voiceInputConfigs)
      .where(
        and(
          eq(voiceInputConfigs.workspaceId, tenant.workspaceId),
          eq(voiceInputConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return (found as VoiceInputConfigModel) ?? null;
  }

  async saveConfig(
    tenant: TenantContext,
    input: VoiceInputConfigSaveInput,
  ): Promise<VoiceInputConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.getConfig(tenant);

    if (existing) {
      const [updated] = await this.db
        .update(voiceInputConfigs)
        .set({
          enabled: input.enabled ? 1 : 0,
          engineType: input.engineType,
          modelPath: input.modelPath ?? null,
          modelId: input.modelId,
          endpoint: input.endpoint ?? null,
          apiKey: input.apiKey ?? null,
          autoStopOnKeyboard: input.autoStopOnKeyboard === false ? 0 : 1,
          vadSilenceThresholdMs: input.vadSilenceThresholdMs ?? 700,
          settingsJson: input.settings ?? {},
          updatedAt: now,
        })
        .where(
          and(
            eq(voiceInputConfigs.workspaceId, tenant.workspaceId),
            eq(voiceInputConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .returning();
      return updated as VoiceInputConfigModel;
    }

    const [created] = await this.db
      .insert(voiceInputConfigs)
      .values({
        id: `vic_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        enabled: input.enabled ? 1 : 0,
        engineType: input.engineType,
        modelPath: input.modelPath ?? null,
        modelId: input.modelId,
        endpoint: input.endpoint ?? null,
        apiKey: input.apiKey ?? null,
        autoStopOnKeyboard: input.autoStopOnKeyboard === false ? 0 : 1,
        vadSilenceThresholdMs: input.vadSilenceThresholdMs ?? 700,
        settingsJson: input.settings ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [voiceInputConfigs.workspaceId, voiceInputConfigs.subjectUserId],
        set: {
          enabled: input.enabled ? 1 : 0,
          engineType: input.engineType,
          modelPath: input.modelPath ?? null,
          modelId: input.modelId,
          endpoint: input.endpoint ?? null,
          apiKey: input.apiKey ?? null,
          autoStopOnKeyboard: input.autoStopOnKeyboard === false ? 0 : 1,
          vadSilenceThresholdMs: input.vadSilenceThresholdMs ?? 700,
          settingsJson: input.settings ?? {},
          updatedAt: now,
        },
      })
      .returning();
    return created as VoiceInputConfigModel;
  }
}
