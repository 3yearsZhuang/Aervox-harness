/**
 * Aervox｜思隅 @aervox/api — 本地单用户上下文（跨模块共享）
 *
 * CR-030 后 API 不再接受或解析租户 Header。Repository 仍临时要求 LocalContext
 * 兼容参数，因此在请求边界为每个请求创建固定的本机上下文；actorId 仅可由认证
 * 配置注入，用于审计，不承担数据隔离。
 */
import type { FastifyRequest } from "fastify";
import type { LocalContext } from "@aervox/repositories";

const LOCAL_CONTEXT_KEY = Symbol("aervox.local-context");

function createLocalContext(actorId?: string): LocalContext {
  return {
    workspaceId: "local",
    subjectUserId: "local",
    ...(actorId ? { actorId } : {}),
  };
}

/** 认证中间件为当前请求注入本地上下文；actorId 只来自服务端配置。 */
export function setRequestLocalContext(req: FastifyRequest, actorId?: string): void {
  (req as unknown as Record<PropertyKey, unknown>)[LOCAL_CONTEXT_KEY] = createLocalContext(actorId);
}

/** 读取请求上已缓存的本地上下文（可能未设置）。 */
export function getRequestLocalContext(req: FastifyRequest): LocalContext | undefined {
  return (req as unknown as Record<PropertyKey, unknown>)[LOCAL_CONTEXT_KEY] as LocalContext | undefined;
}

/**
 * 解析当前请求的本地单用户上下文。
 * 中间件未运行时仍创建固定本机上下文，绝不读取请求 Header。
 */
export function resolveLocalContext(req: FastifyRequest): LocalContext {
  const cached = getRequestLocalContext(req);
  if (cached) return cached;
  setRequestLocalContext(req);
  return getRequestLocalContext(req) as LocalContext;
}
