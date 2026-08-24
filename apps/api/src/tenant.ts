/**
 * Aervox｜思隅 @aervox/api — 租户上下文解析
 *
 * 从请求 Header 提取 TenantContext（x-workspace-id / x-user-id / x-actor-id），
 * 替代 PostgreSQL RLS 的应用层隔离防线。所有仓储方法均要求注入该上下文。
 */
import type { FastifyRequest } from "fastify";
import type { TenantContext } from "@aervox/database";

/** 从请求解析租户上下文（缺失时回退默认值，便于本地联调） */
export function resolveTenant(req: FastifyRequest): TenantContext {
  const actorId = req.headers["x-actor-id"] as string | undefined;
  return {
    workspaceId: (req.headers["x-workspace-id"] as string) ?? "ws_default",
    subjectUserId: (req.headers["x-user-id"] as string) ?? "usr_default",
    ...(actorId ? { actorId } : {}),
  };
}
