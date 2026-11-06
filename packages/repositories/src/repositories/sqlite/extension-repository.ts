/**
 * Aervox｜思隅 @aervox/repositories — 内容/生态扩展域 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8（ExternalSource/Plugin/PluginGrant/CommunityContent/Organization）
 * P2/P3 扩展实体：先落表为后续生态/社区功能预留。
 */
import { eq, and, sql, type SQLWrapper } from "drizzle-orm";
import { jsonEach, jsonText, randomGeneration, textHex } from "../../sql-dialect.js";
import type { AervoxDatabase } from "../../client.js";
import {
  externalSources,
  plugins,
  pluginGrants,
  toolRegistrations,
  communityContents,
  organizations,
} from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";
import type {
  IExtensionRepository,
  ExternalSourceModel,
  PluginModel,
  PluginGrantModel,
  CommunityContentModel,
  OrganizationModel,
  PluginToolPermitReaderPort,
  PluginToolPermitSnapshot,
} from "../types/index.js";

const MAX_PERMIT_GRANTS = 256;
const integerText = (column: SQLWrapper) => sql<string | null>`CAST(${column} AS TEXT)`;
function permitText(hex: string | null, nullable = false): string | null {
  if (hex === null && nullable) return null;
  if (typeof hex !== "string" || hex.length > 131072 || !/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("plugin_tool_permit_text_invalid");
  const bytes = Buffer.from(hex, "hex");
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) throw new Error("plugin_tool_permit_text_invalid");
  return value; // Hex preserves embedded NUL; invalid UTF-8 never collapses identities.
}
function permitInteger(value: string | null): number {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) throw new Error("plugin_tool_permit_integer_invalid");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || String(number) !== value) throw new Error("plugin_tool_permit_integer_invalid");
  return number;
}

export class SqliteExtensionRepository implements IExtensionRepository, PluginToolPermitReaderPort {
  constructor(private readonly db: AervoxDatabase) {}

  async readPluginToolPermit(_ctx: LocalContext, pluginId: string, toolId: string): Promise<PluginToolPermitSnapshot> {
    // One read statement, no new policy state or transaction. Only matching required
    // permissions are materialized, with one sentinel row to reject over-budget data.
    const textBytes = (column: SQLWrapper) => textHex(this.db, column);
    const rows = await this.db.select({
      pluginId: textBytes(plugins.id), version: textBytes(plugins.version), checksum: textBytes(plugins.checksum),
      generation: textBytes(plugins.lifecycleGeneration), availability: textBytes(plugins.availability), pluginEnabled: integerText(plugins.enabled),
      toolId: textBytes(toolRegistrations.id), name: textBytes(toolRegistrations.name), description: textBytes(toolRegistrations.description),
      category: textBytes(toolRegistrations.category), safetyLevel: textBytes(toolRegistrations.safetyLevel), replay: textBytes(toolRegistrations.replay),
      owner: textBytes(toolRegistrations.pluginId), toolEnabled: integerText(toolRegistrations.enabled), builtin: integerText(toolRegistrations.builtin),
      priority: integerText(toolRegistrations.priority), inputSchemaJson: toolRegistrations.inputSchemaJson,
      requiredPermissionsJson: toolRegistrations.requiredPermissionsJson, gatingConditionsJson: toolRegistrations.gatingConditionsJson,
      grantId: textBytes(pluginGrants.id), grantOwner: textBytes(pluginGrants.pluginId), permission: textBytes(pluginGrants.permission), scope: textBytes(pluginGrants.scope),
    }).from(plugins).leftJoin(toolRegistrations, and(eq(toolRegistrations.id, toolId), eq(toolRegistrations.pluginId, plugins.id)))
      .leftJoin(pluginGrants, and(eq(pluginGrants.pluginId, plugins.id), sql`${pluginGrants.revokedAt} IS NULL`, sql`EXISTS (
        SELECT 1 FROM ${jsonEach(this.db, toolRegistrations.requiredPermissionsJson, { alias: 'requirement', kind: 'array' })}
        WHERE CASE WHEN requirement.type = 'text' THEN requirement.value
          WHEN requirement.type = 'object' THEN ${jsonText(this.db, sql`requirement.value`, '$.permission')} ELSE NULL END = ${pluginGrants.permission}
        AND CASE WHEN requirement.type = 'text' THEN '*'
          WHEN requirement.type = 'object' THEN ${jsonText(this.db, sql`requirement.value`, '$.scope')} ELSE NULL END = ${pluginGrants.scope}
      )`)).where(eq(plugins.id, pluginId)).limit(MAX_PERMIT_GRANTS + 1);
    if (rows.length > MAX_PERMIT_GRANTS) throw new Error("plugin_tool_permit_budget_exceeded");
    const row = rows[0];
    if (!row) return { plugin: null, tool: null, grants: [] };
    const requiredText = (hex: string | null) => permitText(hex)!;
    return {
      plugin: { id: requiredText(row.pluginId), version: requiredText(row.version), checksum: requiredText(row.checksum),
        lifecycleGeneration: requiredText(row.generation), availability: requiredText(row.availability), enabled: permitInteger(row.pluginEnabled) },
      tool: row.toolId === null ? null : { id: requiredText(row.toolId), name: requiredText(row.name), description: requiredText(row.description),
        category: requiredText(row.category), safetyLevel: requiredText(row.safetyLevel), replay: permitText(row.replay, true),
        pluginId: permitText(row.owner, true), enabled: permitInteger(row.toolEnabled), builtin: permitInteger(row.builtin), priority: permitInteger(row.priority),
        inputSchemaJson: row.inputSchemaJson, requiredPermissionsJson: row.requiredPermissionsJson, gatingConditionsJson: row.gatingConditionsJson },
      grants: rows.filter(item => item.grantId !== null).map(item => ({ id: requiredText(item.grantId), pluginId: requiredText(item.grantOwner),
        permission: requiredText(item.permission), scope: requiredText(item.scope) })),
    };
  }

