/**
 * Aervox｜思隅 @aervox/database — 语音输出配置 SQLite 仓储实现（CR-011 阶段 1 · 本地语音模型配置）
 *
 * - 配置按 (workspaceId, subjectUserId) 租户隔离，每租户多行（多预设），至多一行激活；
 * - 本地 provider 固定 gpt-sovits-local；modelPath 白名单校验由 API 层负责。
 */
import { and, asc, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { voiceConfigs } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IVoiceConfigRepository,
  LocalVoiceConfigSaveInput,
  LocalVoiceConfigModel,
} from "../types.js";

function rowToModel(row: typeof voiceConfigs.$inferSelect): LocalVoiceConfigModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
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

export class SqliteVoiceConfigRepository implements IVoiceConfigRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async getConfig(tenant: TenantContext): Promise<LocalVoiceConfigModel | null> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(voiceConfigs)
      .where(
        and(
          eq(voiceConfigs.workspaceId, tenant.workspaceId),
          eq(voiceConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(asc(voiceConfigs.createdAt))
      .limit(50);
    if (rows.length === 0) return null;
    const active = rows.find((row) => row.isActive === 1) ?? rows[0]!;
    return rowToModel(active);
  }

  async saveConfig(
    tenant: TenantContext,
    input: LocalVoiceConfigSaveInput,
  ): Promise<LocalVoiceConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const active = await this.getConfig(tenant);

    if (active) {
      const [updated] = await this.db
        .update(voiceConfigs)
        .set({ ...valuesFor(input), updatedAt: now })
        .where(eq(voiceConfigs.id, active.id))
        .returning();
      return rowToModel(updated!);
    }

    const [created] = await this.db
      .insert(voiceConfigs)
      .values({
        id: `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
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

  async listPresets(tenant: TenantContext): Promise<LocalVoiceConfigModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(voiceConfigs)
      .where(
        and(
          eq(voiceConfigs.workspaceId, tenant.workspaceId),
          eq(voiceConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(asc(voiceConfigs.createdAt));
    return rows.map(rowToModel);
  }

  async createPreset(
    tenant: TenantContext,
    name: string,
    input: LocalVoiceConfigSaveInput,
  ): Promise<LocalVoiceConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.listPresets(tenant);
    const firstPreset = existing.length === 0;

    const [created] = await this.db
      .insert(voiceConfigs)
      .values({
        id: `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
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
    input: LocalVoiceConfigSaveInput,
  ): Promise<LocalVoiceConfigModel | null> {
    assertTenantContext(tenant);
    const [updated] = await this.db
      .update(voiceConfigs)
      .set({ ...valuesFor(input), updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(voiceConfigs.id, presetId),
          eq(voiceConfigs.workspaceId, tenant.workspaceId),
          eq(voiceConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return updated ? rowToModel(updated!) : null;
  }

  async activatePreset(
    tenant: TenantContext,
    presetId: string,
  ): Promise<LocalVoiceConfigModel | null> {
    assertTenantContext(tenant);
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(voiceConfigs)
        .where(
          and(
            eq(voiceConfigs.id, presetId),
            eq(voiceConfigs.workspaceId, tenant.workspaceId),
            eq(voiceConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .limit(1);
      if (!target) return null;
      await tx
        .update(voiceConfigs)
        .set({ isActive: 0, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(voiceConfigs.workspaceId, tenant.workspaceId),
            eq(voiceConfigs.subjectUserId, tenant.subjectUserId),
          ),
        );
      const [activated] = await tx
        .update(voiceConfigs)
        .set({ isActive: 1, updatedAt: new Date().toISOString() })
        .where(eq(voiceConfigs.id, presetId))
        .returning();
      return rowToModel(activated!);
    });
  }

  async deletePreset(tenant: TenantContext, presetId: string): Promise<boolean> {
    assertTenantContext(tenant);
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(voiceConfigs)
        .where(
          and(
            eq(voiceConfigs.id, presetId),
            eq(voiceConfigs.workspaceId, tenant.workspaceId),
            eq(voiceConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .limit(1);
      if (!target) return false;
      const wasActive = target.isActive === 1;
      await tx.delete(voiceConfigs).where(eq(voiceConfigs.id, presetId));
      if (wasActive) {
        const [first] = await tx
          .select()
          .from(voiceConfigs)
          .where(
            and(
              eq(voiceConfigs.workspaceId, tenant.workspaceId),
              eq(voiceConfigs.subjectUserId, tenant.subjectUserId),
            ),
          )
          .orderBy(asc(voiceConfigs.createdAt))
          .limit(1);
        if (first) {
          await tx
            .update(voiceConfigs)
            .set({ isActive: 1, updatedAt: new Date().toISOString() })
            .where(eq(voiceConfigs.id, first.id));
        }
      }
      return true;
    });
  }
}

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