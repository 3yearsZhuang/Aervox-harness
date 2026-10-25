/**
 * Aervox｜思隅 @aervox/repositories — 插件 Config / Page SQLite 仓储实现（CAP-020 扩展 · CR-006）
 *
 * - 配置按 pluginId 在本地实例唯一，revision 做乐观 CAS；
 * - secret 值与配置分开存储，接口只暴露配置状态；生产应替换为加密 SecretStore Port；
 * - Page 元数据为系统级（生命周期归插件，启停/卸载联动由 API 层处理）。
 */
import { withSessionLock } from "../../session-lock.js";
import { DomainConflictError } from "../../errors.js";
import { pluginConfigAccessQuerySchema, pluginPageSchema, type PluginConfigAccessQuery, type PluginConfigSchemaResponse } from "@aervox/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  pluginConfigs,
  pluginConfigSecrets,
  pluginPages,
  plugins,
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

  private requirePageAccessIdentity(access: PluginConfigAccessQuery): PluginConfigAccessQuery {
    const parsed = pluginConfigAccessQuerySchema.safeParse(access);
    if (!parsed.success || !parsed.data.expectedLifecycleGeneration || !parsed.data.expectedPageId || !parsed.data.expectedPageGeneration) {
      throw new DomainConflictError("A captured Page and plugin identity are required");
    }
    return parsed.data;
  }

  private pageAccessColumns = {
    enabled: plugins.enabled, availability: plugins.availability, lifecycleGeneration: plugins.lifecycleGeneration,
    schemaVersion: plugins.configSchemaVersion, fields: plugins.configSchemaJson,
    pageGeneration: pluginPages.id, capabilities: pluginPages.capabilitiesJson,
  };

  private requirePageAccess(
    row: (Pick<typeof plugins.$inferSelect, "enabled" | "availability" | "lifecycleGeneration"> & {
      schemaVersion: number; fields: unknown; pageGeneration: string | null; capabilities: unknown;
    }) | undefined,
    access: PluginConfigAccessQuery,
    expectedSchema?: PluginConfigSchemaResponse,
  ): void {
    const capabilities = pluginPageSchema.shape.capabilities.safeParse(row?.capabilities);
    if (!row || row.enabled !== 1 || row.availability !== "available" || row.lifecycleGeneration !== access.expectedLifecycleGeneration
      || row.pageGeneration !== access.expectedPageGeneration || !capabilities.success || !capabilities.data.includes("config.read")
      || (expectedSchema !== undefined && (row.schemaVersion !== expectedSchema.schemaVersion
        || JSON.stringify(row.fields) !== JSON.stringify(expectedSchema.fields)))) {
      throw new DomainConflictError("Plugin or Page configuration access changed; reopen the page");
    }
  }

  async getConfig(ctx: LocalContext, pluginId: string, access?: PluginConfigAccessQuery, expectedSchema?: PluginConfigSchemaResponse): Promise<PluginConfigModel | null> {
    if (access !== undefined) {
      const captured = this.requirePageAccessIdentity(access);
      // The grant, schema, and optional configuration share one SQLite snapshot.
      // A missing configuration is distinct from a missing/revoked Page.
      const [row] = await this.db.select({ ...this.pageAccessColumns, config: pluginConfigs }).from(plugins)
        .leftJoin(pluginPages, and(eq(pluginPages.pluginId, plugins.id), eq(pluginPages.pageId, captured.expectedPageId!)))
        .leftJoin(pluginConfigs, eq(pluginConfigs.pluginId, plugins.id)).where(eq(plugins.id, pluginId)).limit(1);
      this.requirePageAccess(row, captured, expectedSchema);
      return (row?.config as PluginConfigModel | null) ?? null;
    }
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

  async assertPageConfigAccess(pluginId: string, access: PluginConfigAccessQuery, expectedSchema?: PluginConfigSchemaResponse): Promise<void> {
    const captured = this.requirePageAccessIdentity(access);
    const [row] = await this.db.select(this.pageAccessColumns).from(plugins)
      .leftJoin(pluginPages, and(eq(pluginPages.pluginId, plugins.id), eq(pluginPages.pageId, captured.expectedPageId!)))
      .where(eq(plugins.id, pluginId)).limit(1);
    this.requirePageAccess(row, captured, expectedSchema);
  }

  async saveConfig(
    ctx: LocalContext,
    input: PluginConfigSaveInput,
  ): Promise<{ saved: PluginConfigModel; conflict: false } | { saved: PluginConfigModel | null; conflict: true }> {
    return withSessionLock(`plugin-config:${input.pluginId}`, () => this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const [existing] = await tx.select().from(pluginConfigs).where(eq(pluginConfigs.pluginId, input.pluginId));
      if (input.expectedSchema == null || typeof input.expectedLifecycleGeneration !== "string" || !input.expectedLifecycleGeneration
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        return { saved: (existing as PluginConfigModel) ?? null, conflict: true as const };
      }
      const [plugin] = await tx.select({
        schema: plugins.configSchemaJson, schemaVersion: plugins.configSchemaVersion,
        enabled: plugins.enabled, availability: plugins.availability, generation: plugins.lifecycleGeneration,
      }).from(plugins).where(eq(plugins.id, input.pluginId));
      if (!plugin || plugin.enabled !== 1 || plugin.availability !== "available"
        || plugin.generation !== input.expectedLifecycleGeneration || plugin.schemaVersion !== input.schemaVersion
        || JSON.stringify(plugin.schema) !== JSON.stringify(input.expectedSchema)) {
        return { saved: (existing as PluginConfigModel) ?? null, conflict: true as const };
      }
      if (input.expectedPageId !== undefined || input.expectedPageGeneration !== undefined) {
        const expectedPageId = pluginPageSchema.shape.id.safeParse(input.expectedPageId);
        if (!expectedPageId.success
          || typeof input.expectedPageGeneration !== "string" || !input.expectedPageGeneration
          || input.expectedPageGeneration.length > 128) {
          return { saved: (existing as PluginConfigModel) ?? null, conflict: true as const };
        }
        // Page declarations can change without a plugin lifecycle rotation. Bind
        // this save to its actual Page in the same writer transaction as Secrets.
        const [page] = await tx.select({ generation: pluginPages.id, capabilities: pluginPages.capabilitiesJson }).from(pluginPages)
          .where(and(eq(pluginPages.pluginId, input.pluginId), eq(pluginPages.pageId, expectedPageId.data)));
        const capabilities = pluginPageSchema.shape.capabilities.safeParse(page?.capabilities);
        if (!page || page.generation !== input.expectedPageGeneration
          || !capabilities.success || !capabilities.data.includes("config.write")) {
          return { saved: (existing as PluginConfigModel) ?? null, conflict: true as const };
        }
      }
      if ((existing?.revision ?? 0) !== input.expectedRevision) {
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
    expectedSchema: unknown,
    expectedLifecycleGeneration: string,
    expectedRevision: number,
    pageIdentity?: Pick<PluginConfigAccessQuery, "expectedPageId" | "expectedPageGeneration">,
  ): Promise<PluginConfigModel> {
    return withSessionLock(`plugin-config:${pluginId}`, () => this.db.transaction(async (tx) => {
      if (expectedSchema == null || typeof expectedLifecycleGeneration !== "string" || !expectedLifecycleGeneration
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new DomainConflictError("Plugin configuration expectations are required before resetting");
      }
      const [plugin] = await tx.select({
        schema: plugins.configSchemaJson, schemaVersion: plugins.configSchemaVersion,
        enabled: plugins.enabled, availability: plugins.availability, generation: plugins.lifecycleGeneration,
      }).from(plugins).where(eq(plugins.id, pluginId));
      if (!plugin || plugin.enabled !== 1 || plugin.availability !== "available"
        || plugin.generation !== expectedLifecycleGeneration || plugin.schemaVersion !== schemaVersion
        || JSON.stringify(plugin.schema) !== JSON.stringify(expectedSchema)) {
        throw new DomainConflictError("Plugin configuration lifecycle or schema changed; reload before resetting");
      }
      if (pageIdentity !== undefined) {
        const captured = this.requirePageAccessIdentity({ ...pageIdentity, expectedLifecycleGeneration });
        const [page] = await tx.select({ generation: pluginPages.id, capabilities: pluginPages.capabilitiesJson }).from(pluginPages)
          .where(and(eq(pluginPages.pluginId, pluginId), eq(pluginPages.pageId, captured.expectedPageId!)));
        const capabilities = pluginPageSchema.shape.capabilities.safeParse(page?.capabilities);
        if (!page || page.generation !== captured.expectedPageGeneration || !capabilities.success || !capabilities.data.includes("config.write")) {
          throw new DomainConflictError("Page configuration write access changed; reopen the page");
        }
      }
      const [existing] = await tx.select({ revision: pluginConfigs.revision }).from(pluginConfigs).where(eq(pluginConfigs.pluginId, pluginId));
      if ((existing?.revision ?? 0) !== expectedRevision) {
        throw new DomainConflictError("Plugin configuration revision changed; reload before resetting");
      }
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
    // The internal primary key is the durable host-owned incarnation. One SQL
    // upsert rotates it even for an identical declaration, so a removed grant
    // cannot revive a previously opened Page when that grant is restored.
    const incarnation = `ppage_${crypto.randomUUID()}`;
    const metadata = {
      title: page.title,
      description: page.description ?? null,
      entry: page.entry,
      capabilitiesJson: page.capabilities,
      checksum: page.checksum ?? null,
      updatedAt: now,
    };
    const [saved] = await this.db
      .insert(pluginPages)
      .values({
        id: incarnation,
        pluginId: page.pluginId,
        pageId: page.pageId,
        ...metadata,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [pluginPages.pluginId, pluginPages.pageId],
        set: { id: incarnation, ...metadata },
      })
      .returning();
    return saved as PluginPageModel;
  }

  async updatePageChecksum(pluginId: string, pageId: string, expectedPageGeneration: string, checksum: string): Promise<PluginPageModel | null> {
    if (typeof expectedPageGeneration !== "string" || !expectedPageGeneration || expectedPageGeneration.length > 128) return null;
    // Files are written outside the SQL transaction. Only the incarnation that
    // authorized those writes may publish their checksum; a changed/deleted Page
    // must retain its current declaration and must never be recreated here.
    const [updated] = await this.db.update(pluginPages)
      .set({ id: `ppage_${crypto.randomUUID()}`, checksum, updatedAt: new Date().toISOString() })
      .where(and(eq(pluginPages.pluginId, pluginId), eq(pluginPages.pageId, pageId), eq(pluginPages.id, expectedPageGeneration)))
      .returning();
    return (updated as PluginPageModel) ?? null;
  }

  async listPages(pluginId: string, expectedLifecycleGeneration?: string): Promise<PluginPageModel[]> {
    if (expectedLifecycleGeneration !== undefined) {
      // One read snapshot binds the current Page grants to the enabled package
      // identity, including the empty-Page case. No configuration or Secret is read.
      const rows = await this.db.select({ page: pluginPages }).from(plugins)
        .leftJoin(pluginPages, eq(pluginPages.pluginId, plugins.id))
        .where(and(eq(plugins.id, pluginId), eq(plugins.enabled, 1),
          eq(plugins.availability, "available"), eq(plugins.lifecycleGeneration, expectedLifecycleGeneration)))
        .orderBy(pluginPages.pageId);
      if (!expectedLifecycleGeneration || !rows.length) throw new DomainConflictError("plugin lifecycle changed; reopen the page");
      return rows.flatMap(row => row.page ? [row.page as PluginPageModel] : []);
    }
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