  async createExternalSource(
    ctx: LocalContext,
    sourceData: { id: string; provider: string; externalId: string; permissionScope: string; syncState?: string },
  ): Promise<ExternalSourceModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(externalSources)
      .values({
        id: sourceData.id,
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

  async getExternalSource(ctx: LocalContext, id: string): Promise<ExternalSourceModel | null> {
    const [found] = await this.db
      .select()
      .from(externalSources)
      .where(
        and(
          eq(externalSources.id, id),
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
      proactiveSpecJson?: unknown;
    },
  ): Promise<PluginModel> {
    const now = new Date().toISOString();
    const existing = await this.getPlugin(pluginData.id);
    if (existing) {
      const [updated] = await this.db
        .update(plugins)
        .set({
          publisher: pluginData.publisher,
          lifecycleGeneration: randomGeneration(this.db),
          version: pluginData.version,
          checksum: pluginData.checksum,
          signature: pluginData.signature ?? null,
          permissions: pluginData.permissions ?? null,
          installSource: pluginData.installSource ?? "registry",
          ...(pluginData.enabled !== undefined ? { enabled: pluginData.enabled } : {}),
          ...(pluginData.configSchemaJson !== undefined ? { configSchemaJson: pluginData.configSchemaJson } : {}),
          ...(pluginData.configSchemaVersion !== undefined ? { configSchemaVersion: pluginData.configSchemaVersion } : {}),
          ...(pluginData.proactiveSpecJson !== undefined ? { proactiveSpecJson: pluginData.proactiveSpecJson } : {}),
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
        lifecycleGeneration: randomGeneration(this.db),
        publisher: pluginData.publisher,
        version: pluginData.version,
        checksum: pluginData.checksum,
        signature: pluginData.signature ?? null,
        permissions: pluginData.permissions ?? null,
        installSource: pluginData.installSource ?? "registry",
        enabled: pluginData.enabled ?? 1,
        configSchemaJson: pluginData.configSchemaJson ?? null,
        configSchemaVersion: pluginData.configSchemaVersion ?? 1,
        proactiveSpecJson: pluginData.proactiveSpecJson ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as PluginModel;
  }

  async setPluginAvailability(id: string, availability: "available" | "missing" | "invalid" | "unreadable"): Promise<void> {
    await this.db.update(plugins).set({
      availability,
      lifecycleGeneration: sql`CASE WHEN ${plugins.availability} <> ${availability} THEN ${randomGeneration(this.db)} ELSE ${plugins.lifecycleGeneration} END`,
    }).where(eq(plugins.id, id));
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
      .set({
        enabled: enabled ? 1 : 0,
        lifecycleGeneration: sql`CASE WHEN ${plugins.enabled} <> ${enabled ? 1 : 0} THEN ${randomGeneration(this.db)} ELSE ${plugins.lifecycleGeneration} END`,
        updatedAt: now,
      })
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
    ctx: LocalContext,
    grantData: { id: string; pluginId: string; permission: string; scope: string; grantedAt?: string },
  ): Promise<PluginGrantModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(pluginGrants)
      .values({
        id: grantData.id,
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

  async revokePluginGrant(ctx: LocalContext, id: string, expectedPluginId?: string): Promise<PluginGrantModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(pluginGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(pluginGrants.id, id),
          expectedPluginId === undefined ? undefined : eq(pluginGrants.pluginId, expectedPluginId),
        ),
      )
      .returning();
    return (updated as PluginGrantModel) ?? null;
  }

  async hasPluginPermission(ctx: LocalContext, pluginId: string, permission: string): Promise<boolean> {
    const [found] = await this.db
      .select()
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.pluginId, pluginId),
          eq(pluginGrants.permission, permission),
          // 未撤销的授权视为有效（libsql file 后端读快照偶发滞后，沿用 sql IS NULL 既有约定）
          sql`${pluginGrants.revokedAt} IS NULL`,
        ),
      )
      .limit(1);
    return !!found;
  }

  /** CR-032：带 scope 的授权检查（感知源授权 permission=proactive.sensor, scope=sourceId） */
  async hasPluginGrant(
    ctx: LocalContext,
    pluginId: string,
    permission: string,
    scope: string,
  ): Promise<boolean> {
    const [found] = await this.db
      .select()
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.pluginId, pluginId),
          eq(pluginGrants.permission, permission),
          eq(pluginGrants.scope, scope),
          sql`${pluginGrants.revokedAt} IS NULL`,
        ),
      )
      .limit(1);
    return !!found;
  }

