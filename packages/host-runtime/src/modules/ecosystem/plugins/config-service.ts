/**
 * Aervox｜思隅 @aervox/api — 插件 Config / Page 服务（CAP-020 扩展 · CR-006）
 *
 * 职责：
 * - 登记/读取插件配置 Schema（系统级，随 Bundle 注册）；
 * - 按 (workspaceId, subjectUserId, pluginId) 读写配置，secret 只保存状态、永不回显；
 * - revision CAS 防并发覆盖；Schema 升级补默认值并隔离 orphaned 值；
 * - Page 元数据 + 本地 Bundle 静态资源（路径安全 + checksum）；
 * - 配置读写/重置/Page 打开等操作写入 AuditRecord。
 */
import type {
  IPluginConfigRepository,
  IPluginPageRepository,
  IPluginSecretRepository,
  IPlatformRepository,
  PluginModel,
  LocalContext,
} from "@aervox/repositories";
import { DomainConflictError, SqliteExtensionRepository, withSessionLock } from "@aervox/repositories";
import { pluginPageSchema, pluginPageGenerationSchema, type SavePluginConfigRequest } from "@aervox/contracts";
import crypto from "node:crypto";
import { PluginBundleStore } from "./bundle-store.js";
import {
  applyDefaults,
  diffSchema,
  parseConfigSchema,
  validateValues,
  type ConfigIssue,
} from "./config-schema.js";
import {
  type ServerPluginRegistry,
  defaultServerPluginRegistry,
} from "./turn-plugins/registry.js";

export interface PluginConfigServiceSnapshot {
  pluginId: string;
  revision: number;
  schemaVersion: number;
  values: Record<string, unknown>;
  secretFields: Record<string, { configured: boolean }>;
  orphanedValues: Record<string, unknown>;
  issues: ConfigIssue[];
}

export class PluginConfigError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: ConfigIssue[],
  ) {
    super(message);
  }
}

export interface PluginConfigServiceDeps {
  extensionRepo: SqliteExtensionRepository;
  configRepo: IPluginConfigRepository;
  secretRepo: IPluginSecretRepository;
  pageRepo: IPluginPageRepository;
  auditRepo: IPlatformRepository;
  bundleStore: PluginBundleStore;
  pluginRegistry?: ServerPluginRegistry;
}

export class PluginConfigService {
  constructor(private readonly deps: PluginConfigServiceDeps) {}

  private buildSecretFields(
    fields: Parameters<typeof validateValues>[0],
    states: Array<{ fieldKey: string; configured: boolean }>,
  ): Record<string, { configured: boolean }> {
    const map = new Map(states.map((s) => [s.fieldKey, s.configured]));
    const out: Record<string, { configured: boolean }> = {};
    for (const field of fields) {
      if (field.type === "secret") out[field.key] = { configured: map.get(field.key) ?? false };
    }
    return out;
  }

  private async findPlugin(pluginId: string): Promise<{ plugin: PluginModel; resolvedId: string } | null> {
    let plugin = await this.deps.extensionRepo.getPlugin(pluginId);
    if (plugin) return { plugin, resolvedId: pluginId };

    const registry = this.deps.pluginRegistry ?? defaultServerPluginRegistry;
    const candidateIds = registry.getAllAliases(pluginId);
    for (const cid of candidateIds) {
      if (cid === pluginId) continue;
      plugin = await this.deps.extensionRepo.getPlugin(cid);
      if (plugin) return { plugin, resolvedId: cid };
    }
    return null;
  }

  private requireMutableBundle(plugin: PluginModel): void {
    if (plugin.bundleGeneration) throw new PluginConfigError(409, "PLUGIN_PACKAGE_IMMUTABLE", "Repackage and install a new version to change package declarations or resources");
  }

