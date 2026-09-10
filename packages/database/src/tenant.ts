/**
 * Aervox｜思隅 @aervox/database — 本地单用户上下文（轻量兼容结构）
 *
 * CR-030：系统已全栈演进为纯本地单机单用户架构，不再执行多租户隔离与 RLS 约束。
 * 保留 TenantContext 仅用于过渡兼容，assertTenantContext 退化为 no-op。
 */
/**
 * @deprecated CR-030 兼容桥接类型。纯本地数据库不会使用这些字段执行隔离；
 * 新代码不应把它当作授权或安全边界。
 */
export interface TenantContext {
  /** 工作区标识（本地单用户默认 local） */
  readonly workspaceId?: string;
  /** 数据主体用户标识（本地单用户默认 local_user） */
  readonly subjectUserId?: string;
  /** 操作者标识 */
  readonly actorId?: string;
}

export const LOCAL_TENANT_CONTEXT: TenantContext = {
  workspaceId: "local",
  subjectUserId: "local_user",
  actorId: "local_user",
};

/**
 * 本地单机下退化为 no-op
 */
export function assertTenantContext(_tenant?: TenantContext): void {
  // Compatibility no-op: local file permissions, not this value, define the security boundary.
}

/**
 * @deprecated Compatibility no-op; entity ownership is not represented in local SQLite.
 */
export function assertEntityBelongsToTenant(
  _tenant?: TenantContext,
  _entity?: { workspaceId?: string; subjectUserId?: string },
): void {
  // no-op in pure-local single-user architecture
}
