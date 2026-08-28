/**
 * Aervox｜思隅 @aervox/database — 领域错误类型（缺陷 B）
 *
 * 数据层抛出的业务异常统一收敛为 DatabaseError 层级，携带 domainCode
 * （NOT_FOUND / FORBIDDEN / CONFLICT），由上层（apps/api）的 setErrorHandler
 * 映射为对应 HTTP 状态码，避免裸 Error 被统一当作 500。
 * 数据层不依赖也不感知 HTTP/API 错误体系，只表达领域语义。
 */

/** 领域错误类别（与 API 层 ApiErrorCode 对应，但不绑定 HTTP 状态码） */
export type DatabaseErrorCode = "NOT_FOUND" | "FORBIDDEN" | "CONFLICT";

/** 数据层业务异常基类 */
export abstract class DatabaseError extends Error {
  readonly domainCode: DatabaseErrorCode;

  constructor(domainCode: DatabaseErrorCode, message: string) {
    super(message);
    this.name = "DatabaseError";
    this.domainCode = domainCode;
  }
}

/** 在租户范围内未找到资源 → 上层应映射 404 */
export class NotFoundInTenantError extends DatabaseError {
  constructor(message = "resource not found in tenant") {
    super("NOT_FOUND", message);
    this.name = "NotFoundInTenantError";
  }
}

/** 跨租户/越权访问 → 上层应映射 403 */
export class TenantAccessViolationError extends DatabaseError {
  constructor(message = "cross-tenant access violation") {
    super("FORBIDDEN", message);
    this.name = "TenantAccessViolationError";
  }
}

/** 领域状态冲突（幂等/版本冲突）→ 上层应映射 409 */
export class DomainConflictError extends DatabaseError {
  constructor(message = "domain conflict") {
    super("CONFLICT", message);
    this.name = "DomainConflictError";
  }
}