  private requireConfigLifecycle(pluginId: string, plugin: PluginModel, expectedLifecycleGeneration?: string): void {
    if (plugin.enabled !== 1) throw new PluginConfigError(409, "PLUGIN_DISABLED", `plugin disabled: ${pluginId}`);
    if ((plugin.availability ?? "available") !== "available") {
      throw new PluginConfigError(409, "PLUGIN_UNAVAILABLE", `plugin unavailable: ${pluginId}`);
    }
    if (!plugin.lifecycleGeneration || (expectedLifecycleGeneration !== undefined
      && plugin.lifecycleGeneration !== expectedLifecycleGeneration)) {
      throw new PluginConfigError(409, "PLUGIN_CONFIG_REVISION_CONFLICT", "plugin lifecycle changed; reopen the page");
    }
  }

  private async requirePlugin(pluginId: string): Promise<PluginModel> {
    const found = await this.findPlugin(pluginId);
    if (!found) throw new PluginConfigError(404, "PLUGIN_NOT_FOUND", `plugin not found: ${pluginId}`);
    if (found.plugin.enabled !== 1) {
      throw new PluginConfigError(409, "PLUGIN_DISABLED", `plugin disabled: ${pluginId}`);
    }
    return found.plugin;
  }

  private async audit(
    tenant: LocalContext,
    action: string,
    pluginId: string,
    metadata?: unknown,
  ): Promise<void> {
    await this.deps.auditRepo.createAuditRecord(tenant, {
      id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      actorType: "user",
      actorId: tenant.actorId ?? tenant.subjectUserId,
      action,
      subjectType: "plugin",
      subjectId: pluginId,
      metadata: metadata ?? null,
    });
  }

  // ── Schema ──────────────────────────────────────────────

  async registerConfigSchema(pluginId: string, input: unknown): Promise<unknown> {
    return withSessionLock(`plugin-config:${pluginId}`, async () => {
    const found = await this.findPlugin(pluginId);
    if (!found) throw new PluginConfigError(404, "PLUGIN_NOT_FOUND", `plugin not found: ${pluginId}`);
    const { plugin, resolvedId } = found;
    this.requireMutableBundle(plugin);
    let fields: ReturnType<typeof parseConfigSchema>;
    try {
      fields = parseConfigSchema(input);
    } catch (error) {
      throw new PluginConfigError(
        400,
        "INVALID_CONFIG_SCHEMA",
        error instanceof Error ? error.message : "invalid config schema",
      );
    }
    const updated = await this.deps.extensionRepo.setPluginConfigSchema(
      resolvedId,
      fields,
      plugin.configSchemaVersion ?? 1,
    );
    if (!updated) throw new PluginConfigError(404, "PLUGIN_NOT_FOUND", `plugin not found: ${pluginId}`);
    return { schemaVersion: plugin.configSchemaVersion ?? 1, fields };
    });
  }

  async getConfigSchema(pluginId: string): Promise<{ schemaVersion: number; fields: unknown[] }> {
    const found = await this.findPlugin(pluginId);
    if (!found) throw new PluginConfigError(404, "PLUGIN_NOT_FOUND", `plugin not found: ${pluginId}`);
    const { plugin } = found;
    if (!plugin.configSchemaJson) {
      throw new PluginConfigError(404, "PLUGIN_CONFIG_SCHEMA_NOT_FOUND", "plugin has no config schema");
    }
    return {
      schemaVersion: plugin.configSchemaVersion ?? 1,
      fields: plugin.configSchemaJson as unknown[],
    };
  }

  // ── 配置 ──────────────────────────────────────────────

