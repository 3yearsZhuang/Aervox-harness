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
  TenantContext,
} from "@aervox/database";
import { SqliteExtensionRepository } from "@aervox/database";
import { pluginPageSchema } from "@aervox/contracts";
import crypto from "node:crypto";
import { PluginBundleStore } from "./bundle-store.js";
import {
  applyDefaults,
  diffSchema,
  parseConfigSchema,
  validateValues,
  type ConfigIssue,
} from "./config-schema.js";

export interface PluginConfigSnapshot {
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

  private async requirePlugin(pluginId: string): Promise<PluginModel> {
    const plugin = await this.deps.extensionRepo.getPlugin(pluginId);
    if (!plugin) throw new PluginConfigError(404, "PLUGIN_NOT_FOUND", `plugin not found: ${pluginId}`);
    if (plugin.enabled !== 1) {
      throw new PluginConfigError(409, "PLUGIN_DISABLED", `plugin disabled: ${pluginId}`);
    }
    return plugin;
  }

  private async audit(
    tenant: TenantContext,
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
    const plugin = await this.requirePlugin(pluginId);
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
      pluginId,
      fields,
      plugin.configSchemaVersion ?? 1,
    );
    if (!updated) throw new PluginConfigError(404, "PLUGIN_NOT_FOUND", `plugin not found: ${pluginId}`);
    return { schemaVersion: plugin.configSchemaVersion ?? 1, fields };
  }

  async getConfigSchema(pluginId: string): Promise<{ schemaVersion: number; fields: unknown[] }> {
    const plugin = await this.requirePlugin(pluginId);
    if (!plugin.configSchemaJson) {
      throw new PluginConfigError(404, "PLUGIN_CONFIG_SCHEMA_NOT_FOUND", "plugin has no config schema");
    }
    return {
      schemaVersion: plugin.configSchemaVersion ?? 1,
      fields: plugin.configSchemaJson as unknown[],
    };
  }

  // ── 配置 ──────────────────────────────────────────────

  async getConfig(tenant: TenantContext, pluginId: string): Promise<PluginConfigSnapshot> {
    await this.requirePlugin(pluginId);
    const schema = await this.getConfigSchema(pluginId);
    const stored = await this.deps.configRepo.getConfig(tenant, pluginId);
    const secretStates = await this.deps.secretRepo.listStates(tenant, pluginId);
    const fields = schema.fields as Parameters<typeof validateValues>[0];
    const values = stored?.valuesJson as Record<string, unknown> | undefined;
    const { defaults } = diffSchema(fields, (values ?? {}) as Record<string, unknown>);
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
    tenant: TenantContext,
    pluginId: string,
    body: { revision: number; values?: Record<string, unknown>; secretValues?: Record<string, string | null> },
  ): Promise<PluginConfigSnapshot> {
    await this.requirePlugin(pluginId);
    const schema = await this.getConfigSchema(pluginId);
    const fields = schema.fields as Parameters<typeof validateValues>[0];
    const stored = await this.deps.configRepo.getConfig(tenant, pluginId);

    // 合并当前值（缺省字段保留原值）
    const previous = stored?.valuesJson as Record<string, unknown> | undefined;
    const merged = { ...(previous ?? applyDefaults(fields)), ...(body.values ?? {}) };
    const { issues, values } = validateValues(fields, merged);
    if (issues.length > 0) {
      throw new PluginConfigError(400, "INVALID_CONFIG", "config validation failed", issues);
    }

    // secret 操作：null=清除，string=写入，缺省=保持
    for (const field of fields) {
      if (field.type !== "secret") continue;
      const op = body.secretValues?.[field.key];
      if (op === null) {
        await this.deps.secretRepo.delete(tenant, pluginId, field.key);
      } else if (typeof op === "string") {
        await this.deps.secretRepo.put(tenant, { pluginId, fieldKey: field.key, value: op });
      }
    }
    const secretStates = await this.deps.secretRepo.listStates(tenant, pluginId);
    const secretKeys = secretStates.map((s) => s.fieldKey);
    const secretFields = this.buildSecretFields(fields, secretStates);

    const { saved, conflict } = await this.deps.configRepo.saveConfig(tenant, {
      pluginId,
      schemaVersion: schema.schemaVersion,
      expectedRevision: body.revision,
      values,
      secretKeys,
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
      secretFields,
      orphanedValues: (saved.orphanedValuesJson as Record<string, unknown>) ?? {},
      issues: [],
    };
  }

  async resetConfig(tenant: TenantContext, pluginId: string): Promise<PluginConfigSnapshot> {
    await this.requirePlugin(pluginId);
    const schema = await this.getConfigSchema(pluginId);
    const fields = schema.fields as Parameters<typeof validateValues>[0];
    const defaults = applyDefaults(fields);
    await this.deps.secretRepo.deleteAllForPlugin(pluginId);
    const saved = await this.deps.configRepo.resetConfig(tenant, pluginId, schema.schemaVersion, defaults);
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
    await this.requirePlugin(pluginId);
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
      title: saved.title,
      description: saved.description,
      entry: saved.entry,
      capabilities: saved.capabilitiesJson,
      checksum: saved.checksum,
    };
  }

  async listPages(pluginId: string): Promise<unknown[]> {
    await this.requirePlugin(pluginId);
    const rows = await this.deps.pageRepo.listPages(pluginId);
    return rows.map((row) => ({
      id: row.pageId,
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
    await this.requirePlugin(pluginId);
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
    await this.deps.pageRepo.upsertPage({
      pluginId,
      pageId,
      title: page.title,
      description: page.description ?? undefined,
      entry: page.entry,
      capabilities: page.capabilitiesJson,
      checksum,
    });
    return { checksum };
  }

  /** 读取 Page 入口 HTML（Bridge SDK 注入由渲染端完成） */
  async readPageEntry(
    pluginId: string,
    pageId: string,
  ): Promise<{ content: Buffer; mime: string }> {
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
  }
}
