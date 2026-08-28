/**
 * Aervox｜思隅 @aervox/api — 统一错误类型与错误码（缺陷6）
 *
 * 业务错误抛 ApiError（或子类），由 app.ts 的 setErrorHandler 统一序列化为
 * `{ error, code, message }` 响应；非业务异常（schema validation / 5xx）保持
 * Fastify 默认序列化不变。
 * 说明：各路由既有的「快照回复」（200/201 + 内嵌 error 字段）属于业务成功面契约，
 * 与异常路径（本层）并存，不在此混用。
 */
export type ApiErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INTERNAL_ERROR";

/** API 异常基类：携带机器可读错误码与 HTTP 状态码 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;

  constructor(code: ApiErrorCode, statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** 查询未命中 → 404 { error, code: "NOT_FOUND", message } */
export class NotFoundError extends ApiError {
  constructor(message = "resource not found") {
    super("NOT_FOUND", 404, message);
    this.name = "NotFoundError";
  }
}

/** 请求数据非法 → 400 { error, code: "VALIDATION_FAILED", message } */
export class ValidationError extends ApiError {
  constructor(message = "validation failed") {
    super("VALIDATION_FAILED", 400, message);
    this.name = "ValidationError";
  }
}

/** 状态冲突（幂等/版本冲突）→ 409 { error, code: "CONFLICT", message } */
export class ConflictError extends ApiError {
  constructor(message = "conflict") {
    super("CONFLICT", 409, message);
    this.name = "ConflictError";
  }
}