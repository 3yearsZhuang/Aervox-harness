/**
 * Aervox｜思隅 @aervox/database — 插件 Config / Page SQLite 仓储实现（CAP-020 扩展 · CR-006）
 *
 * - 配置按 (workspaceId, subjectUserId, pluginId) 租户隔离，revision 做乐观 CAS；
 * - secret 值与配置分开存储，接口只暴露配置状态；生产应替换为加密 SecretStore Port；
 * - Page 元数据为系统级（生命周期归插件，启停/卸载联动由 API 层处理）。
 */
import { and, eq, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  pluginConfigs,
  pluginConfigSecrets,
  pluginPages,
} from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IPluginConfigRepository,
  IPluginPageRepository,
  IPluginSecretRepository,
  PluginConfigModel,
  PluginConfigSaveInput,
  PluginPageModel,
  PluginSecretModel,
} from "../types.js";

export class SqlitePluginConfigRepository implements IPluginConfigRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async getConfig(tenant: TenantContext, pluginId: string): Promise<PluginConfigModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(pluginConfigs)
      .where(
        and(
          eq(pluginConfigs.workspaceId, tenant.workspaceId),
          eq(pluginConfigs.subjectUserId, tenant.subjectUserId),
          eq(pluginConfigs.pluginId, pluginId),
        ),
      )
      .limit(1);
    return (found as PluginConfigModel) ?? null;
  }

  async saveConfig(
    tenant: TenantContext,
    input: PluginConfigSaveInput,
  ): Promise<{ saved: PluginConfigModel; conflict: boolean }> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.getConfig(tenant, input.pluginId);

    if (existing) {
      if (input.expectedRevision >= 0 && existing.revision !== input.expectedRevision) {
        return { saved: existing, conflict: true };
      }
      const [updated] = await this.db
        .update(pluginConfigs)
        .set({
          valuesJson: input.values,
          secretKeysJson: input.secretKeys,
          schemaVersion: input.schemaVersion,
          revision: existing.revision + 1,
          orphanedValuesJson: input.orphanedValues ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(pluginConfigs.id, existing.id),
            eq(pluginConfigs.workspaceId, tenant.workspaceId),
            eq(pluginConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .returning();
      return { saved: updated as PluginConfigModel, conflict: false };
    }

    const [created] = await this.db
      .insert(pluginConfigs)
      .values({
        id: `pcfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        pluginId: input.pluginId,
        valuesJson: input.values,
        secretKeysJson: input.secretKeys,
        schemaVersion: input.schemaVersion,
        revision: 1,
        orphanedValuesJson: input.orphanedValues ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { saved: created as PluginConfigModel, conflict: false };
  }

  async resetConfig(
    tenant: TenantContext,
    pluginId: string,
    schemaVersion: number,
    defaults: Record<string, unknown>,
  ): Promise<PluginConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.getConfig(tenant, pluginId);
    if (existing) {
      const [updated] = await this.db
        .update(pluginConfigs)
        .set({
          valuesJson: defaults,
          secretKeysJson: [],
          schemaVersion,
          revision: existing.revision + 1,
          orphanedValuesJson: null,
          updatedAt: now,
        })
        .where(eq(pluginConfigs.id, existing.id))
        .returning();
      return updated as PluginConfigModel;
    }
    const [created] = await this.db
      .insert(pluginConfigs)
      .values({
        id: `pcfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        pluginId,
        valuesJson: defaults,
        secretKeysJson: [],
        schemaVersion,
        revision: 1,
        orphanedValuesJson: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as PluginConfigModel;
  }

  async deleteConfigsForPlugin(pluginId: string): Promise<void> {
    await this.db.delete(pluginConfigs).where(eq(pluginConfigs.pluginId, pluginId));
  }
}

export class SqlitePluginSecretRepository implements IPluginSecretRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async put(
    tenant: TenantContext,
    entry: { pluginId: string; fieldKey: string; value: unknown },
  ): Promise<void> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.getState(tenant, entry.pluginId, entry.fieldKey);
    if (existing.configured) {
      await this.db
        .update(pluginConfigSecrets)
        .set({ valueJson: entry.value, configured: 1, updatedAt: now })
        .where(
          and(
            eq(pluginConfigSecrets.workspaceId, tenant.workspaceId),
            eq(pluginConfigSecrets.subjectUserId, tenant.subjectUserId),
            eq(pluginConfigSecrets.pluginId, entry.pluginId),
            eq(pluginConfigSecrets.fieldKey, entry.fieldKey),
          ),
        );
      return;
    }
    await this.db
      .insert(pluginConfigSecrets)
      .values({
        id: `psec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        pluginId: entry.pluginId,
        fieldKey: entry.fieldKey,
        valueJson: entry.value,
        configured: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [pluginConfigSecrets.workspaceId, pluginConfigSecrets.subjectUserId, pluginConfigSecrets.pluginId, pluginConfigSecrets.fieldKey],
      });
  }

  async getState(
    tenant: TenantContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<{ configured: boolean }> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select({ configured: pluginConfigSecrets.configured })
      .from(pluginConfigSecrets)
      .where(
        and(
          eq(pluginConfigSecrets.workspaceId, tenant.workspaceId),
          eq(pluginConfigSecrets.subjectUserId, tenant.subjectUserId),
          eq(pluginConfigSecrets.pluginId, pluginId),
          eq(pluginConfigSecrets.fieldKey, fieldKey),
        ),
      )
      .limit(1);
    return { configured: found ? found.configured === 1 : false };
  }

  async listStates(
    tenant: TenantContext,
    pluginId: string,
  ): Promise<Array<{ fieldKey: string; configured: boolean }>> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select({ fieldKey: pluginConfigSecrets.fieldKey, configured: pluginConfigSecrets.configured })
      .from(pluginConfigSecrets)
      .where(
        and(
          eq(pluginConfigSecrets.workspaceId, tenant.workspaceId),
          eq(pluginConfigSecrets.subjectUserId, tenant.subjectUserId),
          eq(pluginConfigSecrets.pluginId, pluginId),
        ),
      );
    return rows.map((row) => ({ fieldKey: row.fieldKey, configured: row.configured === 1 }));
  }

  async delete(
    tenant: TenantContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<void> {
    assertTenantContext(tenant);
    await this.db
      .delete(pluginConfigSecrets)
      .where(
        and(
          eq(pluginConfigSecrets.workspaceId, tenant.workspaceId),
          eq(pluginConfigSecrets.subjectUserId, tenant.subjectUserId),
          eq(pluginConfigSecrets.pluginId, pluginId),
          eq(pluginConfigSecrets.fieldKey, fieldKey),
        ),
      );
  }

  async deleteAllForPlugin(pluginId: string): Promise<void> {
    await this.db.delete(pluginConfigSecrets).where(eq(pluginConfigSecrets.pluginId, pluginId));
  }
}

export class SqlitePluginPageRepository implements IPluginPageRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async upsertPage(page: {
    pluginId: string;
    pageId: string;
    title: unknown;
    description?: unknown;
    entry: string;
    capabilities: string[];
    checksum?: string | null;
  }): Promise<PluginPageModel> {
    const now = new Date().toISOString();
    const existing = await this.getPage(page.pluginId, page.pageId);
    if (existing) {
      const [updated] = await this.db
        .update(pluginPages)
        .set({
          title: page.title,
          description: page.description ?? null,
          entry: page.entry,
          capabilitiesJson: page.capabilities,
          checksum: page.checksum ?? null,
          updatedAt: now,
        })
        .where(eq(pluginPages.id, existing.id))
        .returning();
      return updated as PluginPageModel;
    }
    const [created] = await this.db
      .insert(pluginPages)
      .values({
        id: `ppage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        pluginId: page.pluginId,
        pageId: page.pageId,
        title: page.title,
        description: page.description ?? null,
        entry: page.entry,
        capabilitiesJson: page.capabilities,
        checksum: page.checksum ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as PluginPageModel;
  }

  async listPages(pluginId: string): Promise<PluginPageModel[]> {
    const rows = await this.db
      .select()
      .from(pluginPages)
      .where(eq(pluginPages.pluginId, pluginId))
      .orderBy(pluginPages.pageId);
    return rows as PluginPageModel[];
  }

  async getPage(pluginId: string, pageId: string): Promise<PluginPageModel | null> {
    const [found] = await this.db
      .select()
      .from(pluginPages)
      .where(and(eq(pluginPages.pluginId, pluginId), eq(pluginPages.pageId, pageId)))
      .limit(1);
    return (found as PluginPageModel) ?? null;
  }

  async deletePagesForPlugin(pluginId: string): Promise<void> {
    await this.db.delete(pluginPages).where(eq(pluginPages.pluginId, pluginId));
  }
}
