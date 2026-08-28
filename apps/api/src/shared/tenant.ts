/**
 * Aervox｜思隅 @aervox/api — 租户上下文解析（跨模块共享）
 *
 * 从请求 Header 提取 TenantContext（x-workspace-id / x-user-id / x-actor-id），
 * 替代 PostgreSQL RLS 的应用层隔离防线。所有仓储方法均要求注入该上下文。
 *
 * 信任模型（缺陷1加固）：请求头本身是**不可信输入**。租户上下文应只来自
 * 认证中间件（shared/auth.ts）校验通过后写入的已验证值；resolveTenant 返回
 * 该缓存值。仅当中间件未运行（单元测试直调 / 旧调用方）时回退 header 解析。
 */
import type { FastifyRequest } from "fastify";
import type { TenantContext } from "@aervox/database";

const TENANT_KEY = Symbol("aervox.tenant");

/** 从请求头解析租户上下文（纯函数；缺失时回退默认值，便于本地联调） */
export function parseTenantHeaders(req: FastifyRequest): TenantContext {
  const actorId = req.headers["x-actor-id"] as string | undefined;
  return {
    workspaceId: (req.headers["x-workspace-id"] as string) ?? "ws_default",
    subjectUserId: (req.headers["x-user-id"] as string) ?? "usr_default",
    ...(actorId ? { actorId } : {}),
  };
}

/** 认证中间件校验通过后写入的已验证租户上下文 */
export function setRequestTenant(req: FastifyRequest, context: TenantContext): void {
  (req as unknown as Record<PropertyKey, unknown>)[TENANT_KEY] = context;
}

/** 读取请求上已缓存的租户上下文（可能未设置） */
export function getRequestTenant(req: FastifyRequest): TenantContext | undefined {
  return (req as unknown as Record<PropertyKey, unknown>)[TENANT_KEY] as TenantContext | undefined;
}

/**
 * 从请求解析租户上下文（跨模块共享）。
 * 优先返回认证中间件写入的已验证上下文；中间件未运行时回退 header 解析
 * （并缓存），保持既有测试与直调语义不变。
 */
export function resolveTenant(req: FastifyRequest): TenantContext {
  const cached = getRequestTenant(req);
  if (cached) return cached;
  const context = parseTenantHeaders(req);
  setRequestTenant(req, context);
  return context;
}