  async getConfig(tenant: LocalContext, pluginId: string, expectedLifecycleGeneration?: string): Promise<PluginConfigServiceSnapshot> {
    const found = await this.findPlugin(pluginId);
    if (!found) throw new PluginConfigError(404, "PLUGIN_NOT_FOUND", `plugin not found: ${pluginId}`);
    if (found.plugin.enabled !== 1) {
      throw new PluginConfigError(409, "PLUGIN_DISABLED", `plugin disabled: ${pluginId}`);
    }
    if (expectedLifecycleGeneration !== undefined) this.requireConfigLifecycle(pluginId, found.plugin, expectedLifecycleGeneration);
    const targetId = found.resolvedId;
    const schema = await this.getConfigSchema(targetId);
    let stored = await this.deps.configRepo.getConfig(tenant, targetId);
    if (!stored && targetId !== pluginId) {
      stored = await this.deps.configRepo.getConfig(tenant, pluginId);
    }
    const secretStates = await this.deps.secretRepo.listStates(tenant, targetId);
    const fields = schema.fields as Parameters<typeof validateValues>[0];
    const values = stored?.valuesJson as Record<string, unknown> | undefined;
    const { defaults } = diffSchema(fields, (values ?? {}) as Record<string, unknown>);
    if (expectedLifecycleGeneration !== undefined) {
      // A Page read can outlive disable/re-enable while awaiting configuration or Secret state.
      // Recheck the captured identity before releasing its response to the old document session.
      const current = await this.deps.extensionRepo.getPlugin(targetId);
      if (!current) throw new PluginConfigError(409, "PLUGIN_CONFIG_REVISION_CONFLICT", "plugin lifecycle changed; reopen the page");
      this.requireConfigLifecycle(pluginId, current, expectedLifecycleGeneration);
    }
    return {
      pluginId,
      revision: stored?.revision ?? 0,
      schemaVersion: schema.schemaVersion,
      values: defaults,
      secretFields: this.buildSecretFields(fields, secretStates),
      orphanedValues: (stored?.orphanedValuesJson as Record<string, unknown>) ?? {},
      issues: [],
    };
  }

  async saveConfig(
    tenant: LocalContext,
    pluginId: string,
    body: SavePluginConfigRequest,
  ): Promise<PluginConfigServiceSnapshot> {
    if ((body.expectedPageId !== undefined || body.expectedPageGeneration !== undefined)
      && (!pluginPageSchema.shape.id.safeParse(body.expectedPageId).success
        || !pluginPageGenerationSchema.safeParse(body.expectedPageGeneration).success || !body.expectedLifecycleGeneration)) {
      throw new PluginConfigError(400, "INVALID_CONFIG", "Page writes require a valid Page id and captured Page and plugin generations");
    }
    const found = await this.findPlugin(pluginId);
    if (!found) throw new PluginConfigError(404, "PLUGIN_NOT_FOUND", `plugin not found: ${pluginId}`);
    this.requireConfigLifecycle(pluginId, found.plugin, body.expectedLifecycleGeneration);
    const targetId = found.resolvedId;
    const schema = await this.getConfigSchema(targetId);
    const fields = schema.fields as Parameters<typeof validateValues>[0];
    let stored = await this.deps.configRepo.getConfig(tenant, targetId);
    if (!stored && targetId !== pluginId) {
      stored = await this.deps.configRepo.getConfig(tenant, pluginId);
    }

    // 合并当前值（缺省字段保留原值）
    const previous = stored?.valuesJson as Record<string, unknown> | undefined;
    const merged = { ...(previous ?? applyDefaults(fields)), ...(body.values ?? {}) };
    const { issues, values } = validateValues(fields, merged);
    if (issues.length > 0) {
      throw new PluginConfigError(400, "INVALID_CONFIG", "config validation failed", issues);
    }

    // Pass only schema-declared operations to the same-database config transaction.
    const secretChanges: Record<string, string | null> = {};
    for (const field of fields) {
      if (field.type !== "secret") continue;
      const op = body.secretValues?.[field.key];
      if (op === null || typeof op === "string") secretChanges[field.key] = op;
    }

    const { saved, conflict } = await this.deps.configRepo.saveConfig(tenant, {
      pluginId: targetId,
      schemaVersion: schema.schemaVersion,
      expectedRevision: body.revision,
      expectedSchema: schema.fields,
      expectedLifecycleGeneration: found.plugin.lifecycleGeneration,
      expectedPageId: body.expectedPageId,
      expectedPageGeneration: body.expectedPageGeneration,
      values,
      secretKeys: [],
      secretChanges,
      orphanedValues: stored?.orphanedValuesJson as Record<string, unknown> | undefined,
    });
    if (conflict) {
      throw new PluginConfigError(409, "PLUGIN_CONFIG_REVISION_CONFLICT", "config revision conflict");
    }
    await this.audit(tenant, "plugin.config.save", pluginId, { revision: saved.revision });
    return {
      pluginId,
      revision: saved.revision,
      schemaVersion: saved.schemaVersion,
      values: saved.valuesJson as Record<string, unknown>,
      secretFields: this.buildSecretFields(fields, saved.secretKeysJson.map((fieldKey) => ({ fieldKey, configured: true }))),
      orphanedValues: (saved.orphanedValuesJson as Record<string, unknown>) ?? {},
      issues: [],
    };
  }

