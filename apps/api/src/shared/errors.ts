/**
 * Aervox｜思隅 @aervox/api — 共享错误类型
 *
 * 供各模块与 Fastify 错误处理器统一使用。快照回复（200/201 带错误描述）由路由内部直接处理，
 * 此处仅覆盖跨模块复用的异常类型。
 */

/** 查询未命中时抛出，由统一错误层映射为 404 */
export class NotFoundError extends Error {
  constructor(message = "resource not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

/** 请求数据非法时抛出，由统一错误层映射为 400 */
export class ValidationError extends Error {
  constructor(message = "validation failed") {
    super(message);
    this.name = "ValidationError";
  }
}