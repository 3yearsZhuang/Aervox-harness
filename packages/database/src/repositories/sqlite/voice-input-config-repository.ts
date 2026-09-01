/**
 * Aervox｜思隅 @aervox/database — 语音输入配置 SQLite 仓储实现（CR-016）
 *
 * - 配置按 (workspaceId, subjectUserId) 租户隔离，每租户多行（多预设），至多一行激活；
 * - 支持 SenseVoice 本地模型 / OpenAI Whisper 兼容端点配置。
 */
import { and, asc, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { voiceInputConfigs } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IVoiceInputConfigRepository,
  VoiceInputConfigSaveInput,
  VoiceInputConfigModel,
} from "../types.js";

function rowToModel(row: typeof voiceInputConfigs.$inferSelect): VoiceInputConfigModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
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

export class SqliteVoiceInputConfigRepository implements IVoiceInputConfigRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async getConfig(tenant: TenantContext): Promise<VoiceInputConfigModel | null> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(voiceInputConfigs)
      .where(
        and(
          eq(voiceInputConfigs.workspaceId, tenant.workspaceId),
          eq(voiceInputConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(asc(voiceInputConfigs.createdAt))
      .limit(50);
    if (rows.length === 0) return null;
    const active = rows.find((row) => row.isActive === 1) ?? rows[0]!;
    return rowToModel(active);
  }

  async saveConfig(
    tenant: TenantContext,
    input: VoiceInputConfigSaveInput,
  ): Promise<VoiceInputConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const active = await this.getConfig(tenant);

    if (active) {
      const [updated] = await this.db
        .update(voiceInputConfigs)
        .set({ ...valuesFor(input), updatedAt: now })
        .where(eq(voiceInputConfigs.id, active.id))
        .returning();
      return rowToModel(updated!);
    }

    const [created] = await this.db
      .insert(voiceInputConfigs)
      .values({
        id: `vic_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
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

  async listPresets(tenant: TenantContext): Promise<VoiceInputConfigModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(voiceInputConfigs)
      .where(
        and(
          eq(voiceInputConfigs.workspaceId, tenant.workspaceId),
          eq(voiceInputConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(asc(voiceInputConfigs.createdAt));
    return rows.map(rowToModel);
  }

  async createPreset(
    tenant: TenantContext,
    name: string,
    input: VoiceInputConfigSaveInput,
  ): Promise<VoiceInputConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.listPresets(tenant);
    const firstPreset = existing.length === 0;

    const [created] = await this.db
      .insert(voiceInputConfigs)
      .values({
        id: `vic_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
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
    input: VoiceInputConfigSaveInput,
  ): Promise<VoiceInputConfigModel | null> {
    assertTenantContext(tenant);
    const [updated] = await this.db
      .update(voiceInputConfigs)
      .set({ ...valuesFor(input), updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(voiceInputConfigs.id, presetId),
          eq(voiceInputConfigs.workspaceId, tenant.workspaceId),
          eq(voiceInputConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return updated ? rowToModel(updated!) : null;
  }

  async activatePreset(
    tenant: TenantContext,
    presetId: string,
  ): Promise<VoiceInputConfigModel | null> {
    assertTenantContext(tenant);
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(voiceInputConfigs)
        .where(
          and(
            eq(voiceInputConfigs.id, presetId),
            eq(voiceInputConfigs.workspaceId, tenant.workspaceId),
            eq(voiceInputConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .limit(1);
      if (!target) return null;
      await tx
        .update(voiceInputConfigs)
        .set({ isActive: 0, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(voiceInputConfigs.workspaceId, tenant.workspaceId),
            eq(voiceInputConfigs.subjectUserId, tenant.subjectUserId),
          ),
        );
      const [activated] = await tx
        .update(voiceInputConfigs)
        .set({ isActive: 1, updatedAt: new Date().toISOString() })
        .where(eq(voiceInputConfigs.id, presetId))
        .returning();
      return rowToModel(activated!);
    });
  }

  async deletePreset(tenant: TenantContext, presetId: string): Promise<boolean> {
    assertTenantContext(tenant);
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(voiceInputConfigs)
        .where(
          and(
            eq(voiceInputConfigs.id, presetId),
            eq(voiceInputConfigs.workspaceId, tenant.workspaceId),
            eq(voiceInputConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .limit(1);
      if (!target) return false;
      const wasActive = target.isActive === 1;
      await tx.delete(voiceInputConfigs).where(eq(voiceInputConfigs.id, presetId));
      if (wasActive) {
        const [first] = await tx
          .select()
          .from(voiceInputConfigs)
          .where(
            and(
              eq(voiceInputConfigs.workspaceId, tenant.workspaceId),
              eq(voiceInputConfigs.subjectUserId, tenant.subjectUserId),
            ),
          )
          .orderBy(asc(voiceInputConfigs.createdAt))
          .limit(1);
        if (first) {
          await tx
            .update(voiceInputConfigs)
            .set({ isActive: 1, updatedAt: new Date().toISOString() })
            .where(eq(voiceInputConfigs.id, first.id));
        }
      }
      return true;
    });
  }
}

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