  async resetConfig(tenant: LocalContext, pluginId: string, expectedLifecycleGeneration?: string): Promise<PluginConfigServiceSnapshot> {
    const found = await this.findPlugin(pluginId);
    if (!found) throw new PluginConfigError(404, "PLUGIN_NOT_FOUND", `plugin not found: ${pluginId}`);
    this.requireConfigLifecycle(pluginId, found.plugin, expectedLifecycleGeneration);
    const targetId = found.resolvedId;
    const schema = await this.getConfigSchema(targetId);
    const fields = schema.fields as Parameters<typeof validateValues>[0];
    const defaults = applyDefaults(fields);
    const stored = await this.deps.configRepo.getConfig(tenant, targetId);
    const saved = await this.deps.configRepo.resetConfig(tenant, targetId, schema.schemaVersion, defaults, schema.fields,
      found.plugin.lifecycleGeneration, stored?.revision ?? 0)
      .catch((error: unknown) => {
        if (error instanceof DomainConflictError) throw new PluginConfigError(409, "PLUGIN_CONFIG_REVISION_CONFLICT", error.message);
        throw error;
      });
    await this.audit(tenant, "plugin.config.reset", pluginId, { revision: saved.revision });
    return {
      pluginId,
      revision: saved.revision,
      schemaVersion: saved.schemaVersion,
      values: saved.valuesJson as Record<string, unknown>,
      secretFields: this.buildSecretFields(fields, []),
      orphanedValues: {},
      issues: [],
    };
  }

  // ── Page ──────────────────────────────────────────────

