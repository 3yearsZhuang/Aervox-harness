/**
 * Aervox｜思隅 @aervox/database — 隐私/删除实体表
 *
 * 规则依据：docs/PRD.md §8 数据模型
 * （ConsentGrant / DeletionRequest / DeletionTarget）
 */
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tenantColumns, timestampColumns } from "./common.js";

/** 同意授权（日记/模型调用/分析/外部同步/设备权限；授权操作者与数据主体分开记录） */
export const consentGrants = sqliteTable(
  "consent_grants",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    actorId: text("actor_id").notNull(),
    purpose: text("purpose").notNull(), // "diary" | "model_invocation" | "analytics" | "external_sync" | "device"
    scope: text("scope").notNull(),
    policyVersion: text("policy_version").notNull(),
    grantedAt: text("granted_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    // 仅未撤销的有效授权唯一；撤销后可重新授予
    tenantScopeActiveIdx: uniqueIndex("consent_grants_tenant_purpose_scope_idx")
      .on(table.workspaceId, table.subjectUserId, table.purpose, table.scope)
      .where(sql`${table.revokedAt} IS NULL`),
  }),
);

/** 删除请求（账户/工作区/来源级删除及各存储传播进度；接受后来源始终保持 deny） */
export const deletionRequests = sqliteTable(
  "deletion_requests",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    scope: text("scope").notNull(), // "account" | "workspace" | "source" | "memory"
    idempotencyKey: text("idempotency_key").notNull(),
    requestedAt: text("requested_at").notNull(),
    effectiveAt: text("effective_at"),
    status: text("status").notNull().default("pending"), // "pending" | "in_progress" | "completed" | "failed"
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    ownerModule: text("owner_module").notNull(),
    lastVerifiedAt: text("last_verified_at"),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdemIdx: uniqueIndex("deletion_requests_tenant_idempotency_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.idempotencyKey,
    ),
  }),
);

/** 删除传播清单逐下游状态（不含被删除正文，供清理/验证/重试，不充当独立恢复账本） */
export const deletionTargets = sqliteTable(
  "deletion_targets",
  {
    requestId: text("request_id")
      .notNull()
      .references(() => deletionRequests.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    ownerModule: text("owner_module").notNull(),
    status: text("status").notNull().default("pending"), // "pending" | "in_progress" | "completed" | "failed"
    attemptCount: integer("attempt_count").notNull().default(0),
    verifiedAt: text("verified_at"),
    evidenceRef: text("evidence_ref"), // 不含正文的 tombstone 引用
  },
  (table) => ({
    pk: primaryKey({ columns: [table.requestId, table.targetType, table.targetId] }),
  }),
);
