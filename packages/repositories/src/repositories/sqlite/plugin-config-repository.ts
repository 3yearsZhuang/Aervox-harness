/**
 * Aervox｜思隅 @aervox/repositories — 插件 Config / Page SQLite 仓储实现（CAP-020 扩展 · CR-006）
 *
 * - 配置按 pluginId 在本地实例唯一，revision 做乐观 CAS；
 * - secret 值与配置分开存储，接口只暴露配置状态；生产应替换为加密 SecretStore Port；
 * - Page 元数据为系统级（生命周期归插件，启停/卸载联动由 API 层处理）。
 */
import { withSessionLock } from "../../session-lock.js";
import { and, eq, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  pluginConfigs,
  pluginConfigSecrets,
  pluginPages,
} from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";
import type {
  IPluginConfigRepository,
  IPluginPageRepository,
  IPluginSecretRepository,
  PluginConfigModel,
  PluginConfigSaveInput,
  PluginPageModel,
  PluginSecretModel,
} from "../types/index.js";

export class SqlitePluginConfigRepository implements IPluginConfigRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async getConfig(ctx: LocalContext, pluginId: string): Promise<PluginConfigModel | null> {
    const [found] = await this.db
      .select()
      .from(pluginConfigs)
      .where(
        and(
          eq(pluginConfigs.pluginId, pluginId),
        ),
      )
      .limit(1);
    return (found as PluginConfigModel) ?? null;
  }

  async saveConfig(
    ctx: LocalContext,
    input: PluginConfigSaveInput,
  ): Promise<{ saved: PluginConfigModel; conflict: false } | { saved: PluginConfigModel | null; conflict: true }> {
    return withSessionLock(`plugin-config:${input.pluginId}`, () => this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const [existing] = await tx.select().from(pluginConfigs).where(eq(pluginConfigs.pluginId, input.pluginId));
      if (input.expectedRevision >= 0 && (existing?.revision ?? 0) !== input.expectedRevision) {
        return { saved: (existing as PluginConfigModel) ?? null, conflict: true as const };
      }
      // The revision check and all credential writes share the same writer transaction.
      for (const [fieldKey, value] of Object.entries(input.secretChanges ?? {})) {
        if (value === null) {
          await tx.delete(pluginConfigSecrets).where(and(
            eq(pluginConfigSecrets.pluginId, input.pluginId), eq(pluginConfigSecrets.fieldKey, fieldKey),
          ));
        } else {
          await tx.insert(pluginConfigSecrets).values({
            id: `psec_${crypto.randomUUID()}`, pluginId: input.pluginId, fieldKey,
            valueJson: value, configured: 1, createdAt: now, updatedAt: now,
          }).onConflictDoUpdate({
            target: [pluginConfigSecrets.pluginId, pluginConfigSecrets.fieldKey],
            set: { valueJson: value, configured: 1, updatedAt: now },
          });
        }
      }
      const secretKeys = input.secretChanges === undefined ? input.secretKeys
        : (await tx.select({ fieldKey: pluginConfigSecrets.fieldKey }).from(pluginConfigSecrets)
          .where(and(eq(pluginConfigSecrets.pluginId, input.pluginId), eq(pluginConfigSecrets.configured, 1))))
          .map((row) => row.fieldKey);
      const values = {
        valuesJson: input.values, secretKeysJson: secretKeys, schemaVersion: input.schemaVersion,
        revision: (existing?.revision ?? 0) + 1, orphanedValuesJson: input.orphanedValues ?? null, updatedAt: now,
      };
      if (existing) {
        const [updated] = await tx.update(pluginConfigs).set(values).where(and(
          eq(pluginConfigs.id, existing.id), eq(pluginConfigs.revision, existing.revision),
        )).returning();
        if (!updated) throw new Error("plugin_config_revision_conflict");
        return { saved: updated as PluginConfigModel, conflict: false as const };
      }
      const [created] = await tx.insert(pluginConfigs).values({
        id: `pcfg_${crypto.randomUUID()}`, pluginId: input.pluginId, createdAt: now, ...values,
      }).returning();
      return { saved: created as PluginConfigModel, conflict: false as const };
    }));
  }

  async resetConfig(
    ctx: LocalContext,
    pluginId: string,
    schemaVersion: number,
    defaults: Record<string, unknown>,
  ): Promise<PluginConfigModel> {
    return withSessionLock(`plugin-config:${pluginId}`, () => this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      await tx.delete(pluginConfigSecrets).where(eq(pluginConfigSecrets.pluginId, pluginId));
      const [saved] = await tx.insert(pluginConfigs).values({
        id: `pcfg_${crypto.randomUUID()}`, pluginId, valuesJson: defaults,
        secretKeysJson: [], schemaVersion, revision: 1, orphanedValuesJson: null,
        createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: pluginConfigs.pluginId,
        set: { valuesJson: defaults, secretKeysJson: [], schemaVersion,
          revision: sql`${pluginConfigs.revision} + 1`, orphanedValuesJson: null, updatedAt: now },
      }).returning();
      return saved as PluginConfigModel;
    }));
  }

  async deleteConfigsForPlugin(pluginId: string): Promise<void> {
    await this.db.delete(pluginConfigs).where(eq(pluginConfigs.pluginId, pluginId));
  }
}

export class SqlitePluginSecretRepository implements IPluginSecretRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async put(
    ctx: LocalContext,
    entry: { pluginId: string; fieldKey: string; value: unknown },
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.getState(ctx, entry.pluginId, entry.fieldKey);
    if (existing.configured) {
      await this.db
        .update(pluginConfigSecrets)
        .set({ valueJson: entry.value, configured: 1, updatedAt: now })
        .where(
          and(
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
        pluginId: entry.pluginId,
        fieldKey: entry.fieldKey,
        valueJson: entry.value,
        configured: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [pluginConfigSecrets.pluginId, pluginConfigSecrets.fieldKey],
      });
  }

  async getState(
    ctx: LocalContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<{ configured: boolean }> {
    const [found] = await this.db
      .select({ configured: pluginConfigSecrets.configured })
      .from(pluginConfigSecrets)
      .where(
        and(
          eq(pluginConfigSecrets.pluginId, pluginId),
          eq(pluginConfigSecrets.fieldKey, fieldKey),
        ),
      )
      .limit(1);
    return { configured: found ? found.configured === 1 : false };
  }

  async listStates(
    ctx: LocalContext,
    pluginId: string,
  ): Promise<Array<{ fieldKey: string; configured: boolean }>> {
    const rows = await this.db
      .select({ fieldKey: pluginConfigSecrets.fieldKey, configured: pluginConfigSecrets.configured })
      .from(pluginConfigSecrets)
      .where(
        and(
          eq(pluginConfigSecrets.pluginId, pluginId),
        ),
      );
    return rows.map((row) => ({ fieldKey: row.fieldKey, configured: row.configured === 1 }));
  }

  async delete(
    ctx: LocalContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<void> {
    await this.db
      .delete(pluginConfigSecrets)
      .where(
        and(
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