  async registerPage(pluginId: string, input: unknown): Promise<unknown> {
    return withSessionLock(`plugin-config:${pluginId}`, async () => {
    this.requireMutableBundle(await this.requirePlugin(pluginId));
    const parsed = pluginPageSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new PluginConfigError(400, "INVALID_PAGE", first ? `${first.path.join(".")}: ${first.message}` : "invalid page");
    }
    const page = parsed.data;
    if (!page.entry.startsWith(`pages/${page.id}/`)) {
      throw new PluginConfigError(400, "INVALID_PAGE", `entry must start with pages/${page.id}/`);
    }
    const saved = await this.deps.pageRepo.upsertPage({
      pluginId,
      pageId: page.id,
      title: page.title,
      description: page.description,
      entry: page.entry,
      capabilities: page.capabilities,
      checksum: page.checksum ?? null,
    });
    return {
      id: saved.pageId,
      pageGeneration: saved.id,
      title: saved.title,
      description: saved.description,
      entry: saved.entry,
      capabilities: saved.capabilitiesJson,
      checksum: saved.checksum,
    };
    });
  }

  async listPages(pluginId: string, expectedLifecycleGeneration?: string): Promise<unknown[]> {
    await this.requirePlugin(pluginId);
    let rows;
    try {
      rows = await this.deps.pageRepo.listPages(pluginId, expectedLifecycleGeneration);
    } catch (error) {
      if (error instanceof DomainConflictError) throw new PluginConfigError(409, "PLUGIN_CONFIG_REVISION_CONFLICT", "plugin lifecycle changed; reopen the page");
      throw error;
    }
    return rows.map((row) => ({
      id: row.pageId,
      pageGeneration: row.id,
      title: row.title,
      description: row.description,
      entry: row.entry,
      capabilities: row.capabilitiesJson,
      checksum: row.checksum,
    }));
  }

  async getPage(pluginId: string, pageId: string): Promise<unknown> {
    await this.requirePlugin(pluginId);
    const page = await this.deps.pageRepo.getPage(pluginId, pageId);
    if (!page) throw new PluginConfigError(404, "PLUGIN_PAGE_NOT_FOUND", `page not found: ${pageId}`);
    return {
      id: page.pageId,
      pageGeneration: page.id,
      title: page.title,
      description: page.description,
      entry: page.entry,
      capabilities: page.capabilitiesJson,
      checksum: page.checksum,
    };
  }

  async writePageAssets(
    pluginId: string,
    pageId: string,
    files: Array<{ path: string; contentBase64: string }>,
  ): Promise<{ checksum: string }> {
    return withSessionLock(`plugin-config:${pluginId}`, async () => {
    this.requireMutableBundle(await this.requirePlugin(pluginId));
    const page = await this.deps.pageRepo.getPage(pluginId, pageId);
    if (!page) throw new PluginConfigError(404, "PLUGIN_PAGE_NOT_FOUND", `page not found: ${pageId}`);

    const hashes: string[] = [];
    for (const file of files) {
      let buffer: Buffer;
      try {
        buffer = Buffer.from(file.contentBase64, "base64");
      } catch {
        throw new PluginConfigError(400, "INVALID_ASSET_CONTENT", `invalid base64 for ${file.path}`);
      }
      if (buffer.length > 5 * 1024 * 1024) {
        throw new PluginConfigError(400, "ASSET_TOO_LARGE", `asset too large: ${file.path}`);
      }
      const hash = await this.deps.bundleStore.writeAsset(pluginId, pageId, file.path, buffer);
      hashes.push(`${file.path}:${hash}`);
    }
    const checksum = crypto.createHash("sha256").update(hashes.sort().join("|")).digest("hex");
    // Files are written outside the database transaction. Do not let stale
    // metadata restore a revoked declaration or recreate a deleted Page.
    const updated = await this.deps.pageRepo.updatePageChecksum(pluginId, pageId, page.id, checksum);
    if (!updated) throw new PluginConfigError(409, "PLUGIN_PAGE_REVISION_CONFLICT", "Page changed during resource upload; reload before uploading again");
    return { checksum };
    });
  }

  /** 读取 Page 入口 HTML（Bridge SDK 注入由渲染端完成） */
  async readPageEntry(
    pluginId: string,
    pageId: string,
  ): Promise<{ content: Buffer; mime: string }> {
    await this.requirePlugin(pluginId);
    const page = await this.deps.pageRepo.getPage(pluginId, pageId);
    if (!page) throw new PluginConfigError(404, "PLUGIN_PAGE_NOT_FOUND", `page not found: ${pageId}`);
    const rel = this.deps.bundleStore.entryToPageRelative(pluginId, pageId, page.entry);
    return this.deps.bundleStore.readAsset(pluginId, pageId, rel);
  }

  /** 读取 Page 内静态资源（相对 Page 根） */
  async readPageAsset(
    pluginId: string,
    pageId: string,
    relPath: string,
  ): Promise<{ content: Buffer; mime: string }> {
    await this.requirePlugin(pluginId);
    if (!await this.deps.pageRepo.getPage(pluginId, pageId)) {
      throw new PluginConfigError(404, "PLUGIN_PAGE_NOT_FOUND", `page not found: ${pageId}`);
    }
    return this.deps.bundleStore.readAsset(pluginId, pageId, relPath);
  }

  /** 供卸载钩子调用：清理配置/secret/Page 元数据与 Bundle 目录 */
  async cleanupPlugin(pluginId: string): Promise<void> {
    await this.deps.configRepo.deleteConfigsForPlugin(pluginId);
    await this.deps.secretRepo.deleteAllForPlugin(pluginId);
    const pages = await this.deps.pageRepo.listPages(pluginId);
    for (const page of pages) {
      await this.deps.bundleStore.deletePage(pluginId, page.pageId).catch(() => undefined);
    }
    await this.deps.pageRepo.deletePagesForPlugin(pluginId);
    await this.deps.bundleStore.deletePluginResources(pluginId);
  }
}
