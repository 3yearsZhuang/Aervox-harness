/**
 * Aervox｜思隅 @aervox/database — 租户上下文与隔离保护
 *
 * 替代 PostgreSQL RLS 的应用层强隔离防线。
 * 所有仓储方法强制要求传入 TenantContext，并在查询构建期自动注入 (workspaceId, subjectUserId) 约束。
 * 越权断言抛 TenantAccessViolationError（缺陷 B），由 API 层映射为 403 而非 500。
 */
import { TenantAccessViolationError } from "./errors.js";

export interface TenantContext {
  /** 工作区标识 */
  readonly workspaceId: string;
  /** 数据主体用户标识 */
  readonly subjectUserId: string;
  /** 操作者标识（组织管理员/教师/监护人/插件以独立 actorId 表示，不得替代数据主体） */
  readonly actorId?: string;
}

/**
 * 校验租户上下文非空且格式合法
 */
export function assertTenantContext(tenant: TenantContext): void {
  if (!tenant || typeof tenant !== "object") {
    throw new Error("TenantContext is required for data isolation");
  }
  if (!tenant.workspaceId || tenant.workspaceId.trim() === "") {
    throw new Error("TenantContext.workspaceId must be a non-empty string");
  }
  if (!tenant.subjectUserId || tenant.subjectUserId.trim() === "") {
    throw new Error("TenantContext.subjectUserId must be a non-empty string");
  }
}

/**
 * 校验给定的实体对象是否属于当前租户主体
 */
export function assertEntityBelongsToTenant(
  tenant: TenantContext,
  entity: { workspaceId: string; subjectUserId: string },
): void {
  assertTenantContext(tenant);
  if (
    entity.workspaceId !== tenant.workspaceId ||
    entity.subjectUserId !== tenant.subjectUserId
  ) {
    throw new TenantAccessViolationError(
      `Cross-tenant access violation: entity (${entity.workspaceId}, ${entity.subjectUserId}) does not match context (${tenant.workspaceId}, ${tenant.subjectUserId})`,
    );
  }
}