  /** CR-032：按 permission 批量列出全部有效授权（Worker 物化器一次载入感知源授权矩阵） */
  async listActiveGrantsByPermission(ctx: LocalContext, permission: string): Promise<PluginGrantModel[]> {
    const rows = await this.db
      .select()
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.permission, permission),
          sql`${pluginGrants.revokedAt} IS NULL`,
        ),
      );
    return rows as PluginGrantModel[];
  }

  async createCommunityContent(
    ctx: LocalContext,
    contentData: { id: string; authorId: string; type: string; status?: string; reviewState?: string; visibility?: string },
  ): Promise<CommunityContentModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(communityContents)
      .values({
        id: contentData.id,
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

  async getCommunityContent(ctx: LocalContext, id: string): Promise<CommunityContentModel | null> {
    const [found] = await this.db
      .select()
      .from(communityContents)
      .where(
        and(
          eq(communityContents.id, id),
        ),
      );
    return (found as CommunityContentModel) ?? null;
  }

  async createOrganization(
    ctx: LocalContext,
    orgData: { id: string; ownerId: string; memberScope?: string; policyVersion: string },
  ): Promise<OrganizationModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(organizations)
      .values({
        id: orgData.id,
        ownerId: orgData.ownerId,
        memberScope: orgData.memberScope ?? "institution",
        policyVersion: orgData.policyVersion,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as OrganizationModel;
  }

  async getOrganization(ctx: LocalContext, id: string): Promise<OrganizationModel | null> {
    const [found] = await this.db
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.id, id),
        ),
      );
    return (found as OrganizationModel) ?? null;
  }
}
