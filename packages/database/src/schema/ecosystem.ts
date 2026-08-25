/**
 * Aervox｜思隅 @aervox/database — 内容/生态扩展实体表（P2/P3）
 *
 * 规则依据：docs/PRD.md §8 数据模型
 * （ExternalSource / Plugin / PluginGrant / CommunityContent / Organization）
 *
 * 扩展实体 PRD 标注「不要求 MVP 首次实现」，先落表为后续生态/社区功能预留。
 * plugins / plugin_grants 为平台级能力；community_contents / organizations 属 P3 生态。
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tenantColumns, timestampColumns } from "./common.js";

/** 第三方题库/文献同步来源（P2 · CAP-023） */
export const externalSources = sqliteTable(
  "external_sources",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    provider: text("provider").notNull(), // 第三方题库/文献平台
    externalId: text("external_id").notNull(), // 第三方资源 ID
    permissionScope: text("permission_scope").notNull(), // 授权范围
    syncState: text("sync_state").notNull().default("idle"), // "idle" | "syncing" | "synced" | "failed"
    revokedAt: text("revoked_at"),
    ...timestampColumns,
  },
  (table) => ({
    tenantProviderIdx: index("external_sources_tenant_provider_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.provider,
    ),
  }),
);

/** 技能/插件生命周期（P2 · CAP-020；系统级，无租户列） */
export const plugins = sqliteTable(
  "plugins",
  {
    id: text("id").primaryKey(), // 插件名（标识）
    publisher: text("publisher").notNull(),
    version: text("version").notNull(),
    checksum: text("checksum").notNull(),
    signature: text("signature"),
    permissions: text("permissions", { mode: "json" }), // 插件声明的权限
    installSource: text("install_source").notNull().default("registry"), // "registry" | "local" | "marketplace"
    enabled: integer("enabled").notNull().default(1),
    ...timestampColumns,
  },
  (table) => ({
    publisherIdVersionIdx: uniqueIndex("plugins_publisher_id_version_idx").on(
      table.publisher,
      table.id,
      table.version,
    ),
  }),
);

/** 插件权限逐项授予/撤销（P2 · CAP-020） */
export const pluginGrants = sqliteTable(
  "plugin_grants",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    scope: text("scope").notNull(),
    grantedAt: text("granted_at").notNull(),
    revokedAt: text("revoked_at"),
    ...timestampColumns,
  },
  (table) => ({
    // 未撤销的授权唯一；撤销后可重新授予
    tenantPluginPermActiveIdx: uniqueIndex("plugin_grants_tenant_plugin_perm_idx")
      .on(table.workspaceId, table.subjectUserId, table.pluginId, table.permission)
      .where(sql`${table.revokedAt} IS NULL`),
  }),
);

/** 社区内容与公开知识网页（P3 · CAP-028/029） */
export const communityContents = sqliteTable(
  "community_contents",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    authorId: text("author_id").notNull(),
    type: text("type").notNull(), // "question_pack" | "knowledge_card" | "persona" | "web_page"
    status: text("status").notNull().default("draft"), // "draft" | "published" | "archived"
    reviewState: text("review_state").notNull().default("pending"), // "pending" | "approved" | "rejected" | "flagged"
    visibility: text("visibility").notNull().default("public"), // "public" | "unlisted" | "private"
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("community_contents_tenant_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
  }),
);

/** 机构/监护空间（P3 · CAP-032） */
export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    ownerId: text("owner_id").notNull(),
    memberScope: text("member_scope").notNull().default("institution"), // "school" | "institution" | "guardian"
    policyVersion: text("policy_version").notNull(),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("organizations_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);
