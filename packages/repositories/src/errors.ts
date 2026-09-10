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

/** 仓储中未找到资源 → 上层应映射 404 */
export class RepositoryNotFoundError extends DatabaseError {
  constructor(message = "resource not found") {
    super("NOT_FOUND", message);
    this.name = "RepositoryNotFoundError";
  }
}

/** 本地资源越权访问 → 上层应映射 403 */
export class RepositoryAccessViolationError extends DatabaseError {
  constructor(message = "local resource access violation") {
    super("FORBIDDEN", message);
    this.name = "RepositoryAccessViolationError";
  }
}

/** 领域状态冲突（幂等/版本冲突）→ 上层应映射 409 */
export class DomainConflictError extends DatabaseError {
  constructor(message = "domain conflict") {
    super("CONFLICT", message);
    this.name = "DomainConflictError";
  }
}

/**
 * 事件/工具写入的 fencing 失配：Attempt 已被新执行者抢占或恢复器收敛（fencing 递增），
 * 迟到写入被拒绝（AVX-HAR-001 §11.2「事件/工具写入的 fencing 校验」、§12.2）。
 * 上层（host-agent）应将其转译为 Loop 的 LeaseLostError，执行器停止产生新副作用。
 */
export class FencingMismatchError extends DatabaseError {
  constructor(message = "attempt fencing mismatch: late write rejected") {
    super("CONFLICT", message);
    this.name = "FencingMismatchError";
  }
}
