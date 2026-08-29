/**
 * Aervox｜思隅 @aervox/database — 内容/生态扩展域 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8（ExternalSource/Plugin/PluginGrant/CommunityContent/Organization）
 * P2/P3 扩展实体：先落表为后续生态/社区功能预留。
 */
import { eq, and, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  externalSources,
  plugins,
  pluginGrants,
  communityContents,
  organizations,
} from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IExtensionRepository,
  ExternalSourceModel,
  PluginModel,
  PluginGrantModel,
  CommunityContentModel,
  OrganizationModel,
} from "../types.js";

export class SqliteExtensionRepository implements IExtensionRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async createExternalSource(
    tenant: TenantContext,
    sourceData: { id: string; provider: string; externalId: string; permissionScope: string; syncState?: string },
  ): Promise<ExternalSourceModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(externalSources)
      .values({
        id: sourceData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        provider: sourceData.provider,
        externalId: sourceData.externalId,
        permissionScope: sourceData.permissionScope,
        syncState: sourceData.syncState ?? "idle",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as ExternalSourceModel;
  }

  async getExternalSource(tenant: TenantContext, id: string): Promise<ExternalSourceModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(externalSources)
      .where(
        and(
          eq(externalSources.id, id),
          eq(externalSources.workspaceId, tenant.workspaceId),
          eq(externalSources.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as ExternalSourceModel) ?? null;
  }

  async createPlugin(
    pluginData: {
      id: string;
      publisher: string;
      version: string;
      checksum: string;
      signature?: string | null;
      permissions?: unknown;
      installSource?: string;
      enabled?: number;
      configSchemaJson?: unknown;
      configSchemaVersion?: number;
    },
  ): Promise<PluginModel> {
    const now = new Date().toISOString();
    const existing = await this.getPlugin(pluginData.id);
    if (existing) {
      const [updated] = await this.db
        .update(plugins)
        .set({
          publisher: pluginData.publisher,
          version: pluginData.version,
          checksum: pluginData.checksum,
          signature: pluginData.signature ?? null,
          permissions: pluginData.permissions ?? null,
          installSource: pluginData.installSource ?? "registry",
          ...(pluginData.enabled !== undefined ? { enabled: pluginData.enabled } : {}),
          ...(pluginData.configSchemaJson !== undefined ? { configSchemaJson: pluginData.configSchemaJson } : {}),
          ...(pluginData.configSchemaVersion !== undefined ? { configSchemaVersion: pluginData.configSchemaVersion } : {}),
          updatedAt: now,
        })
        .where(eq(plugins.id, pluginData.id))
        .returning();
      return updated as PluginModel;
    }
    const [created] = await this.db
      .insert(plugins)
      .values({
        id: pluginData.id,
        publisher: pluginData.publisher,
        version: pluginData.version,
        checksum: pluginData.checksum,
        signature: pluginData.signature ?? null,
        permissions: pluginData.permissions ?? null,
        installSource: pluginData.installSource ?? "registry",
        enabled: pluginData.enabled ?? 1,
        configSchemaJson: pluginData.configSchemaJson ?? null,
        configSchemaVersion: pluginData.configSchemaVersion ?? 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as PluginModel;
  }

  async listPlugins(): Promise<PluginModel[]> {
    const rows = await this.db.select().from(plugins);
    return rows as PluginModel[];
  }

  async getPlugin(id: string): Promise<PluginModel | null> {
    const [found] = await this.db.select().from(plugins).where(eq(plugins.id, id)).limit(1);
    return (found as PluginModel) ?? null;
  }

  async setPluginConfigSchema(
    id: string,
    schema: unknown,
    schemaVersion: number,
  ): Promise<PluginModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(plugins)
      .set({ configSchemaJson: schema, configSchemaVersion: schemaVersion, updatedAt: now })
      .where(eq(plugins.id, id))
      .returning();
    return (updated as PluginModel) ?? null;
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<PluginModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(plugins)
      .set({ enabled: enabled ? 1 : 0, updatedAt: now })
      .where(eq(plugins.id, id))
      .returning();
    return (updated as PluginModel) ?? null;
  }

  async deletePlugin(id: string): Promise<boolean> {
    // plugin_grants 外键 ON DELETE CASCADE 连带清理授权
    const res = await this.db.delete(plugins).where(eq(plugins.id, id)).returning({ id: plugins.id });
    return res.length > 0;
  }

  async grantPlugin(
    tenant: TenantContext,
    grantData: { id: string; pluginId: string; permission: string; scope: string; grantedAt?: string },
  ): Promise<PluginGrantModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(pluginGrants)
      .values({
        id: grantData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        pluginId: grantData.pluginId,
        permission: grantData.permission,
        scope: grantData.scope,
        grantedAt: grantData.grantedAt ?? now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as PluginGrantModel;
  }

  async revokePluginGrant(tenant: TenantContext, id: string): Promise<PluginGrantModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(pluginGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(pluginGrants.id, id),
          eq(pluginGrants.workspaceId, tenant.workspaceId),
          eq(pluginGrants.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return (updated as PluginGrantModel) ?? null;
  }

  async hasPluginPermission(tenant: TenantContext, pluginId: string, permission: string): Promise<boolean> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.workspaceId, tenant.workspaceId),
          eq(pluginGrants.subjectUserId, tenant.subjectUserId),
          eq(pluginGrants.pluginId, pluginId),
          eq(pluginGrants.permission, permission),
          // 未撤销的授权视为有效（libsql file 后端读快照偶发滞后，沿用 sql IS NULL 既有约定）
          sql`${pluginGrants.revokedAt} IS NULL`,
        ),
      )
      .limit(1);
    return !!found;
  }

  async createCommunityContent(
    tenant: TenantContext,
    contentData: { id: string; authorId: string; type: string; status?: string; reviewState?: string; visibility?: string },
  ): Promise<CommunityContentModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(communityContents)
      .values({
        id: contentData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        authorId: contentData.authorId,
        type: contentData.type,
        status: contentData.status ?? "draft",
        reviewState: contentData.reviewState ?? "pending",
        visibility: contentData.visibility ?? "public",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as CommunityContentModel;
  }

  async getCommunityContent(tenant: TenantContext, id: string): Promise<CommunityContentModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(communityContents)
      .where(
        and(
          eq(communityContents.id, id),
          eq(communityContents.workspaceId, tenant.workspaceId),
          eq(communityContents.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as CommunityContentModel) ?? null;
  }

  async createOrganization(
    tenant: TenantContext,
    orgData: { id: string; ownerId: string; memberScope?: string; policyVersion: string },
  ): Promise<OrganizationModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(organizations)
      .values({
        id: orgData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        ownerId: orgData.ownerId,
        memberScope: orgData.memberScope ?? "institution",
        policyVersion: orgData.policyVersion,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as OrganizationModel;
  }

  async getOrganization(tenant: TenantContext, id: string): Promise<OrganizationModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.id, id),
          eq(organizations.workspaceId, tenant.workspaceId),
          eq(organizations.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as OrganizationModel) ?? null;
  }
}
